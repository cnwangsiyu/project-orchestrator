#!/usr/bin/env node
// Copy immutable fixtures into a temporary HOME. Never invoke the installed res.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SUITE_TIMEOUTS = {
  'status.mjs': 600000,
  't88/test-res.sh': 600000,
  't88/memory/test-res.sh': 600000,
  't88/legacy/test-res.sh': 600000,
  'lane3.mjs': 600000,
  'fairness.mjs': 600000,
  'lanes.mjs': 600000,
  'pools.mjs': 600000,
  'scheduler-ranking.mjs': 600000,
  'pool-identity.mjs': 600000,
  'pool-surplus.mjs': 600000,
  'pool-exclusions.mjs': 600000,
  'pool-exec.mjs': 600000,
  'devbox-admission.mjs': 600000,
  'dynamic-leases.mjs': 600000,
  'config-reload.mjs': 600000,
  'mem-guard.mjs': 600000,
  'followups.mjs': 600000,
  'mini-build.mjs': 600000,
  'stale-holds.mjs': 600000,
  'build.mjs': 1200000,
};
// The outer runner must allow every bounded child plus fixture setup/logging overhead.
export const RES_TEST_BUDGET_MS = Object.values(SUITE_TIMEOUTS).reduce((sum, timeout) => sum + timeout, 0) + 300000;

export function runResSuites() {
  const selected = process.env.RES_TEST_SUITE;
  if (selected && !Object.hasOwn(SUITE_TIMEOUTS, selected)) throw Error(`unknown res suite: ${selected}`);
  const base = path.dirname(fileURLToPath(import.meta.url));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'res-tests-'));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, '.claude/orchestrator/_shared'), { recursive: true });
  fs.cpSync(path.join(base, 't88'), path.join(tmp, 't88'), { recursive: true });
  fs.cpSync(path.join(base, 'fixtures'), path.join(tmp, 'fixtures'), { recursive: true });
  const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
  fs.copyFileSync(path.join(base, 'fixtures/ps'), path.join(bin, 'ps'));
  fs.chmodSync(path.join(bin, 'ps'), 0o755);
  if (os.platform() === 'linux') {
    // These suites replay macOS metrics. Individual Linux-path fixtures override uname.
    fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\nprintf "Darwin\\n"\n', { mode: 0o755 });
    fs.copyFileSync(path.join(base, 'fixtures/shlock'), path.join(bin, 'shlock'));
    fs.chmodSync(path.join(bin, 'shlock'), 0o755);
    if (fs.existsSync('/usr/bin/mawk')) fs.symlinkSync('/usr/bin/mawk', path.join(bin, 'awk'));
  }
  const res = path.resolve(base, '../res');
  const env = { ...process.env, HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    PATH: process.env.RES_TEST_NATIVE_PS === '1' ? process.env.PATH : `${bin}:${process.env.PATH}`,
    RES_DIR: path.join(tmp, 'unused'), RES_TEST_METRICS: '0', RES_TEST_MEMORY_GUARD: '0', RES_TEST_SERIAL_CASES: '1',
    // Historical expiry fixtures use 45s; pool-exec checks the production 300s default.
    RES_WAITER_STALE_SECONDS: '45',
    T88_RES: res, T86_RES: res, T83_RES: res,
    RES_TEST_AWK: process.env.RES_TEST_AWK || (os.platform() === 'linux' && fs.existsSync('/usr/bin/mawk') ? '/usr/bin/mawk' : '/usr/bin/awk') };
  let assertions = 0;
  console.log(`Res PID table: ${process.env.RES_TEST_NATIVE_PS === '1' ? 'native ps' : 'scratch fixture (host ps not required)'}`);
  for (const [suite, timeout] of Object.entries(SUITE_TIMEOUTS)) {
    if (selected && selected !== suite) continue;
    if ((process.env.RES_TEST_EXCLUDE_SUITES || '').split(',').includes(suite)) continue;
    const node = suite.endsWith('.mjs');
    const script = path.join(node ? base : tmp, suite);
    // Slow/load-sensitive runs may select one suite and disable only its outer
    // watchdog; independently bounded probes/waits retain their normal limits.
    const r = spawnSync(node ? process.execPath : '/bin/bash', [script], {
      cwd: tmp, env: { ...env, RES_TEST_ROOT: tmp, RES_SOURCE: res },
      encoding: 'utf8', timeout: process.env.RES_TEST_NO_WATCHDOG === '1' ? undefined : timeout, maxBuffer: 8 * 2 ** 20 });
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    fs.writeFileSync(path.join(tmp, suite.replaceAll('/', '-') + '.log'), output, { mode: 0o600 });
    if (r.status !== 0 || r.error) {
      const diagnostic = output.length <= 8000 ? output : `${output.slice(0, 4000)}\n[output truncated]\n${output.slice(-4000)}`;
      throw Error(`${suite}: exit=${r.status}; ${r.error?.message ?? ''}\n${diagnostic}\nFixtures: ${tmp}`);
    }
    const count = Number(output.match(/ALL (\d+) ASSERTIONS PASSED/)?.[1]);
    if (!count) throw Error(`${suite}: assertion count missing; fixtures: ${tmp}`);
    assertions += count;
    console.log(`PASS res/${suite}: ${count} assertions`);
  }
  console.log(`Res suites: ${assertions} assertions passed; isolated evidence: ${tmp}`);
  return { assertions, tmp };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runResSuites();
