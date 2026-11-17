#!/usr/bin/env node
// Exercise the real launcher/checker with fixture-only CLIs and account metadata.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { computeNightly } from '../lib/nightly-metrics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'scripts/nightly-review.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-review-'));
const day = '2026-11-14';
const homes = [];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const shellQuote=s=>"'"+String(s).replaceAll("'","'\\''")+"'";

const shim = `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2), home = process.env.HOME, scenario = process.env.FIXTURE_SCENARIO;
const value = (key) => args[args.indexOf(key) + 1];
const q = ${shellQuote.toString()};
const count = (name) => { const f = path.join(home, name); let n = 0; try { n = Number(fs.readFileSync(f)); } catch {} fs.writeFileSync(f, String(++n)); return n; };
fs.appendFileSync(path.join(home, 'calls.jsonl'), JSON.stringify(args) + '\\n');
if (args[0]?.endsWith('/nightly-review.mjs')) {
  const r = spawnSync(${JSON.stringify(process.execPath)}, args, { stdio: 'inherit' }); process.exit(r.status ?? 1);
}
if (args[0]?.endsWith('/route.mjs')) {
  if (args[1] !== 'claude-tools' && scenario === 'deferred') {console.log(JSON.stringify({kind:'defer',deferred:'company accounts unavailable'}));process.exit(0);}
  const vendor=args[1]==='claude-tools'||process.env.NIGHTLY_MODE==='claude'?'claude':'codex';
  const account=vendor==='claude'?'claude':['personal','standing-personal'].includes(scenario)?'personal':scenario.startsWith('ttadk')?'ttadk':'trae';
  const model=vendor==='claude'?(args[1]==='claude-tools'?'sonnet':'opus'):args.includes('--exclude-model')?'second-model':scenario==='seat-shape'?'routed-model':'first-model';
  const effort=vendor==='claude'?'medium':scenario==='seat-shape'?'medium':'high';
  const sandbox=process.env.NIGHTLY_MODE==='dry'?'read-only':scenario==='seat-shape'?'workspace-write':'danger-full-access';
  const taskDir=value('--task-dir'), name=value('--name');
  const workerArgs=['--account',account,'start','--cwd',value('--cwd'),'--sandbox',sandbox,'--effort',effort,'--model',model,'--name',name,
    '--fixture-routed','true','--log',path.join(taskDir,'codex.jsonl'),'--out',path.join(taskDir,'codex-last.md'),
    ...(args.includes('--user-ok')?['--user-ok',value('--user-ok')]:[]),'Read '+path.join(taskDir,'brief.md')+' and follow it.'];
  const launch=vendor==='claude'?['claude','--bg','--remote-control','--permission-mode','bypassPermissions','-n',name,'--model',model,'--effort',effort,
    '--fixture-routed','--fixture-brief',path.join(taskDir,'brief.md'),'Read the fixture brief.']:['node',${JSON.stringify(path.join(root,'scripts/codex-worker.mjs'))},...workerArgs];
  const needsUserOK=args[1]!=='claude-tools'&&(scenario==='gate'||(scenario==='personal'||process.env.NIGHTLY_MODE==='claude')&&!args.includes('--user-ok'))?['approval required']:[];
  console.log(JSON.stringify({kind:needsUserOK.length||scenario==='kind-blocked'?'blocked':'launch',pick:{vendor,model,effort,account,sandbox,workerArgs,command:launch.map(q).join(' ')},needsUserOK}));
  process.exit(0);
}
if (args[0]?.endsWith('/review-data.mjs')) {
  const r = JSON.parse(fs.readFileSync(path.join(home, 'review-fixture.json'), 'utf8'));
  if (scenario !== 'no-findings' && !scenario.startsWith('imbalance')) r.globalRules.unrouted = Array.from({length: 4}, (_, i) => ({ project: 'p', name: 'task-' + i }));
  if (scenario === 'imbalance-unresolved') for (const a of r.globalRules.acknowledgements) a.session = null;
  console.log(JSON.stringify(r)); process.exit(0);
}
if (args[0]?.endsWith('/orch-usage.mjs')) { console.log('{"orchestrators":[]}'); process.exit(0); }
if (args[0]?.endsWith('/resource-review.mjs')) { console.log(fs.readFileSync(path.join(home, 'resource-fixture.json'), 'utf8')); process.exit(0); }
if (!args[0]?.endsWith('/codex-worker.mjs')) { console.log('{}'); process.exit(0); }
const cmd = args[3];
if (cmd === 'status') {
  const n = count('status-count');
  if (scenario === 'uncertain') process.exit(2);
  if (scenario === 'wrong-turn') { console.log(JSON.stringify({ thread: 'another-thread', last: { id: 'another-turn', status: 'inProgress' } })); process.exit(0); }
  if (scenario === 'unknown-hub-status') { console.log(JSON.stringify({ last: { status: 'unknown' } })); process.exit(0); }
  const active = ['stall', 'long'].includes(scenario) || (scenario === 'hub-dies' && n < 2);
  const completed = ['completed-follower', 'result-unavailable', 'result-hangs'].includes(scenario);
  console.log(JSON.stringify({ last: { status: active ? 'inProgress' : completed ? 'completed' : 'failed', error: 'queue infrastructure failure' } }));
  process.exit(0);
}
const attempt = path.dirname(value('--out'));
const n = count(cmd === 'start' ? 'start-count' : 'wait-count');
fs.appendFileSync(value('--log'), JSON.stringify({ fixture: true, command: cmd }) + '\\n');
console.log('thread=fixture-thread-' + path.basename(attempt) + ' turn=fixture-turn');
if (cmd === 'start' && ['stall', 'completed-follower', 'result-unavailable', 'result-hangs'].includes(scenario)) { console.log('stalled: follower only'); process.exit(4); }
if (scenario === 'result-unavailable') { console.error('cannot retrieve completed final result'); process.exit(1); }
if (scenario === 'result-hangs' || (scenario === 'hub-dies' && n === 1)) { setInterval(() => {}, 1000); await new Promise(() => {}); }
if (scenario === 'hub-dies') { console.error('turn failed after hub death'); process.exit(1); }
if (['uncertain', 'wrong-turn', 'unknown-hub-status'].includes(scenario)) { console.error('hub connection closed'); process.exit(1); }
if (scenario === 'policy') { console.error('security-policy-block: cyberPolicy'); process.exit(1); }
if (scenario === 'fail-all' || (scenario === 'fail-once' && n === 1)) { console.error('turn failed: queue infrastructure failure'); process.exit(1); }
if (scenario === 'ttadk-rate' && n === 1) { console.error('rate-limited: retry once'); process.exit(1); }
if (scenario === 'ttadk-quota') { console.error('quota-exhausted: all models exhausted'); process.exit(1); }
if (scenario === 'long') {
  for (const signal of ['SIGALRM', 'SIGTERM', 'SIGINT']) process.on(signal, () => { fs.writeFileSync(path.join(home, 'killed'), signal); process.exit(99); });
  fs.writeFileSync(path.join(attempt, 'progress.json'), JSON.stringify({ stage: 'report', note: '已核对路由，正在写报告', t: new Date().toISOString() }));
  await new Promise((r) => setTimeout(r, 3000));
}
if (scenario !== 'no-report') {
  fs.writeFileSync(value('--out'), 'fixture final report');
  fs.writeFileSync(path.join(attempt, 'report.md'), 'fixture report ' + path.basename(attempt));
  fs.writeFileSync(path.join(attempt, 'notify.json'), JSON.stringify({ actions: [], decisions: ['decisions', 'secretary-relay'].includes(scenario) ? [{id: 'd1', question: '是否调整?', options: [{label: '维持', description: '保留当前策略'}, {label: '调整', description: '另行评估'}], recommended: 0, default: '不回答则保持现状'}] : [] }));
}
console.log('turn completed');
`;

