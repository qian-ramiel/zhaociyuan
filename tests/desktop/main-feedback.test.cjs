const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function mainFixture(options = {}) {
  const handles = {}, events = {}, windows = [], requests = [];
  const hook = new EventEmitter(); let hookStarts = 0, hookStops = 0, trusted = options.trusted ?? true;
  let cursor = { x: 810, y: 310 };
  const paths = {}, names = [];
  hook.start = () => hookStarts++; hook.stop = () => hookStops++;
  let ready, tray, permission, fail = false, captures = 0, bootstrap, sources = [], streamResponse;
  const captureOptions = [];
  const prefs = { visible: true, clickThrough: false, alwaysOnTop: true, menu: 'hover', showGrip: true, gazeEnabled: true, visionEnabled: true, hearingEnabled: true, speechEnabled: true, pushToTalk: false, ...options.preferences };
  class Window {
    constructor(options) {
      this.options = options; this.sent = []; this.visible = false; this.bounds = { x: 800, y: 300, width: 350, height: 450 };
      this.webContents = Object.assign(new EventEmitter(), { send: (...args) => this.sent.push(args), setWindowOpenHandler() {} });
      windows.push(this);
    }
    loadURL() {} on() {} once() {} setVisibleOnAllWorkspaces() {} setAlwaysOnTop() {}
    setIgnoreMouseEvents(value, options) { this.ignored = value; this.forward = options.forward; }
    show() { this.visible = true; } showInactive() { this.visible = true; } hide() { this.visible = false; }
    focus() { this.focused = true; } isDestroyed() { return false; }
    getBounds() { return this.bounds; } setBounds(value) { this.bounds = value; }
  }
  const electron = {
    app: { isPackaged: true, getPreferredSystemLanguages: () => [options.systemLanguage || 'zh-CN'], setName: (name) => names.push(name), getPath: (key) => '/fixture/' + key, setPath: (key, value) => { paths[key] = value; }, requestSingleInstanceLock: () => true, on() {}, whenReady: () => ({ then: (cb) => { ready = cb; } }), quit() {} },
    BrowserWindow: Window,
    ipcMain: { handle: (key, cb) => { handles[key] = cb; }, on: (key, cb) => { events[key] = cb; } },
    nativeImage: { createFromPath: (filename) => {
      assert.match(filename, /renderer\/dist\/brand\/logo.png$/);
      return { resize: ({ width, height }) => ({ width, height, representations: [],
        toDataURL: () => `fixture:${width}x${height}`, addRepresentation(value) { this.representations.push(value); },
        setTemplateImage(value) { this.template = value; } }) };
    } },
    Tray: class { constructor(icon) { tray = this; this.icon = icon; this.callbacks = {}; } setContextMenu(menu) { this.menu = menu; } setToolTip(value) { this.tooltip = value; } setTitle(value) { this.title = value; } on(key, cb) { this.callbacks[key] = cb; } popUpContextMenu() { this.opened = true; } },
    Menu: { buildFromTemplate: (template) => template },
    globalShortcut: { register() {}, unregisterAll() {} },
    screen: { getCursorScreenPoint: () => cursor, getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }), getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }) },
    session: { defaultSession: { setPermissionRequestHandler: (cb) => { permission = cb; } } },
    desktopCapturer: { getSources: async (options) => { captures++; captureOptions.push(options); return sources; } },
    systemPreferences: { getMediaAccessStatus: () => 'granted', askForMediaAccess: async () => true, isTrustedAccessibilityClient: () => trusted }, dialog: { showErrorBox: (_, message) => { throw Error(message); } },
  };
  const filename = path.resolve('apps/desktop/main.cjs');
  const context = vm.createContext({
    require: (name) => name === 'electron' ? electron : name === 'uiohook-napi' ? { uIOhook: hook, UiohookKey: { F8: 66, Escape: 1 } } : require(name.startsWith('.') ? path.resolve(path.dirname(filename), name) : name),
    __dirname: path.dirname(filename), Buffer, URL, AbortSignal, AbortController, setTimeout, clearTimeout, setInterval: () => ({ unref() {} }), clearInterval() {},
    process: { env: { NICE_PEOPLE_EXTERNAL_API: '1' }, platform: 'darwin', resourcesPath: '/fixture' },
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      if (url.endsWith('/stream') && streamResponse) return streamResponse(options);
      if (fail) return { ok: false, json: async () => ({ detail: '保存失败' }) };
      if (options.method === 'PUT') Object.assign(prefs, JSON.parse(options.body));
      if (url.endsWith('/api/bootstrap')) return { ok: true, json: async () => bootstrap };
      return { ok: true, json: async () => ({ ...prefs }) };
    },
  });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return { context, handles, events, windows, requests, prefs, paths, names, cursor: (value) => { cursor = value; }, hook, hookStarts: () => hookStarts, hookStops: () => hookStops, trust: (value) => { trusted = value; }, ready: () => ready(), tray: () => tray, permission: () => permission, fail: (value) => { fail = value; }, streamFixture: (value) => { streamResponse = value; }, captures: () => captures, captureOptions, captureFixture: (value, items) => { bootstrap = value; sources = items; } };
}

