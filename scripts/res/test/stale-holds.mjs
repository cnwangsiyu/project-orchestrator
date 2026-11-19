#!/usr/bin/env node
// Actual test-owned processes, synthetic holds and SSH-free remote confirmations.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = path.join(process.env.RES_TEST_ROOT, 'stale-holds');
const state = path.join(root, 'state'), bin = path.join(root, 'bin'), checkout = path.join(root, 'checkout');
for (const dir of [bin, checkout, path.join(state, 'locks')]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(state, 'resources.tsv'), 'heavy-lane-1\tslot\topen\t-\tfixture\ndevbox-cn-1\tremote\topen\t-\tfixture runner@192.0.2.1 caps=node\n');
fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\necho Darwin\n', { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\nexec /bin/ps "$@"\n', { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexec /bin/sleep 0.01\n', { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'shlock'), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do case "$1" in -p) p="$2";; -f) f="$2";; esac; shift 2; done\n( set -C; printf "%s\\n" "$p" >"$f" ) 2>/dev/null\n', { mode: 0o755 });
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, RES_DIR: state, RES_TEST_METRICS: '1', RES_TEST_LOAD1M: '0', RES_TEST_PHYSICAL_CORES: '14', RES_TEST_MEMORYSTATUS_LEVEL: '50', RES_TEST_MEMSIZE: '68719476736', RES_TEST_VM_STAT: 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 0.\nPages inactive: 0.\nPages speculative: 0.', RES_TEST_SWAPUSAGE: 'used = 0M', RES_TEST_POOL_FAST_POLL: '1' };
const res = process.env.RES_SOURCE;
let assertions = 0;
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); assertions++; };
const ok = (a, msg) => { assert.ok(a, msg); assertions++; };
const run = (...args) => {
  const r = spawnSync(res, args, { env, encoding: 'utf8', timeout: 30000 });
  if (r.error) throw r.error;
  return { code: r.status, text: `${r.stdout}${r.stderr}` };
};
const dir = id => path.join(state, 'locks', id + '.d');
function hold(id, paths = []) {
  fs.mkdirSync(dir(id), { recursive: true });
  const text = `by\tdead-fixture\ntask\tshared-task-name\npid\t2147483647\nhost\t${os.hostname()}\nstart\t${Math.floor(Date.now() / 1000) - 1000}\ncheckouts\t${JSON.stringify(paths)}\n`;
  fs.writeFileSync(path.join(dir(id), 'info'), text); return text;
}
const claim = id => ['wait', id, '--by', 'next', '--project', 'fixture', '--for', 'fixture', '--pid', String(process.pid), '--timeout', '0'];
const child = spawn('/bin/sleep', ['60'], { cwd: checkout, detached: true, stdio: 'ignore' });
const exited = new Promise(resolve => child.once('exit', resolve));
try {
  hold('heavy-lane-1', [checkout]);
  const refused = run(...claim('heavy-lane-1'));
  eq(refused.code, 2, refused.text);
  ok(refused.text.includes('STALE pid but build processes alive under'), refused.text);
  ok(run('status', 'heavy-lane-1').text.includes('STALE-PID (build alive)'));
  run(...claim('heavy-lane-1'));
  eq(fs.readFileSync(path.join(state, 'log.tsv'), 'utf8').split('\n').filter(line => line.includes('\tstale-build-alive\t')).length, 1);
} finally { child.kill('SIGTERM'); await exited; }
eq(run(...claim('heavy-lane-1')).code, 0, 'exited work allows reclaim');
run('return', 'heavy-lane-1', '--by', 'next');
hold('heavy-lane-1');
eq(run(...claim('heavy-lane-1')).code, 0, 'no checkout metadata retains legacy behavior');
run('return', 'heavy-lane-1', '--by', 'next');

const text = hold('devbox-cn-1');
// Task names are not identities: a different live holder on another slot is irrelevant.
fs.appendFileSync(path.join(state, 'resources.tsv'), 'devbox-cn-2\tremote\topen\t-\tfixture runner@192.0.2.1 caps=node\n');
fs.mkdirSync(dir('devbox-cn-2'));
fs.writeFileSync(path.join(dir('devbox-cn-2'), 'info'), `by\tother-s2-${process.pid}\ntask\tshared-task-name\npid\t${process.pid}\nhost\t${os.hostname()}\nstart\t${Math.floor(Date.now()/1000)-1000}\n`);
const pool = ['wait-pool', 'devbox-cn', '--by', 'next', '--project', 'fixture', '--for', 'fixture', '--pid', String(process.pid), '--timeout', '0'];
const confirmationDir = path.join(state, 'devbox-stale-confirmations'); fs.mkdirSync(confirmationDir);
const receipt = path.join(confirmationDir, 'devbox-cn-1.json');
const confirm = (changes = {}) => fs.writeFileSync(receipt, JSON.stringify({ slot: 'devbox-cn-1', digest: createHash('sha256').update(text).digest('hex'), at: Date.now()/1000, clean: true, target:'runner@192.0.2.1', ...changes }));
confirm(); eq(run(...pool).code, 2, 'heavy reclaim off by default');
fs.writeFileSync(path.join(state, 'machine.conf'), 'DEVBOX_HEAVY_STALE_RECLAIM=1\n');
fs.unlinkSync(receipt); eq(run(...pool).code, 2, 'no SSH confirmation never reclaims');
confirm({ at: Date.now()/1000 - 61 }); eq(run(...pool).code, 2, 'expired proof rejected');
confirm({ digest: 'a'.repeat(64) }); eq(run(...pool).code, 2, 'replacement hold digest rejected');
confirm(); eq(run(...pool).code, 0, 'dead holder reclaims with a different live same-task run on another slot');
ok(fs.readFileSync(path.join(dir('devbox-cn-1'), 'info'), 'utf8').includes('reclaimed_from\tdead-fixture'));
ok(fs.readFileSync(path.join(dir('devbox-cn-2'), 'info'), 'utf8').includes(`by\tother-s2-${process.pid}`),'different same-task live holder remains untouched');
run('return', 'devbox-cn-1', '--by', 'next');
hold('devbox-cn-1'); fs.unlinkSync(receipt);
eq(run('release-dead', 'devbox-cn-1', '--by', 'dead-fixture', '--pid', '2147483647').code, 1);
const current = fs.readFileSync(path.join(dir('devbox-cn-1'), 'info'), 'utf8');
fs.writeFileSync(receipt, JSON.stringify({ slot:'devbox-cn-1', digest:createHash('sha256').update(current).digest('hex'), at:Date.now()/1000, clean:true, target:'runner@192.0.2.1' }));
eq(run('release-dead', 'devbox-cn-1', '--by', 'dead-fixture', '--pid', '2147483647').code, 0);
eq(fs.existsSync(dir('devbox-cn-1')), false);
console.log(`ALL ${assertions} ASSERTIONS PASSED`);
