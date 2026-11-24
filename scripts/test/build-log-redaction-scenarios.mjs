#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { maskLogText } from '../lib/nightly-audit.mjs';
import { claimOutputDirectory } from '../lib/masking-scope.mjs';

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const cli = path.join(root, 'scripts/mask-logs.mjs');
const wrapper = path.join(root, 'scripts/heavy-build.sh');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'build-log-redaction-'));
const lines = text => text.split('\n').length;

try {
  const giant = `compiler says "${'x'.repeat(2 * 1024 * 1024)}\nTOKEN=FAKE_GIANT_VALUE_123\n`;
  const giantMasked = maskLogText(giant);
  assert.equal(giantMasked.masked, 1); assert.ok(!giantMasked.text.includes('FAKE_GIANT_VALUE_123'));
  const logs = path.join(temp, 'logs'); fs.mkdirSync(logs);
  const scope = claimOutputDirectory(logs);
  const ownership = ['--run-dir', scope.directory, '--run-id', scope.runId];
  const gradle = path.join(logs, 'gradle-failure.log');
  const xcode = path.join(logs, 'xcodebuild.txt');
  const gradleText = [
    'Gradle properties:',
    'NEXUS_MAGIC_WORD=FAKE_NEXUS_VALUE_123',
    'storePassword "FAKE_STORE_PASSWORD_456"',
    'ACCESS_KEY=FAKE_ACCESS_KEY_789',
    'BUILD_NUMBER=42',
    'FAILURE: Build failed',
    '',
  ].join('\n');
  const xcodeText = [
    'Build settings from command line:',
    '    TOKEN_NAME = FAKE_XCODE_TOKEN_123',
    '    PRODUCT_NAME = Fixture',
    '** BUILD FAILED **',
    '',
  ].join('\n');
  fs.writeFileSync(gradle, gradleText); fs.writeFileSync(xcode, xcodeText);
  const binary = path.join(logs, 'binary.log'); fs.writeFileSync(binary, Buffer.from([0, 1, 2, 3]));
  const outside = path.join(temp, 'outside.log'); fs.writeFileSync(outside, 'SECRET=FAKE_OUTSIDE_VALUE_123\n');
  fs.symlinkSync(outside, path.join(logs, 'linked.log'));
  const rollout = path.join(logs, 'rollout.jsonl');
  const encrypted = '{"encrypted_content":"TOKEN=FAKE_OPAQUE_VALUE_123"}\n'; fs.writeFileSync(rollout, encrypted);
  let deep = logs;
  for (let i = 0; i < 120; i++) { deep = path.join(deep, `d${i}`); fs.mkdirSync(deep); }
  const deepLog = path.join(deep, 'deep.out'); fs.writeFileSync(deepLog, 'SECRET=FAKE_DEEP_VALUE_123\n');

  const dry = spawnSync(process.execPath, [cli, '--dry-run', ...ownership, logs], { encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.ok(dry.stdout.includes(`${gradle}\t3`)); assert.ok(dry.stdout.includes(`${xcode}\t1`));
  assert.ok(dry.stdout.includes(`${deepLog}\t1`));
  assert.ok(!dry.stdout.includes('FAKE_')); assert.equal(fs.readFileSync(gradle, 'utf8'), gradleText);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'SECRET=FAKE_OUTSIDE_VALUE_123\n');
  assert.equal(fs.readFileSync(rollout, 'utf8'), encrypted);

  const masked = spawnSync(process.execPath, [cli, '--force', ...ownership, logs], { encoding: 'utf8' });
  assert.equal(masked.status, 0, masked.stderr); assert.ok(!masked.stdout.includes('FAKE_'));
  const maskedGradle = fs.readFileSync(gradle, 'utf8'), maskedXcode = fs.readFileSync(xcode, 'utf8');
  assert.equal(lines(maskedGradle), lines(gradleText)); assert.equal(lines(maskedXcode), lines(xcodeText));
  assert.ok(maskedGradle.includes('NEXUS_MAGIC_WORD=[MASKED]'));
  assert.ok(maskedGradle.includes('storePassword "[MASKED]"'));
  assert.ok(maskedGradle.includes('ACCESS_KEY=[MASKED]'));
  assert.ok(maskedXcode.includes('TOKEN_NAME = [MASKED]'));
  assert.equal(fs.readFileSync(binary).length, 4); assert.equal(fs.readFileSync(outside, 'utf8'), 'SECRET=FAKE_OUTSIDE_VALUE_123\n');
  assert.equal(fs.readFileSync(rollout, 'utf8'), encrypted);

  const bin = path.join(temp, 'bin'); fs.mkdirSync(bin);
  const fakeRes = path.join(bin, 'res');
  fs.writeFileSync(fakeRes, `#!${process.execPath}\nconst a=process.argv.slice(2);\nif(a[0]==='wait-build'&&a[1]==='--help'){console.log('wait-build --lane');process.exit(0)}\nif(a[0]==='wait-build'){console.log('build-lane=heavy-lane-1');process.exit(0)}\nif(a[0]==='return-build')process.exit(0);\nprocess.exit(9);\n`, { mode: 0o755 });
  const captured = path.join(temp, 'captured-build.log');
  const command = `process.stdout.write('NEXUS_MAGIC_WORD=FAKE_CAPTURED_NEXUS_123\\n');process.stdout.write('storePassword "FAKE_CAPTURED_PASSWORD_456"\\n');process.stdout.write('TOKEN_NAME = FAKE_CAPTURED_XCODE_789\\n');process.exit(17)`;
  const run = spawnSync('/bin/bash', [wrapper, process.execPath, '-e', command], {
    encoding: 'utf8',
    env: { ...process.env, RES_COMMAND: fakeRes, HEAVY_BUILD_BY: 'fixture', HEAVY_BUILD_PROJECT: 'fixture',
      HEAVY_BUILD_TASK: 'BC-111', HEAVY_BUILD_TIMEOUT: '1', HEAVY_BUILD_LOG: captured },
  });
  assert.equal(run.status, 17, run.stderr);
  assert.match(run.stderr, /log-redaction files=1 masked=3/); assert.ok(!run.stderr.includes('FAKE_'));
  const capturedText = fs.readFileSync(captured, 'utf8');
  assert.equal(lines(capturedText), 4); assert.ok(!capturedText.includes('FAKE_'));
  assert.match(capturedText, /NEXUS_MAGIC_WORD=\[MASKED\]/);
  assert.match(capturedText, /storePassword "\[MASKED\]"/);
  assert.match(capturedText, /TOKEN_NAME = \[MASKED\]/);
  // BC-123: upload CLI key forms (access key ids, -ak/-sk, signed URL params, tosutil -i/-k).
  const V = 'FAKE_AK_VALUE_7781';
  for (const form of [`--access_key_id ${V}`, `--access-key-id=${V}`, `-ak ${V}`, `--ak ${V}`, `AK=${V}`, `accessKeyId=${V}`, `AccessKeyId: ${V}`,
    `ACCESS_KEY_ID=${V}`, `-sk ${V}`, `--secret-access-key ${V}`, `secret_access_key=${V}`, `tosutil cp a tos://b -i ${V} -k ${V}`,
    `?X-Tos-Credential=${V}%2F20261118`, `&AccessKeyId=${V}&Signature=${V}`]) {
    assert.ok(!maskLogText(`upload ${form}\n`).text.includes(V), `masks ${form.replaceAll(V, 'V')}`);
  }
  for (const plain of ['curl -k https://example.invalid', 'ls -i build', 'tar -xk archive']) assert.equal(maskLogText(plain).masked, 0, `keeps ${plain}`);
  console.log('PASS build log masking: Gradle/Xcode values, dry-run secrecy, binary/symlink/JSONL skips, line structure and exit preservation');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
