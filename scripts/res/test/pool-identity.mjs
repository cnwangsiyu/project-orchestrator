#!/usr/bin/env node
// Exercise the real post-mkdir transaction with stable FIFO identities in scratch state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function testPoolIdentity({ source = fileURLToPath(new URL('../res', import.meta.url)),
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'res-pool-identity-')) } = {}) {
  const code = fs.readFileSync(source, 'utf8');
  const dispatch = code.lastIndexOf('\ncase "${1:-}" in');
  assert.ok(dispatch > 0);
  const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  let count = 1;
  for (const [name, change, success] of [
    ['same-path', { samePath: true }, true],
    ['expired-current-head', { samePath: true, expireDuringCheck: true }, true],
    ['same-episode-new-path', {}, true],
    ['same-holder-new-order', { order: '00000000000000000002' }, false],
    ['same-order-other-holder', { holder: 'other' }, false],
    ['same-order-other-pid', { pid: 2147483647 }, false],
    ['same-order-other-host', { host: 'other' }, false],
    ['fresh-only-existing-hold', { existing: true }, false],
  ]) {
    const state = path.join(root, name), locks = path.join(state, 'locks');
    const queue = path.join(state, 'pool-waiters/devbox-cn');
    const oldest = path.join(queue, 'waiter.aaa');
    const current = change.samePath ? oldest : path.join(queue, 'waiter.zzz');
    fs.mkdirSync(locks, { recursive: true }); fs.mkdirSync(oldest, { recursive: true });
    if (current !== oldest) fs.mkdirSync(current);
    fs.writeFileSync(path.join(state, 'resources.tsv'),
      'devbox-cn-29\tremote\topen\t-\tfixture runner@192.0.2.1 caps=vak,chromium,docker prefer=chromium\n');
    const stamp = Math.floor(Date.now() / 1000), order = '00000000000000000001';
    const info = `holder\thead\npid\t${process.pid}\nhost\tfixture\norder\t${order}\nheartbeat\t${stamp}\ngate_streak\t0\n`;
    fs.writeFileSync(path.join(oldest, 'info'), info);
    if (current !== oldest) fs.writeFileSync(path.join(current, 'info'), info);
    const existing = 'by\thead\npid\t' + process.pid + '\nhost\tfixture\n';
    const lock = path.join(locks, 'devbox-cn-29.d');
    if (change.existing) { fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'info'), existing); }
    const driver = code.slice(0, dispatch) + `
local_host() { printf 'fixture\\n'; }
# Identity tests isolate TTL; pools.mjs separately exercises heartbeat expiry.
waiter_live() { return 0; }
BY=${quote(change.holder ?? 'head')} PROJECT=fixture TASK=fixture PURPOSE=fixture
UNTIL= NOTE= FORCE= OFFLINE= DEVICE= POLICY= PID=${quote(change.pid ?? process.pid)} PID_EXPLICIT=
pin= ACQUIRE_PID_EXPLICIT= BUILD_WAITER_STAGING= BUILD_WAITER_GATE_STREAK=0
BUILD_WAITER_DIR=${quote(current)} BUILD_WAITER_HOST=${quote(change.host ?? 'fixture')}
BUILD_WAITER_SINCE=now BUILD_WAITER_START=${stamp} BUILD_WAITER_ORDER=${quote(change.order ?? order)}
WAITER_ROOT=${quote(queue)} WAITER_RESOURCE=devbox-cn-any
POOL_ACQUIRE=1 POOL_NEED=vak,chromium,docker excluded_slots= excluded_hosts=
${change.expireDuringCheck ? `eval "$(declare -f box_health | sed '1s/box_health/original_box_health/')"
box_health() {
  original_box_health "$@" || return $?
  if [ "$1" = check ]; then
    sed -i.bak 's/^heartbeat.*/heartbeat\\t1/' "$BUILD_WAITER_DIR/info"
    waiter_live() { return 1; }
    cleanup_build_waiters "$WAITER_ROOT"
    [ -d "$BUILD_WAITER_DIR" ] || return 1
  fi
}
` : ''}
if acquire_attempt pool devbox-cn-29; then exit 0; else exit $?; fi
`;
    const result = spawnSync('/bin/bash', ['-c', driver], {
      env: { ...process.env, RES_DIR: state }, encoding: 'utf8', timeout: 120000,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, success ? 0 : 2, `${name}: ${result.stderr}`); count++;
    assert.equal(result.stdout.includes('slot=devbox-cn-29'), success, name); count++;
    const log = path.join(state, 'log.tsv');
    const actions = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(line => line.split('\t')[1]) : [];
    assert.deepEqual(actions, success ? ['take', 'waiter-acquire'] : change.existing ? [] : ['return'], name); count++;
    assert.equal(fs.existsSync(lock), success || !!change.existing, name); count++;
    if (change.existing) { assert.equal(fs.readFileSync(path.join(lock, 'info'), 'utf8'), existing); count++; }
  }
  return count;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`ALL ${testPoolIdentity()} ASSERTIONS PASSED`);
}
