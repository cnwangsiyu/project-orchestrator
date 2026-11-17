#!/usr/bin/env node
// Scratch remote capacity only: no live registry, devices, hubs or ssh.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const root = path.join(process.env.RES_TEST_ROOT, 'pools');
const state = path.join(root, 'state'), mocks = path.join(root, 'mocks');
fs.mkdirSync(path.join(state, 'locks'), { recursive: true }); fs.mkdirSync(mocks, { recursive: true });
const row = (id, kind = 'remote') => `${id}\t${kind}\topen\t-\tfixture\n`;
fs.writeFileSync(path.join(state, 'resources.tsv'), ['devbox-cn-1', 'devbox-cn-2', 'devbox-cn-3', 'devbox-cn-4', 'devbox-cn-light', 'devbox-cn-light-2'].map(id => row(id)).join('') + row('devbox-cn-6', 'checkout') + row('devbox-cn-special'));
for (const command of ['adb', 'idevice_id', 'xcrun']) fs.writeFileSync(path.join(mocks, command), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
// Any accidental heavy-check must fail, even though remote capacity is free.
fs.writeFileSync(path.join(mocks, 'uname'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
fs.writeFileSync(path.join(mocks, 'ps'), '#!/bin/sh\ncase "$*" in\n  "-p "*) kill -0 "$2" 2>/dev/null || exit 1; echo "$2";;\n  *) exit 2;;\nesac\n', { mode: 0o755 });
fs.writeFileSync(path.join(mocks, 'sleep'), `#!/bin/sh
if [ -n "\${PAUSE_MARK:-}" ] && [ "$1" = 1 ]; then
  touch "$PAUSE_MARK"
  while [ ! -f "$PAUSE_MARK.release" ]; do /bin/sleep 0.02; done
fi
if [ -n "\${SECOND_MARK:-}" ] && [ "$1" = 2 ]; then
  touch "$SECOND_MARK"
  while [ ! -f "$SECOND_MARK.release" ]; do /bin/sleep 0.02; done
fi
exec /bin/sleep 0.03
`, { mode: 0o755 });
const env = { ...process.env, RES_DIR: state, PATH: `${mocks}:${process.env.PATH}` };
const args = (by) => ['--by', by, '--project', by, '--task', 'fixture', '--for', 'remote fixture', '--pid', String(process.pid)];
const locks = () => fs.readdirSync(path.join(state, 'locks')).filter(n => n.endsWith('.d')).sort();
const waiters = (pool = 'devbox-cn') => {
  const dir = path.join(state, 'pool-waiters', pool);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.startsWith('waiter.')).map(n => path.join(dir, n)) : [];
};
const field = (dir, key) => fs.readFileSync(path.join(dir, 'info'), 'utf8').match(new RegExp(`^${key}\\t(.*)$`, 'm'))?.[1];
const owner = id => field(path.join(state, 'locks', `${id}.d`), 'by');
let count = 0;
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); count++; };
const ok = (a, msg) => { assert.ok(a, msg); count++; };
const run = argv => {
  const r = spawnSync(process.env.RES_SOURCE, argv, { env, encoding: 'utf8' });
  if (r.error) throw r.error;
  return { code: r.status, text: `${r.stdout}${r.stderr}` };
};
const take = (id, by = id) => { const r = run(['take', id, ...args(by)]); eq(r.code, 0, r.text); };
const release = (id, by = id) => eq(run(['return', id, '--by', by]).code, 0);
const acquire = (by, pool = 'devbox-cn', extra = []) => run(['wait-pool', pool, ...args(by), '--timeout', '0', ...extra]);
const children = new Set();
function start(by, extra = {}) {
  const child = spawn(process.env.RES_SOURCE, ['wait-pool', 'devbox-cn', ...args(by), '--timeout', '2'], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.text = ''; child.stdout.on('data', b => { child.text += b; }); child.stderr.on('data', b => { child.text += b; });
  child.done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => { children.delete(child); resolve(code); }); });
  children.add(child); return child;
}
async function until(predicate, child) {
  const deadline = Date.now() + 60000;
  while (!predicate()) {
    if (Date.now() > deadline || child && !children.has(child)) throw Error(`scenario did not reach expected state: ${child?.text ?? ''}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const unblock = mark => fs.writeFileSync(`${mark}.release`, 'go');
try {
  for (const id of ['devbox-cn-1', 'devbox-cn-2', 'devbox-cn-3']) take(id);
  const free = acquire('any-free'); eq(free.code, 0, free.text); ok(free.text.includes('slot=devbox-cn-4'));
  eq(owner('devbox-cn-4'), 'any-free'); eq(waiters(), []);
  const before = fs.readFileSync(path.join(state, 'locks/devbox-cn-4.d/info'), 'utf8');
  const again = acquire('any-free', 'devbox-cn-'); eq(again.code, 0); ok(again.text.includes('slot=devbox-cn-4'));
  eq(fs.readFileSync(path.join(state, 'locks/devbox-cn-4.d/info'), 'utf8'), before);
  eq(acquire('wrong-pid', 'missing-pool').code, 1);
  const lightExcluded = acquire('excluded'); eq(lightExcluded.code, 2, lightExcluded.text); eq(waiters(), []);
  eq(locks(), ['devbox-cn-1.d', 'devbox-cn-2.d', 'devbox-cn-3.d', 'devbox-cn-4.d']);
  const light = acquire('light', 'devbox-cn-light'); eq(light.code, 0); ok(light.text.includes('slot=devbox-cn-light')); release('devbox-cn-light', 'light');
  const lightA = acquire('light-a', 'devbox-cn-light'); eq(lightA.code, 0); ok(/slot=devbox-cn-light\n/.test(lightA.text + '\n'));
  const lightB = acquire('light-b', 'devbox-cn-light'); eq(lightB.code, 0, lightB.text); ok(lightB.text.includes('slot=devbox-cn-light-2'));
  release('devbox-cn-light-2', 'light-b'); release('devbox-cn-light', 'light-a');

  const firstMark = path.join(root, 'first'), secondMark = path.join(root, 'second'), retryMark = path.join(root, 'retry');
  const first = start('first', { PAUSE_MARK: firstMark }); await until(() => fs.existsSync(firstMark), first);
  const second = start('second', { PAUSE_MARK: secondMark, SECOND_MARK: retryMark }); await until(() => fs.existsSync(secondMark) && waiters().length === 2, second);
  ok(run(['status', 'devbox-cn-4']).text.includes('Waiting pool devbox-cn:'));
  ok(run(['status']).text.includes('Waiting pool devbox-cn:'));
  release('devbox-cn-4', 'any-free'); unblock(secondMark);
  await until(() => fs.existsSync(retryMark), second); eq(locks().includes('devbox-cn-4.d'), false);
  const jump = run(['take', 'devbox-cn-4', ...args('jump')]); eq(jump.code, 2); ok(jump.text.includes('FIFO'));
  unblock(firstMark); eq(await first.done, 0, first.text); eq(owner('devbox-cn-4'), 'first');
  release('devbox-cn-4', 'first'); unblock(retryMark); eq(await second.done, 0, second.text); eq(owner('devbox-cn-4'), 'second'); eq(waiters(), []);

  const addedMark = path.join(root, 'added'); const added = start('added', { PAUSE_MARK: addedMark });
  await until(() => fs.existsSync(addedMark), added);
  fs.appendFileSync(path.join(state, 'resources.tsv'), row('devbox-cn-5'));
  unblock(addedMark); eq(await added.done, 0, added.text); ok(added.text.includes('slot=devbox-cn-5')); release('devbox-cn-5', 'added'); take('devbox-cn-5');

  const sweepMark = path.join(root, 'sweep'); const swept = start('swept', { PAUSE_MARK: sweepMark });
  await until(() => fs.existsSync(sweepMark), swept);
  const oldDir = waiters()[0], order = field(oldDir, 'order');
  const info = fs.readFileSync(path.join(oldDir, 'info'), 'utf8').replace(/^heartbeat\t.*$/m, 'heartbeat\t1');
  fs.writeFileSync(path.join(oldDir, 'info'), info);
  run(['status', 'devbox-cn-1']); eq(waiters(), []);
  // A younger live waiter stays queued behind the re-published original order.
  const youngerMark = path.join(root, 'younger'); const younger = start('younger', { PAUSE_MARK: youngerMark });
  await until(() => fs.existsSync(youngerMark), younger);
  unblock(sweepMark); await until(() => fs.existsSync(oldDir), swept); eq(field(oldDir, 'order'), order);
  release('devbox-cn-5'); eq(await swept.done, 0, swept.text); eq(owner('devbox-cn-5'), 'swept');
  younger.kill('SIGTERM'); unblock(youngerMark); eq(await younger.done, 143); eq(waiters(), []); release('devbox-cn-5', 'swept'); take('devbox-cn-5');

  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    const child = start(signal); await until(() => waiters().length === 1 && child.text.includes('retry in'), child);
    child.kill(signal); eq(await child.done, code); eq(waiters(), []);
  }
  eq(acquire('timeout').code, 2); eq(waiters(), []);
  const log = fs.readFileSync(path.join(state, 'log.tsv'), 'utf8');
  for (const event of ['start', 'acquire', 'timeout', 'rejoin']) ok(log.includes(`\twaiter-${event}\tdevbox-cn-any\t`));
  eq(locks().filter(n => n.startsWith('heavy-')), []);
  for (const id of ['devbox-cn-1', 'devbox-cn-2', 'devbox-cn-3', 'devbox-cn-5']) release(id);
  release('devbox-cn-4', 'second');
  console.log(`ALL ${count} ASSERTIONS PASSED`);
} finally {
  // Release fixture pause hooks before signalling their parents on failure.
  for (const name of fs.readdirSync(root).filter(n => !n.endsWith('.release'))) {
    if (fs.statSync(path.join(root, name)).isFile()) unblock(path.join(root, name));
  }
  for (const child of children) child.kill('SIGTERM');
  await Promise.all([...children].map(child => child.done));
}
