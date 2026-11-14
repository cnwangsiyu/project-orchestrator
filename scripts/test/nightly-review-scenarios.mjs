#!/usr/bin/env node
// Exercise the real launcher/checker with fixture-only CLIs and account metadata.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'scripts/nightly-review.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-review-'));
const day = '2026-11-14';
const homes = [];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

const shim = `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2), home = process.env.HOME, scenario = process.env.FIXTURE_SCENARIO;
const value = (key) => args[args.indexOf(key) + 1];
const count = (name) => { const f = path.join(home, name); let n = 0; try { n = Number(fs.readFileSync(f)); } catch {} fs.writeFileSync(f, String(++n)); return n; };
fs.appendFileSync(path.join(home, 'calls.jsonl'), JSON.stringify(args) + '\\n');
if (args[0]?.endsWith('/nightly-review.mjs')) {
  const r = spawnSync(${JSON.stringify(process.execPath)}, args, { stdio: 'inherit' }); process.exit(r.status ?? 1);
}
if (args[0]?.endsWith('/route.mjs')) {
  if (args[1] === 'claude-tools') console.log(JSON.stringify({ pick: { vendor: 'claude', model: 'sonnet', effort: 'medium' } }));
  else if (scenario === 'deferred') console.log(JSON.stringify({ deferred: 'company accounts unavailable' }));
  else {
    const account = scenario === 'personal' ? 'personal' : scenario.startsWith('ttadk') ? 'ttadk' : 'trae';
    console.log(JSON.stringify({ pick: { vendor: 'codex', model: args.includes('--exclude-model') ? 'second-model' : 'first-model', effort: 'high', account },
      needsUserOK: scenario === 'gate' ? ['approval required'] : [] }));
  }
  process.exit(0);
}
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
  fs.writeFileSync(path.join(attempt, 'notify.json'), JSON.stringify({ changed: false, decisions: [], actions: [] }));
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
  if (scenario === 'agents-hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); await new Promise(() => {}); }
  if (scenario === 'agents-error') { console.error('fixture session service unavailable'); process.exit(2); }
  if (scenario === 'agents-malformed') { console.log('[null]'); process.exit(0); }
  console.log(JSON.stringify(sessions())); process.exit(0);
}
if (scenario === 'notify-fail') process.exit(7);
const prompt = args.at(-1), match = /ack --file '([^']+)'/.exec(prompt);
if (!match) process.exit(9);
const name = args[args.indexOf('-n') + 1];
const session = { id: 'fixture-' + name, sessionId: 'session-' + name, name, state: 'completed' };
const finisher = name.includes('-finish-');
const review = name.endsWith('-attempt-1');
const delayed = finisher && scenario === 'active-finisher';
const missing = finisher && scenario === 'missing-finisher';
const dead = finisher && ['dead-finisher', 'dead-finisher-pid', 'agents-hang', 'agents-error', 'agents-malformed'].includes(scenario) || review && scenario === 'dead-claude';
const unknown = finisher && scenario === 'unknown-finisher';
const deadStatus = scenario === 'dead-status-sender' && name.includes('-failure-');
if (delayed) {
  const code = 'const fs = require("node:fs"); for (const s of ["SIGTERM", "SIGALRM"]) process.on(s, () => { fs.writeFileSync(' + JSON.stringify(path.join(home, 'session-killed')) + ', s); process.exit(99); }); setTimeout(() => { fs.writeFileSync(' + JSON.stringify(match[1]) + ', JSON.stringify({delivery:"sent"})); }, 3500);';
  const child = spawn(${JSON.stringify(process.execPath)}, ['-e', code], { stdio: 'ignore' }); child.unref();
  session.pid = child.pid; session.state = 'working';
}
if (dead || deadStatus) session.state = 'failed';
if (scenario === 'dead-finisher-pid' && finisher) { session.pid = 2147483647; session.state = 'working'; }
if (unknown) delete session.state;
if (!missing) fs.writeFileSync(registry, JSON.stringify([...sessions().filter((s) => s.id !== session.id), session]));
if (dead || deadStatus || delayed || missing || unknown) { console.log(JSON.stringify(session)); process.exit(0); }
let existing = {}; try { existing = JSON.parse(fs.readFileSync(match[1], 'utf8')); } catch {}
fs.writeFileSync(match[1], JSON.stringify({ ...existing, delivery: 'sent', sentAt: new Date().toISOString() }));
console.log(JSON.stringify(session));
`;