test('brand changes preserve packaged userData and native logo reference', async () => {
  const f = mainFixture(); await f.ready();
  assert.equal(f.names[0], '兆次元');
  assert.equal(f.paths.userData, '/fixture/appData/Nice People');
  assert.equal(f.windows[0].options.title, '兆次元');
  assert.equal(f.tray().tooltip, '兆次元');
  assert.equal(f.tray().title ?? '', '');
  assert.equal(f.tray().icon.template, true);
  assert.equal(f.tray().icon.width, 22);
  assert.deepEqual(f.tray().icon.representations.map((value) => [value.scaleFactor, value.dataURL]), [[2, 'fixture:44x44']]);
  assert.deepEqual(fs.readFileSync('apps/desktop/renderer/public/brand/logo.png'), fs.readFileSync('docs/brand/zhaociyuan/兆次元-logo-选定版.png'));
});

test('first-install language is saved, explicit preference survives system changes and updates every window', async () => {
  for (const [systemLanguage, expected] of [['zh-TW', 'zh'], ['en-GB', 'en'], ['ja-JP', 'ja'], ['fr-FR', 'en']]) {
    const f = mainFixture({ systemLanguage }); await f.ready(); assert.equal(f.prefs.language, expected);
    for (const window of f.windows) assert.deepEqual(Array.from(window.options.webPreferences.additionalArguments), ['--zhaociyuan-ui-language=' + expected]);
  }
  const f = mainFixture({ systemLanguage: 'ja-JP', preferences: { language: 'en' } }); await f.ready();
  assert.equal(f.tray().menu[0].label, 'Control Panel');
  const event = { senderFrame: { url: 'http://127.0.0.1:8791/' }, sender: f.windows[0].webContents };
  f.events.state(event, { persona: { characterName: '原始名字' } });
  await f.handles.overlay(event, { language: 'ja' });
  assert.equal(f.prefs.language, 'ja'); assert.equal(f.tray().menu[0].label, 'コントロールパネル');
  for (const window of f.windows) assert.equal(window.sent.filter(([channel]) => channel === 'state').at(-1)[1].desktopPreferences.language, 'ja');
  await assert.rejects(f.handles.overlay(event, { language: 'fr' })); assert.equal(f.prefs.language, 'ja');
  f.fail(true); await assert.rejects(f.handles.overlay(event, { language: 'zh' })); assert.equal(f.prefs.language, 'ja');
  assert.equal(f.tray().menu[0].label, 'コントロールパネル');
});

