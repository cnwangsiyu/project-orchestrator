#!/usr/bin/env node
// Full fixture suite. Isolate account state and keep delivery logs outside the skill.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const base = path.dirname(fileURLToPath(import.meta.url)), root = path.dirname(path.dirname(base));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'project-orchestrator-tests-'));
const home = path.join(tmp, 'fixture-home'); fs.mkdirSync(home, { recursive: true });
const env = { ...process.env, HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp, PYTHONDONTWRITEBYTECODE: '1' };
const suites = fs.readdirSync(base).filter((f) => f.endsWith('.mjs') && f !== path.basename(fileURLToPath(import.meta.url))).sort().map((f) => ({ name: f, exe: process.execPath, args: [path.join(base, f)] }));
suites.push({ name: 'cleanup-python', exe: 'python3', args: ['-m', 'unittest', 'discover', '-s', 'scripts/resource-cleanup', '-p', 'test*.py', '-v'] });
let failed = 0;
for (const suite of suites) {
  // res-scenarios runs four bounded suites sequentially (including real backoff).
  const timeout = suite.name === 'res-scenarios.mjs' ? 1200000 : 300000;
  const r = spawnSync(suite.exe, suite.args, { cwd: root, env, encoding: 'utf8', timeout, maxBuffer: 16 * 2 ** 20 });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? '\n' + r.error.message : ''}`;
  fs.writeFileSync(path.join(tmp, `${suite.name}.log`), output, { mode: 0o600 });
  const success = r.status === 0 && !r.error;
  if (!success) failed++;
  console.log(`${success ? 'PASS' : 'FAIL'} ${suite.name}: exit=${r.status ?? 'unknown'}${r.error ? ' ' + r.error.code : ''}`);
  if (!success) console.log(output.slice(-6000));
}
console.log(`Full suite: ${suites.length - failed}/${suites.length} passed; fixture logs: ${tmp}`);
process.exitCode = failed ? 1 : 0;
