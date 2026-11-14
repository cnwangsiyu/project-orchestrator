#!/usr/bin/env node
// Copy immutable fixtures into a temporary HOME. Never invoke the installed res.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function runResSuites() {
  const base = path.dirname(fileURLToPath(import.meta.url));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'res-tests-'));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, '.claude/orchestrator/_shared'), { recursive: true });
  fs.cpSync(path.join(base, 't88'), path.join(tmp, 't88'), { recursive: true });
  fs.cpSync(path.join(base, 'fixtures'), path.join(tmp, 'fixtures'), { recursive: true });
  const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
  fs.copyFileSync(path.join(base, 'fixtures/ps'), path.join(bin, 'ps'));
  fs.chmodSync(path.join(bin, 'ps'), 0o755);
  const res = path.resolve(base, '../res');
  const env = { ...process.env, HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    PATH: process.env.RES_TEST_NATIVE_PS === '1' ? process.env.PATH : `${bin}:${process.env.PATH}`,
    RES_DIR: path.join(tmp, 'unused'), RES_TEST_METRICS: '0',
    T88_RES: res, T86_RES: res, T83_RES: res };
  const suites = ['t88/test-res.sh', 't88/memory/test-res.sh', 't88/legacy/test-res.sh', 'lane3.mjs', 'build.mjs'];
  let assertions = 0;
  console.log(`Res PID table: ${process.env.RES_TEST_NATIVE_PS === '1' ? 'native ps' : 'scratch fixture (host ps not required)'}`);
  for (const suite of suites) {
    const node = suite.endsWith('.mjs');
    const script = path.join(node ? base : tmp, suite);
    const r = spawnSync(node ? process.execPath : '/bin/bash', [script], {
      cwd: tmp, env: { ...env, RES_TEST_ROOT: tmp, RES_SOURCE: res },
      encoding: 'utf8', timeout: 300000, maxBuffer: 8 * 2 ** 20 });
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    fs.writeFileSync(path.join(tmp, suite.replaceAll('/', '-') + '.log'), output, { mode: 0o600 });
    if (r.status !== 0 || r.error) throw Error(`${suite}: exit=${r.status}; ${r.error?.message ?? ''}\n${output.slice(-8000)}\nFixtures: ${tmp}`);
    const count = Number(output.match(/ALL (\d+) ASSERTIONS PASSED/)?.[1]);
    if (!count) throw Error(`${suite}: assertion count missing; fixtures: ${tmp}`);
    assertions += count;
    console.log(`PASS res/${suite}: ${count} assertions`);
  }
  console.log(`Res suites: ${assertions} assertions passed; isolated evidence: ${tmp}`);
  return { assertions, tmp };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runResSuites();
