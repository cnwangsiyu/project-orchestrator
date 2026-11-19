import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(process.env.RES_TEST_ROOT || os.tmpdir(), 'scheduler-ranking-'));
const res = process.env.RES_SOURCE || new URL('../res', import.meta.url).pathname;
const small = '192.0.2.8', large = '192.0.2.64';
const file = name => path.join(root, name);
fs.mkdirSync(file('devbox-metrics'));
fs.mkdirSync(file('locks'));
let count = 0;
const eq = (a, b, message) => { assert.deepEqual(a, b, message); count++; };
const row = (id, host, tags = '') => `${id}\tremote\topen\t-\tfixture runner@${host} caps=node,gpu ${tags}\n`;
const registry = (smallTags = '', largeTags = '') => fs.writeFileSync(file('resources.tsv'),
  row('devbox-cn-1', small, smallTags) + row('devbox-cn-2', large, largeTags)
  + row('devbox-cn-light', small, smallTags) + row('devbox-cn-light-2', large, largeTags));
const config = extra => fs.writeFileSync(file('machine.conf'), `DEVBOX_DYNAMIC_ADMISSION=1\nDEVBOX_DYNAMIC_HOSTS=${small},${large}\n${extra || ''}`);
const sample = (host, cores, load5, mem = 100, disk = 200) => fs.writeFileSync(file(`devbox-metrics/${host}.json`),
  JSON.stringify({ at: Date.now()/1000, cores, load5, memAvailableGiB: mem, freeGiB: disk }));
const run = args => {
  const r = spawnSync(res, args, { encoding: 'utf8', env: { ...process.env, RES_DIR: root }, timeout: 30000 });
  if (r.error) throw r.error;
  return r;
};
const claim = (id, extra = [], pool = 'devbox-cn') => {
  const r = run(['wait-pool', pool, '--by', 'fixture', '--project', 'fixture', '--for', 'ranking', '--pid', String(process.pid), '--timeout', '0', ...extra]);
  eq(r.status, 0, r.stdout+r.stderr);
  eq(r.stdout.match(/^slot=(.*)$/m)?.[1], id, r.stdout+r.stderr);
  eq(run(['return', id, '--by', 'fixture']).status, 0);
};
try {
  registry(); config(); sample(small, 8, 0); sample(large, 64, 0);
  claim('devbox-cn-2');
  claim('devbox-cn-light-2', [], 'devbox-cn-light');
  claim('devbox-cn-2', ['--prefer-host', small]);
  sample(large, 64, 55); claim('devbox-cn-2');
  sample(large, 64, 60); claim('devbox-cn-1');
  sample(large, 64, 50); claim('devbox-cn-2', ['--prefer-slot', 'devbox-cn-1']);
  sample(large, 64, 55); claim('devbox-cn-1', ['--prefer-slot', 'devbox-cn-1']);
  sample(small, 8, 0, 20); sample(large, 8, 0, 40); claim('devbox-cn-2');
  sample(small, 8, 0, 40, 150); sample(large, 8, 0, 40, 200); claim('devbox-cn-2');
  sample(small, 8, 0, 40, 200); claim('devbox-cn-1');
  // CPU reservations, including light starts, matter even before load catches up.
  fs.mkdirSync(file('devbox-reservations'), { recursive: true });
  fs.writeFileSync(file(`devbox-reservations/${large}.json`), JSON.stringify([[Date.now()/1000, 60, 1]]));
  sample(large, 64, 0); claim('devbox-cn-1');
  fs.unlinkSync(file(`devbox-reservations/${large}.json`));
  for (const pool of ['devbox-cn', 'devbox-cn-light']) {
    const a = pool === 'devbox-cn' ? 'devbox-cn-1' : 'devbox-cn-light';
    const b = pool === 'devbox-cn' ? 'devbox-cn-2' : 'devbox-cn-light-2';
    registry('', 'prefer=gpu'); sample(small, 8, 0); sample(large, 64, 0);
    claim(a, [], pool);
    claim(b, ['--need', 'gpu'], pool);
    sample(small, 8, 8); claim(b, [], pool);
    sample(small, 8, 0);
    fs.mkdirSync(file(`locks/${a}.d`));
    claim(b, [], pool);
    fs.rmdirSync(file(`locks/${a}.d`));
  }
  registry(); sample(small, 8, 0); sample(large, 64, 0);
  config('DEVBOX_RANK_BY_SPARE=0\n'); claim('devbox-cn-1', ['--prefer-host', small]);
  config('DEVBOX_RANK_BY_SPARE=invalid\n'); eq(run(['audit']).status, 1);
  config();
  fs.writeFileSync(file('devbox-hosts.json'), JSON.stringify({ [large]: { cores: 64, freeGiB: 1, probedAt: new Date(Date.now()-90000000).toISOString() } }));
  fs.unlinkSync(file(`devbox-metrics/${large}.json`));
  const before = fs.readFileSync(file('log.tsv'), 'utf8');
  const audit = run(['audit', '--json']); eq(audit.status, 0, audit.stderr);
  const facts = JSON.parse(audit.stdout).hosts[large];
  eq(facts.cores, 64); eq(facts.coresSource, 'stale-probe'); eq(facts.freeGiB, null);
  eq(facts.probeStale, true); eq(facts.pools.heavy.open, 1);
  eq(fs.readFileSync(file('log.tsv'), 'utf8'), before, 'audit cannot write history');
  eq(fs.readdirSync(file('locks')), [], 'audit cannot create holds');
  console.log(`ALL ${count} ASSERTIONS PASSED`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
