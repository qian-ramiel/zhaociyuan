import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gitBinary = process.platform === 'darwin' && fs.existsSync('/usr/bin/git') ? '/usr/bin/git' : 'git';
const approvedDocs = new Set([
  'docs/DEVELOPMENT.md', 'docs/PRIVACY.md', 'docs/LICENSING.md', 'docs/ROADMAP.md',
  'docs/release/MAC-INSTALL.md', 'docs/brand/zhaociyuan/兆次元-logo-选定版.png',
]);
const binaryExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.ico', '.icns']);
const credentialPatterns = [
  ['provider-key', /\bsk-[A-Za-z0-9_-]{20,}/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ['aws-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['credential-assignment', /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*["']?\s*[:=]\s*["']([A-Za-z0-9_+/.=-]{24,})["']/gi],
];

export function inspectCandidate(file, content, mode = '100644') {
  const findings = [];
  const add = (rule, line = 1) => findings.push({ file, line, rule });
  if (mode === '120000') add('symlink-needs-review');
  if (/^(?:archive|releases|node_modules|\.venv|\.codex|\.aws|\.agents)\//.test(file)
      || /^build\/(?:staging|pyinstaller)\//.test(file)
      || /(?:^|\/)(?:__pycache__|\.pytest_cache|dist)\//.test(file)
      || (/^(?:runtime|resources)\//.test(file) && !file.endsWith('/.gitkeep'))
      || (file.startsWith('docs/') && !approvedDocs.has(file))) add('private-or-generated-path');
  if (/(?:^|\/)(?:\.env(?:\..*)?|secrets\.json)$/.test(file) && !file.endsWith('.env.example')) add('secret-file');
  if (/\.(?:db(?:-.*)?|sqlite3?|pem|key|p12|pfx|dmg|onnx|bin|moc3|zip|rar|wav|mp3|webm|mobileprovision)$/i.test(file)) add('private-binary-or-data');
  if (content.length > 10 * 1024 * 1024) add('large-file-needs-review');
  if (binaryExtensions.has(path.extname(file).toLowerCase())) return findings;
  if (content.includes(0)) {
    add('unexpected-binary');
    return findings;
  }
  const text = content.toString('utf8');
  for (const [rule, pattern] of credentialPatterns) {
    for (const match of text.matchAll(pattern)) {
      if (rule === 'credential-assignment' && /^(?:YOUR_|REPLACE_|EXAMPLE_|x+$)/i.test(match[1])) continue;
      add(rule, text.slice(0, match.index).split('\n').length);
    }
  }
  for (const match of text.matchAll(/\/Users\/([A-Za-z0-9._-]+)/g)) {
    if (!['example', 'test', 'fixture', 'USERNAME'].includes(match[1])) add('personal-home-path', text.slice(0, match.index).split('\n').length);
  }
  return findings;
}

function git(args, options = {}) {
  return execFileSync(gitBinary, args, { cwd: root, maxBuffer: 32 * 1024 * 1024, ...options });
}

export function checkCandidates(staged = false) {
  const entries = git(['ls-files', '--stage', '-z']).toString('utf8').split('\0').filter(Boolean);
  const indexed = new Map(entries.map(entry => {
    const [metadata, file] = entry.split('\t');
    const [mode, sha, stage] = metadata.split(' ');
    if (stage !== '0') throw Error('Resolve conflicted files before publishing.');
    return [file, { mode, sha }];
  }));
  const candidates = new Set(indexed.keys());
  if (!staged) for (const file of git(['ls-files', '--others', '--exclude-standard', '-z']).toString('utf8').split('\0').filter(Boolean)) candidates.add(file);
  const findings = [];
  for (const file of candidates) {
    const entry = indexed.get(file);
    const untrackedLink = !entry && fs.lstatSync(path.join(root, file)).isSymbolicLink();
    // Inspect index blobs, not just working copies, so staged secrets cannot hide.
    const content = entry ? git(['cat-file', 'blob', entry.sha]) : untrackedLink ? Buffer.from(fs.readlinkSync(path.join(root, file))) : fs.readFileSync(path.join(root, file));
    findings.push(...inspectCandidate(file, content, untrackedLink ? '120000' : entry?.mode));
  }
  return { files: candidates.size, findings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkCandidates(process.argv.includes('--staged'));
  // Report locations only; never echo suspected credentials.
  for (const item of result.findings) console.error(`${item.file}:${item.line}: ${item.rule}`);
  console.log(`Publish check: ${result.files} candidate files, ${result.findings.length} findings. Binary images require human review.`);
  process.exitCode = result.findings.length ? 1 : 0;
}
