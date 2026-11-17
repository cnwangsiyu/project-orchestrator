import fs from 'node:fs';
import path from 'node:path';
import { rulesShared } from './global-rules.mjs';
import { withLock, writeJson } from './shared-file.mjs';

const keys = ['route-args', 'auto-reroute-depth', 'owner', 'name', 'cwd', 'log', 'out', 'stall-min',
  'queue-patience-min', 'alt', 'queue-alternative', 'queue-alt-start-min', 'background', 'require-model',
  // Browser/desktop scope must survive a continuation: without it the hub answers every site approval with a decline
  // and the worker reports "The user declined approval" (VAK W304-queue-cancel-2, 2026-11-15).
  'browser-origins', 'computer-use-apps', 'chrome-profile-dir','project','role','routed-seat','sandbox','network'];
const launchFile = (account, thread) => {
  if (![account, thread].every((v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(v)))
    throw Error('invalid public account/thread identifier');
  return path.join(rulesShared(), 'worker-launches', account, `${thread}.json`);
};
const readLaunch = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
};
const launchDefaults = (opts, owner = opts.owner) => {
  const defaults = Object.fromEntries(keys.filter((key) => opts[key] !== undefined).map((key) => [key,
    ['cwd', 'log', 'out'].includes(key) ? path.resolve(opts[key]) : opts[key]]));
  if (owner) defaults.owner = owner;
  return defaults;
};
export const inheritedLaunch = (account, opts) => {
  const record = readLaunch(launchFile(account, opts.thread));
  if (!record) return null;
  if (record.account !== account || record.thread !== opts.thread || !record.defaults) throw Error('invalid launch record');
  return Object.fromEntries(keys.filter((key) => opts[key] === undefined && record.defaults[key] !== undefined)
    .map((key) => [key, record.defaults[key]]));
};
export const saveLaunch = (account, thread, opts, owner, evidence = {}) => {
  const file = launchFile(account, thread);
  const defaults = launchDefaults(opts, owner);
  withLock(file, () => {
    const record = readLaunch(file);
    // --force-large permits a turn without clearing the provider's size evidence.
    writeJson(file, { account, thread, t: Date.now(), defaults, ...evidence,
      ...(record?.requestBufferExceededAt != null ? { requestBufferExceededAt: record.requestBufferExceededAt } : {}) });
  });
};
export const readRequestBufferExceededAt = (account, thread) => readLaunch(launchFile(account, thread))?.requestBufferExceededAt ?? null;
export const markRequestBufferExceeded = (account, thread, opts = {}, now = Date.now()) => {
  const file = launchFile(account, thread);
  return withLock(file, () => {
    const record = readLaunch(file) ?? { account, thread, t: now, defaults: launchDefaults(opts) };
    const at = record.requestBufferExceededAt ?? now;
    writeJson(file, { ...record, requestBufferExceededAt: at });
    return at;
  });
};
export const recordLaunchModel = (account, thread, turn, evidence) => {
  const file = launchFile(account, thread);
  withLock(file, () => {
    const record = readLaunch(file);
    // A stale follower must not replace a newer continuation's model evidence.
    if (record && (record.turn == null || record.turn === turn))
      writeJson(file, { ...record, turn, ...evidence, modelObservedAt: Date.now() });
  });
};
