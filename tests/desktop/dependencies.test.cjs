const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

test('proxy override removes the vulnerable formatter dependency from the build chain', () => {
  const lock = require('../../package-lock.json');
  const agents = Object.entries(lock.packages).filter(([name]) => name.endsWith('/global-agent'));
  assert(agents.length > 0);
  for (const [, info] of agents) assert.equal(info.version, '4.1.3');
  assert(!Object.keys(lock.packages).some((name) => name.endsWith('/sprintf-js')));
});

test('Electron download proxy initialization still forwards real HTTP requests', { timeout: 10000 }, async (t) => {
  const proxy = http.createServer((request, response) => {
    assert.equal(request.url, 'http://download.invalid/test');
    response.end('proxy-ok');
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => proxy.close());
  const script = `
    require('app-builder-lib/node_modules/@electron/get/dist/cjs/proxy.js').initializeProxy();
    require('node:http').get('http://download.invalid/test', (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk) => process.stdout.write(chunk));
    }).on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  `;
  const result = await promisify(execFile)(process.execPath, ['-e', script], {
    cwd: root, timeout: 5000,
    env: { PATH: process.env.PATH, GLOBAL_AGENT_HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}` },
  });
  assert.equal(result.stdout, 'proxy-ok');
});
