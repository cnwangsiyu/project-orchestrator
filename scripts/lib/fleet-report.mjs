import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOUR = 3600000, DAY = 24 * HOUR;
const round = n => Number.isFinite(n) ? +n.toFixed(2) : null;
export const remoteHost = description => description.match(/[A-Za-z0-9_.-]+@([A-Za-z0-9][A-Za-z0-9.-]*)/)?.[1].replace(/\.$/, '') ?? null;
const identity = holder => /^(.*) \(([^()]*)\)$/.exec(holder)?.[1] ?? holder;
const timestamp = value => Date.parse(value?.replace(' ', 'T'));

export function waitStats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = p => sorted.length ? round(sorted[Math.ceil(sorted.length * p) - 1]) : null;
  return { count: sorted.length, p50Minutes: percentile(.5), p90Minutes: percentile(.9), maxMinutes: percentile(1) };
}

// Work hours are explicitly PST (UTC-08:00), including weekends, as requested.
function workHoursMs(start, end) {
  let result = 0;
  for (let day = Math.floor((start - 8 * HOUR) / DAY) * DAY; day + 17 * HOUR < end; day += DAY) {
    result += Math.max(0, Math.min(end, day + 29 * HOUR) - Math.max(start, day + 17 * HOUR));
  }
  return result;
}

