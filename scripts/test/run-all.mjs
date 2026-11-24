#!/usr/bin/env node
// Full fixture suite. Isolate account state and keep delivery logs outside the skill.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RES_TEST_BUDGET_MS } from '../res/test/run.mjs';
import { redactLogFile } from '../lib/log-redaction.mjs';
const base = path.dirname(fileURLToPath(import.meta.url)), root = path.dirname(path.dirname(base));
const args = process.argv.slice(2), listFailing = args.includes('--list-failing'), stopOnFailure = args.includes('--stop-on-failure');
const noClaim = args.includes('--no-claim');
const filesAt = args.indexOf('--files'), selected = filesAt < 0 ? null : args[filesAt + 1]?.split(',');
const reportAt = args.indexOf('--report'), report = reportAt < 0 ? null : args[reportAt + 1];
const onAt = args.indexOf('--on'), onArg = onAt < 0 ? null : args[onAt + 1];
if (filesAt >= 0 && (!selected?.length || selected.some(name => !name))) throw Error('--files needs comma-separated suite names');
if (reportAt >= 0 && (!report || report.startsWith('--'))) throw Error('--report needs a new JSON file');
if (report && fs.existsSync(report)) throw Error('--report refuses to overwrite an existing file');
if (onAt >= 0 && !['local', 'devbox'].includes(onArg)) throw Error('--on needs local or devbox');
if (args.some((arg, index) => !['--list-failing', '--stop-on-failure', '--no-claim', '--files', '--report', '--on'].includes(arg) && ![filesAt, reportAt, onAt].some(at => at >= 0 && index === at + 1))) throw Error('usage: run-all.mjs [--list-failing] [--stop-on-failure] [--no-claim] [--on local|devbox] [--files NAME,...] [--report FILE]');
if (report) fs.mkdirSync(path.dirname(path.resolve(report)), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'project-orchestrator-tests-'));
const home = path.join(tmp, 'fixture-home'); fs.mkdirSync(home, { recursive: true });
const env = { ...process.env, HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp, PYTHONDONTWRITEBYTECODE: '1',
  RULES_SHARED: path.join(home, '.claude/orchestrator/_shared'), ORCHESTRATOR_OWNER: '' };
// Clear caller overrides rather than inventing a new default route-log name:
// suites must be able to exercise their own RULES_SHARED defaults.
for (const key of Object.keys(env)) if (key.startsWith('CODEX_WORKER_') || ['CODEX_THREAD_ID', 'TRAECLI_THREAD_ID', 'CODEX_HOME', 'CODEX_HUB', 'RULES_DIGEST',
  'CODEX_ACCOUNTS', 'QUOTA_CACHE', 'ROUTE_LOG_FILE', 'QUOTA_LOG_FILE', 'RESOURCE_LOG_FILE', 'RULES_LEDGER_ROOT', 'TRAE_SESSIONS_DIR'].includes(key)) delete env[key];
