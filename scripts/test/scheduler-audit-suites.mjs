// Bounded slices of the audit acceptance set, for the five-minute GUI wrapper.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const [kind, ...selected] = process.argv.slice(2);
const required = fs.readdirSync('scripts/test').filter(name => name.endsWith('-scenarios.mjs')
  && /rules|worker/.test(fs.readFileSync('scripts/test/' + name, 'utf8'))).sort();
const suites = kind === 'scenarios' ? required : kind === 'res' ? [
  't88/test-res.sh', 't88/memory/test-res.sh', 't88/legacy/test-res.sh', 'lane3.mjs',
  'fairness.mjs', 'lanes.mjs', 'pools.mjs', 'pool-identity.mjs', 'pool-surplus.mjs',
  'pool-exclusions.mjs', 'pool-exec.mjs', 'devbox-admission.mjs', 'followups.mjs',
  'stale-holds.mjs', 'build.mjs', 'scheduler-ranking.mjs',
] : kind === 'devbox' ? ['baseline', 'dead-slot', 'inputs', 'hygiene', 'credentials',
  'packed-module', 'receipt', 'res-progress', 'cpu', 'auto', 'units', 'prewarm', 'metrics', 'placement', 'ssh-drop', 'affinity'] : null;
if (!suites || !selected.length) throw Error('usage: scheduler-audit-suites.mjs res|scenarios|devbox INDEX...');
const results = [];
fs.mkdirSync('reports', { recursive: true });
const report = 'reports/scheduler-audit-' + kind + '-' + selected.join('-') + '.json';
const save = () => fs.writeFileSync(report, JSON.stringify({ kind, results }, null, 2) + '\n');
for (const text of selected) {
  const index = Number(text), suite = suites[index];
  if (!Number.isInteger(index) || !suite) throw Error('invalid suite index');
  const script = kind === 'res' ? 'scripts/res/test/run.mjs'
    : kind === 'devbox' ? 'scripts/test/devbox-run-scenarios.mjs' : 'scripts/test/' + suite;
  const env = { ...process.env, ...(kind === 'res' ? { RES_TEST_SUITE: suite }
    : kind === 'devbox' ? { DEVBOX_TEST_CASE: suite } : {}) };
  const started = Date.now();
  const result = spawnSync(process.execPath, [script], { env, encoding: 'utf8', timeout: 240000, maxBuffer: 32*1024*1024 });
  results.push({ suite, pass: !result.error && result.status === 0, exit: result.status,
    durationSec: (Date.now()-started)/1000, assertions: Number(result.stdout?.match(/PASS res\/[^:]+: (\d+) assertions/)?.[1]) || null });
  save();
  if (result.error || result.status !== 0) {
    console.error(`FAIL audit ${kind}/${suite}: exit=${result.status} ${result.error?.message || ''}`);
    console.error(result.stdout || ''); console.error(result.stderr || ''); process.exit(1);
  }
  console.log(`PASS audit ${kind}/${suite}: ${((Date.now()-started)/1000).toFixed(1)}s`);
  if (kind === 'res') console.log(result.stdout.trim());
}
