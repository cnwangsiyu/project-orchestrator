// Monitoring writes only public worker events. Never invoke a notification command from a registry.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rulesShared } from './global-rules.mjs';
import { appendEvent, readEvents, validOwner } from './worker-events.mjs';
import { withLock, writeJson } from './shared-file.mjs';

export function monitoringOwner(shared = rulesShared()) {
  if (validOwner(process.env.MONITOR_OWNER)) return process.env.MONITOR_OWNER;
  try {
    const file = path.join(shared, 'monitor-owner.json'), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) return null;
    const row = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (validOwner(row.owner)) return row.owner;
  } catch {}
  return null;
}

export function notifyMonitorFailure(cause, { owner = monitoringOwner(), event = 'stalled', now = Date.now(),
  intervalMs = 6 * 3600000, emit = appendEvent, rows = readEvents, shared = rulesShared() } = {}) {
  if (!validOwner(owner)) return { notified: false, unknown: 'monitoring owner is unconfigured' };
  if (!['stalled', 'failed'].includes(event) || !/^[a-zA-Z0-9_.:/-]{1,160}$/.test(cause)) throw Error('invalid monitoring cause');
  fs.mkdirSync(shared, { recursive: true });
  // Recheck under one monitor lock; failed event appends never consume the cooldown.
  return withLock(path.join(shared, 'monitor-notifications'), () => {
    const file = path.join(shared, 'monitor-notifications-state.json');
    let state = {};
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw Error('unsafe notification state');
      state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!state || typeof state !== 'object' || Array.isArray(state)) throw Error('invalid notification state');
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const key = `${owner}/${cause}`;
    const prior = rows().findLast(row => row.owner === owner && row.monitorCause === cause);
    const lastAt = Math.max(state[key] ?? -Infinity, prior?.t ?? -Infinity);
    if (now - lastAt < intervalMs) return { notified: false, suppressed: true };
    const row = emit({ runId: randomUUID(), owner, event, name: `monitor:${cause}`, account: 'monitor',
      monitorCause: cause, finalLine: `Monitoring ${event}: ${cause}; inspect the monitoring report (missing evidence is UNKNOWN).` });
    state[key] = now;
    writeJson(file, state);
    return { notified: true, id: row.id };
  });
}
