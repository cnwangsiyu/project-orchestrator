// mini2 has an unencrypted disk. Only explicitly listed source files can cross.
import fs from 'node:fs';
import path from 'node:path';
import { readBatch } from './devbox-transfer-check.mjs';

const sourceExtension = /\.(?:[cm]?[jt]sx?|swift|m{1,2}|[ch](?:pp|xx)?|cc|hh|py|rb|go|rs|java|kts?|sh|bash|zsh|php|cs|scala|vue|svelte)$/i;

const sensitiveName = /session|sso|auth|tokens?|keys?|credentials?|cookies?|secret|password|passwd|signing|keystore|keychain/i;
const reviewableExtension = /\.(?:md|json|ya?ml|plist|xcconfig)$/i;
const privateKeyBlock = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

export function safeSourcePath(name) {
  if (typeof name !== 'string' || !name || /[\x00-\x1f\x7f\\]/.test(name)
      || /^(?:\/|[a-z]:)/i.test(name)) return false;
  const filename = path.posix.basename(name);
  if (/cookie/i.test(filename) || /^(?:\.git-credentials|credentials|\.pgpass)$/i.test(filename)) return false;
  if (/private.*key/i.test(filename) && !sourceExtension.test(filename)) return false;
  if (sensitiveName.test(filename) && !sourceExtension.test(filename) && !reviewableExtension.test(filename)) return false;
  return name.split('/').every(part => part && part !== '.' && part !== '..'
    && !/^(?:\.env.*|\.netrc|\.pypirc|\.ssh|\.aws|\.kube|\.docker|\.git|id_rsa.*|id_ed25519.*)$/i.test(part)
    && !/\.local\.(?:plist|json|xcconfig|ya?ml|toml|ini)$/i.test(part)
    && !/\.(?:pem|p12|pfx|jks|key|keystore|mobileprovision|provisionprofile|p8|cer|der|keychain.*)$/i.test(part));
}

const contentRules = [
  ['private-key-block', privateKeyBlock],
  ['npm-credential', /^[ \t]*(?:_auth(?:Token)?|\/\/[^\r\n]*?:(?:_auth(?:Token)?|_password))[ \t]*=/im],
  ['aws-access-key-id', /AKIA[0-9A-Z]{16}/],
  ['slack-token', /xox[baprs]-/],
  ['github-token', /gh[pousr]_[A-Za-z0-9]{30,}/],
  ['credential-assignment', /(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*['"][^'"\s]{12,}['"]/i],
  ['jwt', /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['bearer-authorization', /Authorization:\s*Bearer\s+[A-Za-z0-9._~+/-]{16,}/i],
  ['url-credentials', /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]{6,}@/i],
  ['structured-credential', /"?(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)"?\s*:\s*"?[^\s"]{12,}/i],
];

export function checkSourceContent(name, bytes) {
  const refuse = id => { throw Error('mini2 source content refused: ' + JSON.stringify(name) + ' (' + id + ')'); };
  if (sensitiveName.test(path.posix.basename(name))) {
    const sample = bytes.subarray(0, 8192);
    let nuls = 0;
    for (const byte of sample) if (byte === 0) nuls++;
    if (nuls > sample.length / 10) refuse('binary-sensitive-name');
  }
  const text = bytes.toString('utf8');
  for (const [id, pattern] of contentRules) if (pattern.test(text)) refuse(id);
  for (const [encoded] of text.matchAll(/[A-Za-z0-9+/]{36,}={0,2}/g)) {
    if (privateKeyBlock.test(Buffer.from(encoded, 'base64').toString('latin1'))) refuse('base64-private-key-block');
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
