// mini2 has an unencrypted disk. Only explicitly listed source files can cross.
import fs from 'node:fs';
import path from 'node:path';
import { readBatch } from './devbox-transfer-check.mjs';

const sourceExtension = /\.(?:[cm]?[jt]sx?|swift|m{1,2}|[ch](?:pp|xx)?|cc|hh|py|rb|go|rs|java|kts?|sh|bash|zsh|php|cs|scala|vue|svelte)$/i;

const sensitiveName = /session|sso|o?auth(?!or|ori|ent|ic)|tokens?|keys?|credentials?|cookies?|secret|password|passwd|signing|keystore|keychain/i;
// Text formats that may sit under a sensitive name only after the content scan (which covers cookie jars and session/token values).
const scannedTextExtension = /\.(?:md|json)$/i;
const privateKeyBlock = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

export function safeSourcePath(name) {
  if (typeof name !== 'string' || !name || /[\x00-\x1f\x7f\\]/.test(name)
      || /^(?:\/|[a-z]:)/i.test(name)) return false;
  const filename = path.posix.basename(name);
  if (/cookie/i.test(filename) || /^(?:\.git-credentials|credentials|\.pgpass)$/i.test(filename)) return false;
  if (/private.*key/i.test(filename) && !sourceExtension.test(filename)) return false;
  // A sensitive word anywhere in the path (directory or file name) is allowed only for source-code files and
  // .md/.json text, all content-scanned. Other data/config under such names, HAR files and anything inside an
  // `auth`/`.auth` directory (Playwright storage state) never cross.
  if (name.split('/').some(part => sensitiveName.test(part)) && !sourceExtension.test(filename)
      && !(scannedTextExtension.test(filename) && !/\.har\.json$/i.test(filename) && !name.split('/').some(part => /^\.?auth$/i.test(part)))) return false;
  return name.split('/').every(part => part && part !== '.' && part !== '..'
    && !/^(?:\.env.*|\.netrc|\.pypirc|\.ssh|\.aws|\.kube|\.docker|\.git|id_rsa.*|id_ed25519.*)$/i.test(part)
    && !/\.local\.(?:plist|json|xcconfig|ya?ml|toml|ini)$/i.test(part)
    && !/\.(?:pem|p12|pfx|jks|key|keystore|mobileprovision|provisionprofile|p8|cer|der|keychain.*)$/i.test(part));
}

