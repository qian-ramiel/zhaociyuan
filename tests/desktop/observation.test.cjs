const test = require('node:test');
const assert = require('node:assert/strict');

const desktop = { visionEnabled: true, gazeEnabled: true };
const screen = { enabled: true, paused: false, sourceId: 'screen:1:0' };
const mode = { screenAllowed: true, proactive: true, quietStart: '23:00', quietEnd: '08:00', observation: { periodic: true, onChange: false } };

test('visual permissions retain their levels and explain the first blocking layer', async () => {
  const { screenState } = await import('../../apps/desktop/observation.mjs');
  assert.equal(screenState(desktop, screen, mode).allowed, true);
  for (const [d, s, m, reason] of [
    [{ ...desktop, visionEnabled: false }, screen, mode, '屏幕感知总开关已关闭'],
    [desktop, { ...screen, enabled: false }, mode, '角色未允许屏幕感知'],
    [desktop, { ...screen, paused: true }, mode, '屏幕感知已暂停'],
    [desktop, screen, { ...mode, screenAllowed: false }, '当前模式未允许屏幕感知'],
    [desktop, { ...screen, sourceId: '' }, mode, '尚未选择观察来源'],
  ]) assert.deepEqual(screenState(d, s, m), { allowed: false, reason });
});

test('automatic capture requires proactive screen triggers and respects focus and overnight quiet hours', async () => {
  const { proactiveState } = await import('../../apps/desktop/observation.mjs');
  const companion = { screen, focus: false };
  const noon = new Date(2026, 9, 10, 12);
  assert.equal(proactiveState(desktop, companion, mode, noon).allowed, true);
  assert.equal(proactiveState(desktop, companion, { ...mode, proactive: false }, noon).allowed, false);
  assert.equal(proactiveState(desktop, companion, { ...mode, observation: { periodic: false, onChange: false } }, noon).allowed, false);
  assert.equal(proactiveState(desktop, { ...companion, focus: true }, mode, noon).reason, '专注中');
  assert.equal(proactiveState(desktop, companion, mode, new Date(2026, 9, 10, 23, 30)).reason, '安静时段');
  assert.equal(proactiveState(desktop, companion, mode, new Date(2026, 9, 10, 7)).reason, '安静时段');
  assert.equal(proactiveState(desktop, companion, { ...mode, quietStart: '00:00', quietEnd: '00:00' }, noon).allowed, true);
});

test('gaze is separate from screen capture and keeps global and appearance gates', async () => {
  const { gazeState } = await import('../../apps/desktop/observation.mjs');
  assert.equal(gazeState({ ...desktop, visionEnabled: false }, { kind: 'live2d' }), '视线跟随已开启');
  assert.equal(gazeState({ ...desktop, gazeEnabled: false }, { kind: 'live2d' }), '视线跟随总开关已关闭');
  assert.equal(gazeState(desktop, { kind: 'live2d', gaze: { enabled: false } }), '当前形象未启用视线跟随');
});
