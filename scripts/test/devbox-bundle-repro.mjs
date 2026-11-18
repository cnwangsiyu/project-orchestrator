#!/usr/bin/env node
// Read-only source probe; all refs, alternates and bundle output live in scratch.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeBundle } from '../devbox-run.mjs';

const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
if (!args.includes('--repo')) throw Error('--repo PATH [--ref COMMIT] [--parent-objects DIR] [--out DIR]');
const repo = fs.realpathSync(value('--repo'));
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = git('-C', repo, 'rev-parse', '--verify', '--end-of-options', (args.includes('--ref') ? value('--ref') : 'HEAD') + '^{commit}');
const objects = fs.realpathSync(git('-C', repo, 'rev-parse', '--path-format=absolute', '--git-path', 'objects'));
const temp = args.includes('--out') ? fs.mkdtempSync(path.join(value('--out'), 'bundle-repro-')) : fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-repro-'));
const exportRepo = path.join(temp, 'export.git');
git('init', '--bare', exportRepo);
const stores = [objects, ...(args.includes('--parent-objects') ? [fs.realpathSync(value('--parent-objects'))] : [])];
fs.writeFileSync(path.join(exportRepo, 'objects/info/alternates'), stores.join('\n') + '\n');
git('--git-dir', exportRepo, 'update-ref', 'refs/heads/export', commit);
const state = { cancel: 0, children: new Set(), values: [] };
const parent = Number(args.includes('--watch-pid') ? value('--watch-pid') : process.ppid);
const watch = setInterval(() => {
  try { process.kill(parent, 0); } catch {
    state.cancel ||= 143;
    for (const stop of state.children) stop('SIGTERM');
  }
}, 1000);
for (const [signal, code] of Object.entries({ SIGINT: 130, SIGTERM: 143 })) process.on(signal, () => {
  state.cancel ||= code;
  for (const stop of state.children) stop('SIGTERM');
});
try {
  const bundle = await makeBundle({ exportRepo, temp, commit, sourceRepo: repo }, [], state);
  const receipt = { status: 'PASS', sourceRepo: repo, commit, objectDirs: stores, bundle, bytes: fs.statSync(bundle).size };
  fs.writeFileSync(path.join(temp, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
} catch (error) {
  const receipt = { status: 'FAIL', message: error.message, bundleDiagnostics: error.bundleDiagnostics };
  fs.writeFileSync(path.join(temp, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.error(error.message);
  process.exitCode = error.code || 1;
} finally { clearInterval(watch); }
