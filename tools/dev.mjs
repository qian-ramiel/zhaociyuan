import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children = [];
let stopping = false;
const token = randomBytes(32).toString('hex');
const env = { ...process.env, NICE_PEOPLE_TOKEN: token, NICE_PEOPLE_EXTERNAL_API: '1', PYTHONPATH: path.join(root, 'services/companion') };

function start(command, args) {
  const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
  children.push(child);
  child.on('error', (error) => { console.error(error.message); stop(1); });
  child.on('exit', (code) => { if (!stopping) stop(code || 0); });
  return child;
}
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500);
}
async function freePort(port) {
  for (let candidate = port; candidate < port + 50; candidate++) {
    const available = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(candidate, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (available) return candidate;
  }
  throw new Error('没有可用的本地端口');
}
async function ready(url) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('服务启动超时');
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
try {
  const apiPort = await freePort(8791);
  const uiPort = await freePort(4317);
  env.NICE_PEOPLE_API = 'http://127.0.0.1:' + apiPort;
  env.NICE_PEOPLE_URL = 'http://127.0.0.1:' + uiPort;
  env.NICE_PEOPLE_UI_PORT = String(uiPort);
  start(path.join(root, '.venv/bin/python'), ['-m', 'uvicorn', 'server.app.api:app', '--host', '127.0.0.1', '--port', String(apiPort)]);
  start(path.join(root, 'node_modules/.bin/vite'), ['--config', 'apps/desktop/renderer/vite.config.ts']);
  await ready(env.NICE_PEOPLE_API + '/api/health');
  await ready(env.NICE_PEOPLE_URL);
  console.log('兆次元 1.0: ' + env.NICE_PEOPLE_URL);
  if (!process.argv.includes('--web')) start(path.join(root, 'node_modules/.bin/electron'), ['.']);
} catch (error) { console.error(error.message); stop(1); }
