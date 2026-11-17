import fs from 'node:fs';
import path from 'node:path';
import { readEvents } from './worker-events.mjs';
import { runningWorkers } from './running-workers.mjs';
import { orchRoot, sharedDir, projectDir, publicId, iso, timeOf, oneLine, maskSecrets, readJson, readText,
  jsonLines, atomicJson, appendLogLocked, withLock } from './task-storage.mjs';

export const BOARD_VERSION = 1;
export const TASK_STATES = ['queued', 'running', 'blocked', 'waiting-user', 'review', 'done', 'parked', 'cancelled'];
export const boardFile = project => path.join(projectDir(project), 'board.json');
const archiveFile = project => path.join(projectDir(project), 'board-archive.jsonl');
const emptyBoard = project => ({ schemaVersion: BOARD_VERSION, project, tasks: [], updatedAt: null });
export const readBoard = project => {
  const board = readJson(boardFile(project), emptyBoard(project));
  if (board.schemaVersion !== BOARD_VERSION || board.project !== project || !Array.isArray(board.tasks)) throw Error('unsupported or invalid board');
  return board;
};
export const mutateBoard = (project, fn) => withLock(boardFile(project), () => {
  const board = readBoard(project), before = JSON.stringify(board);
  const result = fn(board);
  if (JSON.stringify(board) !== before) { board.updatedAt = iso(Date.now()); atomicJson(boardFile(project), board); }
  return result ?? board;
});
const newTask = (id, title = id, now = Date.now()) => ({ id: publicId(id, 'task'), title: oneLine(title, 500), state: 'queued',
  next: '', blocker: '', deps: [], deadline: null, note: '', updatedAt: iso(now), orchestratorUpdatedAt: null,
  stateUpdatedAt: null, stateSource: null, auto: { workers: [], updatedAt: null } });
const ensureTask = (board, id, title, now) => {
  let task = board.tasks.find(row => row.id === id);
  if (!task) { task = newTask(id, title, now); board.tasks.push(task); }
  return task;
};
export const setTask = (project, id, fields, now = Date.now()) => {
  publicId(id, 'task');
  const allowed = ['title', 'state', 'next', 'blocker', 'deps', 'deadline', 'note'];
  for (const key of Object.keys(fields)) if (!allowed.includes(key)) throw Error(`not an orchestrator field: ${key}`);
  if (fields.state !== undefined && !TASK_STATES.includes(fields.state)) throw Error('invalid task state');
  if (fields.deps !== undefined && (!Array.isArray(fields.deps) || fields.deps.some(dep => { publicId(dep, 'dependency'); return dep === id; }))) throw Error('invalid dependencies');
  if (fields.deadline && (!/^\d{4}-\d\d-\d\dT/.test(fields.deadline) || !Number.isFinite(Date.parse(fields.deadline)))) throw Error('deadline needs an ISO timestamp');
  return mutateBoard(project, board => {
    const task = ensureTask(board, id);
    for (const [key, value] of Object.entries(fields)) task[key] = typeof value === 'string' ? maskSecrets(value) : value;
    task.orchestratorUpdatedAt = task.updatedAt = iso(now);
    if (fields.state !== undefined) {
      task.stateUpdatedAt = iso(now); task.stateSource = 'orchestrator';
      if (fields.state !== 'waiting-user') delete task.queueWait;
    }
    return task;
  });
};
export const linkTask = (project, id, thread, account) => {
  publicId(id, 'task'); publicId(thread, 'thread'); if (account) publicId(account, 'account');
  return mutateBoard(project, board => {
    const task = ensureTask(board, id);
    // A manual link supersedes inferred names, and a thread cannot belong to two rows.
    for (const row of board.tasks) {
      row.links = (row.links ?? []).filter(link => link.thread !== thread || account && link.account && link.account !== account);
      if (row !== task) row.auto.workers = row.auto.workers.filter(worker => worker.thread !== thread || account && worker.account !== account);
    }
    task.links.push({ thread, ...(account ? { account } : {}) });
    task.orchestratorUpdatedAt = task.updatedAt = iso(Date.now());
    return task;
  });
};
export const archiveTasks = (project, days, now = Date.now()) => {
  if (!Number.isFinite(days) || days < 0) throw Error('done-older-than needs nonnegative days');
  return mutateBoard(project, board => {
    const archived = board.tasks.filter(task => task.state === 'done' && timeOf(task.stateUpdatedAt ?? task.updatedAt) < now - days * 86400000);
    if (archived.length) {
      const prior = jsonLines(readText(archiveFile(project)));
      const pending = archived.filter(task => !prior.some(row => row.task.id === task.id && row.task.updatedAt === task.updatedAt));
      if (pending.length) appendLogLocked(archiveFile(project), pending.map(task => ({ schemaVersion: BOARD_VERSION, archivedAt: iso(now), project, task })));
      board.tasks = board.tasks.filter(task => !archived.includes(task));
    }
    return archived;
  });
};
const entries = dir => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };
export const readLaunches = () => {
  const root = path.join(sharedDir(), 'worker-launches'), launches = [];
  for (const account of entries(root).filter(entry => entry.isDirectory()).slice(0, 64)) {
    for (const entry of entries(path.join(root, account.name)).filter(entry => entry.isFile() && entry.name.endsWith('.json')).slice(0, 10000)) {
      const launch = readJson(path.join(root, account.name, entry.name), null);
      if (launch?.account && launch.thread && launch.defaults) launches.push(launch);
    }
  }
  return launches;
};
const routeValue = (launch, flag) => {
  try { const args = JSON.parse(launch.defaults?.['route-args'] ?? '[]'); const i = args.indexOf(`--${flag}`); return i < 0 ? null : args[i + 1]; } catch { return null; }
};
export const launchProject = launch => launch?.defaults?.project ?? routeValue(launch ?? {}, 'project') ?? launch?.project ?? null;
export const projectForOwner = (owner, launches = readLaunches()) => owner
  ? launchProject(launches.filter(launch => launch.defaults.owner === owner && launchProject(launch)).sort((a, b) => b.t - a.t)[0]) : null;
