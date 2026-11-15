// Simulate a restricted worker's denied shared writes in a separate real process.
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(process.env.TALKBACK_DENY_SHARED);
const denied = (file) => {
  if (typeof file !== 'string') return false;
  const rel = path.relative(root, path.resolve(file));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};
const error = () => { const e = Error('fixture sandbox denies shared writes'); e.code = process.env.TALKBACK_DENY_CODE ?? 'EACCES'; throw e; };
for (const key of ['mkdirSync', 'writeFileSync', 'appendFileSync', 'renameSync']) {
  const original = fs[key];
  fs[key] = (file, ...args) => { if (denied(file)) error(); return original.call(fs, file, ...args); };
}
const open = fs.openSync;
fs.openSync = (file, flags, ...args) => {
  if (denied(file) && (typeof flags === 'string' ? /[wa+]/.test(flags) : flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT))) error();
  return open.call(fs, file, flags, ...args);
};
