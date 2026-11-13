import fs from 'node:fs';
import path from 'node:path';

// mkdir serializes shared read-modify-write operations; recover locks left by a dead writer.
export const withLock = (file, fn) => {
  const lock = `${file}.lock`, until = Date.now() + 10000;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30000) { fs.rmdirSync(lock); continue; } } catch {}
      if (Date.now() > until) throw new Error(`lock busy: ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch {} }
};

export const writeJson = (file, value, space) => {
  const tmp = `${file}.${process.pid}`;
  try { fs.writeFileSync(tmp, JSON.stringify(value, null, space)); fs.renameSync(tmp, file); }
  finally { try { fs.unlinkSync(tmp); } catch {} }
};
