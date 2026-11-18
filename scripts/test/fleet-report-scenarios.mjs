#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { computeFleet, readFleet, formatFleet, fleetBoxLines } from '../lib/fleet-report.mjs';

const since = Date.parse('2026-11-16T09:00:00-08:00'), now = since + 12 * 3600000;
const registry = [
  'heavy-build\tslot\topen\t-\tbuild mutex', 'heavy-lane-1\tslot\topen\t-\tmini', 'heavy-lane-2\tslot\topen\t-\tmini',
  'devbox-cn-1\tremote\topen\t-\trunner@192.0.2.1 caps=node', 'devbox-cn-2\tremote\topen\t-\trunner@192.0.2.1 caps=node',
  'devbox-cn-3\tremote\topen\t-\trunner@192.0.2.2 caps=node', 'devbox-cn-4\tremote\tnever\t-\trunner@192.0.2.2 caps=node',
].join('\n');
const event = (time, action, id, holder = 'owner (project/task)', detail = '') => `2026-11-16T${time}:00-08:00\t${action}\t${id}\t${holder}\t${detail}`;
const log = [event('08:00', 'take', 'heavy-lane-1'), event('11:00', 'return', 'heavy-lane-1', 'owner'),
  event('13:00', 'take', 'heavy-lane-2'), event('14:00', 'return', 'heavy-lane-2', 'owner'),
  event('13:00', 'take', 'heavy-build'), event('14:00', 'return', 'heavy-build', 'owner'),
  event('08:00', 'take', 'devbox-cn-1'), event('10:00', 'take', 'devbox-cn-1'),
  event('11:00', 'reclaim', 'devbox-cn-1', 'reclaimer'),
  event('12:00', 'take', 'devbox-cn-2'), event('14:00', 'return', 'devbox-cn-2', 'wrong-owner'),
  event('16:00', 'return', 'devbox-cn-2', 'owner'), event('20:00', 'take', 'devbox-cn-3'),
  event('08:55', 'waiter-start', 'devbox-cn-any'), event('09:05', 'waiter-rejoin', 'devbox-cn-any'),
  event('09:10', 'waiter-acquire', 'devbox-cn-any', 'owner (project/task)', 'slot=devbox-cn-1'),
  event('12:00', 'waiter-start', 'devbox-cn-any'), event('12:05', 'waiter-acquire', 'devbox-cn-any', 'owner (project/task)', 'slot=devbox-cn-2'),
  event('19:00', 'waiter-start', 'devbox-cn-any'), event('19:05', 'waiter-timeout', 'devbox-cn-any'),
  event('20:00', 'waiter-start', 'devbox-cn-any'), event('20:30', 'waiter-acquire', 'devbox-cn-any', 'owner (project/task)', 'slot=devbox-cn-3'),
].join('\n');
const probes = { '192.0.2.1': { freeGiB: 40, probedAt: new Date(now - 3600000).toISOString() },
  '192.0.2.2': { freeGiB: 33, probedAt: new Date(now - 25 * 3600000).toISOString() } };
const report = computeFleet({ log, registry, since, now, probes });
const resource = id => report.resources.find(r => r.id === id);
assert.equal(resource('heavy-lane-1').busyHours, 2);
assert.equal(resource('heavy-build').busyHours, 1);
assert.equal(report.totals.mini.busyHours, 3);
assert.equal(report.totals.mini.busyPct, 12.5);
assert.equal(report.totals.devbox.slots, 3);
assert.equal(report.totals.devbox.busyHours, 7);
assert.equal(report.boxes[0].busyHours, 6);
assert.equal(report.boxes[0].busyPct, 25);
assert.equal(report.boxes[0].workIdlePct, 75);
assert.equal(report.boxes[0].diskFreeGiB, 40);
assert.equal(report.boxes[0].diskProbeStale, false);
assert.equal(report.boxes[1].diskProbeStale, true);
assert.equal(resource('devbox-cn-1').takes, 0);
assert.equal(resource('devbox-cn-2').takes, 1);
assert.equal(resource('devbox-cn-3').currentHolders[0].by, 'owner');
assert.deepEqual(report.queues[0], { id: 'devbox-cn-any', count: 3, p50Minutes: 15, p90Minutes: 30, maxMinutes: 30 });
assert.deepEqual(report.boxes[0].waits, { count: 2, p50Minutes: 5, p90Minutes: 15, maxMinutes: 15 });
assert.equal(resource('devbox-cn-2').waits.maxMinutes, 5);
assert.ok(report.recommendations.some(s => s.includes('09:00–21:00 PST')));
assert.ok(report.recommendations.some(s => s.includes('wait p90 30 min')));
assert.match(formatFleet(report), /STALE/);
assert.equal(fleetBoxLines(report).length, 3);

