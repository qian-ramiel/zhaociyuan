const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('both built-in runtimes are complete, hash-pinned and publishable', async () => {
  const { bundledCharacterFiles, builtinPrefix } = await import('../../tools/builtin-characters.mjs');
  const { inspectCandidate } = await import('../../tools/check-publish.mjs');
  const root = path.resolve(__dirname, '../..');
  const files = bundledCharacterFiles(root);
  assert.equal(files.length, 47);
  assert(files.includes('mao/runtime/mao_pro.model3.json'));
  assert(files.includes('hiyori/runtime/hiyori_pro_t11.model3.json'));
  for (const file of files) assert.deepEqual(inspectCandidate(builtinPrefix + file, fs.readFileSync(path.join(root, builtinPrefix, file))), [], file);
  assert(!files.some((file) => /\.(?:cmo3|can3|wav|mp3|zip)$/.test(file)));
});

test('allowlist rejects unreviewed models, tampered data and unsafe paths', async () => {
  const { validBuiltinPath } = await import('../../tools/builtin-characters.mjs');
  const { inspectCandidate } = await import('../../tools/check-publish.mjs');
  for (const file of ['resources/characters/private/runtime/model.moc3',
    'resources/builtin-characters/other/runtime/model.moc3',
    'resources/builtin-characters/mao/runtime/mao_pro.moc3']) {
    assert(inspectCandidate(file, Buffer.from('not the pinned model')).length > 0);
  }
  assert.equal(validBuiltinPath('mao/runtime/../../private.moc3'), false);
  assert.equal(validBuiltinPath('hiyori/runtime/model.moc3'), true);
});

test('packaging stages exactly the public resource allowlist', async () => {
  const { stageBuiltinCharacters, bundledCharacterFiles } = await import('../../tools/builtin-characters.mjs');
  const root = path.resolve(__dirname, '../..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zhaociyuan-characters-'));
  try {
    const files = stageBuiltinCharacters(root, temporary);
    assert.deepEqual(files, bundledCharacterFiles(root));
    for (const file of files) assert.equal(fs.statSync(path.join(temporary, file)).size, fs.statSync(path.join(root, 'resources/builtin-characters', file)).size);
    const pkg = require('../../package.json');
    assert.equal(pkg.build.extraResources.find((entry) => entry.to === 'builtin-characters').from, 'build/staging/builtin-characters');
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
