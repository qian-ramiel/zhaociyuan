import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const browserCache = path.join(root, 'runtime/qa/fixes-2026-10-08/browser-cache');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && await fs.stat(browserCache).catch(() => null)) process.env.PLAYWRIGHT_BROWSERS_PATH = browserCache;
const { chromium } = await import('playwright');
const qa = path.join(root, 'runtime/qa/voice-call-2026-10-09', String(Date.now()));
await fs.mkdir(qa, { recursive: true });
const report = { checks: [], errors: [], nativeTray: 'not tested: no visible windows', nativeDrag: 'not tested: CSS regions and isolated main-process substitutes only', capture: 'synthetic PNG and mocked failure; no real screen access', audio: 'mocked general playback plus real MediaSource/AudioContext decoding of synthetic MP3; Chromium muted; no hardware microphone/speaker access', keyboard: 'injected commands only; native hook not started' };
const calls = [];
let slowModel = false;
let streamingModel = false, streamFinished = false, streamingTts = false, brokenSentence = '';
let transientModel = 0, transientTts = 0;
let startupFailures = 0;
const ffmpeg = execFileSync(path.join(root, '.venv/bin/python'), ['-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'], { encoding: 'utf8' }).trim();
const mp3 = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.25', '-ar', '32000', '-ac', '1', '-f', 'mp3', 'pipe:1']);
const fixture = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  calls.push({ path: req.url, body: JSON.parse(raw || '{}') });
  if (req.url === '/v1/chat/completions' && startupFailures-- > 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { code: 'model_loading', message: '模型启动失败 fixture-private-message' } }));
  }
  if ((req.url === '/v1/chat/completions' && transientModel-- > 0) || (req.url === '/v1/t2a_v2' && transientTts-- > 0)) {
    res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'temporary fixture outage' }));
  }
  if (req.url === '/v1/t2a_v2' && streamingTts) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (JSON.parse(raw).text === brokenSentence) return res.end('data: ' + JSON.stringify({ base_resp: { status_code: 1000 }, data: null }) + '\n\n');
    const chunk = (status, audio) => 'data: ' + JSON.stringify({ base_resp: { status_code: 0 }, data: { status, audio: audio.toString('hex') } }) + '\n\n';
    res.write(chunk(1, mp3.subarray(0, Math.floor(mp3.length / 2))));
    await new Promise((resolve) => setTimeout(resolve, 80));
    res.write(chunk(1, mp3.subarray(Math.floor(mp3.length / 2))));
    return res.end(chunk(2, mp3));
  }
  if (req.url === '/v1/chat/completions' && streamingModel && JSON.parse(raw).stream) {
    streamFinished = false;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frame = (content, reason = null) => 'data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: reason }] }) + '\n\n';
    res.write(frame('`'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    res.write(frame('``json\n{"text":"'));
    for (const char of '先说一句。') {
      res.write(frame(char));
      await new Promise((resolve) => setTimeout(resolve, 70));
    }
    await new Promise((resolve) => setTimeout(resolve, 900));
    res.write(frame('再说一句。最后没有标点","speech":null,"emotion":"calm","actions":"invalid","memoryCandidates":[],"custom":{}}\n```'));
    streamFinished = true;
    return res.end(frame('', 'stop') + 'data: [DONE]\n\n');
  }
  if (req.url === '/v1/audio/speech' || req.url === '/v1/t2a_v2') {
    const wav = Buffer.alloc(44 + 3200);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(3200, 40);
    if (req.url === '/v1/t2a_v2') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ base_resp: { status_code: 0, status_msg: 'success' }, data: { audio: wav.toString('hex') } }));
    }
    res.writeHead(200, { 'Content-Type': 'audio/wav' }); return res.end(wav);
  }
  if (slowModel) await new Promise((resolve) => setTimeout(resolve, 500));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text: '隔离模型回复', speech: '', emotion: 'neutral', actions: [], memoryCandidates: [], custom: {} }) } }] }));
});
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const modelUrl = `http://127.0.0.1:${fixture.address().port}/v1`;
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const url = `http://127.0.0.1:${port}`;
const server = spawn(process.env.NICE_PEOPLE_PYTHON || path.join(root, '.venv/bin/python'), ['tests/desktop/feedback-server.py', String(port)], {
  cwd: root, env: { ...process.env, PYTHONPATH: 'services/companion', NICE_PEOPLE_HOME: path.join(qa, 'data'), NICE_PEOPLE_RESOURCES: path.join(qa, 'resources'), NICE_PEOPLE_TOKEN: '', NICE_PEOPLE_RENDERER: path.join(root, 'apps/desktop/renderer/dist') }, stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
server.stdout.on('data', (chunk) => { output += chunk; });
server.stderr.on('data', (chunk) => { output += chunk; });
server.on('error', (error) => { output += error.message; });
let browser, page;
report.apiErrors = [];
const request = async (route, method = 'GET', body) => {
  const response = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json();
  assert.ok(response.ok, JSON.stringify(value)); return value;
};
try {
  for (let i = 0; i < 100; i++) {
    if (await fetch(url + '/api/health').then((r) => r.ok).catch(() => false)) break;
    if (server.exitCode !== null) throw Error(output);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await request('/api/health');
  browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (error) => report.errors.push(error.message));
  report.cancelledRequests = [];
  page.on('response', async (response) => {
    if (response.status() === 499 && response.url().endsWith('/api/chat')) report.cancelledRequests.push(response.url());
    else if (response.status() >= 400) report.apiErrors.push({ url: response.url(), status: response.status(), body: await response.text().catch(() => '') });
  });
  await page.route('**/assets/voice-vad-*.js', (route) => route.fulfill({ contentType: 'text/javascript', path: path.join(root, 'tests/desktop/voice-vad-fixture.js') }));
  await page.addInitScript(() => {
    window.__RealAudio = Audio; window.__RealAudioContext = AudioContext;
    const commands = new Set(), states = new Set();
    let preferenceQueue = Promise.resolve();
    window.__metrics = { capture: 0, microphone: 0, played: 0, tracksStopped: 0, recorderStarts: 0, asrUploads: 0 };
    window.__micMode = 'forbidden';
    window.__command = (command) => commands.forEach((cb) => cb(command));
    const api = async (route, options = {}) => {
      const response = await fetch(route, { method: options.method || 'GET', headers: { 'Content-Type': 'application/json' }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
      const value = await response.json();
      if (!response.ok) throw Error("Error invoking remote method 'api': Error: " + (typeof value.detail === 'string' ? value.detail : '请求失败'));
      return value;
    };
    window.desktop = {
      platform: 'darwin', api,
      overlay: (patch) => {
        const operation = preferenceQueue.catch(() => {}).then(async () => {
        let prefs = await api('/api/desktop');
        const filtered = Object.fromEntries(Object.entries(patch).filter(([key]) => key in prefs));
        if (Object.keys(filtered).length) prefs = await api('/api/desktop', { method: 'PUT', body: { ...prefs, ...filtered } });
        states.forEach((cb) => cb({ desktopPreferences: prefs })); return prefs;
        });
        preferenceQueue = operation; return operation;
      },
      onCommand: (cb) => { commands.add(cb); return () => commands.delete(cb); },
      onState: (cb) => { states.add(cb); return () => states.delete(cb); },
      notifyState: (value) => { window.__state = value; },
      permission: async () => { const prefs = await api('/api/desktop'); return { screen: 'granted', microphone: 'granted', accessibility: window.__trusted === false ? 'denied' : 'granted', pushToTalk: !prefs.pushToTalk ? 'disabled' : window.__trusted === false ? 'permission-required' : !prefs.hearingEnabled ? 'hearing-disabled' : 'running' }; },
      capture: async () => { window.__metrics.capture++; throw Error("Error invoking remote method 'capture': Error: 目标窗口不可用"); },
      upload: async () => {
        window.__metrics.asrUploads++;
        if (window.__asrMode === 'record') return { text: window.__asrText || '合成语音转写' };
        if (window.__asrMode === 'pending') return new Promise((resolve) => { window.__resolveAsr = (text) => resolve({ text }); });
        throw Error('cancelled recording must not upload');
      },
    };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
      window.__metrics.microphone++;
      if (window.__micMode === 'forbidden') throw Error('fixture microphone must not be requested');
      const stream = { getTracks: () => [{ stop: () => { window.__metrics.tracksStopped++; } }] };
      if (window.__micMode === 'pending') return new Promise((resolve) => { window.__resolveMicrophone = () => resolve(stream); });
      return stream;
    } });
    window.MediaRecorder = class {
      constructor() { if (window.__micMode === 'invalid-recorder') throw Error('fixture recorder unavailable'); this.state = 'inactive'; this.mimeType = 'audio/webm'; }
      start() { this.state = 'recording'; window.__metrics.recorderStarts++; }
      stop() { this.state = 'inactive'; queueMicrotask(() => this.onstop?.()); }
    };
    window.AudioContext = class {
      createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData: (samples) => samples.fill(0) }; }
      createMediaStreamSource() { return { connect() {} }; }
      async close() {}
    };
    window.Audio = class {
      async play() { window.__metrics.played++; if (!window.__holdAudio) setTimeout(() => this.onended?.(), 10); }
      pause() { window.__metrics.paused = (window.__metrics.paused || 0) + 1; }
    };
  });
  const button = (name) => page.getByRole('button', { name, exact: true });
  const tab = (name) => page.getByRole('tab', { name, exact: true });
  const screenshot = (name) => page.screenshot({ path: path.join(qa, name + '.png'), animations: 'disabled' });
  const speechCount = () => calls.filter((c) => c.path === '/v1/audio/speech').length;
  await page.goto(url);
  await page.getByText('还没有角色', { exact: true }).waitFor();
  assert.match(await button('角色库').getAttribute('class'), /selected/);
  await screenshot('01-empty-role-navigation');
  report.checks.push('empty state selects role library consistently');
  await button('创建角色').click();
  assert.equal(await page.getByRole('dialog').getByRole('button', { name: '创建角色', exact: true }).isDisabled(), true);
  await page.getByLabel('角色名称', { exact: true }).fill('隔离测试角色');
  await page.getByRole('dialog').getByRole('button', { name: '创建角色', exact: true }).click();
  await button('添加形象').waitFor();
  assert.equal(await page.locator('.setup-checklist,.setup-steps').count(), 0);
  assert.deepEqual(await page.locator('.sidebar nav > button').evaluateAll((buttons) => buttons.map((b) => b.title)), ['陪伴', '角色库', '角色设定', '角色形象', '角色配置', '运行记录']);
  await screenshot('02-simplified-sidebar');
  report.checks.push('sidebar matches simplified hierarchy and no configuration stepper remains');
  const initial = await request('/api/bootstrap');
  const firstRole = initial.activeRoleId;
  await button('角色配置').click();
  await page.getByLabel('Temperature', { exact: true }).fill('3');
  await button('保存').click();
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /0–2/);
  assert.equal(await page.getByLabel('Temperature', { exact: true }).inputValue(), '3');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Temperature');
  await screenshot('03-temperature-validation');
  await page.getByLabel('Temperature', { exact: true }).fill('0.8');
  await page.getByLabel('回复 Token 上限', { exact: true }).fill('1');
  await button('保存').click();
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /128–32768/);
  assert.equal(await page.getByLabel('回复 Token 上限', { exact: true }).inputValue(), '1');
  assert.equal((await request('/api/settings')).providers.llm.maxTokens, initial.settings.providers.llm.maxTokens);
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '回复 Token 上限');
  report.checks.push('invalid parameters locate field, preserve draft and saved configuration');
  await page.getByLabel('回复 Token 上限', { exact: true }).fill('800');
  await page.getByLabel('API 地址', { exact: true }).fill(modelUrl);
  await page.getByLabel('模型名称', { exact: true }).fill('fixture-model');
  await button('保存').click();
  await page.getByText('服务配置已保存', { exact: true }).waitFor();
  await page.getByLabel('模型名称', { exact: true }).fill('unsaved-model-draft');
  await tab('思维').focus();
  await tab('思维').press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('#config-tab-tts')?.getAttribute('aria-selected') === 'true');
  await tab('声音').press('ArrowLeft');
  await page.getByLabel('模型名称', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('模型名称', { exact: true }).inputValue(), 'unsaved-model-draft');
  await page.getByLabel('模型名称', { exact: true }).fill('fixture-model');
  report.checks.push('configuration keyboard navigation preserves unsaved provider drafts between thinking and voice');
  await button('测试连接').click();
  await page.locator('.status-note.success').waitFor();
  assert.match(await page.locator('.status-note.success').innerText(), /对话模型/);
  await tab('声音').click();
  await page.locator('.status-note.success').waitFor({ state: 'hidden' });
  await tab('思维').click();
  slowModel = true;
  await button('测试连接').click();
  await tab('声音').click();
  await page.waitForTimeout(800);
  assert.equal(await page.locator('.status-note.success').count(), 0);
  slowModel = false;
  await screenshot('04-tts-no-stale-result');
  report.checks.push('tab switch clears old result and ignores late response');
  const providers = (await request('/api/settings')).providers;
  providers.tts = { ...providers.tts, provider: 'openai', baseUrl: modelUrl, model: 'fixture-tts', autoplay: false };
  await request('/api/settings/providers', 'PUT', providers);
  await button('刷新数据').click();
  await button('陪伴').click();
  await page.getByLabel('聊天输入').fill('隔离对话');
  await button('发送').click();
  await page.getByText('隔离模型回复', { exact: true }).waitFor();
  assert.equal(speechCount(), 0);
  await button('朗读这条消息').click();
  await page.waitForFunction(() => window.__metrics.played === 1);
  assert.equal(speechCount(), 1);
  report.checks.push('autoplay false suppresses automatic TTS but manual read invokes TTS and playback');
  await button('全局设置').click();
  await page.getByRole('switch', { name: '屏幕感知总开关', exact: true }).waitFor();
  await page.evaluate(() => window.desktop.overlay({ visionEnabled: false, hearingEnabled: false, speechEnabled: false }));
  await page.waitForFunction(() => [...document.querySelectorAll('[role="switch"]')].filter((e) => ['屏幕感知总开关', '听觉总开关', '语音播放总开关'].includes(e.getAttribute('aria-label'))).every((e) => e.getAttribute('aria-checked') === 'false'));
  for (const name of ['屏幕感知总开关', '听觉总开关', '语音播放总开关']) assert.equal(await page.getByRole('switch', { name, exact: true }).getAttribute('aria-checked'), 'false');
  report.checks.push('status-bar preference events immediately update open global settings');
  await page.getByLabel('角色大小', { exact: true }).fill('1.35');
  assert.equal(await page.getByLabel('气泡宽度', { exact: true }).count(), 0);
  await page.getByLabel('气泡字号', { exact: true }).fill('17');
  await page.getByLabel('气泡自动消失', { exact: true }).selectOption('15');
  await page.waitForFunction(async () => { const prefs = await (await fetch('/api/desktop')).json(); return prefs.characterScale === 1.35 && prefs.bubbleFontSize === 17 && prefs.bubbleAutoHide === 15; });
  assert.equal(await page.getByLabel('角色大小', { exact: true }).evaluate((e) => getComputedStyle(e.parentElement).flexDirection), 'column');
  await screenshot('14-desktop-size-bubble-settings');
  await button('陪伴').click(); await button('全局设置').click();
  await page.waitForFunction(() => document.querySelector('[aria-label="角色大小"]')?.value === '1.35');
  assert.equal(await page.getByLabel('角色大小', { exact: true }).inputValue(), '1.35');
  assert.equal(await page.getByLabel('气泡自动消失', { exact: true }).inputValue(), '15');
  await page.evaluate(() => window.desktop.overlay({ characterScale: 1, bubbleWidth: 90, bubbleFontSize: 13, bubbleAutoHide: 8 }));
  report.checks.push('global desktop sliders and bubble timeout save and reload without changing service switches');
  await button('陪伴').click();
  await button('朗读这条消息').click();
  await page.getByText('语音已关闭，请打开语音开关后重试', { exact: true }).waitFor();
  assert.equal(speechCount(), 1);
  await button('语音输入').click();
  await page.getByText('听觉开关已关闭', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__metrics.microphone), 0);
  await button('角色配置').click();
  await tab('声音').click(); await button('语音识别').click();
  await button('测试录音（4 秒）').click();
  await page.getByText('听觉已关闭，请打开听觉开关后重试', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__metrics.microphone), 0);
  report.checks.push('speech and hearing master switches prevent manual TTS and both microphone entry points');
  await page.evaluate(() => { window.__micMode = 'pending'; return window.desktop.overlay({ hearingEnabled: true }); });
  await button('测试录音（4 秒）').click();
  await page.waitForFunction(() => typeof window.__resolveMicrophone === 'function');
  await page.evaluate(async () => { await window.desktop.overlay({ hearingEnabled: false }); window.__resolveMicrophone(); });
  await page.waitForFunction(() => window.__metrics.tracksStopped > 0);
  assert.equal(await page.evaluate(() => window.__metrics.recorderStarts), 0);
  await page.evaluate(() => { window.__micMode = 'record'; return window.desktop.overlay({ hearingEnabled: true }); });
  await button('测试录音（4 秒）').click();
  await page.waitForFunction(() => window.__metrics.recorderStarts === 1);
  await page.evaluate(() => window.desktop.overlay({ hearingEnabled: false }));
  await button('测试录音（4 秒）').waitFor();
  assert.equal(await page.evaluate(() => window.__metrics.asrUploads), 0);
  await page.evaluate(() => { window.__micMode = 'record'; return window.desktop.overlay({ hearingEnabled: true }); });
  await button('测试录音（4 秒）').click();
  await page.waitForFunction(() => window.__metrics.recorderStarts === 2);
  await tab('声音').click();
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.__metrics.asrUploads), 0);
  await button('陪伴').click();
  const beforeFailedRecorder = await page.evaluate(() => window.__metrics.tracksStopped);
  await page.evaluate(() => { window.__micMode = 'invalid-recorder'; return window.desktop.overlay({ hearingEnabled: true }); });
  await button('语音输入').click();
  await page.getByText('fixture recorder unavailable', { exact: true }).waitFor();
  assert.ok(await page.evaluate(() => window.__metrics.tracksStopped) > beforeFailedRecorder);
  await page.evaluate(() => { window.__micMode = 'record'; return window.desktop.overlay({ hearingEnabled: true }); });
  await button('语音输入').click();
  await button('结束本次录音').waitFor();
  await page.evaluate(() => window.desktop.overlay({ hearingEnabled: false }));
  await button('语音输入').waitFor();
  assert.equal(await page.evaluate(() => window.__metrics.asrUploads), 0);
  report.checks.push('synthetic microphone: pending permission, active test/chat cancellation and recorder failure release tracks without ASR upload');
  let companion = (await request('/api/settings')).companion;
  await request('/api/modes', 'PUT', [{ ...(await request('/api/bootstrap')).modes[0], screenAllowed: true }]);
  companion.screen = { ...companion.screen, enabled: true, onMessage: true, sourceId: 'fixture', sourceName: 'fixture', periodic: false, onChange: false };
  await request('/api/settings/companion', 'PUT', companion);
  await button('刷新数据').click(); await button('陪伴').click();
  await page.getByLabel('聊天输入').fill('视觉关闭时文字聊天'); await button('发送').click();
  await page.waitForFunction(() => window.__state.messages?.length === 4);
  assert.equal(await page.evaluate(() => window.__metrics.capture), 0);
  await page.evaluate(() => window.desktop.overlay({ visionEnabled: true }));
  await page.getByLabel('聊天输入').fill('捕获失败继续文字'); await button('发送').click();
  await page.waitForFunction(() => window.__state.messages?.length === 6);
  assert.equal(await page.evaluate(() => window.__metrics.capture), 1);
  assert.equal(await page.evaluate(() => window.__state.captureError), '目标窗口不可用');
  assert.ok((await page.locator('.chat-context').innerText()).includes('观察来源不可用'));
  report.checks.push('vision off prevents capture; capture failure has clean error and honest context, text still sends');
  await button('清空当前对话').click();
  await page.getByRole('dialog').waitFor();
  assert.deepEqual(await button('确认清空').evaluate((e) => ({ background: getComputedStyle(e).backgroundColor, color: getComputedStyle(e).color })), { background: 'rgb(196, 67, 74)', color: 'rgb(255, 255, 255)' });
  assert.equal((await request('/api/bootstrap')).messages.length, 6);
  await screenshot('05-clear-confirmation');
  await button('取消').click();
  assert.equal((await request('/api/bootstrap')).messages.length, 6);
  await button('清空当前对话').click(); await button('确认清空').click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal((await request('/api/bootstrap')).messages.length, 0);
  report.checks.push('clear requires confirmation; cancel preserves fixture history; confirm clears fixture only');
  const previewScreen = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 900;
    const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, 1600, 900);
    context.fillStyle = '#25414c'; context.font = '24px sans-serif'; context.fillText('Synthetic chat text 123456', 80, 100);
    const screen = { imageData: canvas.toDataURL('image/png'), sourceName: '合成测试窗口', capturedAt: new Date().toISOString() };
    window.desktop.capture = async () => { window.__metrics.capture++; return screen; };
    return screen;
  });
  await page.getByLabel('聊天输入').fill('测试画面预览'); await button('发送').click();
  await button('预览画面 合成测试窗口').waitFor(); await button('预览画面 合成测试窗口').click();
  await page.waitForFunction(() => document.querySelector('.screen-preview-image img')?.naturalWidth === 1600);
  await page.locator('.screen-preview-toolbar').getByText('1600 × 900', { exact: true }).waitFor();
  assert.ok((await page.locator('.screen-preview-toolbar').innerText()).includes('1600 × 900'));
  await button('原始尺寸').click();
  assert.equal(await page.locator('.screen-preview-image img').evaluate((img) => img.getBoundingClientRect().width), 1600);
  assert.equal(await page.locator('.screen-preview-image').evaluate((e) => e.scrollWidth > e.clientWidth), true);
  await screenshot('15-console-screen-preview'); await button('关闭').click();
  assert.ok(calls.some((call) => call.body.messages?.some((message) => Array.isArray(message.content) && message.content.some((part) => part.image_url?.url === previewScreen.imageData))));
  const persistedScreenshot = (await request('/api/chat/history')).find((message) => message.screen_context);
  assert.deepEqual(Object.keys(persistedScreenshot.screen_context).sort(), ['capturedAt', 'sourceName']);
  await button('刷新数据').click(); await button('预览画面 合成测试窗口').click(); await button('关闭').click();
  const chatState = await page.evaluate(() => window.__state);
  const chat = await browser.newPage({ locale: 'zh-CN', viewport: { width: 360, height: 480 } });
  chat.on('pageerror', (error) => report.errors.push(error.message));
  await chat.addInitScript(() => {
    const listeners = new Set(); window.__push = (state) => { window.__state = state; listeners.forEach((callback) => callback(state)); };
    window.__commands = []; window.desktop = {
      api: async (route) => (await fetch(route)).json(),
      onState: (callback) => { listeners.add(callback); return () => listeners.delete(callback); },
      command: (value) => window.__commands.push(value),
      overlay: async (patch) => {
        const saved = await (await fetch('/api/desktop')).json();
        const response = await fetch('/api/desktop', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...saved, ...patch }) });
        if (!response.ok) throw Error(await response.text());
        const preferences = await response.json(); window.__push({ ...window.__state, desktopPreferences: preferences }); return preferences;
      },
    };
  });
  await chat.goto(url + '/?window=chat'); await chat.locator('.floating-chat-titlebar').waitFor();
  assert.equal(await chat.locator('.floating-chat-titlebar').evaluate((e) => getComputedStyle(e).getPropertyValue('-webkit-app-region')), 'drag');
  assert.equal(await chat.getByLabel('陪伴模式', { exact: true }).evaluate((e) => getComputedStyle(e).getPropertyValue('-webkit-app-region')), 'no-drag');
  assert.equal(await chat.getByRole('button', { name: '预览画面 合成测试窗口', exact: true }).isDisabled(), true);
  await chat.evaluate((state) => window.__push(state), chatState);
  await chat.getByRole('button', { name: '预览画面 合成测试窗口', exact: true }).click();
  await chat.getByRole('dialog').waitFor();
  assert.equal(await chat.locator('.screen-preview-image img').getAttribute('src'), previewScreen.imageData);
  assert.equal(await chat.locator('.floating-chat-titlebar').evaluate((e) => getComputedStyle(e).getPropertyValue('-webkit-app-region')), 'no-drag');
  assert.equal(await chat.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await chat.screenshot({ path: path.join(qa, '16-floating-chat-preview.png') });
  await chat.getByRole('button', { name: '原始尺寸', exact: true }).click();
  assert.equal(await chat.locator('.screen-preview-image').evaluate((e) => e.scrollWidth > e.clientWidth), true);
  await chat.getByRole('dialog').press('Escape');
  await chat.getByLabel('聊天输入').fill('浮窗发送'); await chat.getByRole('button', { name: '发送', exact: true }).click();
  assert.deepEqual(await chat.evaluate(() => window.__commands.at(-1)), { type: 'send', value: '浮窗发送' });
  await chat.screenshot({ path: path.join(qa, '17-floating-chat-titlebar.png') });
  const preferencesBeforeFloatingVoice = await request('/api/desktop');
  await chat.evaluate((preferences) => window.__push({ ...window.__state, desktopPreferences: preferences, draft: '语音转写草稿', continuous: false, recording: false }), preferencesBeforeFloatingVoice);
  await chat.waitForFunction(() => document.querySelector('[aria-label="聊天输入"]')?.value === '语音转写草稿');
  assert.equal(await chat.getByLabel('聊天输入').inputValue(), '语音转写草稿');
  await chat.getByLabel('聊天输入').fill('修改转写');
  assert.deepEqual(await chat.evaluate(() => window.__commands.at(-1)), { type: 'draft', value: '修改转写' });
  await chat.getByRole('button', { name: '语音输入', exact: true }).click();
  assert.equal(await chat.evaluate(() => window.__commands.at(-1)), 'voice');
  await chat.getByRole('button', { name: '开始通话', exact: true }).click();
  assert.equal(await chat.evaluate(() => window.__commands.at(-1)), 'continuous');
  await chat.evaluate(() => window.__push({ ...window.__state, draft: '通话中插话', continuous: true, busy: true, voicePhase: 'listening' }));
  await chat.getByRole('button', { name: '挂断通话', exact: true }).waitFor();
  assert.equal(await chat.getByRole('button', { name: '发送', exact: true }).isDisabled(), false);
  await chat.getByRole('button', { name: '发送', exact: true }).click();
  assert.deepEqual(await chat.evaluate(() => window.__commands.at(-1)), { type: 'send', value: '通话中插话' });
  await chat.getByRole('button', { name: '挂断通话', exact: true }).click();
  const beforeEyeCommands = await chat.evaluate(() => window.__commands.length);
  await chat.getByRole('switch', { name: '屏幕感知总开关', exact: true }).click();
  await chat.waitForFunction((enabled) => window.__state.desktopPreferences.visionEnabled === !enabled, preferencesBeforeFloatingVoice.visionEnabled);
  assert.equal((await request('/api/desktop')).visionEnabled, !preferencesBeforeFloatingVoice.visionEnabled);
  assert.equal(await chat.evaluate(() => window.__commands.length), beforeEyeCommands);
  await request('/api/desktop', 'PUT', preferencesBeforeFloatingVoice);
  await chat.close();
  report.checks.push('both chats preview the exact sent image with dimensions and 1:1 scrolling; history only stores metadata; floating titlebar drag is separate from controls and disabled under dialogs');
  report.checks.push('floating chat syncs voice drafts and editing; separate mic/phone commands, call permits busy text interruption; eye persists switch without sending');
  const second = await request('/api/roles', 'POST', { name: '第二测试角色', intro: '' });
  await button('刷新数据').click();
  await page.evaluate((id) => window.__command({ type: 'role', value: id }), second.id);
  await page.waitForFunction((id) => document.querySelector('[aria-label="当前角色"]')?.value === id, second.id);
  assert.equal((await request('/api/bootstrap')).activeRoleId, second.id);
  await page.waitForFunction(() => Object.keys(window.__state.screenPreviews || {}).length === 0);
  await page.evaluate((id) => window.__command({ type: 'role', value: id }), firstRole);
  await page.waitForFunction((id) => document.querySelector('[aria-label="当前角色"]')?.value === id, firstRole);
  assert.equal((await request('/api/bootstrap')).settings.providers.llm.model, 'fixture-model');
  report.checks.push('status-bar role command switches isolated identities and restores original configuration');

  await button('角色配置').click();
  await tab('视觉').click();
  await page.getByRole('heading', { name: '屏幕感知', exact: true }).waitFor();
  await screenshot('07-configuration-vision');
  await tab('记忆').click();
  await button('添加记忆').click();
  await page.getByLabel('内容', { exact: true }).fill('保留的角色记忆');
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('保留的角色记忆', { exact: true }).waitFor();
  await screenshot('08-configuration-memory');
  await tab('思维').click(); await button('管理方案').click();
  await page.getByRole('heading', { name: '服务方案库', exact: true }).waitFor();
  await button('返回角色配置').click();
  assert.match(await button('角色配置').getAttribute('class'), /selected/);
  report.checks.push('four configuration tabs render, memory saves and scheme manager returns to configuration');

  const asset = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 200; canvas.height = 500;
    const context = canvas.getContext('2d'); context.fillStyle = '#d54162'; context.fillRect(0, 0, 200, 500);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const form = new FormData(); form.append('file', blob, 'fade-fixture.png');
    const response = await fetch('/api/characters/import', { method: 'POST', body: form });
    if (!response.ok) throw Error(await response.text()); return response.json();
  });
  const half = await request('/api/appearances', 'POST', { name: '半身夹具', assetId: asset.id, framing: 'half' });
  const full = await request('/api/appearances', 'POST', { name: '全身夹具', assetId: asset.id, framing: 'full' });
  await button('刷新数据').click(); await button('角色形象').click();
  await page.getByRole('switch', { name: '允许 AI 主动切换', exact: true }).click();
  assert.equal((await request('/api/settings')).companion.allowAutoAppearance, false);
  await button('角色设定').click();
  await page.getByRole('tab', { name: '基础设定', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('tab', { name: '日常闲聊', exact: true }).getAttribute('aria-selected'), 'true');
  const activeModeBeforeEdit = (await request('/api/settings')).companion.mode;
  await page.getByLabel('场景提示词', { exact: true }).filter({ visible: true }).fill('未保存的模式草稿');
  await page.getByRole('tab', { name: '基础设定', exact: true }).click();
  await page.getByLabel('角色名字', { exact: true }).fill('未保存的角色草稿');
  await page.getByRole('tab', { name: '日常闲聊', exact: true }).click();
  assert.equal(await page.getByLabel('场景提示词', { exact: true }).filter({ visible: true }).inputValue(), '未保存的模式草稿');
  await page.getByRole('tab', { name: '基础设定', exact: true }).click();
  assert.equal(await page.getByLabel('角色名字', { exact: true }).inputValue(), '未保存的角色草稿');
  assert.equal((await request('/api/settings')).companion.mode, activeModeBeforeEdit);
  await button('新建模式').click();
  assert.equal(await button('工作流').isDisabled(), true);
  await page.getByLabel('模式名称', { exact: true }).filter({ visible: true }).fill('夜间陪伴');
  await page.getByLabel('场景提示词', { exact: true }).filter({ visible: true }).fill('简短回应，避免打扰。');
  await page.getByLabel('默认形象', { exact: true }).filter({ visible: true }).selectOption(half.id);
  assert.equal(await page.getByLabel('回复长度', { exact: true }).filter({ visible: true }).inputValue(), 'inherit');
  await button('保存').click(); await page.getByText('模式已保存', { exact: true }).waitFor();
  let snapshot = await request('/api/bootstrap');
  const mode = snapshot.modes.find((item) => item.name === '夜间陪伴');
  assert.equal(snapshot.settings.companion.modeAppearances[mode.id], half.id);
  const legacy = [
    { id: 'legacy-all', name: '原有共享流程', enabled: true, trigger: 'message', mode: 'all', keyword: '', prompt: 'shared legacy' },
    { id: 'daily-only', name: '日常专属流程', enabled: true, trigger: 'message', mode: 'daily', keyword: '', prompt: 'daily legacy' },
  ];
  await request('/api/workflows', 'PUT', legacy); await button('刷新数据').click();
  await button('工作流').click();
  assert.equal(await button('日常专属流程').count(), 0);
  await page.getByText('共享', { exact: true }).filter({ visible: true }).waitFor();
  await button('添加工作流').click();
  await page.getByLabel('工作流名称').filter({ visible: true }).fill('夜间工作流');
  assert.equal(await page.getByLabel('适用模式').filter({ visible: true }).inputValue(), mode.id);
  await page.getByLabel('提示词', { exact: true }).filter({ visible: true }).fill('只有需要时回应。');
  await button('保存').click(); await page.getByText('工作流已保存', { exact: true }).waitFor();
  const flows = await request('/api/workflows');
  assert.deepEqual(flows.find((item) => item.id === 'daily-only'), legacy[1]);
  assert.deepEqual(flows.find((item) => item.id === 'legacy-all'), legacy[0]);
  assert.equal(flows.find((item) => item.name === '夜间工作流').mode, mode.id);
  await screenshot('09-mode-workflows');
  await page.getByRole('tab', { name: '日常闲聊', exact: true }).click(); await button('工作流').click();
  assert.equal(await button('夜间工作流').count(), 0);
  await button('日常专属流程').waitFor();
  await page.getByRole('tab', { name: '夜间陪伴', exact: true }).click();
  await button('使用此模式').click(); await button('陪伴').click();
  await page.waitForFunction((id) => document.querySelector('[aria-label="当前形象"]')?.value === id, half.id);
  report.checks.push('mode owns default appearance and new workflows; legacy shared and other mode workflows survive save');
  report.checks.push('role settings tabs preserve unsaved base and mode drafts; editing does not activate modes; new modes inherit reply length');

  await page.getByRole('switch', { name: '主动发言', exact: true }).click();
  await page.waitForFunction(async () => (await (await fetch('/api/bootstrap')).json()).modes.find((m) => m.name === '夜间陪伴').proactive === true);
  await button('角色设定').click(); await page.getByRole('tab', { name: '夜间陪伴', exact: true }).click();
  await page.getByRole('switch', { name: '模式允许屏幕感知', exact: true }).click();
  await screenshot('31-role-mode-settings');
  await button('主动互动').click();
  assert.equal(await page.getByRole('switch', { name: '模式主动发言', exact: true }).getAttribute('aria-checked'), 'true');
  await page.getByRole('switch', { name: '模式定期观察', exact: true }).click();
  await page.getByLabel('观察间隔（秒）').filter({ visible: true }).fill('5');
  await page.getByLabel('安静开始').filter({ visible: true }).fill('00:00');
  await page.getByLabel('安静结束').filter({ visible: true }).fill('00:00');
  await button('保存').click(); await page.getByText('模式已保存', { exact: true }).waitFor();
  await screenshot('32-mode-automatic-observation');
  await page.setViewportSize({ width: 390, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await screenshot('33-mode-mobile');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await button('陪伴').click();
  let automaticState = (await request('/api/settings')).companion;
  await request('/api/settings/companion', 'PUT', { ...automaticState, focus: true }); await button('刷新数据').click();
  const capturesBeforeAutomatic = await page.evaluate(() => window.__metrics.capture);
  await page.waitForTimeout(5300);
  assert.equal(await page.evaluate(() => window.__metrics.capture), capturesBeforeAutomatic);
  await page.getByRole('switch', { name: '专注', exact: true }).click();
  await page.waitForFunction((count) => window.__metrics.capture > count, capturesBeforeAutomatic, { timeout: 10000 });
  await page.waitForFunction(() => window.__state.messages.some((m) => m.role === 'user' && m.content.startsWith('请看看当前的')));
  const capturesAfterAutomatic = await page.evaluate(() => window.__metrics.capture);
  await page.waitForTimeout(5300);
  assert.equal(await page.evaluate(() => window.__metrics.capture), capturesAfterAutomatic);
  await page.getByRole('switch', { name: '主动发言', exact: true }).click();
  await button('角色设定').click(); await page.getByRole('tab', { name: '夜间陪伴', exact: true }).click(); await button('主动互动').click();
  assert.equal(await page.getByRole('switch', { name: '模式主动发言', exact: true }).getAttribute('aria-checked'), 'false');
  await page.getByRole('switch', { name: '模式定期观察', exact: true }).click();
  await button('保存').click(); await page.getByText('模式已保存', { exact: true }).waitFor();
  await button('角色配置').click(); await tab('视觉').click();
  assert.equal(await page.getByRole('switch', { name: '定期捕获', exact: true }).count(), 0);
  assert.equal(await page.getByLabel('观察间隔（秒）').count(), 0);
  report.checks.push('proactive quick toggle and mode edit share persisted state; sampling belongs only to modes; focus and cooldown prevent synthetic capture before dispatch; 390px mode editing stays within viewport');

  await button('角色库').click();
  assert.equal(await page.getByText('角色包导入与导出', { exact: true }).count(), 0);
  await page.locator('.page-heading .upload-button').getByText('导入角色', { exact: true }).waitFor();
  await button('导出当前角色').click();
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: '导出角色', exact: true }).click();
  const download = await downloadReady;
  const exported = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
  assert.equal(exported.format, 'nice-people-role');
  assert.equal(exported.workflows.length, 3);
  assert.equal(exported.settings.providers.llm.apiKey, '');
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await screenshot('10-role-library');
  report.checks.push('role library provides existing import and key-free export without a separate bundle page');

  await page.evaluate(() => window.desktop.overlay({ speechEnabled: true }));
  const existingProviders = (await request('/api/settings')).providers;
  const originalTts = existingProviders.tts;
  await request('/api/settings/providers', 'PUT', { ...existingProviders, tts: { ...originalTts, provider: 'openai', baseUrl: modelUrl + '/t2a_v2', apiKey: 'isolated-minimax-key', model: 'speech-2.8-hd', voice: 'male-qn-qingse' } });
  await button('刷新数据').click();
  await button('角色配置').click(); await tab('声音').click();
  assert.equal(await page.getByLabel('TTS 服务', { exact: true }).inputValue(), 'minimax');
  assert.equal((await request('/api/settings')).providers.tts.provider, 'openai');
  await button('保存').click(); await page.getByText('服务配置已保存', { exact: true }).waitFor();
  const miniSettings = (await request('/api/settings')).providers;
  assert.equal(miniSettings.tts.provider, 'minimax');
  assert.equal(miniSettings.tts.apiKey, '');
  const beforeMiniPlayback = await page.evaluate(() => window.__metrics.played);
  await button('试听').click();
  await page.waitForFunction((count) => window.__metrics.played > count, beforeMiniPlayback);
  const miniCalls = calls.filter((call) => call.path === '/v1/t2a_v2');
  assert.equal(miniCalls.length, 1);
  assert.equal(miniCalls[0].body.voice_setting.voice_id, 'male-qn-qingse');
  assert.equal(miniCalls[0].body.audio_setting.format, 'wav');
  assert.equal(miniCalls[0].body.output_format, 'hex');
  assert.equal(miniCalls[0].body.input, undefined);
  await screenshot('13-minimax-http-tts');
  await request('/api/settings/providers', 'PUT', { ...miniSettings, tts: originalTts });
  await button('刷新数据').click();
  report.checks.push('stored OpenAI type with MiniMax endpoint is corrected in draft; save retains key; audition uses native MiniMax and decodes hex WAV');

  await request('/api/appearances/' + half.id + '/activate', 'POST');
  await request('/api/desktop', 'PUT', { ...await request('/api/desktop'), hearingEnabled: true });
  const overlayState = await request('/api/bootstrap');
  const overlay = await browser.newPage({ locale: 'zh-CN', viewport: { width: 350, height: 546 } });
  await overlay.exposeFunction('__resizeOverlay', async (height) => { await overlay.setViewportSize({ width: overlay.viewportSize().width, height }); });
  overlay.on('pageerror', (error) => report.errors.push(error.message));
  await overlay.addInitScript(() => {
    const listeners = new Set();
    let appliedHeight = 72;
    window.__push = (state) => { window.__state = state; listeners.forEach((callback) => callback(state)); };
    window.__commands = [];
    window.__preferenceCalls = [];
    window.__pointerMap = [];
    window.desktop = {
      api: async (route, options = {}) => (await fetch(route, { method: options.method || 'GET', headers: { 'Content-Type': 'application/json' }, body: options.body ? JSON.stringify(options.body) : undefined })).json(),
      onState: (callback) => { listeners.add(callback); return () => listeners.delete(callback); },
      command: (command) => window.__commands.push(command), openChat: async () => { window.__openedChat = true; },
      pointerRegions: (regions, capturing) => { window.__pointerMap = regions; window.__pointerCapturing = capturing; },
      overlay: async (patch) => {
        window.__preferenceCalls.push(patch);
        if (window.__failPreferences) throw Error('保存失败');
        const prefs = await (await fetch('/api/desktop')).json();
        const next = { ...prefs, ...Object.fromEntries(Object.entries(patch).filter(([key]) => key in prefs)) };
        if ('bubbleHeight' in patch || 'bubbleHeightPreview' in patch) {
          const height = patch.bubbleHeightPreview ?? next.bubbleHeight;
          await window.__resizeOverlay(innerHeight - appliedHeight + height); appliedHeight = height;
        }
        if (Object.keys(patch).some((key) => key in prefs)) {
          const response = await fetch('/api/desktop', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
          if (!response.ok) throw Error('保存失败');
          if (window.__state) window.__push({ ...window.__state, desktopPreferences: next });
        }
        return next;
      },
    };
  });
  await overlay.goto(url + '/?window=companion');
  await overlay.locator('.avatar-loading').waitFor({ state: 'hidden' });
  await overlay.locator('.portrait').waitFor();
  await overlay.evaluate((data) => window.__push({ appearance: data.appearances.find((a) => a.id === data.settings.companion.activeAppearanceId), persona: data.settings.persona, emotion: 'neutral', status: 'idle', message: '', muted: false, motions: [], appearances: data.appearances, modes: data.modes, companion: data.settings.companion, desktopPreferences: data.desktop }), overlayState);
  assert.equal(await overlay.locator('.overlay-menu').getAttribute('aria-hidden'), 'true');
  const bounds = await overlay.locator('.avatar-viewport').boundingBox();
  const transparent = await overlay.screenshot({ path: path.join(qa, '11-overlay-fade-hidden.png'), omitBackground: true });
  const alpha = await overlay.evaluate(async ({ bytes, bounds }) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close();
    const x = Math.floor(bounds.x + bounds.width / 2);
    return [bounds.height - 11, bounds.height - 5, bounds.height - .5].map((y) => context.getImageData(x, Math.floor(bounds.y + y), 1, 1).data[3]);
  }, { bytes: [...transparent], bounds });
  assert.ok(alpha[0] > 250 && alpha[1] > 90 && alpha[1] < 180 && alpha[2] < 30, JSON.stringify(alpha));
  assert.equal(await overlay.locator('.avatar-viewport').evaluate((e) => getComputedStyle(e).getPropertyValue('--bottom-fade').trim()), '10px');
  report.fadeAlpha = alpha;
  await overlay.mouse.move(170, 180);
  await overlay.getByRole('button', { name: '打开聊天', exact: true }).click();
  assert.equal(await overlay.evaluate(() => window.__openedChat), true);
  assert.equal(await overlay.locator('.overlay-controls .icon-button').count(), 8);
  const switchNames = await overlay.locator('.overlay-controls [role=switch]').evaluateAll((elements) => elements.map((e) => e.getAttribute('aria-label')));
  assert.deepEqual(switchNames, ['通话开关', '屏幕感知总开关', '语音播放总开关']);
  await overlay.evaluate(() => { window.__toolbarBase = window.__state; window.__push({ ...window.__state, muted: false, continuous: true, desktopPreferences: { ...window.__state.desktopPreferences, visionEnabled: true, speechEnabled: true } }); });
  await overlay.waitForFunction(() => [...document.querySelectorAll('.overlay-controls [role=switch]')].every((e) => e.getAttribute('aria-checked') === 'true'));
  for (const name of switchNames) {
    const control = overlay.getByRole('switch', { name, exact: true });
    assert.equal(await control.getAttribute('aria-checked'), 'true', name);
    assert.equal(await control.evaluate((e) => getComputedStyle(e).backgroundColor), 'rgb(223, 244, 237)');
  }
  await overlay.evaluate(() => window.__push({ ...window.__toolbarBase, muted: true, continuous: false }));
  await overlay.waitForFunction(() => document.querySelector('[aria-label="通话开关"]')?.getAttribute('aria-checked') === 'false');
  report.checks.push('overlay call, vision and speech controls share switch states; vision and speech are adjacent with matching green enabled background');
  for (const [name, key] of [['屏幕感知总开关', 'visionEnabled']]) {
    const control = overlay.getByRole('switch', { name, exact: true });
    const previous = await control.getAttribute('aria-checked');
    await control.click();
    await overlay.waitForFunction(({ name, value }) => document.querySelector(`[aria-label="${name}"]`)?.getAttribute('aria-checked') === value, { name, value: String(previous !== 'true') });
    assert.equal((await request('/api/desktop'))[key], previous !== 'true');
    await control.click();
    await overlay.waitForFunction(({ name, value }) => document.querySelector(`[aria-label="${name}"]`)?.getAttribute('aria-checked') === value, { name, value: previous });
  }
  assert.equal(await overlay.evaluate(() => window.__commands.some((c) => c === 'voice' || c === 'observe')), false);
  await overlay.getByRole('switch', { name: '通话开关', exact: true }).click();
  assert.equal(await overlay.evaluate(() => window.__commands.at(-1)), 'continuous');
  await overlay.evaluate(() => { window.__failPreferences = true; });
  const visionBefore = await overlay.getByRole('switch', { name: '屏幕感知总开关' }).getAttribute('aria-checked');
  await overlay.getByRole('switch', { name: '屏幕感知总开关' }).click();
  await overlay.getByRole('alert').getByText('保存失败').waitFor();
  assert.equal(await overlay.getByRole('switch', { name: '屏幕感知总开关' }).getAttribute('aria-checked'), visionBefore);
  await overlay.evaluate(() => { window.__failPreferences = false; });
  await overlay.getByRole('button', { name: '隐藏角色' }).click();
  await overlay.waitForFunction(async () => (await (await fetch('/api/desktop')).json()).visible === false);
  await overlay.evaluate(() => window.desktop.overlay({ visible: true }));
  assert.equal((await request('/api/desktop')).visible, true);
  report.checks.push('overlay phone dispatches call toggle; eye persists visual master switch; no recording/observe commands; failed save leaves switch unchanged; hide and restore share preferences');
  assert.equal(await overlay.locator('.overlay-controls>.overlay-drag').count(), 1);
  assert.equal(await overlay.locator('.overlay-status').count(), 0);
  await overlay.getByRole('button', { name: '切换陪伴模式', exact: true }).click();
  await overlay.locator('.overlay-popover').waitFor();
  assert.equal(await overlay.locator('.overlay-popover').getByText('角色形象', { exact: true }).count(), 0);
  await overlay.locator('.overlay-popover').getByRole('button', { name: '夜间陪伴', exact: true }).click();
  assert.equal((await overlay.evaluate(() => window.__commands.at(-1))).type, 'mode');
  assert.equal(await overlay.locator('.overlay-popover').count(), 0);
  await overlay.getByRole('button', { name: '更换形象', exact: true }).click();
  await overlay.locator('.overlay-popover').getByRole('button', { name: full.name, exact: true }).click();
  assert.equal((await overlay.evaluate(() => window.__commands.at(-1))).type, 'appearance');
  assert.equal(await overlay.locator('.overlay-controls').evaluate((e) => getComputedStyle(e).maskImage), 'none');
  await overlay.screenshot({ path: path.join(qa, '12-overlay-fade-menu.png'), omitBackground: true });
  await overlay.mouse.move(-10, -10);
  await overlay.waitForTimeout(5200);
  assert.equal(await overlay.locator('.overlay-menu').getAttribute('aria-hidden'), 'true');
  assert.equal(await overlay.locator('.overlay-avatar').evaluate((e) => getComputedStyle(e).display), 'block');
  for (const [appearance, framing] of [[overlayState.appearances.find((item) => item.id === full.id), 'full'], [{ ...overlayState.appearances.find((item) => item.id === half.id), framing: 'mini' }, 'mini']]) {
    await overlay.evaluate(({ appearance, data }) => window.__push({ appearance, persona: data.settings.persona, emotion: 'neutral', status: 'idle', message: '', muted: true, motions: [], appearances: data.appearances, modes: data.modes, companion: data.settings.companion, desktopPreferences: data.desktop }), { appearance, data: overlayState });
    await overlay.locator('.avatar-viewport.' + framing).waitFor();
    assert.ok((await overlay.locator('.avatar-viewport').evaluate((e) => getComputedStyle(e).maskImage)).includes('linear-gradient'));
    assert.equal(await overlay.locator('.avatar-viewport').evaluate((e) => getComputedStyle(e).getPropertyValue('--bottom-fade').trim()), '10px');
  }
  const bubbleState = { appearance: overlayState.appearances.find((item) => item.id === half.id), persona: overlayState.settings.persona, emotion: 'neutral', status: 'idle', message: '气泡测试：这是一条需要自动消失的回复。'.repeat(6), muted: true, motions: [], appearances: overlayState.appearances, modes: overlayState.modes, companion: overlayState.settings.companion, desktopPreferences: { ...overlayState.desktop, bubbleAutoHide: 1, bubbleWidth: 75, bubbleFontSize: 17 }, messages: [{ id: 991, role: 'assistant', content: '气泡测试', created_at: new Date().toISOString() }] };
  await overlay.evaluate((state) => window.__push(state), bubbleState);
  await overlay.locator('.speech-bubble').waitFor();
  assert.equal(await overlay.locator('.speech-bubble').evaluate((e) => getComputedStyle(e).fontSize), '17px');
  const lineGeometry = await overlay.locator('.speech-bubble>p').evaluate((e) => ({ height: e.getBoundingClientRect().height, line: parseFloat(getComputedStyle(e).lineHeight) }));
  assert.ok(lineGeometry.height > 20 && lineGeometry.height < 72);
  const avatarBefore = await overlay.locator('.overlay-avatar').boundingBox();
  const toolbarBefore = await overlay.locator('.overlay-controls').boundingBox();
  assert.ok(Math.abs(avatarBefore.y + avatarBefore.height - toolbarBefore.y - 8) < 1);
  const bubbleBefore = await overlay.locator('.speech-bubble').boundingBox();
  assert.ok(Math.abs(avatarBefore.y - bubbleBefore.y - bubbleBefore.height - 8) < 1);
  await overlay.screenshot({ path: path.join(qa, '18-bubble-styled.png'), omitBackground: true });
  await overlay.waitForTimeout(1150); assert.equal(await overlay.locator('.speech-bubble').count(), 0);
  assert.deepEqual(await overlay.locator('.overlay-avatar').boundingBox(), avatarBefore);
  await overlay.evaluate((state) => window.__push({ ...state, emotion: 'happy' }), bubbleState);
  assert.equal(await overlay.locator('.speech-bubble').count(), 0);
  bubbleState.messages[0].id = 992;
  await overlay.evaluate((state) => window.__push(state), bubbleState); await overlay.locator('.speech-bubble').waitFor();
  await overlay.waitForTimeout(600); bubbleState.messages[0].id = 993;
  await overlay.evaluate((state) => window.__push(state), bubbleState);
  await overlay.waitForTimeout(600); assert.equal(await overlay.locator('.speech-bubble').count(), 1);
  await overlay.waitForTimeout(600); assert.equal(await overlay.locator('.speech-bubble').count(), 0);
  bubbleState.messages[0].id = 994; bubbleState.desktopPreferences.bubbleAutoHide = 0;
  await overlay.evaluate((state) => window.__push(state), bubbleState); await overlay.locator('.speech-bubble').waitFor();
  await overlay.waitForTimeout(1100); assert.equal(await overlay.locator('.speech-bubble').count(), 1);
  await overlay.getByRole('button', { name: '隐藏气泡', exact: true }).click(); assert.equal(await overlay.locator('.speech-bubble').count(), 0);
  await overlay.mouse.move(-10, -10);
  bubbleState.messages[0].id = 995; bubbleState.desktopPreferences.bubbleAutoHide = 1; bubbleState.status = 'speaking';
  await overlay.evaluate((state) => window.__push(state), bubbleState); await overlay.locator('.speech-bubble').waitFor();
  await overlay.waitForTimeout(1150); assert.equal(await overlay.locator('.speech-bubble').count(), 1);
  bubbleState.status = 'idle'; await overlay.evaluate((state) => window.__push(state), bubbleState);
  await overlay.waitForTimeout(1150); assert.equal(await overlay.locator('.speech-bubble').count(), 0);
  for (const viewport of [{ width: 260, height: 317 }, { width: 592, height: 900 }]) {
    await overlay.setViewportSize(viewport); bubbleState.messages[0].id++; bubbleState.desktopPreferences.bubbleAutoHide = 0;
    await overlay.evaluate((state) => window.__push(state), bubbleState); await overlay.mouse.move(100, 100);
    const controls = await overlay.locator('.overlay-controls').boundingBox();
    assert.ok(controls.x >= 0 && controls.x + controls.width <= viewport.width);
    assert.equal(await overlay.locator('.overlay-controls').evaluate((e) => e.scrollWidth <= e.clientWidth), true);
    const bubbleBounds = await overlay.locator('.speech-bubble').boundingBox();
    const avatarBounds = await overlay.locator('.overlay-avatar').boundingBox();
    assert.ok(Math.abs(avatarBounds.y - bubbleBounds.y - bubbleBounds.height - 8) < 1);
    await overlay.screenshot({ path: path.join(qa, `19-overlay-${viewport.width}.png`), omitBackground: true });
  }
  bubbleState.appearance = { ...bubbleState.appearance, framing: 'mini' };
  const savedBeforeResize = await request('/api/desktop');
  await request('/api/desktop', 'PUT', { ...savedBeforeResize, bubbleWidth: bubbleState.desktopPreferences.bubbleWidth,
    bubbleFontSize: bubbleState.desktopPreferences.bubbleFontSize, bubbleHeight: bubbleState.desktopPreferences.bubbleHeight });
  await overlay.setViewportSize({ width: 350, height: 546 });
  bubbleState.messages[0].id++; await overlay.evaluate((state) => window.__push(state), bubbleState);
  await overlay.getByRole('slider', { name: '气泡高度' }).waitFor();
  await overlay.waitForTimeout(100);
  const initialBubble = await overlay.locator('.speech-bubble').boundingBox();
  const initialAvatar = await overlay.locator('.overlay-avatar').boundingBox();
  const handle = await overlay.getByRole('slider', { name: '气泡高度' }).boundingBox();
  await overlay.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await overlay.mouse.down(); await overlay.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 - 80, { steps: 4 }); await overlay.mouse.up();
  await overlay.waitForFunction(async () => (await (await fetch('/api/desktop')).json()).bubbleHeight === 152);
  await overlay.waitForFunction(() => document.querySelector('[aria-label="气泡高度"]')?.getAttribute('aria-valuenow') === '152');
  const resizedBubble = await overlay.locator('.speech-bubble').boundingBox();
  const resizedAvatar = await overlay.locator('.overlay-avatar').boundingBox();
  assert.equal(resizedBubble.width, initialBubble.width); assert.equal(Math.round(resizedBubble.height), 152);
  assert.equal(resizedAvatar.height, initialAvatar.height);
  assert.ok(await overlay.locator('.speech-bubble>p').evaluate((e) => e.clientHeight > 80));
  assert.ok(await overlay.evaluate(() => window.__preferenceCalls.some((p) => p.bubbleHeightPreview === 152)));
  await overlay.screenshot({ path: path.join(qa, '20-bubble-height-resized-mini.png'), omitBackground: true });
  await overlay.getByRole('slider', { name: '气泡高度' }).focus(); await overlay.keyboard.press('ArrowUp');
  await overlay.waitForFunction(async () => (await (await fetch('/api/desktop')).json()).bubbleHeight === 162);
  await overlay.getByRole('slider', { name: '气泡高度' }).blur();
  bubbleState.desktopPreferences.bubbleHeight = 162;
  await overlay.evaluate((state) => window.__push(state), bubbleState);
  await overlay.waitForFunction(() => document.querySelector('[aria-label="气泡高度"]')?.getAttribute('aria-valuenow') === '162');
  assert.equal(await overlay.getByRole('slider', { name: '气泡高度' }).getAttribute('aria-valuenow'), '162');
  const cancelHandle = await overlay.getByRole('slider', { name: '气泡高度' }).boundingBox();
  await overlay.mouse.move(cancelHandle.x + cancelHandle.width / 2, cancelHandle.y + 7); await overlay.mouse.down();
  await overlay.mouse.move(cancelHandle.x + cancelHandle.width / 2, cancelHandle.y - 23);
  await overlay.waitForFunction(() => document.querySelector('[aria-label="气泡高度"]')?.getAttribute('aria-valuenow') === '192');
  await overlay.locator('.bubble-resize').evaluate((e) => e.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true })));
  await overlay.mouse.up();
  await overlay.waitForFunction(() => document.querySelector('[aria-label="气泡高度"]')?.getAttribute('aria-valuenow') === '162');
  assert.equal((await request('/api/desktop')).bubbleHeight, 162);
  await overlay.getByRole('slider', { name: '气泡高度' }).focus(); await overlay.keyboard.press('End');
  await overlay.waitForFunction(async () => (await (await fetch('/api/desktop')).json()).bubbleHeight === 280);
  await overlay.keyboard.press('Home');
  await overlay.waitForFunction(async () => (await (await fetch('/api/desktop')).json()).bubbleHeight === 56);
  await overlay.evaluate(() => window.desktop.overlay({ bubbleHeight: 162 }));
  await overlay.getByRole('slider', { name: '气泡高度' }).blur();
  bubbleState.desktopPreferences.bubbleAutoHide = 1; bubbleState.messages[0].id++;
  await overlay.evaluate((state) => window.__push(state), bubbleState);
  const readingBubble = await overlay.locator('.speech-bubble').boundingBox();
  await overlay.mouse.move(readingBubble.x + 30, readingBubble.y + 40); await overlay.waitForTimeout(1150);
  assert.equal(await overlay.locator('.speech-bubble').count(), 1);
  await overlay.mouse.move(-10, -10); await overlay.waitForTimeout(1150);
  assert.equal(await overlay.locator('.speech-bubble').count(), 0);
  report.checks.push('resize cancellation restores saved height; keyboard respects min/max; hovering to read pauses auto-hide and leaving restarts it');
  const paddedPng = await overlay.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 200; canvas.height = 500;
    const context = canvas.getContext('2d'); context.fillStyle = '#d83b63'; context.fillRect(40, 50, 120, 400);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await overlay.route('**/assets/characters/transparent-bounds.png', (route) => route.fulfill({ contentType: 'image/png', body: Buffer.from(paddedPng, 'base64') }));
  bubbleState.appearance = { ...bubbleState.appearance, framing: 'full', modelPath: 'transparent-bounds.png' };
  bubbleState.desktopPreferences.bubbleAutoHide = 0; bubbleState.messages[0].id++;
  await overlay.evaluate((state) => window.__push(state), bubbleState);
  await overlay.locator('.avatar-loading').waitFor({ state: 'hidden' }); await overlay.waitForTimeout(150);
  await overlay.mouse.move(100, 300);
  const paddedAvatar = await overlay.locator('.avatar-viewport').boundingBox();
  const paddedBubble = await overlay.locator('.speech-bubble').boundingBox();
  const paddedToolbar = await overlay.locator('.overlay-controls').boundingBox();
  assert.ok(Math.abs(paddedBubble.y + paddedBubble.height + 8 - (paddedAvatar.y + paddedAvatar.height * .1)) < 4);
  assert.ok(Math.abs(paddedToolbar.y + 8 - (paddedAvatar.y + paddedAvatar.height * .9)) < 4);
  await overlay.screenshot({ path: path.join(qa, '21-transparent-character-anchors.png'), omitBackground: true });
  await overlay.evaluate(() => window.__push({ ...window.__state, desktopPreferences: { ...window.__state.desktopPreferences, showBubble: false } }));
  await overlay.waitForFunction(() => !document.querySelector('.speech-bubble'));
  assert.equal(await overlay.locator('.bubble-resize').count(), 0);
  await overlay.waitForFunction(() => window.__pointerMap.length > 0);
  assert.equal(await overlay.evaluate(() => window.__pointerMap.some((r) => 5 >= r.y && 5 < r.y + r.height)), false);
  await overlay.evaluate(() => window.__push({ ...window.__state, desktopPreferences: { ...window.__state.desktopPreferences, showBubble: true } }));
  await overlay.locator('.speech-bubble').waitFor();
  report.checks.push('hidden bubbles and empty upper window area are excluded from native hit map; visible bubble resize and controls remain interactive');
  report.checks.push('transparent asset margins are excluded from bubble and toolbar anchors, not mistaken for character space');
  report.checks.push('bubble top handle drags height directly, keeps width/character size stable, expands scrollable text, saves on release and supports keyboard resize');
  await overlay.close();
  report.checks.push('10px fade preserved; eight icon controls plus integrated grip fit minimum size; toolbar overlaps character bottom by 8px; popovers close on selection; hover menu still hides after five seconds');
  report.checks.push('bubble settings apply; timeout restarts for repeated new replies, not unrelated state; never-hide and manual dismiss work; speech postpones expiry; avatar layout never jumps');

  await page.setViewportSize({ width: 390, height: 900 });
  await button('全局设置').click();
  await page.getByLabel('角色大小', { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-label="角色大小"]')?.disabled);
  await page.locator('.desktop-setting-preview .avatar-loading').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await screenshot('20-narrow-desktop-settings');
  await button('角色配置').click();
  await tab('思维').click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await screenshot('06-narrow-configuration');
  report.checks.push('390px configuration and sidebar do not overflow horizontally');
  await page.setViewportSize({ width: 1440, height: 1000 }); await button('陪伴').click();
  await page.evaluate(() => { window.__micMode = 'record'; window.__asrMode = 'record'; return window.desktop.overlay({ hearingEnabled: true, speechEnabled: true, visionEnabled: false }); });
  const voiceHistory = (await request('/api/chat/history')).length;
  const capturesBeforeEye = await page.evaluate(() => window.__metrics.capture);
  await page.getByRole('switch', { name: '屏幕感知总开关' }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="屏幕感知总开关"]')?.getAttribute('aria-checked') === 'true');
  await page.getByRole('switch', { name: '屏幕感知总开关' }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="屏幕感知总开关"]')?.getAttribute('aria-checked') === 'false');
  assert.equal(await page.evaluate(() => window.__metrics.capture), capturesBeforeEye);
  assert.equal((await request('/api/chat/history')).length, voiceHistory);
  await page.getByLabel('聊天输入').fill('保留草稿'); await button('语音输入').click();
  await page.waitForFunction(() => window.__state.voicePhase === 'listening' && window.__state.recording);
  await page.evaluate(() => { window.__voiceOptions.onSpeechRealStart(); window.__voiceOptions.onSpeechEnd(new Float32Array(16000).fill(.1)); });
  assert.equal((await request('/api/chat/history')).length, voiceHistory);
  await button('结束本次录音').click();
  await page.waitForFunction(() => document.querySelector('[aria-label="聊天输入"]')?.value === '保留草稿\n合成语音转写');
  assert.equal((await request('/api/chat/history')).length, voiceHistory);
  assert.equal(await page.evaluate(() => window.__state.draft), '保留草稿\n合成语音转写');
  await screenshot('22-manual-voice-draft');
  await page.getByLabel('聊天输入').fill('');
  const uploadsBeforeNoise = await page.evaluate(() => window.__metrics.asrUploads);
  await button('语音输入').click(); await page.waitForFunction(() => window.__state.voicePhase === 'listening');
  await page.evaluate(() => window.__voiceOptions.onVADMisfire()); await button('结束本次录音').click();
  await page.getByText('没有检测到清晰人声，请重试', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__metrics.asrUploads), uploadsBeforeNoise);
  report.checks.push('chat eye toggles persisted screen permission without sending; manual confirmed speech fills shared draft only on stop; no-voice recording skips ASR');
  await page.evaluate(() => { window.__holdAudio = true; });
  slowModel = true;
  const microphoneBeforeCall = await page.evaluate(() => window.__metrics.microphone);
  await button('开始通话').click(); await button('挂断通话').waitFor();
  await page.waitForFunction(() => window.__state.voicePhase === 'listening' && window.__state.continuous);
  const utterance = async (text) => page.evaluate((text) => { window.__asrText = text; window.__voiceOptions.onSpeechRealStart(); window.__voiceOptions.onSpeechEnd(new Float32Array(16000).fill(.1)); }, text);
  await utterance('通话第一句'); await page.waitForFunction(() => window.__state.busy);
  await utterance('通话第二句');
  await page.waitForFunction(() => window.__state.status === 'speaking');
  assert.equal((await request('/api/chat/history')).some((m) => m.content === '通话第一句'), false);
  assert.equal((await request('/api/chat/history')).some((m) => m.content === '通话第二句'), true);
  assert.equal(await page.evaluate(() => window.__metrics.microphone), microphoneBeforeCall + 1);
  const pauses = await page.evaluate(() => window.__metrics.paused || 0);
  await page.evaluate(() => window.__voiceOptions.onSpeechRealStart());
  await page.waitForFunction((count) => window.__metrics.paused > count, pauses);
  assert.equal(await page.evaluate(() => window.__state.continuous), true);
  await page.evaluate(() => { window.__asrText = '通话第三句'; window.__voiceOptions.onSpeechEnd(new Float32Array(16000).fill(.1)); });
  await page.waitForFunction(() => window.__state.busy);
  await page.getByLabel('聊天输入').fill('文字插话'); assert.equal(await button('发送').isEnabled(), true);
  await page.evaluate(() => { window.__holdAudio = false; }); await button('发送').click();
  await page.waitForFunction(() => !window.__state.busy && window.__state.messages.some((m) => m.content === '文字插话'));
  await page.waitForTimeout(700);
  assert.equal((await request('/api/chat/history')).some((m) => m.content === '通话第三句'), false);
  assert.equal(await page.evaluate(() => window.__state.continuous), true);
  await screenshot('23-call-connected-phone');
  report.checks.push('call automatically sends speech with one persistent listener; speech interrupts generation and playing audio; text can interrupt while busy; canceled reply never enters history');
  slowModel = false;
  await page.evaluate(() => { window.__asrMode = 'pending'; }); await utterance('等待转写');
  await page.waitForFunction(() => typeof window.__resolveAsr === 'function');
  await button('挂断通话').click(); await button('开始通话').waitFor();
  await page.evaluate(() => window.__resolveAsr('挂断后的迟到语音')); await page.waitForTimeout(150);
  assert.equal((await request('/api/chat/history')).some((m) => m.content === '挂断后的迟到语音'), false);
  assert.equal(await page.evaluate(() => window.__state.continuous), false);
  report.checks.push('hangup stops listening and discards late ASR rather than sending a new message');

  await page.evaluate(() => { window.__asrMode = 'record'; });
  await button('角色配置').click(); await tab('声音').click(); await button('语音识别').click();
  await page.getByLabel('录音结束后', { exact: true }).selectOption('auto'); await button('保存').click();
  await page.getByText('服务配置已保存', { exact: true }).waitFor();
  assert.equal((await request('/api/settings')).providers.asr.autoSend, true);
  await screenshot('24-voice-send-preference'); await button('陪伴').click();
  const speakDraft = async (text) => {
    await button('语音输入').click(); await page.waitForFunction(() => window.__state.voicePhase === 'listening' && window.__state.recording);
    await utterance(text); await button('结束本次录音').click();
  };
  await speakDraft('普通录音自动发送');
  await page.waitForFunction(() => !window.__state.busy && window.__state.messages.some((m) => m.content === '普通录音自动发送'));
  const beforePtt = (await request('/api/chat/history')).length;
  const manualPreference = (await request('/api/settings')).providers;
  await request('/api/settings/providers', 'PUT', { ...manualPreference, asr: { ...manualPreference.asr, autoSend: false } });
  await button('刷新数据').click();
  await page.evaluate(() => window.__command('ptt-start'));
  await page.waitForFunction(() => window.__state.voicePhase === 'listening' && window.__state.recording);
  await utterance('快捷键松开发送'); await page.evaluate(() => window.__command('ptt-end'));
  await page.waitForFunction(() => !window.__state.busy && window.__state.messages.some((m) => m.content === '快捷键松开发送'));
  assert.equal((await request('/api/chat/history')).length, beforePtt + 2);
  assert.equal((await request('/api/settings')).providers.asr.autoSend, false);
  await page.evaluate(() => { window.__micMode = 'pending'; window.__command('ptt-start'); });
  await page.waitForFunction(() => typeof window.__resolveMicrophone === 'function' && window.__state.voicePhase === 'loading');
  await page.evaluate(() => { window.__command('ptt-end'); window.__resolveMicrophone(); });
  await page.waitForFunction(() => window.__state.voicePhase === 'idle' && !window.__state.recording);
  await page.evaluate(() => { window.__micMode = 'record'; });
  report.checks.push('role auto-send choice persists and sends only on recording stop; PTT release sends independently of manual preference; release during microphone loading does not get stuck');
  await button('全局设置').click();
  await page.getByLabel('按住说话快捷键', { exact: true }).selectOption('ShiftLeft+ShiftRight');
  await page.waitForFunction(async () => (await (await fetch('/api/desktop')).json()).pushToTalkKey === 'ShiftLeft+ShiftRight');
  if (await page.getByRole('switch', { name: '按住说话，松开发送', exact: true }).getAttribute('aria-checked') === 'true') {
    await page.getByRole('switch', { name: '按住说话，松开发送', exact: true }).click();
    await page.waitForFunction(async () => (await (await fetch('/api/desktop')).json()).pushToTalk === false);
  }
  await page.getByRole('switch', { name: '按住说话，松开发送', exact: true }).click();
  await page.waitForFunction(async () => (await (await fetch('/api/desktop')).json()).pushToTalk === true);
  await page.getByRole('switch', { name: '按住说话，松开发送', exact: true }).evaluate((element) => new Promise((resolve) => { const check = () => element.getAttribute('aria-checked') === 'true' ? resolve() : requestAnimationFrame(check); check(); }));
  await screenshot('25-global-push-to-talk');
  await page.getByRole('switch', { name: '显示聊天气泡', exact: true }).click();
  await page.waitForFunction(async () => (await (await fetch('/api/desktop')).json()).showBubble === false);
  await page.getByRole('switch', { name: '显示聊天气泡', exact: true }).click();
  await page.waitForFunction(async () => (await (await fetch('/api/desktop')).json()).showBubble === true);
  await page.getByRole('button', { name: '权限', exact: true }).click();
  await page.locator('.setting-row').filter({ hasText: '辅助功能' }).getByText('已授权', { exact: true }).waitFor();
  await page.evaluate(() => { window.__trusted = false; });
  await page.getByRole('button', { name: '刷新权限', exact: true }).click();
  await page.getByText('等待辅助功能授权', { exact: true }).waitFor();
  await screenshot('29-accessibility-required');
  await page.evaluate(() => { window.__trusted = true; });
  await page.getByRole('button', { name: '刷新权限', exact: true }).click();
  await page.getByText('已启用', { exact: true }).waitFor();
  assert.equal(await page.title(), '兆次元 · AI 伴侣');
  const mark = page.locator('.brand img');
  assert.equal(await mark.getAttribute('src'), '/brand/logo.png');
  const logoPixels = await mark.evaluate((img) => {
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
    const context = canvas.getContext('2d'); context.drawImage(img, 0, 0, 32, 32);
    const pixels = context.getImageData(0, 0, 32, 32).data;
    return { loaded: img.complete && img.naturalWidth > 0, opaque: pixels.filter((_, i) => i % 4 === 3 && pixels[i] > 128).length, corner: pixels[3] };
  });
  assert.ok(logoPixels.loaded && logoPixels.opaque > 100);
  assert.equal(logoPixels.corner, 0);
  await screenshot('30-zhaociyuan-brand-permissions');
  await page.getByRole('button', { name: '桌面', exact: true }).click();
  report.checks.push('selected transparent logo renders at small size; branded page title; bubble preference persists; permission panel distinguishes accessibility denial and running shortcut');
  await page.getByRole('switch', { name: '按住说话，松开发送', exact: true }).click();
  await button('陪伴').click();
  report.checks.push('global PTT enable and key preset persist in isolated fixture only; native keyboard hook was not started');

  const providerBeforeStream = (await request('/api/settings')).providers;
  await request('/api/settings/providers', 'PUT', { ...providerBeforeStream, llm: { ...providerBeforeStream.llm, streaming: true }, tts: { ...providerBeforeStream.tts, provider: 'minimax', baseUrl: modelUrl, apiKey: 'isolated-fixture', model: 'speech-fixture', voice: 'fixture', autoplay: true, streaming: true } });
  streamingModel = true; streamingTts = true;
  await page.evaluate(() => {
    window.__audioEnded = 0; window.__streamTexts = []; window.__streamAudio = []; window.__audioEvents = [];
    const originalApi = window.desktop.api;
    window.desktop.api = async (route, ...args) => {
      const result = await originalApi(route, ...args);
      if (route === '/api/bootstrap') window.__streamBootstrap = result;
      return result;
    };
    window.Audio = function (...args) {
      const audio = new window.__RealAudio(...args), index = window.__streamAudio.length;
      window.__streamAudio.push(audio);
      audio.addEventListener('ended', () => window.__audioEnded++);
      for (const type of ['play', 'pause', 'ended', 'error', 'waiting']) audio.addEventListener(type, () => window.__audioEvents.push({ index, type, ended: audio.ended, time: audio.currentTime }));
      return audio;
    };
    window.AudioContext = window.__RealAudioContext;
    const publish = window.desktop.notifyState;
    window.desktop.notifyState = (state) => {
      publish(state);
      const partial = state.messages.find((message) => message.id < 0 && message.role === 'assistant')?.content;
      if (partial && window.__streamTexts.at(-1) !== partial) window.__streamTexts.push(partial);
    };
    window.__lipLevels = []; window.desktop.lipSync = (level) => window.__lipLevels.push(level);
    const controllers = new Map();
    window.desktop.cancelStream = async (id) => controllers.get(id)?.abort();
    window.desktop.stream = async (id, route, body, callback) => {
      const controller = new AbortController(); controllers.set(id, controller);
      try {
        const response = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
        if (!response.ok) throw Error(await response.text());
        const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
        while (true) {
          const { value, done } = await reader.read(); buffer += decoder.decode(value, { stream: !done });
          let end; while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (line) callback(JSON.parse(line)); }
          if (done) break;
        }
      } finally { controllers.delete(id); }
    };
  });
  await button('刷新数据').click();
  await page.waitForFunction(() => window.__streamBootstrap?.settings.providers.tts.autoplay &&
    window.__streamBootstrap.settings.providers.tts.streaming && window.__streamBootstrap.settings.providers.tts.provider === 'minimax' &&
    window.__state.persona === window.__streamBootstrap.settings.persona);
  await page.getByLabel('聊天输入').fill('真实流式夹具'); await button('发送').click();
  await page.getByText('先说一句。', { exact: true }).waitFor();
  assert.equal(streamFinished, false);
  assert.ok(await page.evaluate(() => window.__streamTexts.length >= 4 && window.__streamTexts.every((text) => !/[`{]/.test(text))));
  await page.waitForFunction(() => window.__lipLevels.some((level) => level > .01));
  assert.equal(streamFinished, false);
  await screenshot('26-stream-first-sentence');
  await page.waitForFunction(() => !window.__state.busy && window.__state.messages.some((m) => m.content === '先说一句。再说一句。最后没有标点'));
  await page.waitForFunction(() => window.__state.status === 'idle' && window.__audioEnded === 3);
  assert.ok(calls.some((call) => call.path === '/v1/t2a_v2' && call.body.stream === true && call.body.text === '先说一句。'));
  assert.deepEqual(calls.filter((call) => call.path === '/v1/t2a_v2' && call.body.stream === true).slice(-3).map((call) => call.body.text), ['先说一句。', '再说一句。', '最后没有标点']);
  await screenshot('27-stream-finished');
  report.checks.push('character SSE inside split JSON fences updates text at least four times before completion; invalid metadata never leaks schema; all three MiniMax MP3 sentences actually end, including final unpunctuated suffix; first audio and measured lip amplitude precede model completion');
  transientModel = 1; transientTts = 1;
  const beforeRetryEnded = await page.evaluate(() => window.__audioEnded);
  const beforeRetryHistory = (await request('/api/chat/history')).length;
  await page.getByLabel('聊天输入').fill('临时连接故障自动重试'); await button('发送').click();
  await page.waitForFunction((count) => window.__audioEnded === count + 3 && !window.__state.busy && window.__state.status === 'idle', beforeRetryEnded);
  assert.equal((await request('/api/chat/history')).length, beforeRetryHistory + 2);
  const retryEvents = await request('/api/events');
  assert.ok(retryEvents.some((e) => e.result === 'retry' && e.service === '对话模型'));
  assert.ok(retryEvents.some((e) => e.result === 'retry' && e.service === 'TTS'));
  await button('运行记录').click();
  assert.ok(await page.getByText('重试', { exact: true }).count() >= 2);
  await page.locator('.log-row').filter({ hasText: '自动重试' }).first().click();
  assert.ok((await page.locator('.log-detail').innerText()).includes('自动重试'));
  await screenshot('34-runtime-retry-details'); await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click(); await button('陪伴').click();
  report.checks.push('transient model and TTS HTTP503 recover once before output with exactly one saved reply and three completed sentences; retry details are visible in runtime records');
  startupFailures = 2;
  const beforeStartupHistory = (await request('/api/chat/history')).length;
  const beforeStartupAudio = await page.evaluate(() => window.__audioEnded);
  await page.getByLabel('聊天输入').fill('模型启动暂时失败后恢复'); await button('发送').click();
  await page.waitForFunction((count) => window.__audioEnded === count + 3 && !window.__state.busy && window.__state.status === 'idle', beforeStartupAudio);
  assert.equal((await request('/api/chat/history')).length, beforeStartupHistory + 2);
  assert.ok((await request('/api/events')).filter((e) => e.result === 'retry' && e.detail.includes('model_loading')).length >= 2);
  report.checks.push('upstream HTTP400 model_loading retries twice before first text and recovers with one saved turn and three completed audio sentences');
  await page.evaluate(() => {
    window.__runtimeApi = window.desktop.api;
    window.desktop.api = async (route, ...args) => {
      if (route === '/api/runtime/issues') throw Error('isolated offline report fixture');
      return window.__runtimeApi(route, ...args);
    };
  });
  startupFailures = 10;
  const beforeFailedStartupHistory = (await request('/api/chat/history')).length;
  await page.getByLabel('聊天输入').fill('持续启动失败应记录'); await button('发送').click();
  await page.waitForFunction(() => !window.__state.busy && JSON.parse(localStorage.getItem('zhaociyuan-runtime-issues-v1') || '[]').some((item) => item.code === 'client-stream'));
  startupFailures = 0;
  assert.equal((await request('/api/chat/history')).length, beforeFailedStartupHistory);
  await page.evaluate(() => { window.desktop.api = window.__runtimeApi; });
  await button('运行记录').click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('zhaociyuan-runtime-issues-v1') || '[]').length === 0);
  await page.locator('.log-row').filter({ hasText: 'model_loading' }).filter({ hasText: '失败' }).first().click();
  const startupDetail = await page.locator('.log-detail').innerText();
  assert.ok(startupDetail.includes('对话生成') && startupDetail.includes('HTTP 400') && startupDetail.includes('模型='));
  assert.ok(!startupDetail.includes('fixture-private-message'));
  await screenshot('36-model-startup-failure-details');
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  assert.ok((await request('/api/events')).some((e) => e.service === '对话连接' && e.detail.includes('服务返回失败')));
  await button('陪伴').click();
  report.checks.push('exhausted model-startup retries show a detailed failure record without private provider text; client diagnostics survive report outage and flush back into runtime records on recovery');
  const endedBeforeFailure = await page.evaluate(() => window.__audioEnded);
  brokenSentence = '再说一句。';
  await page.getByLabel('聊天输入').fill('句中语音失败'); await button('发送').click();
  await page.waitForFunction((count) => window.__audioEnded === count + 2 && !window.__state.busy && window.__state.status === 'idle', endedBeforeFailure);
  assert.ok(await page.getByRole('status').innerText().then((text) => text.includes('MiniMax')));
  brokenSentence = '';
  const failureRecords = await request('/api/events');
  assert.ok(failureRecords.some((e) => e.service === 'TTS' && e.result === 'error' && e.detail.includes('1000')));
  await button('运行记录').click();
  await page.locator('.log-row').filter({ hasText: '1000' }).first().click();
  await screenshot('35-runtime-error-details'); await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click(); await button('陪伴').click();
  report.checks.push('second sentence upstream TTS error is visible while third sentence still plays and completes; sentence failure does not cancel the remaining reply');
  await page.getByLabel('聊天输入').fill('取消流式回复'); await button('发送').click();
  await page.waitForFunction(() => window.__state.busy && window.__state.messages.some((m) => m.id < 0 && m.role === 'assistant'));
  await button('停止生成或播放').click();
  await page.waitForFunction(() => !window.__state.busy && window.__state.status === 'idle');
  await page.waitForTimeout(1100);
  assert.equal((await request('/api/chat/history')).some((m) => m.content === '取消流式回复'), false);
  assert.equal(await page.evaluate(() => window.__state.messages.some((m) => m.id < 0)), false);
  assert.equal(await page.evaluate(() => window.__lipLevels.at(-1)), 0);
  report.checks.push('cancel during partial streamed response aborts model and TTS, removes provisional messages, resets measured mouth to zero and does not persist canceled history');
  const readableBubble = { ...bubbleState, message: JSON.stringify({ text: '# 提醒\n\n**先保存**，再按 `Esc`。\n\n```js\nconst x = 1;\n```', emotion: 'calm' }), busy: true };
  const bubblePreview = await browser.newPage({ locale: 'zh-CN', viewport: { width: 390, height: 640 } });
  bubblePreview.on('pageerror', (error) => report.errors.push(error.message));
  await bubblePreview.route('**/assets/characters/transparent-bounds.png', (route) => route.fulfill({ contentType: 'image/png', body: Buffer.from(paddedPng, 'base64') }));
  await bubblePreview.addInitScript(() => {
    const listeners = new Set();
    window.__push = (state) => { window.__state = state; listeners.forEach((callback) => callback(state)); };
    window.desktop = { onState: (callback) => { listeners.add(callback); return () => listeners.delete(callback); },
      api: async (route) => (await fetch(route)).json(), overlay: async () => window.__state.desktopPreferences, command() {} };
  });
  await bubblePreview.goto(url + '/?window=companion');
  await bubblePreview.waitForFunction(() => typeof window.__push === 'function');
  await bubblePreview.evaluate((state) => window.__push(state), readableBubble);
  await bubblePreview.waitForFunction(() => document.querySelector('.speech-bubble p')?.textContent?.includes('先保存'));
  await bubblePreview.waitForFunction(() => document.querySelector('.portrait')?.naturalWidth > 0);
  const bubbleText = await bubblePreview.locator('.speech-bubble p').innerText();
  assert.doesNotMatch(bubbleText, /\{"text"|```|\*\*|\\n/);
  assert.ok(bubbleText.includes('const x = 1;'));
  await bubblePreview.screenshot({ path: path.join(qa, '28-readable-bubble.png'), animations: 'disabled' });
  await bubblePreview.close();
  report.checks.push('bubble unwraps legacy JSON and removes Markdown markers while preserving readable code content; generation keeps the bubble visible');

  const runtime = await browser.newPage();
  const runtimeRequests = [];
  runtime.on('request', (request) => runtimeRequests.push(request.url()));
  runtime.on('pageerror', (error) => report.errors.push(error.message));
  await runtime.goto(url + '/?window=companion');
  const vadChunk = (await fs.readdir(path.join(root, 'apps/desktop/renderer/dist/assets'))).find((name) => name.startsWith('voice-vad-') && name.endsWith('.js'));
  const realVad = await runtime.evaluate(async (chunk) => {
    const module = await import('/assets/' + chunk);
    let active = true, speeches = 0;
    const source = new AudioContext(); const destination = source.createMediaStreamDestination();
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => destination.stream });
    const options = { silenceSeconds: .5, isActive: () => active, onSpeechRealStart: () => speeches++, onSpeechEnd: () => speeches++, onVADMisfire() {}, onError: (error) => { throw error; } };
    const unstarted = await module.createVoiceDetector(options); await unstarted.destroy();
    const detector = await module.createVoiceDetector(options); await detector.start();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    active = false; await detector.destroy();
    const released = destination.stream.getTracks().every((track) => track.readyState === 'ended');
    await source.close(); return { speeches, released };
  }, vadChunk);
  assert.deepEqual(realVad, { speeches: 0, released: true });
  assert.ok(runtimeRequests.some((route) => route.endsWith('/voice-assets/silero_vad_v5.onnx')));
  assert.ok(runtimeRequests.some((route) => route.endsWith('/voice-assets/ort-wasm-simd-threaded.wasm')));
  assert.equal(runtimeRequests.some((route) => !route.startsWith(url)), false);
  await runtime.close();
  report.realVad = realVad;
  report.checks.push('real local Silero ONNX/WASM starts against synthetic silent stream, emits no speech, releases tracks and handles destroy-before-start; no CDN or hardware microphone accessed');
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.apiErrors, []);
  report.passed = true;
} catch (error) {
  report.passed = false; report.failure = error.stack;
  if (page) {
    report.audioDiagnostics = await page.evaluate(() => ({ ended: window.__audioEnded, status: window.__state?.status,
      events: window.__audioEvents, audio: window.__streamAudio?.map((item) => ({ paused: item.paused, ended: item.ended, time: item.currentTime,
        duration: item.duration, readyState: item.readyState, networkState: item.networkState, error: item.error?.code,
        buffered: Array.from({ length: item.buffered.length }, (_, index) => [item.buffered.start(index), item.buffered.end(index)]) })) })).catch(() => null);
    report.runtimeEvents = await request('/api/events').catch(() => []);
    report.streamRequests = calls.filter((item) => item.body.stream).map((item) => ({ path: item.path, text: item.body.text }));
    report.lastPage = await page.locator('body').innerText().catch(() => 'unavailable');
    report.inputs = await page.locator('input').evaluateAll((inputs) => inputs.filter((input) => input.type !== 'password').map((input) => ({ label: input.getAttribute('aria-label'), value: input.value }))).catch(() => []);
    await page.screenshot({ path: path.join(qa, 'failure.png') }).catch(() => {});
  }
  throw error;
} finally {
  await browser?.close();
  if (server.exitCode === null) { const exited = once(server, 'exit'); server.kill('SIGTERM'); await exited; }
  await new Promise((resolve) => fixture.close(resolve));
  await fs.writeFile(path.join(qa, 'result.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(qa, 'server.log'), output);
  console.log(JSON.stringify({ ...report, evidence: qa }, null, 2));
}
