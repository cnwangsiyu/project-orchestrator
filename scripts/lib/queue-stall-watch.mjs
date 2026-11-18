import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { rulesShared } from './global-rules.mjs';
import { withLock, writeJson } from './shared-file.mjs';
import { savedLaunch } from './worker-launch.mjs';
import { readQueue } from './worker-queue.mjs';
import { readLeases } from './resource-data.mjs';
import { personalFallbackPolicy } from './pipeline/personal-fallback.mjs';
import { parseTaskSpec } from './pipeline/taskspec.mjs';
import { shellQuote } from './pipeline/presentation.mjs';
import { flagArgs, scopedFlags } from './route-args.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const read = (file, fallback = null) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const waiting = queue => ['waiting', 'queued'].includes(queue?.state);
export const queuePolicy = (now = Date.now()) => {
  const file = process.env.PERSONAL_FALLBACK_FILE || path.join(rulesShared(), 'personal-fallback.json');
  return personalFallbackPolicy(fs.existsSync(file) ? read(file) : read(path.join(root, 'references/personal-fallback.json')), now);
};
export const queueStatus = (row, profiles) => {
  const home = profiles[row.account]?.home;
  if (!home || profiles[row.account]?.kind !== 'trae' || !row.turn) return null;
  const queue = readQueue(home, row.thread);
  return queue?.turnId === row.turn ? queue : null;
};
export function queueStallLabel(queue, now = Date.now()) {
  if (!waiting(queue) || !Number.isFinite(queue.since)) return '';
  const elapsed = (now - queue.since) / 60000;
  return elapsed >= (queuePolicy(now)?.queueWaitMinutes ?? 5)
    ? `QUEUE-STALLED ${Math.floor(elapsed)} min @${queue.position ?? '?'}` : '';
}

export function fallbackRouteArgs(launch) {
  const defaults = launch?.defaults ?? {}, saved = defaults['route-args'];
  const argv = Array.isArray(saved) ? saved : JSON.parse(saved ?? 'null');
  if (!Array.isArray(argv) || !argv.length) throw Error('missing saved route-args; do not guess a replacement route');
  const task = parseTaskSpec(argv, { taskId: 'saved-route', requestId: 'saved-route', sandboxCeiling: 'danger-full-access' });
  const flags = scopedFlags(task.flags);
  // The launch record, not ambient caller state, supplies omitted owner/failure flags.
  if (!flags.owner && defaults.owner) flags.owner = defaults.owner;
  flags.failures ??= String(task.failures);
  const seat = typeof defaults['routed-seat'] === 'string' ? JSON.parse(defaults['routed-seat']) : defaults['routed-seat'];
  return { args: [task.category, ...flagArgs(flags)], tier: seat?.tier ?? task.tier,
    needsSeparateDecision: !!task.reviewClass || task.contentLabels.some(label => label !== 'ordinary'),
    excludedAccounts: (flags['exclude-account'] ?? '').split(',').map(s => s.trim()).filter(Boolean) };
}

const holdsFor = (row, launch) => {
  const leases = readLeases(process.env.RES_DIR || rulesShared());
  if (!leases.complete) return null;
  const taskIds = [row.task, row.name, launch?.defaults?.task, launch?.defaults?.name].filter(Boolean);
  return leases.held.some(hold => (hold.pid !== null && hold.pid === row.pid)
    || (hold.project === row.project && taskIds.includes(hold.task)));
};
const lastProgress = (row, notes) => notes.findLast(n => n.account === row.account && n.thread === row.thread
  && (n.turn ? n.turn === row.turn : n.runId === row.runId) && !['queue-stalled', 'pool-stalled'].includes(n.kind)
  && (n.event === 'message' || n.currentStep || n.finalLine));
