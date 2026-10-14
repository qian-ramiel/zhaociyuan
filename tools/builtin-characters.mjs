import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const builtinPrefix = 'resources/builtin-characters/';
export const builtinMetadata = new Set(['catalog.json', 'manifest.json', 'NOTICE.md',
  'licenses/free-material-license.html', 'licenses/sample-model-terms.html']);
const runtimePath = /^(mao|hiyori)\/(?:ReadMe\.txt|preview\.png|runtime\/[A-Za-z0-9_./-]+\.(?:json|png|moc3))$/;

export function validBuiltinPath(relative) {
  return runtimePath.test(relative) && !relative.split('/').includes('..');
}

export function approvedBuiltinRuntime(file, content, root) {
  if (!file.startsWith(builtinPrefix)) return false;
  const relative = file.slice(builtinPrefix.length);
  if (!validBuiltinPath(relative)) return false;
  const manifest = JSON.parse(fs.readFileSync(path.join(root, builtinPrefix, 'manifest.json'), 'utf8'));
  const entry = manifest.files.find((item) => item.path === relative);
  return entry?.bytes === content.length && entry.sha256 === crypto.createHash('sha256').update(content).digest('hex');
}

export function bundledCharacterFiles(root) {
  const source = path.join(root, builtinPrefix);
  const catalog = JSON.parse(fs.readFileSync(path.join(source, 'catalog.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
  if (catalog.schemaVersion !== 1 || manifest.schemaVersion !== 1 ||
      catalog.models.map((model) => model.id).join(',') !== 'mao,hiyori') throw Error('Unexpected built-in character catalog');
  const files = [...builtinMetadata, ...manifest.files.map((entry) => entry.path)];
  if (new Set(files).size !== files.length) throw Error('Duplicate built-in character file');
  for (const relative of files) {
    if (!builtinMetadata.has(relative) && !validBuiltinPath(relative)) throw Error('Unsafe built-in character path');
    const file = path.join(source, relative);
    if (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile() || !fs.realpathSync(file).startsWith(fs.realpathSync(source) + path.sep)) throw Error('Invalid built-in character file');
    if (!builtinMetadata.has(relative) && !approvedBuiltinRuntime(builtinPrefix + relative, fs.readFileSync(file), root)) throw Error(`Built-in character checksum mismatch: ${relative}`);
  }
  for (const model of catalog.models) {
    if (!files.includes(model.id + '/' + model.model) || !files.includes(model.id + '/ReadMe.txt')) throw Error('Incomplete built-in character model');
  }
  return files;
}

export function stageBuiltinCharacters(root, destination) {
  const files = bundledCharacterFiles(root);
  for (const relative of files) {
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, builtinPrefix, relative), target);
  }
  return files;
}
