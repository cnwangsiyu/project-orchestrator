import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkTransfer } from '../lib/devbox-transfer-check.mjs';
// BC-116: CI template placeholders ("{{NPM_TOKEN}}") are references; fake literals still fail.
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-tpl-'));
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
git('init', '-q'); fs.mkdirSync(path.join(repo, '.codebase/pipelines'), { recursive: true });
fs.writeFileSync(path.join(repo, '.codebase/pipelines/ref.yaml'), 'env:\n  NPM_TOKEN: "{{NPM_TOKEN}}"\n  OTHER_TOKEN: "{{ secrets.other_token }}"\n');
fs.writeFileSync(path.join(repo, '.codebase/pipelines/lit.yaml'), 'env:\n  NPM_TOKEN: "FAKEabcd1234efgh5678"\n');
git('add', '-A'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 't');
const id = 'id-' + 'a'.repeat(64);
const findings = await checkTransfer(repo, 'HEAD', 'commit', id, { scope: 'snapshot', cacheRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'scan-cache-')) });
assert.deepEqual(findings.map(f => f.path), ['.codebase/pipelines/lit.yaml']);
console.log('all pass');
