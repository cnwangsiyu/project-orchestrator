// Regression for BC-145: waiters outlast a slow holder; a dead holder's lock is recovered.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const src = fs.readFileSync(fileURLToPath(new URL('../devbox-run.mjs', import.meta.url)), 'utf8');
const body = /async function withStateLock[\s\S]*?\n}\n/.exec(src)[0];
const pause = ms => new Promise(r => setTimeout(r, ms));
const withStateLock = new Function('fs', 'path', 'pause', body + '; return withStateLock;')(fs, path, pause);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-')), file = path.join(dir, 'h.json');
let order = [];
await Promise.all([1,2,3,4,5].map(i => withStateLock(file, async () => { order.push('in' + i); await pause(400); order.push('out' + i); }, 24000)));
for (let i = 0; i < order.length; i += 2) assert.equal(order[i].slice(2), order[i+1].slice(3), 'critical sections do not interleave');
fs.mkdirSync(file + '.lock'); fs.writeFileSync(path.join(file + '.lock', 'owner'), '999999');
assert.equal(await withStateLock(file, async () => 'recovered'), 'recovered');
assert.ok(!fs.existsSync(file + '.lock'));
fs.mkdirSync(file + '.lock'); fs.writeFileSync(path.join(file + '.lock', 'owner'), String(process.pid));
await assert.rejects(withStateLock(file, async () => 1, 3), /state lock busy/);
fs.rmSync(dir, { recursive: true }); console.log('PASS state lock waits, recovers dead holders, reports busy holders');