// Helper/fixture CLI modules are not suites (some intentionally require args).
let suites = fs.readdirSync(base).filter(f => f.endsWith('-scenarios.mjs') || f === 'pipeline-invariants.mjs').sort().map((f) => ({ name: f, exe: process.execPath, args: [path.join(base, f)] }));
// pipeline-invariants.mjs is intentionally auto-discovered with the other suites.
// Fail visibly if a partial checkout accidentally omits the pure pipeline tests.
if (!suites.some((s) => s.name === 'pipeline-invariants.mjs')) throw Error('pipeline invariant suite is missing');
suites.push({ name: 'cleanup-python', exe: 'python3', args: ['-B', '-m', 'unittest', 'discover', '-s', 'scripts/resource-cleanup', '-p', 'test*.py', '-v'] });
if (selected) {
  for (const name of selected) if (!suites.some(suite => suite.name === name)) throw Error(`unknown suite: ${name}`);
  suites = suites.filter(suite => selected.includes(suite.name));
}
const fullRun = !selected || selected.length > 8;
const explicitOn = onArg || process.env.SUITE_ON;
if (explicitOn && !['local', 'devbox'].includes(explicitOn)) throw Error('SUITE_ON must be local or devbox');
const location = process.env.SUITE_LOCATION || 'local';
const localOnly = new Set(['devbox-tree-scenarios.mjs', 'mini2-scenarios.mjs', 'worker-inbox-fix-scenarios.mjs']);
const originalSuites = suites;
let remoteResults = [];
const chosenOn = process.env.SUITE_REMOTE_CHILD ? 'local' : (explicitOn || (fullRun ? 'devbox' : 'local'));
if (chosenOn === 'devbox') {
  const remoteSuites = suites.filter(suite => !localOnly.has(suite.name));
  const localSuites = suites.filter(suite => localOnly.has(suite.name));
  const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  const remoteArgs = ['scripts/test/run-all.mjs', '--on', 'local', '--no-claim', '--files', remoteSuites.map(suite => suite.name).join(',')];
  if (listFailing) remoteArgs.push('--list-failing');
  if (stopOnFailure) remoteArgs.push('--stop-on-failure');
  const command = `SUITE_REMOTE_CHILD=1 SUITE_LOCATION=devbox SUITE_RESULT_STDOUT=1 SUITE_NO_CLAIM_REASON=${quote('devbox lease owns remote resources')} ${['node', ...remoteArgs].map(quote).join(' ')}`;
  const out = path.join(tmp, 'devbox-run');
  const devbox = process.env.SUITE_DEVBOX_RUN_BIN || path.join(root, 'scripts/devbox-run.mjs');
  const run = spawnSync(process.execPath, [devbox, '--project', 'project-orchestrator', '--task', 'full-suite', '--repo', root, '--ref', 'HEAD', '--pool', 'devbox-cn', '--need', 'node', '--cores', '1', '--mem-gib', '2', '--disk-gib', '2', '--out', out, '--timeout', '120', '--queue-timeout', '30', '--', command], { cwd: root, env: process.env, encoding: 'utf8', timeout: 3 * 60 * 60 * 1000, maxBuffer: 32 * 2 ** 20 });
  const marker = run.stdout?.match(/^SUITE_RESULT_JSON=([A-Za-z0-9+/=]+)$/m)?.[1];
  process.stdout.write((run.stdout ?? '').split('\n').filter(line => !line.startsWith('SUITE_RESULT_JSON=')).join('\n'));
  process.stderr.write(run.stderr ?? '');
  if (marker) {
    remoteResults = JSON.parse(Buffer.from(marker, 'base64').toString('utf8'));
    suites = localSuites;
  } else if (explicitOn === 'devbox') {
    throw Error(`devbox suite run failed before returning results (${run.error?.message || `exit ${run.status}`})`);
  } else {
    console.warn(`WARNING: devbox suite unavailable; falling back to local (${run.error?.message || `exit ${run.status}`})`);
    suites = originalSuites;
  }
}
const res = process.env.SUITE_RES_BIN || path.join(root, 'scripts/res/res');
const claimTimeout = process.env.SUITE_CLAIM_TIMEOUT_MIN || '20';
if (!/^\d+(?:\.\d+)?$/.test(claimTimeout)) throw Error('SUITE_CLAIM_TIMEOUT_MIN must be a non-negative number of minutes');
let claim = null;
const releaseClaim = () => {
  if (!claim) return;
  const owned = claim; claim = null;
  const released = spawnSync(res, ['return', owned.lane, '--by', owned.holder, '--note', 'full suite finished'], { encoding: 'utf8' });
  if (released.status !== 0) process.stderr.write(`WARNING: could not return suite slot ${owned.lane}: ${(released.stderr || released.error?.message || `exit ${released.status}`).trim()}\n`);
};
const capacity = () => {
  const result = spawnSync(res, ['pool-capacity', 'local'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return { result, row: null };
  try { return { result, row: Object.values(JSON.parse(result.stdout))[0] ?? null }; }
  catch { return { result, row: null }; }
};
if (fullRun && suites.length) {
  if (noClaim) {
    const reason = process.env.SUITE_NO_CLAIM_REASON?.trim();
    if (!process.stdin.isTTY && !reason) throw Error('--no-claim is refused without a TTY unless SUITE_NO_CLAIM_REASON is set');
    console.log(`suite claim bypassed: reason=${reason || 'interactive operator override'}`);
  } else {
    const before = capacity();
    if (before.result.error?.code === 'ENOENT') {
      console.warn(`WARNING: res unavailable; running full suite without a claim (${before.result.error.message})`);
    } else if (!before.row && before.result.status !== 0) {
      console.warn(`WARNING: res admission unavailable; running full suite without a claim (${(before.result.stderr || `exit ${before.result.status}`).trim()})`);
    } else if (before.row && !['headroom', 'load'].includes(before.row.gate)) {
      console.warn(`WARNING: res admission closed (${before.row.gate}); running full suite without a claim`);
    } else {
      const ahead = Number(before.row?.claims ?? before.row?.held ?? 0);
      console.log(`waiting for a suite slot: ${Number.isFinite(ahead) ? ahead : 0} ahead`);
      const holder = `suite-${process.pid}-${Date.now()}`;
      const acquired = spawnSync(res, ['wait-lane', '--by', holder, '--project', 'project-orchestrator', '--task', 'full-suite', '--for', 'full project-orchestrator fixture suite', '--timeout', claimTimeout, '--profile', 'medium', '--cores', '1', '--mem-gib', '2', '--wrapper', '--pid', String(process.pid)], { encoding: 'utf8' });
      const lane = acquired.stdout?.match(/^lane=(.+)$/m)?.[1];
      if (acquired.status === 0 && lane) {
        claim = { lane, holder };
        console.log(`suite slot: ${lane}`);
        process.once('exit', releaseClaim);
        for (const [signal, code] of [['SIGINT', 130], ['SIGHUP', 129], ['SIGTERM', 143]]) process.once(signal, () => { releaseClaim(); process.exit(code); });
      } else {
        const after = capacity();
        if (acquired.error?.code === 'ENOENT' || !after.row || (after.row.gate && after.row.gate !== 'load')) {
          console.warn(`WARNING: res claim failed outside the load gate; running full suite without a claim (${(acquired.stderr || acquired.error?.message || `exit ${acquired.status}`).trim()})`);
        } else {
          throw Error(`suite slot unavailable after ${claimTimeout} minutes (${after.row.gate})`);
        }
      }
    }
  }
}
let failed = remoteResults.filter(result => !result.pass).length;
const results = [...remoteResults];
for (const suite of suites) {
  // Six res suites run sequentially, including v1.5 fairness, the build/signal matrix and real backoff.
  // The runner file includes all sixteen selector groups. Keep its individual
  // fixture watchdogs unchanged; macOS process startup makes the full set longer.
  const timeout = suite.name === 'res-scenarios.mjs' ? RES_TEST_BUDGET_MS
    : suite.name === 'devbox-run-scenarios.mjs' ? 3600000 : 300000;
  const started = performance.now();
  const r = spawnSync(suite.exe, suite.args, { cwd: root, env, encoding: 'utf8', timeout, maxBuffer: 16 * 2 ** 20 });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? '\n' + r.error.message : ''}`;
  const log = path.join(tmp, `${suite.name}.log`);
  fs.writeFileSync(log, output, { mode: 0o600 });
  redactLogFile(log, { force: true });
  const success = r.status === 0 && !r.error;
  if (!success) failed++;
  const durationSec = (performance.now() - started) / 1000;
  results.push({ file: suite.name, pass: success, exit: r.status, error: r.error?.code ?? null, durationSec, log });
  fs.writeFileSync(path.join(tmp, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  if (report) fs.writeFileSync(report, JSON.stringify({ platform: process.platform, node: process.version, results }, null, 2) + '\n', { mode: 0o600 });
  console.log(`${success ? 'PASS' : 'FAIL'} [${location}] ${suite.name}: duration=${durationSec.toFixed(3)}s exit=${r.status ?? 'unknown'}${r.error ? ' ' + r.error.code : ''}`);
  if (!success && !listFailing) console.log(fs.readFileSync(log, 'utf8').slice(-6000));
  if (!success && stopOnFailure) break;
}
if (process.env.SUITE_RESULT_STDOUT) console.log(`SUITE_RESULT_JSON=${Buffer.from(JSON.stringify(results)).toString('base64')}`);
if (!process.env.SUITE_REMOTE_CHILD) console.log(`Full suite: ${results.length - failed}/${originalSuites.length} passed; attempted=${results.length}; fixture logs: ${tmp}`);
process.exitCode = failed ? 1 : 0;
