import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rulesLog } from './global-rules.mjs';
import { readLeases } from './resource-data.mjs';

export const REROUTE_EXIT = { stopped: 7, needsUser: 8, deferred: 9, limit: 10 };
export const routeFlag = (args, key) => {
  const i = args.indexOf(`--${key}`);
  return i < 0 ? null : args[i + 1]?.startsWith('--') || args[i + 1] === undefined ? true : args[i + 1];
};
export const setRouteFlag = (args, key, value) => {
  const next = [...args];
  for (let i; (i = next.indexOf(`--${key}`)) >= 0;) {
    next.splice(i, next[i + 1] !== undefined && !next[i + 1].startsWith('--') ? 2 : 1);
  }
  if (value != null) next.push(`--${key}`, ...(value === true ? [] : [String(value)]));
  return next;
};
export const parseRouteArgs = (raw) => {
  if (raw === undefined) return null;
  const args = JSON.parse(raw);
  if (!Array.isArray(args) || !args.length || args.some((v) => typeof v !== 'string' || !v || v.includes('\0'))
    || args[0].startsWith('--')) throw Error('--route-args needs a JSON argv array beginning with the category');
  return args;
};
export const nextRouteArgs = (args, from, depth, policy = false, alternative = null) => {
  let next = [...args];
  for (const key of ['json', 'dry', 'table', 'fresh', 'auto-reroute-depth']) next = setRouteFlag(next, key, null);
  for (const key of ['exclude-model', 'exclude-account', 'exclude-lane']) {
    const excluded = [next, alternative?.routeArgs ?? []]
      .flatMap((a) => String(routeFlag(a, key) ?? '').split(',').map((v) => v.trim()).filter(Boolean));
    if (key === 'exclude-lane') excluded.push(`${from.account}:${from.model.toLowerCase()}`);
    next = setRouteFlag(next, key, excluded.length ? [...new Set(excluded)].join(',') : null);
  }
  next = setRouteFlag(next, 'auto-reroute-depth', depth + 1);
  next = setRouteFlag(next, 'worker', true);
  if (policy) { next = setRouteFlag(next, 'defensive', null); next = setRouteFlag(next, 'adversarial', true); }
  return next;
};
export const turnHasWork = (turn) => (turn?.items ?? []).some((item) => item.type !== 'userMessage');
export const heldTaskResources = (args, name) => {
  const shared = process.env.RULES_SHARED ?? path.dirname(rulesLog());
  const bound = routeFlag(args, 'shared-lock') || routeFlag(args, 'device-lease');
  if (!fs.existsSync(path.join(shared, 'resources.tsv'))) return bound ? 'resource metadata unavailable' : null;
  const leases = readLeases(shared);
  if (!leases.complete) return 'resource metadata incomplete';
  const project = routeFlag(args, 'project');
  const hold = leases.held.find((r) => r.pid === process.pid || r.pid === process.ppid || r.holder === name
    || (project && r.project === project && r.task && [r.task, `${project}-${r.task}`].includes(name)));
  return hold ? `resource ${hold.id} is still held; exit the owning wrapper so it returns the hold before redispatch` : null;
};
const runNode = (script, args, { capture = false, timeout = 0 } = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [...process.execArgv, script, ...args],
    { stdio: capture ? ['ignore', 'pipe', 'inherit'] : ['ignore', 'inherit', 'inherit'] });
  let stdout = '', signal = null;
  child.stdout?.on('data', (chunk) => { stdout += chunk; if (stdout.length > 4 * 2 ** 20) child.kill('SIGTERM'); });
  const forward = (s) => { signal = s; child.kill(s); };
  const onInt = () => forward('SIGINT'), onTerm = () => forward('SIGTERM');
  process.once('SIGINT', onInt); process.once('SIGTERM', onTerm);
  const timer = timeout ? setTimeout(() => forward('SIGTERM'), timeout) : null;
  const cleanup = () => { clearTimeout(timer); process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm); };
  child.on('error', (e) => { cleanup(); reject(e); });
  child.on('close', (code, s) => { cleanup(); resolve({ code: code ?? ((s ?? signal) === 'SIGINT' ? 130 : 143), stdout }); });
});

