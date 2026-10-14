import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { translate } from '../../apps/desktop/locale.mjs';

const root = process.cwd();
const cache = path.join(root, 'runtime/qa/fixes-2026-10-08/browser-cache');
if (await fs.stat(cache).catch(() => null)) process.env.PLAYWRIGHT_BROWSERS_PATH ||= cache;
const { chromium } = await import('playwright');
const directory = path.join(root, 'runtime/qa/i18n', String(Date.now()));
await fs.mkdir(directory, { recursive: true });
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
const url = `http://127.0.0.1:${port}`;
const server = spawn(process.env.NICE_PEOPLE_PYTHON || path.join(root, '.venv/bin/python'), ['tests/desktop/feedback-server.py', String(port)], {
  env: { ...process.env, PYTHONPATH: 'services/companion', NICE_PEOPLE_HOME: path.join(directory, 'data'), NICE_PEOPLE_RESOURCES: path.join(directory, 'resources'), NICE_PEOPLE_TOKEN: '', NICE_PEOPLE_RENDERER: path.join(root, 'apps/desktop/renderer/dist') }, stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '', browser;
server.stdout.on('data', (value) => { log += value; }); server.stderr.on('data', (value) => { log += value; });
const report = { checks: [], errors: [], native: 'Native system-language resolution and menu covered by injected main-process tests; browser screenshots use isolated data.' };
async function request(route, method = 'GET', body) {
  const response = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value;
}
async function ready(check, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { if (await check()) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw Error('Readiness timeout: ' + log);
}
try {
  await ready(() => fetch(url + '/api/health').then((value) => value.ok));
  browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
  for (const [locale, language] of [['zh-CN', 'zh'], ['en-GB', 'en'], ['ja-JP', 'ja'], ['fr-FR', 'en']]) {
    const context = await browser.newContext({ locale, viewport: { width: 1100, height: 820 } });
    const page = await context.newPage(); page.on('pageerror', (error) => report.errors.push(error.message));
    await page.goto(url);
    await page.getByRole('heading', { name: translate('角色库', language), exact: true }).waitFor();
    await page.getByRole('button', { name: translate('全局设置', language), exact: true }).click();
    assert.equal(await page.getByRole('combobox', { name: translate('界面语言', language) }).inputValue(), language);
    assert.equal(await page.locator('html').getAttribute('lang'), { zh: 'zh-CN', en: 'en-US', ja: 'ja-JP' }[language]);
    await page.screenshot({ path: path.join(directory, `settings-${locale}.png`) });
    report.checks.push(`first profile ${locale} -> ${language}, translated settings and document language`);
    await context.close();
  }
  const role = await request('/api/roles', 'POST', { name: '不翻译这个角色', intro: '日本語と中文の原文', personality: '保留这段设定。' });
  const persona = (await request('/api/settings')).persona; persona.systemPrompt = '请保持这段中文提示词，不要自动翻译。';
  await request('/api/settings/persona', 'PUT', persona);
  const baseline = (await request('/api/bootstrap')).settings;
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1100, height: 820 } });
  let state, prefs = await request('/api/desktop');
  const commands = [];
  await context.exposeBinding('__invoke', async (source, kind, route, options) => {
    if (kind === 'publish') { state = route; return; }
    if (kind === 'api') return request(route, options?.method, options?.body);
    if (kind === 'command') {
      commands.push(route);
      if (route?.type === 'draft') {
        const main = context.pages().find((page) => page.url() === url + '/');
        await main?.evaluate((command) => window.__deliverCommand?.(command), route);
      }
      return;
    }
    if (kind === 'permission') return { screen: 'denied', microphone: 'denied', accessibility: 'denied', pushToTalk: 'permission-required' };
    if (kind === 'overlay') {
      prefs = await request('/api/desktop', 'PUT', { ...prefs, ...route });
      for (const page of context.pages()) if (!page.isClosed()) await page.evaluate((next) => window.__deliver?.(next), { ...state, desktopPreferences: prefs });
      return prefs;
    }
    throw Error('Unknown bridge action');
  });
  await context.addInitScript(() => {
    const callbacks = new Set(), commandCallbacks = new Set(); window.__identity = Math.random();
    window.__deliver = (state) => { for (const callback of callbacks) callback(state); };
    window.__deliverCommand = (command) => { for (const callback of commandCallbacks) callback(command); };
    window.desktop = {
      platform: 'darwin', initialLanguage: 'en', api: (route, options) => window.__invoke('api', route, options),
      overlay: (value) => window.__invoke('overlay', value), permission: () => window.__invoke('permission'),
      notifyState: (state) => window.__invoke('publish', state), onState: (callback) => { callbacks.add(callback); return () => callbacks.delete(callback); },
      onCommand: (callback) => { commandCallbacks.add(callback); return () => commandCallbacks.delete(callback); }, command: (command) => window.__invoke('command', command),
      pointerRegions() {}, lipSync() {}, openChat() {}, openConsole() {},
    };
  });
  const page = await context.newPage(); page.on('pageerror', (error) => report.errors.push(error.message));
  await page.goto(url); await page.getByRole('heading', { name: '不翻译这个角色', exact: true }).waitFor();
  const chat = await context.newPage(); chat.on('pageerror', (error) => report.errors.push(error.message));
  await chat.goto(url + '/?window=chat');
  await chat.getByRole('textbox', { name: 'Chat Input' }).fill('まだ送っていない文本');
  await ready(() => state?.draft === 'まだ送っていない文本');
  const identity = await chat.evaluate(() => window.__identity);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  for (const [language, label] of [['ja', '表示言語'], ['zh', '界面语言'], ['en', 'Interface Language']]) {
    await page.locator('.general-page select').first().selectOption(language);
    await page.getByRole('combobox', { name: label }).waitFor();
    await ready(async () => await page.locator('.toast').count() === 0);
    await chat.getByRole('textbox', { name: translate('聊天输入', language) }).waitFor();
    assert.equal(await chat.getByRole('textbox', { name: translate('聊天输入', language) }).inputValue(), 'まだ送っていない文本');
    assert.equal(await chat.evaluate(() => window.__identity), identity);
    assert.equal((await request('/api/desktop')).language, language);
    assert.deepEqual((await request('/api/bootstrap')).settings, baseline);
    await page.screenshot({ path: path.join(directory, `live-switch-${language}.png`) });
    report.checks.push(`${language}: persisted switch, chat draft retained without reloading, role settings unchanged`);
    for (const key of ['角色设定', '角色形象', '角色配置', '运行记录']) {
      await page.getByRole('button', { name: translate(key, language), exact: true }).click();
      await page.screenshot({ path: path.join(directory, `${language}-${key}.png`) });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (key === '角色配置') {
        const input = page.getByRole('spinbutton', { name: translate('回复 Token 上限', language) });
        await input.fill('20');
        await page.getByRole('button', { name: translate('保存', language), exact: true }).click();
        await ready(() => page.evaluate((label) => document.activeElement?.getAttribute('aria-label') === label, translate('回复 Token 上限', language)));
        assert.equal(await input.inputValue(), '20');
        assert.deepEqual((await request('/api/bootstrap')).settings, baseline);
        assert((await page.locator('.validation-error').innerText()).includes('128'));
      }
    }
    await page.getByRole('button', { name: translate('全局设置', language), exact: true }).click();
  }
  assert(!commands.some((value) => value === 'stop' || value === 'continuous' || value.type === 'send'));
  await page.reload(); await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  assert.equal(await page.getByRole('combobox', { name: 'Interface Language' }).inputValue(), 'en');
  assert.deepEqual(report.errors, []); report.checks.push('saved language survives reload without issuing stop, call or send commands');
  report.passed = true;
} catch (error) { report.errors.push(error.stack); report.passed = false; process.exitCode = 1; }
finally {
  await browser?.close(); const exit = once(server, 'exit'); server.kill('SIGTERM'); await exit;
  await fs.writeFile(path.join(directory, 'server.log'), log);
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, directory }, null, 2));
}
