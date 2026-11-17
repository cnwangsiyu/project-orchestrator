import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pending = new Map();
let timer = null;
// A short-lived best-effort child cannot change the worker's exit code.
const spawnRefresh = row => {
  try {
    const args = [fileURLToPath(new URL('../board.mjs', import.meta.url)), 'refresh'];
    if (row.project) args.push('--project', row.project);
    if (row.thread) args.push('--thread', row.thread);
    if (row.account) args.push('--account', row.account);
    const child = spawn(process.execPath, args, { stdio: 'ignore', env: { ...process.env, ORCHESTRATOR_OWNER: row.owner ?? '' } });
    const timeout = setTimeout(() => child.kill('SIGTERM'), 5000); timeout.unref();
    child.on('error', () => clearTimeout(timeout)); child.on('exit', () => clearTimeout(timeout)); child.unref();
  } catch {}
};
const flush = () => {
  clearTimeout(timer); timer = null;
  const rows = [...pending.values()]; pending.clear();
  for (const row of rows) spawnRefresh(row);
};
process.on('exit', flush);
export const requestBoardRefresh = row => {
  pending.set(JSON.stringify([row.account, row.runId ?? row.thread ?? row.name]), row);
  if (['finished', 'failed', 'stalled', 'needs-user', 're-routed', 'follower-ended'].includes(row.event)) { flush(); return; }
  // Forking during thread setup competes with its short RPC deadline. Coalesce requests, not facts.
  if (!timer) { timer = setTimeout(flush, 500); timer.unref(); }
};
