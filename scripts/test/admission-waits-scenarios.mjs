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
const at = stamp => Date.parse(`${day}T${stamp}-08:00`) / 1000;
const line = (stamp, row) => JSON.stringify({ schema: 1, at: at(stamp), host: 'fixture-host', project: 'fixture-project', task: 'fixture-task', profile: 'medium', ...row });
const run = (...args) => execFileSync(process.execPath, [script, '--shared', root, '--day', day, ...args], { encoding: 'utf8' }).trim();
try {
  fs.mkdirSync(samples, { recursive: true });
  fs.writeFileSync(path.join(samples, 'admission.2026-11-24.ndjson'), [
    line('00:01:00', { open: false, gate: 'fifo' }), line('00:02:00', { open: false, gate: 'fifo' }),
    line('00:03:00', { open: true, gate: 'headroom' }),
    line('10:00:00', { open: false, gate: 'memory' }), line('10:04:00', { open: false, gate: 'io-pressure' }),
    line('10:10:00', { open: true, gate: 'headroom' }),
    line('23:58:00', { open: false, gate: 'memory' }),
    JSON.stringify({ schema: 1, at: at('12:00:00'), type: 'placement', open: false, gate: 'memory' }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(samples, 'admission.ndjson'), line('11:00:00', { open: false, gate: 'memory' }) + '\n');
  assert.equal(run(), '3\t280\t600\t2', 'dated journals are canonical and polls collapse into episodes');
  const detail = JSON.parse(run('--json'));
  assert.deepEqual(detail, { day, tz: 'America/Los_Angeles', count: 3, averageSeconds: 280, maxSeconds: 600,
    memoryGateRefusalEpisodes: 2, unresolvedEpisodes: 1,
    gates: { fifo: { episodes: 1, unresolved: 0 }, memory: { episodes: 2, unresolved: 1 }, 'io-pressure': { episodes: 1, unresolved: 0 } } });
  assert.equal(run('--tz', 'UTC'), '2\t360\t600\t1', 'timezone selection changes the daily window at its boundary');
  fs.rmSync(path.join(samples, 'admission.2026-11-24.ndjson'));
  assert.equal(run(), '1\t46800\t46800\t1', 'alias is used only without dated journals and open episodes end at local day end');
  console.log('PASS admission wait episodes, local day boundaries, unresolved state and gate JSON');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
