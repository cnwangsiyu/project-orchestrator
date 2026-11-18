import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { rulesShared } from './global-rules.mjs';
import { ackFile, followerAlive } from './worker-events.mjs';

const ps = promisify(execFile);
const active = (task) => !task.status || ['running', 'in_progress', 'inProgress'].includes(task.status);
const completed = (task) => ['completed', 'finished'].includes(task.status);
const taskIds = (task) => [task.id, task.task_id, task.taskId]
  .filter((id) => typeof id === 'string' && id.length > 0 || Number.isSafeInteger(id)).map(String);
const sameTaskIdentity = (a, b) => {
  if (!a) return false;
  const left = taskIds(a), right = taskIds(b);
  if (left.length && right.length) return left.some((id) => right.includes(id));
  return Number.isInteger(a.pid) && a.pid > 0 && a.pid === b.pid;
};
const detached = (command) => /(?:^|[\s;])nohup\b|(?<![>&\d])&(?![&>])/.test(command ?? '');
const eligible = (row, owner) => row.launcher?.sessionId === owner && (row.followerCommand === 'exec'
  || typeof row.thread === 'string' && row.thread.length > 0 && ['start', 'turn'].includes(row.followerCommand));
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pathMentioned = (command, target, directory = false) => {
  if (typeof target !== 'string' || !path.isAbsolute(target) || target === '/') return false;
  const escaped = escapeRegex(target);
  return new RegExp(`(?:^|[\\s='\"])${escaped}${directory ? '(?:/|(?=[\\s\'\";&|<>)]|$))' : '(?=[\\s\'\";&|<>)]|$)'}`).test(command);
};
const recordPaths = (row) => [row.outFile, row.logFile].filter((value) => typeof value === 'string' && path.isAbsolute(value));
const threadMentioned = (command, thread) => {
  const escaped = escapeRegex(thread);
  return new RegExp(`--thread[\\s=]+(?:'${escaped}'|"${escaped}"|${escaped})(?=[\\s;&|)]|$)`).test(command);
};
// Exact output/log paths or an explicit task directory prove coverage. For older records,
// infer only the launch.sh beside those files, never every nested task under a shared output folder.
const commandMatches = (row, command) => typeof command === 'string' && (
  recordPaths(row).some((file) => pathMentioned(command, file))
  || pathMentioned(command, row.taskDir ?? row.launcher?.taskDir, true)
  || (!(row.taskDir ?? row.launcher?.taskDir)
    && recordPaths(row).some((file) => pathMentioned(command, path.join(path.dirname(file), 'launch.sh'))))
  || (row.followerCommand === 'turn' && /codex-worker(?:\.mjs)?["']?\s+(?:--\S+\s+\S+\s+)*turn\b/.test(command)
    && threadMentioned(command, row.thread))
);
const identityMatches = (row, task, ancestors = [], commands = true, registration = null) => {
  const id = row.launcher?.env?.CLAUDE_CODE_TASK_ID;
  const ids = taskIds(task);
  if (id && ids.length && !ids.includes(String(id))) return false;
  const pids = [row.pid, row.parentPid, ...(Array.isArray(row.ancestorPids) ? row.ancestorPids : []), ...ancestors.map((p) => p.pid)];
  if (task.pid !== undefined && (!Number.isInteger(task.pid) || !pids.includes(task.pid))) return false;
  return (id && ids.includes(String(id))) || (task.pid !== undefined && pids.includes(task.pid))
    || ids.some((value) => /^\d+$/.test(value) && pids.includes(Number(value)))
    || sameTaskIdentity(registration, task)
    || (commands && (commandMatches(row, task.command)
      || ancestors.some((p) => typeof task.command === 'string' && p.command.trim() === task.command.trim())));
};
const ancestry = async (row, timeoutMs, tasks) => {
  const result = [], visited = new Set(), deadline = Date.now() + timeoutMs;
  for (let pid = row.pid; Number.isInteger(pid) && pid > 1 && result.length < 16 && !visited.has(pid) && Date.now() < deadline;) {
    visited.add(pid);
    try {
      const { stdout } = await ps('/bin/ps', ['-p', String(pid), '-o', 'ppid=,command='], { timeout: Math.max(1, deadline - Date.now()), maxBuffer: 16384 });
      const match = stdout.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) break;
      result.push({ pid, command: match[2] }); pid = Number(match[1]);
      if (tasks.some((task) => identityMatches(row, task, result))) break;
    } catch { break; }
  }
  return result;
};

