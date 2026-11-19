#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function testPoolExec({ source = fileURLToPath(new URL('../res', import.meta.url)),
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'res-pool-exec-')) } = {}) {
  const state = path.join(root, 'state'), mocks = path.join(root, 'mocks'), counts = path.join(root, 'execs');
  fs.mkdirSync(path.join(state, 'locks'), { recursive: true }); fs.mkdirSync(mocks, { recursive: true });
  fs.writeFileSync(path.join(state, 'resources.tsv'), Array.from({ length: 5 }, (_, n) =>
    `devbox-cn-${n + 1}\tremote\topen\t-\tfixture runner@192.0.2.1 caps=vak,chromium,docker prefer=chromium\n`).join(''));
  const notes = path.join(state, 'notes'); fs.mkdirSync(notes);
  fs.writeFileSync(path.join(notes, 'devbox-cn-1.md'), 'fixture note body\n');
  const commands = ['python3', 'awk', 'cut', 'hostname', 'date', 'ps', 'sleep', 'mkdir', 'mv', 'rm', 'mktemp', 'cat', 'sed', 'sort', 'head'];
  for (const command of commands) {
    const real = spawnSync('/bin/sh', ['-c', 'command -v "$1"', '-', command], { encoding: 'utf8' }).stdout.trim();
    assert.ok(path.isAbsolute(real), command);
    fs.writeFileSync(path.join(mocks, command), `#!/bin/sh\nprintf '%s\\n' '${command}' >> "$EXEC_COUNTS"\nexec '${real}' "$@"\n`, { mode: 0o755 });
  }
  const env = { ...process.env, RES_DIR: state, PATH: `${mocks}:${process.env.PATH}`, EXEC_COUNTS: counts };
  const args = by => ['--by', by, '--project', 'fixture', '--task', 'fixture', '--for', 'fixture', '--pid', String(process.pid)];
  let count = commands.length;
  const eq = (a, b, message) => { assert.deepEqual(a, b, message); count++; };
  function run(argv, extra = {}) {
    fs.writeFileSync(counts, '');
    const result = spawnSync(source, argv, { env: { ...env, ...extra }, encoding: 'utf8', timeout: 120000 });
    if (result.error) throw result.error;
    const execs = fs.readFileSync(counts, 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(execs.length <= 3, `${argv[0]} exec budget: ${execs}`); count++;
    eq(execs, ['python3'], `${argv[0]} must use only one interpreter`);
    return result;
  }
  const acquired = run(['wait-pool', 'devbox-cn', ...args('head'), '--need', 'vak,chromium,docker', '--prefer-host', '192.0.2.1', '--timeout', '0'], { RES_TEST_POOL_REJECT: 'expire' });
  eq(acquired.status, 0, acquired.stderr); eq(acquired.stdout.includes('slot=devbox-cn-1'), true);
  const notesBlock = `\n── notes for devbox-cn-1 (${notes}/devbox-cn-1.md) — read before use ──\nfixture note body\n`;
  eq(acquired.stdout, 'took devbox-cn-1\n' + notesBlock + 'slot=devbox-cn-1\n');
  eq(fs.readFileSync(path.join(state, 'log.tsv'), 'utf8').includes('\treturn\tdevbox-cn-1\thead\t'), false);
  const repeated = run(['wait-pool', 'devbox-cn', ...args('head'), '--timeout', '0']);
  eq(repeated.status, 0, repeated.stderr); eq(repeated.stdout.includes('slot=devbox-cn-1'), true);
  const taken = run(['take', 'devbox-cn-2', ...args('direct')]); eq(taken.status, 0, taken.stderr);
  fs.writeFileSync(path.join(state, 'machine.conf'), 'BUILD_MAX_CONCURRENCY=3\n');
  const status = run(['status']); eq(status.status, 0, status.stderr); eq(status.stdout.includes('head (fixture/fixture)'), true);
  eq(/Host 192\.0\.2\.1 heldSlots=2 cores=\? .*cores_source=unknown/.test(status.stdout), true);
  eq(status.stdout.includes('Build capacity: heavy-build 0/3'), true);
  const withNotes = run(['status', 'devbox-cn-1']); eq(withNotes.status, 0, withNotes.stderr); eq(withNotes.stdout.endsWith(notesBlock), true);
  const repeatTake = run(['take', 'devbox-cn-1', ...args('head')]); eq(repeatTake.status, 0, repeatTake.stderr); eq(repeatTake.stdout.endsWith(notesBlock), true);
  const refused = run(['take', 'devbox-cn-2', ...args('other')]); eq(refused.status, 2, refused.stderr);
  fs.rmSync(path.join(state, 'locks/devbox-cn-1.d'), { recursive: true });
  fs.rmSync(path.join(state, 'locks/devbox-cn-2.d'), { recursive: true });
  const rejected = run(['wait-pool', 'devbox-cn', ...args('rollback'), '--timeout', '0'], { RES_TEST_POOL_REJECT: 'all' });
  eq(rejected.status, 2, rejected.stderr); eq(fs.readdirSync(path.join(state, 'locks')), []);
  const journal = fs.readFileSync(path.join(state, 'log.tsv'), 'utf8').trim().split('\n').map(line => line.split('\t'));
  eq(journal.filter(row => row[1] === 'return' && row[3] === 'rollback').length, 3);
  eq(journal.some(row => row[1] === 'waiter-yield' && row[4] === 'rollbacks=3'), true);
  const queue = path.join(state, 'pool-waiters/devbox-cn'), older = path.join(queue, 'waiter.older');
  fs.mkdirSync(older, { recursive: true });
  fs.writeFileSync(path.join(older, 'info'), `holder\tolder\npid\t${process.pid}\nhost\t${os.hostname()}\nheartbeat\t${Math.floor(Date.now() / 1000)}\norder\t00000000000000000001\n`);
  for (let n = 2; n <= 5; n++) fs.mkdirSync(path.join(state, `locks/devbox-cn-${n}.d`));
  const fifo = run(['wait-pool', 'devbox-cn', ...args('younger'), '--timeout', '0']); eq(fifo.status, 2, fifo.stderr);
  eq(fs.readdirSync(path.join(state, 'locks')).sort(), [2, 3, 4, 5].map(n => `devbox-cn-${n}.d`)); eq(fs.existsSync(older), true);
  const jumped = run(['take', 'devbox-cn-3', ...args('jumper')]); eq(jumped.status, 2, jumped.stderr);
  fs.writeFileSync(path.join(older, 'info'), fs.readFileSync(path.join(older, 'info'), 'utf8').replace(/^heartbeat\t.*$/m, `heartbeat\t${Math.floor(Date.now() / 1000) - 120}`));
  const defaults = run(['wait-pool', 'devbox-cn', ...args('ttl-default'), '--timeout', '0'], { RES_WAITER_STALE_SECONDS: undefined });
  eq(defaults.status, 2, defaults.stderr); eq(fs.existsSync(older), true);
  const shortTTL = run(['wait-pool', 'devbox-cn', ...args('ttl-short'), '--timeout', '0'], { RES_WAITER_STALE_SECONDS: '45' });
  eq(shortTTL.status, 0, shortTTL.stderr); eq(fs.existsSync(older), false);
  return count;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(`ALL ${testPoolExec()} ASSERTIONS PASSED`);
