#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export async function testPoolSurplus({ source = fileURLToPath(new URL('../res', import.meta.url)),
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'res-pool-surplus-')) } = {}) {
  const state = path.join(root, 'state'), mocks = path.join(root, 'mocks'), barrier = path.join(root, 'barrier');
  for (const dir of [path.join(state, 'locks'), mocks, barrier]) fs.mkdirSync(dir, { recursive: true });
  const python = spawnSync('/bin/sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout.trim();
  const execLog = path.join(root, 'execs');
  fs.writeFileSync(path.join(mocks, 'python3'), `#!/bin/sh\nprintf '%s\\n' "$POOL_HOLDER" >> "$POOL_EXECS"\nexec '${python}' "$@"\n`, { mode: 0o755 });
  const row = (n, caps = 'node') => `devbox-cn-${n}\tremote\topen\t-\tfixture runner@192.0.2.1 caps=${caps}\n`;
  fs.writeFileSync(path.join(state, 'resources.tsv'), Array.from({ length: 8 }, (_, n) => row(n + 1)).join(''));
  const env = { ...process.env, RES_DIR: state, PATH: `${mocks}:${process.env.PATH}`, POOL_EXECS: execLog };
  const args = holder => ['--by', holder, '--project', 'fixture', '--for', 'parallel fixture', '--pid', String(process.pid)];
  const children = new Set(); let count = 0;
  const eq = (a, b, message) => { assert.deepEqual(a, b, message); count++; };
  const ok = (value, message) => { assert.ok(value, message); count++; };
  function start(holder, extra = {}, options = ['--timeout', '2']) {
    const child = spawn(source, ['wait-pool', 'devbox-cn', ...args(holder), ...options], {
      env: { ...env, POOL_HOLDER: holder, RES_TEST_POOL_CLAIM_BARRIER: barrier, ...extra }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.out = ''; child.err = '';
    child.stdout.on('data', b => { child.out += b; }); child.stderr.on('data', b => { child.err += b; });
    child.done = new Promise((resolve, reject) => {
      child.on('error', reject); child.on('close', code => { children.delete(child); resolve(code); });
    });
    children.add(child); return child;
  }
  const run = argv => {
    const result = spawnSync(source, argv, { env, encoding: 'utf8', timeout: 120000 });
    if (result.error) throw result.error;
    return result;
  };
  async function waitForClaim(dir, child) {
    const deadline = Date.now() + 90000;
    while (fs.readdirSync(dir).length !== 1) {
      if (Date.now() > deadline || !children.has(child)) throw Error('claim did not publish: ' + child.err);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try {
    const burst = Array.from({ length: 8 }, (_, n) => start('burst-' + n));
    const deadline = Date.now() + 90000;
    while (fs.readdirSync(barrier).length !== burst.length) {
      if (Date.now() > deadline || children.size !== burst.length) throw Error('parallel claims did not overlap: ' + burst.map(c => c.err).join('\n'));
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    // Every transaction has mkdir-claimed a different slot before ANY head
    // finishes. A serial head-only implementation cannot reach this barrier.
    eq(fs.readdirSync(path.join(state, 'locks')).filter(n => n.endsWith('.d')).length, 8);
    ok(burst.every(c => !c.out.includes('slot=')));
    fs.writeFileSync(path.join(barrier, 'release'), 'go');
    eq(await Promise.all(burst.map(c => c.done)), Array(8).fill(0), burst.map(c => c.err).join('\n'));
    const slots = burst.map(c => c.out.match(/^slot=(.*)$/m)?.[1]);
    eq(new Set(slots).size, 8); ok(burst.every(c => !c.err.includes('retry in')));
    const calls = fs.readFileSync(execLog, 'utf8').trim().split('\n').sort();
    eq(calls, Array.from({ length: 8 }, (_, n) => 'burst-' + n));
    const log = fs.readFileSync(path.join(state, 'log.tsv'), 'utf8');
    eq(log.split('\n').filter(l => l.includes('\treturn\t')).length, 0);
    eq(log.split('\n').filter(l => l.includes('\twaiter-acquire\t')).length, 8);
    fs.rmSync(path.join(state, 'locks'), { recursive: true }); fs.mkdirSync(path.join(state, 'locks'));

    fs.writeFileSync(path.join(state, 'resources.tsv'), row(1, 'android') + row(2, 'chromium'));
    const queue = path.join(state, 'pool-waiters/devbox-cn'), older = path.join(queue, 'waiter.older');
    fs.mkdirSync(older, { recursive: true });
    const waiter = (holder, order, need) => `holder\t${holder}\npid\t${process.pid}\nhost\t${os.hostname()}\nheartbeat\t${Math.floor(Date.now() / 1000)}\norder\t${order}\nneed\t${need}\n`;
    fs.writeFileSync(path.join(older, 'info'), waiter('older', '00000000000000000001', 'android'));
    const direct = run(['take', 'devbox-cn-1', ...args('direct')]);
    eq(direct.status, 2, direct.stderr); ok(direct.stderr.includes('FIFO'));
    const generic = run(['wait-pool', 'devbox-cn', ...args('generic'), '--prefer-slot', 'devbox-cn-1', '--timeout', '0']);
    eq(generic.status, 0, generic.stderr); ok(generic.stdout.includes('slot=devbox-cn-2'));
    eq(fs.existsSync(path.join(state, 'locks/devbox-cn-1.d')), false);
    fs.rmSync(path.join(state, 'locks/devbox-cn-2.d'), { recursive: true });
    const scarce = run(['wait-pool', 'devbox-cn', ...args('same-caps'), '--need', 'android', '--timeout', '0']);
    eq(scarce.status, 2, scarce.stderr); eq(fs.readdirSync(path.join(state, 'locks')), []);
    const second = path.join(queue, 'waiter.second'); fs.mkdirSync(second);
    fs.writeFileSync(path.join(second, 'info'), waiter('second', '00000000000000000002', 'chromium'));
    const bothReserved = run(['wait-pool', 'devbox-cn', ...args('no-surplus'), '--timeout', '0']);
    eq(bothReserved.status, 2, bothReserved.stderr); eq(fs.readdirSync(path.join(state, 'locks')), []);
    fs.rmSync(second, { recursive: true });
    fs.writeFileSync(path.join(older, 'info'), waiter('older', '00000000000000000001', 'android') + 'exclude_slots\tdevbox-cn-1\n');
    const disjoint = run(['wait-pool', 'devbox-cn', ...args('unblocked'), '--need', 'android', '--timeout', '0']);
    eq(disjoint.status, 0, disjoint.stderr); ok(disjoint.stdout.includes('slot=devbox-cn-1')); eq(fs.existsSync(older), true);
    fs.rmSync(path.join(state, 'locks/devbox-cn-1.d'), { recursive: true });

    // An alternative for the older waiter disappears after the younger claim.
    fs.writeFileSync(path.join(older, 'info'), waiter('older', '00000000000000000001', ''));
    const changed = path.join(root, 'registry-change'); fs.mkdirSync(changed);
    const recheck = start('recheck', { RES_TEST_POOL_CLAIM_BARRIER: changed }, ['--timeout', '0', '--need', 'android']);
    await waitForClaim(changed, recheck);
    fs.writeFileSync(path.join(state, 'resources.tsv'), row(1, 'android') + row(2, 'chromium').replace('\topen\t', '\tnever\t'));
    fs.writeFileSync(path.join(changed, 'release'), 'go');
    eq(await recheck.done, 2, recheck.err);
    eq(fs.readdirSync(path.join(state, 'locks')), []);
    ok(fs.readFileSync(path.join(state, 'log.tsv'), 'utf8').includes('\treturn\tdevbox-cn-1\trecheck\tpool acquisition rollback'));
    fs.writeFileSync(path.join(state, 'resources.tsv'), row(1, 'android') + row(2, 'chromium'));
    fs.writeFileSync(path.join(older, 'info'), waiter('older', '00000000000000000001', 'android') + 'exclude_slots\tdevbox-cn-1\n');

    const foreign = path.join(state, 'locks/devbox-cn-2.d'); fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, 'info'), `by\tcancelled\npid\t${process.pid}\nhost\tforeign-host\n`);
    const cancelBarrier = path.join(root, 'cancel-barrier'); fs.mkdirSync(cancelBarrier);
    const cancelling = start('cancelled', { RES_TEST_POOL_CLAIM_BARRIER: cancelBarrier });
    await waitForClaim(cancelBarrier, cancelling);
    const ownInfo = fs.readFileSync(path.join(state, 'locks/devbox-cn-1.d/info'), 'utf8');
    const foreignInfo = ownInfo.replace(/^host\t.*$/m, 'host\tforeign-host');
    fs.writeFileSync(path.join(foreign, 'info'), foreignInfo);
    cancelling.kill('SIGTERM'); cancelling.kill('SIGTERM');
    eq(await cancelling.done, 143, cancelling.err);
    eq(fs.existsSync(path.join(state, 'locks/devbox-cn-1.d')), false);
    eq(fs.readFileSync(path.join(foreign, 'info'), 'utf8'), foreignInfo);
    eq(fs.readdirSync(queue).filter(name => name.startsWith('waiter.')), ['waiter.older']);
    return count;
  } finally {
    fs.writeFileSync(path.join(barrier, 'release'), 'go');
    for (const child of children) child.kill('SIGTERM');
    await Promise.all([...children].map(c => c.done));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(`ALL ${await testPoolSurplus()} ASSERTIONS PASSED`);
