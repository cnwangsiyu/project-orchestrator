// Read Codex quota through the configured hub's normal read-only usage command.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('../codex-worker.mjs', import.meta.url));

const parseUsage = (usage) => {
  // Plans differ in which windows they have, so take whatever comes back and label each by its own duration.
  const windows = []; let plan = null, unlimited = false;
  for (const [id, b] of Object.entries(usage.buckets ?? {})) {
    if (!b) continue;
    plan ??= b.planType;
    if (b.credits?.unlimited) { unlimited = true; continue; }
    for (const w of [b.primary, b.secondary]) {
      if (!w || w.usedPercent == null) continue;
      const mins = w.windowDurationMins;
      const span = mins === 300 ? '5h' : mins === 10080 ? 'week' : mins ? `${mins}m` : '?';
      windows.push({ label: id === 'codex' ? span : `${span} (${b.limitName ?? id})`, used: w.usedPercent, resetsAt: w.resetsAt ? w.resetsAt * 1000 : null, windowMins: mins ?? null, scoped: id !== 'codex' });
    }
  }
  const rc = usage.resetCredits;
  const resets = rc ? {
    count: rc.availableCount ?? 0,
    credits: (rc.credits ?? []).filter((c) => c.status === 'available')
      .map((c) => ({ id: c.id, expiresAt: c.expiresAt ? c.expiresAt * 1000 : null }))
      .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity)),
  } : null;
  return { plan, windows, resets, unlimited, id: usage.accountId ?? null, allowed: usage.ordinaryUsageAllowed ?? null };
};
export const readCodexUsage = (name, timeout, stderr = 'pipe') => parseUsage(JSON.parse(execFileSync(process.execPath,
  [WORKER, '--account', name, 'usage'], { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', stderr] })));

// A hub that answers but can't start threads (2026-11-08: a hub started inside a since-removed worktree panicked on every
// new thread, "provider auth cwd must resolve", while every check here said healthy). Two checks that cost no quota:
// the hub process's working directory still exists, and its hub.log shows no panic since its last start banner. A real
// thread-start probe costs seconds, so it runs only in the nightly review or after a failed start (user, 2026-11-08).
// Only recent panics count (2026-11-09: a one-off panic when the whole system ran out of file handles —
// "Too many open files in system" — left a working TRAE hub flagged broken for hours): a hub that keeps failing keeps
// panicking, so a persistent fault stays visible while a passing one ages out.
// Returns null when fine or not checkable (no listener, no lsof), else { pid, why, fix }.
export const PANIC_WINDOW_MIN = 30;
// Pure: the message of a panic since the hub's last start banner that happened within the window, or null. Panic lines
// carry no timestamp: a panic takes the time of the nearest timestamped log line before it (else after it, else mtime).
export const recentPanic = (log, now, mtime, windowMin = PANIC_WINDOW_MIN) => {
  const start = Math.max(0, ...[...log.matchAll(/app-server \(WebSockets\)/g)].map((m) => m.index));
  const lines = log.slice(start).split('\n');
  const ts = lines.map((l) => { const m = /(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)/.exec(l); return m ? Date.parse(m[1]) : null; });
  let found = null;
  lines.forEach((l, i) => {
    if (!/panicked at /.test(l)) return;
    let t = null;
    for (let k = i; k >= 0 && t == null; k--) t = ts[k];
    for (let k = i; k < lines.length && t == null; k++) t = ts[k];
    if ((t ?? mtime) >= now - windowMin * 60000) found = (lines[i + 1] ?? '').trim().slice(0, 160);
  });
  return found;
};
export const hubBroken = (name, prof) => {
  try {
    const port = new URL(prof.hub).port;
    const pid = execFileSync('lsof', ['-t', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0];
    if (!pid) return null;
    const why = [];
    const cwd = (execFileSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').find((l) => l.startsWith('n')) ?? '').slice(1);
    if (cwd && !fs.existsSync(cwd)) why.push(`its working directory ${cwd} no longer exists`);
    const logPath = path.join(prof.home, 'hub.log');
    if (fs.existsSync(logPath)) {
      const p = recentPanic(fs.readFileSync(logPath, 'utf8'), Date.now(), fs.statSync(logPath).mtimeMs);
      if (p) why.push(`hub.log has a panic in the last ${PANIC_WINDOW_MIN} min: ${p}`);
    }
    if (!why.length) return null;
    return { pid: Number(pid), why: why.join('; '), fix: `once its running turns finish: kill ${pid}; cd ~ && node ${WORKER} --account ${name} hub` };
  } catch { return null; }
};

export const readPersonalCodexQuota = (name, prof = {
  home: path.join(os.homedir(), '.codex'), hub: 'ws://127.0.0.1:47321',
}) => {
  const u = readCodexUsage(name, 10000, 'ignore');
  const broken = hubBroken(name, prof);
  return { ...prof, ...u, name, live: !broken, healthy: !broken, auth: true, hubBroken: broken };
};
