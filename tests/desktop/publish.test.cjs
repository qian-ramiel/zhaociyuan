const test = require('node:test');
const assert = require('node:assert/strict');

test('publication checks reject secrets and private data without returning values', async () => {
  const { inspectCandidate } = await import('../../tools/check-publish.mjs');
  const secret = 'sk-' + 'aB9x'.repeat(10);
  const result = inspectCandidate('config.js', Buffer.from(`const apiKey = '${secret}';`));
  assert.ok(result.some(item => item.rule === 'provider-key'));
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(inspectCandidate('runtime/v1/secrets.json', Buffer.from('{}')).length);
  assert.ok(inspectCandidate('data/private.db', Buffer.from('data')).length);
  assert.ok(inspectCandidate('link', Buffer.from('target'), '120000').length);
});

test('publication checks allow placeholders, source interfaces and selected assets', async () => {
  const { inspectCandidate } = await import('../../tools/check-publish.mjs');
  assert.deepEqual(inspectCandidate('example.js', Buffer.from('const apiKey = "YOUR_API_KEY";')), []);
  assert.deepEqual(inspectCandidate('runtime/.gitkeep', Buffer.alloc(0)), []);
  assert.deepEqual(inspectCandidate('apps/desktop/renderer/public/brand/logo.png', Buffer.from([0, 1, 2])), []);
  assert.deepEqual(inspectCandidate('fixture.js', Buffer.from('/Users/example/data')), []);
  assert.deepEqual(inspectCandidate('docs/screenshots/control-panel.png', Buffer.from([0, 1, 2])), []);
  assert.deepEqual(inspectCandidate('docs/screenshots/desktop-companion.png', Buffer.from([0, 1, 2])), []);
  assert.ok(inspectCandidate('docs/screenshots/private-chat.png', Buffer.from([0, 1, 2])).length);
  assert.ok(inspectCandidate('docs/private.md', Buffer.from('draft')).length);
});

test('public documentation rejects internal rollout instructions, not privacy guidance', async () => {
  const { inspectCandidate } = await import('../../tools/check-publish.mjs');
  const draft = inspectCandidate('README.md', Buffer.from('仓库仍为 Private，Star 不会授予下载权限。'));
  assert.ok(draft.some(item => item.rule === 'internal-publication-copy'));
  assert.deepEqual(inspectCandidate('docs/PRIVACY.md', Buffer.from('不要公开私人聊天；private vulnerability reporting 用于安全报告。')), []);
  assert.deepEqual(inspectCandidate('NOTICE.md', Buffer.from('An SDK license is not an application release authorization.')), []);
});
