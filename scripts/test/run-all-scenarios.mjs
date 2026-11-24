#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const runner = path.join(root, 'scripts/test/run-all.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'run-all-scenarios-'));
const fake = path.join(tmp, 'res');
const fakeDevbox = path.join(tmp, 'devbox-run.mjs');
const calls = path.join(tmp, 'calls');
fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\ncase "$1" in\n  pool-capacity) printf '{"fixture":{"claims":0,"gate":"headroom"}}\\n' ;;\n  wait-lane) printf 'lane=fixture-lane\\n' ;;\n  return) printf 'returned fixture-lane\\n' ;;\nesac\n`, { mode: 0o700 });
fs.writeFileSync(fakeDevbox, `import { spawnSync } from 'node:child_process';\nconst at=process.argv.indexOf('--'); const r=spawnSync('/bin/bash',['-lc',process.argv[at+1]],{encoding:'utf8'}); process.stdout.write(r.stdout||''); process.stderr.write(r.stderr||''); process.exitCode=r.status;\n`);
const repeated = Array(9).fill('resource-scenarios.mjs').join(',');
const run = (extra = [], env = {}) => spawnSync(process.execPath, [runner, ...extra], { cwd: root, env: { ...process.env, SUITE_RES_BIN: fake, SUITE_NO_CLAIM_REASON: '', SUITE_REMOTE_CHILD: '', SUITE_LOCATION: '', SUITE_RESULT_STDOUT: '', SUITE_ON: '', ...env }, encoding: 'utf8', timeout: 30000 });

let result = run(['--on', 'local', '--files', repeated]);
assert.equal(result.status, 0, result.stderr);
assert.match(result.stdout, /waiting for a suite slot: 0 ahead/);
assert.match(result.stdout, /suite slot: fixture-lane/);
assert.match(fs.readFileSync(calls, 'utf8'), /wait-lane .*--profile medium .*--cores 1 .*--mem-gib 2 .*--wrapper/);
assert.match(fs.readFileSync(calls, 'utf8'), /return fixture-lane/);

fs.writeFileSync(calls, '');
result = run(['--on', 'local', '--files', repeated, '--no-claim']);
assert.notEqual(result.status, 0);
assert.match(result.stderr, /refused without a TTY/);
result = run(['--on', 'local', '--files', repeated, '--no-claim'], { SUITE_NO_CLAIM_REASON: 'runner fixture' });
assert.equal(result.status, 0, result.stderr);
assert.match(result.stdout, /suite claim bypassed: reason=runner fixture/);
assert.equal(fs.readFileSync(calls, 'utf8'), '');

result = run(['--files', 'resource-scenarios.mjs']);
assert.equal(result.status, 0, result.stderr);
assert.equal(fs.readFileSync(calls, 'utf8'), '');
result = run(['--files', repeated], { SUITE_DEVBOX_RUN_BIN: fakeDevbox });
assert.equal(result.status, 0, result.stderr);
assert.match(result.stdout, /PASS \[(?:devbox|local)\] resource-scenarios\.mjs/);
assert.equal((result.stdout.match(/Full suite:/g) || []).length, 1);
assert.doesNotMatch(result.stdout, /SUITE_RESULT_JSON=/);
console.log('PASS full-suite claim, release, no-claim guard and small-selection bypass');
