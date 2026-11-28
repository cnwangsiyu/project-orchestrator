// mini2 has an unencrypted disk. Only explicitly listed source files can cross.
import fs from 'node:fs';
import path from 'node:path';
import { readBatch } from './devbox-transfer-check.mjs';

const sourceExtension = /\.(?:[cm]?[jt]sx?|swift|m{1,2}|[ch](?:pp|xx)?|cc|hh|py|rb|go|rs|java|kts?|sh|bash|zsh|php|cs|scala|vue|svelte)$/i;

export function safeSourcePath(name) {
  if (typeof name !== 'string' || !name || /[\x00-\x1f\x7f\\]/.test(name)
      || /^(?:\/|[a-z]:)/i.test(name)) return false;
  return name.split('/').every(part => part && part !== '.' && part !== '..'
    && !/^(?:\.env.*|\.netrc|\.pypirc|\.ssh|\.aws|\.kube|\.docker|\.git|id_rsa.*|id_ed25519.*)$/i.test(part)
    && !/\.local\.(?:plist|json|xcconfig|ya?ml|toml|ini)$/i.test(part)
    && !/\.(?:pem|p12|pfx|jks|key|keystore|mobileprovision|provisionprofile|p8|cer|der|keychain.*)$/i.test(part)
    && (!/private.*key/i.test(part) || sourceExtension.test(part)));
}

const contentRules = [
  ['private-key-block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['npm-credential', /^[ \t]*(?:_auth(?:Token)?|\/\/[^\r\n]*?:(?:_auth(?:Token)?|_password))[ \t]*=/im],
  ['aws-access-key-id', /AKIA[0-9A-Z]{16}/],
  ['slack-token', /xox[baprs]-/],
  ['github-token', /gh[pousr]_[A-Za-z0-9]{30,}/],
  ['credential-assignment', /(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*['"][^'"\s]{12,}['"]/i],
];

export function checkSourceContent(name, bytes) {
  const text = bytes.toString('utf8');
  for (const [id, pattern] of contentRules) {
    if (pattern.test(text)) throw Error('mini2 source content refused: ' + JSON.stringify(name) + ' (' + id + ')');
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
    if (mode !== '000000' && !blobs.has(oid)) blobs.set(oid, name);
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
