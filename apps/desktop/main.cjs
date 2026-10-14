const { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, screen, session, shell, systemPreferences, Tray } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { safeSource, cropBounds, overlaySize } = require('./state.cjs');
const { trayTemplate } = require('./tray.cjs');
const { apiError, requestHeaders } = require('./errors.mjs');
const { readEvents } = require('./stream.cjs');
const { createPushToTalk } = require('./push-to-talk.cjs');
const { validRegions, ignoresPointer } = require('./pointer-regions.cjs');
const { freePort, serviceOptions, launchService } = require('./service.cjs');
const { initialLanguage, languages, translate } = require('./locale.mjs');

const ROOT = path.resolve(__dirname, '../..');
const DEV_URL = process.env.NICE_PEOPLE_URL;
let API_URL = process.env.NICE_PEOPLE_API || 'http://127.0.0.1:8791';
const TOKEN = process.env.NICE_PEOPLE_TOKEN || crypto.randomBytes(32).toString('hex');
let UI_URL = DEV_URL || API_URL;
let consoleWindow, companionWindow, chatWindow, apiProcess, tray, lastState;
let quitting = false;
const overlayPreferences = { visible: true, clickThrough: false, alwaysOnTop: true, menu: 'hover', showGrip: true, gazeEnabled: true, visionEnabled: true, hearingEnabled: true, speechEnabled: true, characterScale: 1, bubbleWidth: 90, bubbleHeight: 72, bubbleFontSize: 13, bubbleAutoHide: 8, showBubble: true, pushToTalk: true, pushToTalkKey: 'ShiftLeft+ShiftRight' };
let bubbleHeightPreview = null;
let preferenceQueue = Promise.resolve();
let traySignature = '';
const streams = new Map();
let pushToTalk, shortcutSignature = '';
let pointerRegions = [], pointerCapturing = false, pointerIgnored, pointerTimer;
const t = (source) => translate(source, overlayPreferences.language || 'en');

function updatePointerPassthrough() {
  if (!companionWindow || companionWindow.isDestroyed()) return;
  const ignore = ignoresPointer(screen.getCursorScreenPoint(), companionWindow.getBounds(), pointerRegions, overlayPreferences.clickThrough, pointerCapturing);
  if (ignore !== pointerIgnored) {
    companionWindow.setIgnoreMouseEvents(ignore, { forward: true });
    pointerIgnored = ignore;
  }
}

function accessibilityGranted() {
  return process.platform !== 'darwin' || systemPreferences.isTrustedAccessibilityClient(false);
}

function configureVoiceShortcut() {
  const trusted = accessibilityGranted();
  const signature = JSON.stringify([overlayPreferences.pushToTalk, overlayPreferences.pushToTalkKey, overlayPreferences.hearingEnabled, trusted]);
  if (signature === shortcutSignature) return;
  pushToTalk?.stop(); pushToTalk = null;
  globalShortcut.unregister?.('CommandOrControl+Shift+Space');
  shortcutSignature = signature;
  if (!overlayPreferences.pushToTalk) {
    return;
  }
  if (!overlayPreferences.hearingEnabled) return;
  if (!trusted) return;
  try {
    const { uIOhook, UiohookKey } = require('uiohook-napi');
    const controller = createPushToTalk(uIOhook, UiohookKey, process.platform, sendCommand);
    controller.start(overlayPreferences.pushToTalkKey || 'ShiftLeft+ShiftRight');
    pushToTalk = controller;
  } catch {
    shortcutSignature = '';
    sendCommand({ type: 'error', value: t("按住说话无法启动，请检查辅助功能或输入监控权限与快捷键冲突") });
  }
}

// Keep existing profiles when the visible product name changes.
if (app.isPackaged) {
  app.setPath('userData', process.env.NICE_PEOPLE_PROFILE || path.join(app.getPath('appData'), 'Nice People'));
} else {
  const profile = process.env.NICE_PEOPLE_PROFILE || path.join(ROOT, 'runtime/v1/electron');
  fs.mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
}
app.setName('兆次元');
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showConsole());

