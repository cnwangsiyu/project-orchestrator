#!/usr/bin/env node
// Load-aware mini admission and counted heavy-build slots use scratch state only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const root = path.join(process.env.RES_TEST_ROOT, 'mini-build');
const state = path.join(root, 'state'), mocks = path.join(root, 'mocks');
fs.mkdirSync(path.join(state, 'locks'), { recursive: true }); fs.mkdirSync(mocks, { recursive: true });
const ids = ['heavy-build', 'heavy-lane-1', 'heavy-lane-2', 'heavy-lane-3'];
fs.writeFileSync(path.join(state, 'resources.tsv'), ids.map(id => `${id}\tslot\topen\t-\tfixture ${id}`).join('\n') + '\n');
fs.writeFileSync(path.join(mocks, 'uname'), '#!/bin/sh\necho Darwin\n', { mode: 0o755 });
const res = process.env.RES_SOURCE;
const baseEnv = { ...process.env, RES_DIR: state, PATH: `${mocks}:${process.env.PATH}`, RES_TEST_METRICS: '1',
  RES_TEST_PHYSICAL_CORES: '14', RES_TEST_LOAD1M: '8', RES_TEST_MEMORYSTATUS_LEVEL: '50',
  RES_TEST_MEMSIZE: '68719476736', RES_TEST_SWAPUSAGE: 'used = 0M',
  RES_TEST_VM_STAT: 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 0.\nPages inactive: 0.\nPages speculative: 0.' };
let assertions = 0;
const eq = (a, b, message) => { assert.deepEqual(a, b, message); assertions++; };
const ok = (value, message) => { assert.ok(value, message); assertions++; };
const run = (argv, extra = {}) => {
  const result = spawnSync(res, argv, { env: { ...baseEnv, ...extra }, encoding: 'utf8', timeout: 120000 });
  if (result.error) throw result.error;
  return { code: result.status, out: result.stdout, err: result.stderr, text: `${result.stdout}${result.stderr}` };
};
const args = (by, project = 'fixture') => ['--by', by, '--project', project, '--for', 'mini admission', '--task', 'mini'];
const lock = id => path.join(state, 'locks', `${id}.d`);
const field = (id, key) => fs.existsSync(path.join(lock(id), 'info'))
  ? fs.readFileSync(path.join(lock(id), 'info'), 'utf8').match(new RegExp(`^${key}\\t(.*)$`, 'm'))?.[1] : undefined;
const held = () => fs.readdirSync(path.join(state, 'locks')).filter(name => name.endsWith('.d')).map(name => name.slice(0, -2)).sort();
const release = by => eq(run(['return-build', '--by', by, '--pid', String(process.pid)]).code, 0);
const config = text => { const next = path.join(state, 'machine.conf.next'); fs.writeFileSync(next, text); fs.renameSync(next, path.join(state, 'machine.conf')); };
const clear = () => { fs.rmSync(path.join(state, 'machine.conf'), { force: true }); };

const repos = path.join(root, 'repos');
for (const name of ['a', 'b', 'c']) fs.mkdirSync(path.join(repos, name, '.git'), { recursive: true });
const common = path.join(repos, 'common.git'); fs.mkdirSync(path.join(common, 'worktrees', 'one'), { recursive: true });
fs.mkdirSync(path.join(common, 'worktrees', 'two'), { recursive: true });
for (const [name, worktree] of [['same-one', 'one'], ['same-two', 'two']]) {
  const directory = path.join(repos, name); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, '.git'), `gitdir: ${path.join(common, 'worktrees', worktree)}\n`);
  fs.writeFileSync(path.join(common, 'worktrees', worktree, 'commondir'), '../..\n');
}

// Normal lanes use the physical-core threshold and memorystatus-derived memory.
let result = run(['take', 'heavy-lane-1', ...args('lane-boundary')], { RES_TEST_LOAD1M: '17.5', RES_TEST_MEMORYSTATUS_LEVEL: '20', RES_TEST_MEMSIZE: '64424509440' });
eq(result.code, 0, result.text); eq(run(['return', 'heavy-lane-1', '--by', 'lane-boundary']).code, 0);
eq(run(['take', 'heavy-lane-1', ...args('lane-load')], { RES_TEST_LOAD1M: '17.5001' }).code, 5);
eq(run(['take', 'heavy-lane-1', ...args('lane-memory')], { RES_TEST_MEMORYSTATUS_LEVEL: '19', RES_TEST_MEMSIZE: '64424509440' }).code, 5);
eq(run(['take', 'heavy-lane-1', ...args('lane-unreadable')], { RES_TEST_MEMORYSTATUS_LEVEL: 'missing' }).code, 1);
// The first build preserves the legacy pages fallback when its pinned lane is
// lane 3; only lane 1/2 and concurrent admission require memorystatus.
result = run(['take-build', ...args('first-pages'), '--checkout', path.join(repos, 'a'), '--lane', 'heavy-lane-3'], {
  RES_TEST_MEMORYSTATUS_LEVEL: 'missing',
  RES_TEST_VM_STAT: 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 4194304.\nPages inactive: 0.\nPages speculative: 0.',
});
eq(result.code, 0, result.text); release('first-pages');

