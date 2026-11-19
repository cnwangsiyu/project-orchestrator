import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { remoteScripts, parseArgs } from '../devbox-run.mjs';
import { artifactName, readArtifactManifest, artifactTimeoutMs } from '../lib/devbox-artifacts.mjs';
import { controlOptions } from '../lib/devbox-ssh.mjs';
import { mock } from 'node:test';
import { readArchive } from '../lib/devbox-artifacts.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-scenarios-'));
const root = path.join(temp, 'devbox-run'), workspace = path.join(root, 'wt', 'fixture');
const control = path.join(root, 'runs', randomUUID());
fs.mkdirSync(workspace, { recursive: true }); fs.mkdirSync(control, { recursive: true });
const bytes = randomBytes(1024 * 1024), digest = createHash('sha256').update(bytes).digest('hex');
fs.writeFileSync(path.join(workspace, 'public.bin'), bytes);
const data = { root, workspace, control, commit: 'a'.repeat(40), slot: 'devbox-cn-1', host: '192.0.2.1', patterns: ['public.bin'] };
const invoke = (operation, value, python = remoteScripts[operation]) => spawnSync('python3', ['-c', python, Buffer.from(JSON.stringify(value)).toString('base64')], { maxBuffer: 128 * 1024 * 1024 });
try {
  const args = ['--project', 'fixture', '--task', 'artifact', '--repo', temp];
  assert.equal(parseArgs([...args, '--', 'true']).artifactStreams, 1);
  assert.equal(parseArgs([...args, '--', 'true']).artifactTimeout, 120);
  for (const value of ['0', '121', 'NaN']) assert.throws(() => parseArgs([...args, '--artifact-timeout', value, '--', 'true']));
  assert.equal(artifactTimeoutMs(1000), 900000);
  assert.equal(artifactTimeoutMs(200 * 1024 ** 2), 1048576);
  assert.equal(artifactTimeoutMs(10 * 1024 ** 3), 7200000);
  assert.equal(artifactTimeoutMs(1000, 0.01), 600);
  const progress = [], progressFile = path.join(temp, 'progress.tar');
  let finishRange, transferStats;
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const pending = readArchive({ size: bytes.length, sha256: digest }, progressFile, {
      readRange: async ({ outputFile, onBytes }) => {
        fs.appendFileSync(outputFile, bytes.subarray(0, 100)); onBytes(100);
        await new Promise(resolve => { finishRange = resolve; });
        fs.appendFileSync(outputFile, bytes.subarray(100)); onBytes(bytes.length - 100); return { code: 0 };
      }, onProgress: value => progress.push(value), onStats: value => { transferStats = value; },
    });
    mock.timers.tick(29999); assert.equal(progress.length, 0);
    mock.timers.tick(1); assert.equal(progress.length, 1);
    assert.equal(progress[0].receivedBytes, 100);
    assert.equal(progress[0].percent, 100 / bytes.length * 100);
    assert.ok(progress[0].averageMBps > 0);
    finishRange(); await pending;
    assert.equal(transferStats.receivedBytes, bytes.length);
    mock.timers.tick(30000); assert.equal(progress.length, 1, 'progress stops at transfer completion');
  } finally { mock.timers.reset(); }
  assert.equal(parseArgs([...args, '--artifact-streams', '4', '--', 'true']).artifactStreams, 4);
  for (const value of ['0', '5', 'auto']) assert.throws(() => parseArgs([...args, '--artifact-streams', value, '--', 'true']));
  const all = invoke('artifacts', data);
  assert.equal(all.status, 0, all.stderr.toString());
  const sizeRecord = JSON.parse(/DEVBOX_ARTIFACT_SIZE=(\{[^\n]*\})/.exec(all.stderr.toString())[1]);
  assert.equal(sizeRecord.size, all.stdout.length);
  assert.equal(sizeRecord.reason, 'small set');
  assert.equal(fs.existsSync(path.join(control, 'artifact-archive.tar')), false);
  assert.equal(fs.existsSync(path.join(control, 'artifact-retention.json')), false);
  assert.match(all.stderr.toString(), new RegExp('DEVBOX_ARTIFACT_SHA256=' + createHash('sha256').update(all.stdout).digest('hex')));
  const tar = path.join(temp, 'all.tar'); fs.writeFileSync(tar, all.stdout);
  assert.deepEqual(execFileSync('tar', ['-xOf', tar, 'public.bin']), bytes);
  const manifest = invoke('artifacts', { ...data, fetch: 'manifest' });
  assert.equal(manifest.status, 0, manifest.stderr.toString());
  const receipt = JSON.parse(manifest.stdout.toString());
  assert.deepEqual(receipt.artifacts, [{ name: 'public.bin', size: bytes.length, sha256: digest }]);
  fs.writeFileSync(path.join(workspace, 'public.bin'), 'workspace reused');
  const fetched = invoke('fetch-artifact', { ...receipt, root, artifact: receipt.artifacts[0] });
  assert.equal(fetched.status, 0, fetched.stderr.toString()); assert.deepEqual(fetched.stdout, bytes);
  fs.writeFileSync(path.join(control, 'artifacts', 'public.bin'), Buffer.alloc(bytes.length));
  assert.notEqual(invoke('fetch-artifact', { ...receipt, root, artifact: receipt.artifacts[0] }).status, 0);
  assert.notEqual(invoke('fetch-artifact', { ...receipt, root, control: path.join(temp, 'elsewhere'), artifact: receipt.artifacts[0] }).status, 0);
  fs.symlinkSync(path.join(temp, 'outside'), path.join(workspace, 'link'));
  assert.notEqual(invoke('artifacts', { ...data, patterns: ['link'] }).status, 0);
  const file = path.join(temp, 'manifest.json'); fs.writeFileSync(file, JSON.stringify(receipt));
  const rows = [{ slot: data.slot, host: data.host, target: 'alice@192.0.2.1' }];
  assert.equal(readArtifactManifest(file, 'public.bin', rows).artifact.sha256, digest);
  assert.throws(() => readArtifactManifest(file, '../public.bin', rows));
  assert.throws(() => readArtifactManifest(file, 'missing.bin', rows));
  assert.throws(() => readArtifactManifest(file, 'public.bin', []));
  for (const invalid of ['/absolute', '../up', 'a/../b', 'a//b', 'a\\b', 'a\nb', '.', '']) assert.equal(artifactName(invalid), false);
  const state = {};
  assert.ok(controlOptions('inspect', state).includes('ControlMaster=auto'));
  assert.ok(Buffer.byteLength(state.sshControlDir + '/control-' + 'a'.repeat(40)) < 104);
  assert.ok(controlOptions('run', state).includes('ControlPath=none'));
  assert.notDeepEqual(controlOptions('artifacts', state), controlOptions('inspect', state));
  fs.rmSync(state.sshControlDir, { recursive: true });
  const large = path.join(workspace, 'large.bin'), fd = fs.openSync(large, 'w');
  try { for (let i = 0; i < 64; i++) fs.writeSync(fd, Buffer.alloc(1048576)); } finally { fs.closeSync(fd); }
  const staged = invoke('artifacts', { ...data, streams: 4, patterns: ['large.bin'] });
  assert.equal(staged.status, 0, staged.stderr.toString());
  const plan = JSON.parse(staged.stdout), chunks = [], length = Math.ceil(plan.size / 4);
  for (let i = 0; i < 4; i++) {
    const offset = i * length, range = invoke('artifact-range', { ...data, sha256: plan.sha256, offset, length: Math.min(length, plan.size - offset) });
    assert.equal(range.status, 0, range.stderr.toString()); chunks.push(range.stdout);
  }
  assert.equal(createHash('sha256').update(Buffer.concat(chunks)).digest('hex'), plan.sha256);
  assert.notEqual(invoke('artifact-range', { ...data, sha256: plan.sha256, offset: -1, length: 1 }).status, 0);
  assert.equal(invoke('artifact-release', { ...data, sha256: plan.sha256 }).status, 0);
  assert.equal(fs.existsSync(path.join(control, 'artifact-archive.tar')), false);
  const lowDisk = remoteScripts.artifacts.replace('\ndisk=os.statvfs(root)\n', '\nimport types\ndisk=types.SimpleNamespace(f_bavail=53*1073741824+1048576,f_frsize=1)\n');
  const fallback = invoke('artifacts', { ...data, streams: 4, patterns: ['large.bin'] }, lowDisk);
  assert.equal(fallback.status, 0, fallback.stderr.toString());
  assert.doesNotMatch(fallback.stderr.toString(), /DEVBOX_ARTIFACT_PLAN=/);
  const fallbackSize = JSON.parse(/DEVBOX_ARTIFACT_SIZE=(\{[^\n]*\})/.exec(fallback.stderr.toString())[1]);
  assert.equal(fallbackSize.reason, 'low disk'); assert.equal(fallbackSize.size, fallback.stdout.length);
  assert.match(fallback.stderr.toString(), new RegExp('DEVBOX_ARTIFACT_SHA256=' + createHash('sha256').update(fallback.stdout).digest('hex')));
  assert.equal(fs.existsSync(path.join(control, 'artifact-archive.tar')), false);
  console.log('PASS size-scaled timeout, cheap small direct streams, archive digest, immutable retention, named readback, corruption/path checks, isolated SSH sockets, staged ranges and low-disk direct fallback');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
