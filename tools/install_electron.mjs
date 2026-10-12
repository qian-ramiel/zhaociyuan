import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extract } = require('@electron-internal/extract-zip');
const moduleRoot = path.resolve('node_modules/electron');
const metadata = JSON.parse(await fs.readFile(path.join(moduleRoot, 'package.json'), 'utf8'));
const checksums = JSON.parse(await fs.readFile(path.join(moduleRoot, 'checksums.json'), 'utf8'));
const archive = process.argv[2];
if (!archive || process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Provide the official darwin-arm64 Electron ZIP path.');
const filename = `electron-v${metadata.version}-darwin-arm64.zip`;
const digest = createHash('sha256').update(await fs.readFile(archive)).digest('hex');
if (digest !== checksums[filename]) throw new Error('Official Electron checksum mismatch; installation aborted.');
await extract(archive, { dir: path.join(moduleRoot, 'dist') });
await fs.writeFile(path.join(moduleRoot, 'path.txt'), 'Electron.app/Contents/MacOS/Electron');
console.log(`Electron ${metadata.version} installed; official SHA-256 verified.`);