const claudeShim = `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2), home = process.env.HOME;
const scenario = process.env.FIXTURE_SCENARIO;
const registry = path.join(home, 'sessions.json');
const sessions = () => { try { return JSON.parse(fs.readFileSync(registry, 'utf8')); } catch { return []; } };
fs.appendFileSync(path.join(home, 'claude.jsonl'), JSON.stringify(args) + '\\n');
if (args[0] === 'agents') {
  if (scenario === 'imbalance-unresolved') { console.log('[]'); process.exit(0); }
  if (scenario === 'agents-hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); await new Promise(() => {}); }
  if (scenario === 'agents-error') { console.error('fixture session service unavailable'); process.exit(2); }
  if (scenario === 'agents-malformed') { console.log('[null]'); process.exit(0); }
  console.log(JSON.stringify([{name: 'Routing 主对话', sessionId: 'routing-session', project: 'routing'}, {name: 'P 主对话', sessionId: 'p-session', project: 'p'}, {name: '工作秘书 mini', sessionId: scenario === 'secretary-relay' ? undefined : 'secretary-session', host: 'mini'}, ...sessions()])); process.exit(0);
}
if (scenario === 'notify-fail') process.exit(7);
const prompt = args.includes('--fixture-brief')?fs.readFileSync(args[args.indexOf('--fixture-brief')+1],'utf8'):args.at(-1), match = /ack --file '([^']+)'/.exec(prompt);
if (!match) process.exit(9);
const name = args[args.indexOf('-n') + 1];
const session = { id: 'fixture-' + name, sessionId: 'session-' + name, name, state: 'completed' };
const finisher = name.includes('-finish-');
const review = name.endsWith('-attempt-1');
const delayed = finisher && scenario === 'active-finisher';
const missing = finisher && scenario === 'missing-finisher';
const dead = finisher && ['dead-finisher', 'dead-finisher-pid', 'agents-hang', 'agents-error', 'agents-malformed'].includes(scenario) || review && scenario === 'dead-claude';
const unknown = finisher && scenario === 'unknown-finisher';
const liveInactive = finisher && ['live-pid-blocked-finisher', 'live-pid-idle-finisher', 'live-pid-unknown-finisher'].includes(scenario);
const deadStatus = scenario === 'dead-status-sender' && name.includes('-failure-');
if (delayed) {
  const code = 'const fs = require("node:fs"); for (const s of ["SIGTERM", "SIGALRM"]) process.on(s, () => { fs.writeFileSync(' + JSON.stringify(path.join(home, 'session-killed')) + ', s); process.exit(99); }); setTimeout(() => { fs.writeFileSync(' + JSON.stringify(match[1]) + ', JSON.stringify({delivery:"sent"})); }, 3500);';
  const child = spawn(${JSON.stringify(process.execPath)}, ['-e', code], { stdio: 'ignore' }); child.unref();
  session.pid = child.pid; session.state = 'working';
}
if (dead || deadStatus) session.state = 'failed';
if (scenario === 'dead-finisher-pid' && finisher) { session.pid = 2147483647; session.state = 'working'; }
if (unknown) delete session.state;
if (liveInactive) {
  session.pid = Number(process.env.FIXTURE_LIVE_PID);
  session.state = scenario.split('-')[2];
  session.running = true;
}
if (!missing) fs.writeFileSync(registry, JSON.stringify([...sessions().filter((s) => s.id !== session.id), session]));
if (dead || deadStatus || delayed || missing || unknown || liveInactive) { console.log(JSON.stringify(session)); process.exit(0); }
let existing = {}; try { existing = JSON.parse(fs.readFileSync(match[1], 'utf8')); } catch {}
fs.writeFileSync(match[1], JSON.stringify({ ...existing, delivery: 'sent', sentAt: new Date().toISOString() }));
console.log(JSON.stringify(session));
`;