// Obvious placeholders (example configs, docs, fixtures) and file paths are not secrets.
const notPlaceholder = '(?!/|\\$|<|\\{|(?:replace|change|example|your|dummy|placeholder|fake|fixture|test|sample|redacted|xxx|password|secret)[^\\s]*)';
// High-confidence secret formats: applied to every uploaded blob.
const contentRules = [
  ['private-key-block', privateKeyBlock],
  ['npm-credential', /^[ \t]*(?:_auth(?:Token)?|\/\/[^\r\n]*?:(?:_auth(?:Token)?|_password))[ \t]*=/im],
  ['aws-access-key-id', /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/],
  ['slack-token', /xox[baprs]-/],
  ['github-token', /gh[pousr]_[A-Za-z0-9]{30,}/],
  ['jwt', /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['bearer-authorization', /Authorization:\s*Bearer\s+[A-Za-z0-9._~+/-]{16,}/i],
  ['url-credentials', new RegExp('[a-z][a-z0-9+.-]*://[^/\\s:@$]+:' + notPlaceholder + '[^/\\s@${}]{6,}@', 'i')],
];
// Generic heuristics: applied to non-source files (docs, JSON, config, data), where captured login state lives.
// Source code is exempt because test fixtures routinely contain fake values of these shapes.
const dataRules = [
  ['credential-assignment', new RegExp('(?:password|passwd|secret|api[_-]?key|access[_-]?token)\\s*[:=]\\s*[\'"]' + notPlaceholder + '[^\'"\\s]{12,}[\'"]', 'i')],
  ['structured-credential', new RegExp('"?(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)"?\\s*:\\s*"?' + notPlaceholder + '[^\\s"]{12,}', 'i')],
  ['env-secret-assignment', new RegExp('(?:^|[\\s;])(?:export\\s+)?[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY)(?!_FILE|_PATH)[A-Z0-9_]*\\s*=\\s*' + notPlaceholder + '[^\\s\'"$]{12,}', 'm')],
  ['curl-user-credentials', /\bcurl\b[^\n]*\s-u\s*[^\s:]+:[^\s]{6,}/],
  ['cookie-jar-json', /"cookies"\s*:\s*\[/],
  ['session-token-value', new RegExp('"?(?:token|session(?:[_-]?id)?|sid|cookie)"?\\s*[:=]\\s*"?' + notPlaceholder + '[A-Za-z0-9._~+/=-]{20,}', 'i')],
  ['bearer-value', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/],
];

export function checkSourceContent(name, bytes) {
  const refuse = id => { throw Error('mini2 source content refused: ' + JSON.stringify(name) + ' (' + id + ')'); };
  const sample = bytes.subarray(0, 8192);
  let nuls = 0;
  for (const byte of sample) if (byte === 0) nuls++;
  // Binary blobs (models, images): only key blocks are meaningful; random bytes would trip text heuristics.
  const binary = nuls > 0;
  const rules = binary ? [contentRules[0]] : sourceExtension.test(path.posix.basename(name)) ? contentRules : [...contentRules, ...dataRules];
  const scan = (text, active, base64 = true) => {
    for (const [id, pattern] of active) if (pattern.test(text)) refuse(id);
    if (base64) for (const [encoded] of text.matchAll(/[A-Za-z0-9+/]{36,}={0,2}/g)) {
      for (let offset = 0; offset < 4; offset++) {
        if (privateKeyBlock.test(Buffer.from(encoded.slice(offset), 'base64').toString('latin1'))) refuse('base64-private-key-block');
      }
    }
  };
  scan(bytes.toString(binary ? 'latin1' : 'utf8'), rules, !binary);
  // UTF-16 text (any name): many NUL bytes. Decode both byte orders and scan with every rule.
  if (nuls > sample.length / 10) {
    // Binary content under a sensitive name (session.ts, auth.json, ...) could be a cookie/credential store.
    if (name.split('/').some(part => sensitiveName.test(part))) refuse('binary-sensitive-name');
    const all = [...contentRules, ...dataRules];
    scan(bytes.toString('utf16le'), all);
    if (bytes.length > 1) scan(Buffer.from(bytes.subarray(1)).toString('utf16le'), all);
  }
}

export function checkAllowlist(allowed, entries, history, untracked = []) {
  if (!Array.isArray(allowed) || !allowed.length || new Set(allowed).size !== allowed.length || allowed.some(name => !safeSourcePath(name)))
    throw Error('mini2 requires an exact, non-sensitive source allowlist');
  const names = new Set(allowed);
  for (const { name, mode } of entries) {
    if (!names.has(name) || !safeSourcePath(name) || !['100644','100755'].includes(mode))
      throw Error('mini2 source path is outside the regular-file allowlist: ' + name);
  }
  for (const name of [...history, ...untracked]) {
    if (!names.has(name) || !safeSourcePath(name)) throw Error('mini2 history/worktree path is outside the allowlist: ' + name);
  }
  if (untracked.length) throw Error('mini2 requires tracked sources; untracked uploads are disabled');
}

export function checkWorktree(repo, names) {
  for (const name of names) {
    if (!safeSourcePath(name)) throw Error('mini2 worktree path refused');
    const file=path.join(repo,name);
    try {
      const info=fs.lstatSync(file);
      if (!info.isFile() || fs.realpathSync(file)!==file) throw Error('mini2 worktree must contain regular source files');
    } catch (error) {
      if (error.code!=='ENOENT') throw error; // Tracked deletions are valid patches.
    }
  }
}

// Read history from the finished bundle and apply the finished patch to its
// index. This checks what the remote will receive, including binary changes.
export async function checkUploads({ allowed, bundle, patchFile, commit, temp, execute, state }) {
  const repo = path.join(temp, 'verify.git');
  const git = async args => {
    const result = await execute('git', args, { state, timeout: 300000 });
    if (result.code) throw Error('mini2 upload verification failed: git ' + args[0]);
    return result.stdout;
  };
  await git(['clone', '--bare', '--branch', 'export', '--', bundle, repo]);
  const inRepo = args => git(['-C', repo, ...args]);
  if ((await inRepo(['rev-parse', 'HEAD'])).trim() !== commit) throw Error('mini2 bundle commit mismatch');

  checkAllowlist(allowed, [], []);
  const names = new Set(allowed);
  const blobs = new Map();
  const add = (name, mode, oid) => {
    if (!names.has(name) || !['000000', '100644', '100755'].includes(mode))
      throw Error('mini2 upload path is outside the regular-file allowlist: ' + JSON.stringify(name));
    // A shared blob must still be checked under a sensitive basename.
    if (mode !== '000000' && (!blobs.has(oid) || sensitiveName.test(path.posix.basename(name)))) blobs.set(oid, name);
  };
  const changes = (await inRepo(['log', '--full-history', '-m', '--root', '--format=', '--raw',
    '-z', '--no-renames', '--no-abbrev', commit])).split('\0');
  for (let i = 0; i < changes.length - 1; i += 2) {
    const [, mode, , oid] = changes[i].trim().split(/\s+/);
    add(changes[i + 1], mode, oid);
  }

  if (patchFile && fs.statSync(patchFile).size) {
    await inRepo(['read-tree', commit]);
    await inRepo(['apply', '--cached', '--binary', patchFile]);
    const index = (await inRepo(['ls-files', '--stage', '-z'])).split('\0').filter(Boolean);
    for (const record of index) {
      const tab = record.indexOf('\t');
      const [mode, oid] = record.slice(0, tab).split(' ');
      add(record.slice(tab + 1), mode, oid);
    }
  }
  await readBatch(repo, [...blobs.keys()], (oid, bytes) => checkSourceContent(blobs.get(oid), bytes), state);
}