test('empty native space ignores clicks; avatar, controls and captured resize remain interactive', async () => {
  const f = mainFixture(); await f.ready();
  const event = { senderFrame: { url: 'http://127.0.0.1:8791/' }, sender: f.windows[1].webContents };
  const regions = [{ x: 20, y: 100, width: 300, height: 300 }, { x: 10, y: 390, width: 320, height: 40 }];
  f.events['pointer-regions'](event, regions, false);
  assert.equal(f.windows[1].ignored, true);
  assert.equal(f.windows[1].forward, true);
  f.cursor({ x: 900, y: 500 }); vm.runInContext('updatePointerPassthrough()', f.context);
  assert.equal(f.windows[1].ignored, false);
  f.events['pointer-regions'](event, [], true);
  f.cursor({ x: 800, y: 300 }); vm.runInContext('updatePointerPassthrough()', f.context);
  assert.equal(f.windows[1].ignored, false);
  await f.handles.overlay(event, { clickThrough: true });
  assert.equal(f.windows[1].ignored, true);
  await f.handles.overlay(event, { clickThrough: false });
  f.events['pointer-regions'](event, regions, false);
  f.events['pointer-regions']({ ...event, sender: f.windows[0].webContents }, [{ x: 0, y: 0, width: 350, height: 450 }], true);
  f.events['pointer-regions'](event, [{ x: NaN, y: 0, width: 1, height: 1 }], true);
  assert.equal(f.windows[1].ignored, true);
  f.cursor({ x: 900, y: 500 }); vm.runInContext('updatePointerPassthrough()', f.context);
  assert.equal(f.windows[1].ignored, false);
  f.windows[1].webContents.emit('did-start-loading');
  assert.equal(f.windows[1].ignored, true);
});

test('default double Shift waits for permission, refresh activates injected hook and revocation stops it', async () => {
  const f = mainFixture({ trusted: false, preferences: { pushToTalk: true, pushToTalkKey: 'ShiftLeft+ShiftRight' } }); await f.ready();
  const event = { senderFrame: { url: 'http://127.0.0.1:8791/' } };
  assert.equal(f.hookStarts(), 0);
  assert.equal(f.handles.permission(event).accessibility, 'denied');
  assert.equal(f.handles.permission(event).pushToTalk, 'permission-required');
  f.trust(true);
  assert.equal(f.handles.permission(event).pushToTalk, 'running');
  assert.equal(f.hookStarts(), 1);
  f.handles.permission(event); assert.equal(f.hookStarts(), 1);
  f.trust(false);
  assert.equal(f.handles.permission(event).pushToTalk, 'permission-required');
  assert.equal(f.hookStops(), 1);
});

test('main wires tray to console commands, click popup and persisted preference broadcast', async () => {
  const f = mainFixture(); await f.ready();
  const event = { senderFrame: { url: 'http://127.0.0.1:8791/' }, sender: f.windows[0].webContents };
  f.events.state(event, { roles: [{ id: 'r', name: '角色' }], appearances: [{ id: 'a', name: '全身' }], appearance: { id: 'a' }, companion: { characterId: 'r' } });
  f.tray().callbacks.click(); assert.equal(f.tray().opened, true);
  f.tray().menu[0].click(); assert.equal(f.windows[0].focused, true);
  f.tray().menu[2].submenu[0].click(); f.tray().menu[4].submenu[0].click();
  assert.deepEqual(f.windows[0].sent.filter(([channel]) => channel === 'command').map(([, command]) => JSON.parse(JSON.stringify(command))), [{ type: 'settings', value: '' }, { type: 'role', value: 'r' }, { type: 'appearance', value: 'a' }]);
  f.tray().menu[6].click({ checked: false });
  await vm.runInContext('preferenceQueue', f.context);
  assert.equal(f.prefs.visionEnabled, false);
  assert.equal(f.tray().menu[6].checked, false);
  for (const window of f.windows) assert.equal(window.sent.filter(([channel]) => channel === 'state').at(-1)[1].desktopPreferences.visionEnabled, false);
  await assert.rejects(f.handles.capture(event), /视觉开关已关闭/);
  assert.equal(f.captures(), 0);
});

