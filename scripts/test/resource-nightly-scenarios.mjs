#!/usr/bin/env node
// Exercise the real nightly launcher with fixture CLIs; no live accounts, sessions or files.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const base = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(base, '.resource-nightly-'));
const skill = path.dirname(path.dirname(base));
try {
  const bin = path.join(tmp, '.local/bin'); fs.mkdirSync(bin, { recursive: true });
  const shared = path.join(tmp, '.claude/orchestrator/_shared'); fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(path.join(shared, 'codex-accounts.json'), JSON.stringify({ fixture: { kind: 'ttadk', home: tmp } }));
  const node = `#!${process.execPath}
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.HOME + '/calls.jsonl', JSON.stringify(args) + '\\n');
if (args[0] === '-e') { const r = spawnSync(${JSON.stringify(process.execPath)}, args, { stdio: 'inherit' }); process.exit(r.status ?? 2); }
if (args[0]?.endsWith('/route.mjs')) console.log(JSON.stringify({ pick: { vendor: 'codex', model: 'fixture-model', effort: 'high', account: 'fixture' } }));
else if (args[0]?.endsWith('/resource-sample.mjs')) { if (!args.includes('--read-only')) process.exit(99); console.log(JSON.stringify({ schema: 1, complete: false, processComplete: false })); console.error('fixture UNKNOWN'); process.exit(2); }
else if (args[0]?.endsWith('/resource-review.mjs')) { console.log(JSON.stringify({ coverage: { observedMinutes: 0 }, badCases: [] })); console.error('fixture UNKNOWN'); process.exit(2); }
else console.log('{}');
`;
  fs.writeFileSync(path.join(bin, 'node'), node, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n[ "$1" = agents ] || exit 99\nprintf "[]\\n"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nprintf "%s\\n" "$*" > "$HOME/worker-args.txt"\nprintf "{}\\n"\n', { mode: 0o755 });
  const run = spawnSync('/bin/zsh', [path.join(skill, 'scripts/nightly-review.sh')], { env: { ...process.env, HOME: tmp, NIGHTLY_MODE: 'dry', NIGHTLY_PERSONAL_OK: '0' }, encoding: 'utf8', timeout: 15000 });
  assert.equal(run.status, 0, run.stderr);
  const review = path.join(shared, 'routing-review');
  const day = fs.readdirSync(review).find((s) => s.endsWith('.data'));
  const data = path.join(review, day);
  assert.ok(fs.existsSync(path.join(data, 'resource-review-24h.txt')));
  assert.ok(fs.existsSync(path.join(data, 'resource-review-24h.json')));
  assert.ok(fs.existsSync(path.join(data, 'resource-review-96h.json')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'resource-now.json'), 'utf8')).complete, false);
  assert.match(fs.readFileSync(path.join(data, 'resource-now.err'), 'utf8'), /UNKNOWN/);
  assert.match(fs.readFileSync(path.join(tmp, 'worker-args.txt'), 'utf8'), /-s read-only/);
  assert.match(fs.readFileSync(path.join(tmp, 'worker-args.txt'), 'utf8'), /Machine resources:/);
  assert.ok(!fs.existsSync(path.join(tmp, 'Library/LaunchAgents')));
  const calls = fs.readFileSync(path.join(tmp, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter((a) => a[0]?.endsWith('/resource-sample.mjs')).length, 1);
  assert.equal(calls.filter((a) => a[0]?.endsWith('/resource-review.mjs')).length, 3);
  console.log('resource nightly launcher: read-only hooks, UNKNOWN propagation and dry worker all pass');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