export const matchingBackgroundTask = async (row, tasks, owner, { finished = false, registration = null, ancestryTimeoutMs = 150 } = {}) => {
  if (!eligible(row, owner) || !Array.isArray(tasks) || (!finished && !followerAlive(row))) return null;
  const candidates = tasks.filter((task) => task && typeof task === 'object' && !detached(task.command)
    && (finished ? completed(task) : active(task))
    && (!row.launcher?.env?.CLAUDE_CODE_TASK_ID || !taskIds(task).length || taskIds(task).includes(String(row.launcher.env.CLAUDE_CODE_TASK_ID))));
  // A reused command or thread can describe an older turn. Completed tasks need a PID/ID or a verified live registration.
  const direct = candidates.find((task) => identityMatches(row, task, [], !finished, registration));
  if (direct || finished || !candidates.length) return direct ?? null;
  const parents = await ancestry(row, ancestryTimeoutMs, candidates);
  return candidates.find((task) => identityMatches(row, task, parents)) ?? null;
};

const atomic = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}`;
  try { await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 }); await fs.rename(temp, file); }
  finally { await fs.unlink(temp).catch(() => {}); }
};
export const captureStopTasks = async (input) => {
  if (input.hook_event_name !== 'Stop' || process.env.ORCH_HOOK_CAPTURE !== '1') return;
  const tasks = Array.isArray(input.background_tasks) ? input.background_tasks : [];
  const safe = tasks.filter((task) => task && typeof task === 'object').map((task) => Object.fromEntries(
    Object.entries(task).filter(([key, value]) => /^(?:id|task_?id|type|command|status|.*description.*|name|title|summary)$/i.test(key)
      && ['string', 'number', 'boolean'].includes(typeof value))
      .map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 300) : value])));
  await atomic(path.join(rulesShared(), 'hook-capture/last-stop.json'), safe);
};

const sameTask = (a, b) => {
  if (taskIds(a).length && taskIds(b).length) return sameTaskIdentity(a, b);
  if (Number.isInteger(a.pid) && Number.isInteger(b.pid)) return a.pid === b.pid;
  return typeof a.command === 'string' && a.command === b.command;
};
// Persist only registrations that were verified while the follower was live. A missing registry proves nothing.
export const stopBackgroundState = async (owner, tasks, snapshot, { ancestryDeadline = Date.now() + 150 } = {}) => {
  const file = path.join(rulesShared(), 'worker-stop-state', path.basename(ackFile(owner)));
  let previous = {};
  try { previous = JSON.parse(await fs.readFile(file, 'utf8')); } catch {}
  const registrations = {}, suppressed = new Set(), covered = new Set(), now = Date.now();
  for (const row of snapshot.running) {
    // Share one ancestry budget across every worker and leave time to emit an uncovered-worker block.
    const task = await matchingBackgroundTask(row, tasks, owner, { ancestryTimeoutMs: Math.max(0, ancestryDeadline - Date.now()) });
    if (task) {
      covered.add(row.runId);
      registrations[row.runId] = Object.fromEntries(['id', 'task_id', 'taskId', 'pid', 'command'].filter((key) => task[key] !== undefined).map((key) => [key, task[key]]));
    }
  }
  for (const row of snapshot.pending) {
    if (row.event !== 'finished' || row.exit !== 0 || row.mayRun || !eligible(row, owner)) continue;
    const saved = previous.registrations?.[row.runId];
    const prior = saved && typeof saved === 'object' && !Array.isArray(saved)
      && (taskIds(saved).length || (Number.isInteger(saved.pid) && saved.pid > 0)
        || (typeof saved.command === 'string' && saved.command.trim())) ? saved : null;
    const reported = await matchingBackgroundTask(row, tasks, owner, { finished: true, registration: prior });
    const disappeared = Array.isArray(tasks) && prior && Number.isFinite(previous.stopAt) && row.t < previous.stopAt
      && !followerAlive(row) && !tasks.some((task) => task && typeof task === 'object' && sameTask(prior, task));
    if (reported || disappeared) suppressed.add(row.id);
    // Retain the verified registration until delivery commits, including a clean exit still listed as running.
    if (prior) registrations[row.runId] = prior;
  }
  await atomic(file, { stopAt: now, registrations }).catch(() => {});
  return { covered, suppressed };
};
