import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rulesShared } from './global-rules.mjs';
import { withLock, writeJson } from './shared-file.mjs';
import { canonicalPath } from './launch-paths.mjs';

export const sharedCliEnv = Object.freeze({ BYTEDCLI_NO_AUTO_UPGRADE: '1' });

export function resWorkerSandbox(mode, { directory, task, network, cwd } = {}) {
  if (!['read-only', 'workspace-write'].includes(mode)) throw Error('--needs-res requires a bounded sandbox');
  const root = canonicalPath(process.env.RES_DIR || path.join(os.homedir(), '.claude/orchestrator/_shared'));
  if (root === path.parse(root).root) throw Error('--needs-res requires a res state directory below the filesystem root');
  if (directory !== undefined && (typeof directory !== 'string' || canonicalPath(directory) !== root))
    throw Error('--res-state-directory must match RES_DIR or the default res directory');
  if (typeof task !== 'string' || !task.trim() || task === '.' || task === '..') throw Error('--needs-res requires a task name');
  const scratch = path.join(root, 'tmp', 'needs-res', encodeURIComponent(task));
  if (canonicalPath(scratch) !== scratch) throw Error('--needs-res scratch directory must be inside the res scratch tree without symlinks');
  if (mode === 'workspace-write' && cwd) {
    const workspace = canonicalPath(cwd);
    const fromRes = path.relative(root, workspace);
    const inRes = fromRes !== '' && !fromRes.startsWith('..' + path.sep) && fromRes !== '..' && !path.isAbsolute(fromRes);
    const taskWorkspace = fromRes.split(path.sep)[0] === 'tasks' && fromRes.split(path.sep).length >= 2;
    const coversRes = workspace === root || root.startsWith(workspace.endsWith(path.sep) ? workspace : workspace + path.sep);
    if (coversRes || (inRes && !taskWorkspace)) throw Error('--needs-res workspace overlaps the res control directory');
  }
  const profile = 'orchestrator_res';
  return {
    default_permissions: profile,
    permissions: {
      [profile]: {
        extends: mode === 'read-only' ? ':read-only' : ':workspace',
        filesystem: { [scratch]: 'write' },
        ...(network === undefined ? {} : { network: { enabled: network } }),
      },
    },
    shell_environment_policy: { set: { ...sharedCliEnv, RES_DIR: root, RES_QUERY_SCRATCH: scratch, TMPDIR: scratch } },
  };
}

// A legacy workspaceWrite reply can represent several filesystem profiles.
// For a read-only baseline, require the named profile or explicit read-only
// evidence with the exact root. False means mismatch, null means no proof.
export function resWorkerSandboxVerified(response, config) {
  const profile = response?.activePermissionProfile ?? response?.thread?.activePermissionProfile;
  const sandbox = response?.sandbox ?? response?.thread?.sandbox;
  const name = config.default_permissions;
  const { extends: base, network } = config.permissions[name];
  const type = typeof sandbox === 'string' ? sandbox : sandbox?.type;
  if (type && !['workspaceWrite', 'workspace-write', 'readOnly', 'read-only'].includes(type)) return false;
  const roots = sandbox?.writableRoots ?? undefined;
  const expected = config.shell_environment_policy.set.TMPDIR;
  if (roots !== undefined && (!Array.isArray(roots) || roots.length !== 1 || roots[0] !== expected)) return false;
  if (network && typeof sandbox?.networkAccess === 'boolean' && sandbox.networkAccess !== network.enabled) return false;
  if (profile != null) {
    const id = typeof profile === 'string' ? profile : profile.id;
    return id === name && (profile.extends == null || profile.extends === base);
  }
  if (roots !== undefined && ['workspaceWrite', 'workspace-write', 'readOnly', 'read-only'].includes(type))
    return base === ':workspace' || type === 'readOnly' || type === 'read-only' ? true : null;
  return null;
}

export const claudeWorkspacePreamble = (workspace, review = false) => review
  ? `The repository under review is ${workspace}. Read it with git -C or absolute paths. Make your own worktree for tests.`
  : `The task workspace is ${workspace}. Use git -C or absolute paths to access it.`;

