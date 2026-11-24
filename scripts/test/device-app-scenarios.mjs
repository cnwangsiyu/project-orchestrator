#!/usr/bin/env node
// Scratch-only checks for the shared-device ownership registry and guard.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const res = path.join(root, 'scripts/res/res');
const guard = path.join(root, 'scripts/device-app-guard.sh');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'device-app-registry-'));
const env = { ...process.env, RES_DIR: scratch, RULES_SHARED: scratch, DEVICE_APP_RES: res };
const run = (exe, args, extra = {}) => spawnSync(exe, args, { env: { ...env, ...extra }, encoding: 'utf8' });
const expect = (expected, exe, ...args) => {
  const result = run(exe, args);
  assert.equal(result.status, expected, `${args.join(' ')}\n${result.stdout}${result.stderr}`);
  return result;
};
try {
  fs.mkdirSync(path.join(scratch, 'locks'), { recursive: true });
  fs.writeFileSync(path.join(scratch, 'resources.tsv'), 'iphone11\tdevice\topen\tfixture-udid\tfixture shared iPhone\ncheckout\tcheckout\topen\t-\tfixture checkout\n');
  fs.mkdirSync(path.join(scratch, 'locks/iphone11.d'));
  fs.writeFileSync(path.join(scratch, 'locks/iphone11.d/info'), 'by\tfixture-holder\nproject\tvideo-agent\ntask\tfixture\n');
  const base = ['device-app'];
  assert.equal(expect(5, res, ...base, 'check', '--device', 'iphone11', '--bundle', 'com.example.app', '--project', 'video-agent').stdout.trim(), 'UNREGISTERED');
  assert.equal(expect(1, res, ...base, 'claim', '--device', 'iphone11', '--bundle', 'com.example.app', '--project', 'video-agent', '--name', 'VideoAgent', '--version', '0.1.0 (277)', '--task', 'R-fixture', '--by', 'not-holder').status, 1);
  assert.equal(expect(0, res, ...base, 'claim', '--device', 'iphone11', '--bundle', 'com.example.app', '--project', 'video-agent', '--name', 'VideoAgent', '--version', '0.1.0 (277)', '--task', 'R-fixture', '--by', 'fixture-holder').stdout.trim(), 'CLAIMED iphone11 com.example.app');
  assert.equal(expect(0, res, ...base, 'check', '--device', 'iphone11', '--bundle', 'com.example.app', '--project', 'video-agent', '--expect-name', 'VideoAgent').stdout.trim(), 'OWNED-BY-YOU');
  const other = expect(4, res, ...base, 'check', '--device', 'iphone11', '--bundle', 'com.example.app', '--project', 'vesdk-mainline');
  assert.match(other.stdout.trim(), /^OWNED-BY-OTHER video-agent \(VideoAgent 0\.1\.0 \(277\)\)$/);
  assert.equal(JSON.parse(expect(0, res, ...base, 'list', '--device', 'iphone11').stdout)[0].bundle, 'com.example.app');
  assert.equal(expect(4, res, ...base, 'claim', '--device', 'iphone11', '--bundle', 'com.example.app', '--project', 'vesdk-mainline', '--name', 'TikTok', '--version', '1', '--task', 'other', '--by', 'fixture-holder').status, 4);
  assert.equal(expect(0, res, ...base, 'claim', '--device', 'iphone11', '--bundle', 'com.example.app', '--project', 'vesdk-mainline', '--name', 'TikTok', '--version', '1', '--task', 'other', '--by', 'fixture-holder', '--transfer-approved-by', 'owner-session', '--reason', 'fixture transfer').status, 0);
  const accepted = expect(0, '/bin/bash', guard, '--device', 'iphone11', '--bundle', 'com.example.app', '--project', 'vesdk-mainline', '--expect-name', 'TikTok', '--actual-name', 'TikTok', '--actual-version', '1');
  assert.match(accepted.stdout, /DEVICE-APP-GUARD PASS/);
  const mismatch = expect(3, '/bin/bash', guard, '--device', 'iphone11', '--bundle', 'com.example.app', '--project', 'vesdk-mainline', '--expect-name', 'TikTok', '--actual-name', 'VideoAgent', '--actual-version', '0.1.0 (277)');
  assert.match(mismatch.stderr, /REFUSED/);
  const collision = expect(3, '/bin/bash', guard, '--device', 'iphone11', '--bundle', 'com.unknown.app', '--project', 'vesdk-mainline', '--expect-name', 'TikTok', '--actual-name', 'VideoAgent', '--actual-version', '0.1.0 (277)');
  assert.match(collision.stderr, /unregistered but installed/);
  const newInstall = expect(0, '/bin/bash', guard, '--device', 'iphone11', '--bundle', 'com.unknown.app', '--project', 'vesdk-mainline', '--expect-name', 'TikTok', '--actual-name', '-', '--actual-version', '-');
  assert.match(newInstall.stdout, /unregistered and not installed/);
  console.log('PASS device-app registry leases, ownership transfer, distinct checks and no-device guard');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