function validateSender(event) {
  const sender = event.senderFrame?.url || '';
  if (!sender.startsWith(UI_URL + '/') && sender !== UI_URL) throw new Error(t("无效窗口请求"));
}

async function callApi(route, options = {}) {
  if (typeof route !== 'string' || !route.startsWith('/api/') || route.includes('..') || route.length > 500) throw new Error(t("无效 API 地址"));
  const method = options.method || 'GET';
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error(t("无效请求方法"));
  const response = await fetch(API_URL + route, {
    method,
    headers: { ...requestHeaders(options.body), Authorization: 'Bearer ' + TOKEN },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(route.includes('images') ? 200000 : 120000),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(apiError(value.detail));
  return value;
}

async function startApi() {
  if (process.env.NICE_PEOPLE_EXTERNAL_API === '1') return;
  if (app.isPackaged && !process.env.NICE_PEOPLE_API) API_URL = 'http://127.0.0.1:' + await freePort();
  UI_URL = DEV_URL || API_URL;
  const config = serviceOptions({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, root: ROOT,
    userData: app.getPath('userData'), env: process.env, token: TOKEN, apiUrl: API_URL });
  const logPath = path.join(app.getPath('userData'), 'startup.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  if (fs.existsSync(logPath) && fs.statSync(logPath).size > 1024 * 1024) fs.renameSync(logPath, logPath + '.previous');
  apiProcess = await launchService(config, { onLaunch: (child) => { apiProcess = child; }, log: (data) => {
    try { fs.appendFileSync(logPath, data); } catch {}
  } });
  if (quitting) { apiProcess.kill(); throw new Error(t("启动已取消")); }
  apiProcess.once('exit', () => {
    if (!quitting) { dialog.showErrorBox(t("兆次元 本地服务已停止"), t("请重新启动软件。排查信息保存在用户数据目录中的 startup.log。")); app.quit(); }
  });
}

function windowOptions(extra = {}) {
  return { show: false, backgroundColor: '#f5f7f8',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
      additionalArguments: ['--zhaociyuan-ui-language=' + (overlayPreferences.language || 'en')] }, ...extra };
}

function secureWindow(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(UI_URL + '/') && url !== UI_URL) event.preventDefault(); });
}

function sendCommand(command) { consoleWindow?.webContents.send('command', command); }

function refreshTray() {
  if (!tray) return;
  const signature = JSON.stringify([lastState?.roles, lastState?.appearances, lastState?.companion?.characterId, lastState?.appearance?.id, overlayPreferences]);
  if (signature === traySignature) return;
  traySignature = signature;
  tray.setContextMenu(Menu.buildFromTemplate(trayTemplate(lastState, overlayPreferences, {
    configure: () => { sendCommand({ type: 'settings', value: '' }); showConsole(); },
    role: (value) => sendCommand({ type: 'role', value }),
    appearance: (value) => sendCommand({ type: 'appearance', value }),
    preference: (key, value) => { void applyOverlayOptions({ [key]: value }).catch((error) => sendCommand({ type: 'error', value: error.message })); },
    quit: () => { quitting = true; app.quit(); },
  })));
}

function showConsole() {
  consoleWindow?.show();
  consoleWindow?.focus();
}

function showChat() {
  if (!chatWindow || chatWindow.isDestroyed()) {
    const bounds = companionWindow.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    chatWindow = new BrowserWindow(windowOptions({ width: 440, height: 620, minWidth: 360, minHeight: 480,
      x: Math.max(area.x, Math.min(bounds.x - 450, area.x + area.width - 440)), y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - 620)),
      title: t("兆次元 · 聊天"), titleBarStyle: 'hiddenInset', alwaysOnTop: true }));
    secureWindow(chatWindow);
    chatWindow.loadURL(UI_URL + '/?window=chat');
    chatWindow.webContents.on('did-finish-load', () => { if (lastState) chatWindow.webContents.send('state', lastState); });
    chatWindow.once('ready-to-show', () => { chatWindow.show(); chatWindow.focus(); });
    chatWindow.on('close', (event) => { if (!quitting) { event.preventDefault(); chatWindow.hide(); } });
  } else { chatWindow.show(); chatWindow.focus(); }
}

