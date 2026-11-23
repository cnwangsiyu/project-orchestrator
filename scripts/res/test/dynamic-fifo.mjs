#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { strict as baseAssert } from 'node:assert';
import { fileURLToPath } from 'node:url';

let assertions = 0;
const assert = new Proxy(baseAssert, { get(target, name) {
  const value = Reflect.get(target, name);
  return typeof value === 'function' ? (...args) => { assertions++; return value.apply(target, args); } : value;
} });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dynamic-fifo-'));
const source = process.env.RES_SOURCE || fileURLToPath(new URL('../res', import.meta.url));
const env = { ...process.env, RES_DIR: root, RULES_SHARED: root, RES_TEST_POOL_FAST_POLL: '1' };
const host = '192.0.2.1', otherHost = '192.0.2.2';
const lease = n => `devbox-cn-fixture-${n}`;
const registry = `devbox-host-fixture\tremote\topen\t-\trunner@${host} caps=node root=/tmp/runner\n`;
const run = (...args) => spawnSync(source, args, { env, encoding: 'utf8', timeout: 10000 });
const args = by => ['--by', by, '--project', 'fixture', '--task', 'fifo', '--for', 'test', '--pid', String(process.pid)];
const wait = (by, extra = []) => run('wait-pool', 'devbox-cn-light', ...args(by), '--timeout', '0', '--hard-exclude-slot', lease(1), ...extra);
const slot = result => /^slot=(\S+)$/m.exec(result.stdout)?.[1];
const release = (id, by) => { const result = run('return', id, '--by', by); assert.equal(result.status, 0, result.stderr); };
const sample = box => fs.writeFileSync(path.join(root, 'devbox-metrics', box + '.json'), JSON.stringify({
  at: Date.now() / 1000, cores: 8, load5: 0, memAvailableGiB: 64, freeGiB: 2000, io_some_avg60: 0, io_full_avg10: 0,
}));
const queue = path.join(root, 'pool-waiters', 'devbox-cn', 'waiter.older');
const older = { holder: 'large', pid: String(process.pid), host: os.hostname(), order: '00000000000000000001',
  heartbeat: String(Math.floor(Date.now() / 1000)), claim_kind: 'HEAVY', claim_cores: '7', claim_mem: '8', claim_disk: '2',
  need: 'node', input_eligible_slots: lease(1), input_allowed_slots: '', bypasses: '3' };
const publish = () => {
  older.heartbeat = String(Math.floor(Date.now() / 1000));
  fs.writeFileSync(path.join(queue, 'info'), Object.entries(older).map(([name, value]) => `${name}\t${value}\n`).join(''));
};
const resetBypasses = () => {
  fs.rmSync(path.join(root, 'pool-bypasses'), { recursive: true, force: true });
  older.bypasses = '0'; publish();
};
const bypassCount = () => /^bypasses\t(\d+)$/m.exec(fs.readFileSync(path.join(queue, 'info'), 'utf8'))?.[1];
const admit = (by, extra = []) => {
  const result = wait(by, extra); assert.equal(result.status, 0, result.stderr);
  assert.notEqual(slot(result), lease(1)); release(slot(result), by); return slot(result);
};

try {
  fs.mkdirSync(path.join(root, 'devbox-metrics'));
  fs.writeFileSync(path.join(root, 'resources.tsv'), registry);
  fs.writeFileSync(path.join(root, 'machine.conf'), 'DEVBOX_MAX_BYPASS=3\n');
  sample(host);
  // Only ordinal 10 has ever been issued; ordinal 1 exists solely in the
  // older waiter's input eligibility. The younger catalog must stay [2, 10].
  const incumbent = run('take', lease(10), ...args('incumbent'), '--cores', '2', '--mem-gib', '2', '--disk-gib', '2');
  assert.equal(incumbent.status, 0, incumbent.stderr);
  fs.mkdirSync(queue, { recursive: true }); publish();
  const catalog = spawnSync('python3', ['-B', '-c', `
import json, os, re, sys, textwrap
root, source, hard_slots = sys.argv[1:]
locks = os.path.join(root, 'locks')
request, preferred_slot, excluded_slots = 'devbox-cn-light', '', ''
with open(source) as stream: code = stream.read()
definition = code[code.index('    def read_registry():'):code.index('    rows, remote = read_registry()')]
exec(textwrap.dedent(definition))
rows, remote = read_registry()
print(json.dumps([{'slot': slot} for slot in remote if not slot.startswith('devbox-host-')]))
`, root, source, lease(1)], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(catalog.status, 0, catalog.stderr);
  assert.deepEqual(JSON.parse(catalog.stdout).map(row => row.slot).sort(), [lease(10), lease(2)].sort());
  assert.equal(fs.existsSync(path.join(root, 'devbox-leases', lease(1) + '.json')), false);
  const exhausted = wait('uncataloged-exhausted');
  assert.equal(exhausted.status, 2, 'exhausted older unissued ordinal must protect host capacity: ' + exhausted.stderr);
  assert.equal(slot(exhausted), undefined);
  assert.equal(bypassCount(), '3');

  // Missing catalog entries still charge legitimate small bypasses durably.
  resetBypasses();
  for (let index = 1; index <= 3; index++) {
    admit('uncataloged-bypass-' + index);
    assert.equal(bypassCount(), String(index));
  }
  assert.equal(wait('uncataloged-drain').status, 2);
  assert.equal(bypassCount(), '3');
  assert.equal(fs.existsSync(path.join(root, 'devbox-leases', lease(1) + '.json')), false);

  // A fitting head receives capacity before even the first smaller bypass.
  release(lease(10), 'incumbent'); resetBypasses();
  assert.equal(wait('uncataloged-fitting-head').status, 2);
  assert.equal(bypassCount(), '0');

  // Older and younger slot exclusions have independent ordinal namespaces.
  delete older.input_eligible_slots; delete older.input_allowed_slots;
  older.exclude_slots = lease(2); publish();
  assert.equal(wait('independent-exclusions').status, 2);
  delete older.exclude_slots; older.input_eligible_slots = lease(1); publish();

  // Disjoint capabilities and hosts do not consume this head's bypass budget.
  fs.writeFileSync(path.join(root, 'resources.tsv'), registry + `devbox-host-other\tremote\topen\t-\trunner@${otherHost} caps=python root=/tmp/runner\n`);
  sample(otherHost);
  assert.match(admit('disjoint-capabilities', ['--need', 'python']), /^devbox-cn-other-/);
  assert.equal(bypassCount(), '0');
  fs.writeFileSync(path.join(root, 'resources.tsv'), registry);
  older.exclude_hosts = host; publish();
  admit('excluded-host'); assert.equal(bypassCount(), '0');
  delete older.exclude_hosts;
  older.need = 'python'; publish();
  admit('incompatible-head'); assert.equal(bypassCount(), '0');
  older.need = 'node';

  // Explicitly empty input eligibility wins over a nonempty selected-ID field.
  older.input_eligible_slots = ''; older.input_allowed_slots = lease(1); publish();
  admit('empty-input-eligibility'); assert.equal(bypassCount(), '0');
  delete older.input_eligible_slots; older.input_allowed_slots = ''; publish();
  admit('empty-input-selection'); assert.equal(bypassCount(), '0');
  assert.equal(fs.existsSync(path.join(root, 'devbox-leases', lease(1) + '.json')), false);
  console.log(`PASS dynamic FIFO: never-issued input ID, bounded charged bypasses, fitting head, independent exclusions, disjoint capabilities, excluded hosts, empty eligibility`);
  console.log(`ALL ${assertions} ASSERTIONS PASSED`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
