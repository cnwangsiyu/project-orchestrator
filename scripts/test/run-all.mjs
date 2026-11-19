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
const args = process.argv.slice(2), listFailing = args.includes('--list-failing');
const filesAt = args.indexOf('--files'), selected = filesAt < 0 ? null : args[filesAt + 1]?.split(',');
const reportAt = args.indexOf('--report'), report = reportAt < 0 ? null : args[reportAt + 1];
if (filesAt >= 0 && (!selected?.length || selected.some(name => !name))) throw Error('--files needs comma-separated suite names');
if (reportAt >= 0 && (!report || report.startsWith('--'))) throw Error('--report needs a new JSON file');
if (report && fs.existsSync(report)) throw Error('--report refuses to overwrite an existing file');
if (args.some((arg, index) => !['--list-failing', '--files', '--report'].includes(arg) && ![filesAt, reportAt].some(at => at >= 0 && index === at + 1))) throw Error('usage: run-all.mjs [--list-failing] [--files NAME,...] [--report FILE]');
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
suites.push({ name: 'cleanup-python', exe: 'python3', args: ['-m', 'unittest', 'discover', '-s', 'scripts/resource-cleanup', '-p', 'test*.py', '-v'] });
if (selected) {
  for (const name of selected) if (!suites.some(suite => suite.name === name)) throw Error(`unknown suite: ${name}`);
  suites = suites.filter(suite => selected.includes(suite.name));
}
let failed = 0;
const results = [];
for (const suite of suites) {
  // Six res suites run sequentially, including v1.5 fairness, the build/signal matrix and real backoff.
  // The runner file includes all sixteen selector groups. Keep its individual
  // fixture watchdogs unchanged; macOS process startup makes the full set longer.
  const timeout = suite.name === 'res-scenarios.mjs' ? RES_TEST_BUDGET_MS
    : suite.name === 'devbox-run-scenarios.mjs' ? 1800000 : 300000;
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
  console.log(`${success ? 'PASS' : 'FAIL'} ${suite.name}: duration=${durationSec.toFixed(3)}s exit=${r.status ?? 'unknown'}${r.error ? ' ' + r.error.code : ''}`);
  if (!success && !listFailing) console.log(fs.readFileSync(log, 'utf8').slice(-6000));
}
console.log(`Full suite: ${suites.length - failed}/${suites.length} passed; fixture logs: ${tmp}`);
process.exitCode = failed ? 1 : 0;