export function computeFleet({ log, registry, now = Date.now(), since = now - 24 * HOUR, holders = null, probes = null, health = null }) {
  if (!Number.isFinite(since) || !Number.isFinite(now) || since >= now) throw Error('report window must start before now');
  const warnings = [], resources = new Map(), active = new Map(), pending = new Map(), queues = new Map(), latestTake = new Map();
  const buildDurations = { solo: [], concurrent: [] };
  const duration = now - since, workDuration = workHoursMs(since, now);
  for (const line of registry.split('\n').filter(l => l.trim() && !l.startsWith('#'))) {
    const [id, kind, policy, , ...description] = line.split('\t');
    if (!id || !kind || !policy || !description.length || resources.has(id)) throw Error('invalid or duplicate resource registry row');
    const host = kind === 'remote' ? remoteHost(description.join('\t')) : null;
    resources.set(id, { id, kind, policy, box: kind === 'remote' ? host ?? 'unknown-remote' : 'mini',
      busyMs: 0, workBusyMs: 0, takes: 0, waits: [], currentHolders: [] });
  }
  let invalidLines = 0;
  const events = log.split('\n').filter(l => l.trim() && !l.startsWith('#')).flatMap(line => {
    const [time, event, resource, holder, ...detail] = line.split('\t'), t = timestamp(time);
    if (!Number.isFinite(t) || !event || !resource || holder == null) { invalidLines++; return []; }
    return t <= now ? [{ t, event, resource, holder, detail: detail.join('\t') }] : [];
  }).sort((a, b) => a.t - b.t);
  const close = (id, end) => {
    const hold = active.get(id), resource = resources.get(id);
    if (!hold) return;
    if (resource) {
      const start = Math.max(since, hold.t);
      resource.busyMs += Math.max(0, end - start);
      if (end > start) resource.workBusyMs += workHoursMs(start, end);
    }
    active.delete(id);
  };
  for (const e of events) {
    // Only take records append (project/task); return records contain the exact
    // holder name, which may itself end with parentheses.
    const by = e.event === 'take' ? identity(e.holder) : e.holder, resource = resources.get(e.resource);
    if (e.event === 'take') {
      if (active.get(e.resource)?.by !== by) {
        close(e.resource, e.t); active.set(e.resource, { t: e.t, by });
        if (resource && e.t >= since) resource.takes++;
      }
      latestTake.set(e.holder, e);
    } else if (['return', 'reclaim', 'reclaim-stale', 'rollback'].includes(e.event)) {
      if (e.event !== 'return' || active.get(e.resource)?.by === by) close(e.resource, e.t);
    }
    if (e.event === 'return' && /^heavy-build(?:-[23])?$/.test(e.resource)) {
      const mode = /(?:^|\s)build_mode=(solo|concurrent)(?:\s|$)/.exec(e.detail)?.[1];
      const peak = Number(/(?:^|\s)peak_concurrent=(\d+)(?:\s|$)/.exec(e.detail)?.[1]);
      const seconds = Number(/(?:^|\s)duration_seconds=(\d+)(?:\s|$)/.exec(e.detail)?.[1]);
      if (mode && Number.isSafeInteger(peak) && peak > 0 && Number.isSafeInteger(seconds) && seconds >= 0 &&
          (mode === 'solo' ? peak === 1 : peak > 1)) buildDurations[mode].push(seconds / 60);
      else if (/build_mode=|peak_concurrent=|duration_seconds=/.test(e.detail)) warnings.push('Malformed build-duration telemetry skipped.');
    }
    const key = `${e.resource}\t${e.holder}`;
    if (e.event === 'waiter-start') pending.set(key, e.t);
    if (['waiter-acquire', 'waiter-timeout', 'waiter-cancel'].includes(e.event)) {
      const start = pending.get(key); pending.delete(key);
      if (e.event === 'waiter-acquire' && start != null && e.t >= since) {
        const minutes = (e.t - start) / 60000;
        if (!queues.has(e.resource)) queues.set(e.resource, []);
        queues.get(e.resource).push(minutes);
        const selected = /(?:^|\s)(?:slot|lane)=([^\s]+)/.exec(e.detail)?.[1] ??
          (resource ? e.resource : latestTake.get(e.holder)?.resource);
        resources.get(selected)?.waits.push(minutes);
        // Build waits also belong to the build mutex, but totals use lanes only.
        if (e.resource === 'heavy-build' && selected !== 'heavy-build') resources.get('heavy-build')?.waits.push(minutes);
      }
    }
  }
  const journalHolders = [...active].map(([id, hold]) => ({ id, by: hold.by, since: new Date(hold.t).toISOString() }));
  for (const id of [...active.keys()]) close(id, now);
  for (const hold of holders ?? journalHolders) resources.get(hold.id)?.currentHolders.push(hold);
  if (holders == null) warnings.push('Current holders inferred from the journal; lock snapshot unavailable.');
  if (invalidLines) warnings.push(`${invalidLines} malformed journal lines skipped; occupancy may be incomplete.`);
  const summarize = (members, id) => {
    const busyMs = members.reduce((sum, r) => sum + r.busyMs, 0), capacityMs = duration * members.length;
    const workBusyMs = members.reduce((sum, r) => sum + r.workBusyMs, 0);
    return { id, slots: members.length, busyHours: round(busyMs / HOUR), capacityHours: round(capacityMs / HOUR),
      busyPct: capacityMs ? round(100 * busyMs / capacityMs) : null,
      idlePct: capacityMs ? round(100 * (1 - busyMs / capacityMs)) : null,
      workIdlePct: workDuration && members.length ? round(100 * (1 - workBusyMs / (workDuration * members.length))) : null,
      takes: members.reduce((sum, r) => sum + r.takes, 0), waits: waitStats(members.flatMap(r => r.waits)),
      currentHolders: members.flatMap(r => r.currentHolders) };
  };
  const all = [...resources.values()], open = all.filter(r => r.policy === 'open');
  // The build mutex overlaps a lane; count compute slot-hours once in mini totals.
  const mini = open.filter(r => /^heavy-lane-\d+$/.test(r.id));
  const devbox = open.filter(r => r.kind === 'remote');
  const boxes = [...new Set(all.filter(r => r.kind === 'remote').map(r => r.box))].sort().map(host => {
    const box = summarize(devbox.filter(r => r.box === host), host);
    const probe = probes?.hosts?.[host] ?? probes?.[host];
    box.diskFreeGiB = Number.isFinite(probe?.freeGiB) ? probe.freeGiB : null;
    box.diskProbedAt = probe?.probedAt ?? null;
    const probedAt = Date.parse(box.diskProbedAt);
    box.diskProbeStale = !Number.isFinite(probedAt) || now - probedAt > DAY || probedAt > now;
    box.quarantined = !!health?.[host]?.manual || (health?.[host]?.quarantinedUntil ?? 0) * 1000 > now;
    return box;
  });
  const totals = { mini: summarize(mini, 'mini'), devbox: summarize(devbox, 'devbox') };
  const queueRows = [...queues].map(([id, values]) => ({ id, ...waitStats(values) }));
  const recommendations = [];
  for (const box of boxes) if (box.workIdlePct > 70) recommendations.push(`${box.id}: ${box.workIdlePct}% idle in 09:00–21:00 PST; move more work to this box or reduce its slots.`);
  for (const queue of queueRows) if (queue.id !== 'heavy-build' && queue.p90Minutes > 10)
    recommendations.push(`${queue.id}: wait p90 ${queue.p90Minutes} min; add slots or move work to another pool.`);
  return { schema: 1, since: new Date(since).toISOString(), until: new Date(now).toISOString(),
    timezone: 'work hours: PST (UTC-08:00); unzoned journal timestamps: local collector time',
    basis: 'Registered resources over the full window; box/totals capacity uses currently open slots. Slot-hours measure reservations, not CPU use. Mini totals exclude the overlapping heavy-build mutex.',
    warnings, resources: all.map(r => ({ ...summarize([r], r.id), kind: r.kind, policy: r.policy, box: r.box })),
    boxes, totals, queues: queueRows, buildDurations: { solo: waitStats(buildDurations.solo), concurrent: waitStats(buildDurations.concurrent) }, recommendations };
}