function cleanReview() {
  return {reviews: {window: {byProject: {p: {dispatches: 10, reviews: 1, targetPct: 10, requiredReviews: 0, secondReviewers: 0, reReviews: 0, yield: {blocking: 0, known: 1, unknown: 0}}}}},
    outcomes: {coverage: {completed: 10, autoCompleted: 10}, byVendor: {}}, companyHealth: [],
    globalRules: {unrouted: [], launchMismatches: [], personalQuotaWithoutOK: [], coverage: {decisionsWithoutLaunchEvidence: 0},
      acknowledgements: [{project: 'p', orchestrator: 'P 主对话', session: 'p-session', current: true}, {project: 'routing', orchestrator: 'Routing 主对话', session: 'routing-session', current: true}]}, workerInbox: []};
}
function cleanResources() {
  return {coverage: {coveragePct: 100}, utilisation: {cpu: {meanIdlePct: 50, hoursIdleAbove50WithReadyTasks: 0, hoursOverGate: 0},
    memory: {meanAvailableGiB: 32, minAvailableGiB: 20, pressureHours: 0}, heavyLanes: {occupancyPct: 30}, queue: {hours: 0}, quota: {ttadk: {tokensUnusedAtReset: 0}}}};
}

function fixture(scenario, fixtureDay = day) {
  const home = fs.mkdtempSync(path.join(tmp, `${scenario}-`)); homes.push(home);
  const bin = path.join(home, '.local/bin'); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'node'), shim, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude'), claudeShim, { mode: 0o755 });
  const shared = path.join(home, '.claude/orchestrator/_shared'); fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(path.join(shared, 'resources.tsv'), 'devbox-cn-1\tremote\topen\t-\tfixture\nheavy-lane-1\tslot\topen\t-\tfixture\n');
  const at = ms => new Date(Date.now() - ms).toISOString();
  fs.writeFileSync(path.join(shared, 'log.tsv'), scenario.startsWith('imbalance') ?
    `${at(3600000)}\ttake\theavy-lane-1\tw (p/task)\tfixture\n${at(1800000)}\twaiter-start\theavy-lane-any\tw (p/task)\tpid=1\n${at(60000)}\twaiter-acquire\theavy-lane-any\tw (p/task)\tlane=heavy-lane-1\n` : '');
  fs.writeFileSync(path.join(shared, 'codex-accounts.json'), JSON.stringify({ trae: { kind: 'trae' }, ttadk: { kind: 'ttadk' }, personal: { kind: 'chatgpt' } }));
  fs.writeFileSync(path.join(home, 'review-fixture.json'), JSON.stringify(cleanReview()));
  fs.writeFileSync(path.join(home, 'resource-fixture.json'), JSON.stringify(cleanResources()));
  const baseline = computeNightly({day: fixtureDay, review: cleanReview(), resources: cleanResources()});
  const previous = new Date(`${fixtureDay}T12:00:00`); previous.setDate(previous.getDate() - 1);
  const prevDay = `${previous.getFullYear()}-${String(previous.getMonth()+1).padStart(2,'0')}-${String(previous.getDate()).padStart(2,'0')}`;
  fs.mkdirSync(path.join(shared, 'routing-review'), { recursive: true });
  fs.writeFileSync(path.join(shared, 'routing-review', prevDay + '.metrics.json'), JSON.stringify({unknownClasses: baseline.unknownClasses}));
  const dir = path.join(shared, 'routing-review'), run = path.join(dir, `${fixtureDay}.run`);
  const env = { ...process.env, HOME: home, NIGHTLY_DIR: dir, NIGHTLY_DAY: fixtureDay, NIGHTLY_MODE: 'auto', NIGHTLY_PERSONAL_OK: '0', NIGHTLY_USER_OK:'',
    NIGHTLY_EXCLUDE: '', NIGHTLY_EXCLUDE_MODEL: '', NIGHTLY_DEADLINE: '23:59', NIGHTLY_POLL_MS: '100',
    NIGHTLY_PROBE_MS: '2000', NIGHTLY_RESULT_RETRIES: '2', NIGHTLY_LIVENESS_RETRIES: '3', NIGHTLY_RERUN: '0',
    RULES_SHARED: shared, FIXTURE_SCENARIO: scenario, FIXTURE_LIVE_PID: String(process.pid) };
  // Never allow a caller's live account registry/routing logs to leak into a fixture.
  delete env.CODEX_ACCOUNTS; delete env.ROUTE_LOG_FILE; delete env.CODEX_HOME; delete env.CODEX_HUB;
  const execute = (overrides = {}, args = []) => spawnSync('/bin/zsh', [script, ...args], { env: { ...env, ...overrides }, encoding: 'utf8', timeout: 30000 });
  return { home, dir, run, env, execute, status: () => json(path.join(run, 'status.json')),
    calls: () => fs.readFileSync(path.join(home, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse),
    count: (name) => fs.existsSync(path.join(home, name)) ? Number(fs.readFileSync(path.join(home, name))) : 0 };
}

