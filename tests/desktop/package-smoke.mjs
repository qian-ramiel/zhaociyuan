import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const { freePort, serviceOptions, launchService } = require('../../apps/desktop/service.cjs');
const root = process.cwd();
const reportDir = path.join(root, 'runtime/qa/mac-package', String(Date.now()));
fs.mkdirSync(reportDir, { recursive: true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zhaociyuan-install-'));
const mountpoint = path.join(temporary, 'volume');
fs.mkdirSync(mountpoint);
const dmg = path.join(root, 'releases/Zhaociyuan-1.0.0-mac-arm64.dmg');
const result = { passed: false, checks: [], errors: [], dmg, temporary };
let mounted = false, api, electron, browser;
function run(command, args) {
  const run = spawnSync(command, args, { encoding: 'utf8' });
  if (run.status !== 0) throw Error(`${command}: ${run.stderr || run.error || run.status}`);
  return run.stdout;
}
async function waitFor(check, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { const value = await check(); if (value) return value; } catch {} await new Promise((resolve) => setTimeout(resolve, 200)); }
  throw Error('Readiness timeout');
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit');
  child.kill('SIGTERM');
  await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 4000))]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await ended; }
}
function allFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? allFiles(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
}

try {
  run('hdiutil', ['verify', dmg]); result.checks.push('DMG integrity');
  run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountpoint, dmg]); mounted = true;
  assert.equal(fs.readlinkSync(path.join(mountpoint, 'Applications')), '/Applications');
  const installed = path.join(temporary, 'installed/兆次元.app');
  fs.mkdirSync(path.dirname(installed));
  run('ditto', [path.join(mountpoint, '兆次元.app'), installed]);
  result.checks.push('DMG application copied to a path outside project');
  run('codesign', ['--verify', '--deep', '--strict', installed]);
  result.checks.push('ad-hoc code signature integrity');
  const resources = path.join(installed, 'Contents/Resources');
  const iconName = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIconFile', path.join(installed, 'Contents/Info.plist')]).trim();
  assert(fs.existsSync(path.join(resources, iconName)));
  assert(fs.existsSync(path.join(resources, 'licenses/model-manifest.json')));
  assert(!fs.existsSync(path.join(resources, 'characters')));
  const packagedFiles = allFiles(resources);
  assert(!packagedFiles.some((file) => /companion\.db|\.env$|test_wavs|modelscope|model\.onnx$/.test(file) && file.includes('sense-voice')));
  assert(!packagedFiles.some((file) => /companion\.db$|\.env$/.test(file)));
  result.checks.push('icon, license notices and no personal database');
  const cleanEnv = { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  for (const name of Object.keys(cleanEnv)) if (name.startsWith('NICE_PEOPLE_') || name.startsWith('PYTHON')) delete cleanEnv[name];
  const token = crypto.randomBytes(32).toString('hex');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const service = serviceOptions({ packaged: true, resourcesPath: resources, root: '/does-not-exist',
    userData: path.join(temporary, 'service-profile'), env: cleanEnv, token, apiUrl: base });
  api = await launchService(service, { log: (data) => fs.appendFileSync(path.join(reportDir, 'service.log'), data) });
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  async function request(route, method = 'GET', body) {
    const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value;
  }
  assert.equal((await fetch(base + '/api/desktop')).status, 401);
  const state = await request('/api/bootstrap'); assert.equal(state.roles.length, 0); assert.equal(state.messages.length, 0);
  const health = await request('/api/health'); assert(health.asr_installed && health.tts_installed); assert.equal(health.modelConfigured, false);
  result.checks.push('standalone service, authorization, fresh profile and bundled voice models');
  await request('/api/roles', 'POST', { name: '安装验收角色' });
  const audio = await request('/api/tts/synthesize', 'POST', { text: '你好，我是兆次元。今天是一个美好的日子。' });
  const bytes = Buffer.from(await (await fetch(base + audio.audio_url)).arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString(), 'RIFF'); assert(bytes.length > 16000);
  fs.writeFileSync(path.join(reportDir, 'tts.wav'), bytes);
  result.checks.push('actual bundled Kokoro synthesis without playing audio');
  const wave = path.join(temporary, 'sample.wav'); const webm = path.join(temporary, 'sample.webm');
  fs.writeFileSync(wave, bytes);
  const ffmpeg = allFiles(path.join(resources, 'companion-service/_internal/imageio_ffmpeg')).find((file) => /\/ffmpeg-macos/.test(file));
  assert(ffmpeg); run(ffmpeg, ['-nostdin', '-y', '-i', wave, '-c:a', 'libopus', webm]);
  const form = new FormData(); form.append('file', new Blob([fs.readFileSync(webm)], { type: 'audio/webm' }), 'sample.webm');
  const response = await fetch(base + '/api/asr/transcribe', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form });
  const transcript = await response.json(); assert(response.ok, JSON.stringify(transcript)); assert(transcript.text.trim());
  result.transcript = transcript.text; result.checks.push('bundled ffmpeg WebM conversion and actual SenseVoice transcription');
  await stop(api); api = null;
  const debugPort = await freePort();
  electron = spawn(path.join(installed, 'Contents/MacOS/兆次元'), ['--remote-debugging-port=' + debugPort], {
    env: { ...cleanEnv, NICE_PEOPLE_PROFILE: path.join(temporary, 'electron-profile') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  electron.stdout.on('data', (data) => fs.appendFileSync(path.join(reportDir, 'electron.log'), data));
  electron.stderr.on('data', (data) => fs.appendFileSync(path.join(reportDir, 'electron.log'), data));
  await waitFor(async () => { if (electron.exitCode !== null) throw Error('Packaged Electron exited'); return (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok; });
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const page = await waitFor(() => browser.contexts()[0]?.pages().find((page) => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(page.url())));
  const pageErrors = []; page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.waitForFunction(() => window.desktop && document.body.innerText.includes('角色'), { timeout: 45000 });
  const bootstrap = await page.evaluate(() => window.desktop.api('/api/bootstrap'));
  assert.equal(bootstrap.roles.length, 0); assert(bootstrap.health.tts_installed && bootstrap.health.asr_installed);
  assert.equal(bootstrap.desktop.pushToTalkKey, 'ShiftLeft+ShiftRight');
  const permission = await page.evaluate(() => window.desktop.permission()); result.permission = permission;
  const windows = browser.contexts()[0].pages(); assert(windows.some((page) => page.url().includes('window=companion')));
  await page.evaluate(() => window.desktop.openChat());
  await waitFor(() => browser.contexts()[0].pages().some((page) => page.url().includes('window=chat')));
  await page.screenshot({ path: path.join(reportDir, 'installed-onboarding.png') });
  assert.deepEqual(pageErrors, []); result.checks.push('actual installed Electron: onboarding, companion and floating chat, working IPC');
  const appBase = new URL(page.url()).origin;
  await page.evaluate(() => window.desktop.quit()).catch((error) => {
    if (!/Target page, context or browser has been closed/.test(error.message)) throw error;
  });
  await waitFor(() => electron.exitCode === 0, 10000);
  electron = null; await browser.close().catch(() => {}); browser = null;
  await waitFor(async () => { try { await fetch(appBase + '/api/health', { signal: AbortSignal.timeout(500) }); return false; } catch { return true; } });
  assert(fs.existsSync(path.join(temporary, 'electron-profile/companion/data/companion.db')));
  result.checks.push('clean app shutdown stops owned service; data outside application');
  result.passed = true;
} catch (error) { result.errors.push(error.stack); process.exitCode = 1; }
finally {
  await browser?.close().catch(() => {});
  await stop(electron); await stop(api);
  if (mounted) { try { run('hdiutil', ['detach', mountpoint]); } catch (error) { result.errors.push(error.message); result.passed = false; process.exitCode = 1; } }
  if (result.passed) { fs.rmSync(temporary, { recursive: true, force: true }); result.temporaryRemoved = true; }
  fs.writeFileSync(path.join(reportDir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, reportDir }, null, 2));
}
