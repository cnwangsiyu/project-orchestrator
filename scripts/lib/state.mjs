// state: read Claude's and every Codex account's usage, and derive the quota state that quota.mjs prints and route.mjs
// routes on. All quota policy lives here (POLICY, analyze, leanLines), so both scripts and the docs agree.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readPause, readPoolPauses, liftAuthPause, poolOf, claimProbes } from './trae-health.mjs';

export const now = Date.now();

// ---- Claude ----
// Epoch ms of a wall-clock time in an IANA zone (no library: correct the UTC guess by the zone's offset).
const zoned = (y, mo, d, h, mi, tz) => {
  const guess = Date.UTC(y, mo, d, h, mi);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
    .formatToParts(new Date(guess)).map((p) => [p.type, Number(p.value)]));
  return guess - (Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - guess);
};
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// "Nov 3 at 9am (America/Los_Angeles)", "4:30pm (America/Los_Angeles)" → epoch ms, or null.
const parseReset = (s) => {
  const m = s.match(/^(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2})(?:,)?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i);
  if (!m) return null;
  const [, mon, day, hh, mm = '0', ampm, tz] = m;
  const h = (Number(hh) % 12) + (ampm.toLowerCase() === 'pm' ? 12 : 0);
  try {
    const today = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' })
      .formatToParts(new Date(now)).map((p) => [p.type, Number(p.value)]));
    let t;
    if (mon) {
      const mo = MONTHS.indexOf(mon.toLowerCase());
      if (mo < 0) return null;
      t = zoned(today.year, mo, Number(day), h, Number(mm), tz);
      if (t < now - 86400000) t = zoned(today.year + 1, mo, Number(day), h, Number(mm), tz);
    } else {
      t = zoned(today.year, today.month - 1, today.day, h, Number(mm), tz);
      if (t < now) t += 86400000;
    }
    return t;
  } catch { return null; }
};

const readClaude = () => {
  const out = execFileSync('claude', ['-p', '/usage'], { encoding: 'utf8', timeout: 90000, cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'ignore'] });
  const windows = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*Current (.+?):\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets\s+(.+))?$/);
    if (!m) continue;
    const label = m[1].replace(/\s+/g, ' ');
    const windowMins = /session/i.test(label) ? 300 : /week/i.test(label) ? 10080 : null;
    // A window for one model only (e.g. "week (Fable)") doesn't limit other work, so it doesn't decide the status.
    const scoped = /\((?!all models)[^)]*\)/i.test(label);
    windows.push({ label, used: Number(m[2]), resetsAt: m[3] ? parseReset(m[3].trim()) : null, windowMins, scoped });
  }
  if (!windows.length) throw new Error('no usage lines in `claude -p /usage` output');
  return windows;
};

// ---- Codex accounts ----
// Each account is a profile in the accounts file: its own CODEX_HOME (own login) and own hub, so accounts run side by
// side. Without the file there is one profile, `main` (~/.codex, the default hub). The file also keeps each account's
// last reading; an account whose hub is down is projected from it (windows roll over at their reset).
export const SHARED = path.join(os.homedir(), '.claude', 'orchestrator', '_shared');
export const ACCOUNTS = process.env.CODEX_ACCOUNTS || path.join(SHARED, 'codex-accounts.json');
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'codex-worker.mjs');
export const MAIN_PROFILE = { home: path.join(os.homedir(), '.codex'), hub: 'ws://127.0.0.1:47321' };