export const resolveProject = (project, launches) => publicId(project || process.env.ORCHESTRATOR_PROJECT
  || projectForOwner(process.env.ORCHESTRATOR_OWNER || process.env.CODEX_WORKER_OWNER, launches) || '', 'project (pass --project or ORCHESTRATOR_PROJECT)');
export const boardProjects = () => entries(orchRoot()).filter(entry => entry.isDirectory() && !entry.name.startsWith('_')
  && fs.existsSync(path.join(orchRoot(), entry.name, 'board.json'))).map(entry => entry.name);

// Read a bounded tail through a regular, non-symlink file descriptor, never a FIFO or auth/config file.
const tail = (file, cached, limit = 128 * 1024) => {
  if (typeof file !== 'string' || !/\.(?:jsonl|md)$/.test(file)) return null;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    if (cached?.file === file && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return { ...cached, unchanged: true };
    const offset = Math.max(0, stat.size - limit), buffer = Buffer.alloc(Math.min(stat.size, limit));
    const n = fs.readSync(fd, buffer, 0, buffer.length, offset);
    let text = buffer.subarray(0, n).toString('utf8');
    if (offset && file.endsWith('.jsonl')) text = text.slice(text.indexOf('\n') + 1);
    return { file, mtimeMs: stat.mtimeMs, size: stat.size, text };
  } catch (e) { if (['ENOENT', 'ELOOP', 'EACCES'].includes(e.code)) return null; throw e; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
};
const describeItem = item => {
  if (!item) return null;
  if (['commandExecution', 'exec_command', 'shell'].includes(item.type)) return `running: ${item.command ?? item.cmd ?? ''}`;
  if (item.type === 'fileChange') return `editing ${item.changes?.map(change => change.path).join(', ') ?? item.path ?? 'files'}`;
  if (item.type === 'agentMessage') return item.text;
  return null;
};
export const rolloutFields = (text, thread) => {
  let currentStep = '', tokens = null, at = 0;
  for (const row of jsonLines(text)) {
    const p = row.params ?? row.payload ?? {};
    if (p.threadId && thread && p.threadId !== thread) continue;
    let step = describeItem(p.item);
    if (row.type === 'response_item' && p.type === 'function_call') {
      let args; try { args = JSON.parse(p.arguments); } catch { args = {}; }
      step = args.cmd || args.command ? `running: ${args.cmd ?? args.command}`
        : /apply_patch/.test(p.name) ? `editing ${String(args.input ?? p.arguments ?? '').match(/\*\*\* (?:Update|Add) File: (.+)/)?.[1] ?? 'files'}`
          : `tool: ${p.name ?? 'call'}`;
    } else if (row.type === 'response_item' && p.type === 'custom_tool_call') {
      step = /apply_patch/.test(p.name) ? `editing ${String(p.input ?? '').match(/\*\*\* (?:Update|Add) File: (.+)/)?.[1] ?? 'files'}` : `tool: ${p.name}`;
    } else if (row.type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
      step = p.content?.map(part => part.text ?? '').join(' ');
    } else if (row.method === 'item/agentMessage/delta') step = p.delta;
    else if (row.method === 'turn/completed') step = describeItem(p.turn?.items?.findLast(item => item.type === 'agentMessage'));
    else if (row.type === 'event_msg' && ['agent_message', 'agent_reasoning'].includes(p.type)) step = p.message ?? p.text;
    if (step?.trim()) { currentStep = oneLine(step); at = Math.max(at, timeOf(row.timestamp ?? row.t)); }
    const usage = p.tokenUsage?.total ?? p.info?.total_token_usage ?? (p.type === 'token_count' ? p.total_token_usage : null);
    if (usage) tokens = { input: usage.inputTokens ?? usage.input_tokens ?? 0, cached: usage.cachedInputTokens ?? usage.cached_input_tokens ?? 0,
      output: usage.outputTokens ?? usage.output_tokens ?? 0, total: usage.totalTokens ?? usage.total_tokens ?? null };
  }
  return { currentStep, tokens, at };
};
export const resultFields = text => {
  const summaryBlock = text.match(/^## Summary\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/mi)?.[1];
  const paragraph = (summaryBlock ?? text).trim().split(/\n\s*\n/).find(part => part.trim() && !/^#+\s/.test(part.trim())) ?? '';
  const commit = text.match(/\b(?:commit|sha)\b[^\n]*?\b([a-f0-9]{7,40})\b/i)?.[1] ?? null;
  const passed = text.match(/\b(\d+)\s+(?:tests?\s+)?pass(?:ed)?\b/i)?.[1] ?? text.match(/\bpass(?:ed)?\s*[:=]\s*(\d+)/i)?.[1];
  const failed = text.match(/\b(\d+)\s+(?:tests?\s+)?fail(?:ed)?\b/i)?.[1] ?? text.match(/\bfail(?:ed)?\s*[:=]\s*(\d+)/i)?.[1];
  return { summary: oneLine(paragraph, 1000), commit, tests: passed !== undefined || failed !== undefined
    ? { passed: passed === undefined ? null : +passed, failed: failed === undefined ? null : +failed } : null };
};
const workerKey = worker => JSON.stringify([worker.account, worker.thread ?? worker.runId]);
const stateEvent = event => ({ running: 'running', finished: 'finished', failed: 'failed', stalled: 'stalled', 'needs-user': 'blocked',
  're-routed': 'rerouted', 'follower-ended': 'unknown' })[event];
export const workerFacts = async ({ launches = readLaunches(), events = readEvents() } = {}) => {
  // This passive view uses public local evidence only. Missing followers stay UNKNOWN, never probe a hub on a read.
  const profiles = readJson(process.env.CODEX_ACCOUNTS || path.join(sharedDir(), 'codex-accounts.json'), {});
  const live = await runningWorkers({ rows: events, profiles, knownThread: async () => { throw Error('passive board: no hub probe'); } });
  return { launches, events, live };
};
export const refreshBoard = async (project, { thread, account, facts, now = Date.now() } = {}) => {
  facts ??= await workerFacts();
  project = resolveProject(project, facts.launches);
  const groups = new Map(), launchMap = new Map(facts.launches.map(launch => [workerKey(launch), launch]));
  for (const event of [...facts.events].sort((a, b) => a.t - b.t || (a.seq ?? 0) - (b.seq ?? 0))) {
    if (thread && event.thread !== thread || account && event.account !== account) continue;
    const key = workerKey(event);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  for (const launch of facts.launches) if ((!thread || launch.thread === thread) && (!account || launch.account === account)) {
    if (!groups.has(workerKey(launch))) groups.set(workerKey(launch), []);
  }
  return mutateBoard(project, board => {
    const archived = new Map(jsonLines(readText(archiveFile(project))).map(row => [row.task.id, timeOf(row.archivedAt)]));
    for (const [key, events] of groups) {
      const launch = launchMap.get(key), defaults = launch?.defaults ?? {}, latest = events.at(-1);
      const base = latest ?? launch; if (!base) continue;
      const manual = board.tasks.find(task => task.links?.some(link => link.thread === base.thread && (!link.account || link.account === base.account)));
      const existing = board.tasks.find(task => task.auto.workers.some(worker => workerKey(worker) === key || base.runId && worker.runId === base.runId));
      const owner = latest?.owner ?? defaults.owner;
      const inferredProject = launchProject(launch) ?? [...events].reverse().find(event => event.project)?.project ?? projectForOwner(owner, facts.launches);
      if (!manual && !existing && inferredProject !== project) continue;
      const id = manual?.id ?? defaults.task ?? latest?.task ?? existing?.id ?? defaults.name ?? latest?.name;
      if (!id) continue;
      publicId(id, 'task');
      const stateRows = events.filter(event => stateEvent(event.event)), stateRow = stateRows.at(-1);
      const eventAt = stateRow?.t ?? launch?.t ?? 0;
      if (!existing && !manual && archived.has(id) && eventAt <= archived.get(id)) continue;
      const task = ensureTask(board, id, defaults.name ?? latest?.name ?? id, eventAt || now);
      // Collapse the provisional start row into its final account/thread identity.
      const prior = task.auto.workers.find(worker => workerKey(worker) === key || base.runId && worker.runId === base.runId);
      if (prior?.eventAt > eventAt) continue;
      const live = facts.live.threads.find(worker => worker.account === base.account && worker.thread === base.thread);
      const runId = stateRow?.runId ?? base.runId ?? prior?.runId ?? null;
      const sameRun = !prior?.runId || !runId || prior.runId === runId;
      const starts = [events.find(event => event.event === 'running' && event.runId === runId)?.t,
        sameRun ? timeOf(prior?.startedAt) : 0].filter(Boolean);
      const startedAt = starts.length ? Math.min(...starts) : launch?.t || eventAt;
      const worker = { name: defaults.name ?? latest?.name ?? id, thread: base.thread ?? null, account: base.account ?? null,
        model: launch?.actualModel ?? latest?.actualModel ?? launch?.effectiveModel ?? latest?.model ?? defaults.model ?? prior?.model ?? null,
        effort: latest?.effort ?? launch?.effort ?? defaults.effort ?? prior?.effort ?? null, state: stateEvent(stateRow?.event) ?? prior?.state ?? 'unknown',
        startedAt: iso(startedAt || eventAt || now), lastActivityAt: iso(Math.max(latest?.t ?? launch?.t ?? 0, live?.lastActivityAt ?? 0, timeOf(prior?.lastActivityAt))),
        currentStep: prior?.currentStep ?? '', lastProgress: prior?.lastProgress ?? '', lastProgressAt: prior?.lastProgressAt ?? null,
        eta: latest?.eta ?? prior?.eta ?? null, tokens: latest?.tokens ?? prior?.tokens ?? null,
        result: sameRun ? prior?.result ?? null : null, finishedAt: null,
        runId, eventAt, updatedAt: prior?.updatedAt ?? iso(eventAt || now) };
      const output = defaults.out ?? latest?.outFile;
      const log = defaults.log ?? latest?.logFile ?? (output ? path.join(path.dirname(output), 'codex.jsonl') : null);
      const files = [...new Set([log, latest?.rolloutFile ?? launch?.rolloutFile].filter(Boolean))];
      let stepAt = 0;
      for (const file of files) {
        const priorCache = file === log ? prior?._rollout : prior?._session;
        const rollout = tail(file, priorCache);
        if (!rollout) continue;
        const parsed = rollout.unchanged ? priorCache.fields : rolloutFields(rollout.text, worker.thread);
        worker[file === log ? '_rollout' : '_session'] = { file: rollout.file, mtimeMs: rollout.mtimeMs, size: rollout.size, fields: parsed };
        if (parsed.currentStep && (parsed.at || rollout.mtimeMs) >= stepAt) { worker.currentStep = parsed.currentStep; stepAt = parsed.at || rollout.mtimeMs; }
        if (parsed.tokens) worker.tokens = parsed.tokens;
        worker.lastActivityAt = iso(Math.max(timeOf(worker.lastActivityAt), rollout.mtimeMs, parsed.at));
      }
      const progress = events.findLast(event => event.event === 'message' && ['progress', 'info'].includes(event.kind));
      if (progress && progress.t >= timeOf(worker.lastProgressAt)) { worker.lastProgress = oneLine(progress.text, 500); worker.lastProgressAt = iso(progress.t); }
      if (['finished', 'failed', 'stalled', 'blocked'].includes(worker.state)) {
        worker.finishedAt = worker.state === 'stalled' ? null : iso(eventAt);
        const result = tail(output, prior?._result);
        if (result && result.mtimeMs >= startedAt) {
          const parsed = result.unchanged ? prior._result.fields : resultFields(result.text);
          worker._result = { file: result.file, mtimeMs: result.mtimeMs, size: result.size, fields: parsed };
          worker.result = parsed;
        } else if (!worker.result && latest?.finalLine) worker.result = resultFields(latest.finalLine);
      }
      if (JSON.stringify({ ...worker, updatedAt: null }) !== JSON.stringify({ ...prior, updatedAt: null })) worker.updatedAt = iso(now);
      task.auto.workers = task.auto.workers.filter(row => workerKey(row) !== key && !(base.runId && row.runId === base.runId));
      task.auto.workers.push(worker);
      task.auto.workers.sort((a, b) => workerKey(a).localeCompare(workerKey(b)));
      task.auto.updatedAt = iso(Math.max(...task.auto.workers.map(row => timeOf(row.updatedAt))));
      task.updatedAt = iso(Math.max(timeOf(task.orchestratorUpdatedAt), timeOf(task.auto.updatedAt)));
    }
    for (const task of board.tasks) {
      const workers = task.auto.workers.filter(worker => worker.state !== 'rerouted'), recent = [...workers].sort((a, b) => b.eventAt - a.eventAt)[0];
      if (task.state === 'waiting-user' && task.queueWait) continue;
      if (!recent || recent.eventAt <= timeOf(task.stateUpdatedAt)) continue;
      // Active peers prevent an earlier finisher from moving a multi-worker task into review.
      const active = workers.filter(worker => worker.state === 'running');
      const failed = workers.filter(worker => ['failed', 'stalled', 'blocked'].includes(worker.state) && worker.eventAt >= (active.length ? Math.max(...active.map(row => row.eventAt)) : 0));
      const state = failed.length ? 'blocked' : active.length ? 'running' : workers.every(worker => worker.state === 'finished') ? 'review' : null;
      if (!state) continue;
      task.state = state; task.stateSource = 'worker'; task.stateUpdatedAt = iso(recent.eventAt);
      if (failed.length) {
        const failedWorker = failed.sort((a, b) => b.eventAt - a.eventAt)[0];
        const event = facts.events.findLast(row => workerKey(row) === workerKey(failedWorker) && stateEvent(row.event));
        task.blocker = oneLine(`worker ${failedWorker.state}: ${event?.reason || event?.finalLine || `exit ${event?.exit ?? 'unknown'}; see worker result`}`, 500);
      } else if (task.blocker.startsWith('worker ')) task.blocker = '';
    }
    return board;
  });
};
