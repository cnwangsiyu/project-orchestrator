import fs from 'node:fs';
import path from 'node:path';
import { withLock, writeJson } from './shared-file.mjs';

const queueFile = (home) => path.join(home, 'queue-status.json');
export const saveQueue = (home, threadId, q) => {
  try {
    const file = queueFile(home);
    withLock(file, () => {
      let rows = {}; try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      rows[threadId] = q;
      writeJson(file, Object.fromEntries(Object.entries(rows).slice(-200)));
    });
  } catch {}
};
export const readQueue = (home, threadId) => {
  try { return JSON.parse(fs.readFileSync(queueFile(home), 'utf8'))[threadId] ?? null; } catch { return null; }
};