// A tiny cross-process lock (mkdir is atomic) around read-modify-write of a shared file; stale after 30 s.
export const withLock = (file, fn) => {
  const lock = `${file}.lock`, until = Date.now() + 10000;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30000) { fs.rmdirSync(lock); continue; } } catch {}
      if (Date.now() > until) throw new Error(`lock busy: ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch {} }
};
const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };
const writeJson = (f, v) => { const t = `${f}.${process.pid}`; fs.writeFileSync(t, JSON.stringify(v, null, 1)); fs.renameSync(t, f); };
export const readProfiles = () => {
  const reg = readJson(ACCOUNTS, {});
  if (!Object.keys(reg).length) reg.main = { ...MAIN_PROFILE };
  return reg;
};
// The Codex model catalog (`codex debug models`) as the main ChatGPT account sees it. Each home lists different models
// (TTADK's gateway lists its own), so the caller's CODEX_HOME must not leak in: the nightly TTADK worker inherits
// TTADK's, and on 2026-11-08 that saved TTADK's 18 models as the main baseline. review-data compares against main.
export const codexCatalog = ({ reg = readProfiles(), env = process.env } = {}) => {
  const home = reg.main?.home ?? MAIN_PROFILE.home;
  try {
    const raw = execFileSync('codex', ['debug', 'models'], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'], env: { ...env, CODEX_HOME: home } });
    const j = JSON.parse(raw.slice(raw.indexOf('{')));
    return { home, codex: (j.models ?? j).filter((m) => m.visibility !== 'hide').map((m) => ({ slug: m.slug, desc: m.description, ctx: m.context_window, efforts: (m.supported_reasoning_levels ?? []).map((x) => x.effort ?? x) })) };
  } catch (e) { return { home, codex: [], codexError: String(e.message).split('\n')[0] }; }
};
export const updateProfiles = (fn) => withLock(ACCOUNTS, () => { const reg = readProfiles(); fn(reg); writeJson(ACCOUNTS, reg); return reg; });

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
// The account a home's `codex login` points at (its hub may still run an older one until it restarts). Only the
// account id, email and plan are read from the id token; no token is kept or printed.
const readLogin = (home) => {
  try {
    const a = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'));
    const claims = JSON.parse(Buffer.from(a.tokens.id_token.split('.')[1], 'base64url').toString());
    const auth = claims['https://api.openai.com/auth'] ?? {};
    return { id: a.tokens.account_id ?? auth.chatgpt_account_id ?? null, email: claims.email ?? null, plan: auth.chatgpt_plan_type ?? null };
  } catch { return null; }
};
const rollForward = (acc) => {
  const windows = (acc.windows ?? []).map((w) => {
    let { used, resetsAt } = w;
    while (resetsAt && w.windowMins && resetsAt <= now) { used = 0; resetsAt += w.windowMins * 60000; }
    return { ...w, used, resetsAt };
  });
  const all = acc.resets?.credits ?? [];
  const credits = all.filter((c) => !c.expiresAt || c.expiresAt > now);
  return { ...acc, windows, resets: acc.resets ? { count: Math.max(0, (acc.resets.count ?? 0) - (all.length - credits.length)), credits } : null };
};
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
// ---- TTADK daily token quota (LLMBox) ----
// TTADK's own dashboard number: GET /api/v1/user/quota on the LLMBox gateway, which wants a short-lived token in
// `x-jwt-token` (the dashboard's header). The ttadk CLI mints and prints one itself (`ttadk auth token jwt`), so this
// reader never opens a credential file: it asks the CLI, uses the value in memory for one read-only request and drops it.
// Any failure leaves `usage:null` and a short `usageError`; nothing here changes TTADK's health or routing. This is the
// user-approved 2026-11-13 exception to the credential rule, scoped to this query inside quota.mjs/state.mjs.
export const TTADK_QUOTA_URL = 'https://llmbox-global.byteintl.net/api/v1/user/quota';
export const TTADK_DAILY_RESET_UTC_HOUR = 16;
export const ttadkQuotaUrl = (env = process.env) => env.TTADK_QUOTA_URL?.trim() || TTADK_QUOTA_URL;
const quotaNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v
  : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
// ISO string, epoch seconds or epoch ms → epoch ms (null when unreadable).
const quotaWhen = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v > 1e9 ? v * 1000 : null;
  if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : quotaWhen(Number(v));
  }
  return null;
};
const quotaRound = (x) => Math.round(x * 10) / 10;
const quotaBucket = (raw, index) => {
  const used = quotaNum(raw.used ?? raw.tokens_used);
  const limit = quotaNum(raw.limit ?? raw.tokens_limit ?? raw.quota);
  const resetsAt = quotaWhen(raw.resets_at ?? raw.resetsAt ?? raw.reset_at ?? raw.resetAt ?? raw.reset);
  const label = [raw.window, raw.period, raw.kind, raw.type, raw.name, raw.label, raw.scope, raw.interval]
    .filter((x) => typeof x === 'string' && x.trim()).join(' ').trim() || null;
  const rawUtil = quotaNum(raw.utilization ?? raw.utilisation ?? raw.used_percent ?? raw.percent);
  return { index, label, used, limit, resetsAt,
    // Compute from the numbers when both are there; else take the API's share (0–1, or already a percent).
    utilization: used != null && limit ? quotaRound((used / limit) * 100)
      : rawUtil == null ? null : quotaRound(rawUtil <= 1 ? rawUtil * 100 : rawUtil),
    remaining: used != null && limit != null ? Math.max(0, limit - used) : null,
    // A window/period that says day is the daily quota; the documented 16:00 UTC reset is the other tell.
    daily: /\bdaily\b|\bday\b|\b24\s*h(?:ours?)?\b|per[-_ ]?day/i.test(label ?? ''),
    atDailyReset: resetsAt != null && new Date(resetsAt).getUTCHours() === TTADK_DAILY_RESET_UTC_HOUR && new Date(resetsAt).getUTCMinutes() === 0 };
};
// Pick the daily bucket by its fields, never by position: the one marked day/daily, and among several plausible ones
// the one resetting at 16:00 UTC. Every bucket is kept (minimal fields) so a caller can see what came back.
export const selectDailyQuota = (payload) => {
  const list = Array.isArray(payload) ? payload : payload?.quotas ?? payload?.data ?? null;
  if (!Array.isArray(list)) return { usage: null, error: 'llmbox quota response has no quotas array' };
  const buckets = list.filter((b) => b && typeof b === 'object').map(quotaBucket);
  if (!buckets.length) return { usage: null, error: 'llmbox quota response lists no quotas' };
  const minimal = buckets.map((b) => ({ label: b.label, used: b.used, limit: b.limit, utilization: b.utilization,
    resetsAt: b.resetsAt ? new Date(b.resetsAt).toISOString() : null }));
  const daily = buckets.filter((b) => b.daily), at16 = buckets.filter((b) => b.atDailyReset);
  let pick = null;
  if (buckets.length === 1) pick = buckets[0];
  else if (daily.filter((b) => b.atDailyReset).length === 1) pick = daily.find((b) => b.atDailyReset);
  else if (at16.length === 1) pick = at16[0];
  else if (daily.length === 1) pick = daily[0];
  const usage = { used: pick?.used ?? null, limit: pick?.limit ?? null, remaining: pick?.remaining ?? null,
    utilization: pick?.utilization ?? null, resetsAt: pick?.resetsAt ?? null, source: 'llmbox', buckets: minimal };
  if (!pick) return { usage, error: `cannot tell which of ${buckets.length} llmbox quota buckets is the daily one` };
  if (pick.utilization == null) return { usage, error: 'the daily llmbox quota bucket has no utilization' };
  return { usage, error: null };
};
// One read-only request; the token lives only in this call's headers. Returns {usage, error, status}; never throws.
export const fetchTtadkQuota = async ({ token, header = 'x-jwt-token', url = ttadkQuotaUrl(), fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) => {
  if (!token) return { usage: null, status: null, error: 'no TTADK token' };
  let res;
  try {
    res = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json', [header]: token }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const what = `${e?.name ?? ''} ${e?.message ?? ''}`;
    return { usage: null, status: null, error: /timeout|abort/i.test(what) ? `llmbox timed out after ${timeoutMs}ms` : 'llmbox request failed (network)' };
  }
  if (!res.ok) return { usage: null, status: res.status, error: `llmbox HTTP ${res.status}` };
  let body;
  try { body = await res.json(); } catch { return { usage: null, status: res.status, error: `llmbox returned non-JSON (HTTP ${res.status})` }; }
  const { usage, error } = selectDailyQuota(body);
  return { usage, status: res.status, error };
};
// readTtadk is synchronous (route.mjs reads the state without awaiting), so the request runs in a child node process;
// the token goes in over stdin, never argv. The child imports this module so parsing stays in one place.
const QUOTA_CHILD = `
import { readFileSync } from 'node:fs';
const { fetchTtadkQuota } = await import(${JSON.stringify(import.meta.url)});
process.stdout.write(JSON.stringify(await fetchTtadkQuota(JSON.parse(readFileSync(0, 'utf8')))));
`;
const quotaViaChild = (token, header) => {
  try {
    const raw = execFileSync(process.execPath, ['--input-type=module', '-e', QUOTA_CHILD], { input: JSON.stringify({ token, header, url: ttadkQuotaUrl() }),
      encoding: 'utf8', timeout: 7000, maxBuffer: 4 << 20, stdio: ['pipe', 'pipe', 'ignore'] });
    return JSON.parse(raw);
  } catch (e) { return { usage: null, status: null, error: `quota query failed (${e?.code === 'ETIMEDOUT' ? 'timeout' : 'child error'})` }; }
};
// A short-lived token from the CLI itself, never from the credential store directly; stdout is parsed and dropped.
const ttadkToken = (bin, kind) => {
  try {
    const j = JSON.parse(execFileSync(bin, ['auth', 'token', kind, '-f', 'json'], { encoding: 'utf8', timeout: 30000, maxBuffer: 1 << 20, stdio: ['ignore', 'pipe', 'ignore'] }));
    return typeof j.token === 'string' && j.token.trim() ? j.token.trim() : null;
  } catch { return null; }
};
// The dashboard's x-jwt-token first; LLMBox's own CLI auth (Authorization: Bearer at-<sso>) only if that is rejected.
const readTtadkUsage = (bin) => {
  const tries = [];
  const jwt = ttadkToken(bin, 'jwt');
  if (jwt) {
    const r = quotaViaChild(jwt, 'x-jwt-token');
    if (r.usage) return { usage: r.usage, usageError: r.error ?? null };
    tries.push(`jwt/x-jwt-token: ${r.error}`);
    if (r.status !== 401 && r.status !== 403) return { usage: null, usageError: tries.join('; ') };
  } else tries.push('jwt: ttadk auth token jwt printed no token');
  const sso = ttadkToken(bin, 'sso');
  if (!sso) { tries.push('sso: ttadk auth token sso printed no token'); return { usage: null, usageError: tries.join('; ') }; }
  const r = quotaViaChild(`Bearer at-${sso.replace(/^at-/, '')}`, 'authorization');
  if (r.usage) return { usage: r.usage, usageError: r.error ?? null };
  tries.push(`sso/authorization: ${r.error}`);
  return { usage: null, usageError: tries.join('; ') };
};
// A TTADK (company gateway) account has no ChatGPT rate-limit windows: what matters is whether it works right now — the
// ttadk CLI present, its SSO session active, the gateway listing the models, the hub up — and how many turns it runs.
const readTtadk = (name, prof) => {
  const out = { name, kind: 'ttadk', home: prof.home, hub: prof.hub, browser: !!prof.browser, chromePlugin: prof.chromePlugin ?? null,
    models: prof.models ?? [], windows: [], resets: null, healthy: false, reason: null, live: false, active: 0, ssoExpiresAt: null, email: prof.email ?? null,
    // Web search through the local proxy every TTADK call goes through (codex-worker starts it on demand); searchLive:
    // the proxy answers now.
    search: !!prof.searchPort, searchLive: false,
    // Best-effort daily token quota from LLMBox (see the approved exception above); display-only, never routing.
    usage: null, usageError: null };
  const bin = prof.ttadkBin && fs.existsSync(prof.ttadkBin) ? prof.ttadkBin : null;
  if (!bin) { out.reason = 'ttadk CLI not found (npm install -g @byted/ttadk@latest --registry=https://bnpm.byted.org, then codex-worker ttadk-setup)'; return out; }
  try {
    const st = JSON.parse(execFileSync(bin, ['auth', 'status', '-f', 'json'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] }));
    const sso = (st.providers ?? []).find((x) => x.provider === 'sso');
    out.email = st.account ?? out.email;
    out.ssoExpiresAt = sso?.expiresAt ? Date.parse(sso.expiresAt) : null;
    if (sso?.status !== 'active' || (out.ssoExpiresAt && out.ssoExpiresAt <= now)) { out.reason = 'TTADK SSO not logged in or expired (the user runs `! ttadk auth login sso`)'; return out; }
  } catch (e) { out.reason = `ttadk auth status failed: ${String(e.message).split('\n')[0]}`; return out; }
  // The dashboard's own number, read best-effort; a failure is recorded and changes nothing else.
  try { const q = readTtadkUsage(bin); out.usage = q.usage; out.usageError = q.usageError; } catch { out.usageError = 'quota read failed'; }
  try {
    const mj = JSON.parse(execFileSync(bin, ['models', '-f', 'json'], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] }));
    const ms = Array.isArray(mj) ? mj : mj.models ?? []; // {tool, count, models: [...]}
    out.models = ms.filter((m) => (m.availableAgents ?? []).includes('codex') && m.realtimeHealth?.tier !== 'unhealthy').map((m) => m.id);
  } catch {}
  if (!out.models.includes('gpt-6.1-sol')) { out.reason = 'the TTADK gateway lists no healthy gpt-6.1-sol for codex'; return out; }
  out.healthy = true;
  // Token quota used up (the proxy records it; see ttadk-search-proxy.mjs): unusable until the reset, for every model.
  try {
    const q = JSON.parse(fs.readFileSync(path.join(prof.home, 'quota-limit.json'), 'utf8'));
    if (q.resetsAt > now) {
      out.healthy = false; out.quotaOut = { kind: q.kind, resetsAt: q.resetsAt };
      out.reason = `its ${q.kind} token quota is used up (shared by all models; about 500M tokens a day); resets ${fmt(q.resetsAt)}`;
    }
  } catch {}
  try {
    const list = execFileSync(process.execPath, [WORKER, '--account', name, 'list', '--limit', '60'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
    out.live = true;
    out.active = list.split('\n').filter((l) => l.split('\t')[2] === 'active').length;
  } catch { out.live = false; }
  const broken = out.live ? hubBroken(name, prof) : null;
  if (broken) { out.healthy = false; out.hubBroken = broken; out.reason = `its hub answers but can't start threads (${broken.why}); restart it ${broken.fix}`; }
  if (out.search) {
    try { out.searchLive = execFileSync('curl', ['-s', '-m', '2', `http://127.0.0.1:${prof.searchPort}/__health`], { encoding: 'utf8', timeout: 5000 }).includes('ttadk-search-proxy'); } catch {}
  }
  return out;
};
// A TRAE CLI account (codex-worker trae-setup): the company's agent CLI with its own model pool, used after TTADK and
// before personal quota (user, 2026-11-08). Healthy = the CLI present, logged in, GPT-6.1-Sol listed, the hub sound.
const readTrae = (name, prof) => {
  const out = { name, kind: 'trae', home: prof.home, hub: prof.hub, browser: false, chromePlugin: null, models: prof.models ?? [], modelIds: prof.modelIds ?? {},
    windows: [], resets: null, healthy: false, reason: null, live: false, active: 0, email: null, search: true, searchLive: true };
  const bin = prof.bin && fs.existsSync(prof.bin) ? prof.bin : null;
  if (!bin) { out.reason = 'TRAE CLI not found (install it, then codex-worker trae-setup)'; return out; }
  let status = '';
  try { status = execFileSync('/bin/sh', ['-c', '"$0" login status 2>&1', bin], { encoding: 'utf8', timeout: 30000 }); } catch (e) { status = String(e.stdout ?? ''); } // it prints to stderr
  if (!/logged in/i.test(status) || /not logged in/i.test(status)) { out.reason = 'TRAE CLI not logged in (run `traecli login --git-code`, or the user runs `! traecli login --sso`)'; return out; }
  liftAuthPause(prof.home); // logged in again: an auth pause is over
  try {
    const ids = execFileSync(bin, ['models'], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').map((l) => l.trim()).filter((l) => /^[A-Za-z0-9][\w.-]*$/.test(l));
    if (ids.length) { out.modelIds = Object.fromEntries(ids.map((i) => [i.toLowerCase(), i])); out.models = Object.keys(out.modelIds); }
  } catch {}
  // Healthy with any model route.mjs can use: GPT-6.1-Sol first, its fallback families (route.mjs ALTS) after it.
  if (!out.models.some((m) => /^(gpt-6\.1-sol|deepseek-v4\.1-flash|gemini-3\.1-pro|deepseek-v4-pro)/.test(m))) { out.reason = 'TRAE CLI lists neither GPT-6.1-Sol nor a fallback model'; return out; }
  out.healthy = true;
  // Paused after repeated or hard worker failures (lib/trae-health.mjs): unavailable until the pause ends.
  const pause = readPause(prof.home);
  if (pause) { out.healthy = false; out.paused = pause; out.reason = `paused until ${fmt(pause.pausedUntil)} after worker failures (${pause.reason})`; }
  try {
    const list = execFileSync(process.execPath, [WORKER, '--account', name, 'list', '--limit', '60'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
    out.live = true;
    out.active = list.split('\n').filter((l) => l.split('\t')[2] === 'active').length;
  } catch { out.live = false; }
  const broken = out.live ? hubBroken(name, prof) : null;
  if (broken) { out.healthy = false; out.hubBroken = broken; out.reason = `its hub answers but can't start threads (${broken.why}); restart it ${broken.fix}`; }
  return out;
};
// A ChatGPT Codex home can drive Chrome and desktop apps when its config has the node_repl MCP server with the browser
// service — written by `codex-worker browser-setup`, or by the ChatGPT app itself on its own home (~/.codex), which then
// has no `browser` mark in the accounts file (2026-11-10: the MacBook's orchestrators sent all browser work to Claude).
export const codexBrowserReady = (home) => {
  try {
    const toml = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    return /^\[mcp_servers\.node_repl\]/m.test(toml) && /NODE_REPL_TRUSTED_SERVICES[^\n]*browser/.test(toml);
  } catch { return false; }
};
const chromePluginOf = (home) => {
  // The app's own unpacked copy first: it matches the app's node_repl (see codex-worker, findChromePlugin).
  for (const d of [path.join(os.homedir(), '.codex', '.tmp', 'bundled-marketplaces', 'openai-bundled', 'plugins'), path.join(home, 'plugins', 'cache')]) {
    try {
      if (fs.existsSync(path.join(d, 'chrome', 'scripts', 'browser-client.mjs'))) return path.join(d, 'chrome');
      for (const m of fs.readdirSync(d)) for (const v of fs.readdirSync(path.join(d, m, 'chrome')).sort().reverse())
        if (fs.existsSync(path.join(d, m, 'chrome', v, 'scripts', 'browser-client.mjs'))) return path.join(d, m, 'chrome', v);
    } catch {}
  }
  return null;
};
const readCodexAll = () => {
  const accounts = [];
  updateProfiles((reg) => {
    for (const [name, prof] of Object.entries(reg)) {
      if (prof.kind === 'ttadk') {
        const t = readTtadk(name, prof);
        reg[name] = { ...prof, models: t.models, email: t.email, seenAt: now };
        accounts.push({ ...t, seenAt: now });
        continue;
      }
      if (prof.kind === 'trae') {
        const t = readTrae(name, prof);
        reg[name] = { ...prof, models: t.models, modelIds: t.modelIds, seenAt: now };
        accounts.push({ ...t, seenAt: now });
        continue;
      }
      const login = readLogin(prof.home);
      try {
        const u = parseUsage(JSON.parse(execFileSync(process.execPath, [WORKER, '--account', name, 'usage'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] })));
        reg[name] = { ...prof, id: u.id, email: login?.id === u.id ? login.email : prof.email ?? null, plan: u.plan, seenAt: now, windows: u.windows, resets: u.resets, unlimited: u.unlimited };
        // A broken hub still answers `usage`; count it as not live so routing prefers a working hub, and say how to fix it.
        const broken = hubBroken(name, prof);
        const browser = !!reg[name].browser || codexBrowserReady(prof.home);
        accounts.push({ name, live: !broken, ...reg[name], browser, chromePlugin: reg[name].chromePlugin ?? (browser ? chromePluginOf(prof.home) : null),
          allowed: u.allowed, staleHub: !!(login?.id && u.id && login.id !== u.id), hubBroken: broken });
      } catch (e) {
        const error = String(e.stderr || e.message).trim().split('\n')[0];
        accounts.push(prof.windows ? { name, live: false, error, loggedIn: !!login, ...rollForward(prof) }
          : { name, live: false, error, loggedIn: !!login, home: prof.home, hub: prof.hub, email: login?.email ?? null, windows: null, resets: null });
      }
    }
  });
  return accounts;
};

// ---- reading, with a shared 10-minute cache and a 48-hour history for recent burn rates ----
const TTL_MS = 10 * 60 * 1000;
export const CACHE = process.env.QUOTA_CACHE || path.join(SHARED, 'quota.json');
export const QUOTA_LOG = process.env.QUOTA_LOG_FILE || path.join(SHARED, 'quota-log.jsonl');
export const ROUTE_LOG = process.env.ROUTE_LOG_FILE || path.join(SHARED, 'route-log.jsonl');
// Outcome ↔ routing-decision join, shared by outcome.mjs and review-data.mjs so both read the log the same way.
// Reviews (NAME-R, review / second-opinion rows) are checks of a task, not attempts at it: they get no outcome of their own.
export const isReviewDecision = (r) => ['review', 'review-high', 'second-opinion'].includes(r.category) || /-R\d*$/.test(r.name ?? '');
// Names are compared without a leading "<project>-" (orchestrators write both T17 and lynx-view-T17). A decision belongs to
// an outcome when its name is the outcome's name or derives from it (NAME-fix1, NAME-r2, NAME-<subtask>).
const bare = (project, name) => (name.startsWith(`${project}-`) ? name.slice(project.length + 1) : name);
// Model comparisons count code rework only: rework whose recorded cause is spec, process, infra or scope is not the
// model's (rework retro 2026-11-10, user-approved). Records without a cause (older ones) count as before.
export const modelView = (o) => (o.result === 'rework' && o.cause && o.cause !== 'code' ? { ...o, result: 'pass', rounds: 0 } : o);
// ---- TRAE CLI vs native Codex (user, 2026-11-08: measure whether TRAE's Codex fork does worse with the same model) ----
// The harness a Codex attempt ran on: 'trae' for the TRAE CLI account, 'codex' for every other Codex account (TTADK and
// the ChatGPT accounts run the official Codex CLI), 'claude' for Claude.
export const harnessOf = (pick, profiles = {}) => {
  if (!pick) return null;
  if (pick.vendor !== 'codex') return pick.vendor;
  return profiles[pick.account]?.kind === 'trae' || pick.account === 'trae' ? 'trae' : 'codex';
};
// Fisher's exact test, two-sided, on the 2x2 table [[a, b], [c, d]] (first-pass vs not, per harness).
export const fisherExact = (a, b, c, d) => {
  const lf = (n) => { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; };
  const r1 = a + b, r2 = c + d, c1 = a + c, n = r1 + r2;
  const p = (x) => Math.exp(lf(r1) + lf(r2) + lf(c1) + lf(n - c1) - lf(n) - lf(x) - lf(r1 - x) - lf(c1 - x) - lf(r2 - c1 + x));
  const p0 = p(a); let sum = 0;
  for (let x = Math.max(0, c1 - r2); x <= Math.min(r1, c1); x++) { const px = p(x); if (px <= p0 * (1 + 1e-7)) sum += px; }
  return Math.min(1, sum);
};
// Compare outcomes of the same model on TRAE vs native Codex, by first attempt: per model, and per model + category.
// Only like-for-like rows are compared (same model, same category); a verdict needs at least MIN tasks on each side.
export const compareHarness = (outs, profiles = {}, MIN = 8) => {
  const cell = () => ({ tasks: 0, pass: 0, rework: 0, fail: 0, rounds: [], minutes: [] });
  const groups = {};
  for (const o of outs) {
    const h = harnessOf(o.first, profiles);
    if (h !== 'trae' && h !== 'codex') continue;
    for (const key of [o.first.model, `${o.first.model} / ${o.category ?? '?'}`]) {
      const g = (groups[key] ??= { trae: cell(), codex: cell() })[h];
      g.tasks++; g[o.result]++;
      if (o.rounds != null) g.rounds.push(o.rounds); if (o.minutes != null) g.minutes.push(o.minutes);
    }
  }
  const mean = (xs) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null);
  const side = (c) => ({ tasks: c.tasks, firstPass: c.tasks ? `${c.pass}/${c.tasks} (${Math.round((100 * c.pass) / c.tasks)}%)` : '-', fail: c.fail, meanRounds: mean(c.rounds), meanMinutes: mean(c.minutes) });
  const rows = [];
  for (const [key, g] of Object.entries(groups)) {
    if (!g.trae.tasks || !g.codex.tasks) continue;
    const p = fisherExact(g.trae.pass, g.trae.tasks - g.trae.pass, g.codex.pass, g.codex.tasks - g.codex.pass);
    const enough = g.trae.tasks >= MIN && g.codex.tasks >= MIN;
    const tr = g.trae.pass / g.trae.tasks, cr = g.codex.pass / g.codex.tasks;
    const verdict = !enough ? `too few tasks (need ${MIN} on each side)` : p < 0.05 ? (tr < cr ? 'TRAE significantly worse' : 'TRAE significantly better') : 'no significant difference';
    rows.push({ key, trae: side(g.trae), codex: side(g.codex), p: Math.round(p * 1000) / 1000, verdict });
  }
  const onlyTrae = Object.entries(groups).filter(([k, g]) => !k.includes(' / ') && g.trae.tasks && !g.codex.tasks).map(([k, g]) => `${k}: ${g.trae.tasks} on TRAE, none on Codex`);
  return { rows: rows.sort((x, y) => (x.key.includes(' / ') - y.key.includes(' / ')) || x.p - y.p), onlyTrae, min: MIN };
};
// Harness drift: TRAE's GPT-6.1-Sol prompt vs official Codex's (both CLIs cache the model catalog). 2026-11-08: 0.91 of
// lines equal, the differences in the plugins/apps section. A drop means TRAE's fork moved away from upstream Codex.
export const harnessDrift = (model = 'gpt-6.1-sol') => {
  const read = (f) => { try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return (j.models ?? j).find((m) => String(m.slug).toLowerCase() === model); } catch { return null; } };
  const t = read(path.join(os.homedir(), '.trae', 'cli', 'models_cache.json')), c = read(path.join(MAIN_PROFILE.home, 'models_cache.json'));
  const ti = t?.model_messages?.instructions_template, ci = c?.model_messages?.instructions_template;
  if (!ti || !ci) return { model, available: false };
  const A = ti.split('\n'), B = new Set(ci.split('\n')), Bl = ci.split('\n');
  const same = A.filter((l) => B.has(l)).length;
  const keys = ['tool_mode', 'shell_type', 'apply_patch_tool_type', 'multi_agent_version', 'supports_search_tool'];
  return { model, available: true, sharedLines: Math.round((1000 * same) / Math.max(A.length, Bl.length)) / 1000, traeLines: A.length, codexLines: Bl.length,
    toolConfigDiffers: keys.filter((k) => JSON.stringify(t[k] ?? null) !== JSON.stringify(c[k] ?? null)) };
};
export const outcomeOwns = (project, outcomeName, r) => {
  if (r.project !== project || !r.name) return false;
  const o = bare(project, outcomeName), d = bare(project, r.name);
  return d === o || d.startsWith(`${o}-`);
};
// One outcome per task (nightly review 2026-11-09: 11 tasks in a week had 2–3 records; review-data counted each, and
// the lynx re-records of 11-06 said 0 rounds after first records with 1–2). Records of the same project and name (with
// or without the "<project>-" prefix) merge into one at the latest record's time: the latest result, note and accepted
// pick; the most rounds any record gave; the first non-null first pick; reviewed if any record says so. `dupes` counts
// the records merged.
export const dedupeOutcomes = (records) => {
  const by = new Map();
  for (const o of [...records].sort((a, b) => a.t - b.t)) {
    const k = `${o.project}\u0000${o.project && o.name ? bare(o.project, o.name) : o.name}`;
    const p = by.get(k);
    if (!p) { by.set(k, { ...o, dupes: 1 }); continue; }
    const rounds = [p.rounds, o.rounds].filter((x) => x != null);
    by.set(k, { ...p, ...o, rounds: rounds.length ? Math.max(...rounds) : null, minutes: o.minutes ?? p.minutes,
      first: p.first ?? o.first, category: p.category ?? o.category, impact: p.impact ?? o.impact, reviewed: !!(p.reviewed || o.reviewed), dupes: p.dupes + 1 });
  }
  return [...by.values()];
};
export const readState = ({ fresh = false } = {}) => {
  let data = readJson(CACHE, null);
  const failed = data && (data.errors?.claude || data.errors?.codex);
  if (fresh || !data || !('codexAccounts' in data) || now - data.checkedAt > TTL_MS || (failed && now - data.checkedAt > 2 * 60000)) {
    const prev = data;
    data = { checkedAt: now, claude: null, codexAccounts: null, errors: {}, history: prev?.history ?? {} };
    try { data.claude = readClaude(); } catch (e) { data.errors.claude = String(e.message).split('\n')[0]; }
    try { data.codexAccounts = readCodexAll(); } catch (e) { data.errors.codex = String(e.stderr || e.message).trim().split('\n')[0]; }
    const push = (key, w) => {
      if (!w) return;
      const h = (data.history[key] ?? []).filter((x) => now - x.t < 48 * 3600000);
      h.push({ t: now, used: w.used, resetsAt: w.resetsAt });
      data.history[key] = h;
    };
    push('claude', weekly(data.claude));
    for (const a of data.codexAccounts ?? []) if (a.live) push(`codex:${a.name}`, weekly(a.windows));
    withLock(CACHE, () => writeJson(CACHE, data));
    // Append a compact snapshot for the nightly review: weekly usage, resets and cards per vendor/account.
    if (process.env.QUOTA_LOG !== '0') {
      const wk = (ws) => { const w = weekly(ws); return w ? { used: w.used, resetsAt: w.resetsAt } : null; };
      const snap = { t: now, claude: wk(data.claude), codex: (data.codexAccounts ?? []).filter((a) => a.live).map((a) => ({ name: a.name, ...wk(a.windows), cards: (a.resets?.credits ?? []).map((c) => ({ id: c.id, expiresAt: c.expiresAt })), cardCount: a.resets?.count ?? null })) };
      try { fs.appendFileSync(QUOTA_LOG, JSON.stringify(snap) + '\n'); } catch {}
    }
  }
  return data;
};

