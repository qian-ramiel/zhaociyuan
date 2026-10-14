const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function serviceOptions({ packaged, resourcesPath, root, userData, env, token, apiUrl }) {
  const executable = packaged ? path.join(resourcesPath, 'companion-service/companion-service') : path.join(root, '.venv/bin/python');
  const serviceRoot = packaged ? path.join(resourcesPath, 'companion-service') : path.join(root, 'services/companion');
  const args = packaged ? ['--port', new URL(apiUrl).port] : ['-m', 'uvicorn', 'server.app.api:app', '--host', '127.0.0.1', '--port', new URL(apiUrl).port || '8791'];
  return {
    executable: env.NICE_PEOPLE_PYTHON && !packaged ? env.NICE_PEOPLE_PYTHON : executable,
    args,
    options: { cwd: serviceRoot, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...env, PYTHONPATH: serviceRoot, PYTHONNOUSERSITE: '1', NICE_PEOPLE_TOKEN: token,
      NICE_PEOPLE_HOME: env.NICE_PEOPLE_HOME || (packaged ? path.join(userData, 'companion') : path.join(root, 'runtime/v1')),
      NICE_PEOPLE_RESOURCES: env.NICE_PEOPLE_RESOURCES || (packaged ? path.join(userData, 'resources') : path.join(root, 'resources')),
      NICE_PEOPLE_BUNDLED_SPEECH: packaged ? path.join(resourcesPath, 'speech') : '',
      NICE_PEOPLE_BUNDLED_CHARACTERS: env.NICE_PEOPLE_BUNDLED_CHARACTERS || (packaged ? path.join(resourcesPath, 'builtin-characters') : path.join(root, 'resources/builtin-characters')),
      NICE_PEOPLE_RENDERER: packaged ? path.join(resourcesPath, 'renderer') : path.join(root, 'apps/desktop/renderer/dist'),
    } },
  };
}

async function launchService(config, { launch = spawn, fetcher = fetch, timeoutMs = 45000, log = () => {}, onLaunch = () => {} } = {}) {
  if (!fs.existsSync(config.executable)) throw new Error('安装包中的本地服务缺失，请重新安装兆次元。');
  const child = launch(config.executable, config.args, config.options);
  onLaunch(child);
  let stopped;
  child.on('error', () => { stopped = '本地服务无法启动，请检查安装包是否完整。'; });
  child.on('exit', (code) => { stopped = `本地服务已退出（${code ?? '信号'}），请查看启动日志。`; });
  child.stdout.on('data', log); child.stderr.on('data', log);
  const url = `http://127.0.0.1:${config.args.at(-1)}`;
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (stopped) throw new Error(stopped);
      try {
        // An authenticated check cannot mistake another localhost service for our child.
        const response = await fetcher(url + '/api/desktop', { headers: { Authorization: 'Bearer ' + config.options.env.NICE_PEOPLE_TOKEN }, signal: AbortSignal.timeout(1000) });
        if (response.ok && typeof (await response.json()).visible === 'boolean') return child;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error('本地服务启动超时，请查看用户数据目录中的 startup.log。');
  } catch (error) { child.kill(); throw error; }
}

module.exports = { freePort, serviceOptions, launchService };