test('serialized preferences retain simultaneous switches; failed save preserves prior state', async () => {
  const f = mainFixture(); await f.ready();
  const event = { senderFrame: { url: 'http://127.0.0.1:8791/' } };
  await Promise.all([f.handles.overlay(event, { hearingEnabled: false }), f.handles.overlay(event, { speechEnabled: false })]);
  assert.equal(f.prefs.hearingEnabled, false); assert.equal(f.prefs.speechEnabled, false);
  let granted;
  await f.permission()({ getURL: () => event.senderFrame.url }, 'media', (value) => { granted = value; });
  assert.equal(granted, false);
  f.fail(true);
  await assert.rejects(f.handles.overlay(event, { visible: false }), /保存失败/);
  assert.equal(f.prefs.visible, true);
  assert.equal(vm.runInContext('overlayPreferences.visible', f.context), true);
  f.fail(false);
  await f.handles.overlay(event, { speechEnabled: true });
  assert.equal(f.prefs.hearingEnabled, false); assert.equal(f.prefs.speechEnabled, true);
});

test('untrusted renderer cannot drive main settings or replace current tray state', async () => {
  const f = mainFixture(); await f.ready();
  await assert.rejects(async () => f.handles.overlay({ senderFrame: { url: 'https://untrusted.invalid/' } }, { visible: false }), /无效窗口请求/);
  f.events.state({ senderFrame: { url: 'http://127.0.0.1:8791/' }, sender: f.windows[1].webContents }, { roles: [{ id: 'injected', name: 'injected' }] });
  assert.equal(f.tray().menu[2].submenu[0].enabled, false);
});

test('floating draft updates are relayed only from trusted windows', async () => {
  const f = mainFixture(); await f.ready();
  const command = { type: 'draft', value: '待发送语音' };
  assert.equal(f.windows[0].options.webPreferences.backgroundThrottling, false);
  f.events.command({ senderFrame: { url: 'http://127.0.0.1:8791/' } }, command);
  assert.equal(f.windows[0].sent.at(-1)[0], 'command');
  assert.equal(f.windows[0].sent.at(-1)[1], command);
  assert.throws(() => f.events.command({ senderFrame: { url: 'https://untrusted.invalid/' } }, command), /无效窗口请求/);
});

test('native PTT stays off until opted in and trusted; hearing off stops hook and held recording', async () => {
  const f = mainFixture(); await f.ready();
  const event = { senderFrame: { url: 'http://127.0.0.1:8791/' } };
  assert.equal(f.hookStarts(), 0);
  f.trust(false);
  await f.handles.overlay(event, { pushToTalk: true });
  assert.equal(f.handles.permission(event).pushToTalk, 'permission-required');
  assert.equal(f.hookStarts(), 0);
  f.trust(true);
  await f.handles.overlay(event, { pushToTalk: true, pushToTalkKey: 'F8' });
  assert.equal(f.hookStarts(), 1);
  f.hook.emit('keydown', { keycode: 66 });
  assert.equal(f.windows[0].sent.at(-1)[1], 'ptt-start');
  await f.handles.overlay(event, { hearingEnabled: false });
  assert.equal(f.hookStops(), 1);
  assert.ok(f.windows[0].sent.some(([channel, value]) => channel === 'command' && value === 'ptt-cancel'));
  await assert.rejects(f.handles.overlay(event, { pushToTalkKey: 'bad' }), /快捷键/);
});

test('stream IPC allowlist rejects untrusted route/sender; lip amplitude only forwards console output', async () => {
  const f = mainFixture(); await f.ready();
  const event = { senderFrame: { url: 'http://127.0.0.1:8791/' }, sender: f.windows[0].webContents };
  await assert.rejects(f.handles.stream(event, 'id', '/api/roles', {}), /无效流式/);
  await assert.rejects(f.handles.stream({ ...event, senderFrame: { url: 'https://bad/' } }, 'id', '/api/chat/stream', {}), /无效窗口/);
  f.events['lip-sync'](event, .7);
  assert.deepEqual(f.windows[1].sent.at(-1), ['lip-sync', .7]);
  const count = f.windows[1].sent.length;
  f.events['lip-sync']({ ...event, sender: f.windows[1].webContents }, .8);
  f.events['lip-sync'](event, NaN);
  assert.equal(f.windows[1].sent.length, count);
});

