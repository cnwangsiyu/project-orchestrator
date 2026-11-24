#!/usr/bin/env node
// Private storage helper for `res device-app`.  The public interface and lease
// check live in res; keeping JSON I/O here makes updates atomic and testable.
import fs from 'node:fs';
import path from 'node:path';

const [action, root, ...args] = process.argv.slice(2);
const fail = (message, code = 1) => { console.error(`res: ${message}`); process.exit(code); };
const text = (value, label) => {
  if (typeof value !== 'string' || !value || value.length > 240 || /[\n\r\0]/.test(value)) fail(`invalid ${label}`);
  return value;
};
const deviceId = value => /^[A-Za-z0-9._-]{1,120}$/.test(value ?? '') ? value : fail('invalid device id');
const project = value => /^[A-Za-z0-9._-]{1,120}$/.test(value ?? '') ? value : fail('invalid project');
const bundle = value => /^[A-Za-z0-9._-]{1,255}$/.test(value ?? '') && value.includes('.') ? value : fail('invalid bundle id');
const statePath = path.join(path.resolve(root), 'device-apps.json');
const lockPath = `${statePath}.lock`;

function readState() {
  try {
    const value = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (value?.schema !== 1 || typeof value.devices !== 'object' || !value.devices || Array.isArray(value.devices)) throw Error('schema');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return { schema: 1, devices: {} };
    fail('device-app registry is invalid; refusing to use it');
  }
}
function record(state, device, id) {
  const byDevice = state.devices[device];
  const value = byDevice?.[id];
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !project(value.project) || !text(value.name, 'stored app name') || !text(value.version, 'stored app version') || !text(value.task, 'stored task') || !Number.isFinite(value.at)) fail('device-app registry is invalid; refusing to use it');
  return value;
}
function withLock(fn) {
  const until = Date.now() + 3000;
  for (;;) {
    try { fs.mkdirSync(lockPath, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST' || Date.now() >= until) fail('device-app registry is busy; retry', 2);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return fn(); } finally { fs.rmdirSync(lockPath, { recursive: true, force: true }); }
}
function outputCheck(value, caller, expected) {
  if (!value) { console.log('UNREGISTERED'); process.exitCode = 5; return; }
  if (value.project === caller && (!expected || value.name === expected)) { console.log('OWNED-BY-YOU'); return; }
  console.log(`OWNED-BY-OTHER ${value.project} (${value.name} ${value.version})`);
  process.exitCode = 4;
}

if (action === 'check') {
  const [device, id, caller, expected = ''] = args;
  if (args.length < 3 || args.length > 4) fail('device-app check internal arguments invalid');
  outputCheck(record(readState(), deviceId(device), bundle(id)), project(caller), expected && text(expected, 'expected app name'));
} else if (action === 'list') {
  const [device] = args;
  if (args.length !== 1) fail('device-app list internal arguments invalid');
  const entries = readState().devices[deviceId(device)] ?? {};
  const rows = Object.entries(entries).map(([id, value]) => ({ bundle: bundle(id), ...record(readState(), device, id) }));
  console.log(JSON.stringify(rows.sort((a, b) => a.bundle.localeCompare(b.bundle))));
} else if (action === 'claim') {
  const [deviceValue, idValue, projectValue, nameValue, versionValue, taskValue, transferValue = '', reasonValue = ''] = args;
  if (args.length < 6 || args.length > 8) fail('device-app claim internal arguments invalid');
  const device = deviceId(deviceValue), id = bundle(idValue), caller = project(projectValue);
  const name = text(nameValue, 'app name'), version = text(versionValue, 'app version'), task = text(taskValue, 'task');
  const transfer = transferValue && text(transferValue, 'transfer approver');
  const reason = reasonValue && text(reasonValue, 'transfer reason');
  if ((transfer && !reason) || (!transfer && reason)) fail('transfer needs approver and reason');
  let conflict = null;
  withLock(() => {
    const state = readState(), old = record(state, device, id);
    if (old && old.project !== caller && !transfer) {
      conflict = old;
      return;
    }
    state.devices[device] ??= {};
    state.devices[device][id] = { project: caller, name, version, task, at: Math.floor(Date.now() / 1000), ...(transfer ? { transferApprovedBy: transfer, transferReason: reason } : {}) };
    const temporary = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, statePath);
  });
  if (conflict) {
    console.error(`OWNED-BY-OTHER ${conflict.project} (${conflict.name} ${conflict.version})`);
    process.exit(4);
  }
  console.log(`CLAIMED ${device} ${id}`);
} else {
  fail('unknown device-app action');
}
