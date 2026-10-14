import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { translate } from '../../apps/desktop/locale.mjs';

const root = process.cwd();
const require = createRequire(import.meta.url);
const { freePort } = require('../../apps/desktop/service.cjs');
const directory = path.join(root, 'runtime/qa/builtin-characters', String(Date.now()));
await fs.mkdir(directory, { recursive: true });
const report = { checks: [], renders: [], errors: [], failedRequests: [], passed: false };
const chunk = (await fs.readdir(path.join(root, 'apps/desktop/renderer/dist/assets'))).find((file) => /^main-.*\.js$/.test(file));
let app;
async function ready(check, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw Error('Readiness timeout');
}
async function pixels(page) {
  return page.locator('.avatar-viewport canvas').first().evaluate((canvas) => new Promise((resolve) => requestAnimationFrame(() => {
    const gl = canvas.getContext('webgl2');
    const bytes = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
    gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    let visible = 0, hash = 2166136261;
    for (let i = 0; i < bytes.length; i += 4) {
      if (bytes[i + 3] > 16) visible++;
      hash = Math.imul(hash ^ bytes[i] ^ bytes[i + 1] ^ bytes[i + 2] ^ bytes[i + 3], 16777619);
    }
    resolve({ visible, hash: hash >>> 0 });
  })));
}
try {
  const port = await freePort();
  app = await electron.launch({ args: ['.'], cwd: root, env: { ...process.env,
    NICE_PEOPLE_API: `http://127.0.0.1:${port}`, NICE_PEOPLE_PYTHON: process.env.NICE_PEOPLE_PYTHON || path.join(root, '.venv/bin/python'),
    NICE_PEOPLE_PROFILE: path.join(directory, 'electron'), NICE_PEOPLE_HOME: path.join(directory, 'home'),
    NICE_PEOPLE_RESOURCES: path.join(directory, 'resources'), NICE_PEOPLE_BUNDLED_CHARACTERS: path.join(root, 'resources/builtin-characters'),
    PYTHON_KEYRING_BACKEND: 'keyring.backends.null.Keyring',
  }, timeout: 60000 });
  await app.firstWindow();
  let page, overlay;
  await ready(async () => {
    const windows = await app.windows();
    page = windows.find((page) => page.url() === `http://127.0.0.1:${port}/`);
    overlay = windows.find((page) => page.url().includes('window=companion'));
    return page && overlay;
  });
  for (const window of [page, overlay]) {
    window.on('pageerror', (error) => report.errors.push(error.message));
    window.on('response', (response) => { if (response.status() >= 400) report.failedRequests.push({ url: new URL(response.url()).pathname, status: response.status() }); });
  }
  await page.waitForFunction(() => window.desktop && document.querySelector('.avatar-viewport canvas') && !document.querySelector('.avatar-loading'), { timeout: 60000 });
  await page.evaluate(() => window.desktop.overlay({ hearingEnabled: false, visionEnabled: false, pushToTalk: false }));
  const state = await page.evaluate(() => window.desktop.api('/api/bootstrap'));
  assert.deepEqual(state.roles.map((role) => role.name), ['虹色 Mao', '桃濑日和 Hiyori']);
  assert.equal(state.settings.persona.characterName, '虹色 Mao');
  assert.equal(state.health.modelConfigured, false);
  assert.equal(state.messages.length, 0);
  report.checks.push('clean native first launch: Mao selected, both roles present, no fabricated conversation or cloud credentials');
  const language = state.desktop.language;
  for (const [index, role] of state.roles.entries()) {
    await page.getByLabel(translate('当前角色', language), { exact: true }).selectOption(role.id);
    await page.getByRole('button', { name: translate('陪伴', language), exact: true }).click();
    await page.waitForFunction((id) => document.querySelector('.avatar-viewport')?.getAttribute('data-appearance') === id + '-full' && !document.querySelector('.avatar-loading'), role.id);
    await overlay.waitForFunction((id) => document.querySelector('.avatar-viewport')?.getAttribute('data-appearance') === id + '-full' && !document.querySelector('.avatar-loading'), role.id);
    const before = await pixels(page);
    assert(before.visible > 1000, `${role.name}: blank main canvas`);
    await page.screenshot({ path: path.join(directory, `${index}-panel.png`) });
    const overlayPixels = await pixels(overlay);
    assert(overlayPixels.visible > 1000, `${role.name}: blank overlay canvas`);
    await overlay.screenshot({ path: path.join(directory, `${index}-overlay.png`), omitBackground: true });
    await page.evaluate(async (chunk) => {
      const model = await import('/assets/' + chunk);
      model.lookAtLive2D(-.8, .2, true);
      model.setLive2DVoiceMouth(0.9);
    }, chunk);
    await new Promise((resolve) => setTimeout(resolve, 650));
    const moved = await pixels(page);
    assert.notEqual(moved.hash, before.hash, `${role.name}: model is not updating`);
    await page.evaluate(async (chunk) => { const model = await import('/assets/' + chunk); model.setLive2DVoiceMouth(0); model.lookAtLive2D(0, 0, true); }, chunk);
    if (index === 0) {
      for (const expression of ['exp_02', 'exp_04', 'exp_08', 'exp_05', 'exp_07', 'exp_01']) {
        await page.evaluate(async ({ chunk, expression }) => (await import('/assets/' + chunk)).setLive2DExpression(expression), { chunk, expression });
      }
    }
    const data = await page.evaluate(() => window.desktop.api('/api/bootstrap'));
    for (const appearance of data.appearances) {
      await page.evaluate((id) => window.desktop.command({ type: 'appearance', value: id }), appearance.id);
      await page.waitForFunction((id) => document.querySelector('.avatar-viewport')?.getAttribute('data-appearance') === id, appearance.id);
      assert((await pixels(page)).visible > 500, `${role.name}: ${appearance.framing} blank`);
      await page.screenshot({ path: path.join(directory, `${index}-${appearance.framing}.png`) });
    }
    report.renders.push({ name: role.name, panel: before.visible, overlay: overlayPixels.visible, beforeHash: before.hash, movingHash: moved.hash });
    report.checks.push(`${role.name}: panel/overlay nonblank, animated, gaze/mouth API, full/half/mini switching`);
  }
  await page.getByRole('button', { name: translate('角色库', language), exact: true }).click();
  assert.equal(await page.locator('.role-item').count(), 2);
  await page.screenshot({ path: path.join(directory, 'role-library.png') });
  await page.getByLabel(translate('当前角色', language), { exact: true }).selectOption(state.roles[0].id);
  await page.getByRole('button', { name: translate('陪伴', language), exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.avatar-viewport canvas') && !document.querySelector('.avatar-loading'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(directory, 'narrow-panel.png'), fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert((await pixels(page)).visible > 500);
  report.checks.push('390px panel remains nonblank without horizontal overflow');
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.failedRequests, []);
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  if (app) await app.close();
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, directory }, null, 2));
}
