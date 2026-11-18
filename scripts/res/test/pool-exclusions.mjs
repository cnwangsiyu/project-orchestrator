import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(process.env.RES_TEST_ROOT, 'exclusions-'));
const res = process.env.RES_SOURCE;
const mocks = path.join(root, 'bin');
fs.mkdirSync(mocks);
for (const name of ['adb', 'xcrun', 'idevice_id']) fs.writeFileSync(path.join(mocks, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
const env = { ...process.env, RES_DIR: root, PATH: mocks + path.delimiter + process.env.PATH };
const first = '192.0.2.1', free = '192.0.2.2', hard = '192.0.2.3';
const pool = 'devbox-cn', slot = n => `${pool}-${n}`;
const ownerArgs = by => ['--by', by, '--project', 'fixture', '--task', 'placement', '--for', 'scenario', '--pid', String(process.pid)];
const waitArgs = (by, timeout, ...args) => ['wait-pool', pool, ...ownerArgs(by), '--timeout', timeout, '--need', 'node', ...args];
const call = (...args) => spawnSync(res, args, { env, encoding: 'utf8', timeout: 30000 });
const row = (n, host, caps, policy = 'open') => `${slot(n)}\tremote\t${policy}\t-\trunner@${host} caps=${caps}\n`;
let assertions = 0;
const check = (actual, expected) => { assert.equal(actual, expected); assertions++; };
const match = (actual, expected) => { assert.match(actual, expected); assertions++; };
fs.writeFileSync(path.join(root, 'resources.tsv'), row(1, first, 'node') + row(2, free, 'node')
  + row(3, hard, 'node') + row(4, '192.0.2.4', 'android') + row(5, '192.0.2.5', 'node', 'never'));
fs.writeFileSync(path.join(root, 'machine.conf'), 'DEVBOX_SOFT_EXCLUDE_MINUTES=0.01\n');
check(call('take', slot(1), ...ownerArgs('holder')).status, 0);
const filters = ['--exclude-host', free, '--exclude-slot', slot(2), '--hard-exclude-host', hard];
const soft = call(...waitArgs('soft', '0.1', ...filters));
check(soft.status, 0);
match(soft.stderr, /waiting only because of your own exclusions; free matching slots on 192\.0\.2\.2\n/);
match(soft.stderr, /dropped soft exclusions automatically/);
const dropped = JSON.parse(/^softExclusionsDropped=(.*)$/m.exec(soft.stdout)[1]);
check(dropped.hosts[0], free); check(dropped.slots[0], slot(2));
assert.ok(dropped.afterSec >= 0);
match(soft.stdout, /slot=devbox-cn-2/);
check(call('return', slot(2), '--by', 'soft').status, 0);
const journal = fs.readFileSync(path.join(root, 'log.tsv'), 'utf8');
check(journal.match(/waiter-start.*\tsoft \(/g)?.length, 1);

const child = spawn(res, waitArgs('hard', '0.15', ...filters, '--exclude-reason', 'fixture binding'), { env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', data => { output += data; });
const observed = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('wait notice missing')), 10000);
  child.stderr.on('data', data => {
    output += data;
    if (output.includes('waiting only because of your own exclusions')) {
      clearTimeout(timer); resolve();
    }
  });
});
const closed = new Promise(resolve => child.on('close', resolve));
await observed;
const restriction = /hard\s+fixture\/placement.*self_restricted reason=fixture binding free_hosts=192\.0\.2\.2/;
match(call('status', pool).stdout, restriction);
fs.appendFileSync(path.join(root, 'resources.tsv'), 'fixture-device\tphone\tnever\tfixture-id\tsynthetic device\n');
match(call('status').stdout, restriction);
check(await closed, 2);
check(output.includes('softExclusionsDropped='), false);
check(output.match(/waiting only because/g)?.length, 1);

check(call('quarantine', free, '--reason', 'fixture quarantine').status, 0);
const quarantined = call(...waitArgs('quarantined', '0.03', ...filters));
check(quarantined.status, 2);
check(quarantined.stderr.includes('free matching slots'), false);

console.log(`ALL ${assertions} ASSERTIONS PASSED`);
