const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { serviceOptions, launchService } = require('../../apps/desktop/service.cjs');

test('packaged runtime never invokes system Python; mutable data stays outside app', () => {
  const config = serviceOptions({ packaged: true, resourcesPath: '/Applications/兆次元.app/Contents/Resources',
    root: '/ignored', userData: '/Users/example/Library/Application Support/Nice People',
    env: { NICE_PEOPLE_PYTHON: '/unwanted/python' }, token: 'private-token', apiUrl: 'http://127.0.0.1:33333' });
  assert.equal(config.executable, '/Applications/兆次元.app/Contents/Resources/companion-service/companion-service');
  assert.deepEqual(config.args, ['--port', '33333']);
  assert.equal(config.options.env.NICE_PEOPLE_HOME, '/Users/example/Library/Application Support/Nice People/companion');
  assert.equal(config.options.env.NICE_PEOPLE_RESOURCES, '/Users/example/Library/Application Support/Nice People/resources');
  assert.match(config.options.env.NICE_PEOPLE_RENDERER, /Resources\/renderer$/);
  assert.match(config.options.env.NICE_PEOPLE_BUNDLED_SPEECH, /Resources\/speech$/);
  assert.match(config.options.env.NICE_PEOPLE_BUNDLED_CHARACTERS, /Resources\/builtin-characters$/);
});

test('development runtime preserves optional local Python and data overrides', () => {
  const config = serviceOptions({ packaged: false, root: '/repo', userData: '/profile',
    env: { NICE_PEOPLE_PYTHON: '/custom/python', NICE_PEOPLE_HOME: '/temporary/data' }, token: 'token', apiUrl: 'http://127.0.0.1:8791' });
  assert.equal(config.executable, '/custom/python');
  assert.deepEqual(config.args.slice(0, 3), ['-m', 'uvicorn', 'server.app.api:app']);
  assert.equal(config.options.env.NICE_PEOPLE_HOME, '/temporary/data');
});

function fixture() {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.kill = () => { child.killed = true; };
  return child;
}
const config = { executable: __filename, args: ['--port', '33333'], options: { env: { NICE_PEOPLE_TOKEN: 'token' } } };

test('service readiness requires authenticated desktop state, not public health response', async () => {
  const child = fixture(); let attempts = 0;
  const started = await launchService(config, { launch: () => child, timeoutMs: 1000,
    fetcher: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:33333/api/desktop');
      assert.equal(options.headers.Authorization, 'Bearer token');
      return { ok: true, json: async () => ++attempts === 1 ? { status: 'ok' } : { visible: true } };
    } });
  assert.equal(started, child); assert.equal(attempts, 2); assert.equal(child.killed, undefined);
});

test('missing service, child crash and readiness timeout fail explicitly and stop child', async () => {
  await assert.rejects(launchService({ ...config, executable: '/missing/service' }), /服务缺失/);
  const child = fixture();
  await assert.rejects(launchService(config, { launch: () => { queueMicrotask(() => child.emit('exit', 1)); return child; },
    fetcher: async () => ({ ok: false }), timeoutMs: 1000 }), /服务已退出/);
  assert.equal(child.killed, true);
  const timeout = fixture();
  await assert.rejects(launchService(config, { launch: () => timeout, fetcher: async () => ({ ok: false }), timeoutMs: 1 }), /启动超时/);
  assert.equal(timeout.killed, true);
});

test('packaging uses explicit runtime and weight allowlists rather than private data directories', () => {
  const pkg = require('../../package.json');
  assert.equal(pkg.build.mac.identity, '-');
  assert.equal(pkg.build.mac.notarize, false);
  assert.equal(pkg.build.mac.icon, 'build/packaging/app.icns');
  assert(pkg.build.files.includes('apps/desktop/*.cjs'));
  for (const resource of pkg.build.extraResources) assert(!/^(resources|runtime|\.venv)\//.test(resource.from));
  assert.equal(pkg.build.extraResources.find((item) => item.to === 'renderer').from, 'apps/desktop/renderer/dist');
});