// Counted slots admit different repositories, reject overlap and enforce cap.
config('LOAD_LIMIT=30\nLOAD_LIMIT_WITH_LANES=30\nMIN_AVAIL_GIB=8\n');
result = run(['take-build', ...args('first'), '--checkout', path.join(repos, 'a')]); eq(result.code, 0, result.text);
result = run(['take-build', ...args('second'), '--checkout', path.join(repos, 'b')]); eq(result.code, 0, result.text);
eq(held(), ['heavy-build', 'heavy-build-2', 'heavy-lane-1', 'heavy-lane-2']);
eq(field('heavy-build', 'peak_concurrent'), '2'); eq(field('heavy-build-2', 'peak_concurrent'), '2');
result = run(['status', 'heavy-build']); eq(result.code, 0, result.text); ok(result.text.includes('Build capacity: heavy-build 2/2'), result.text);
eq(run(['take-build', ...args('third'), '--checkout', path.join(repos, 'c')]).code, 2);
release('second'); release('first'); eq(held(), []);
let journal = fs.readFileSync(path.join(state, 'log.tsv'), 'utf8');
ok(/\treturn\theavy-build-2\tsecond\tbuild_mode=concurrent peak_concurrent=2 duration_seconds=\d+/.test(journal), journal);
ok(/\treturn\theavy-build\tfirst\tbuild_mode=concurrent peak_concurrent=2 duration_seconds=\d+/.test(journal), journal);

result = run(['take-build', ...args('same-first'), '--checkout', path.join(repos, 'same-one')]); eq(result.code, 0, result.text);
result = run(['take-build', ...args('same-second'), '--checkout', path.join(repos, 'same-two')]);
eq(result.code, 2, result.text); ok(result.text.includes('checkout is already held'), result.text); release('same-first');
journal = fs.readFileSync(path.join(state, 'log.tsv'), 'utf8');
ok(/\treturn\theavy-build\tsame-first\tbuild_mode=solo peak_concurrent=1 duration_seconds=\d+/.test(journal), journal);

// A legacy holder without checkout metadata blocks concurrent admission.
result = run(['take', 'heavy-build', ...args('legacy')]); eq(result.code, 0, result.text);
result = run(['take-build', ...args('blocked-by-legacy'), '--checkout', path.join(repos, 'b')]);
eq(result.code, 2, result.text); ok(result.text.includes('identity unresolved'), result.text);
eq(run(['return', 'heavy-build', '--by', 'legacy']).code, 0);

// Concurrent builds use the stricter 0.6/core and 24 GiB gate.
result = run(['take-build', ...args('low-first'), '--checkout', path.join(repos, 'a')]); eq(result.code, 0, result.text);
result = run(['take-build', ...args('low-second'), '--checkout', path.join(repos, 'b')], { RES_TEST_LOAD1M: '8.4', RES_TEST_MEMORYSTATUS_LEVEL: '40', RES_TEST_MEMSIZE: '64424509440' });
eq(result.code, 0, result.text); release('low-second');
eq(run(['take-build', ...args('high-second'), '--checkout', path.join(repos, 'b')], { RES_TEST_LOAD1M: '8.4001', RES_TEST_MEMORYSTATUS_LEVEL: '50' }).code, 5);
eq(run(['take-build', ...args('memory-second'), '--checkout', path.join(repos, 'b')], { RES_TEST_LOAD1M: '8', RES_TEST_MEMORYSTATUS_LEVEL: '39', RES_TEST_MEMSIZE: '64424509440' }).code, 5);
release('low-first');

// Configured cap three consumes all three lanes and updates every peak.
config('LOAD_LIMIT=30\nLOAD_LIMIT_WITH_LANES=30\nMIN_AVAIL_GIB=8\nBUILD_MAX_CONCURRENCY=3\n');
for (const [by, repo] of [['cap-one', 'a'], ['cap-two', 'b'], ['cap-three', 'c']]) {
  result = run(['take-build', ...args(by), '--checkout', path.join(repos, repo)]); eq(result.code, 0, result.text);
}
eq(held(), ['heavy-build', 'heavy-build-2', 'heavy-build-3', 'heavy-lane-1', 'heavy-lane-2', 'heavy-lane-3']);
for (const id of ['heavy-build', 'heavy-build-2', 'heavy-build-3']) eq(field(id, 'peak_concurrent'), '3');
result = run(['status', 'heavy-build']); ok(result.text.includes('Build capacity: heavy-build 3/3'), result.text);
for (const by of ['cap-three', 'cap-two', 'cap-one']) release(by); eq(held(), []);

