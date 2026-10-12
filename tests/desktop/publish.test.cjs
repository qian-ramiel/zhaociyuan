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
  assert.ok(inspectCandidate('docs/private.md', Buffer.from('draft')).length);
});