// Split night/work occupancy: only the work-hour reservation enters the alert.
const fullSince = since - 9 * 3600000, fullNow = fullSince + 24 * 3600000;
const overnight = computeFleet({ registry, since: fullSince, now: fullNow, log: [
  event('00:00', 'take', 'devbox-cn-1'), event('09:00', 'return', 'devbox-cn-1', 'owner'),
  event('09:00', 'take', 'devbox-cn-2'), event('15:00', 'return', 'devbox-cn-2', 'owner'),
].join('\n') });
assert.equal(overnight.boxes[0].busyHours, 15);
assert.equal(overnight.boxes[0].workIdlePct, 75);
assert.equal(computeFleet({ registry, log: '', since, now, holders: [] }).boxes[0].diskFreeGiB, null);
assert.equal(computeFleet({ registry, log: 'invalid', since, now, holders: [] }).warnings.length, 1);

// Holder names are opaque; parentheses in --by are not project metadata on return.
const namedHolder = computeFleet({ registry, since, now, log: [
  event('09:00', 'take', 'devbox-cn-1', 'owner (nightly) (project/task)'),
  event('10:00', 'return', 'devbox-cn-1', 'owner (nightly)'),
].join('\n') });
assert.equal(namedHolder.boxes[0].busyHours, 1);
assert.equal(namedHolder.boxes[0].currentHolders.length, 0);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-report-'));
try {
  fs.writeFileSync(path.join(tmp, 'resources.tsv'), registry); fs.writeFileSync(path.join(tmp, 'log.tsv'), log);
  fs.mkdirSync(path.join(tmp, 'locks/devbox-cn-2.d'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'locks/devbox-cn-2.d/info'), 'by\tcurrent\nproject\tfixture\npid\t123\nsince\t2026-11-16 20:00\n');
  fs.writeFileSync(path.join(tmp, 'devbox-hosts.json'), JSON.stringify(probes));
  const disk = readFleet({ directory: tmp, now, since });
  assert.equal(disk.boxes[0].currentHolders[0].by, 'current');
  assert.equal(disk.boxes[1].currentHolders.length, 0);
  assert.equal(disk.boxes[0].diskFreeGiB, 40);
  const before = fs.readdirSync(tmp).sort();
  const cli = args => spawnSync(process.execPath, [new URL('../fleet-report.mjs', import.meta.url).pathname, ...args], {
    env: { ...process.env, RES_DIR: tmp }, encoding: 'utf8' });
  const json = cli(['--hours', '72', '--json']); assert.equal(json.status, 0, json.stderr); assert.equal(JSON.parse(json.stdout).schema, 1);
  for (const args of [['--hours', '0'], ['--hours', 'bad'], ['--since', 'invalid'], ['--hours', '1', '--since', '2026-11-16T00:00:00Z']]) assert.equal(cli(args).status, 1);
  assert.deepEqual(fs.readdirSync(tmp).sort(), before, 'report must remain read-only');
  fs.writeFileSync(path.join(tmp, 'devbox-hosts.json'), '{}');
  assert.equal(readFleet({ directory: tmp, now, since }).boxes[0].diskFreeGiB, null);
  fs.writeFileSync(path.join(tmp, 'devbox-hosts.json'), '{');
  assert.ok(readFleet({ directory: tmp, now, since }).warnings.some(s => s.includes('devbox-hosts.json')));
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log('PASS fleet report: hold replay, FIFO wait durations, PST work hours, totals, disk freshness, read-only CLI');
