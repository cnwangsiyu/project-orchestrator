#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadDigest } from '../lib/global-rules.mjs';
import { nextRouteArgs, parseRouteArgs, routeFlag, setRouteFlag } from '../lib/worker-reroute.mjs';

const scripts = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'automatic-reroute-')));
const SOL = 'gpt-6.1-sol', ASTRA = 'gpt-6-astra', now = Date.now(), min = 60000;
const transport = path.join(scripts, 'test/fixtures/reroute-transport.mjs');
const run = (label, config = {}, flags = [], options = {}) => {
  const dir = path.join(tmp, label); fs.mkdirSync(dir);
  const home = path.join(dir, 'home'), traeHome = path.join(home, 'trae'), task = path.join(dir, 'task');
  fs.mkdirSync(traeHome, { recursive: true }); fs.mkdirSync(task);
  const profiles = path.join(dir, 'profiles.json'), cache = path.join(dir, 'quota.json'), log = path.join(dir, 'route.jsonl'), rpc = path.join(dir, 'rpc.jsonl');
  const guard = path.join(dir, 'auth-guard.jsonl');
  if (options.staleRecovery) fs.writeFileSync(path.join(task, 'reroute.json'),
    JSON.stringify({ t: now - min, depth: 2, status: 'deferred', from: { threadId: 'old-attempt' } }));
  const source = options.source ?? SOL;
  const ttHome = path.join(home, 'tt'); fs.mkdirSync(ttHome);
  fs.writeFileSync(profiles, JSON.stringify({ trae: { kind: 'trae', home: traeHome, hub: 'ws://127.0.0.1:1' },
    ...(config.everyHop || options.peerReady ? { peer:{kind:'trae',home:ttHome,hub:'ws://127.0.0.1:1'} } : {}),
    ...(options.companyReviews || options.canonical ? { ttadk: { kind: 'ttadk', home: ttHome, hub: 'ws://127.0.0.1:1' } } : {}),
    ...(options.authGuard ? { main: { home: path.join(home, 'personal'), hub: 'ws://127.0.0.1:1',
      id: 'public-main-id', email: 'cached@example.com', plan: 'prolite' } } : {}) }));
  const models = options.noModels ? [] : options.defer ? [SOL, ASTRA] : [SOL, ASTRA, 'gpt-5.6-sol', 'gpt-5.6-terra', 'deepseek-v4.1-flash'];
  const tr = { name: 'trae', kind: 'trae', home: traeHome, healthy: true, live: true, windows: [], models,
    quota: { sampledAt: now, daily: options.canonical ? { [SOL]: { depleted: true }, [ASTRA]: { depleted: true } } : {} }, load: {} };
  const tt = { name: 'ttadk', kind: 'ttadk', home: ttHome, models: options.companyReviews ? ['kimi-k3'] : options.defer || options.canonical ? [SOL] : [],
    healthy: !!(options.companyReviews || options.ttReady), live: true, reason: options.companyReviews || options.ttReady ? null : 'its daily token quota is used up',
    windows: [], usage: { used: options.companyReviews || options.ttReady ? 10 : 100, limit: 100, resetsAt: now + 5 * min } };
  fs.writeFileSync(cache, JSON.stringify({ checkedAt: now - (options.expiredCache ? 20 * min : 0), claude: [{ label: 'week', used: 10, resetsAt: now + 120 * 60 * min, windowMins: 10080 }],
    codexAccounts: [tt, tr, ...(config.everyHop || options.peerReady ? [{...tt,name:'peer',kind:'trae',models:[ASTRA],healthy:true,live:true,reason:null,usage:{used:10,limit:100,resetsAt:now+3600000}}] : [])], errors: {}, history: {} }));
  if (options.defer) fs.writeFileSync(path.join(traeHome, 'lane-state.json'), JSON.stringify({ [SOL]: { t: now - 3 * min, state: 'queued', position: 1000, drainPerMin: 0.01 } }));
  if (options.canonical) fs.writeFileSync(path.join(traeHome, 'lane-state.json'), JSON.stringify({
    [ASTRA]: { t: now - 3 * min, state: 'queued', position: 1000, drainPerMin: 0.01 } }));
  fs.writeFileSync(log, JSON.stringify({ t: now, project: 'reroute', name: label, category: 'analysis',
    pick: { vendor: 'codex', model: SOL, effort: 'high', account: 'trae' } }) + '\n');
  if (options.hold) {
    const locks = path.join(dir, 'locks', 'heavy-build.d'); fs.mkdirSync(locks, { recursive: true });
    fs.writeFileSync(path.join(dir, 'resources.tsv'), 'heavy-build\tslot\t1\tbuild\n');
    fs.writeFileSync(path.join(locks, 'info'), `by\t${label}\nproject\treroute\ntask\t${label}\npid\t${process.pid}\n`);
  }
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  for (const cli of ['codex', 'claude']) fs.writeFileSync(path.join(bin, cli), '#!/bin/sh\nprintf \'{"models":[]}\\n\'\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'traecli'), '#!/bin/sh\nprintf \'Not logged in\\n\'\nexit 1\n', { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, CODEX_ACCOUNTS: profiles, QUOTA_CACHE: cache,
    ROUTE_LOG_FILE: log, RULES_SHARED: dir, QUOTA_LOG: '0', TRAE_PROBE: '0', ROUTE_RR: path.join(dir, 'rotation'),
    REROUTE_FIXTURE: JSON.stringify({ source, rpc, ...(options.authGuard ? { authGuard: guard } : {}), ...config }),
    ...(options.authGuard ? { NODE_OPTIONS: `--import=${transport}` } : {}) };
  // The accepted Sol attempt sets a real quality floor. A hard task can move to
  // company Astra; ordinary analysis cannot silently fall to 5.6-Sol or Flash.
  let routeArgs = ['implement-hard', '--impact', 'service', '--project', 'reroute', '--name', label, '--cwd', dir, '--task-dir', task,
    '--failures', '0', '--exclude-account', 'main,b', ...flags];
  if (options.template) for (const key of ['cwd', 'task-dir']) routeArgs = setRouteFlag(routeArgs, key, null);
  const r = spawnSync(process.execPath, ['--import', transport, path.join(scripts, 'codex-worker.mjs'), '--account', 'trae',
    'start', '--cwd', dir, '--model', source, '--effort', 'high', '--sandbox', 'workspace-write', '--name', label,
    '--owner', 'c2987dae-1fac-5a84-a312-a29117f1b8c7',
    '--route-args', JSON.stringify(routeArgs), '--auto-reroute-depth', String(options.depth ?? 0), '--queue-patience-min', String(options.patience ?? 5),
    ...(options.stallMin === undefined ? [] : ['--stall-min', String(options.stallMin)]),
    ...(options.altStart === undefined ? [] : ['--queue-alt-start-min', String(options.altStart)]),
    ...(options.canonical ? ['--queue-alternative', JSON.stringify({ model: SOL, account: 'ttadk', basis: 'reset',
      startDelayMin: 5, routeArgs: [...routeArgs, '--exclude-lane', `trae:${SOL}`] })] : []),
    '--log', path.join(task, 'worker.jsonl'), '--out', path.join(task, 'final.md'),
    ...(options.requireModel ? ['--require-model'] : []),
    ...(options.workerBackground ? ['--background'] : []), 'Read brief.md and follow it.'],
  { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(r.error, undefined, `${label}: ${r.error?.message}`);
  const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  const calls = fs.readFileSync(rpc, 'utf8').trim().split('\n').map(JSON.parse);
  return { ...r, rows, calls, task, dir, env, routeArgs, guard, profiles, cache };
};
try {
  const args = ['review', '--security', '--defensive', '--failures', '2', '--exclude-model', 'gemini', '--exclude-account', 'b', '--sandbox', 'read-only'];
  const next = nextRouteArgs([...args, '--exclude-lane', 'ttadk:gemini', '--fresh'], { model: SOL, account: 'trae' }, 1, true);
  assert.equal(routeFlag(next, 'failures'), '2'); assert.equal(routeFlag(next, 'adversarial'), true);
  assert.equal(routeFlag(next, 'defensive'), null); assert.equal(routeFlag(next, 'exclude-model'), 'gemini');
  assert.equal(routeFlag(next, 'exclude-lane'), `ttadk:gemini,trae:${SOL}`); assert.equal(routeFlag(next, 'fresh'), null);
  assert.equal(routeFlag(next, 'exclude-account'), 'b'); assert.equal(routeFlag(next, 'auto-reroute-depth'), '2');
  assert.throws(() => parseRouteArgs('{}')); assert.throws(() => parseRouteArgs('[1]'));
  const hopped = run('queue');
  assert.equal(hopped.status, 0, hopped.stderr + hopped.stdout); assert.match(hopped.stdout, /rerouted:.*queued 90.*waited 2\.0 min/);
  assert.match(fs.readFileSync(path.join(hopped.task, 'final.md'), 'utf8'), /DONE automatic replacement/);
  assert.equal(hopped.calls.filter((c) => c.method === 'turn/interrupt').length, 1);
  const hop = hopped.rows.find((r) => r.kind === 'reroute'); assert.ok(hop.automatic); assert.equal(hop.from.model, SOL);
  assert.ok(hopped.rows.some((r) => r.kind === 'launch' && r.model === hop.to.model));
  const events = (r) => fs.readFileSync(path.join(r.dir, 'worker-events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events(hopped).some((row) => row.event === 're-routed'));
  assert.ok(events(hopped).some((row) => row.event === 'finished'));
  assert.ok(events(hopped).every((row) => row.owner === 'c2987dae-1fac-5a84-a312-a29117f1b8c7'), 'automatic hops inherit the launcher owner');
  for (const id of new Set(events(hopped).map((row) => row.runId)))
    assert.equal(events(hopped).filter((row) => row.runId === id && row.event !== 'running').length, 1);
  const replacement = hopped.calls.find((c) => c.method === 'turn/start' && c.model !== SOL);
  assert.match(replacement.params.input[0].text, /inspect git status\/diff.*continue, don't redo/);
  assert.equal(hopped.calls.filter((c) => c.method === 'thread/start').length, 2, 'replacement gets a fresh thread');
  for(const call of hopped.calls.filter(c=>c.method==='thread/start'||c.method==='thread/resume'))
    assert.ok(call.params.developerInstructions.includes(loadDigest().worker),'every automatic hop receives all fixed rules');
  const seed = run('continuation-seed', { progress: true, complete: true }, ['--exclude-model', 'gemini'], { depth: 1 });
  const continued = spawnSync(process.execPath, ['--import', transport, path.join(scripts, 'codex-worker.mjs'), '--account', 'trae',
    'turn', '--thread', 'fixture', '--model', SOL, '--effort', 'high', 'Continue the fixture brief.'],
  { env: { ...seed.env, REROUTE_FIXTURE: JSON.stringify({ source: SOL, rpc: path.join(seed.dir, 'rpc.jsonl') }) }, encoding: 'utf8', timeout: 15000 });
  assert.equal(continued.error, undefined); assert.equal(continued.status, 0, continued.stderr + continued.stdout);
  assert.match(continued.stdout, /inherited:.*route-args.*c2987dae-1fac-5a84-a312-a29117f1b8c7/); assert.match(continued.stdout, /rerouted:/);
  const continuedRows = fs.readFileSync(path.join(seed.dir, 'route.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const continuedHop = continuedRows.find((r) => r.kind === 'reroute'); assert.equal(continuedHop.depth, 2);
  const continuationState = JSON.parse(fs.readFileSync(path.join(seed.task, 'reroute.json'), 'utf8'));
  assert.equal(routeFlag(continuationState.routeArgs, 'failures'), '0');
  assert.equal(routeFlag(continuationState.routeArgs, 'exclude-model'), 'gemini');
  assert.equal(routeFlag(continuationState.routeArgs, 'exclude-account'), 'main,b');
  assert.equal(routeFlag(continuationState.routeArgs, 'fresh'), null);
  assert.match(fs.readFileSync(path.join(seed.task, 'final.md'), 'utf8'), /DONE automatic replacement/);
  assert.ok(events(seed).every((row) => row.owner === 'c2987dae-1fac-5a84-a312-a29117f1b8c7'));
  const requiredInfrastructure = run('required-infrastructure', { mode: 'restriction' }, [], { requireModel: true,peerReady:true });
  assert.equal(requiredInfrastructure.status, 0, requiredInfrastructure.stderr + requiredInfrastructure.stdout);
  assert.ok(requiredInfrastructure.rows.some((row) => row.kind === 'reroute'), 'missing execution evidence before work preserves infrastructure handoff');
  assert.equal(requiredInfrastructure.calls.filter(c=>c.method==='thread/start')[1]?.params.model,ASTRA,'infrastructure replacement preserves the hard-family floor');
  const template = run('filled-template', {}, [], { template: true });
  assert.equal(template.status, 0, template.stderr + template.stdout);
  assert.ok(template.calls.filter((c) => c.method === 'thread/start').every((c) => c.params.cwd === template.dir));
  assert.ok(fs.existsSync(path.join(template.task, 'reroute.json')), 'runtime task directory survives an initially incomplete route template');
  const earlier = run('earlier-alternative', {}, [], { patience: 30, altStart: 1 });
  assert.equal(earlier.status, 0, earlier.stderr + earlier.stdout); assert.match(earlier.stdout, /alternative start 1 \(patience 30\)/);
  const plateau = run('forty-minute-plateau', { samples: [[0, 100], [40 * min, 100]] });
  assert.equal(plateau.status, 0, plateau.stderr + plateau.stdout);
  assert.match(plateau.stdout, /elapsed wait 40\.0 min >= patience 5/);
  assert.equal(plateau.calls.filter((c) => c.method === 'turn/interrupt').length, 1);
  const quiet = run('quiet-queue-deadline', { quiet: true }, [], { patience: 0.01 });
  assert.equal(quiet.status, 0, quiet.stderr + quiet.stdout);
  assert.equal(quiet.rows.filter((r) => r.kind === 'reroute').length, 1, 'elapsed alarm is independent of queue notifications');
  const coinciding = run('queue-patience-before-stall', { quiet: true, quietKeepAliveMs: 8000, functionalSetupBudget: true }, [], { patience: 0.075, stallMin: 0.001 });
  assert.equal(coinciding.status, 0, coinciding.stderr + coinciding.stdout);
  assert.equal(coinciding.calls.filter((c) => c.method === 'turn/interrupt').length, 1);
  assert.equal(coinciding.rows.filter((r) => r.kind === 'reroute').length, 1, 'the stall alarm must not terminate a queued patience handoff');
  assert.doesNotMatch(coinciding.stdout, /stalled:/);
  const canonical = run('ttadk-sol-reset', {}, [], { canonical: true });
  assert.equal(canonical.status, 0, canonical.stderr + canonical.stdout);
  const scheduled = JSON.parse(fs.readFileSync(path.join(canonical.task, 'reroute.json')));
  assert.equal(scheduled.route.deferUntil,null);assert.equal(scheduled.route.pick.account,'trae');assert.equal(scheduled.route.pick.model,ASTRA);
  assert.ok(scheduled.route.eta.some((r) => r.account === 'ttadk' && r.model === SOL));
  assert.ok(!routeFlag(scheduled.routeArgs, 'exclude-model')); assert.equal(routeFlag(scheduled.routeArgs, 'exclude-lane'), `trae:${SOL}`);
  assert.equal(canonical.calls.filter((c) => c.method === 'thread/start').length, 2, 'launches a runnable company alternative instead of waiting for reset');
  const sameModel = run('same-model-other-account', {}, [], { canonical: true, ttReady: true });
  assert.equal(sameModel.status, 0, sameModel.stderr + sameModel.stdout);
  assert.deepEqual(sameModel.calls.filter((c) => c.method === 'thread/start').map((c) => [c.account, c.model]),
    [['trae', SOL], ['ttadk', SOL]], 'lane exclusions retain the same model on a ready alternative account');
  const guarded = run('credential-free-refresh', {}, ['--fresh'], { authGuard: true, expiredCache: true });
  assert.equal(guarded.status, 8, guarded.stderr + guarded.stdout);
  execFileSync(process.execPath, [path.join(scripts, 'route.mjs'), 'analysis', '--fresh', '--json'],
    { env: guarded.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
  const guardRows = fs.readFileSync(guarded.guard, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(guardRows.some((r) => r.kind === 'guard-active' && r.pid !== guardRows[0].pid));
  assert.ok(!guardRows.some((r) => r.kind === 'auth-read'), 'neither the worker nor its router/refresh children open credential files');
  const refreshed = JSON.parse(fs.readFileSync(guarded.cache));
  assert.equal(refreshed.codexAccounts.some((r)=>r.name==='main'),false,'routing does not rewrite the public cache from the registry');
  for (const routeFailure of [2, 143, 'json']) {
    const failed = run(`router-failed-${routeFailure}`, { routeFailure }, [], { staleRecovery: routeFailure === 2 });
    assert.equal(failed.status, 7, failed.stderr + failed.stdout);
    assert.equal(failed.calls.filter((c) => c.method === 'turn/interrupt').length, 1);
    const recovery = JSON.parse(fs.readFileSync(path.join(failed.task, 'reroute.json')));
    assert.equal(recovery.status, 'route-failed'); assert.equal(recovery.exitCode, 7);
    assert.equal(recovery.from.threadId, 'fixture'); assert.equal(recovery.from.turnId, 'turn');
    assert.ok(recovery.recovery.routeCommand.includes('--exclude-lane'));
    assert.match(recovery.recovery.continuationPrompt, /inspect git status\/diff.*continue, don't redo/);
    assert.ok(!failed.rows.some((r) => r.kind === 'reroute'));
  }
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
    const r = run(mode, { mode });
    const restricted=mode.startsWith('restriction');
    assert.equal(r.status, restricted?8:0);
    assert.equal(r.rows.filter((r) => r.kind === 'reroute').length, restricted?0:1);
    if(restricted) assert.equal(r.calls.filter(c=>c.method==='thread/start').length,1);
  }
  const needsOK = run('needs-ok', {}, [], { noModels: true });
  assert.equal(needsOK.status, 8, needsOK.stderr + needsOK.stdout); assert.match(needsOK.stdout, /reroute-needs-user:/);
  assert.equal(needsOK.calls.filter((c) => c.method === 'thread/start').length, 1);
  assert.equal(events(needsOK).at(-1).event, 'needs-user');
  const urgent = run('urgent-personal', {}, ['--urgent'], { noModels: true });
  assert.equal(urgent.status, 8); assert.equal(urgent.calls.filter((c) => c.method === 'thread/start').length, 1);
  const signing = run('no-signing-hop', {}, ['--signing']);
  assert.equal(signing.status, 8); assert.equal(signing.calls.filter((c) => c.method === 'thread/start').length, 1);
  const defer = run('deferred', {}, [], { defer: true, source: ASTRA });
  assert.equal(defer.status, 8, defer.stderr + defer.stdout);
  assert.equal(events(defer).at(-1).event, 'needs-user');
  assert.equal(JSON.parse(fs.readFileSync(path.join(defer.task, 'reroute.json'))).route.blocked,true,'Astra cannot defer down to Sol');
  const limited = run('depth-limit', {}, [], { depth: 2 }); assert.equal(limited.status, 10);
  assert.equal(events(limited).at(-1).event, 'failed');
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
  assert.equal(backgroundLaunch.calls.find((c) => c.method === 'turn/start').params.input[0].text,
    `Read ${backgroundLaunch.dir}/brief.md and follow it.`);
  assert.ok(!backgroundLaunch.calls.some((c) => c.method === 'turn/interrupt'));
  assert.ok(!backgroundLaunch.rows.some((r) => r.kind === 'reroute'));
  for (const cancel of ['silent', 'unconfirmed']) {
    const r = run(`cancel-${cancel}`, { cancel }); assert.equal(r.status, 7, r.stderr + r.stdout);
    assert.match(r.stderr, /queue-cancel-unconfirmed/); assert.ok(!r.rows.some((r) => r.kind === 'reroute'));
    assert.equal(events(r).at(-1).event, 'failed');
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
  assert.equal(companyPolicy.status, 8, companyPolicy.stderr + companyPolicy.stdout);
  assert.deepEqual(companyPolicy.calls.filter((c) => c.method === 'thread/start').map((c) => c.model), [SOL],'policy block never launders a GPT attempt into an unproven cross-family quality hop');
  assert.ok(!fs.existsSync(path.join(companyPolicy.task, 'reroute-review-1.md')));
  const startPolicy = run('start-policy', { mode: 'policy-start' }, ['--security'], { companyReviews: true });
  assert.equal(startPolicy.status, 8, startPolicy.stderr + startPolicy.stdout);
  assert.ok(startPolicy.rows.some((r) => r.kind === 'policy-block'));
  const failedChild = run('failed-child', { childFails: true }); assert.equal(failedChild.status, 1, 'original caller receives child failure');
  console.log('PASS automatic reroutes: queue completion, unavailable/restriction, approval, deferral, depth, work/background guards, cancellation, resource ownership, policy, logs/outcome/nightly');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