test('stream IPC forwards events with request id and releases state/listeners after completion', async () => {
  const f = mainFixture(); await f.ready();
  const sender = f.windows[0].webContents;
  const event = { senderFrame: { url: 'http://127.0.0.1:8791/' }, sender };
  f.streamFixture(() => new Response('{"type":"text","delta":"你好"}\n{"type":"done"}\n'));
  await f.handles.stream(event, 'voice-stream', '/api/chat/stream', { content: 'hello', requestId: 'trace-chat' });
  assert.deepEqual(f.windows[0].sent.filter(([channel]) => channel === 'stream-event'), [
    ['stream-event', 'voice-stream', { type: 'text', delta: '你好' }], ['stream-event', 'voice-stream', { type: 'done' }],
  ]);
  assert.equal(vm.runInContext('streams.size', f.context), 0);
  assert.equal(sender.listenerCount('destroyed'), 0);
  const request = f.requests.find((entry) => entry.url.endsWith('/api/chat/stream'));
  assert.match(request.options.headers.Authorization, /^Bearer /);
  assert.equal(request.options.headers['X-Request-ID'], 'trace-chat');
  assert.equal(JSON.parse(request.options.body).content, 'hello');
});

test('stream IPC cancel is owner-scoped; destroyed sender aborts and clears outstanding request', async () => {
  const f = mainFixture(); await f.ready();
  const event = { senderFrame: { url: 'http://127.0.0.1:8791/' }, sender: f.windows[0].webContents };
  let signal;
  f.streamFixture((options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ start(controller) {
      signal.addEventListener('abort', () => controller.error(Error('aborted')), { once: true });
    } }));
  });
  const pending = f.handles.stream(event, 'pending', '/api/tts/stream', { text: 'hello' });
  const rejection = assert.rejects(pending, /aborted/);
  await f.handles['stream-cancel']({ ...event, sender: f.windows[1].webContents }, 'pending');
  assert.equal(signal.aborted, false);
  await f.handles['stream-cancel'](event, 'pending');
  await rejection;
  assert.equal(vm.runInContext('streams.size', f.context), 0);
  const destroyed = f.handles.stream(event, 'destroyed', '/api/chat/stream', { content: 'hello' });
  const destroyedRejection = assert.rejects(destroyed, /aborted/);
  event.sender.emit('destroyed');
  await destroyedRejection;
  assert.equal(signal.aborted, true);
  assert.equal(event.sender.listenerCount('destroyed'), 0);
});

test('desktop sizes persist, clamp to work area and reject invalid numeric preferences', async () => {
  const f = mainFixture(); await f.ready();
  const event = { senderFrame: { url: 'http://127.0.0.1:8791/' }, sender: f.windows[0].webContents };
  f.events.state(event, { appearance: { id: 'a', framing: 'full' } });
  await f.handles.overlay(event, { characterScale: 1.6, bubbleWidth: 65, bubbleFontSize: 17, bubbleAutoHide: 0 });
  assert.equal(f.prefs.characterScale, 1.6); assert.equal(f.prefs.bubbleAutoHide, 0);
  const bounds = f.windows[1].getBounds();
  assert.equal(bounds.width, 592); assert.equal(bounds.height, 900); assert.equal(bounds.y, 0);
  for (const patch of [{ characterScale: NaN }, { characterScale: '1' }, { bubbleWidth: 101 }, { bubbleHeight: 55 }, { bubbleHeight: 281 }, { bubbleHeightPreview: NaN }, { bubbleHeightPreview: '72' }, { bubbleFontSize: 10 }, { bubbleAutoHide: -1 }, { bubbleAutoHide: 1.5 }]) await assert.rejects(f.handles.overlay(event, patch), /数值无效/);
  assert.equal(f.prefs.characterScale, 1.6);
  await f.handles.overlay(event, { framing: 'mini', characterScale: .65 });
  assert.equal(f.windows[1].getBounds().width, 260);
  assert.equal(f.windows[1].getBounds().height, 317);
});