const keys = ['route-args', 'auto-reroute-depth', 'owner', 'name', 'cwd', 'log', 'out', 'stall-min',
  'queue-patience-min', 'alt', 'queue-alternative', 'queue-alt-start-min', 'background', 'require-model', 'no-auto-continue', 'model', 'effort',
  // Browser/desktop scope must survive a continuation: without it the hub answers every site approval with a decline
  // and the worker reports "The user declined approval" (VAK W304-queue-cancel-2, 2026-11-15).
  'browser-origins', 'computer-use-apps', 'chrome-profile-dir','project','task','role','routed-seat','sandbox','network','needs-res'];
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
    ['cwd', 'log', 'out'].includes(key) ? canonicalPath(opts[key]) : opts[key]]));
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
export const savedLaunch = (account, thread) => readLaunch(launchFile(account, thread));
export const saveLaunch = (account, thread, opts, owner, evidence = {}) => {
  const file = launchFile(account, thread);
  const defaults = launchDefaults(opts, owner);
  withLock(file, () => {
    const record = readLaunch(file);
    // --force-large permits a turn without clearing the provider's size evidence.
    writeJson(file, { account, thread, t: Date.now(), defaults, effort: opts.effort ?? record?.effort ?? null, ...evidence,
      ...(record?.requestBufferExceededAt != null ? { requestBufferExceededAt: record.requestBufferExceededAt } : {}),
      ...(record?.retirement ? { retirement: record.retirement } : {}),
      ...(record?.ownerInterrupts ? { ownerInterrupts: record.ownerInterrupts } : {}),
      ...(record?.transportRetry ? { transportRetry: record.transportRetry } : {}) });
  });
};
// The claim is durable before backoff/RPC. Uncertain starts are never repeated.
export const claimTransportContinuation = (account, thread, turn, now = Date.now()) => {
  const file = launchFile(account, thread);
  return withLock(file, () => {
    const record = readLaunch(file);
    if (!record) return 'missing launch metadata';
    if (record.transportRetry?.sourceTurn === turn || record.transportRetry?.continuationTurn === turn)
      return 'one automatic continuation already claimed';
    if (record.transportRetry && !record.transportRetry.continuationTurn)
      return 'unacknowledged automatic continuation claim is consumed; reconcile it explicitly';
    if (record.turn && record.turn !== turn) return 'launch metadata belongs to a newer turn; reconcile it before continuing';
    writeJson(file, { ...record, transportRetry: { sourceTurn: turn, phase:'claimed', claimedAt: now, pid: process.pid } });
    return null;
  });
};
export const markTransportContinuationStarting = (account, thread, sourceTurn, now = Date.now()) => {
  const file = launchFile(account, thread);
  return withLock(file, () => {
    const record = readLaunch(file);
    if (record?.transportRetry?.sourceTurn !== sourceTurn || record.transportRetry.continuationTurn)
      throw Error('transport continuation claim changed before start');
    writeJson(file,{...record,transportRetry:{...record.transportRetry,phase:'starting',startRequestedAt:now}});
  });
};
export const saveTransportContinuation = (account, thread, sourceTurn, continuationTurn) => {
  const file = launchFile(account, thread);
  return withLock(file, () => {
    const record = readLaunch(file);
    if (record?.transportRetry?.sourceTurn !== sourceTurn) throw Error('transport retry claim changed');
    writeJson(file, { ...record, turn: continuationTurn, transportRetry: { ...record.transportRetry,
      phase:'acknowledged',acknowledgedAt:Date.now(),continuationTurn } });
  });
};
// Record the request before the RPC so a fast hub completion can see it.
export const markOwnerInterrupt = (account, thread, turn) => {
  const file = launchFile(account, thread);
  withLock(file, () => {
    const record = readLaunch(file);
    if (record && !Object.hasOwn(record.ownerInterrupts ?? {}, turn)) writeJson(file, { ...record, ownerInterrupts: { ...record.ownerInterrupts, [turn]: Date.now() } });
  });
};
export const ownerInterruptAt = (account, thread, turn) =>
  savedLaunch(account, thread)?.ownerInterrupts?.[turn];

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

const retireAfterMs = 6 * 60 * 60 * 1000;
export function retirementHint(record, now = Date.now(), turn = record?.turn) {
  const stats = record?.retirement;
  const activeMs = turn && turn === record?.turn && turn !== stats?.measuredTurn && Number.isFinite(record.t)
    ? Math.max(0, now - record.t) : 0;
  const turnHours = ((stats?.turnMs ?? 0) + activeMs) / 3600000, steers = stats?.steers ?? 0;
  return turnHours >= retireAfterMs / 3600000 || steers >= 15
    ? `large-thread: ${record.thread}: ${turnHours.toFixed(1)}h of turn time, ${steers} steers; consider retiring this thread` : null;
}

export function recordRetirementEvidence(account, thread, turn, event, now = Date.now()) {
  const file = launchFile(account, thread);
  return withLock(file, () => {
    const record = readLaunch(file);
    if (!record) return null;
    const retirement = { ...record.retirement };
    if (event === 'steer') retirement.steers = (retirement.steers ?? 0) + 1;
    if (event === 'ended' && record.turn === turn && retirement.measuredTurn !== turn) {
      retirement.turnMs = (retirement.turnMs ?? 0) + (Number.isFinite(record.t) ? Math.max(0, now - record.t) : 0);
      retirement.measuredTurn = turn;
    }
    const next = { ...record, retirement };
    writeJson(file, next);
    return retirementHint(next, now, turn);
  });
}
