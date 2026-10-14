const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('@babel/parser');
const { resolveLanguage, initialLanguage, translate, createLanguageStore, localeTag, builtinModeLabel } = require('../../apps/desktop/locale.mjs');
const { trayTemplate } = require('../../apps/desktop/tray.cjs');
const messages = require('../../apps/desktop/locales/messages.json');

test('first install resolves supported system variants and falls back to English', () => {
  for (const locale of ['zh-CN', 'zh-TW', 'zh_Hant_HK', 'ZH-cn']) assert.equal(resolveLanguage(locale), 'zh');
  for (const locale of ['en-US', 'en-GB', 'EN_au']) assert.equal(resolveLanguage(locale), 'en');
  for (const locale of ['ja', 'ja-JP', 'JA_jp']) assert.equal(resolveLanguage(locale), 'ja');
  for (const locale of ['fr-FR', 'ko-KR', 'de', '', undefined, 'zhh']) assert.equal(resolveLanguage(locale), 'en');
  assert.equal(initialLanguage('ja', 'en-US'), 'ja');
  assert.equal(initialLanguage('en', 'zh-CN'), 'en');
  assert.equal(initialLanguage(null, 'ja-JP'), 'ja');
  assert.equal(initialLanguage('unsupported', 'fr-FR'), 'en');
});

test('catalogs contain complete English/Japanese strings with matching interpolation tokens', () => {
  assert(Object.keys(messages).length >= 600);
  const tokens = (text) => [...text.matchAll(/\{\{\w+\}\}/g)].map((match) => match[0]).sort();
  for (const [key, values] of Object.entries(messages)) {
    assert.equal(values.length, 2, key);
    for (const value of values) { assert(value.trim(), key); assert.deepEqual(tokens(value), tokens(key), key); }
  }
  const paths = ['apps/desktop/main.cjs', ...fs.readdirSync('apps/desktop/renderer/src').filter((name) => name.endsWith('.tsx')).map((name) => path.join('apps/desktop/renderer/src', name)),
    ...fs.readdirSync('apps/desktop/renderer/src/components').filter((name) => name.endsWith('.tsx')).map((name) => path.join('apps/desktop/renderer/src/components', name))];
  let count = 0;
  function visit(node) {
    if (node.type === 'CallExpression' && node.callee.name === 't' && node.arguments[0]?.type === 'StringLiteral') {
      const key = node.arguments[0].value; assert(messages[key], `Missing translation: ${key}`); count++;
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'extra', 'comments'].includes(key)) continue;
      if (Array.isArray(value)) { for (const child of value) if (child?.type) visit(child); }
      else if (value?.type) visit(value);
    }
  }
  for (const file of paths) visit(parse(fs.readFileSync(file, 'utf8'), { sourceType: 'unambiguous', plugins: ['typescript', 'jsx'] }));
  assert(count > 500);
});

test('translation interpolates text literally, leaves unknown content intact and formats locale tags', () => {
  assert.equal(translate('{{v0}} 个角色', 'en', { v0: 2 }), '2 characters');
  assert.equal(translate('{{v0}} 个角色', 'ja', { v0: 2 }), '2 キャラクター');
  assert.equal(translate('{{v0}} 个角色', 'zh', { v0: 2 }), '2 个角色');
  assert.equal(translate('我的自定义角色提示词', 'en'), '我的自定义角色提示词');
  assert(translate('删除「{{v0}}」及其配置、聊天和记忆？共享形象资源仍会保留。', 'en', { v0: '<script>$&{{v1}}</script>' }).includes('<script>$&{{v1}}</script>'));
  assert.equal(localeTag('ja'), 'ja-JP');
});

test('language store changes in place without resetting state, ignores invalid values and unsubscribes', () => {
  const store = createLanguageStore('zh-CN'); let changes = 0;
  const stop = store.subscribe(() => changes++);
  store.set('en'); store.set('en'); store.set('xx');
  assert.equal(store.get(), 'en'); assert.equal(changes, 1);
  stop(); store.set('ja'); assert.equal(changes, 1);
});

test('native tray translates controls while preserving character and appearance names', () => {
  const state = { roles: [{ id: 'r', name: '我叫关闭' }], appearances: [{ id: 'a', name: '我的半身' }] };
  const actions = { configure() {}, role() {}, appearance() {}, preference() {}, quit() {} };
  for (const language of ['en', 'ja']) {
    const menu = trayTemplate(state, { language, visible: true }, actions);
    assert.equal(menu[0].label, translate('配置面板', language));
    assert.equal(menu[2].submenu[0].label, '我叫关闭'); assert.equal(menu[4].submenu[0].label, '我的半身');
    assert.equal(menu.at(-1).label, translate('退出', language));
  }
});
test('only unchanged built-in mode labels translate, not custom names or saved prompts', () => {
  assert.equal(builtinModeLabel({ id: 'daily', name: '日常闲聊' }, 'en'), 'Daily Chat');
  assert.equal(builtinModeLabel({ id: 'daily', name: '我的模式' }, 'en'), '我的模式');
  assert.equal(builtinModeLabel({ id: 'custom', name: '日常闲聊' }, 'en'), '日常闲聊');
});
