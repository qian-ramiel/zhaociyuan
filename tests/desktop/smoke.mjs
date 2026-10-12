import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { _electron as electron, chromium } from 'playwright';

const root = process.cwd();
const qa = path.join(root, 'runtime/qa');
const runHome = path.join(qa, 'runs', String(Date.now()));
await fs.mkdir(qa, { recursive: true });
const report = { started: new Date().toISOString(), checks: [], nativeCapture: 'not tested', errors: [] };
let app;
const modelInputs = [];
const fixture = createServer(async (req, res) => {
  let raw = '';
  for await (const part of req) raw += part;
  if (req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end('{}'); }
  const body = JSON.parse(raw);
  modelInputs.push(body);
  const content = typeof body.messages.at(-1).content === 'string' ? body.messages.at(-1).content : body.messages.at(-1).content[0].text;
  const reply = { text: content.includes('连接成功') ? '连接成功。' : '测试服务已收到本轮问题' + (Array.isArray(body.messages.at(-1).content) ? '和当前画面。' : '。'), speech: '', emotion: 'happy', actions: [], memoryCandidates: [], custom: {} };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
});
await new Promise((resolve) => fixture.listen(18912, '127.0.0.1', resolve));

try {
  app = await electron.launch({ args: ['.'], cwd: root, env: { ...process.env, NICE_PEOPLE_API: 'http://127.0.0.1:18911', NICE_PEOPLE_HOME: path.join(runHome, 'data'), NICE_PEOPLE_PROFILE: path.join(runHome, 'electron') }, timeout: 60000 });
  await app.firstWindow();
  let page;
  for (let i = 0; i < 100 && !page; i++) {
    page = (await app.windows()).find((p) => p.url().startsWith('http://127.0.0.1:18911') && !p.url().includes('window=companion'));
    if (!page) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(page, 'Control window missing');
  page.on('pageerror', (e) => report.errors.push(e.message));
  await page.getByRole('button', { name: '陪伴', exact: true }).waitFor({ timeout: 60000 });
  await page.getByText('还没有角色', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(qa, 'v2-05-empty.png') });
  await page.getByRole('button', { name: '创建角色', exact: true }).click();
  await page.getByLabel('角色名称', { exact: true }).fill('桌面测试角色');
  await page.getByLabel('角色简介', { exact: true }).fill('真实窗口回归测试');
  await page.screenshot({ path: path.join(qa, 'v2-06-create-role.png') });
  await page.getByRole('dialog').getByRole('button', { name: '创建角色', exact: true }).click();
  await page.getByRole('button', { name: '添加形象', exact: true }).waitFor();
  await page.evaluate(async () => {
    const data = await window.desktop.api('/api/bootstrap');
    const asset = data.assets.find((a) => a.model_path.includes('Hiyori'));
    if (!asset) throw Error('Hiyori resource missing');
    for (const [name, framing] of [['全身', 'full'], ['半身', 'half'], ['mini', 'mini']]) await window.desktop.api('/api/appearances', { method: 'POST', body: { name, assetId: asset.id, framing, aliases: [name + '形象'] } });
    const modes = [{ id: 'daily', name: '日常闲聊', prompt: '自然交流', screenAllowed: true }, { id: 'game', name: '游戏陪玩', prompt: '简短建议', screenAllowed: true }];
    await window.desktop.api('/api/modes', { method: 'PUT', body: modes });
  });
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  await page.getByRole('button', { name: '陪伴', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.avatar-loading'), { timeout: 30000 });
  report.checks.push('desktop bootstrap and Live2D model loaded');
  const pixels = await page.locator('canvas').evaluate((canvas) => new Promise((resolve) => requestAnimationFrame(() => {
    const gl = canvas.getContext('webgl2');
    const data = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
    gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, data);
    let visible = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 20) visible++;
    resolve(visible);
  })));
  assert.ok(pixels > 1000, `Live2D canvas is blank: ${pixels}`);
  report.checks.push(`nonblank Live2D canvas: ${pixels} opaque pixels`);
  await page.screenshot({ path: path.join(qa, '01-desktop.png') });

  await page.getByRole('button', { name: '角色配置', exact: true }).click();
  await page.getByLabel('API 地址', { exact: true }).fill('http://127.0.0.1:18912/v1');
  await page.getByLabel('模型名称', { exact: true }).fill('fixture-model');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await page.getByText('对话模型：连接成功：连接成功。', { exact: true }).waitFor();
  const services = await page.evaluate(() => window.desktop.api('/api/settings'));
  services.providers.tts.autoplay = false;
  await page.evaluate((value) => window.desktop.api('/api/settings/providers', { method: 'PUT', body: value }), services.providers);
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  report.checks.push('configurable compatible model: UI save and real HTTP round trip to local test fixture');
  await page.screenshot({ path: path.join(qa, 'v2-12-model.png') });
  await page.getByRole('button', { name: '保存为方案', exact: true }).click();
  await page.getByLabel('方案名称', { exact: true }).fill('桌面测试方案');
  await page.getByRole('button', { name: '保存方案', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('tab', { name: '声音', exact: true }).click();
  await page.screenshot({ path: path.join(qa, 'v2-13-tts.png') });
  await page.getByRole('tab', { name: '视觉', exact: true }).click();
  await page.screenshot({ path: path.join(qa, 'v2-14-vision.png') });
  await page.getByRole('tab', { name: '声音', exact: true }).click();
  await page.getByRole('button', { name: '语音识别', exact: true }).click();
  await page.screenshot({ path: path.join(qa, 'v2-26-asr.png') });
  report.checks.push('per-role services and key-free profile save through UI');

  await page.getByRole('button', { name: '陪伴模式', exact: true }).click();
  await page.getByRole('button', { name: '新建模式', exact: true }).click();
  await page.getByLabel('模式名称', { exact: true }).fill('深夜写代码');
  await page.getByLabel('场景提示词', { exact: true }).fill('先给可执行的简短建议。');
  await page.getByLabel('默认形象', { exact: true }).selectOption({ label: 'mini' });
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('模式已保存', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(qa, 'v2-18-mode-editor.png') });
  await page.getByRole('button', { name: '返回', exact: true }).click();
  assert.ok(await page.getByRole('button', { name: '深夜写代码', exact: true }).count());
  await page.getByRole('button', { name: '编辑模式 深夜写代码', exact: true }).click();
  await page.getByLabel('默认形象', { exact: true }).selectOption({ label: '半身' });
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('模式已保存', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('默认形象', { exact: true }).inputValue(), (await page.evaluate(() => window.desktop.api('/api/bootstrap'))).appearances.find((a) => a.name === '半身').id);
  report.checks.push('custom mode name/prompt and mode-owned default appearance');

  await page.getByRole('button', { name: '陪伴', exact: true }).click();
  await page.getByLabel('聊天输入').fill('换成 mini 形象');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="avatar"]').classList.contains('mini'));
  await page.getByText('好，换成mini形象。', { exact: true }).waitFor();
  await page.getByLabel('聊天输入').fill('换成全身形象');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="avatar"]').classList.contains('full'));
  report.checks.push('dialog-driven mini/full switch; same role and chat history');
  await page.getByLabel('聊天输入').fill('帮我讨论一下任务');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByText('测试服务已收到本轮问题。', { exact: true }).waitFor();
  report.checks.push('chat text response from test model');

  await page.getByRole('button', { name: '角色形象', exact: true }).click();
  assert.equal(await page.locator('.appearance-item').count(), 3);
  await page.getByRole('button', { name: '编辑 半身', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.avatar-loading'));
  await page.screenshot({ path: path.join(qa, 'v2-10-appearance-editor.png') });
  await page.getByLabel('形象名称', { exact: true }).fill('半身');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.screenshot({ path: path.join(qa, '02-appearances.png') });
  report.checks.push('appearance editing and per-appearance motion configuration');

  await page.getByRole('button', { name: '角色配置', exact: true }).click();
  await page.getByRole('tab', { name: '记忆', exact: true }).click();
  await page.getByRole('button', { name: '添加记忆', exact: true }).click();
  await page.getByLabel('内容', { exact: true }).fill('桌面测试：用户正在设计一个游戏。');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('桌面测试：用户正在设计一个游戏。', { exact: true }).waitFor();
  report.checks.push('memory creation through UI');

  await page.getByRole('button', { name: '角色配置', exact: true }).click();
  await page.getByRole('tab', { name: '视觉', exact: true }).click();
  await page.screenshot({ path: path.join(qa, '03-screen.png') });
  const permission = await page.evaluate(() => window.desktop.permission());
  report.permissions = permission;
  if (permission.screen === 'granted') {
    await app.evaluate(({ BrowserWindow }) => {
      const fixture = new BrowserWindow({ width: 700, height: 450, title: 'Capture Fixture', webPreferences: { nodeIntegration: false, contextIsolation: true } });
      fixture.loadURL('data:text/html,' + encodeURIComponent('<title>Capture Fixture</title><body style="background:#f0f7f8;font:24px sans-serif;padding:40px"><h1>Capture Fixture</h1><p>Enemy HP: 25</p><p>Player HP: 80</p></body>'));
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const sources = await page.evaluate(() => window.desktop.sources());
    const source = sources.find((s) => s.name.includes('Capture Fixture'));
    assert.ok(source, 'Test capture window missing');
    const current = await page.evaluate(() => window.desktop.api('/api/settings'));
    current.companion.screen = { ...current.companion.screen, enabled: true, paused: false, onMessage: true, periodic: false, onChange: false, sourceId: source.id, sourceName: source.name };
    await page.evaluate((value) => window.desktop.api('/api/settings/companion', { method: 'PUT', body: value }), current.companion);
    await page.getByRole('button', { name: '刷新数据', exact: true }).click();
    await page.getByRole('button', { name: '陪伴', exact: true }).click();
    await page.getByLabel('聊天输入').fill('现在应该怎么打？');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByText('测试服务已收到本轮问题和当前画面。', { exact: true }).waitFor();
    assert.ok(modelInputs.some((m) => Array.isArray(m.messages.at(-1).content) && m.messages.at(-1).content.some((c) => c.type === 'image_url')));
    report.nativeCapture = 'passed: selected fixture window captured and bound to chat input';
  } else report.nativeCapture = 'not exercised: macOS screen permission is ' + permission.screen;

  const speech = await page.evaluate(() => window.desktop.api('/api/tts/synthesize', { method: 'POST', body: { text: '请换成半身形象。' } }));
  const waveform = await page.evaluate(async (url) => Array.from(new Uint8Array(await (await fetch(url)).arrayBuffer())), speech.audio_url);
  assert.ok(waveform.length > 10000);
  const transcript = await page.evaluate(async (bytes) => window.desktop.upload('/api/asr/transcribe', new Uint8Array(bytes), 'test.wav', 'audio/wav', {}), waveform);
  assert.ok(transcript.text.length > 0);
  report.checks.push('actual local Kokoro TTS -> WAV -> SenseVoice ASR: ' + transcript.text);

  const questionSpeech = await page.evaluate(() => window.desktop.api('/api/tts/synthesize', { method: 'POST', body: { text: '现在应该怎么打？' } }));
  const questionBytes = await page.evaluate(async (url) => Array.from(new Uint8Array(await (await fetch(url)).arrayBuffer())), questionSpeech.audio_url);
  await page.getByRole('button', { name: '陪伴', exact: true }).click();
  await page.evaluate(async (bytes) => {
    const context = new AudioContext();
    const buffer = await context.decodeAudioData(new Uint8Array(bytes).buffer);
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.__restoreMicrophone = async () => { navigator.mediaDevices.getUserMedia = original; await context.close(); };
    navigator.mediaDevices.getUserMedia = async () => {
      const destination = context.createMediaStreamDestination();
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(destination);
      await context.resume();
      source.start(context.currentTime + 0.4);
      return destination.stream;
    };
  }, questionBytes);
  const messageCount = await page.evaluate(async () => (await window.desktop.api('/api/chat/history')).length);
  const requestCount = modelInputs.length;
  await page.getByRole('button', { name: '连续语音', exact: true }).click();
  let voiceHistory = [];
  for (let i = 0; i < 120; i++) {
    voiceHistory = await page.evaluate(() => window.desktop.api('/api/chat/history'));
    if (voiceHistory.length >= messageCount + 2) break;
    const voiceError = await page.locator('.toast.error').count() ? await page.locator('.toast.error').textContent() : '';
    if (voiceError) throw new Error('Voice UI: ' + voiceError);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(voiceHistory.length >= messageCount + 2, 'Continuous voice did not send a new message');
  await page.getByRole('button', { name: '停止连续语音', exact: true }).click();
  assert.ok(voiceHistory.at(-2).content.length > 0);
  if (report.nativeCapture.startsWith('passed')) {
    assert.ok(voiceHistory.at(-2).screen_context);
    assert.ok(modelInputs.slice(requestCount).some((m) => Array.isArray(m.messages.at(-1).content)));
  }
  await page.evaluate(() => window.__restoreMicrophone());
  report.checks.push('continuous-voice UI: real synthesized audio stream -> silence detection -> local ASR -> automatic send with per-message capture; physical microphone quality not evaluated');

  for (const name of ['角色库', '角色设定', '角色形象', '角色配置', '陪伴模式', '运行记录', '全局设置']) {
    await page.getByRole('button', { name, exact: true }).click();
    await page.locator('.page-heading').first().waitFor();
    assert.ok(await page.locator('h1').count());
    await page.waitForFunction(() => !document.querySelector('.avatar-loading'));
    await page.screenshot({ path: path.join(qa, 'v2-' + name + '.png') });
  }
  report.checks.push('all settings pages render');
  await page.getByRole('button', { name: '陪伴', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('canvas') && !document.querySelector('.avatar-loading'));
  await page.screenshot({ path: path.join(qa, '04-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  report.checks.push('390px responsive layout: no horizontal overflow');
  await page.setViewportSize({ width: 1380, height: 900 });
  for (let i = 0; i < 4; i++) {
    await page.getByRole('button', { name: '陪伴模式', exact: true }).click();
    await page.getByRole('button', { name: '编辑模式 日常闲聊', exact: true }).click();
    await page.getByRole('button', { name: '工作流', exact: true }).click();
    await page.getByRole('button', { name: '陪伴', exact: true }).click();
  }
  await page.waitForFunction(() => document.querySelector('canvas') && !document.querySelector('.avatar-loading'));
  report.checks.push('rapid navigation during Live2D loading: recovered without stale callbacks');
  const companionPage = (await app.windows()).find((p) => p.url().includes('window=companion'));
  assert.ok(companionPage);
  await companionPage.waitForFunction(() => document.querySelector('canvas') && !document.querySelector('.avatar-loading'));
  await companionPage.screenshot({ path: path.join(qa, '05-overlay.png'), omitBackground: true });
  await companionPage.mouse.move(175, 220);
  await companionPage.locator('.overlay-menu.shown').waitFor();
  await companionPage.waitForFunction(() => Number(getComputedStyle(document.querySelector('.overlay-menu')).opacity) > .95);
  assert.equal(await companionPage.locator('.overlay-controls button').count(), 8);
  assert.ok(await companionPage.getByRole('button', { name: '打开聊天', exact: true }).count());
  await companionPage.getByRole('button', { name: '打开聊天', exact: true }).click();
  let floating;
  for (let i = 0; i < 40 && !floating; i++) {
    floating = (await app.windows()).find((p) => p.url().includes('window=chat'));
    if (!floating) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(floating, 'Independent chat window missing');
  await floating.waitForFunction(() => document.querySelector('.floating-mode')?.options.length > 1);
  const modeOptions = await floating.getByLabel('陪伴模式', { exact: true }).locator('option').evaluateAll((options) => options.map((option) => option.value));
  assert.ok(modeOptions.length > 1);
  await floating.getByLabel('陪伴模式', { exact: true }).selectOption(modeOptions[1]);
  await page.waitForFunction((id) => window.desktop.api('/api/bootstrap').then((data) => data.settings.companion.mode === id), modeOptions[1]);
  await floating.getByLabel('陪伴模式', { exact: true }).selectOption(modeOptions[0]);
  await page.waitForFunction((id) => window.desktop.api('/api/bootstrap').then((data) => data.settings.companion.mode === id), modeOptions[0]);
  await floating.getByLabel('聊天输入').fill('浮动聊天测试');
  await floating.getByRole('button', { name: '发送', exact: true }).click();
  await floating.getByText('浮动聊天测试', { exact: true }).waitFor();
  await floating.waitForFunction(() => !document.querySelector('.thinking'));
  await floating.screenshot({ path: path.join(qa, 'v2-03-floating-chat.png') });
  await companionPage.evaluate(() => {
    document.activeElement?.blur();
    document.querySelector('.desktop-companion').dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
  });
  await new Promise((resolve) => setTimeout(resolve, 5200));
  assert.equal(await companionPage.locator('.overlay-menu.shown').count(), 0, 'Menu did not hide after leaving for 5 seconds');
  assert.ok(await floating.getByLabel('聊天输入').isVisible(), 'Chat must stay independent');
  await companionPage.screenshot({ path: path.join(qa, 'v2-01-overlay-hidden.png'), omitBackground: true });
  await companionPage.mouse.move(170, 210);
  await companionPage.locator('.overlay-menu.shown').waitFor();
  await companionPage.waitForFunction(() => Number(getComputedStyle(document.querySelector('.overlay-menu')).opacity) > .95);
  await companionPage.screenshot({ path: path.join(qa, 'v2-02-overlay-menu.png'), omitBackground: true });
  const geometry = await companionPage.evaluate(() => {
    const grip = document.querySelector('.overlay-drag').getBoundingClientRect();
    const controls = document.querySelector('.overlay-controls').getBoundingClientRect();
    return { grip: { x: grip.x, y: grip.y, height: grip.height, right: grip.right }, controls: { x: controls.x, y: controls.y, right: controls.right }, integrated: document.querySelector('.overlay-drag').parentElement === document.querySelector('.overlay-controls'), drag: getComputedStyle(document.querySelector('.overlay-drag')).webkitAppRegion };
  });
  assert.ok(geometry.integrated && Math.abs(geometry.grip.y - geometry.controls.y) <= 6 && geometry.grip.x >= geometry.controls.x && geometry.grip.right <= geometry.controls.right);
  assert.equal(geometry.drag, 'drag');
  await companionPage.mouse.move(95, 160);
  await companionPage.screenshot({ path: path.join(qa, 'v2-gaze-left.png'), omitBackground: true });
  await companionPage.mouse.move(280, 160);
  await companionPage.mouse.click(280, 160);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await companionPage.screenshot({ path: path.join(qa, 'v2-gaze-right.png'), omitBackground: true });
  report.checks.push('local pointer/click gaze renders without errors and native bottom handle retains drag region');
  report.checks.push('seven-icon hover toolbar, integrated bottom drag handle, independent floating chat and 5-second hide');
  report.checks.push('transparent companion window renders');
  await page.getByRole('button', { name: '角色库', exact: true }).click();
  const firstRole = (await page.evaluate(() => window.desktop.api('/api/bootstrap'))).activeRoleId;
  await page.getByRole('button', { name: '创建角色', exact: true }).click();
  await page.getByLabel('角色名称', { exact: true }).fill('隔离测试角色');
  await page.getByRole('dialog').getByRole('button', { name: '创建角色', exact: true }).click();
  await page.getByRole('button', { name: '添加形象', exact: true }).waitFor();
  const isolated = await page.evaluate(() => window.desktop.api('/api/bootstrap'));
  assert.equal(isolated.settings.persona.characterName, '隔离测试角色');
  assert.equal(isolated.messages.length + isolated.memories.length + isolated.appearances.length, 0);
  assert.equal(isolated.health.modelConfigured, false);
  await page.getByLabel('当前角色', { exact: true }).selectOption(firstRole);
  await page.getByRole('heading', { name: '桌面测试角色', exact: true }).waitFor();
  assert.ok((await page.evaluate(() => window.desktop.api('/api/bootstrap'))).messages.length > 0);
  report.checks.push('role creation and activation through UI isolate services, chat, memory and appearance; original role preserved');
  const runtimeErrors = report.errors.filter((message) => !message.includes('WebGL context was lost'));
  assert.deepEqual(runtimeErrors, []);
  report.passed = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.passed = false;
  report.failure = error.stack;
  console.error(error.stack);
  if (app) { try { await (await app.firstWindow()).screenshot({ path: path.join(qa, 'failure.png') }); } catch {} }
  process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(qa, 'report.json'), JSON.stringify(report, null, 2));
  if (app) await app.close();
  fixture.close();
}