// Only the FIFO head seeking the first slot can override new gates. Existing
// build and strict lane-3 gates remain authoritative.
config('LOAD_LIMIT=30\nLOAD_LIMIT_WITH_LANES=30\nMIN_AVAIL_GIB=8\nLOAD_OVERRIDE_MINUTES=20\nLOAD_POLL_SECONDS=15\n');
const oldHead = String(Math.floor(Date.now() / 1000) - 1201);
result = run(['wait-build', ...args('override'), '--checkout', path.join(repos, 'a'), '--timeout', '0'], { RES_TEST_LOAD1M: '18', RES_TEST_LOAD_HEAD_SINCE: oldHead });
eq(result.code, 0, result.text); ok(result.text.includes('load_override=1'), result.text); release('override');
journal = fs.readFileSync(path.join(state, 'log.tsv'), 'utf8'); ok(journal.includes('\tload-override\theavy-build\toverride '), journal);
const overrideCount = journal.split('\n').filter(line => line.includes('\tload-override\t')).length;
result = run(['wait-build', ...args('old-gate'), '--checkout', path.join(repos, 'a'), '--timeout', '0'], { RES_TEST_LOAD1M: '31', RES_TEST_LOAD_HEAD_SINCE: oldHead });
eq(result.code, 2, result.text);
journal = fs.readFileSync(path.join(state, 'log.tsv'), 'utf8');
eq(journal.split('\n').filter(line => line.includes('\tload-override\t')).length, overrideCount);
result = run(['take-build', ...args('concurrent-anchor'), '--checkout', path.join(repos, 'a')]); eq(result.code, 0, result.text);
result = run(['wait-build', ...args('concurrent-no-override'), '--checkout', path.join(repos, 'b'), '--timeout', '0'],
  { RES_TEST_LOAD1M: '9', RES_TEST_LOAD_HEAD_SINCE: oldHead });
eq(result.code, 2, result.text); release('concurrent-anchor');
journal = fs.readFileSync(path.join(state, 'log.tsv'), 'utf8');
eq(journal.split('\n').filter(line => line.includes('\tload-override\t')).length, overrideCount);
for (const [id, by] of [['heavy-lane-1', 'strict-one'], ['heavy-lane-2', 'strict-two']]) {
  result = run(['take', id, ...args(by)]); eq(result.code, 0, result.text);
}
result = run(['wait-build', ...args('strict-no-override'), '--checkout', path.join(repos, 'a'), '--timeout', '0'],
  { RES_TEST_LOAD1M: '9', RES_TEST_LOAD_HEAD_SINCE: oldHead });
eq(result.code, 2, result.text);
for (const [id, by] of [['heavy-lane-1', 'strict-one'], ['heavy-lane-2', 'strict-two']]) eq(run(['return', id, '--by', by]).code, 0);
journal = fs.readFileSync(path.join(state, 'log.tsv'), 'utf8');
eq(journal.split('\n').filter(line => line.includes('\tload-override\t')).length, overrideCount);

// Status exposes load-blocked queued heads without granting occupied capacity.
const children = [];
const start = (by, extra = {}) => {
  const child = spawn(res, ['wait-build', ...args(by), '--checkout', path.join(repos, by === 'fifo-one' ? 'a' : 'b'), '--timeout', '2'],
    { env: { ...baseEnv, RES_TEST_LOAD1M: '18', ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.text = ''; child.stdout.on('data', b => { child.text += b; }); child.stderr.on('data', b => { child.text += b; });
  child.done = new Promise(resolve => child.on('close', code => resolve(code))); children.push(child); return child;
};
const until = async predicate => { const deadline = Date.now() + 45000; while (!predicate()) { if (Date.now() > deadline) throw Error('waiter state timeout'); await new Promise(r => setTimeout(r, 50)); } };
try {
  const first = start('fifo-one'); await until(() => first.text.includes('retry in '));
  const second = start('fifo-two'); await until(() => second.text.includes('retry in '));
  result = run(['status', 'heavy-build']); ok(result.text.includes('blocked=load') && result.text.includes('FIFO'), result.text);
  ok(result.text.indexOf('fifo-one') < result.text.indexOf('fifo-two'), result.text);
} finally {
  for (const child of children) child.kill('SIGTERM');
  for (const child of children) eq(await child.done, 143);
}
eq(held(), []);

config('LOAD_POLL_SECONDS=25\n');
for (const wait of [['wait-lane'], ['wait', 'heavy-lane-1']]) {
  const lane = spawn(res, [...wait, ...args('load-poll'), '--timeout', '1'], {
    env: { ...baseEnv, RES_TEST_LOAD1M: '18' }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  const done = new Promise(resolve => lane.on('close', resolve));
  let stderr = '';
  lane.stderr.on('data', chunk => { stderr += chunk; });
  try {
    await until(() => stderr.includes('retry in '));
    ok(stderr.includes('retry in 25s'), stderr);
    if (wait[0] === 'wait-lane') ok(run(['status', 'heavy-lane-1']).text.includes('blocked=load'));
  } finally {
    lane.kill('SIGTERM');
    await done;
  }
}

clear();
console.log(`ALL ${assertions} ASSERTIONS PASSED`);
