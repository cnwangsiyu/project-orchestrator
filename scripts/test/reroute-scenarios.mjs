#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nextRouteArgs, parseRouteArgs, routeFlag, setRouteFlag } from '../lib/worker-reroute.mjs';

const scripts = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'automatic-reroute-'));
const SOL = 'gpt-6.1-sol', ASTRA = 'gpt-6-astra', now = Date.now(), min = 60000;
const transport = path.join(scripts, 'test/fixtures/reroute-transport.mjs');
const run = (label, config = {}, flags = [], options = {}) => {
  const dir = path.join(tmp, label); fs.mkdirSync(dir);
  const home = path.join(dir, 'home'), traeHome = path.join(home, 'trae'), task = path.join(dir, 'task');
  fs.mkdirSync(traeHome, { recursive: true }); fs.mkdirSync(task);
  const profiles = path.join(dir, 'profiles.json'), cache = path.join(dir, 'quota.json'), log = path.join(dir, 'route.jsonl'), rpc = path.join(dir, 'rpc.jsonl');
  const source = options.source ?? SOL;
  const ttHome = path.join(home, 'tt'); fs.mkdirSync(ttHome);
  fs.writeFileSync(profiles, JSON.stringify({ trae: { kind: 'trae', home: traeHome, hub: 'ws://127.0.0.1:1' },
    ...(options.companyReviews ? { ttadk: { kind: 'ttadk', home: ttHome, hub: 'ws://127.0.0.1:1' } } : {}) }));
  const models = options.noModels ? [] : options.defer ? [SOL, ASTRA] : [SOL, ASTRA, 'gpt-5.6-sol', 'gpt-5.6-terra', 'deepseek-v4.1-flash'];
  const tr = { name: 'trae', kind: 'trae', home: traeHome, healthy: true, live: true, windows: [], models,
    quota: { sampledAt: now, daily: {} }, load: {} };
  const tt = { name: 'ttadk', kind: 'ttadk', home: ttHome, models: options.companyReviews ? ['kimi-k3'] : options.defer ? [SOL] : [],
    healthy: !!options.companyReviews, live: true, reason: options.companyReviews ? null : 'its daily token quota is used up',
    windows: [], usage: { used: options.companyReviews ? 10 : 100, limit: 100, resetsAt: now + 5 * min } };
  fs.writeFileSync(cache, JSON.stringify({ checkedAt: now, claude: [{ label: 'week', used: 10, resetsAt: now + 120 * 60 * min, windowMins: 10080 }],
    codexAccounts: [tt, tr], errors: {}, history: {} }));
  if (options.defer) fs.writeFileSync(path.join(traeHome, 'lane-state.json'), JSON.stringify({ [SOL]: { t: now - 3 * min, state: 'queued', position: 1000, drainPerMin: 0.01 } }));
  fs.writeFileSync(log, JSON.stringify({ t: now, project: 'reroute', name: label, category: 'analysis',
    pick: { vendor: 'codex', model: SOL, effort: 'high', account: 'trae' } }) + '\n');
  if (options.hold) {
    const locks = path.join(dir, 'locks', 'heavy-build.d'); fs.mkdirSync(locks, { recursive: true });
    fs.writeFileSync(path.join(dir, 'resources.tsv'), 'heavy-build\tslot\t1\tbuild\n');
    fs.writeFileSync(path.join(locks, 'info'), `by\t${label}\nproject\treroute\ntask\t${label}\npid\t${process.pid}\n`);
  }
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  for (const cli of ['codex', 'claude']) fs.writeFileSync(path.join(bin, cli), '#!/bin/sh\nprintf \'{"models":[]}\\n\'\n', { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, CODEX_ACCOUNTS: profiles, QUOTA_CACHE: cache,
    ROUTE_LOG_FILE: log, RULES_SHARED: dir, QUOTA_LOG: '0', TRAE_PROBE: '0', ROUTE_RR: path.join(dir, 'rotation'),
    REROUTE_FIXTURE: JSON.stringify({ source, rpc, ...config }) };
  let routeArgs = [options.defer ? 'implement-hard' : 'analysis', ...(options.defer ? ['--impact', 'service'] : []), '--project', 'reroute', '--name', label, '--cwd', dir, '--task-dir', task,
    '--failures', '0', '--exclude-account', 'main,b', ...flags];
  if (options.template) for (const key of ['cwd', 'task-dir']) routeArgs = setRouteFlag(routeArgs, key, null);
  const r = spawnSync(process.execPath, ['--import', transport, path.join(scripts, 'codex-worker.mjs'), '--account', 'trae',
    'start', '--cwd', dir, '--model', source, '--effort', 'high', '--sandbox', 'workspace-write', '--name', label,
    '--route-args', JSON.stringify(routeArgs), '--auto-reroute-depth', String(options.depth ?? 0), '--queue-patience-min', String(options.patience ?? 5),
    ...(options.altStart === undefined ? [] : ['--queue-alt-start-min', String(options.altStart)]),
    '--log', path.join(task, 'worker.jsonl'), '--out', path.join(task, 'final.md'),
    ...(options.workerBackground ? ['--background'] : []), 'Read brief.md and follow it.'],
  { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(r.error, undefined, `${label}: ${r.error?.message}`);
  const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  const calls = fs.readFileSync(rpc, 'utf8').trim().split('\n').map(JSON.parse);
  return { ...r, rows, calls, task, dir, env, routeArgs };
};
try {
  const args = ['review', '--security', '--defensive', '--failures', '2', '--exclude-model', 'gemini', '--exclude-account', 'b', '--sandbox', 'read-only'];
  const next = nextRouteArgs(args, SOL, 1, true);
  assert.equal(routeFlag(next, 'failures'), '2'); assert.equal(routeFlag(next, 'adversarial'), true);
  assert.equal(routeFlag(next, 'defensive'), null); assert.equal(routeFlag(next, 'exclude-model'), `gemini,${SOL}`);
  assert.equal(routeFlag(next, 'exclude-account'), 'b'); assert.equal(routeFlag(next, 'auto-reroute-depth'), '2');
  assert.throws(() => parseRouteArgs('{}')); assert.throws(() => parseRouteArgs('[1]'));
  const hopped = run('queue');
  assert.equal(hopped.status, 0, hopped.stderr + hopped.stdout); assert.match(hopped.stdout, /rerouted:.*queued 90.*waited 2\.0 min/);
  assert.match(fs.readFileSync(path.join(hopped.task, 'final.md'), 'utf8'), /DONE automatic replacement/);
  assert.equal(hopped.calls.filter((c) => c.method === 'turn/interrupt').length, 1);
  const hop = hopped.rows.find((r) => r.kind === 'reroute'); assert.ok(hop.automatic); assert.equal(hop.from.model, SOL);
  assert.ok(hopped.rows.some((r) => r.kind === 'launch' && r.model === hop.to.model));
  const replacement = hopped.calls.find((c) => c.method === 'turn/start' && c.model !== SOL);
  assert.match(replacement.params.input[0].text, /inspect git status\/diff.*continue, don't redo/);
  assert.equal(hopped.calls.filter((c) => c.method === 'thread/start').length, 2, 'replacement gets a fresh thread');
  const template = run('filled-template', {}, [], { template: true });
  assert.equal(template.status, 0, template.stderr + template.stdout);
  assert.ok(template.calls.filter((c) => c.method === 'thread/start').every((c) => c.params.cwd === template.dir));
  assert.ok(fs.existsSync(path.join(template.task, 'reroute.json')), 'runtime task directory survives an initially incomplete route template');
  const earlier = run('earlier-alternative', {}, [], { patience: 30, altStart: 1 });
  assert.equal(earlier.status, 0, earlier.stderr + earlier.stdout); assert.match(earlier.stdout, /> alternative start 1 \(patience 30\)/);
  const outcome = execFileSync(process.execPath, [path.join(scripts, 'outcome.mjs'), '--project', 'reroute', '--name', 'queue', '--result', 'pass'], { env: hopped.env, encoding: 'utf8' });
  assert.match(outcome, /recorded reroute\/queue/);
  const recorded = fs.readFileSync(path.join(hopped.dir, 'route.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).at(-1);
  assert.deepEqual(recorded.actual.map((p) => p.model), [SOL, hop.to.model]); assert.equal(recorded.automaticReroutes, 1);
  execFileSync(process.execPath, [path.join(scripts, 'outcome.mjs'), '--project', 'reroute', '--name', 'queue', '--correct', '--note', 'automatic chain retained'], { env: hopped.env, stdio: 'pipe' });
  const correction = fs.readFileSync(path.join(hopped.dir, 'route.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).at(-1);
  assert.equal(Object.hasOwn(correction, 'actual'), false, 'unrelated metadata corrections preserve the existing actual chain');
  const review = JSON.parse(execFileSync(process.execPath, [path.join(scripts, 'review-data.mjs'), '--json'], { env: hopped.env, encoding: 'utf8' }));
  assert.equal(review.routing.automaticReroutes.count, 1); assert.equal(review.routing.automaticReroutes.faster, 1);
  for (const mode of ['unavailable', 'unavailable-turn', 'restriction', 'restriction-start']) {
    const r = run(mode, { mode }); assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(r.rows.filter((r) => r.kind === 'reroute').length, 1);
  }
  const needsOK = run('needs-ok', {}, [], { noModels: true });
  assert.equal(needsOK.status, 8, needsOK.stderr + needsOK.stdout); assert.match(needsOK.stdout, /reroute-needs-user:/);
  assert.equal(needsOK.calls.filter((c) => c.method === 'thread/start').length, 1);
  const urgent = run('urgent-personal', {}, ['--urgent'], { noModels: true });
  assert.equal(urgent.status, 8); assert.equal(urgent.calls.filter((c) => c.method === 'thread/start').length, 1);
  const signing = run('no-signing-hop', {}, ['--signing']);
  assert.equal(signing.status, 8); assert.equal(signing.calls.filter((c) => c.method === 'thread/start').length, 1);
  const defer = run('deferred', {}, [], { defer: true, source: ASTRA });
  assert.equal(defer.status, 9, defer.stderr + defer.stdout);
  assert.ok(JSON.parse(fs.readFileSync(path.join(defer.task, 'reroute.json'))).route.deferUntil);
  const limited = run('depth-limit', {}, [], { depth: 2 }); assert.equal(limited.status, 10);
  assert.ok(!limited.rows.some((r) => r.kind === 'reroute'));
  const two = run('two-hops', { everyHop: true, mode: 'unavailable' });
  assert.equal(two.status, 10, two.stderr + two.stdout); assert.equal(two.rows.filter((r) => r.kind === 'reroute').length, 2);
  for (const [label, config, flags] of [['executing', { progress: true, complete: true }, []],
    ['background', { complete: true }, ['--background']], ['read-work', { readWork: true, complete: true }, []],
    ['ready-then-requeued', { ready: true, complete: true }, []]]) {
    const r = run(label, config, flags); assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(!r.calls.some((c) => c.method === 'turn/interrupt'), label); assert.ok(!r.rows.some((r) => r.kind === 'reroute'), label);
  }
  const backgroundLaunch = run('background-launch', { complete: true }, [], { workerBackground: true });
  assert.equal(backgroundLaunch.status, 0, backgroundLaunch.stderr + backgroundLaunch.stdout);
  assert.equal(backgroundLaunch.calls.find((c) => c.method === 'turn/start').params.input[0].text, 'Read brief.md and follow it.');
  assert.ok(!backgroundLaunch.calls.some((c) => c.method === 'turn/interrupt'));
  assert.ok(!backgroundLaunch.rows.some((r) => r.kind === 'reroute'));
  for (const cancel of ['silent', 'unconfirmed']) {
    const r = run(`cancel-${cancel}`, { cancel }); assert.equal(r.status, 7, r.stderr + r.stdout);
    assert.match(r.stderr, /queue-cancel-unconfirmed/); assert.ok(!r.rows.some((r) => r.kind === 'reroute'));
  }
  const held = run('held-wrapper', {}, ['--shared-lock'], { hold: true });
  assert.equal(held.status, 7); assert.match(held.stdout, /owning wrapper/);
  assert.ok(fs.existsSync(path.join(held.dir, 'locks/heavy-build.d/info')), 'never release a caller hold');
  const plainPolicy = run('plain-policy', { mode: 'policy' }); assert.equal(plainPolicy.status, 1);
  assert.ok(!plainPolicy.rows.some((r) => r.kind === 'reroute'));
  const policy = run('security-policy', { mode: 'policy' }, ['--security']);
  assert.equal(policy.status, 8, policy.stderr + policy.stdout); assert.match(policy.stdout, /reroute-needs-user:/);
  assert.ok(!policy.calls.some((c) => c.method === 'thread/start' && c.model !== SOL), 'required second opinion approval prevents launch');
  const companyPolicy = run('company-policy', { mode: 'policy' }, ['--security'], { companyReviews: true });
  assert.equal(companyPolicy.status, 0, companyPolicy.stderr + companyPolicy.stdout);
  assert.deepEqual(companyPolicy.calls.filter((c) => c.method === 'thread/start').map((c) => c.model), [SOL, 'kimi-k3', 'deepseek-v4.1-flash']);
  assert.ok(fs.existsSync(path.join(companyPolicy.task, 'reroute-review-1.md')), 'required company second opinion is followed separately');
  const startPolicy = run('start-policy', { mode: 'policy-start' }, ['--security'], { companyReviews: true });
  assert.equal(startPolicy.status, 0, startPolicy.stderr + startPolicy.stdout);
  assert.ok(startPolicy.rows.some((r) => r.kind === 'policy-block'));
  const failedChild = run('failed-child', { childFails: true }); assert.equal(failedChild.status, 1, 'original caller receives child failure');
  console.log('PASS automatic reroutes: queue completion, unavailable/restriction, approval, deferral, depth, work/background guards, cancellation, resource ownership, policy, logs/outcome/nightly');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