async function until(test) {
  for (let n = 0; n < 200; n++) { if (test()) return; await delay(25); }
  throw Error('fixture did not reach expected state');
}

try {
  const quiet = fixture('no-findings'); const q = quiet.execute();
  assert.equal(q.status, 0, q.stdout + q.stderr);
  assert.equal(quiet.count('start-count'), 0);
  assert.equal(quiet.calls().filter(a => a[0]?.endsWith('/route.mjs')).length, 0);
  assert.ok(!fs.existsSync(path.join(quiet.home, '.claude/orchestrator/_shared/worker-events.jsonl')));
  assert.match(fs.readFileSync(path.join(quiet.dir, day + '.md'), 'utf8'), /model skipped/);
  const completedCheck = quiet.execute({ NIGHTLY_DEADLINE: '00:00' }, ['--deadline-check']);
  assert.equal(completedCheck.status, 0); assert.ok(!fs.existsSync(path.join(quiet.run, 'deadline-status.json')));
  console.log('PASS no findings: script table only, no route, worker, finisher or messages');

  const imbalance = fixture('imbalance'); const ir = imbalance.execute(); assert.equal(ir.status, 0, ir.stdout + ir.stderr);
  const imbalanceMetrics = json(path.join(imbalance.run, 'attempt-1/metrics.json'));
  assert.deepEqual(imbalanceMetrics.findings.map(f => f.id), ['lane-devbox-imbalance']);
  assert.equal(imbalanceMetrics.needsModel, false); assert.equal(imbalance.count('start-count'), 0);
  assert.equal(imbalance.calls().filter(a => a[0]?.endsWith('/route.mjs')).length, 0);
  const imbalanceEvents = fs.readFileSync(path.join(imbalance.home, '.claude/orchestrator/_shared/worker-events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(imbalanceEvents.length, 1); assert.equal(imbalanceEvents[0].owner, 'p-session');
  assert.match(imbalanceEvents[0].text, /portable \(non-macOS\).*wait-pool devbox-cn/);
  assert.ok(fs.existsSync(path.join(imbalance.run, 'attempt-1/data/log.tsv')));
  assert.match(fs.readFileSync(path.join(imbalance.dir, day + '.md'), 'utf8'), /model skipped/);
  assert.equal(imbalance.execute().status, 0); assert.equal(imbalance.count('start-count'), 0);
  console.log('PASS imbalance-only: frozen resource log, script finding and inbox delivery without any model route');
  const unresolvedImbalance = fixture('imbalance-unresolved'); const ur = unresolvedImbalance.execute();
  assert.equal(ur.status, 1, ur.stdout + ur.stderr); assert.equal(unresolvedImbalance.status().state, 'blocked');
  assert.equal(unresolvedImbalance.calls().filter(a => a[0]?.endsWith('/route.mjs')).length, 0);
  assert.equal(unresolvedImbalance.count('start-count'), 0);
  assert.ok(!fs.existsSync(path.join(unresolvedImbalance.home, '.claude/orchestrator/_shared/worker-events.jsonl')));
  console.log('PASS imbalance-only missing recipient: blocked evidence retained without a fallback model or guessed owner');

  const one = fixture('success'); const r = one.execute(); assert.equal(r.status, 0, r.stdout + r.stderr);
  const brief = fs.readFileSync(path.join(one.run, 'attempt-1/brief.md'), 'utf8');
  assert.match(brief, /"id": "unrouted"/); assert.doesNotMatch(brief, /"id": "review-share|"id": "resource-|finisher/);
  const metrics = json(path.join(one.run, 'attempt-1/metrics.json')); assert.deepEqual(metrics.findings.map(f => f.id), ['unrouted']);
  const events = fs.readFileSync(path.join(one.home, '.claude/orchestrator/_shared/worker-events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.length, 1); assert.equal(events[0].owner, 'p-session'); assert.match(events[0].text, /task-0/);
  assert.equal(one.calls().filter(a => a[1] === 'claude-tools').length, 0);
  assert.match(fs.readFileSync(path.join(one.dir, day + '.md'), 'utf8'), /Metric.*Value[\s\S]*unrouted[\s\S]*Model analysis[\s\S]*fixture report/);
  assert.equal(one.execute().status, 0); assert.equal(one.count('start-count'), 1);
  console.log('PASS one finding only in brief; direct recipient inbox; report includes script plus analysis; idempotent');

  const decisions = fixture('decisions'); assert.equal(decisions.execute().status, 0);
  const delivered = fs.readFileSync(path.join(decisions.home, '.claude/orchestrator/_shared/worker-events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const secretary = delivered.filter(e => e.owner === 'secretary-session'); assert.equal(secretary.length, 1);
  assert.match(secretary[0].text, /维持（推荐）[\s\S]*调整[\s\S]*不回答则保持现状/);
  console.log('PASS one decision message to mini secretary with options, recommendation and explicit default');
  const relay = fixture('secretary-relay'); const relayResult = relay.execute();
  assert.equal(relayResult.status, 0, relayResult.stdout + relayResult.stderr);
  const relayRoutes = relay.calls().filter(a => a[1] === 'claude-tools');
  assert.equal(relayRoutes.length, 1); assert.match(relayRoutes[0][relayRoutes[0].indexOf('--name') + 1], /secretary/);
  assert.equal(json(path.join(relay.run, 'attempt-1/delivery.json')).sent.find(r => r.recipient === '工作秘书 mini').delivery, 'secretary-relay');
  const relayPrompt = fs.readFileSync(path.join(relay.run, 'attempt-1', 'launch-routing-nightly-review-' + day + '-secretary-1/brief.md'), 'utf8');
  assert.match(relayPrompt, /Only relay[\s\S]*不回答则保持现状/);
  assert.doesNotMatch(relayPrompt, /Finish the nightly|AskUserQuestion|PushNotification/);
  console.log('PASS missing secretary session uses one minimal relay, with no ordinary finisher or cards');


  const monday = fixture('no-findings', '2026-11-16'); assert.equal(monday.execute().status, 0);
  assert.equal(monday.count('start-count'), 1);
  assert.match(fs.readFileSync(path.join(monday.run, 'attempt-1/brief.md'), 'utf8'), /weekly-full-review/);
  console.log('PASS Monday full review runs even without metric anomalies');

  for (const scenario of ['stall', 'completed-follower', 'fail-once', 'ttadk-rate']) {
    const f = fixture(scenario), result = f.execute(); assert.equal(result.status, 0, scenario + result.stdout + result.stderr);
    assert.ok(f.count('start-count') >= 1);
    if (scenario === 'stall' || scenario === 'completed-follower') assert.equal(f.count('start-count'), 1, 'reattach accepted worker');
    if (scenario === 'fail-once') assert.ok(f.calls().some(a => a.includes('--exclude-model')));
  }
  console.log('PASS follower reattachment, completed-result recovery and bounded infrastructure retries');

  for (const scenario of ['result-unavailable', 'result-hangs', 'uncertain', 'wrong-turn', 'unknown-hub-status', 'personal', 'gate', 'kind-blocked', 'no-report', 'policy']) {
    const f = fixture(scenario), result = f.execute(); assert.equal(result.status, 1, scenario + result.stdout + result.stderr);
    assert.ok(['blocked', 'failed'].includes(f.status().state));
    if (['personal', 'gate', 'kind-blocked'].includes(scenario)) assert.equal(f.count('start-count'), 0);
    if (['uncertain', 'wrong-turn', 'unknown-hub-status', 'result-unavailable', 'result-hangs'].includes(scenario)) {
      const starts = f.count('start-count'); assert.equal(f.execute().status, 1); assert.equal(f.count('start-count'), starts);
    }
    assert.ok(fs.existsSync(path.join(f.dir, day + '.md')), 'script report survives worker failure');
  }
  console.log('PASS gates, policy blocks, missing reports and unknown/completed turns stop without duplicated accepted work');

  const dead = fixture('dead-lock'); fs.mkdirSync(path.join(dead.run, 'launcher.lock'), { recursive: true });
  fs.writeFileSync(path.join(dead.run, 'launcher.lock/owner.json'), JSON.stringify({pid: 2147483647})); assert.equal(dead.execute().status, 0);
  const busy = fixture('busy-lock'); fs.mkdirSync(path.join(busy.run, 'launcher.lock'), { recursive: true });
  fs.writeFileSync(path.join(busy.run, 'launcher.lock/owner.json'), JSON.stringify({pid: process.pid})); assert.equal(busy.execute().status, 1);
  assert.equal(busy.count('start-count'), 0);
  const plan = fixture('plan'); assert.equal(plan.execute({NIGHTLY_MODE: 'plan'}).status, 0);
  assert.ok(!fs.existsSync(plan.run)); assert.equal(plan.calls().filter(a => a[0]?.endsWith('/route.mjs')).length, 1);
  const dry = fixture('dry'); assert.equal(dry.execute({NIGHTLY_MODE: 'dry'}).status, 0);
  assert.ok(!fs.existsSync(path.join(dry.home, '.claude/orchestrator/_shared/worker-events.jsonl')));
  assert.equal(fixture('invalid').execute({}, ['--typo']).status, 1);
  console.log('PASS dead/live lock ownership, model-free plan, dry delivery and invalid command refusal');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