test('bubble drag previews geometry without writes, commits once and preserves window bottom', async () => {
  const f = mainFixture(); await f.ready();
  const event = { senderFrame: { url: 'http://127.0.0.1:8791/' }, sender: f.windows[0].webContents };
  f.events.state(event, { appearance: { id: 'a', framing: 'half' } });
  await f.handles.overlay(event, { framing: 'half' });
  const before = { ...f.windows[1].bounds }, writes = () => f.requests.filter((r) => r.options.method === 'PUT').length;
  const initialWrites = writes();
  await f.handles.overlay(event, { bubbleHeightPreview: 152 });
  const preview = { ...f.windows[1].bounds };
  assert.equal(writes(), initialWrites);
  assert.equal(preview.height, before.height + 80);
  assert.equal(preview.y + preview.height, before.y + before.height);
  assert.equal(preview.width, before.width);
  // Repeated console framing updates must not undo an in-progress drag.
  await f.handles.overlay(event, { framing: 'half' });
  assert.deepEqual({ ...f.windows[1].bounds }, preview);
  await f.handles.overlay(event, { bubbleHeight: 152 });
  assert.equal(writes(), initialWrites + 1);
  assert.equal(f.prefs.bubbleHeight, 152);
  assert.deepEqual({ ...f.windows[1].bounds }, preview);
  await f.handles.overlay(event, { bubbleHeightPreview: 230 });
  f.fail(true);
  await assert.rejects(f.handles.overlay(event, { bubbleHeight: 230 }), /保存失败/);
  await f.handles.overlay(event, { bubbleHeightPreview: null });
  assert.equal(f.prefs.bubbleHeight, 152);
  assert.deepEqual({ ...f.windows[1].bounds }, preview);
});

test('capture uses high-resolution lossless PNG by default and cropped standard JPEG on request', async () => {
  const f = mainFixture(); await f.ready();
  const event = { senderFrame: { url: 'http://127.0.0.1:8791/' } };
  let crop, jpegQuality, oversized = false;
  const thumbnail = {
    isEmpty: () => false, getSize: () => ({ width: 3000, height: 1800 }),
    crop: (bounds) => { crop = bounds; return { toPNG: () => Buffer.alloc(oversized ? 6_000_000 : 4), toJPEG: (quality) => { jpegQuality = quality; return Buffer.alloc(3); } }; },
  };
  const companion = { mode: 'work', screen: { sourceId: 'window:1:0', enabled: true, paused: false, region: { x: .25, y: .2, width: .5, height: .5 } } };
  f.captureFixture({ settings: { companion }, modes: [{ id: 'work', screenAllowed: true }] }, [{ id: 'window:1:0', name: 'Fixture window', thumbnail }]);
  const high = await f.handles.capture(event);
  assert.match(high.imageData, /^data:image\/png;base64,/);
  assert.equal(f.captureOptions[0].thumbnailSize.width, 3200);
  assert.equal(f.captureOptions[0].thumbnailSize.height, 2000);
  assert.equal(crop.x, 750); assert.equal(crop.y, 360); assert.equal(crop.width, 1500);
  companion.screen.quality = 'standard';
  const standard = await f.handles.capture(event);
  assert.match(standard.imageData, /^data:image\/jpeg;base64,/); assert.equal(jpegQuality, 82);
  assert.equal(f.captureOptions[1].thumbnailSize.width, 1600);
  companion.screen.quality = 'high'; oversized = true;
  await assert.rejects(f.handles.capture(event), /截图超过大小上限/);
});
