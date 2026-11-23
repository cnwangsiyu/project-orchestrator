import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';

const root = fs.mkdtempSync(path.join(process.env.RES_TEST_ROOT, 'mem-guard-'));
const state = path.join(root, 'state'), mocks = path.join(root, 'mocks');
const swapDir = path.join(root, 'swapfiles');
const sampleFile = path.join(root, 'samples.tsv');
for (const dir of [state, mocks, swapDir, path.join(state, 'locks')]) fs.mkdirSync(dir, { recursive: true });
const source = process.env.RES_SOURCE;
const vm = path.join(root, 'vm'), swap = path.join(root, 'swap'), calls = path.join(root, 'calls');
fs.writeFileSync(path.join(state, 'resources.tsv'),
  ['heavy-build', 'heavy-lane-1', 'heavy-lane-2', 'heavy-lane-3'].map(id => `${id}\tslot\topen\t-\tfixture\n`).join('') +
  'checkout\tcheckout\topen\t-\tfixture\n' +
  'devbox-cn-1\tremote\topen\t-\tfixture runner@192.0.2.1 caps=node\n');
fs.writeFileSync(path.join(mocks, 'uname'), '#!/bin/sh\necho "${MEM_OS:-Darwin}"\n', { mode: 0o755 });
fs.writeFileSync(path.join(mocks, 'vm_stat'), '#!/bin/sh\necho vm >>"$METRIC_CALLS"\n[ "${MEM_FAIL_VM:-0}" = 0 ] || exit 1\ncat "$METRIC_VM"\n', { mode: 0o755 });
fs.writeFileSync(path.join(mocks, 'sysctl'), `#!/bin/sh
echo "$2" >>"$METRIC_CALLS"
case "$2" in
  vm.swapusage) [ "\${MEM_FAIL_SWAP:-0}" = 0 ] || exit 1; cat "$METRIC_SWAP" ;;
  vm.loadavg) echo '{ 1.00 1.00 1.00 }' ;;
  kern.memorystatus_level) echo 80 ;;
  hw.memsize) echo 68719476736 ;;
  hw.physicalcpu) echo 14 ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
fs.writeFileSync(path.join(mocks, 'sleep'), `#!/bin/sh
if [ "\${MEM_PAUSE:-0}" = 1 ]; then
  n=0; [ ! -f "$MEM_SLEEP_COUNT" ] || n=$(cat "$MEM_SLEEP_COUNT")
  n=$((n+1)); echo "$n" >"$MEM_SLEEP_COUNT"; touch "$MEM_SLEEP_MARK.$n"
  while [ ! -f "$MEM_SLEEP_MARK.$n.release" ]; do /bin/sleep 0.02; done
else exec /bin/sleep "$@"; fi
`, { mode: 0o755 });
const env = { ...process.env, RES_DIR: state, PATH: `${mocks}:${process.env.PATH}`, RES_TEST_METRICS: '0',
  METRIC_VM: vm, METRIC_SWAP: swap, METRIC_CALLS: calls,
  RES_TEST_MEMORY_GUARD: '1', RES_TEST_SWAPFILE_DIR: swapDir,
  MEM_SLEEP_COUNT: path.join(root, 'sleep-count'), MEM_SLEEP_MARK: path.join(root, 'sleep') };
let count = 0;
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); count++; };
const ok = (a, msg) => { assert.ok(a, msg); count++; };
const run = (args, extra = {}) => {
  const r = spawnSync(source, args, { env: { ...env, ...extra }, encoding: 'utf8', timeout: 60000 });
  if (r.error) throw r.error;
  return { code: r.status, text: r.stdout + r.stderr, out: r.stdout };
};
const args = by => ['--by', by, '--project', 'fixture', '--for', 'memory guard', '--pid', String(process.pid)];
const config = content => {
  const next = path.join(state, 'next.conf'); fs.writeFileSync(next, 'MEM_GUARD_SAMPLES=' + sampleFile + '\n' + content); fs.renameSync(next, path.join(state, 'machine.conf'));
};
const json = (name, value) => fs.writeFileSync(path.join(state, name), JSON.stringify(value) + '\n');
const remove = name => fs.rmSync(path.join(state, name), { force: true });
function metrics(compressor = 0, swapGiB = 0, size = 16384, free = 4) {
  fs.writeFileSync(vm, `Mach Virtual Memory Statistics: (page size of ${size} bytes)\nPages free: ${Math.round(free * 2 ** 30 / size)}.\nPages inactive: 0.\nPages speculative: 0.\nPages occupied by compressor: ${Math.round(compressor * 2 ** 30 / size)}.\n`);
  fs.writeFileSync(swap, `total = 65536M used = ${swapGiB * 1024}M free = 0M (encrypted)\n`);
}
const check = () => run(['heavy-check', '--memory-details', '--pid', String(process.pid)]);
const events = event => (fs.existsSync(path.join(state, 'log.tsv')) ? fs.readFileSync(path.join(state, 'log.tsv'), 'utf8') : '')
  .split('\n').filter(line => line.includes(`\t${event}\t`));
const children = new Set();
function samples(compressorCount = 0, swapCount = 0, extra = {}) {
  const current = Date.now() / 1000 - (extra.age || 1);
  fs.writeFileSync(sampleFile, 'time\tcompressor_gib\tfree_gib\tswap_used_gib\tswapfiles\tload1\tprocs\ttop_cpu\n' +
    Array.from({ length: extra.count || 9 }, (_, i) => {
      const at = current - i * (extra.spacing || 10);
      const stamp = extra.iso ? new Date(at * 1000).toISOString() : at;
      return `${stamp}\t${i < compressorCount ? (extra.compressor || 25) : 24}\t4\t${i < swapCount ? 37 : 36}\t0\t1\t1\tfixture\n`;
    }).reverse().join(''));
  if (extra.oldMtime) fs.utimesSync(sampleFile, new Date(Date.now() - 61000), new Date(Date.now() - 61000));
}
function swapfiles(n) {
  for (const name of fs.readdirSync(swapDir)) fs.rmSync(path.join(swapDir, name));
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(swapDir, 'swapfile' + i), '');
}
try {
  metrics(); config('MEM_GUARD_WINDOW_SEC=120\n'); samples();
  fs.writeFileSync(calls, ''); let r = check(); eq(r.code, 0, r.text); ok(r.text.includes('memory=OK guard=enabled'));
  const probes = fs.readFileSync(calls, 'utf8').trim().split('\n');
  eq(probes.filter(v => v === 'vm').length, 1, 'reuse heavy-check vm_stat');
  eq(probes.filter(v => v === 'vm.swapusage').length, 1, 'reuse heavy-check swap');
  console.log('CHECK sustained samples and hard stops');
  samples(5, 5); eq(check().code, 0, 'five high readings do not deny');
  samples(6, 0); r = check(); eq(r.code, 5); ok(r.text.includes('sustained_compressor=6'));
  samples(0, 6, { iso: true }); r = check(); eq(r.code, 5); ok(r.text.includes('sustained_swap=6'));
  samples(6, 6, { spacing: 1 }); eq(check().code, 0, 'closely spaced samples cannot create sustained pressure');
  samples(5, 0, { count: 5 }); eq(check().code, 0, 'partial history below sustain count');
  config('MEM_GUARD_SUSTAIN=3\n'); samples(3, 0); eq(check().code, 5, 'configured sustain count');
  config('MEM_GUARD_COMPRESSOR_GIB=26\n'); samples(9, 0); eq(check().code, 0, 'configured compressor threshold');
  config('MEM_GUARD_SWAP_GIB=38\n'); samples(0, 9); eq(check().code, 0, 'configured swap threshold');
  config('MEM_GUARD=1\n'); metrics(35, 35); samples(9, 9, { age: 61 });
  r = check(); eq(r.code, 0, 'stale data falls back without instantaneous denial'); ok(r.text.includes('sample_source=single'));
  samples(9, 9, { oldMtime: true }); eq(check().code, 0, 'stale file mtime ignored');
  fs.rmSync(sampleFile); r = check(); eq(r.code, 0, 'missing sampler tolerates idle swings');
  metrics(35, 35); json('memory-samples.json', [[Date.now() / 1000 - 10, 0]]);
  eq(check().code, 0, 'swap growth is diagnostic rather than an instantaneous denial');
  for (const size of [4096, 16384]) {
    metrics(0, 0, size, 2); eq(check().code, 0, 'equal free threshold admitted');
    metrics(0, 0, size, 2 - size / 2 ** 30); eq(check().code, 5, 'one page below hard free threshold');
  }
  metrics(0, 0, 16384, 1);
  remove('memory-samples.json.lock'); fs.mkdirSync(path.join(state, 'memory-samples.json.lock'));
  eq(check().code, 5, 'unwritable diagnostic cache cannot suppress a hard stop');
  fs.rmdirSync(path.join(state, 'memory-samples.json.lock'));
  const cacheReady = path.join(root, 'cache-ready'), cacheRelease = path.join(root, 'cache-release');
  const cacheActor = spawn('python3', ['-B', '-c',
    'import fcntl,sys,time,pathlib\nwith open(sys.argv[1], "a") as f:\n fcntl.flock(f, fcntl.LOCK_EX)\n pathlib.Path(sys.argv[2]).touch()\n while not pathlib.Path(sys.argv[3]).exists(): time.sleep(0.02)',
    path.join(state, 'memory-samples.json.lock'), cacheReady, cacheRelease], { env });
  children.add(cacheActor);
  const cacheDone = new Promise(resolve => cacheActor.on('close', code => { children.delete(cacheActor); resolve(code); }));
  const cacheDeadline = Date.now() + 30000;
  while (!fs.existsSync(cacheReady)) { assert.ok(Date.now() < cacheDeadline && children.has(cacheActor)); await pause(20); }
  eq(check().code, 5, 'busy diagnostic cache cannot block a hard stop');
  fs.writeFileSync(cacheRelease, ''); eq(await cacheDone, 0);
  metrics(); swapfiles(47); eq(check().code, 0); swapfiles(48); eq(check().code, 5, 'swapfile count hard stop is inclusive');
  config('MEM_GUARD_SWAPFILES=2\n'); swapfiles(2); eq(check().code, 5, 'configured swapfile threshold');
  swapfiles(0); config('MEM_GUARD=0\n'); metrics(40, 50, 16384, 0); r = check(); eq(r.code, 0); ok(r.text.includes('memory=DISABLED'));
  config('MEM_GUARD=1\nHEAD_OVERRIDE_BASE_LOAD=1\n'); metrics(); samples(6, 0);
  console.log('CHECK admission paths and holder warnings');
  for (const id of ['heavy-build', 'heavy-lane-1', 'heavy-lane-2', 'heavy-lane-3']) {
    samples(6, 0); r = run(['take', id, ...args('take-' + id)]); eq(r.code, 5, r.text);
    samples(6, 0); r = run(['wait', id, ...args('wait-' + id), '--timeout', '0']); eq(r.code, 2, r.text);
  }
  for (const argv of [['take-build'], ['wait-build', '--timeout', '0'], ['wait-lane', '--timeout', '0']]) {
    samples(6, 0); r = run([...argv, ...args(argv[0])], {});
    eq(r.code, argv[0] === 'take-build' ? 5 : 2, r.text);
  }
  samples(6, 0); r = run(['heavy-check', '--admission', 'lane', '--load-override']); eq(r.code, 5); ok(r.text.includes('blocked=memory'));
  eq(fs.readdirSync(path.join(state, 'locks')), [], 'memory denials create no capacity holds');
  r = run(['take', 'checkout', ...args('checkout')]); eq(r.code, 0, r.text);
  r = run(['take', 'devbox-cn-1', ...args('remote')]); eq(r.code, 0, r.text);
  eq(run(['return', 'checkout', '--by', 'checkout']).code, 0);
  eq(run(['return', 'devbox-cn-1', '--by', 'remote']).code, 0);
  metrics(); samples(); eq(run(['take-build', ...args('held')]).code, 0);
  const lease = fs.readFileSync(path.join(state, 'locks/heavy-build.d/info'), 'utf8');
  samples(6, 0); r = run(['status', 'heavy-build']); eq(r.code, 0); ok(r.text.includes('memory=HIGH guard=enabled'));
  samples(6, 0); r = run(['holder', 'heavy-build', '--by', 'held']); eq(r.code, 0); eq(JSON.parse(r.out).memory, 'HIGH');
  eq(fs.readFileSync(path.join(state, 'locks/heavy-build.d/info'), 'utf8'), lease, 'observation leaves holder intact');
  eq(run(['return-build', '--by', 'held', '--pid', String(process.pid)]).code, 0);
  console.log('CHECK denial throttling and unavailable tools');
  remove('memory-denials.json'); const before = events('gate-denied').length;
  samples(6, 0); eq(run(['take-build', ...args('limited')]).code, 5); eq(run(['take-build', ...args('limited')]).code, 5);
  eq(events('gate-denied').length - before, 1, 'denial logged once per holder/minute across probes');
  const rate = JSON.parse(fs.readFileSync(path.join(state, 'memory-denials.json'), 'utf8'));
  for (const name of Object.keys(rate)) rate[name] -= 61; json('memory-denials.json', rate);
  samples(6, 0); eq(run(['take-build', ...args('limited')]).code, 5); eq(events('gate-denied').length - before, 2);
  ok(events('gate-denied').at(-1).includes('reason=memory memory=HIGH guard=enabled compressor_gib=0.000 swap_used_gib=0.000 swap_growth_gib=0.000'));
  const crowdedRates = JSON.parse(fs.readFileSync(path.join(state, 'memory-denials.json'), 'utf8'));
  for (let i = 0; i < 200; i++) crowdedRates['fixture-' + i] = Date.now() / 1000;
  json('memory-denials.json', crowdedRates);
  const crowdedBefore = events('gate-denied').length;
  samples(6, 0); eq(run(['take-build', ...args('crowded-new')]).code, 5);
  samples(6, 0); eq(run(['take-build', ...args('limited')]).code, 5);
  eq(events('gate-denied').length - crowdedBefore, 1, 'active waiter rate entries are not evicted by more waiters');
  remove('memory-warning.json'); fs.writeFileSync(calls, '');
  r = run(['holder', 'heavy-build'], { MEM_OS: 'Linux' }); eq(r.code, 0); eq(JSON.parse(r.out).memory, 'UNSUPPORTED');
  eq(fs.readFileSync(calls, 'utf8'), '', 'Linux guard does not invoke macOS tools');
  for (const extra of [{ MEM_FAIL_VM: '1' }, { MEM_FAIL_SWAP: '1' }]) {
    remove('memory-warning.json'); r = run(['take', 'heavy-build', ...args('unreadable')], extra);
    eq(r.code, 0, r.text); eq((r.text.match(/memory guard unavailable/g) || []).length, 1);
    eq(run(['return', 'heavy-build', '--by', 'unreadable']).code, 0);
  }
  fs.writeFileSync(vm, 'malformed\n'); r = run(['status', 'heavy-build']); eq(r.code, 0); ok(r.text.includes('memory=UNKNOWN'));
  metrics(); samples(); remove('memory-samples.json');
  json('memory-samples.json', Array.from({ length: 500 }, (_, i) => [Date.now() / 1000 - i / 100, i / 1000]));
  eq(check().code, 0); ok(fs.statSync(path.join(state, 'memory-samples.json')).size < 10000);
  ok(JSON.parse(fs.readFileSync(path.join(state, 'memory-samples.json'), 'utf8')).length <= 128);
  console.log('CHECK config fallback and candidate validation');
  samples(); config('LOAD_LIMIT=9\nMEM_GUARD_COMPRESSOR_GIB=28\n'); eq(check().code, 0);
  const saved = fs.readFileSync(path.join(state, 'machine-last-good.json'), 'utf8');
  config('MEM_GUARD=2\n'); r = check(); eq(r.code, 0); ok(r.text.includes('source=machine.conf LOAD_LIMIT=9'));
  eq(fs.readFileSync(path.join(state, 'machine-last-good.json'), 'utf8'), saved, 'invalid edit preserves durable snapshot');
  const invalidCount = events('config-invalid').length; eq(check().code, 0); eq(events('config-invalid').length, invalidCount);
  const candidate = path.join(root, 'candidate.conf');
  for (const text of ['MEM_GUARD=0\n', 'MEM_GUARD=1\nMEM_GUARD_COMPRESSOR_GIB=0.5\nMEM_GUARD_SWAP_GIB=10\nMEM_GUARD_SWAP_GROWTH_GIB=1\nMEM_GUARD_WINDOW_SEC=60\n']) {
    fs.writeFileSync(candidate, text); eq(run(['check-config', candidate]).code, 0);
  }
  for (const text of ['MEM_GUARD=2\n', 'MEM_GUARD_SUSTAIN=10\n', 'MEM_GUARD_SWAPFILES=1.5\n', 'MEM_GUARD_SAMPLES=relative.tsv\n', 'MEM_GUARD_SWAP_GIB=-1\n', 'MEM_GUARD_WINDOW_SEC=1.5\n', 'MEM_GUARD_WINDOW_SEC=86401\n', 'DEVBOX_HEAVY_GIB=oops\n', 'LOAD_LIMIT=30\n', 'MEM_GUARD=0']) {
    fs.writeFileSync(candidate, text); r = run(['check-config', candidate]); eq(r.code, 1); ok(r.text.includes('res:'));
  }
  eq(fs.readFileSync(path.join(state, 'machine-last-good.json'), 'utf8'), saved, 'check-config never publishes');
  eq(run(['check-config']).code, 1, 'default candidate validates current file without fallback');
  eq(run(['check-config', candidate, candidate]).code, 1);
  remove('machine-last-good.json'); eq(check().code, 1, 'no durable snapshot fails closed');
  config('MEM_GUARD=1\n'); metrics(); samples(6, 0); remove('memory-samples.json'); remove('memory-denials.json');
  console.log('CHECK waiter resumes after guard is disabled');
  const child = spawn(source, ['wait-build', ...args('polling'), '--timeout', '1'], { env: { ...env, MEM_PAUSE: '1' } });
  children.add(child); let text = ''; child.stdout.on('data', b => text += b); child.stderr.on('data', b => text += b);
  const done = new Promise(resolve => child.on('close', code => { children.delete(child); resolve(code); }));
  async function until(file) {
    const deadline = Date.now() + 30000;
    while (!fs.existsSync(file)) { assert.ok(Date.now() < deadline && children.has(child), text); await pause(20); }
  }
  await until(path.join(root, 'sleep.1'));
  samples(6, 0); fs.writeFileSync(path.join(root, 'sleep.1.release'), ''); await until(path.join(root, 'sleep.2'));
  eq(events('gate-denied').filter(line => line.includes('\tpolling\t')).length, 1, 'same waiter is throttled across polls');
  eq(fs.readdirSync(path.join(state, 'locks')), [], 'waiter holds no capacity while blocked');
  config('MEM_GUARD=0\n'); fs.writeFileSync(path.join(root, 'sleep.2.release'), '');
  // Let the existing explicit-PID post-acquisition sleep pass too.
  await until(path.join(root, 'sleep.3')); fs.writeFileSync(path.join(root, 'sleep.3.release'), '');
  eq(await done, 0, text); eq(run(['return-build', '--by', 'polling', '--pid', String(process.pid)]).code, 0);
  console.log(`ALL ${count} ASSERTIONS PASSED`);
} finally {
  for (const child of children) child.kill('SIGTERM');
  fs.rmSync(root, { recursive: true, force: true });
}