function createWindows() {
  const consoleOptions = windowOptions({ width: 1380, height: 920, minWidth: 950, minHeight: 660, title: '兆次元', titleBarStyle: 'hiddenInset' });
  consoleOptions.webPreferences.backgroundThrottling = false;
  consoleWindow = new BrowserWindow(consoleOptions);
  secureWindow(consoleWindow);
  consoleWindow.loadURL(UI_URL);
  consoleWindow.once('ready-to-show', () => consoleWindow.show());
  consoleWindow.on('close', (event) => { if (!quitting) { event.preventDefault(); consoleWindow.hide(); } });

  const work = screen.getPrimaryDisplay().workArea;
  const initialSize = overlaySize('half', overlayPreferences.characterScale, overlayPreferences.bubbleHeight);
  initialSize.width = Math.min(initialSize.width, work.width); initialSize.height = Math.min(initialSize.height, work.height);
  companionWindow = new BrowserWindow(windowOptions({ ...initialSize, x: Math.max(work.x, work.x + work.width - initialSize.width - 30), y: Math.max(work.y, work.y + work.height - initialSize.height - 30),
    transparent: true, backgroundColor: '#00000000', frame: false, resizable: false, hasShadow: false, skipTaskbar: true, alwaysOnTop: true, title: t("兆次元 · 桌面角色") }));
  secureWindow(companionWindow);
  companionWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  companionWindow.loadURL(UI_URL + '/?window=companion');
  companionWindow.once('ready-to-show', () => { if (overlayPreferences.visible) companionWindow.showInactive(); });

  const logoPath = path.join(__dirname, 'renderer', app.isPackaged ? 'dist' : 'public', 'brand/logo.png');
  const logo = nativeImage.createFromPath(logoPath);
  if (!app.isPackaged) app.dock?.setIcon(nativeImage.createFromPath(path.join(__dirname, 'renderer/public/brand/app-icon.png')));
  const icon = logo.resize({ width: 22, height: 22 });
  icon.addRepresentation({ scaleFactor: 2, dataURL: logo.resize({ width: 44, height: 44 }).toDataURL() });
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('兆次元');
  refreshTray();
  tray.on('click', () => tray.popUpContextMenu());
  updatePointerPassthrough();
  pointerTimer = setInterval(updatePointerPassthrough, 32);
  pointerTimer.unref?.();
  companionWindow.webContents.on('did-start-loading', () => { pointerRegions = []; pointerCapturing = false; updatePointerPassthrough(); });
  configureVoiceShortcut();
  globalShortcut.register('CommandOrControl+Shift+O', () => consoleWindow.webContents.send('command', 'observe'));
  globalShortcut.register('CommandOrControl+Shift+H', () => { void applyOverlayOptions({ visible: !overlayPreferences.visible }).catch((error) => sendCommand({ type: 'error', value: error.message })); });
}