export function likelyWrapUp(row, launch, notes, now, holds = holdsFor(row, launch)) {
  if (holds !== false) return false;
  const last = lastProgress(row, notes);
  const marker = /^\s*(?:[-*#]+\s*)?(?:DONE|READY(?:_FOR_SIGNING)?|FINAL|WRAP[- ]?UP)\b|\bfinal report\b/i.test(
    last?.text || last?.currentStep || last?.finalLine || row.currentStep || row.finalLine || '');
  const file = launch?.defaults?.out ?? row.outFile;
  let fresh = false;
  if (file) try {
    const stat = fs.lstatSync(file);
    fresh = stat.isFile() && stat.size > 0 && stat.mtimeMs >= (launch?.t ?? row.t)
      && Math.floor(stat.mtimeMs) <= now && now - stat.mtimeMs <= 15 * 60000;
  } catch {}
  return marker || fresh;
}

export function queueStallText(row, queue, { launch, quota = {}, notes = [], holds, now = Date.now(), policy = queuePolicy(now) } = {}) {
  const task = row.name ?? row.task ?? row.thread, position = queue.position ?? '?';
  const waited = Math.max(0, (now - (queue.since ?? now)) / 60000).toFixed(1);
  const daily = quota.codexAccounts?.find(a => a.name === row.account)?.quota?.daily ?? {};
  const bucket = daily[row.model] ?? daily[launch?.model] ?? null;
  const resets = [queue.resetsAt, bucket?.resetsAt, quota.codexAccounts?.find(a => a.name === row.account)?.quota?.weekly?.resetsAt]
    .filter(t => Number.isFinite(t) && t > now);
  const reset = resets.length ? Math.min(...resets) : null;
  const reason = `${bucket?.depleted ? 'bucket depleted' : 'waiting in the TRAE queue'}${reset ? ` until ${new Date(reset).toISOString()}` : ''}`;
  const head = `queue-stalled: ${row.account}/${row.thread} turn=${row.turn ?? '?'} task=${task}, position ${position}, ${waited} min waiting; ${reason}.`;
  if (likelyWrapUp(row, launch, notes, now, holds)) return { text: `${head} likely final report only — let it finish; do not interrupt`, wrapUp: true };
  if (!policy?.enabled) return { text: `${head} Standing fallback disabled; ask the owner to reconcile. Do not auto-interrupt or auto-reroute.` };
  let route;
  try { route = fallbackRouteArgs(launch); } catch {
    return { text: `${head} Saved route arguments are missing or unreadable. Reconcile the turn and recover its launch arguments before creating a handoff.` };
  }
  if (route.needsSeparateDecision || (route.tier === 'hard' && !policy.allowHardPersonalAstra))
    return { text: `${head} This task needs a separate scoped personal fallback decision. Reconcile the live turn before deciding on a handoff.` };
  if (route.excludedAccounts.includes('main'))
    return { text: `${head} The saved route excludes main. Reconcile the live turn and check the original exclusion before deciding on a handoff.` };
  const tt = quota.codexAccounts?.find(a => a.kind === 'ttadk')?.usage;
  const ttNearLimit = tt?.limit > 0 && tt.used / tt.limit >= .95 && (tt.resetsAt == null || tt.resetsAt > now);
  const excluded = [...new Set([...route.excludedAccounts, row.account, ...(ttNearLimit ? ['ttadk'] : [])])];
  const ix = route.args.indexOf('--exclude-account');
  if (ix >= 0) route.args.splice(ix, 2);
  route.args.push('--exclude-account', excluded.join(','));
  const cmd = args => args.map(shellQuote).join(' ');
  const interrupt = cmd(['node', `${root}/scripts/codex-worker.mjs`, '--account', row.account, 'interrupt', '--thread', row.thread]);
  const approval = cmd(['node', `${root}/scripts/approval.mjs`, 'add', '--account', 'main', ...(route.tier === 'hard' ? ['--astra'] : []),
    '--ref', `standing fallback: TRAE queue ${position} ${task}`, '--until', reset ? new Date(reset).toISOString() : '<next-quota-reset-ISO>', '--', ...route.args]);
  const reroute = cmd(['node', `${root}/scripts/route.mjs`, ...route.args, '--user-ok', '<approval-id>']);
  return { text: `${head} Owner only: check current status and standing approval, write a handoff, and confirm no work will be lost and holds are returned. Interrupt: ${interrupt}; after confirmed cancellation, if scoped approval is required and covered: ${approval}; replan with ${reroute}; start a fresh thread with the handoff.`, commands: { interrupt, approval, reroute }, routeArgs: route.args };
}

const readPoolWaits = () => {
  const root = path.join(process.env.RES_DIR || rulesShared(), 'pool-waiters');
  const names = dir => { try { return fs.readdirSync(dir); } catch { return []; } };
  return names(root).flatMap(pool => names(path.join(root, pool)).filter(name => name.startsWith('waiter.')).flatMap(name => {
    try {
      const lines = fs.readFileSync(path.join(root, pool, name, 'info'), 'utf8').trimEnd().split('\n');
      const wait = Object.fromEntries(lines.map(line => line.split(/\t(.*)/s).slice(0, 2)));
      return [{ ...wait, key: pool + '/' + name }];
    } catch { return []; }
  }));
};

export function createPoolStallMonitor(owner, { emit, waitsOf = readPoolWaits } = {}) {
  const file = path.join(rulesShared(), 'pool-stall-watch', `${createHash('sha256').update(owner).digest('hex')}.json`);
  return async (rows, notes, now) => {
    const waits = waitsOf();
    if (!waits.length && !fs.existsSync(file)) return [];
    return withLock(file, () => {
      const states = read(file, {}), prior = JSON.stringify(states), events = [];
      const active = new Set(waits.map(wait => wait.key));
      for (const key of Object.keys(states)) if (!active.has(key) && now - states[key] > 1800000) delete states[key];
      for (const wait of waits) {
        const age = now - Number(wait.started_at) * 1000, heartbeatAge = now - Number(wait.heartbeat) * 1000;
        if (!wait.exclude_reason || !wait.self_restricted || !(age > 600000)
            || !(heartbeatAge >= 0 && heartbeatAge <= 300000) || states[wait.key]
            || wait.worker_owner && wait.worker_owner !== owner) continue;
        const matches = rows.filter(row => row.owner === owner && !row.stale && (wait.worker_thread
          ? row.thread === wait.worker_thread && (!wait.worker_account || row.account === wait.worker_account)
          : wait.worker_owner && row.project === wait.project && [row.task, row.name].includes(wait.task)));
        if (matches.length !== 1) continue;
        if (notes.some(note => note.kind === 'pool-stalled' && note.poolEpisode === wait.key)) {
          states[wait.key] = now;
          continue;
        }
        const event = emit({ ...matches[0], event: 'message', kind: 'pool-stalled', severity: 'risk', wake: true, poolEpisode: wait.key,
          text: `Devbox wait stalled for ${Math.floor(age / 60000)} min. ${wait.holder} (${wait.project}/${wait.task}) set exclusions with reason "${wait.exclude_reason}". Free matching hosts: ${wait.self_restricted}.` });
        if (event) { states[wait.key] = now; events.push(event); }
      }
      if (JSON.stringify(states) !== prior) writeJson(file, states);
      return events;
    });
  };
}

export function createQueueStallMonitor(owner, { profiles = {}, statusOf = row => queueStatus(row, profiles),
  launchOf = row => savedLaunch(row.account, row.thread), quotaOf = () => read(process.env.QUOTA_CACHE || path.join(rulesShared(), 'quota.json'), {}),
  emit, policyOf = queuePolicy, holdsOf = holdsFor } = {}) {
  const file = path.join(rulesShared(), 'queue-stall-watch', `${createHash('sha256').update(owner).digest('hex')}.json`);
  const poolPoll = createPoolStallMonitor(owner, { emit });
  const retainProgress = (rows, notes) => rows.filter(row => profiles[row.account]?.kind === 'trae')
    .map(row => lastProgress(row, notes)?.id).filter(Boolean);
  const poll = async (rows, notes = rows, now = Date.now()) => {
    const statuses = await Promise.all(rows.filter(r => !r.stale && r.account && r.thread).map(async row => {
      try { return { row, queue: await statusOf(row) }; } catch { return { row, unknown: true }; }
    }));
    if (!statuses.some(({ queue }) => waiting(queue)) && !fs.existsSync(file)) return [];
    return withLock(file, () => {
      const states = read(file, {}), prior = JSON.stringify(states), active = new Set(), events = [];
      const policy = policyOf(now), window = (policy?.queueWaitMinutes ?? 5) * 60000;
      for (const { row, queue, unknown } of statuses) {
        const key = JSON.stringify([row.account, row.thread, row.turn ?? row.runId]); active.add(key);
        if (unknown) continue;
        if (!waiting(queue)) { delete states[key]; continue; }
        let state = states[key];
        if (!state || Number.isFinite(queue.since) && queue.since !== state.since) state = { since: queue.since ?? now,
          lastDecreaseAt: now, position: queue.position ?? null, emitted: false };
        if (Number.isFinite(queue.position) && Number.isFinite(state.position) && queue.position < state.position) state.lastDecreaseAt = now;
        if (Number.isFinite(queue.position)) state.position = queue.position;
        // The event is written first. A watcher restarted before the state
        // write can recover that commit from its retained owner event tail.
        if (notes.some(n => n.kind === 'queue-stalled' && n.queueEpisode === key && n.queueSince === state.since)) state.emitted = true;
        if (!state.emitted && (now - state.since >= window || now - state.lastDecreaseAt >= window)) {
          let launch;
          try { launch = launchOf(row); } catch { /* A missing or unreadable launch produces an alert without a command. */ }
          if (launch?.turn && launch.turn !== row.turn) launch = null;
          const details = queueStallText(row, { ...queue, since: state.since }, {
            launch, quota: quotaOf(), notes, holds: holdsOf(row, launch), now, policy });
          const event = emit({ ...row, event: 'message', kind: 'queue-stalled', severity: 'risk', wake: true,
            text: details.text, queueEpisode: key, queueSince: state.since, wrapUp: !!details.wrapUp });
          if (event) { state.emitted = true; events.push(event); }
        }
        states[key] = state;
      }
      for (const key of Object.keys(states)) if (!active.has(key)) delete states[key];
      if (JSON.stringify(states) !== prior) writeJson(file, states);
      return events;
    });
  };
  return {
    async poll(rows, notes = rows, now = Date.now()) {
      const events = await poll(rows, notes, now);
      return events.concat(await poolPoll(rows, notes, now));
    },
    retainProgress,
  };
}
