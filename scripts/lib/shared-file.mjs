import fs from 'node:fs';
import path from 'node:path';

// mkdir serializes shared read-modify-write operations; recover locks left by a dead writer.
export const acquireLock = (file, { timeoutMs = 10000, retryMs = 100, ownerPid = false } = {}) => {
  const lock = `${file}.lock`, until = Date.now() + timeoutMs;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 30000) {
          let alive = false;
          if (ownerPid) {
            const pid = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8'));
            if (Number.isSafeInteger(pid) && pid > 0) try { process.kill(pid, 0); alive = true; } catch (error) { alive = error.code === 'EPERM'; }
          }
          if (!alive) {
            if (ownerPid) fs.rmSync(path.join(lock, 'pid'), { force: true });
            fs.rmdirSync(lock); continue;
          }
        }
      } catch (error) {
        if (ownerPid && error.code === 'ENOENT') {
          try { if (Date.now() - fs.statSync(lock).mtimeMs > 30000) { fs.rmdirSync(lock); continue; } } catch {}
        }
      }
      if (Date.now() >= until) return null;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(retryMs, until - Date.now()));
    }
  }
  if (ownerPid) {
    try { fs.writeFileSync(path.join(lock, 'pid'), String(process.pid)); }
    catch (error) { try { fs.rmdirSync(lock); } catch {} throw error; }
  }
  return () => { try { if (ownerPid) fs.unlinkSync(path.join(lock, 'pid')); fs.rmdirSync(lock); } catch {} };
};
export const withLock = (file, fn, options) => {
  const release = acquireLock(file, options);
  if (!release) throw new Error(`lock busy: ${file}.lock`);
  try { return fn(); } finally { release(); }
};

export const writeJson = (file, value, space) => {
  const tmp = `${file}.${process.pid}`;
  try { fs.writeFileSync(tmp, JSON.stringify(value, null, space)); fs.renameSync(tmp, file); }
  finally { try { fs.unlinkSync(tmp); } catch {} }
};