ipcMain.handle('api', async (event, route, options) => { validateSender(event); return callApi(route, options); });
ipcMain.handle('stream', async (event, id, route, body) => {
  validateSender(event);
  if (!['/api/chat/stream', '/api/tts/stream'].includes(route) || typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id) || streams.has(id) || streams.size >= 8) throw Error(t("无效流式请求"));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  streams.set(id, { controller, sender: event.sender });
  const destroyed = () => controller.abort(); event.sender.once?.('destroyed', destroyed);
  try {
    const response = await fetch(API_URL + route, { method: 'POST', headers: { ...requestHeaders(body), Authorization: 'Bearer ' + TOKEN }, body: JSON.stringify(body), signal: controller.signal });
    if (!response.ok) throw Error(apiError((await response.json()).detail));
    await readEvents(response, (value) => { if (!controller.signal.aborted && !event.sender.isDestroyed?.()) event.sender.send('stream-event', id, value); });
  } finally { clearTimeout(timeout); streams.delete(id); event.sender.removeListener?.('destroyed', destroyed); }
});
ipcMain.handle('stream-cancel', (event, id) => { validateSender(event); const stream = streams.get(id); if (stream?.sender === event.sender) stream.controller.abort(); });
ipcMain.on('lip-sync', (event, value) => {
  if (event.sender !== consoleWindow?.webContents || !Number.isFinite(value)) return;
  companionWindow?.webContents.send('lip-sync', Math.max(0, Math.min(1, value)));
});
ipcMain.handle('upload', async (event, route, bytes, name, type, fields = {}) => {
  validateSender(event);
  if (!['/api/characters/import', '/api/roles/import', '/api/knowledge/import', '/api/asr/transcribe'].includes(route) || !ArrayBuffer.isView(bytes) || bytes.byteLength > 512 * 1024 * 1024) throw new Error(t("无效上传"));
  const body = new FormData();
  body.append('file', new Blob([bytes], { type: String(type) }), String(name));
  for (const [key, value] of Object.entries(fields)) if (key === 'name') body.append(key, String(value));
  const response = await fetch(API_URL + route, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body, signal: AbortSignal.timeout(180000) });
  const result = await response.json();
  if (!response.ok) throw new Error(apiError(result.detail, t("上传失败")));
  return result;
});
ipcMain.handle('permission', (event) => {
  validateSender(event);
  configureVoiceShortcut();
  return {
    screen: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'unknown',
    microphone: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('microphone') : 'unknown',
    accessibility: process.platform === 'darwin' ? accessibilityGranted() ? 'granted' : 'denied' : 'unknown',
    pushToTalk: !overlayPreferences.pushToTalk ? 'disabled' : !accessibilityGranted() ? 'permission-required' : !overlayPreferences.hearingEnabled ? 'hearing-disabled' : pushToTalk ? 'running' : 'unavailable',
  };
});
ipcMain.on('pointer-regions', (event, value, capturing) => {
  validateSender(event);
  if (event.sender !== companionWindow?.webContents) return;
  const regions = validRegions(value);
  if (!regions || typeof capturing !== 'boolean') return;
  pointerRegions = regions; pointerCapturing = capturing;
  updatePointerPassthrough();
});
ipcMain.handle('sources', async (event) => {
  validateSender(event);
  const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 320, height: 180 } });
  return sources.filter((source) => !source.name.startsWith('兆次元')).map((source) => ({ id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL() }));
});
ipcMain.handle('capture', async (event) => {
  validateSender(event);
  if (!overlayPreferences.visionEnabled) throw new Error(t("视觉开关已关闭"));
  const { settings: { companion }, modes } = await callApi('/api/bootstrap');
  if (!modes.find((mode) => mode.id === companion.mode)?.screenAllowed) throw new Error(t("当前模式不允许屏幕观察"));
  const settings = companion.screen;
  if (!settings.enabled || settings.paused) throw new Error(t("屏幕观察已关闭或暂停"));
  if (!safeSource(settings.sourceId)) throw new Error(t("请先选择观察窗口"));
  const high = settings.quality !== 'standard';
  const sources = await desktopCapturer.getSources({ types: [settings.sourceId.startsWith('screen:') ? 'screen' : 'window'], thumbnailSize: high ? { width: 3200, height: 2000 } : { width: 1600, height: 1000 } });
  const selected = sources.find((source) => source.id === settings.sourceId);
  if (!selected || selected.thumbnail.isEmpty()) throw new Error(t("目标窗口不可用，请重新选择"));
  const region = cropBounds(settings.region, selected.thumbnail.getSize());
  if (!overlayPreferences.visionEnabled) throw new Error(t("视觉开关已关闭"));
  const image = selected.thumbnail.crop(region);
  const imageData = 'data:image/' + (high ? 'png' : 'jpeg') + ';base64,' + (high ? image.toPNG() : image.toJPEG(82)).toString('base64');
  if (imageData.length > 8_000_000) throw new Error(t("截图超过大小上限，请缩小捕获区域或切换为标准画质"));
  return { imageData, sourceName: selected.name, capturedAt: new Date().toISOString() };
});
async function applyOverlayOptions(options = {}) {
  const operation = preferenceQueue.catch(() => {}).then(async () => {
  const next = { ...overlayPreferences };
  let changed = false;
  if (options.language !== undefined) {
    if (!languages.includes(options.language)) throw new Error(t('界面语言无效'));
    if (next.language !== options.language) { next.language = options.language; changed = true; }
  }
  for (const key of ['visible', 'clickThrough', 'alwaysOnTop', 'showGrip', 'gazeEnabled', 'visionEnabled', 'hearingEnabled', 'speechEnabled', 'pushToTalk', 'showBubble']) if (typeof options[key] === 'boolean' && next[key] !== options[key]) { next[key] = options[key]; changed = true; }
  if (options.pushToTalkKey !== undefined) {
    if (!['CommandOrControl+Shift+Space', 'Control+Alt+Space', 'F8', 'ShiftLeft+ShiftRight'].includes(options.pushToTalkKey)) throw Error(t("快捷键无效"));
    if (next.pushToTalkKey !== options.pushToTalkKey) { next.pushToTalkKey = options.pushToTalkKey; changed = true; }
  }
  if (['hover', 'always'].includes(options.menu) && options.menu !== next.menu) { next.menu = options.menu; changed = true; }
  for (const [key, min, max, integer] of [['characterScale', .65, 1.6, false], ['bubbleWidth', 60, 100, true], ['bubbleHeight', 56, 280, true], ['bubbleFontSize', 11, 20, true], ['bubbleAutoHide', 0, 120, true]]) {
    if (options[key] === undefined) continue;
    if (!Number.isFinite(options[key]) || options[key] < min || options[key] > max || (integer && !Number.isInteger(options[key]))) throw new Error(t("桌面显示设置数值无效"));
    if (next[key] !== options[key]) { next[key] = options[key]; changed = true; }
  }
  if (options.bubbleHeightPreview !== undefined && options.bubbleHeightPreview !== null && (!Number.isInteger(options.bubbleHeightPreview) || options.bubbleHeightPreview < 56 || options.bubbleHeightPreview > 280)) throw new Error(t("桌面显示设置数值无效"));
  if (changed) {
    await callApi('/api/desktop', { method: 'PUT', body: next });
    Object.assign(overlayPreferences, next);
    configureVoiceShortcut();
    chatWindow?.setTitle?.(t('兆次元 · 聊天'));
    companionWindow?.setTitle?.(t('兆次元 · 桌面角色'));
  }
  const framing = ['full', 'half', 'mini'].includes(options.framing) ? options.framing : lastState?.appearance?.framing || 'half';
  if (options.bubbleHeightPreview !== undefined) bubbleHeightPreview = options.bubbleHeightPreview;
  if (options.bubbleHeight !== undefined) bubbleHeightPreview = null;
  if (options.framing || options.characterScale !== undefined || options.bubbleHeight !== undefined || options.bubbleHeightPreview !== undefined) {
    const size = overlaySize(framing, overlayPreferences.characterScale, bubbleHeightPreview ?? overlayPreferences.bubbleHeight);
    const bounds = companionWindow.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    size.width = Math.min(size.width, area.width); size.height = Math.min(size.height, area.height);
    if (bounds.width !== size.width || bounds.height !== size.height) companionWindow.setBounds({ width: size.width, height: size.height, x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - size.width)), y: Math.max(area.y, Math.min(bounds.y + bounds.height - size.height, area.y + area.height - size.height)) });
  }
  companionWindow.setAlwaysOnTop(overlayPreferences.alwaysOnTop, 'floating');
  updatePointerPassthrough();
  if (overlayPreferences.visible && lastState?.appearance) companionWindow.showInactive(); else companionWindow.hide();
  if (changed && lastState) {
    const state = { ...lastState, desktopPreferences: { ...overlayPreferences } };
    lastState = state;
    consoleWindow.webContents.send('state', state);
    companionWindow.webContents.send('state', state);
    if (chatWindow && !chatWindow.isDestroyed()) chatWindow.webContents.send('state', state);
  }
  refreshTray();
  return { ...overlayPreferences };
  });
  preferenceQueue = operation;
  return operation;
}
ipcMain.handle('overlay', (event, options = {}) => { validateSender(event); return applyOverlayOptions(options); });
ipcMain.handle('open-console', (event) => { validateSender(event); showConsole(); });
ipcMain.handle('open-chat', (event) => { validateSender(event); showChat(); });
ipcMain.handle('open-data', (event) => { validateSender(event); return shell.openPath(app.isPackaged ? app.getPath('userData') : path.join(ROOT, 'runtime/v1')); });
ipcMain.handle('open-permissions', (event) => { validateSender(event); if (process.platform === 'darwin') return shell.openPath('/System/Applications/System Settings.app'); });
ipcMain.handle('quit', (event) => { validateSender(event); quitting = true; app.quit(); });
ipcMain.on('state', (event, state) => {
  validateSender(event);
  if (event.sender !== consoleWindow?.webContents) return;
  state = { ...state, desktopPreferences: { ...overlayPreferences } };
  lastState = state;
  refreshTray();
  if (!companionWindow?.isDestroyed()) companionWindow.webContents.send('state', state);
  if (chatWindow && !chatWindow.isDestroyed()) chatWindow.webContents.send('state', state);
});
ipcMain.on('command', (event, command) => {
  validateSender(event);
  if (['voice', 'continuous', 'stop', 'observe', 'mute', 'refresh'].includes(command)) consoleWindow?.webContents.send('command', command);
  else if (command && typeof command === 'object' && ['send', 'draft', 'mode', 'appearance', 'settings', 'role'].includes(command.type) && typeof command.value === 'string' && command.value.length <= 20000) consoleWindow?.webContents.send('command', command);
});

