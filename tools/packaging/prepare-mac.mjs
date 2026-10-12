import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
process.chdir(root);
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('This build profile requires an Apple Silicon Mac.');
const stage = path.join(root, 'build/staging');
const licenses = path.join(stage, 'licenses');
fs.mkdirSync(licenses, { recursive: true });
function run(command, args, env = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`${command} failed (${result.status})`);
}
function copy(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}

const iconset = path.join(root, 'build/app.iconset');
fs.mkdirSync(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) run('sips', ['-z', String(size * scale), String(size * scale),
    'apps/desktop/renderer/public/brand/app-icon.png', '--out', path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)]);
}
run('iconutil', ['-c', 'icns', iconset, '-o', 'build/packaging/app.icns']);
copy('LICENSE', path.join(licenses, 'PROJECT-LICENSE'));
copy('LICENSES/Apache-2.0.txt', path.join(licenses, 'Apache-2.0.txt'));
copy('NOTICE.md', path.join(licenses, 'PROJECT-NOTICE.md'));
copy('LICENSE-Live2D.md', path.join(licenses, 'LICENSE-Live2D.md'));
copy('apps/desktop/THIRD_PARTY_NOTICES.md', path.join(licenses, 'THIRD_PARTY_NOTICES.md'));
for (const name of ['NOTICE.md', 'SAMPLES_LICENSE.md', 'framework/LICENSE.md', 'core/LICENSE.md']) copy(path.join('apps/desktop/renderer/src/live2d', name), path.join(licenses, 'live2d', name));

const dependencies = JSON.parse(fs.readFileSync('package-lock.json', 'utf8')).packages;
const inventory = [];
for (const [directory, info] of Object.entries(dependencies)) {
  if (!directory.startsWith('node_modules/') || info.dev) continue;
  inventory.push({ package: directory.slice('node_modules/'.length), version: info.version, license: info.license || 'see upstream' });
  if (!fs.existsSync(directory)) continue;
  for (const file of fs.readdirSync(directory)) if (/^(license|licence|copying|notice)(\.|$)/i.test(file) && fs.statSync(path.join(directory, file)).isFile()) copy(path.join(directory, file), path.join(licenses, 'node', directory.slice(13).replaceAll('/', '__'), file));
}
fs.writeFileSync(path.join(licenses, 'node-inventory.json'), JSON.stringify(inventory, null, 2));
const hook = 'node_modules/uiohook-napi';
for (const file of ['src', 'libuiohook', 'binding.gyp', 'package.json', 'LICENSE', 'README.md']) copy(path.join(hook, file), path.join(licenses, 'native-source/uiohook-napi', file));
fs.writeFileSync(path.join(licenses, 'native-source/uiohook-napi/BUILD-NOTES.txt'),
  'Installed uiohook-napi 1.5.5 sources and binding.gyp accompany the native addon. To rebuild: npm install --ignore-scripts; npm install --save-dev node-gyp; npx node-gyp rebuild. Replace prebuilds/darwin-arm64/uiohook-napi.node with build/Release/uiohook_napi.node and rebuild the app. Exact upstream source provenance and public redistribution compliance still require release review.\n');

const speech = path.join(stage, 'speech');
const asrName = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';
const ttsName = 'kokoro-multi-lang-v1_1';
const manifest = [];
// Explicit weights only: no personal characters, recordings, profiles or database.
for (const [name, files] of [[asrName, ['model.int8.onnx', 'tokens.txt', 'LICENSE', 'README.md']],
                            [ttsName, ['model.onnx', 'voices.bin', 'tokens.txt', 'espeak-ng-data', 'dict', 'lexicon-us-en.txt', 'lexicon-zh.txt', 'date-zh.fst', 'number-zh.fst', 'LICENSE', 'README.md']]]) {
  for (const file of files) {
    const source = path.join('resources/speech', name, file);
    if (!fs.existsSync(source)) throw Error(`Missing required voice resource: ${source}. Run npm run setup:speech first.`);
    copy(source, path.join(speech, name, file));
    if (fs.statSync(source).isFile()) manifest.push({ model: name, file, bytes: fs.statSync(source).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex') });
  }
}
fs.writeFileSync(path.join(licenses, 'model-manifest.json'), JSON.stringify(manifest, null, 2));
copy('docs/release/MAC-INSTALL.md', path.join(licenses, 'MAC-INSTALL.md'));
run('.venv/bin/python', ['tools/packaging/python-notices.py', licenses]);
run('.venv/bin/python', ['-m', 'PyInstaller', '--noconfirm', '--clean', '--distpath', 'build/staging', '--workpath', 'build/pyinstaller', 'tools/packaging/companion.spec'], {
  PYTHONPATH: path.join(root, 'services/companion'), PYINSTALLER_CONFIG_DIR: path.join(root, 'build/pyinstaller/cache'),
});
