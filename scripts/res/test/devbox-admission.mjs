import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';

const root = fs.mkdtempSync(path.join(process.env.RES_TEST_ROOT || os.tmpdir(), 'devbox-admission-'));
const res = process.env.RES_SOURCE || new URL('../res', import.meta.url).pathname;
const host = '192.0.2.1', other = '192.0.2.2';
const heavy = 'devbox-cn', light = 'devbox-cn-light';
const slot = n => `${heavy}-${n}`;
const env = { ...process.env, RES_DIR: root };
const args = by => ['--by', by, '--project', 'fixture', '--for', 'gate scenario', '--pid', String(process.pid)];
const take = (id, by = id) => run('take', id, ...args(by));
const wait = (by, ...extra) => run('wait-pool', heavy, ...args(by), '--timeout', '0', ...extra);
const release = (id, by = id) => eq(run('return', id, '--by', by).status, 0);
const journal = () => fs.readFileSync(path.join(root, 'log.tsv'), 'utf8');
const ledger = path.join(root, 'devbox-reservations', host + '.json');
const children = new Set();
let count = 0;
function eq(actual, expected, message) { assert.equal(actual, expected, message); count++; }
function match(value, expression) { assert.match(value, expression); count++; }
function run(...argv) {
  const result = spawnSync(res, argv, { env, encoding: 'utf8', timeout: 120000 });
  if (result.error) throw result.error;
  return result;
}
function start(argv, extra) {
  const child = spawn(res, argv, { env: { ...env, ...extra }, stdio: 'ignore' });
  children.add(child);
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', result => { children.delete(child); resolve(result); });
  });
}
async function until(test) {
  const deadline = Date.now() + 60000;
  while (!test()) { assert.ok(Date.now() < deadline, 'fixture synchronization timed out'); await pause(15); }
}
function config(enabled = 1, overrides = '') {
  fs.writeFileSync(path.join(root, 'machine.conf'), `DEVBOX_DYNAMIC_ADMISSION=${enabled}\nDEVBOX_DYNAMIC_HOSTS=${host}\n${overrides}`);
}
function metrics(load5, memAvailableGiB, age = 0, freeGiB = 1000) {
  fs.writeFileSync(path.join(root, 'devbox-metrics', host + '.json'),
    JSON.stringify({ at: Date.now() / 1000 - age, cores: 8, load5, memAvailableGiB, freeGiB, load1: 99 }));
}
function expireReservations(age = 901) {
  const entries = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  fs.writeFileSync(ledger, JSON.stringify(entries.map(([, ...cost]) => [Date.now() / 1000 - age, ...cost])));
}
function row(id, box, tags = 'caps=node', policy = 'open') {
  return `${id}\tremote\t${policy}\t-\tfixture runner@${box} ${tags}\n`;
}
function seedHead(pool = heavy) {
  const head = path.join(root, 'pool-waiters', pool, 'waiter.older');
  fs.mkdirSync(head, { recursive: true });
  fs.writeFileSync(path.join(head, 'info'), `holder\tolder\npid\t${process.pid}\nhost\t${os.hostname()}\nheartbeat\t${Math.floor(Date.now() / 1000)}\norder\t00000000000000000001\nneed\tnode\nexclude_hosts\t${other}\n`);
  return head;
}
function seedHold(id, age, pid, recordedHost = os.hostname()) {
  const directory = path.join(root, 'locks', id + '.d');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'info'), `by\told-holder\nproject\tfixture\npid\t${pid}\nhost\t${recordedHost}\nstart\t${Math.floor(Date.now() / 1000) - age}\n`);
}
function ageWaiter(by, agedSeconds, nextLoad, nextMemory) {
  const shim = path.join(root, 'python3');
  const inject = path.join(root, 'age-waiter.py');
  const real = spawnSync('/bin/sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(shim, `#!/bin/sh
if [ "$3" = wait ] && [ "$6" = 2 ]; then
  "$REAL_PYTHON" "$AGE_INJECT" "$2" "$4" "$7" || exit 1
fi
exec "$REAL_PYTHON" "$@"
`, { mode: 0o755 });
  // Age the records immediately before the second poll, independent of host scheduling.
  fs.writeFileSync(inject, String.raw`import json, os, pathlib, sys, time
root, pool, holder = sys.argv[1:]
root = pathlib.Path(root)
records = [p for p in (root / 'pool-waiters' / pool).glob('*/info')
           if 'holder\t' + holder + '\n' in p.read_text()]
assert len(records) == 2
at = time.time()
for record in records:
    info = dict(line.split('\t', 1) for line in record.read_text().splitlines())
    info.update(load_blocked_since=at-float(os.environ['AGE_SECONDS']), started_at=at-120)
    record.write_text(''.join('%s\t%s\n' % pair for pair in info.items()))
(root / 'devbox-metrics' / (os.environ['AGE_HOST'] + '.json')).write_text(json.dumps(
    dict(at=at, cores=8, load5=float(os.environ['AGE_LOAD']), memAvailableGiB=float(os.environ['AGE_MEMORY']), freeGiB=1000)))
`);
  const result = spawnSync(res, ['wait-pool', heavy, ...args(by), '--timeout', '1', '--exclude-host', other], {
    env: { ...env, PATH: `${root}:${env.PATH}`, REAL_PYTHON: real, AGE_INJECT: inject,
      AGE_SECONDS: String(agedSeconds), AGE_HOST: host, AGE_LOAD: String(nextLoad), AGE_MEMORY: String(nextMemory),
      RES_TEST_POOL_FAST_POLL: '1' }, encoding: 'utf8', timeout: 120000,
  });
  if (result.error) throw result.error;
  if (result.status === 1) throw Error(result.stderr);
  return result.status;
}

try {
  fs.mkdirSync(path.join(root, 'devbox-metrics'));
  fs.writeFileSync(path.join(root, 'resources.tsv'), row(slot(1), host) + row(slot(2), host)
    + row(slot(3), host, 'caps=node dynamic-only') + row(slot(4), host, 'caps=node', 'never')
    + row(slot(5), other, 'caps=node,rust') + row(light, host));
  config(); metrics(0, 100);
  for (let cycle = 0; cycle < 30; cycle++) { eq(take(slot(1)).status, 0); release(slot(1)); }
  eq(JSON.parse(fs.readFileSync(ledger, 'utf8')).length, 0, '30 quick cycles leave no reservations');
  metrics(0, 100, 0, 53);
  eq(run('take', slot(1), ...args(slot(1)), '--disk-gib', '0').status, 0, 'existing workspace reserves zero disk');
  const reused = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  eq(reused.length, 1); eq(reused[0][3], 0);
  eq(take(slot(1)).status, 0); eq(JSON.parse(fs.readFileSync(ledger, 'utf8')).length, 1, 'one per holder');
  release(slot(1));
  metrics(0, 100, 0, 52.99);
  eq(run('take', slot(1), ...args(slot(1)), '--disk-gib', '0').status, 2, 'real free-space floor stays enforced');
  const diskFile = path.join(root, 'disk-costs.json'); fs.writeFileSync(diskFile, JSON.stringify({[slot(1)]: 0}));
  metrics(0, 100, 0, 53);
  eq(wait('per-slot-reuse', '--disk-gib-file', diskFile, '--exclude-host', other).status, 0); release(slot(1), 'per-slot-reuse');
  metrics(0, 100, 0, 1000); fs.rmSync(path.join(root, 'devbox-metrics', host + '.json'));
  eq(take(slot(3)).status, 3, 'missing metrics: floating row stays closed');
  eq(take(slot(1)).status, 0, 'missing metrics: static row remains usable');
  release(slot(1)); expireReservations();
  metrics(5.1, 20);
  const load = take(slot(1));
  eq(load.status, 2); match(load.stderr, /devbox gate load/);
  match(wait('fallback', '--prefer-host', host).stdout, /slot=devbox-cn-5/); release(slot(5), 'fallback');
  match(wait('caps', '--need', 'rust').stdout, /slot=devbox-cn-5/); release(slot(5), 'caps');
  metrics(0, 7.99);
  const memory = take(slot(1)); eq(memory.status, 2); match(memory.stderr, /devbox gate memory/);
  metrics(5, 8);
  eq(take(slot(3)).status, 0, 'inclusive load and memory limits');
  match(run('status', slot(3)).stdout, /heavy admitted=1\/3 gate=CLOSED reason=memory .*load5=5 reserved_cores=3 reserved_gib=4 mem_available_gib=8/);
  release(slot(3));
  eq(JSON.parse(fs.readFileSync(ledger, 'utf8')).length, 0, 'return releases reservation');
  eq(take(slot(1)).status, 0, 'returned starts no longer block admission');
  expireReservations(301);
  eq(take(slot(1)).status, 0, 'same holder take remains idempotent');
  release(slot(1)); expireReservations();
  metrics(0, 100, 0, 72.99);
  match(take(slot(1)).stderr, /devbox gate disk/, 'heavy cost preserves 53 GiB');
  metrics(0, 100, 0, 73);
  eq(take(slot(1)).status, 0, 'inclusive disk floor');
  expireReservations(301);
  match(take(light).stderr, /devbox gate disk/, 'heavy disk reservation still blocks light after five minutes');
  match(run('status', slot(1)).stdout, /free_disk_gib=73 reserved_disk_gib=20/);
  expireReservations();
  eq(take(light).status, 0, 'disk reservation expires at 15 minutes'); release(light); release(slot(1));
  expireReservations();
  config(1, `DEVBOX_HEAVY_DISK_GIB.${host}=15\nDEVBOX_HEAVY_DISK_GIB.project.fixture=50\n`);
  metrics(0, 100, 0, 102.99);
  match(take(slot(1)).stderr, /devbox gate disk/, 'project cost overrides host cost');
  const hostOverride = run('take', slot(1), '--by', 'other-project', '--project', 'different', '--for', 'host cost fixture', '--pid', String(process.pid));
  eq(hostOverride.status, 0, 'different projects can use host override'); release(slot(1), 'other-project');
  expireReservations(); config();
  metrics(99, 0, 301);
  eq(take(slot(1)).status, 0); release(slot(1));
  eq(take(slot(3)).status, 3);
  match(journal(), /gate-admit\tdevbox-cn-1[^\n]+reason=static-stale-or-missing-metrics/);
  metrics(99, 0);
  const samplePath = path.join(root, 'devbox-metrics', host + '.json');
  const oldSample = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
  delete oldSample.freeGiB;
  fs.writeFileSync(samplePath, JSON.stringify(oldSample));
  eq(take(slot(3)).status, 3, 'legacy samples without free disk leave floating rows closed');
  eq(take(slot(1)).status, 0, 'legacy samples use static baseline capacity'); release(slot(1));

  metrics(99, 0); config(0);
  eq(take(slot(1)).status, 0); release(slot(1));
  eq(take(slot(3)).status, 3);
  match(run('status', slot(3)).stdout, /heavy admitted=0\/2 gate=OPEN reason=static-disabled/);

  config(1, `DEVBOX_HEAVY_CORES=8\nDEVBOX_HEAVY_CORES.${host}=1\n`);
  expireReservations(); metrics(0, 100);
  for (const n of [1, 2, 3]) eq(take(slot(n)).status, 0, 'host-specific cost admits up to registered open rows');
  eq(take(slot(4)).status, 3);
  eq(wait('full', '--exclude-host', other).status, 2, 'headroom cannot manufacture slots');
  config(0);
  release(slot(1));
  match(take(slot(1)).stderr, /devbox gate static-cap/, 'a retained floating hold consumes baseline capacity');
  for (const n of [2, 3]) release(slot(n));

  config(); expireReservations(); metrics(5, 100);
  const barrier = path.join(root, 'claims'); fs.mkdirSync(barrier);
  const burstIds = [slot(1), slot(2), light];
  const burst = burstIds.map(id => start(['take', id, ...args(id)], { RES_TEST_POOL_CLAIM_BARRIER: barrier }));
  await until(() => fs.readdirSync(barrier).length === burstIds.length);
  fs.writeFileSync(path.join(barrier, 'release'), '');
  const result = await Promise.all(burst);
  eq(result.filter(code => code === 0).length, 1, 'concurrent heavy and light claims share the same budget');
  eq(result.filter(code => code === 2).length, 2);
  eq(JSON.parse(fs.readFileSync(ledger, 'utf8')).length, 1);
  release(burstIds[result.indexOf(0)]); expireReservations();
  metrics(0, 100, 0, 73);
  fs.rmSync(barrier, { recursive: true }); fs.mkdirSync(barrier);
  const diskBurst = [slot(1), slot(2)].map(id => start(['take', id, ...args(id)], { RES_TEST_POOL_CLAIM_BARRIER: barrier }));
  await until(() => fs.readdirSync(barrier).length === diskBurst.length);
  fs.writeFileSync(path.join(barrier, 'release'), '');
  const diskResults = await Promise.all(diskBurst);
  eq(diskResults.filter(code => code === 0).length, 1, 'serialized disk reservations block a burst');
  eq(diskResults.filter(code => code === 2).length, 1);
  release(burstIds[diskResults.indexOf(0)]); expireReservations();


  const head = seedHead();
  metrics(0, 100);
  eq(wait('younger', '--exclude-host', other).status, 2, 'younger preserves measured headroom across distinct rows');
  match(wait('surplus').stdout, /slot=devbox-cn-5/); release(slot(5), 'surplus');
  metrics(9, 100);
  eq(ageWaiter('not-head', 1205, 9, 100), 2);
  fs.rmSync(head, { recursive: true });
  eq(ageWaiter('under-20', 1100, 9, 100), 2);
  eq(ageWaiter('memory-floor', 1205, 9, 3), 2);
  metrics(9, 100);
  eq(ageWaiter('load-override', 1205, 9, 100), 0);
  eq(journal().split('\n').filter(line => /gate-admit.*reason=load-override/.test(line)).length, 1);
  match(journal(), /gate-deny\tdevbox-cn-1[^\n]+reason=load .*load5=5\.1 reserved_cores=0.*mem_available_gib=20/);
  match(journal(), /gate-deny\tdevbox-cn-1[^\n]+reason=memory .*load5=0 .*mem_available_gib=7\.99/);
  eq(wait('new-waiter', '--exclude-host', other).status, 2, 'override cannot be inherited by another waiter');

  const overrideSlot = fs.readdirSync(path.join(root, 'locks')).find(name => name.endsWith('.d')).slice(0, -2);
  release(overrideSlot, 'load-override');
  const dead = spawnSync('/bin/sh', ['-c', 'exit 0']).pid;
  const waitLight = by => run('wait-pool', light, ...args(by), '--timeout', '0');
  config(0, 'DEVBOX_LIGHT_STALE_RECLAIM=0\n');
  seedHold(light, 901, dead);
  eq(waitLight('reclaim-off').status, 2);
  match(run('status', light).stdout, /light STALE slot=devbox-cn-light holder=old-holder .*reclaim=disabled/);
  config(0, 'DEVBOX_LIGHT_STALE_RECLAIM=1\n');
  eq(take(light, 'direct').status, 2, 'only a pool waiter can reclaim');
  const lightHead = seedHead(light);
  eq(waitLight('light-younger').status, 2, 'a younger waiter cannot reclaim');
  fs.rmSync(lightHead, { recursive: true });
  match(run('status', light).stdout, /light STALE slot=devbox-cn-light holder=old-holder .*reclaim=eligible/);
  match(waitLight('reclaim-head').stdout, /slot=devbox-cn-light/);
  match(journal(), /reclaim-stale\tdevbox-cn-light\told-holder\tby=reclaim-head pid=\d+ age_seconds=\d+/);
  match(run('status', light).stdout, /light reclaimed slot=devbox-cn-light previous_holder=old-holder/);
  release(light, 'reclaim-head');
  for (const [by, age, pid, recordedHost] of [
    ['young', 840, dead, os.hostname()],
    ['live', 1200, process.pid, os.hostname()],
    ['remote', 1200, dead, 'fixture-foreign-host'],
  ]) {
    seedHold(light, age, pid, recordedHost);
    eq(waitLight(by).status, 2, by);
    release(light, 'old-holder');
  }
  seedHold(slot(1), 7200, dead);
  eq(wait('heavy-no-reclaim', '--exclude-host', other, '--exclude-slot', slot(2)).status, 2);
  match(wait('heavy-free-slot', '--exclude-host', other).stdout, /slot=devbox-cn-2/);
  match(run('status', slot(1)).stdout, /STALE old-holder/);
  release(slot(2), 'heavy-free-slot'); release(slot(1), 'old-holder');
  eq(journal().split('\n').filter(line => line.includes('\treclaim-stale\t')).length, 1);
  config(0, 'DEVBOX_LIGHT_STALE_RECLAIM=1\n');
  const protectedHolder = 'protected-fixture';
  eq(take(light, protectedHolder).status, 0);
  eq(run('retain-remote', light, '--by', protectedHolder, '--pid', String(process.pid)).status, 0);
  const heldInfo = path.join(root, 'locks', light + '.d', 'info');
  fs.writeFileSync(heldInfo, fs.readFileSync(heldInfo, 'utf8').replace(/^pid\t.*$/m, 'pid\t2147483647')
    .replace(/^start\t.*$/m, 'start\t' + (Math.floor(Date.now() / 1000) - 901)));
  eq(run('wait-pool', light, ...args('replacement'), '--timeout', '0', '--exclude-host', other, '--exclude-reason', 'fixture binding').status, 2);
  match(run('status', light).stdout, /remote cleanup required/);
  release(light, protectedHolder);
  console.log(`ALL ${count} ASSERTIONS PASSED`);
} finally {
  for (const child of children) child.kill('SIGTERM');
  fs.rmSync(root, { recursive: true, force: true });
}