// Only a confirmed, never-started turn reaches this entry point. Never use a shell or a detached launch.
export const rerouteWorker = async ({ args, depth, from, reason, prompt, opts, policy = false }) => {
  if (!args || routeFlag(args, 'background') || opts.background) return REROUTE_EXIT.stopped;
  if (typeof opts.cwd === 'string') args = setRouteFlag(args, 'cwd', path.resolve(opts.cwd));
  if (typeof opts.name === 'string') args = setRouteFlag(args, 'name', opts.name);
  if ((!routeFlag(args, 'task-dir') || routeFlag(args, 'task-dir') === '<task dir>') && typeof opts.log === 'string')
    args = setRouteFlag(args, 'task-dir', path.dirname(path.resolve(opts.log)));
  if (depth >= 2) { console.log('reroute-depth-limit: at most 2 automatic re-routes per task'); return REROUTE_EXIT.limit; }
  if (policy && !routeFlag(args, 'security') && !routeFlag(args, 'adversarial')) return REROUTE_EXIT.stopped;
  const held = heldTaskResources(args, opts.name);
  if (held) { console.log(`reroute-blocked: ${held}`); return REROUTE_EXIT.stopped; }
  const alternative = reason === 'queue-too-slow' ? opts.queueAlternative : null;
  const next = nextRouteArgs(args, from, depth, policy, alternative);
  const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const taskDir = typeof routeFlag(args, 'task-dir') === 'string' ? routeFlag(args, 'task-dir')
    : path.join(path.resolve(opts.cwd ?? '.'), '.reroute', String(opts.name ?? 'worker').replace(/[^a-zA-Z0-9._-]/g, '_'));
  const handover = `Previous attempt on ${from.model}@${from.account} was cancelled ${reason === 'queue-too-slow' ? `while queued at position ${from.position}` : `before work (${reason})`}; inspect git status/diff in the workspace before starting; continue, don't redo.\n\n${prompt}`;
  const state = { t: Date.now(), name: opts.name, reason, from, depth: depth + 1, routeArgs: next,
    alternative, status: 'routing', recovery: {
      instructions: 'The previous attempt ended before work. Re-run the recorded route command, then launch its pick.workerArgs with continuationPrompt. Do not resume the cancelled queued turn.',
      routeCommand: [process.execPath, path.join(scripts, 'route.mjs'), ...next, '--json'],
      continuationPrompt: handover, cwd: opts.cwd ?? routeFlag(args, 'cwd'),
    } };
  const persist = () => {
    fs.mkdirSync(taskDir, { recursive: true });
    const file = path.join(taskDir, 'reroute.json'), temp = `${file}.${process.pid}`;
    let current;
    try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    if (current?.depth > state.depth && current.t >= state.t) return; // A followed child's later hop owns the recovery/deferral record.
    fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n'); fs.renameSync(temp, file);
  };
  let route;
  try {
    persist();
    const routed = await runNode(path.join(scripts, 'route.mjs'), [...next, '--json'], { capture: true, timeout: 60000 });
    if (routed.code !== 0) throw Object.assign(Error(`route exited ${routed.code}`), { exitCode: routed.code });
    route = JSON.parse(routed.stdout);
    if (!route || typeof route !== 'object' || Array.isArray(route) || typeof route.category !== 'string'
      || !Object.hasOwn(route, 'pick') || !Array.isArray(route.needsUserOK)) throw Error('route returned an invalid result');
    state.route = route; state.status = 'routed'; persist();
  } catch (e) {
    state.status = 'route-failed'; state.exitCode = REROUTE_EXIT.stopped;
    state.error = { stage: 'route', message: e.message, exitCode: e.exitCode ?? null };
    try { persist(); } catch (writeError) {
      console.error(`reroute-recovery-unwritten: ${writeError.message}; ${JSON.stringify(state.recovery)}`);
    }
    console.log(`reroute-failed: ${e.message}; recovery: ${path.join(taskDir, 'reroute.json')}`);
    return REROUTE_EXIT.stopped;
  }
  if (route.needsUserOK?.length || route.redeemFirst) {
    state.status = 'needs-user'; state.exitCode = REROUTE_EXIT.needsUser; persist();
    console.log(`reroute-needs-user: ${JSON.stringify(route)}`); return REROUTE_EXIT.needsUser;
  }
  if (route.deferred || route.deferUntil || !route.pick) {
    state.status = 'deferred'; state.exitCode = REROUTE_EXIT.deferred; persist();
    console.log(`reroute-needs-user: deferred; ${JSON.stringify(route)}`); return REROUTE_EXIT.deferred;
  }
  const pick = route.pick;
  const picks = [pick, route.secondOpinion].filter(Boolean);
  if (picks.some((p) => !p.company || p.vendor !== 'codex' || !p.workerArgs
    || (policy && /^(gpt|claude)/i.test(p.model))) || route.signing) {
    state.status = 'needs-user'; state.exitCode = REROUTE_EXIT.needsUser; persist();
    console.log(`reroute-needs-user: automatic hops require a company hub worker; ${JSON.stringify(route)}`);
    return REROUTE_EXIT.needsUser;
  }
  const to = { vendor: pick.vendor, model: pick.model, effort: pick.effort, account: pick.account };
  const record = { t: Date.now(), kind: 'reroute', automatic: true, project: routeFlag(args, 'project'), name: opts.name,
    from, to, reason, category: route.category, depth: depth + 1, toStartEstimateMin: route.eta?.find((r) => r.model === pick.model && r.account === pick.account)?.startDelayMin ?? null };
  fs.mkdirSync(path.dirname(rulesLog()), { recursive: true });
  fs.appendFileSync(rulesLog(), JSON.stringify(record) + '\n');
  console.log(`rerouted: ${from.model}@${from.account} (queued ${from.position ?? '?'}, waited ${Number(from.waitedMin ?? 0).toFixed(1)} min) → ${to.model}@${to.account}`);
  const childArgs = [...pick.workerArgs];
  childArgs.push('--reroute-hop-at', String(record.t));
  for (const key of ['log', 'out', 'stall-min', 'network', 'sandbox', 'browser-origins', 'computer-use-apps']) {
    if (typeof opts[key] === 'string') {
      const i = childArgs.indexOf(`--${key}`);
      if (i >= 0) childArgs.splice(i, 2);
      childArgs.push(`--${key}`, opts[key]);
    }
  }
  state.status = 'following'; state.recovery.workerArgs = childArgs; persist();
  const result = await runNode(path.join(scripts, 'codex-worker.mjs'), [...childArgs, handover]);
  state.status = 'finished'; state.exitCode = result.code; persist();
  if (result.code === 0 && route.secondOpinion) {
    // Required company second opinions stay separate, read-only, and never restart the primary task.
    let reviewArgs = [...route.secondOpinion.workerArgs];
    for (const key of ['route-args', 'auto-reroute-depth']) reviewArgs = setRouteFlag(reviewArgs, key, null);
    reviewArgs = setRouteFlag(reviewArgs, 'name', `${opts.name}-R${depth + 1}`);
    const reviewDir = typeof taskDir === 'string' ? taskDir : path.dirname(path.resolve(opts.log ?? 'codex.jsonl'));
    reviewArgs = setRouteFlag(reviewArgs, 'log', path.join(reviewDir, `reroute-review-${depth + 1}.jsonl`));
    reviewArgs = setRouteFlag(reviewArgs, 'out', path.join(reviewDir, `reroute-review-${depth + 1}.md`));
    const reviewed = await runNode(path.join(scripts, 'codex-worker.mjs'), [...reviewArgs,
      `Independent second opinion on the completed replacement attempt; do not redo or edit its work.\n\n${handover}`]);
    if (reviewed.code !== 0) return reviewed.code;
  }
  return result.code;
};