app.whenReady().then(async () => {
  overlayPreferences.language = initialLanguage(undefined, app.getPreferredSystemLanguages?.()[0] || app.getLocale?.());
  session.defaultSession.setPermissionRequestHandler(async (contents, permission, callback) => {
    if (!overlayPreferences.hearingEnabled || !contents.getURL().startsWith(UI_URL) || permission !== 'media') return callback(false);
    if (process.platform === 'darwin') callback(await systemPreferences.askForMediaAccess('microphone'));
    else callback(true);
  });
  try {
    await startApi();
    const desktop = await callApi('/api/desktop');
    Object.assign(overlayPreferences, desktop);
    overlayPreferences.language = initialLanguage(desktop.language, app.getPreferredSystemLanguages?.()[0] || app.getLocale?.());
    if (desktop.language !== overlayPreferences.language) await callApi('/api/desktop', { method: 'PUT', body: overlayPreferences });
    createWindows();
    companionWindow.webContents.on('did-finish-load', () => { if (lastState) companionWindow.webContents.send('state', lastState); });
  } catch (error) { dialog.showErrorBox(t("兆次元 启动失败"), t(error.message)); quitting = true; app.quit(); }
});
app.on('activate', showConsole);
app.on('window-all-closed', () => { if (quitting) app.quit(); });
app.on('before-quit', () => { quitting = true; clearInterval(pointerTimer); pushToTalk?.stop(); for (const stream of streams.values()) stream.controller.abort(); globalShortcut.unregisterAll(); apiProcess?.kill(); });