function fixture(scenario) {
  const home = fs.mkdtempSync(path.join(tmp, `${scenario}-`)); homes.push(home);
  const bin = path.join(home, '.local/bin'); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'node'), shim, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude'), claudeShim, { mode: 0o755 });
  const shared = path.join(home, '.claude/orchestrator/_shared'); fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(path.join(shared, 'codex-accounts.json'), JSON.stringify({ trae: { kind: 'trae' }, ttadk: { kind: 'ttadk' }, personal: { kind: 'chatgpt' } }));
  const dir = path.join(shared, 'routing-review'), run = path.join(dir, `${day}.run`);
  const env = { ...process.env, HOME: home, NIGHTLY_DIR: dir, NIGHTLY_DAY: day, NIGHTLY_MODE: 'auto', NIGHTLY_PERSONAL_OK: '0',
    NIGHTLY_EXCLUDE: '', NIGHTLY_EXCLUDE_MODEL: '', NIGHTLY_DEADLINE: '23:59', NIGHTLY_POLL_MS: '100',
    NIGHTLY_PROBE_MS: '2000', NIGHTLY_RESULT_RETRIES: '2', NIGHTLY_LIVENESS_RETRIES: '3', NIGHTLY_RERUN: '0', FIXTURE_SCENARIO: scenario };
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
  const long = fixture('long');
  const child = spawn('/bin/zsh', [script], { env: long.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', (d) => { output += d; }); child.stderr.on('data', (d) => { output += d; });
  const ended = new Promise((r) => child.on('exit', (code) => r(code)));
  await until(() => { try { return long.status().stage === 'report' && long.status().worker.state === 'running'; } catch { return false; } });
  const check = long.execute({ NIGHTLY_DEADLINE: '00:00' }, ['--deadline-check']);
  assert.equal(check.status, 0, check.stderr);
  const deadline = json(path.join(long.run, 'deadline-status.json'));
  assert.match(deadline.message, /夜间复盘未完成：卡在 report.*已核对路由.*worker 仍在运行/);
  assert.equal(deadline.delivery, 'sent');
  assert.equal(long.execute({ NIGHTLY_DEADLINE: '00:00' }, ['--deadline-check']).status, 0);
  assert.equal(await ended, 0, output);
  assert.equal(long.count('start-count'), 1);
  assert.ok(long.count('status-count') > 0, 'a live follower is independently checked through hub status');
  assert.ok(!fs.existsSync(path.join(long.home, 'killed')));
  assert.equal(long.status().state, 'done');
  const reviewRoute = long.calls().find((a) => a[0]?.endsWith('/route.mjs') && a[1] === 'analysis');
  const statusRoute = long.calls().find((a) => a[0]?.endsWith('/route.mjs') && a[1] === 'claude-tools');
  assert.notEqual(reviewRoute[reviewRoute.indexOf('--name') + 1], statusRoute[statusRoute.indexOf('--name') + 1], 'deadline must not replace the worker launch decision');
  assert.equal(fs.readFileSync(path.join(long.home, 'claude.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((a) => a.includes('--bg')).length, 2);
  const promptArgs = long.calls().find((a) => a[0]?.endsWith('/codex-worker.mjs') && a[3] === 'start');
  assert.ok(promptArgs.includes('--sandbox') && promptArgs.includes('danger-full-access'));
  assert.match(promptArgs.join(' '), /report draft AND notify.json BEFORE optional deep dives/);
  assert.match(promptArgs.join(' '), /Commit\/push fixes only AFTER/);
  assert.match(fs.readFileSync(path.join(long.dir, 'launch.log'), 'utf8'), /final: finish\/done/);
  console.log('PASS long-running hub worker survives deadline, sends status and delivers late report/notification');

  for (const scenario of ['stall', 'completed-follower']) {
    const f = fixture(scenario), r = f.execute(); assert.equal(r.status, 0, r.stderr);
    assert.equal(f.count('start-count'), 1); assert.equal(f.count('wait-count'), 1);
    assert.ok(f.count('status-count') >= 1); assert.equal(f.status().state, 'done');
    assert.ok(!f.calls().some((a) => a.includes('interrupt')));
  }
  console.log('PASS stall/failed followers reattach accepted turns instead of interrupting or duplicating');

  for (const scenario of ['result-unavailable', 'result-hangs']) {
    const f = fixture(scenario), r = f.execute(); assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(f.count('start-count'), 1); assert.equal(f.count('wait-count'), 2, 'completed recovery is bounded');
    assert.equal(f.status().stage, 'report'); assert.equal(f.status().state, 'failed');
    assert.equal(f.status().worker.state, 'done'); assert.equal(f.status().worker.resultUnavailable, true);
    assert.equal(json(path.join(f.run, 'attempt-1/failure-status.json')).delivery, 'sent');
    assert.ok(!fs.existsSync(path.join(f.run, 'launcher.lock')));
    assert.equal(f.execute().status, 1);
    assert.equal(f.count('start-count'), 1); assert.equal(f.count('wait-count'), 2, 'no automatic rerun after exhausted recovery');
  }
  const lostHub = fixture('hub-dies'); assert.equal(lostHub.execute().status, 1);
  assert.equal(lostHub.status().worker.state, 'failed'); assert.ok(lostHub.count('status-count') >= 2);
  const lostNotice = json(path.join(lostHub.run, 'attempt-3/failure-status.json'));
  assert.equal(lostNotice.delivery, 'sent', JSON.stringify(lostNotice));
  console.log('PASS completed-result failures/hung followers stop bounded recovery; a dead turn cannot strand a live follower');

  for (const scenario of ['dead-finisher', 'dead-finisher-pid', 'missing-finisher', 'unknown-finisher', 'agents-hang', 'agents-error', 'agents-malformed']) {
    const f = fixture(scenario);
    fs.mkdirSync(f.run, { recursive: true });
    fs.writeFileSync(path.join(f.run, 'deadline-status.json'), JSON.stringify({ delivery: 'sent', message: 'earlier deadline status' }));
    const r = f.execute({ NIGHTLY_DEADLINE: '00:00' }); assert.equal(r.status, 1, scenario + r.stdout + r.stderr);
    assert.equal(f.status().stage, 'notify');
    assert.equal(f.status().state, ['unknown-finisher', 'agents-hang', 'agents-error', 'agents-malformed'].includes(scenario) ? 'blocked' : 'failed');
    assert.equal(f.status().worker.state, 'done');
    assert.ok(json(path.join(f.run, 'attempt-1/finisher.json')).id, 'persist the actual finisher identity');
    assert.equal(json(path.join(f.run, 'attempt-1/failure-status.json')).delivery, 'sent', 'failure status must still notify after the deadline was delivered');
    assert.ok(!fs.existsSync(path.join(f.run, 'launcher.lock')));
    const starts = f.count('start-count');
    if (['unknown-finisher', 'agents-hang', 'agents-error', 'agents-malformed'].includes(scenario)) {
      assert.equal(f.execute().status, 1); assert.equal(f.count('start-count'), starts);
    } else {
      assert.equal(f.execute({ FIXTURE_SCENARIO: 'success' }).status, 0);
      assert.equal(f.count('start-count'), starts, 'dead finisher retry must not rerun review/fixes');
    }
  }
  const aliveFinisher = fixture('active-finisher');
  assert.equal(aliveFinisher.execute({ NIGHTLY_DEADLINE: '00:00' }).status, 0);
  assert.ok(!fs.existsSync(path.join(aliveFinisher.home, 'session-killed')), 'working finisher survives beyond the RPC/result budgets');
  assert.ok(fs.readFileSync(path.join(aliveFinisher.home, 'claude.jsonl'), 'utf8').includes('["agents","--json"]'));
  const deadClaude = fixture('dead-claude');
  assert.equal(deadClaude.execute({ NIGHTLY_MODE: 'claude', NIGHTLY_PERSONAL_OK: '1' }).status, 1);
  assert.equal(deadClaude.status().worker.state, 'failed');
  assert.equal(json(path.join(deadClaude.run, 'attempt-1/failure-status.json')).delivery, 'sent');
  const noNotice = fixture('dead-status-sender');
  assert.equal(noNotice.execute({ NIGHTLY_MODE: 'claude' }).status, 1);
  assert.equal(json(path.join(noNotice.run, 'attempt-1/failure-status.json')).delivery, 'failed');
  assert.ok(!fs.existsSync(path.join(noNotice.run, 'launcher.lock')), 'a dead failure notifier must not strand the launcher either');
  console.log('PASS dead/missing/unknown finisher and failed liveness RPCs return status and notify; working sessions remain alive');

  const afterDeadline = fixture('personal');
  assert.equal(afterDeadline.execute({ NIGHTLY_DEADLINE: '00:00' }).status, 1);
  assert.equal(afterDeadline.execute({ NIGHTLY_PERSONAL_OK: '1', NIGHTLY_DEADLINE: '00:00' }).status, 0);
  assert.ok(!fs.existsSync(path.join(afterDeadline.run, 'deadline-status.json')), 'post-deadline recovery must not poison the deadline dedup');
  const afterCalls = fs.readFileSync(path.join(afterDeadline.home, 'claude.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((a) => a.includes('--bg'));
  assert.ok(afterCalls.every((a) => !a[a.indexOf('-n') + 1].includes('-status-')));
  assert.equal(afterDeadline.execute({ NIGHTLY_PERSONAL_OK: '1', NIGHTLY_DEADLINE: '00:00' }).status, 0);
  assert.equal(afterDeadline.count('start-count'), 1);
  console.log('PASS successful same-day runs are idempotent and post-05:00 approval recovery sends no stale deadline status');

  const failed = fixture('fail-once'); assert.equal(failed.execute().status, 0);
  const routes = failed.calls().filter((a) => a[0]?.endsWith('/route.mjs') && a[1] === 'analysis');
  assert.ok(routes[1].includes('--exclude-model')); assert.ok(routes[1].includes('first-model'));
  assert.ok(!routes[1].includes('--exclude-account'));
  assert.equal(failed.count('start-count'), 2);
  const archived = path.join(failed.run, 'attempt-1');
  assert.equal(json(path.join(archived, 'status.json')).state, 'failed');
  const oldLog = fs.readFileSync(path.join(archived, 'worker-launch.log'), 'utf8');
  const delivered = fs.readFileSync(path.join(failed.dir, day + '.md'), 'utf8');
  assert.equal(failed.execute().status, 0);
  assert.equal(failed.count('start-count'), 2, 'successful same-day rerun must be a no-op');
  assert.equal(fs.readFileSync(path.join(failed.dir, day + '.md'), 'utf8'), delivered);
  assert.ok(!fs.existsSync(path.join(failed.run, 'attempt-3')));
  assert.equal(failed.execute({ NIGHTLY_RERUN: '1' }).status, 0);
  assert.equal(fs.readFileSync(path.join(archived, 'worker-launch.log'), 'utf8'), oldLog);
  assert.ok(fs.existsSync(path.join(failed.run, 'attempt-3/worker-launch.log')));
  console.log('PASS infrastructure failure excludes only its model; retries and same-day reruns archive attempts');

  for (const scenario of ['no-report', 'fail-all', 'deferred', 'personal', 'gate', 'policy', 'notify-fail']) {
    const f = fixture(scenario), r = f.execute(); assert.notEqual(r.status, 0, scenario);
    assert.ok(['failed', 'blocked'].includes(f.status().state), scenario);
    if (['personal', 'gate', 'deferred'].includes(scenario)) {
      assert.equal(f.count('start-count'), 0);
      const calls = fs.readFileSync(path.join(f.home, 'claude.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.ok(calls.filter((a) => a.includes('--bg')).every((a) => a[a.indexOf('-n') + 1].includes('-failure-')), 'only status notifications, no automatic ask/review sessions');
    }
    if (scenario === 'policy') assert.equal(f.count('start-count'), 1);
    if (scenario === 'no-report') assert.equal(f.count('start-count'), 3);
  }
  console.log('PASS missing reports, exhausted retries, personal/approval gates and notification failures exit nonzero');

  const notificationRetry = fixture('notify-fail'); assert.equal(notificationRetry.execute().status, 1);
  assert.equal(notificationRetry.execute({ FIXTURE_SCENARIO: 'success' }).status, 0);
  assert.equal(notificationRetry.count('start-count'), 1, 'retry notification without rerunning fixes');
  assert.equal(json(path.join(notificationRetry.run, 'attempt-1/status.json')).stage, 'notify');
  assert.equal(json(path.join(notificationRetry.run, 'attempt-1/status.json')).state, 'failed');
  console.log('PASS notification-only retries archive the failed attempt without rerunning the worker');

  for (const scenario of ['uncertain', 'wrong-turn', 'unknown-hub-status']) {
    const uncertain = fixture(scenario); assert.equal(uncertain.execute().status, 1);
    assert.equal(uncertain.status().worker.state, 'unknown');
    assert.equal(uncertain.execute().status, 1);
    assert.equal(uncertain.count('start-count'), 1);
    assert.equal(uncertain.count('wait-count'), 1);
    assert.equal(json(path.join(uncertain.run, 'attempt-1/failure-status.json')).delivery, 'sent');
  }
  console.log('PASS unknown hub state retains thread; a new invocation cannot duplicate the accepted worker');

  const rate = fixture('ttadk-rate'); assert.equal(rate.execute().status, 0);
  const retryRoute = rate.calls().filter((a) => a[0]?.endsWith('/route.mjs') && a[1] === 'analysis')[1];
  assert.ok(!retryRoute.includes('--exclude-model') && !retryRoute.includes('--exclude-account'));
  const quota = fixture('ttadk-quota'); assert.equal(quota.execute().status, 1);
  assert.ok(quota.calls().some((a) => a.includes('--exclude-account') && a.includes('ttadk')));
  console.log('PASS TTADK rate limits retry once; account-wide quota failure uses account exclusion');

  const blocked = fixture('personal'); assert.equal(blocked.execute().status, 1);
  assert.equal(blocked.execute({ NIGHTLY_DEADLINE: '00:00' }, ['--deadline-check']).status, 0);
  assert.match(json(path.join(blocked.run, 'deadline-status.json')).message, /个人额度.*用户 OK/);
  const absent = fixture('absent'); assert.equal(absent.execute({ NIGHTLY_DEADLINE: '00:00' }, ['--deadline-check']).status, 0);
  assert.match(json(path.join(absent.run, 'deadline-status.json')).message, /未找到当日启动记录/);
  const early = fixture('early'); assert.equal(early.execute({}, ['--deadline-check']).status, 0);
  assert.ok(!fs.existsSync(path.join(early.run, 'deadline-status.json')));
  console.log('PASS independent deadline check covers blocked/exited/missing launchers and obeys local deadline');

  const deadlineRetry = fixture('deadline-retry'); fs.mkdirSync(deadlineRetry.run, { recursive: true });
  const oldSender = { id: 'old-status', sessionId: 'old-status-session', name: 'old-dead-status', state: 'failed' };
  fs.writeFileSync(path.join(deadlineRetry.home, 'sessions.json'), JSON.stringify([oldSender]));
  fs.writeFileSync(path.join(deadlineRetry.run, 'deadline-status.json'), JSON.stringify({ delivery: 'launched', sendAttempt: 1, message: '夜间复盘未完成：旧状态' }));
  fs.writeFileSync(path.join(deadlineRetry.run, 'deadline-status.json.session.json'), JSON.stringify(oldSender));
  assert.equal(deadlineRetry.execute({ NIGHTLY_DEADLINE: '00:00' }, ['--deadline-check']).status, 1, 'dead accepted notifier must not stay deduplicated as launched');
  assert.equal(json(path.join(deadlineRetry.run, 'deadline-status.json')).delivery, 'failed');
  fs.writeFileSync(path.join(deadlineRetry.run, 'status.json'), JSON.stringify({ stage: 'finish', state: 'done', mode: 'auto', attempt: 1, worker: { state: 'done' } }));
  assert.equal(deadlineRetry.execute({ NIGHTLY_DEADLINE: '00:00' }, ['--deadline-check']).status, 0);
  assert.match(json(path.join(deadlineRetry.run, 'deadline-status.json')).message, /夜间复盘已完成/);
  assert.equal(json(path.join(deadlineRetry.run, 'deadline-status.json')).delivery, 'sent');
  console.log('PASS dead deadline notifiers release dedup and retry with fresh status rather than an old stuck message');

  const dead = fixture('dead-lock');
  fs.mkdirSync(path.join(dead.run, 'launcher.lock'), { recursive: true });
  fs.writeFileSync(path.join(dead.run, 'launcher.lock/owner.json'), JSON.stringify({ pid: 2147483647 }));
  assert.equal(dead.execute().status, 0, 'dead-owner lock recovered');
  const busy = fixture('busy-lock');
  fs.mkdirSync(path.join(busy.run, 'launcher.lock'), { recursive: true });
  fs.writeFileSync(path.join(busy.run, 'launcher.lock/owner.json'), JSON.stringify({ pid: process.pid }));
  assert.equal(busy.execute().status, 1); assert.equal(busy.count('start-count'), 0);
  const staleGuard = fixture('stale-guard');
  fs.mkdirSync(path.join(staleGuard.run, 'launcher.lock.claim'), { recursive: true });
  assert.equal(staleGuard.execute().status, 0); assert.equal(staleGuard.count('start-count'), 1);
  const deadGuard = fixture('dead-guard');
  fs.mkdirSync(path.join(deadGuard.run, 'launcher.lock.claim'), { recursive: true });
  fs.writeFileSync(path.join(deadGuard.run, 'launcher.lock.claim/owner-dead.json'), JSON.stringify({ pid: 2147483647 }));
  assert.equal(deadGuard.execute().status, 0); assert.equal(deadGuard.count('start-count'), 1);
  const liveGuard = fixture('live-guard');
  fs.mkdirSync(path.join(liveGuard.run, 'launcher.lock.claim'), { recursive: true });
  fs.writeFileSync(path.join(liveGuard.run, 'launcher.lock.claim/owner-live.json'), JSON.stringify({ pid: process.pid }));
  assert.equal(liveGuard.execute().status, 1); assert.equal(liveGuard.count('start-count'), 0);
  const resumedReport = fixture('resumed-report');
  const resumedAttempt = path.join(resumedReport.run, 'attempt-1'); fs.mkdirSync(resumedAttempt, { recursive: true });
  fs.writeFileSync(path.join(resumedAttempt, 'report.md'), 'already finished report');
  fs.writeFileSync(path.join(resumedAttempt, 'notify.json'), JSON.stringify({ changed: false, decisions: [] }));
  fs.writeFileSync(path.join(resumedReport.run, 'status.json'), JSON.stringify({ stage: 'report', state: 'running', attempt: 1, mode: 'auto', worker: { state: 'done', account: 'trae', model: 'first-model', effort: 'high' } }));
  assert.equal(resumedReport.execute().status, 0); assert.equal(resumedReport.count('start-count'), 0);
  console.log('PASS dead-owner recovery, live/unknown lock refusal and report-stage reattachment prevent duplicate work');

  const pendingResult = fixture('result-unavailable');
  fs.mkdirSync(path.join(pendingResult.run, 'attempt-1'), { recursive: true });
  fs.writeFileSync(path.join(pendingResult.run, 'status.json'), JSON.stringify({ stage: 'report', state: 'running', attempt: 1, mode: 'auto', worker: {
    state: 'done', account: 'trae', model: 'first-model', effort: 'high', thread: 'fixture-thread-attempt-1', turn: 'fixture-turn', resultPending: true, resultFetchAttempts: 1 } }));
  assert.equal(pendingResult.execute().status, 1);
  assert.equal(pendingResult.count('start-count'), 0); assert.equal(pendingResult.count('wait-count'), 2);
  assert.equal(pendingResult.status().worker.resultUnavailable, true);
  assert.equal(pendingResult.status().stage, 'report'); assert.equal(pendingResult.status().state, 'failed');
  console.log('PASS completed-result recovery survives launcher restart without resetting the budget or starting another worker');

  const legacy = fixture('no-report'); fs.mkdirSync(legacy.dir, { recursive: true });
  fs.writeFileSync(path.join(legacy.dir, `${day}.md`), 'old report');
  fs.writeFileSync(path.join(legacy.dir, `${day}.worker.jsonl`), 'old evidence');
  assert.equal(legacy.execute().status, 1);
  assert.equal(fs.readFileSync(path.join(legacy.run, `attempt-1/legacy/${day}.worker.jsonl`), 'utf8'), 'old evidence');
  assert.equal(fs.readFileSync(path.join(legacy.dir, `${day}.md`), 'utf8'), 'old report');
  assert.equal(legacy.status().state, 'failed', 'old report must not count as current success');
  const plan = fixture('plan'); assert.equal(plan.execute({ NIGHTLY_MODE: 'plan' }).status, 0);
  assert.ok(!fs.existsSync(plan.run)); assert.ok(!fs.existsSync(path.join(plan.dir, 'launch.log')));
  assert.equal(plan.calls().filter((a) => a[0]?.endsWith('/route.mjs')).length, 2);
  const directPlan = fixture('plan');
  const direct = spawnSync(script, [], { env: { ...directPlan.env, NIGHTLY_MODE: 'plan' }, encoding: 'utf8', timeout: 15000 });
  assert.equal(direct.status, 0, direct.stderr); assert.ok(fs.statSync(script).mode & 0o111);
  const dry = fixture('dry'); assert.equal(dry.execute({ NIGHTLY_MODE: 'dry', NIGHTLY_DEADLINE: '00:00' }).status, 0);
  assert.ok(fs.existsSync(path.join(dry.run, 'attempt-1/worker-final.md')));
  assert.ok(dry.calls().some((a) => a.includes('--sandbox') && a.includes('read-only')));
  assert.ok(!fs.existsSync(path.join(dry.home, 'claude.jsonl')));
  assert.ok(!fs.existsSync(path.join(dry.run, 'deadline-status.json')));
  console.log('PASS direct executable plan and read-only dry modes run with no live/session notifications');
  const invalid = fixture('invalid'); assert.equal(invalid.execute({}, ['--typo']).status, 1);
  assert.equal(invalid.count('start-count'), 0);
  const source = fs.readFileSync(path.join(root, 'scripts/nightly-review.mjs'), 'utf8') + fs.readFileSync(script, 'utf8');
  const withoutClientCleanup = source.replace(/function closeClient\(child\) \{[\s\S]*?\n\}/, '').replace('process.kill(pid, 0)', '');
  assert.doesNotMatch(withoutClientCleanup, /alarm 2400|perl -e|execFileSync|timeout:\s*\d|\.kill\(/);
  assert.ok(!source.includes("workerArgs('interrupt')") && !source.includes("'stop'"));
  console.log('PASS legacy evidence preserved, plan is model-free, and launcher has no hard-kill wrapper');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