export function readFleet({ directory = process.env.RES_DIR || process.env.RULES_SHARED || path.join(os.homedir(), '.claude/orchestrator/_shared'), ...options } = {}) {
  const warnings = [];
  const readOptional = name => {
    try { return JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') warnings.push(`${name} unavailable or invalid.`); return null; }
  };
  let holders = null;
  try {
    holders = [];
    for (const name of fs.readdirSync(path.join(directory, 'locks')).filter(n => n.endsWith('.d'))) {
      try {
        const info = Object.fromEntries(fs.readFileSync(path.join(directory, 'locks', name, 'info'), 'utf8').trim().split('\n').map(line => line.split('\t')));
        holders.push({ id: name.slice(0, -2), by: info.by ?? '?', project: info.project, task: info.task, pid: info.pid, since: info.since });
      } catch (error) { if (error.code !== 'ENOENT') warnings.push(`Holder snapshot unavailable for ${name}.`); }
    }
  } catch (error) { holders = null; if (error.code !== 'ENOENT') warnings.push('Lock snapshot unavailable.'); }
  const report = computeFleet({ ...options, log: fs.readFileSync(path.join(directory, 'log.tsv'), 'utf8'),
    registry: fs.readFileSync(path.join(directory, 'resources.tsv'), 'utf8'), holders,
    probes: readOptional('devbox-hosts.json'), health: readOptional('box-health.json') });
  report.warnings.push(...warnings); return report;
}

const number = value => value == null ? '?' : String(value);
export function fleetBoxLines(report) {
  return [report.totals.mini, ...report.boxes].map(box => `${box.id}: ${box.slots} slots, busy ${number(box.busyPct)}%, idle ${number(box.idlePct)}%, wait p90 ${number(box.waits.p90Minutes)} min, ${box.currentHolders.length} held` +
    (box.id === 'mini' ? '' : `, disk free ${number(box.diskFreeGiB)} GiB${box.diskProbedAt ? ` (probe ${box.diskProbedAt}${box.diskProbeStale ? ', STALE' : ''})` : ' (probe unavailable)'}${box.quarantined ? ', QUARANTINED' : ''}`));
}

export function formatFleet(report) {
  const lines = [`Fleet ${report.since} → ${report.until}`, report.basis, ...report.warnings.map(w => `NOTE: ${w}`),
    'Resource | box | busy h | busy % | idle % | takes | waits p50/p90/max min | current holders'];
  for (const r of report.resources) lines.push(`${r.id} | ${r.box} | ${r.busyHours} | ${number(r.busyPct)} | ${number(r.idlePct)} | ${r.takes} | ${[r.waits.p50Minutes, r.waits.p90Minutes, r.waits.maxMinutes].map(number).join('/')} | ${r.currentHolders.map(h => h.by).join(', ') || '-'}`);
  lines.push('', 'Box | slots | busy h | busy % | idle % | takes | waits p50/p90/max min | current holders | disk free GiB / probe');
  for (const box of [report.totals.mini, ...report.boxes]) {
    const disk = box.id === 'mini' ? '-' : `${number(box.diskFreeGiB)} / ${box.diskProbedAt ?? 'unavailable'}${box.diskProbedAt && box.diskProbeStale ? ' STALE' : ''}`;
    lines.push(`${box.id}${box.quarantined ? ' QUARANTINED' : ''} | ${box.slots} | ${box.busyHours} | ${number(box.busyPct)} | ${number(box.idlePct)} | ${box.takes} | ${[box.waits.p50Minutes, box.waits.p90Minutes, box.waits.maxMinutes].map(number).join('/')} | ${box.currentHolders.map(h => `${h.id}: ${h.by}`).join(', ') || '-'} | ${disk}`);
  }
  for (const group of Object.values(report.totals)) lines.push(`${group.id} total: ${group.busyHours}/${group.capacityHours} slot-hours busy (${number(group.busyPct)}%), ${group.takes} takes`);
  for (const queue of report.queues) lines.push(`${queue.id} queue: ${queue.count} acquisitions, wait p50/p90/max ${[queue.p50Minutes, queue.p90Minutes, queue.maxMinutes].map(number).join('/')} min`);
  const duration = mode => `${mode} n=${report.buildDurations?.[mode]?.count ?? 0} p50/p90/max ${['p50Minutes', 'p90Minutes', 'maxMinutes'].map(key => number(report.buildDurations?.[mode]?.[key])).join('/')} min`;
  lines.push(`Build durations: ${duration('solo')}; ${duration('concurrent')}`);
  lines.push(...report.recommendations.map(r => `Recommendation: ${r}`));
  return lines.join('\n');
}
