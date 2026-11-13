#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attribute, category, commandName, GIB, parseCpu, parseCwd, parsePs, parseSwap, parseVm, readJsonl, readRegistry } from '../lib/resource-data.mjs';
import { appendSample, collect } from '../resource-sample.mjs';
import { review } from '../resource-review.mjs';
const base = path.dirname(fileURLToPath(import.meta.url)), tmp = fs.mkdtempSync(path.join(base, '.resource-test-'));
let checks = 0;
function test(name, f) { return Promise.resolve().then(f).then(() => { checks++; console.log(`PASS ${name}`); }); }
const owner = { project: 'p', task: 'T1', status: 'done', changedAt: 1, activityAt: 1, taskDir: '/tmp/orchestrator/p/tasks/T1' };
const processRow = (i, extra = {}) => ({ pid: 100, ppid: 1, id: '100:start:hash', kind: 'worker', owner, rssBytes: GIB, cpuSeconds: 0, cpuPct: 0, ...extra });
const sample = (i, extra = {}) => ({ schema: 1, host: 'test', t: 10000000 + i * 300000, at: new Date(10000000 + i * 300000).toISOString(), cores: 14, complete: true, processComplete: true, cpu: { user: 10, sys: 10, idle: 80 }, load: [2, 2, 2], memory: { availableBytes: 20 * GIB, pressure: 'normal', swapUsedBytes: 0 }, disk: { freeBytes: 2 * 10 ** 12 - i * GIB }, processes: [processRow(i)], heavyRoots: [], tasks: [], ...extra });
try {
  await test('macOS ps/cwd/CPU/memory parsing', () => {
    const r = parsePs('101 1 501 1-01:30:00 123.4 4096 S 01:12:00 Fri Nov 13 01:00:00 2026 node --token=PRIVATE\n');
    assert.equal(r.errors.length, 0); assert.equal(r.rows[0].elapsedSeconds, 91800); assert.equal(r.rows[0].cpuSeconds, 4320);
    assert.equal(parseCwd('p101\nfcwd\nn/tmp/project\n').get(101), '/tmp/project');
    assert.deepEqual(parseCpu('CPU usage: 1% user, 2% sys, 97% idle\nCPU usage: 10% user, 20% sys, 70% idle'), { user: 10, sys: 20, idle: 70, source: 'top interval (1 second)' });
    assert.equal(parseVm('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 1.\nPages inactive: 2.\nPages speculative: 3.\n').pageHeadroomBytes, 6 * 16384);
    assert.equal(parseVm('malformed'), null); assert.equal(parseSwap('used = 1024.00M'), GIB);
  });
  await test('executable-only privacy and build categories', () => {
    assert.equal(commandName('TOKEN=PRIVATE node -e PRIVATE'), 'unknown');
    assert.equal(commandName('node --api-key PRIVATE'), 'node');
    assert.equal(category('java org.gradle.wrapper.GradleWrapperMain assemble'), 'gradle');
    assert.equal(category('java org.gradle.launcher.daemon.bootstrap.GradleDaemon'), 'daemon');
    assert.equal(category('node --test a.test.ts'), 'node-test');
    assert.equal(category('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless'), 'headless');
  });
  await test('task paths, boundary, worker name, ancestry and ambiguous shared repo', () => {
    const registry = { tasks: [{ ...owner, workers: [] }], mappings: [{ path: '/tmp/repo/.worktrees/T1', project: 'p', task: 'T1' }, { path: '/tmp/shared', project: 'p', task: null }, { path: '/tmp/shared', project: 'q', task: null }] };
    let rows = [{ pid: 10, ppid: 1, cwd: '/tmp/repo/.worktrees/T1/src', _command: 'codex --token=PRIVATE' }, { pid: 11, ppid: 10, _command: 'clang' }, { pid: 12, ppid: 1, cwd: '/tmp/shared', _command: 'node' }, { pid: 13, ppid: 1, cwd: '/tmp/repo/.worktrees/T10', _command: 'node' }];
    let owners = attribute(rows, registry);
    assert.equal(owners.get(10).task, 'T1'); assert.equal(owners.get(11).evidence, 'ancestor:10'); assert.equal(owners.get(12).evidence, 'ambiguous'); assert.equal(owners.get(13).task, null);
    owners = attribute([{ pid: 20, ppid: 1, _command: 'node codex-worker.mjs --name p-T1-fix' }, { pid: 21, ppid: 1, _command: 'node /Users/u/code/.claude-data/orchestrator/q/tasks/T2/build.js' }], registry);
    assert.equal(owners.get(20).task, 'T1'); assert.equal(owners.get(21).project, 'q');
    registry.mappings.push({ path: '/tmp/owned-repo', project: 'p', task: null });
    owners = attribute([{ pid: 30, ppid: 1, cwd: '/tmp/owned-repo/.claude/worktrees/t1-build', _command: 'node' }, { pid: 31, ppid: 30, _command: 'clang' }], registry);
    assert.equal(owners.get(30).task, 'T1'); assert.equal(owners.get(30).evidence, 'inferred-worktree-id');
    assert.equal(owners.get(31).inferred, true);
  });
  await test('actual ledger + explicit metadata + later route reopens finished task', async () => {
    const root = path.join(tmp, 'orchestrator'), dir = path.join(root, 'p'); fs.mkdirSync(path.join(dir, 'tasks', 'T1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'ledger.md'), '- Orchestrator session: "P main"\n### T1\n- status: DONE\n- worktree: /tmp/repo/.worktrees/T1\n');
    fs.writeFileSync(path.join(dir, 'resource-tasks.json'), JSON.stringify({ tasks: [{ task: 'T1', status: 'done', changedAt: 1, paths: ['/tmp/isolated'], workers: ['named-worker'] }] }));
    const route = path.join(tmp, 'route-log.jsonl'); fs.writeFileSync(route, JSON.stringify({ t: Date.now(), project: 'p', name: 'p-T1-fix', kind: 'route' }) + '\n');
    const registry = await readRegistry({ roots: [root], routeFile: route });
    assert.equal(registry.complete, true); assert.equal(registry.tasks[0].status, 'running'); assert.equal(registry.projects[0].orchestrator, 'P main');
    fs.unlinkSync(path.join(dir, 'resource-tasks.json'));
    const outcomeTime = Date.now() - 10000;
    fs.writeFileSync(route, JSON.stringify({ t: outcomeTime, project: 'p', name: 'T1', kind: 'outcome', result: 'pass' }) + '\n');
    let next = await readRegistry({ roots: [root], routeFile: route });
    assert.equal(next.tasks[0].status, 'done'); assert.equal(next.tasks[0].changedAt, outcomeTime);
    for (const kind of ['launch', 'unrouted']) fs.appendFileSync(route, JSON.stringify({ t: outcomeTime + 2, project: 'p', name: 'T1', kind }) + '\n');
    next = await readRegistry({ roots: [root], routeFile: route });
    assert.equal(next.tasks[0].status, 'done'); assert.equal(next.tasks[0].changedAt, outcomeTime);
    fs.appendFileSync(route, JSON.stringify({ t: outcomeTime + 1, project: 'p', name: 'T1', kind: 'route' }) + '\n');
    next = await readRegistry({ roots: [root], routeFile: route }); assert.equal(next.tasks[0].status, 'running');
  });
  await test('sampler keeps raw args transient and collapses compiler children', async () => {
    const registry = { complete: true, errors: [], tasks: [], mappings: [], projects: [] };
    const data = await collect({ registry, leases: { held: [], registered: ['heavy-build', 'heavy-lane-1', 'heavy-lane-2'], complete: true, errors: [] }, journal: { events: [], complete: true, errors: [] }, probe: async (label) => ({ ps: '100 1 501 01:00 0.0 1024 S 00:00 Fri Nov 13 01:00:00 2026 xcodebuild --token=PRIVATE\n101 100 501 01:00 0.0 1024 S 00:00 Fri Nov 13 01:00:00 2026 clang -DPRIVATE\n', cwd: 'p100\nn/tmp/test\n', CPU: 'CPU usage: 10% user, 20% sys, 70% idle', 'memory pages': 'page size of 16384 bytes\nPages free: 1.\nPages inactive: 2.\nPages speculative: 3.\n', 'memory pressure': 'System-wide memory free percentage: 70%', swap: 'used = 0M', memorystatus: '50\n', 'heavy-check': 'load1m=2.00 avail=20.00GiB (memorystatus 50%) pages_headroom=18.00GiB swap_used=0.00GiB gate=OK' })[label] ?? '' });
    assert.equal(data.heavyRoots.length, 1); assert.equal(data.counts.native, 1); assert.equal(data.complete, true); assert.ok(!JSON.stringify(data).includes('PRIVATE')); assert.ok(!JSON.stringify(data).includes('_command'));
  });
  await test('denied, timed-out, malformed probes retain partial UNKNOWN data', async () => {
    const options = { registry: { complete: true, errors: [], tasks: [], mappings: [], projects: [] },
      leases: { held: [], registered: ['heavy-build', 'heavy-lane-1', 'heavy-lane-2'], complete: true, errors: [] },
      journal: { events: [], complete: true, errors: [] } };
    const readings = { ps: '100 1 501 01:00 0.0 1024 S 00:00 Fri Nov 13 01:00:00 2026 xcodebuild archive\n',
      cwd: 'p100\nn/tmp/test\n', CPU: 'CPU usage: 10% user, 20% sys, 70% idle',
      'memory pages': 'page size of 16384 bytes\nPages free: 1.\nPages inactive: 2.\nPages speculative: 3.\n',
      'memory pressure': 'System-wide memory free percentage: 70%', swap: 'used = 0M', memorystatus: '50\n',
      'heavy-check': 'load1m=2.00 avail=20.00GiB (memorystatus 50%) pages_headroom=18.00GiB swap_used=0.00GiB gate=OK',
      'hub listeners': { stdout: '', exitCode: 1 }, ccache: 'Hits: 0\nMisses: 10\n' };
    const healthy = await collect({ ...options, probe: (label) => readings[label] });
    assert.equal(healthy.complete, true); assert.deepEqual(healthy.failedProbes, []);
    for (const label of ['ps', 'cwd', 'CPU', 'memory pages', 'memory pressure', 'swap', 'memorystatus', 'heavy-check', 'hub listeners']) {
      for (const failure of ['denied', 'timeout', 'malformed', 'invalid']) {
        const data = await collect({ ...options, probe: (name) => {
          if (name !== label) return readings[name];
          if (failure === 'invalid') return null;
          if (failure === 'malformed') return 'not a probe reading';
          throw Object.assign(Error('PRIVATE raw diagnostic'), { code: 'EPERM', killed: failure === 'timeout', stderr: 'PRIVATE' });
        } });
        assert.equal(data.complete, false, `${label} ${failure}`);
        assert.ok(data.failedProbes.includes(label), `${label} ${failure}`);
        assert.ok(data.errors.some((s) => s.startsWith(label + ':')));
        assert.ok(!JSON.stringify(data).includes('PRIVATE'));
        if (label === 'ps') { assert.equal(data.processComplete, false); assert.equal(data.counts.xcodebuild, null); assert.equal(data.chrome.state, 'unknown'); }
        if (label === 'memorystatus') assert.equal(data.memory.availableBasis, 'free+inactive+speculative (estimate)');
        if (label === 'heavy-check') assert.equal(data.heavyGate.state, 'UNKNOWN');
        if (label === 'hub listeners') assert.equal(data.hubs.state, 'UNKNOWN');
      }
    }
    const blocked = await collect({ ...options, probe: (label) => {
      if (['ps', 'CPU', 'swap', 'memorystatus'].includes(label)) throw Object.assign(Error('PRIVATE'), { code: 'EPERM' });
      return readings[label];
    } });
    assert.equal(blocked.complete, false); assert.equal(blocked.cpu, null); assert.equal(blocked.memory.swapUsedBytes, null);
    assert.deepEqual(new Set(blocked.failedProbes), new Set(['ps', 'CPU', 'swap', 'memorystatus']));
    assert.ok(blocked.disk.freeBytes > 0); assert.equal(blocked.hubs.state, 'ALL_MISSING');
  });
  await test('synthetic 24h utilisation, overlapping roots and owner shares', () => {
    const logs = Array.from({ length: 289 }, (_, i) => sample(i, { processes: [processRow(i, { kind: 'xcodebuild', cpuSeconds: i * 30 })], tasks: [{ project: 'p', task: 'T2', status: 'queued', ready: true, waitReason: 'heavy-build' }], heavyRoots: [{ id: 'a', pid: 100, kind: 'xcodebuild', owner }, { id: 'b', pid: 200, kind: 'gradle', owner: { project: 'q', task: 'T3' } }] }));
    const r = review(logs, { hours: 24, now: logs.at(-1).t });
    assert.equal(r.coverage.coveragePct, 100); assert.equal(r.utilisation.underuseMinutes, 1440); assert.equal(r.resourceShares[0].sampledCpuSeconds, 8640); assert.equal(r.badCases.find((c) => c.type === 'overlapping_package_builds').minutes, 1440);
    assert.equal(r.diskTrend.changeBytes, -288 * GIB);
    logs[0].heavyRoots.push({ id: 'c', pid: 300, kind: 'native', owner: { project: 'r', task: 'T4' } });
    assert.ok(review(logs, { hours: 24, now: logs.at(-1).t }).badCases.some((c) => c.type === 'overlapping_heavy_workloads'));
  });
  await test('contention, possible under-use vs network wait, no implicit readiness', () => {
    const a = sample(0, { load: [20, 2, 2], memory: { availableBytes: 8 * GIB, pressure: 'warning', swapUsedBytes: 0 }, tasks: [{ project: 'p', task: 'T2', status: 'waiting' }] });
    const r = review([a, sample(1)], { now: sample(1).t });
    assert.ok(r.badCases.some((c) => c.type === 'contention')); assert.ok(r.badCases.some((c) => c.type === 'possible_underuse')); assert.equal(r.utilisation.underuseMinutes, 0);
    a.tasks[0].waitReason = 'network'; assert.equal(review([a, sample(1)], { now: sample(1).t }).utilisation.possibleUnderuseMinutes, 0);
  });
  await test('continuous idle/Chrome evidence, gaps and PID reuse reset duration', () => {
    const logs = Array.from({ length: 25 }, (_, i) => sample(i));
    let r = review(logs, { now: logs.at(-1).t }); assert.ok(r.badCases.some((c) => c.type === 'idle_worker')); assert.ok(r.badCases.some((c) => c.type === 'possible_orphan_tree'));
    r = review(logs.filter((_, i) => i < 5 || i > 10), { now: logs.at(-1).t }); assert.ok(!r.badCases.some((c) => c.type === 'idle_worker')); assert.equal(r.coverage.gaps, 1);
    r = review(logs.map((s, i) => ({ ...s, processes: [processRow(i, { id: i < 12 ? 'old' : 'reused' })] })), { now: logs.at(-1).t }); assert.ok(!r.badCases.some((c) => c.type === 'idle_worker'));
    const chrome = Array.from({ length: 13 }, (_, i) => sample(i, { processes: [processRow(i, { kind: 'chrome', cpuSeconds: i * 600 })] }));
    assert.ok(review(chrome, { now: chrome.at(-1).t }).badCases.some((c) => c.type === 'suspected_hung_chrome'));
    const simulators = logs.map((s) => ({ ...s, processes: s.processes.map((p) => ({ ...p, kind: 'simulator' })) }));
    assert.ok(review(simulators, { now: simulators.at(-1).t }).badCases.some((c) => c.type === 'simulator_left_running'));
  });
  await test('missing/incomplete data is not zero use; no extrapolation or mixed hosts', () => {
    const r = review([sample(0, { complete: false, cpu: null, processComplete: false, processes: [] }), sample(1, { complete: false, cpu: null, processComplete: false, processes: [] })], { now: sample(1).t });
    assert.equal(r.utilisation.meanCpuIdlePct, null); assert.equal(r.coverage.processMinutes, 0); assert.equal(r.resourceShares.length, 0);
    assert.equal(review([sample(0)], { now: sample(1).t }).coverage.observedMinutes, 0);
    assert.equal(review([sample(0)], { now: sample(1).t }).diskTrend, null);
    assert.equal(review([sample(0), sample(1, { host: 'other' })], { now: sample(1).t }).coverage.observedMinutes, 0);
  });
  await test('rotation preserves records, review reads archives, locks fail closed', async () => {
    const file = path.join(tmp, 'resource-log.jsonl'); appendSample(sample(0), file, { maxBytes: 1000 }); appendSample(sample(1), file, { maxBytes: 1000 });
    assert.ok(fs.existsSync(file + '.1')); const read = await readJsonl([file, file + '.1']); assert.equal(read.rows.length, 2); assert.equal(read.errors.length, 0);
    fs.writeFileSync(file + '.lock', ''); assert.throws(() => appendSample(sample(2), file), /lock/); fs.unlinkSync(file + '.lock');
    assert.throws(() => appendSample(sample(2), path.join(tmp, 'cookies.jsonl')), /refused/);
  });
  console.log(`resource scenarios: ${checks} groups all pass`);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
