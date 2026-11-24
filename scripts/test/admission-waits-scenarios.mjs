import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scripts = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admission-waits-'));
const samples = path.join(root, 'host-samples');
const script = path.join(scripts, 'reports/admission-waits.mjs');
const day = '2026-11-24';
const at = Date.parse(`${day}T12:00:00Z`) / 1000;
const line = row => JSON.stringify({ schema: 1, at, ...row });
try {
  fs.mkdirSync(samples, { recursive: true });
  fs.writeFileSync(path.join(samples, 'admission.2026-11-24.ndjson'), [
    line({ open: true, waitSeconds: 30 }), line({ open: true, waitMs: 90_000 }),
    line({ open: false, gate: 'load' }), line({ open: false, gate: 'memory' }),
    line({ open: true, wait: 0 }), JSON.stringify({ schema: 1, at: at - 86_400, open: false, gate: 'memory' }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(samples, 'admission.ndjson'), line({ open: true, waitSeconds: 999 }) + '\n');
  const output = execFileSync(process.execPath, [script, '--shared', root, '--day', day], { encoding: 'utf8' }).trim();
  assert.equal(output, '4\t60\t90\t1', 'dated journals are canonical; waits include gate refusals once');
  fs.rmSync(path.join(samples, 'admission.2026-11-24.ndjson'));
  assert.equal(execFileSync(process.execPath, [script, '--shared', root, '--day', day], { encoding: 'utf8' }).trim(), '1\t999\t999\t0');
  console.log('PASS admission wait counter reads canonical journals, gate refusals and memory refusals');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
