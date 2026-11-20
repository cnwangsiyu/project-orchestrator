// mini2 has an unencrypted disk. Only explicitly listed source files can cross.
import fs from 'node:fs';
import path from 'node:path';
export function safeSourcePath(name) {
  if (typeof name !== 'string' || !name || name.startsWith('/') || /[\x00-\x1f\\]/.test(name)
      || name.split('/').some(part => !part || part === '.' || part === '..')) return false;
  if (/(?:^|\/)(?:\.env(?:\..*)?|\.netrc|\.pypirc|\.npmrc|\.ssh|\.aws|\.kube|\.docker|\.git)(?:\/|$)/i.test(name)) return false;
  if (/(?:signing|keystore|keychain|password|passwd|secret|tokens?(?=[\/_.-]|$)|credential|session|cookie|sso|private.?key|api.?key|access.?key|id_rsa|id_ed25519)/i.test(name)) return false;
  if (/\.local\.(?:plist|json|xcconfig|ya?ml|toml|ini)$/i.test(name)) return false;
  if (/(?:^|[\/_.-])(?:keys?|auth)(?:[\/_.-]|$)|\.(?:pem|p12|pfx|jks|mobileprovision|provisionprofile)$/i.test(name)) return false;
  return true;
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
