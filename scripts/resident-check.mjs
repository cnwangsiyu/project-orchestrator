#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { rulesShared } from './lib/global-rules.mjs';
import { appendEvent, readEvents, validOwner } from './lib/worker-events.mjs';
import { withLock, writeJson } from './lib/shared-file.mjs';
import { unsafeFile } from './lib/resource-data.mjs';

export function checkResidents({ shared = rulesShared(), now = Date.now(), notify = false } = {}) {
  const file = path.join(shared, 'resident-workers.json'), residents = [], errors = [];
  let registry;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw Error('unsafe registry');
    registry = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(registry) || registry.length > 200) throw Error('invalid registry');
  } catch (e) {
    return { status: e.code === 'ENOENT' ? 'UNCONFIGURED' : 'UNKNOWN', residents, missing: [], errors: e.code === 'ENOENT' ? [] : ['resident registry unreadable'] };
  }
  const names = new Set();
  for (const row of registry) {
    if (!row || !/^[A-Za-z0-9_.-]{1,120}$/.test(row.name) || names.has(row.name) || !validOwner(row.owner)
      || !path.isAbsolute(row.heartbeatFile ?? '') || unsafeFile(row.heartbeatFile)
      || !Number.isFinite(row.maxAgeMinutes) || row.maxAgeMinutes <= 0 || row.notify !== 'worker-event') {
      errors.push('invalid/duplicate resident registration'); continue;
    }
    names.add(row.name);
    let heartbeatAt = null, status = 'MISSING';
    try {
      // Metadata only. The heartbeat's contents are never read.
      const real = fs.realpathSync(row.heartbeatFile);
      if (unsafeFile(real)) throw Error('unsafe heartbeat');
      const stat = fs.lstatSync(row.heartbeatFile);
      if (!stat.isFile() || stat.isSymbolicLink()) throw Error('unsafe heartbeat');
      heartbeatAt = stat.mtimeMs;
      status = heartbeatAt > now + 60000 ? 'UNKNOWN' : now - heartbeatAt > row.maxAgeMinutes * 60000 ? 'STALE' : 'HEALTHY';
    } catch (e) { if (e.code !== 'ENOENT') status = 'UNKNOWN'; }
    residents.push({ name: row.name, owner: row.owner, heartbeatAt, maxAgeMinutes: row.maxAgeMinutes, status });
  }
  const missing = residents.filter(row => row.status !== 'HEALTHY');
  if (notify) {
    if (shared !== rulesShared()) throw Error('notification shared directory must match RULES_SHARED');
    withLock(path.join(shared, 'resident-check'), () => {
      const stateFile = path.join(shared, 'resident-check-state.json');
      let state = {};
      try {
        const stat = fs.lstatSync(stateFile);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw Error('unsafe incident state');
        state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (!state || typeof state !== 'object' || Array.isArray(state)) throw Error('invalid incident state');
      } catch (e) { if (e.code !== 'ENOENT') throw Error('resident incident state unreadable'); }
      const events = readEvents();
      for (const row of residents) {
        const key = `${row.owner}/${row.name}`;
        const prior = events.findLast(e => e.resident === row.name && e.owner === row.owner);
        let lastSeq = state[key]?.lastSeq ?? 0;
        const active = prior && (prior.seq ?? 0) > lastSeq ? prior.event === 'stalled'
          : state[key]?.active ?? prior?.event === 'stalled';
        let event = prior;
        if (row.status === 'HEALTHY') {
          if (active) event = appendEvent({ runId: randomUUID(), event: 'observed', owner: row.owner,
            account: 'resident', name: row.name, resident: row.name, residentHealthy: true });
        } else if (!active) {
          event = appendEvent({ runId: randomUUID(), event: 'stalled', owner: row.owner, account: 'resident', name: row.name,
            resident: row.name, residentHeartbeatAt: row.heartbeatAt,
            finalLine: `Resident ${row.name}: ${row.status}; heartbeat age exceeds ${row.maxAgeMinutes}m or cannot be checked.` });
        }
        state[key] = { active: row.status !== 'HEALTHY', heartbeatAt: row.heartbeatAt, lastSeq: Math.max(lastSeq, event?.seq ?? 0) };
      }
      writeJson(stateFile, state);
    });
  }
  return { status: errors.length ? 'UNKNOWN' : missing.length ? 'MISSING' : 'HEALTHY', residents, missing, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--read-only', '--json'].includes(arg))) throw Error('unknown resident-check option');
  const result = checkResidents({ notify: !args.includes('--read-only') });
  console.log(JSON.stringify(result));
  if (['UNKNOWN', 'MISSING'].includes(result.status)) process.exitCode = 2;
}