// ---- window math ----
// The weekly (longest) window sets deadlines, budgets and card math; a 5-hour window only throttles for a few hours.
export const weekly = (ws) => (ws ?? []).filter((w) => !w.scoped && w.windowMins).sort((a, b) => b.windowMins - a.windowMins)[0] ?? null;
const shortWin = (ws) => (ws ?? []).filter((w) => !w.scoped && w.windowMins && w.windowMins < 1440)[0] ?? null;
// Burn rate in %/hour: the recent rate (readings in this same window spanning ≥3 h of the last 24 h) when there is one,
// else the window's lifetime average with the first tenth floored, so a few percent right after a reset isn't a runaway.
const rateOf = (w, hist) => {
  const H = w.windowMins / 60, left = (w.resetsAt - now) / 3600000;
  const lifetime = w.used / Math.max(0.1 * H, H - left);
  const same = (hist ?? []).filter((x) => Math.abs((x.resetsAt ?? 0) - w.resetsAt) < 5 * 60000 && now - x.t <= 24 * 3600000 && x.used <= w.used);
  const old = same[0];
  if (old && now - old.t >= 3 * 3600000) return { rate: (w.used - old.used) / ((now - old.t) / 3600000), basis: 'recent' };
  return { rate: lifetime, basis: 'window' };
};
export const winState = (w, hist) => {
  if (!w) return null;
  const s = { label: w.label, used: w.used, windowH: w.windowMins / 60, resetsAt: w.resetsAt };
  if (!w.resetsAt) return { ...s, left: null, rate: null, projected: null, outIn: null, elapsed: null };
  const left = Math.max(0, (w.resetsAt - now) / 3600000);
  const { rate, basis } = rateOf(w, hist);
  return { ...s, left, rate, basis, elapsed: 1 - left / s.windowH, projected: Math.round(w.used + rate * left), outIn: rate > 0 ? (100 - w.used) / rate : Infinity };
};
export const hours = (h) => (h == null ? '?' : !Number.isFinite(h) ? 'never' : h < 24 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`);
export const fmt = (t) => (t ? new Date(t).toLocaleString('sv-SE').slice(5, 16) : '?');
export const fmtAgo = (t) => { const m = Math.round((now - t) / 60000); return m < 90 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };

// ---- policy (user, 2026-11-03) ----
// Codex quota is use-it-or-lose-it: spend every account's week by its reset, front-loaded while it holds reset cards.
// Claude runs the orchestrators, so it never runs out before Codex: a reserve of its week stays for orchestration.
export const POLICY = {
  // Claude's budget moves with the clock (user, 2026-11-03), so a week about to reset isn't hoarded:
  // - reserve: what the orchestrators burn until the reset (orchPerDay × days left, at least reserveMin);
  // - end cap: never plan to finish the week above 100 − margin − uncertainty, where the projection's uncertainty
  //   shrinks to 0 at the reset (a full week ahead: 100 − 5 − 15 = 80%);
  // - spare line: spareGap below the end cap, also shrinking with time (a full week ahead: 60%).
  claudeOrchPerDay: Number(process.env.QUOTA_CLAUDE_ORCH_PER_DAY ?? 20 / 7), // % of Claude's week the orchestrators use per day
  claudeReserveMin: 2, claudeMargin: 5, claudeUncertainty: 15, claudeSpareGap: 20,
  redeemAt: 99, // a reset card is suggested only once an account's week is this spent
  throttle5h: 95, // a 5-hour window this full pauses new work on that vendor/account until it resets
  overspend: 115, // projected % at reset above which a lone Codex account without cards is overspending
  fableAvoid: 70, // Fable's own window at or above this: no Fable
  ttadkSsoWarnH: 48, // warn when the TTADK SSO session expires within this many hours
  // Sites a browser worker may reach without asking (host globs); route.mjs passes them as --browser-origins.
  browserOrigins: ['*.bytedance.net', '*.byted.org', '*.larkoffice.com', '*.feishu.cn', '*.tiktok-row.net', '*.byteintl.net', '*.bytedance.com'],
  expiringH: 24, expiringRoom: 25, // a Codex week resetting within a day with this much left
};

// Reset-card plan for one account. Redeeming at usage u with d hours of a T-hour week left gains about u + d/T − 1
// weeks: a full new week, minus the unused share forfeited, minus the delay to the next natural reset (the clock
// restarts). So redeem once the week is spent (gain ≈ d/T): the earlier in a cycle, the more it gains. A card that
// expires before the natural reset sets a deadline for spending the account.
const cardPlan = (s, resets, spent) => {
  if (!s || s.left == null || !resets?.count) return null;
  const card = resets.credits[0] ?? null;
  const expH = card?.expiresAt ? (card.expiresAt - now) / 3600000 : null;
  const gainAt = (u) => u / 100 + s.left / s.windowH - 1;
  const txt = card ? `${card.id.slice(-8)}${expH != null ? `, expires in ${hours(expH)}` : ''}` : '(not listed)';
  const beforeReset = expH != null && expH < s.left;
  const p = { count: resets.count, card, txt, expH, redeem: false, urgent: false, lapse: false, gain: 0, deadlineH: null, breakEven: null, line: '',
    beforeResetCount: resets.credits.filter((c) => c.expiresAt && (c.expiresAt - now) / 3600000 < s.left).length };
  if (beforeReset) p.breakEven = Math.max(0, Math.ceil(100 * (1 - (s.left - expH) / s.windowH)));
  if (spent) {
    p.gain = gainAt(100);
    p.redeem = p.gain >= 0.1 || (beforeReset && p.gain > 0);
    p.urgent = p.redeem && expH != null && expH < 24;
    p.line = p.redeem ? `week spent with ${hours(s.left)} to its reset: card ${txt} gains ~${Math.round(p.gain * 100)}% of a week`
      : `week spent but resets in ${hours(s.left)}: wait and keep the card (it would gain only ~${Math.round(p.gain * 100)}%)`;
  } else if (beforeReset && expH <= 1) {
    p.gain = gainAt(s.used);
    if (p.gain > 0.05) { p.redeem = p.urgent = true; p.line = `card ${txt} is about to expire; at ${s.used}% it still gains ~${Math.round(p.gain * 100)}% of a week`; }
    else { p.lapse = true; p.line = `let card ${txt} lapse: at ${s.used}% redeeming forfeits more than it gains (break-even ${p.breakEven}%)`; }
  } else if (beforeReset) {
    p.deadlineH = expH;
    p.line = `card ${txt}, before the week resets: spend this account to ${POLICY.redeemAt}% by then `
      + `(needs ${((100 - s.used) / expH * 24).toFixed(0)}%/day, running ${((s.rate ?? 0) * 24).toFixed(0)}%/day), then redeem; below ${p.breakEven}% let it lapse`;
  } else p.line = `${resets.count} card${resets.count > 1 ? 's' : ''} (soonest ${txt}): front-load this account and redeem at ${POLICY.redeemAt}%`;
  if (p.beforeResetCount > 1) p.line += ` — ${p.beforeResetCount} cards expire before this week resets and each needs a spent week, so front-load hard`;
  return p;
};

// ---- the analysis every caller shares ----
export const analyze = (data) => {
  const P = POLICY, hist = data.history ?? {};
  // Claude
  const cw = weekly(data.claude), cs = winState(cw, hist.claude), c5 = shortWin(data.claude);
  // With no reset time, assume a full window ahead (the most cautious budget).
  const leftShare = cs ? (cs.left == null ? 1 : Math.min(1, cs.left / cs.windowH)) : 1;
  const reserve = cs ? Math.max(P.claudeReserveMin, Math.round(P.claudeOrchPerDay * (cs.left ?? cs.windowH) / 24)) : null;
  const cap = Math.round(100 - P.claudeMargin - P.claudeUncertainty * leftShare);
  const spareLine = Math.round(cap - P.claudeSpareGap * leftShare);
  // room: what Claude workers may still spend now — keep the reserve for the orchestrators and stay under the end cap.
  const room = cs ? Math.max(0, Math.min(100 - P.claudeMargin - reserve, cap) - cs.used) : null;
  const claude = { readable: !!cw, week: cs, cap, spareLine, reserve, room, status: 'unknown', throttledUntil: null, avoidFable: false, expiring: false };
  if (cs) {
    const proj = cs.projected ?? cs.used;
    claude.status = room <= 0 || proj > cap ? 'over' : proj > spareLine ? 'near' : 'spare';
    if (c5 && c5.used >= P.throttle5h && c5.resetsAt) claude.throttledUntil = c5.resetsAt;
    claude.avoidFable = (data.claude ?? []).some((w) => w.scoped && /fable/i.test(w.label) && w.used >= P.fableAvoid);
    // A week resetting within a day with room left: what isn't spent is lost, so stronger settings are fine.
    claude.expiring = cs.left != null && cs.left < P.expiringH && room >= P.expiringRoom && proj < cap;
  }
  // Codex accounts
  // TTADK: preferred for Codex work whenever it is healthy (user, 2026-11-07).
  const tt = (data.codexAccounts ?? []).find((a) => a.kind === 'ttadk') ?? null;
  // No concurrency cap (user, 2026-11-07): a rate-limited run is retried once on TTADK, then re-routed without it.
  const ttadk = tt ? { name: tt.name, home: tt.home, healthy: !!tt.healthy, reason: tt.reason, quotaOut: tt.quotaOut ?? null, live: !!tt.live, active: tt.active ?? 0,
    models: tt.models ?? [], browser: !!tt.browser, chromePlugin: tt.chromePlugin ?? null, search: !!tt.search, searchLive: !!tt.searchLive, ssoLeftH: tt.ssoExpiresAt ? (tt.ssoExpiresAt - now) / 3600000 : null,
    usage: tt.usage ?? null, usageError: tt.usageError ?? null } : null;
  if (ttadk) ttadk.usable = ttadk.healthy;
  // TRAE CLI: the second company account, after TTADK and before personal quota (user, 2026-11-08).
  const tr = (data.codexAccounts ?? []).find((a) => a.kind === 'trae') ?? null;
  // Pauses are read live here (the quota cache is up to 10 minutes old): a paused model family's models are left out
  // of .models, so route.mjs moves to the next family; an account pause makes TRAE unusable.
  // A family whose hard pause has ended gets a recovery probe in the background (lib/trae-health.mjs); it stays out of
  // routing until the probe succeeds. TRAE_PROBE=0 turns this off (tests).
  if (tr?.home && tr.healthy && process.env.TRAE_PROBE !== '0') for (const d of claimProbes(tr.home)) {
    try { spawn(process.execPath, [WORKER, '--account', tr.name, 'probe', '--model', d.model], { detached: true, stdio: 'ignore', cwd: os.homedir() }).unref(); } catch {}
  }
  const poolPauses = tr?.home ? readPoolPauses(tr.home) : {};
  const acctPause = tr?.home ? readPause(tr.home) : null;
  const trae = tr ? { name: tr.name, kind: 'trae', home: tr.home, healthy: !!tr.healthy && !acctPause, reason: acctPause ? `paused until ${new Date(acctPause.pausedUntil).toLocaleTimeString()} after worker failures (${acctPause.reason})` : tr.reason,
    live: !!tr.live, active: tr.active ?? 0, allModels: tr.models ?? [], models: (tr.models ?? []).filter((m) => !poolPauses[poolOf(m)]), poolPauses,
    modelIds: tr.modelIds ?? {}, browser: false, chromePlugin: null, search: true, searchLive: true } : null;
  if (trae) trae.usable = trae.healthy && trae.models.length > 0;
  const rows = (data.codexAccounts ?? []).filter((a) => a.kind !== 'ttadk' && a.kind !== 'trae').map((a) => {
    const w = weekly(a.windows), s = winState(w, hist[`codex:${a.name}`]), w5 = shortWin(a.windows);
    const unconstrained = !!a.windows && !w; // read fine, but no limit window (or unlimited credits)
    const spent = !unconstrained && !!s && (s.used >= P.redeemAt || (a.allowed === false && !(w5 && w5.used >= P.throttle5h)));
    const throttledUntil = w5 && w5.used >= P.throttle5h && w5.resetsAt && !spent ? w5.resetsAt : null;
    const cp = cardPlan(s, a.resets, spent);
    const deadline = unconstrained ? Infinity : Math.min(s?.left ?? Infinity, cp?.deadlineH ?? Infinity);
    return { a, s, unconstrained, spent, throttledUntil, cp, deadline, known: unconstrained || !!s };
  });
  const usable = (r) => r.known && !r.spent && !r.throttledUntil;
  // Earliest deadline first, stale readings included (their quota is lost on the same clock); ties go to live hubs.
  const open = rows.filter(usable).sort((x, y) => x.deadline - y.deadline || (y.a.live - x.a.live));
  const pick = open[0] ?? null;
  // Several accounts that must all be spent within two days: rotate launches across them instead of piling onto one.
  const rotate = open.filter((r) => r.deadline <= 48).length >= 2 ? open.filter((r) => r.deadline <= 48) : null;
  const urgent = rows.filter((r) => r.cp?.urgent);
  const redeemable = rows.filter((r) => r.spent && r.cp?.redeem).sort((x, y) => y.cp.gain - x.cp.gain);
  const redeem = urgent[0] ?? (!pick ? redeemable[0] ?? null : null);
  const throttled = rows.filter((r) => r.throttledUntil).sort((x, y) => x.throttledUntil - y.throttledUntil);
  const cardsHeld = rows.reduce((n, r) => n + (r.a.resets?.count ?? 0), 0);
  const codex = {
    ttadk, trae,
    readable: rows.some((r) => r.known), rows, pick, redeem, cardsHeld, throttled, rotate, open,
    out: !pick && !redeem && rows.some((r) => r.known),
    // Out only because 5-hour windows are full: a pause of hours, not a spent week.
    throttledOnly: !pick && !redeem && throttled.length > 0 && rows.every((r) => !r.known || r.spent || r.throttledUntil),
    nextFree: !pick ? Math.min(...rows.map((r) => (r.throttledUntil ? (r.throttledUntil - now) / 3600000 : r.s?.left ?? Infinity))) : null,
    pickStale: !!pick && !pick.a.live,
  };
  const after = pick ?? redeem; // the account new Codex work lands on (after a redemption, if one is due)
  const ps = after?.s;
  codex.frontLoad = !!after?.cp && !after.cp.lapse;
  codex.underused = !!ps && ps.left != null && !after.unconstrained
    && (codex.frontLoad || ((ps.used + (ps.rate ?? 0) * after.deadline) < 100 && (after.cp?.deadlineH || ps.elapsed >= 0.1)));
  codex.overspending = !!ps && !codex.frontLoad && cardsHeld === 0 && open.length <= 1 && ps.projected != null && ps.projected > P.overspend;
  // Claude may never outlast-fail Codex: with Codex out it takes only what fits its room.
  const stop = !claude.readable && !codex.readable && !codex.ttadk?.healthy && !codex.trae?.healthy;
  return { claude, codex, stop, policy: P };
};

// ---- the lean, as lines; every line is derived from analyze() ----
export const leanLines = (st, data) => {
  const { claude: C, codex: X } = st, out = [];
  const multi = X.rows.length > 1, who = (r) => `${r.a.name}${r.a.email ? ` (${r.a.email})` : ''}`;
  if (st.stop) return ['stop: neither vendor\'s usage is readable — dispatch nothing quota-dependent; check `claude -p /usage` and the Codex hubs, tell the user'];
  for (const r of X.rows) {
    if (r.a.staleHub) out.push(`account ${r.a.name}: its login changed but its hub still runs the old account — restart that hub once no thread runs on it`);
    if (!r.a.live && r.a.loggedIn === false) out.push(`account ${r.a.name}: not logged in — ask the user to run \`! CODEX_HOME=${r.a.home} codex login\`, then start its hub: codex-worker.mjs --account ${r.a.name} hub`);
    else if (r.a.hubBroken) out.push(`account ${r.a.name}: hub answers but can't start threads (${r.a.hubBroken.why}) — restart it ${r.a.hubBroken.fix}`);
    else if (!r.a.live) out.push(`account ${r.a.name}: hub unreachable${r.a.windows ? ` (using its reading from ${fmtAgo(r.a.seenAt)})` : ''} — start it: codex-worker.mjs --account ${r.a.name} hub`);
  }
  const T = X.ttadk;
  if (T) {
    if (T.usable) {
      out.push(`TTADK first: every task its gpt-6.1-sol can handle runs on account ${T.name} (route.mjs does this); the ChatGPT accounts below take image generation${T.search ? '' : ' and web research (TTADK web search not set up: rerun ttadk-setup)'}, and everything when TTADK fails (route.mjs --exclude-account ${T.name}); ${T.active} TTADK turns running`);
      out.push('TTADK device: leave the ChatGPT and Claude quota for the user\'s other device (no TTADK there) — spend it only on work TTADK can\'t do; no effort raises or extra reviews just to use quota (route.mjs applies this)');
    }
    else if (T.quotaOut && X.trae?.usable) out.push(`TTADK paused — ${T.reason}: nothing to fix; its work goes to TRAE meanwhile (see below)`);
    else if (T.quotaOut) out.push(`TTADK paused — ${T.reason}: nothing to fix; ask the user once whether TTADK's work goes on now on personal quota (then --urgent until the reset) or waits for the reset (route.mjs gates it on that OK; high stakes runs on personal quota without asking)`);
    else if (X.trae?.usable) out.push(`TTADK unavailable — ${T.reason}: tell the user now so they can fix it; meanwhile its work goes to TRAE`);
    else out.push(`TTADK unavailable — ${T.reason}: tell the user now so they can fix it; route.mjs asks the user before its work goes to personal quota (--urgent only once the user said go on; high stakes ask too); never hold work without asking`);
    if (T.healthy && !T.live) out.push(`TTADK hub down — start it before hub workers: codex-worker.mjs --account ${T.name} hub (codex exec runs don't need it)`);
    if (T.healthy && T.ssoLeftH != null && T.ssoLeftH < POLICY.ttadkSsoWarnH) out.push(`TTADK SSO expires in ${hours(T.ssoLeftH)}: ask the user to run \`! ttadk auth login sso\` before it lapses`);
    // The dashboard's own daily number: warn before the gateway starts answering 403 (user, 2026-11-13).
    if (T.usable && T.usage?.utilization != null && T.usage.utilization >= 80)
      out.push(`TTADK daily quota ${Math.round(T.usage.utilization)}% used: TRAE takes over when it runs out`);
  }
  const TR = X.trae;
  if (TR) {
    if (TR.usable && !T?.usable) out.push(`TRAE next: with TTADK ${T ? 'out' : 'absent'}, work TTADK would take runs on TRAE CLI (account ${TR.name}, GPT-6.1-Sol, then DeepSeek-V4.1-Flash / Gemini-3.1-Pro when GPT fails or is paused; route.mjs does this) before personal quota; browser, desktop apps and images stay off TRAE`);
    else if (TR.usable) out.push(`TRAE CLI (account ${TR.name}) is the fallback after TTADK, before personal quota`);
    else out.push(`TRAE CLI unavailable — ${TR.reason}`);
    for (const [pool, r] of Object.entries(TR.poolPauses ?? {})) out.push(`TRAE ${pool} models ${r.pausedUntil > Date.now() ? `paused until ${fmt(r.pausedUntil)}, then probed` : 'being probed for recovery'} (${String(r.reason).slice(0, 120)}): route.mjs uses the next model family meanwhile`);
    if (TR.healthy && !TR.live) out.push(`TRAE hub down — start it before hub workers: codex-worker.mjs --account ${TR.name} hub (traecli exec runs don't need it)`);
  }
  if (X.redeem && T) out.push(`reset card due${multi ? ` on ${who(X.redeem)}` : ''}: ${X.redeem.cp.line} — on this TTADK device ask the user only when route.mjs prints redeemFirst (ChatGPT-only work landing on that account); the other device spends that quota`);
  else if (X.redeem) out.push(`redeem a reset card${multi ? ` on ${who(X.redeem)}` : ''}: ${X.redeem.cp.line} — ask the user first, every time; only after a yes: `
    + `codex-worker.mjs --account ${X.redeem.a.name} reset-credit-use --key <new uuid>${X.redeem.cp.card ? ` --credit ${X.redeem.cp.card.id}` : ''}, then quota.mjs --fresh`);
  if (X.rotate) out.push(`${X.ttadk?.usable ? 'ChatGPT-account work' : 'new Codex work'} → rotate across ${X.rotate.map((r) => r.a.name).join(', ')} (each must be spent within ${hours(Math.max(...X.rotate.map((r) => r.deadline)))}); route.mjs alternates per launch`);
  else if (X.pick && multi) out.push(`${X.ttadk?.usable ? 'ChatGPT-account work (images, TTADK fallback)' : 'new Codex work'} → account ${who(X.pick)} (week ${X.pick.s?.used ?? '-'}%, its quota is lost first: ${hours(X.pick.deadline)})${X.pickStale ? ' — from a stale reading' : ''}`);
  if (X.out && T?.usable) out.push('ChatGPT Codex accounts are out; Codex work continues on TTADK (models it lacks wait or go to Claude)');
  else if (X.out && X.throttledOnly) out.push(`codex paused: 5h windows full, free in ${hours(X.nextFree)} — Claude takes it only while it has spare; otherwise wait`);
  else if (X.out) out.push(`codex out on every account (next free in ${hours(X.nextFree)}): tell the user; ${C.status === 'over' || C.status === 'unknown'
    ? 'Claude takes only Claude-only work that can\'t wait; the rest waits'
    : `Claude takes what matters, within ${C.room}% of room (keeping ${C.reserve}% for the orchestrators); the rest waits`}`);
  else if (!X.readable) out.push('codex usage unreadable: start the hubs (codex-worker.mjs --account <name> hub); until then route as if Codex has room and say so');
  else out.push('codex first: everything either vendor can do runs on Codex');
  const cw = C.week;
  if (C.status === 'unknown') out.push('claude usage unreadable: no new Claude workers except Claude-only work; check `claude -p /usage`');
  else if (C.status === 'over') out.push(`claude over budget (week ${cw.used}%, projected ${cw.projected ?? '?'}% vs ${C.cap}% now, ${C.reserve}% kept for the orchestrators until the reset in ${hours(cw.left)}): no new Claude workers except Claude-only work that can't wait; Claude-strength work goes to Codex; keep the orchestrator lean`);
  else if (C.status === 'near') out.push(`claude near budget (projected ${cw.projected ?? cw.used}%, spare line ${C.spareLine}%, cap ${C.cap}%): Claude-only work, design and high-stakes calls; everything else on Codex`);
  else out.push(T ? `claude has spare (projected ${cw.projected ?? cw.used}% ≤ ${C.spareLine}%), but on this TTADK device it takes only what TTADK can't do` : `claude has spare (projected ${cw.projected ?? cw.used}% ≤ ${C.spareLine}%): it also takes the work it is clearly better at`);
  if (C.throttledUntil) out.push(`claude 5h window full: no new Claude workers until ${fmt(C.throttledUntil)}`);
  for (const r of X.throttled) out.push(`codex ${r.a.name} 5h window full until ${fmt(r.throttledUntil)}`);
  if (X.underused && !T) out.push(X.frontLoad ? 'codex front-load (reset cards in hand): raise effort on Codex work one notch, add second-opinion reviews, pull queued work forward'
    : 'codex underused: raise effort on Codex work one notch, add second-opinion reviews, pull queued work forward');
  if (X.overspending) out.push('codex overspending: lower effort one notch where an automatic check catches misses; save Sol xhigh and Astra for what matters');
  for (const r of X.rows) if (r.cp && r.cp !== X.redeem?.cp && (r.cp.deadlineH || r.cp.lapse || (r.spent && !r.cp.redeem)))
    out.push(`${multi ? `${r.a.name}: ` : ''}${r.cp.line}`);
  for (const r of X.rows) if (r.spent && r.cp?.redeem && X.redeem !== r)
    out.push(`${r.a.name}: spent; hold its card ${r.cp.txt} while another account has quota (quota first) — it gains ~${Math.round(r.cp.gain * 100)}% now, falling ~${Math.round(2400 / r.s.windowH)}%/day while held; redeem when the open accounts are spent${r.cp.expH != null && r.cp.expH < r.s.left ? ', or a day before it expires' : ''}`);
  if (C.avoidFable) out.push('Fable window nearly used: no Fable');
  if (C.expiring && !T) out.push(`claude week resets in ${hours(cw.left)} with ${C.room}% spendable beyond the ${C.reserve}% reserve: stronger settings are fine on Claude`);
  for (const r of X.rows) if (!T && r.s?.left != null && r.s.left < POLICY.expiringH && 100 - r.s.used >= POLICY.expiringRoom && !r.spent)
    out.push(`codex ${r.a.name} week resets in ${hours(r.s.left)} with ${100 - r.s.used}% left: put Codex work there now, at stronger settings`);
  return out;
};
