import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostRoot } from '../devbox-run.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-probe-'));
const oldEnv = { PATH: process.env.PATH, DEVBOX_CACHE_DIR: process.env.DEVBOX_CACHE_DIR };
const state = { children: new Set(), values: [] };
const row = { host: '192.0.2.64', user: 'fixture', target: 'fixture@192.0.2.64' };
const cacheFile = path.join(root, 'devbox-hosts.json');
const cached = { root: '/fixture/devbox-run', user: row.user, cores: 64, freeGiB: 271,
  probedAt: new Date(Date.now()-90000000).toISOString() };
try {
  process.env.DEVBOX_CACHE_DIR = root;
  process.env.PATH = root + path.delimiter + process.env.PATH;
  fs.writeFileSync(path.join(root, 'ssh'), `#!${process.execPath}
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(path.join(root, 'calls'))}, 'probe\\n');
if (fs.existsSync(${JSON.stringify(path.join(root, 'fail'))})) process.exit(1);
console.log(JSON.stringify({root:'/fixture/devbox-run',user:'fixture',cores:64,freeGiB:500,probedAt:new Date().toISOString()}));
`, { mode: 0o755 });
  fs.writeFileSync(cacheFile, JSON.stringify({ [row.host]: cached }));
  assert.equal(await hostRoot(row, state, { deadline: Date.now()+2000 }), cached.root);
  const read = () => JSON.parse(fs.readFileSync(cacheFile))[row.host];
  assert.equal(read().cores, 64); assert.equal(read().freeGiB, 500);
  assert.ok(Date.parse(read().probedAt) > Date.parse(cached.probedAt));
  await hostRoot(row, state, { deadline: Date.now()+2000 });
  assert.equal(fs.readFileSync(path.join(root, 'calls'), 'utf8').split('\n').filter(Boolean).length, 1);
  fs.writeFileSync(cacheFile, JSON.stringify({ [row.host]: cached }));
  fs.writeFileSync(path.join(root, 'fail'), 'fixture failure');
  // One run memoizes the resolved root for 60 s; a memoized call never probes.
  assert.equal(await hostRoot(row, state, { deadline: Date.now()+2000 }), cached.root);
  assert.equal(fs.readFileSync(path.join(root, 'calls'), 'utf8').split('\n').filter(Boolean).length, 1, 'in-run root memo');
  // Each later run starts without the memo and consults the disk cache.
  state.hostRoots.clear();
  assert.equal(await hostRoot(row, state, { deadline: Date.now()+2000 }), cached.root);
  assert.equal(read().cores, 64); assert.equal(read().probedAt, cached.probedAt);
  state.hostRoots.clear();
  await hostRoot(row, state, { deadline: Date.now()+2000 });
  assert.equal(fs.readFileSync(path.join(root, 'calls'), 'utf8').split('\n').filter(Boolean).length, 2, 'bounded retry backoff');
  fs.writeFileSync(cacheFile, '{}');
  state.hostRoots.clear();
  await assert.rejects(hostRoot(row, state, { deadline: Date.now()+2000 }), /root probe/);
  assert.equal(state.children.size, 0);
  console.log('PASS scheduler host probes: stale refresh, cache reuse, retained hardware on failure, retry backoff, no fabricated 8-core default');
} finally {
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
}
