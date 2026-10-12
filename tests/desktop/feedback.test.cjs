const test = require('node:test');
const assert = require('node:assert/strict');
const { trayTemplate } = require('../../apps/desktop/tray.cjs');
const { apiError, cleanError, providerNumberError } = require('../../apps/desktop/errors.mjs');

test('tray order, separators, current identity, appearance and actions', () => {
  const calls = [];
  const actions = Object.fromEntries(['configure', 'role', 'appearance', 'preference', 'quit'].map((key) => [key, (...args) => calls.push([key, ...args])]));
  const state = { roles: [{ id: 'r1', name: '一' }, { id: 'r2', name: '二' }], companion: { characterId: 'r2' }, appearances: [{ id: 'a', name: '半身' }], appearance: { id: 'a' } };
  const menu = trayTemplate(state, { visible: true, visionEnabled: false, hearingEnabled: true, speechEnabled: true }, actions);
  assert.deepEqual(menu.map((item) => item.label || '|'), ['配置面板', '|', '更换角色', '|', '更改形象', '|', '屏幕感知总开关', '听觉总开关', '语音播放总开关', '隐藏', '退出']);
  assert.equal(menu[2].submenu[1].checked, true);
  assert.equal(menu[4].submenu[0].checked, true);
  assert.equal(menu[6].checked, false);
  menu[0].click(); menu[2].submenu[0].click(); menu[4].submenu[0].click(); menu[7].click({ checked: false }); menu[9].click(); menu[10].click();
  assert.deepEqual(calls, [['configure'], ['role', 'r1'], ['appearance', 'a'], ['preference', 'hearingEnabled', false], ['preference', 'visible', false], ['quit']]);
});

test('empty tray has disabled submenus; recovery remains available in click-through', () => {
  const menu = trayTemplate(null, { visible: false, clickThrough: true }, {});
  assert.equal(menu[2].submenu[0].enabled, false);
  assert.equal(menu[4].submenu[0].enabled, false);
  assert.equal(menu[9].label, '显示');
  assert.equal(menu[10].label, '恢复角色交互');
});

test('validation errors are field-specific and do not include private input', () => {
  const message = apiError([{ loc: ['body', 'llm', 'temperature'], type: 'less_than_equal', input: 'SECRET', ctx: { le: 2 } }, { loc: ['body', 'llm', 'maxTokens'], type: 'greater_than_equal', ctx: { ge: 128 } }]);
  assert.match(message, /Temperature.*0–2/);
  assert.match(message, /Token 上限.*128–32768/);
  assert.ok(!message.includes('SECRET'));
  assert.equal(cleanError(new Error("Error invoking remote method 'capture': Error: 目标窗口不可用")), '目标窗口不可用');
});

test('provider validation includes integer bounds and preserves the input', () => {
  const value = { llm: { temperature: 3, maxTokens: 800 }, vision: { temperature: .8, maxTokens: 800 } };
  assert.equal(providerNumberError(value).field, 'Temperature');
  assert.equal(value.llm.temperature, 3);
  value.llm.temperature = .8; value.llm.maxTokens = 1;
  assert.match(providerNumberError(value).message, /128–32768/);
  value.llm.maxTokens = 128.5;
  assert.ok(providerNumberError(value));
  value.llm.maxTokens = 128;
  assert.equal(providerNumberError(value), null);
});
