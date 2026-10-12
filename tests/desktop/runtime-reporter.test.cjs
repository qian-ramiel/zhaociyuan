const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntimeReporter } = require('../../apps/desktop/runtime-reporter.mjs');
const { requestHeaders, runtimeErrorType } = require('../../apps/desktop/errors.mjs');

function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
}
const issue = { code: 'client-stream', requestId: 'request-1', roleId: 'role-1', phase: 'request', errorType: 'connection', durationMs: 100 };

test('offline client errors survive reload and flush only for the matching role', async () => {
  const saved = storage(), received = [];
  const offline = createRuntimeReporter(saved, async () => { throw Error('offline'); });
  await offline.report({ ...issue, message: 'private transcript', imageData: 'private screen', apiKey: 'private-key' });
  await offline.report(issue);
  const pending = JSON.parse(saved.getItem('zhaociyuan-runtime-issues-v1'));
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0], issue);
  const recovered = createRuntimeReporter(saved, async (value) => received.push(value));
  await recovered.flush('role-2');
  assert.equal(received.length, 0);
  await recovered.flush('role-1');
  assert.deepEqual(received, [issue]);
  assert.deepEqual(JSON.parse(saved.getItem('zhaociyuan-runtime-issues-v1')), []);
});

test('client reporting is bounded, allowlisted and works when storage is blocked', async () => {
  const saved = storage();
  const reporter = createRuntimeReporter(saved, async () => { throw Error('offline'); });
  await reporter.report({ ...issue, requestId: 'bad\nheader' });
  await reporter.report({ ...issue, code: 'arbitrary-content' });
  for (let n = 0; n < 105; n++) await reporter.report({ ...issue, requestId: 'request-' + n });
  assert.equal(JSON.parse(saved.getItem('zhaociyuan-runtime-issues-v1')).length, 100);
  const received = [];
  const blocked = createRuntimeReporter({ getItem() { throw Error(); }, setItem() { throw Error(); } }, async (value) => received.push(value));
  await blocked.report(issue);
  assert.deepEqual(received, [issue]);
});

test('concurrent reports do not duplicate deliveries or lose errors queued during a flush', async () => {
  const received = [];
  const reporter = createRuntimeReporter(storage(), async (value) => { await new Promise((resolve) => setTimeout(resolve, 5)); received.push(value.requestId); });
  await Promise.all([reporter.report(issue), reporter.report({ ...issue, requestId: 'request-2' })]);
  assert.deepEqual(received, ['request-1', 'request-2']);
});

test('request tracing and error classification never forward message or credential content', () => {
  assert.deepEqual(requestHeaders({ requestId: 'request-1', apiKey: 'private' }), { 'Content-Type': 'application/json', 'X-Request-ID': 'request-1' });
  assert.deepEqual(requestHeaders({ requestId: 'bad\nheader' }), { 'Content-Type': 'application/json' });
  assert.equal(runtimeErrorType(Error('Error invoking remote method \'stream\': Error: fetch failed')), 'connection');
  assert.equal(runtimeErrorType(Error('连接超时')), 'timeout');
  assert.equal(runtimeErrorType(Error('模型流式连接提前结束')), 'protocol');
  assert.equal(runtimeErrorType(Error('private transcript')), 'unknown');
});
