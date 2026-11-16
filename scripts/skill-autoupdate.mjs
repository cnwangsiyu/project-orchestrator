#!/usr/bin/env node
// SessionStart does local work only; a detached copy performs the network fetch.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';

const script = fileURLToPath(import.meta.url);
const sharedDir = () => process.env.RULES_SHARED || path.join(os.homedir(), '.claude/orchestrator/_shared');
const THROTTLE = 10 * 60 * 1000;
const host = os.hostname();
const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
// Ignore Git repository overrides inherited from a caller working in another repo.
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete gitEnv[key];
const files = (shared, checkout) => {
  const id = createHash('sha256').update(checkout).digest('hex').slice(0, 24);
  const base = path.join(shared, 'autoupdate', id);
  return { state: `${base}.json`, lock: `${base}.lock`, fetchLog: `${base}.fetch.log` };
};
const json = async (file) => { try { const data = JSON.parse(await fs.readFile(file, 'utf8')); return data && typeof data === 'object' ? data : {}; } catch { return {}; } };
const write = async (file, data) => {
  const tmp = `${file}.${process.pid}.${randomUUID()}`;
  try { await fs.writeFile(tmp, JSON.stringify(data), { mode: 0o600 }); await fs.rename(tmp, file); }
  finally { await fs.unlink(tmp).catch(() => {}); }
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
async function lock(file) {
  // Recover only a positively dead local owner; unknown/foreign locks are skipped.
  const previous = await json(file);
  if (previous.host === host && Number.isInteger(previous.pid) && previous.pid > 0 && !alive(previous.pid)) {
    let recovery;
    try {
      recovery = await fs.open(`${file}.reclaim`, 'wx', 0o600);
      const current = await json(file);
      if (current.token === previous.token && current.pid === previous.pid) await fs.unlink(file).catch(() => {});
    } catch { return null; }
    finally { if (recovery) { await recovery.close(); await fs.unlink(`${file}.reclaim`).catch(() => {}); } }
  }
  const owner = { pid: process.pid, host, token: randomUUID() };
  try { const handle = await fs.open(file, 'wx', 0o600); await handle.writeFile(JSON.stringify(owner)); await handle.close(); return owner; }
  catch { return null; }
}
async function unlock(file, owner) {
  if ((await json(file)).token === owner.token) await fs.unlink(file).catch(() => {});
}
function git(checkout, args, end, mutation = false) {
  const remaining = end - Date.now();
  if (remaining <= 0) return Promise.reject(Error('local budget exhausted'));
  return new Promise((resolve, reject) => execFile('git', ['--no-optional-locks', '-c', 'submodule.recurse=false', '-C', checkout, ...args],
    { env: gitEnv, ...(mutation ? {} : { timeout: remaining }), maxBuffer: 1024 * 1024, encoding: 'utf8' },
    (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
}
async function discover(shared, end) {
  const own = path.resolve(path.dirname(script), '..');
  const candidates = [own];
  // Derive the paired install from the script's ancestry, never the user's HOME.
  const skills = path.dirname(own), container = path.dirname(skills);
  if (path.basename(skills) === 'skills' && ['.agents', '.claude'].includes(path.basename(container))) {
    candidates.push(path.join(path.dirname(container), path.basename(container) === '.agents' ? '.claude' : '.agents', 'skills', path.basename(own)));
  }
  const config = await json(path.join(shared, 'autoupdate.json'));
  for (const item of Array.isArray(config) ? config : Array.isArray(config.checkouts) ? config.checkouts : []) {
    if (typeof item === 'string' && item) candidates.push(path.resolve(shared, item));
  }
  const roots = new Set();
  for (const candidate of candidates) {
    if (Date.now() >= end) break;
    try {
      const root = await fs.realpath(await git(candidate, ['rev-parse', '--show-toplevel'], end));
      const parent = await git(root, ['rev-parse', '--show-superproject-working-tree'], end);
      if (parent) roots.add(await fs.realpath(parent));
      roots.add(root);
    } catch { /* Missing installs/non-repositories do not break session start. */ }
  }
  return [...roots];
}
async function record(shared, checkout, state, result, extra = {}) {
  const row = { time: new Date().toISOString(), host, checkout, result, ...extra };
  const next = { ...state, checkout, lastResult: row };
  await write(files(shared, checkout).state, next);
  const log = path.join(shared, 'autoupdate.log');
  // Keep the audit small; the per-checkout state preserves the latest result.
  try { if ((await fs.stat(log)).size > 64 * 1024) await fs.rename(log, `${log}.1`); } catch {}
  await fs.appendFile(log, JSON.stringify(row) + '\n', { mode: 0o600 });
  return next;
}
async function target(checkout, end) {
  const branch = await git(checkout, ['symbolic-ref', '--quiet', '--short', 'HEAD'], end).catch(() => '');
  if (branch && branch !== 'main') return { reason: `skipped: branch ${branch}` };
  if (!branch && !await git(checkout, ['rev-parse', '--show-superproject-working-tree'], end)) return { reason: 'skipped: detached non-submodule' };
  const ref = branch ? await git(checkout, ['for-each-ref', '--format=%(upstream)', 'refs/heads/main'], end) : 'refs/remotes/origin/main';
  if (!ref.startsWith('refs/remotes/') || !ref.endsWith('/main')) return { reason: 'skipped: main has no remote main tracking branch' };
  const remote = ref.slice('refs/remotes/'.length, -'/main'.length);
  return { ref, remote };
}
async function apply(shared, checkout, info, state, end) {
  if (await git(checkout, ['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none'], end)) return record(shared, checkout, state, 'skipped: dirty checkout');
  const from = await git(checkout, ['rev-parse', 'HEAD'], end);
  const to = await git(checkout, ['rev-parse', '--verify', info.ref], end).catch(() => '');
  if (!to) return record(shared, checkout, state, 'waiting: tracking ref unavailable');
  if (from === to) return record(shared, checkout, state, 'up to date');
  const descends = await git(checkout, ['merge-base', '--is-ancestor', from, to], end).then(() => true, () => false);
  if (!descends) {
    const ahead = await git(checkout, ['merge-base', '--is-ancestor', to, from], end).then(() => true, () => false);
    return record(shared, checkout, state, ahead ? 'skipped: local HEAD ahead (never moves backwards)' : 'skipped: diverged checkout');
  }
  // Recheck immediately before Git takes its own index/ref locks. FF-only also
  // rejects an owner landing that raced us and changed the ancestry.
  if (await git(checkout, ['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none'], end)) return record(shared, checkout, state, 'skipped: dirty checkout');
  try {
    await git(checkout, ['-c', 'core.hooksPath=/dev/null', '-c', 'merge.autoStash=false', 'merge', '--ff-only', '--no-edit', '--no-autostash', '--no-overwrite-ignore', to], end, true);
  } catch { return record(shared, checkout, state, 'skipped: fast-forward refused (local file collision or concurrent Git operation)'); }
  const actual = await git(checkout, ['rev-parse', 'HEAD'], Date.now() + 5000);
  return record(shared, checkout, state, 'updated', { from, to: actual });
}
async function launchFetch(shared, checkout, info, state, owner) {
  const f = files(shared, checkout);
  await write(f.state, { ...state, lastFetch: Date.now(), fetch: { status: 'running' } });
  const log = await fs.open(f.fetchLog, 'w', 0o600), fd = log.fd;
  let child;
  try {
    child = spawn(process.execPath, [script, '--fetch', checkout, shared, info.remote, info.ref, owner.token],
      { detached: true, stdio: ['ignore', fd, fd], env: gitEnv });
    // Keep the lock owned by this live process until spawn is confirmed.
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    await write(f.lock, { ...owner, pid: child.pid });
    child.unref();
  } catch (error) {
    if (child?.pid && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
    child?.unref();
    throw error;
  } finally { await log.close(); }
}
async function fetchWorker(checkout, shared, remote, ref, token) {
  const f = files(shared, checkout);
  // Parent hands the lock over asynchronously; wait only in the background.
  let owner;
  for (let n = 0; n < 100; n++) {
    owner = await json(f.lock);
    if (owner.token !== token) return;
    if (owner.pid === process.pid) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (owner.pid !== process.pid) return;
  let child, timer, killTimer;
  const running = () => child?.pid && child.exitCode === null && child.signalCode === null;
  const stop = () => { if (running()) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} } };
  const terminate = () => { stop(); process.exitCode = 1; };
  process.once('SIGTERM', terminate); process.once('SIGINT', terminate);
  try {
    // Explicit refspec avoids touching other refs; '+' permits remote rewinds,
    // which apply() detects and skips. Never recurse/update the submodule tree.
    child = spawn('git', ['-c', 'submodule.recurse=false', '-C', checkout, 'fetch', '--no-recurse-submodules', remote, `+refs/heads/main:${ref}`],
      { env: gitEnv, detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve);
      timer = setTimeout(() => { stop(); killTimer = setTimeout(() => { if (running()) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } }, 500); }, 60000);
    });
    const state = await json(f.state);
    await record(shared, checkout, { ...state, fetch: { status: code === 0 ? 'finished' : 'failed', finishedAt: Date.now() } },
      code === 0 ? 'fetched: apply on next session start' : 'skipped: fetch failed (see fetch log)');
  } catch {
    await record(shared, checkout, { ...await json(f.state), fetch: { status: 'failed', finishedAt: Date.now() } }, 'skipped: fetch failed (see fetch log)');
  } finally {
    clearTimeout(timer); clearTimeout(killTimer); stop();
    process.removeListener('SIGTERM', terminate); process.removeListener('SIGINT', terminate);
    await unlock(f.lock, owner);
  }
}

async function updatePass({ budgetMs = 5000, status = false } = {}) {
  const shared = sharedDir(), end = Date.now() + budgetMs, results = [];
  await fs.mkdir(path.join(shared, 'autoupdate'), { recursive: true });
  for (const checkout of await discover(shared, end)) {
    if (Date.now() >= end) break;
    const f = files(shared, checkout);
    if (status) {
      const state = await json(f.state);
      results.push({ checkout, current: await git(checkout, ['rev-parse', 'HEAD'], end).catch(() => 'unavailable'),
        'origin/main': await git(checkout, ['rev-parse', '--verify', 'refs/remotes/origin/main'], end).catch(() => 'unavailable'),
        lastFetch: state.lastFetch ? new Date(state.lastFetch).toISOString() : null, fetch: state.fetch || null,
        lastResult: await fs.stat(f.lock).then(() => 'skipped: locked', () => state.lastResult?.result || 'never checked') });
      continue;
    }
    const owner = await lock(f.lock);
    if (!owner) { results.push({ checkout, result: 'skipped: locked' }); continue; }
    let handedOff = false;
    try {
      let state = await json(f.state);
      const info = await target(checkout, end);
      if (info.reason) state = await record(shared, checkout, state, info.reason);
      else {
        const indexLock = await git(checkout, ['rev-parse', '--path-format=absolute', '--git-path', 'index.lock'], end);
        if (await fs.stat(indexLock).then(() => true, () => false)) {
          state = await record(shared, checkout, state, 'skipped: git index locked');
          results.push({ checkout, result: state.lastResult.result });
          continue;
        }
        // Failed fetches must not cause a stale remote ref to be applied.
        if (state.fetch?.status === 'finished') state = await apply(shared, checkout, info, state, end);
        else state = await record(shared, checkout, state, 'waiting: successful fetch required');
        const safe = !state.lastResult.result.startsWith('skipped:');
        if (safe && (!state.lastFetch || Date.now() - state.lastFetch >= THROTTLE)) {
          // Even the first fetch leaves a dirty checkout entirely untouched.
          if (await git(checkout, ['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none'], end)) state = await record(shared, checkout, state, 'skipped: dirty checkout');
          else { await launchFetch(shared, checkout, info, state, owner); handedOff = true; }
        }
        // Divergence/ahead can be resolved remotely, so fetch clean skipped
        // ancestry cases on the next throttle window too.
        else if (/ahead|diverged/.test(state.lastResult.result) && (!state.lastFetch || Date.now() - state.lastFetch >= THROTTLE)) {
          await launchFetch(shared, checkout, info, state, owner); handedOff = true;
        }
      }
      results.push({ checkout, result: state.lastResult.result, fetching: handedOff });
    } catch {
      await record(shared, checkout, await json(f.state), 'skipped: local check failed or budget exhausted').catch(() => {});
      results.push({ checkout, result: 'skipped: local check failed or budget exhausted' });
    } finally { if (!handedOff) await unlock(f.lock, owner); }
  }
  return results;
}

// A SessionStart deadline must never kill Git halfway through a fast-forward or
// release its lock while Git still runs. The detached local coordinator owns
// both. Give it a short chance to finish before the digest, then let it continue.
export async function autoupdate({ budgetMs = 180 } = {}) {
  const shared = sharedDir();
  await fs.mkdir(path.join(shared, 'autoupdate'), { recursive: true });
  const log = await fs.open(path.join(shared, 'autoupdate/coordinator.log'), 'w', 0o600), fd = log.fd;
  try {
    const child = spawn(process.execPath, [script, '--run'], { detached: true, env: gitEnv, stdio: ['ignore', fd, fd] });
    await new Promise(resolve => {
      const timer = setTimeout(resolve, budgetMs);
      child.once('error', () => { clearTimeout(timer); resolve(); });
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    child.unref();
  } finally { await log.close(); }
}

// Imports must not await filesystem I/O before the caller can arm its deadline.
// Installed/symlinked copies retain this basename; only direct CLI execution needs canonicalization.
if (path.basename(process.argv[1] ?? '') === path.basename(script)
  && await fs.realpath(process.argv[1]).catch(() => '') === script) {
  try {
    if (process.argv[2] === '--fetch') await fetchWorker(...process.argv.slice(3));
    else for (const row of await updatePass({ status: process.argv.includes('--status'), budgetMs: process.argv.includes('--run') ? 30000 : 5000 })) console.log(JSON.stringify(row));
  } catch { /* Fail open, including when Git/shared storage is unavailable. */ }
}
