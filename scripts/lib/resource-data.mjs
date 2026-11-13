// Shared telemetry contract. Read only ledgers, explicit task metadata and route outcomes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

export const SHARED = path.join(os.homedir(), '.claude/orchestrator/_shared');
export const LOG = path.join(SHARED, 'resource-log.jsonl');
export const GIB = 2 ** 30;
export const TERMINAL = new Set(['done', 'finished', 'completed', 'merged', 'abandoned', 'cancelled', 'canceled']);
export const within = (file, root) => !!file && !!root && (file === root || file.startsWith(root + path.sep));
export const safeId = (s) => typeof s === 'string' && /^[a-zA-Z0-9._-]{1,120}$/.test(s) ? s : null;
export const safeHolder = (s) => typeof s === 'string' && /^[a-zA-Z0-9 ._:/+-]{1,120}$/.test(s) && !/(?:token|password|secret|cookie|bearer|api[_-]?key)\s*[:=]/i.test(s) ? s : null;
export const unsafeFile = (f) => /(?:^|[/\\])(?:auth(?:\.[^/]*)?|cookies?(?:\.[^/]*)?|credentials?(?:\.[^/]*)?|\.netrc|\.aws|keychain[^/]*|sessions?\.json)(?:$|[/\\])/i.test(f);
export const safePath = (s) => {
  if (typeof s !== 'string' || !s.startsWith('/') || /[\n\r\0?=#]/.test(s) || unsafeFile(s)) return null;
  const normalized = path.normalize(s);
  try { const real = fs.realpathSync(normalized); return unsafeFile(real) ? null : real; } catch { return normalized; }
};
export const commandName = (cmd = '') => {
  if (cmd.startsWith('/Applications/Google Chrome.app/')) return 'Google Chrome';
  const name = path.basename(cmd.trim().split(/\s+/)[0] || 'unknown');
  return /^[a-zA-Z0-9._+-]{1,80}$/.test(name) ? name : 'unknown';
};
export function readLeases(shared = SHARED) {
  const held = [], errors = []; let registered = [];
  try {
    const resources = new Map(smallText(path.join(shared, 'resources.tsv')).split('\n').filter((s) => s.trim() && !s.startsWith('#')).map((s) => { const a = s.split('\t'); if (a.length < 4) throw Error('invalid resource registry'); return [a[0], a[1]]; }));
    registered = [...resources.keys()].map(safeId).filter(Boolean);
    for (const name of fs.readdirSync(path.join(shared, 'locks')).filter((s) => s.endsWith('.d'))) {
      const id = safeId(name.slice(0, -2)); if (!id) throw Error('invalid resource lock id');
      const data = Object.fromEntries(smallText(path.join(shared, 'locks', name, 'info'), 16384).split('\n').filter((s) => s.includes('\t')).map((s) => { const i = s.indexOf('\t'); return [s.slice(0, i), s.slice(i + 1)]; }));
      held.push({ id, kind: resources.get(id) ?? 'unknown', holder: safeHolder(data.by), project: safeId(data.project), task: safeId(data.task),
        pid: /^[1-9]\d*$/.test(data.pid ?? '') && Number.isSafeInteger(Number(data.pid)) ? Number(data.pid) : null,
        host: safeId(data.host), startMs: /^\d+$/.test(data.start ?? '') && Number.isSafeInteger(Number(data.start) * 1000) && Number(data.start) > 0 ? Number(data.start) * 1000 : null,
        since: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(data.since ?? '') ? data.since : null });
    }
  } catch (e) { errors.push(`lease metadata: ${e.code ?? e.message}; unknown, not FREE`); }
  return { held, registered, complete: errors.length === 0, errors };
}
export function category(cmd = '') {
  const exe = commandName(cmd), lower = cmd.toLowerCase();
  if (/coresimulator|simulator\.app|simulatord/.test(lower)) return 'simulator';
  if (/pymobiledevice|idevice|devicectl|(?:^|\s)adb(?:\s|$)/.test(lower)) return 'device';
  if (/chrome|chromium|headless_shell/.test(lower) && /--headless|playwright|headless_shell|--remote-debugging-pipe/.test(lower)) return 'headless';
  if (/\/applications\/google chrome.app\/contents\//.test(lower)) return 'chrome';
  if (/gradledaemon|kotlin.*daemon/.test(lower)) return 'daemon';
  if (exe === 'xcodebuild') return 'xcodebuild';
  if (/^(?:gradle|gradlew)$/.test(exe) || exe === 'java' && /gradlewrappermain|org\.gradle\.(?:launcher|process)|gradle-launcher/.test(lower)) return 'gradle';
  if (/^(?:cmake|ninja|clang|clang\+\+|cc1|swift-frontend)$/.test(exe)) return 'native';
  if (/^(?:node|jest|vitest|tsx)$/.test(exe) && /(?:--test|\b(?:jest|vitest|test-runner)\b|\.test\.[cm]?[jt]s)/.test(lower)) return 'node-test';
  if (/^(?:claude|codex|traecli|trae|ttadk)$/.test(exe) || /(?:^|\/)codex-worker\.mjs(?:\s|$)/.test(cmd)) return 'worker';
  return 'other';
}
export function seconds(s) {
  const parts = s.split('-'), days = parts.length > 1 ? Number(parts.shift()) : 0;
  return days * 86400 + parts[0].split(':').reverse().reduce((sum, v, i) => sum + Number(v) * 60 ** i, 0);
}
export function parsePs(text) {
  const rows = [], errors = [];
  for (const line of text.split('\n').filter((x) => x.trim())) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/);
    if (!m) { errors.push('unparseable ps row (content omitted)'); continue; }
    const [, pid, ppid, uid, elapsed, cpu, rss, state, cpuTime, started, command] = m;
    rows.push({ pid: +pid, ppid: +ppid, uid: +uid, elapsedSeconds: seconds(elapsed), cpuPct: +cpu, rssBytes: +rss * 1024, state, cpuSeconds: seconds(cpuTime), started, _command: command });
  }
  return { rows, errors };
}
export function parseCwd(text) {
  const result = new Map(); let pid;
  for (const line of text.split('\n')) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
    if (line.startsWith('n/') && pid) result.set(pid, safePath(line.slice(1)));
  }
  return result;
}
export function parseVm(text) {
  const size = Number(text.match(/page size of (\d+) bytes/)?.[1]);
  if (!size) return null;
  const pages = Object.fromEntries([...text.matchAll(/^([^:\n]+):\s+(\d+)\./gm)].map((m) => [m[1].trim(), Number(m[2])]));
  if (!['Pages free', 'Pages inactive', 'Pages speculative'].every((k) => Number.isFinite(pages[k]))) return null;
  return { pageSize: size, pages, pageHeadroomBytes: (pages['Pages free'] + pages['Pages inactive'] + pages['Pages speculative']) * size };
}
export function parseCpu(text) {
  const m = [...text.matchAll(/CPU usage:\s*([\d.]+)% user,\s*([\d.]+)% sys,\s*([\d.]+)% idle/g)].at(-1);
  return m ? { user: +m[1], sys: +m[2], idle: +m[3], source: 'top interval (1 second)' } : null;
}
export function parseSwap(text) {
  const m = text.match(/used\s*=\s*([\d.]+)([KMG])?/);
  return m ? +m[1] * ({ K: 1024, M: 2 ** 20, G: GIB }[m[2]] ?? 1) : null;
}
function smallText(file, max = 2 ** 21) {
  if (unsafeFile(file) || unsafeFile(fs.realpathSync(file))) throw Error('credential-like path refused');
  const s = fs.statSync(file);
  if (!s.isFile() || s.size > max) throw Error('metadata file too large or not regular');
  return fs.readFileSync(file, 'utf8');
}
const taskPaths = (text) => [...text.matchAll(/(?:~\/|\/Users\/|\/private\/tmp\/|\/tmp\/)[^\s`"'<>|,;)]+/g)].map((m) => safePath(m[0].replace(/^~/, os.homedir()))).filter(Boolean);
const stateOf = (s) => {
  const word = String(s ?? '').trim().replace(/^\*+/, '').match(/^([a-zA-Z-]+)/)?.[1]?.toLowerCase();
  return TERMINAL.has(word) || ['running', 'queued', 'waiting', 'blocked', 'idle', 'paused'].includes(word) ? word : 'unknown';
};
export async function readJsonl(files, since = -Infinity, end = Infinity) {
  const rows = [], errors = [];
  for (const file of files) {
    if (unsafeFile(file) || !/\.jsonl(?:\.[1-6])?$/.test(file)) { errors.push('non-telemetry path refused'); continue; }
    try {
      if (fs.lstatSync(file).isSymbolicLink() || unsafeFile(fs.realpathSync(file))) { errors.push('symlink/credential-like telemetry refused'); continue; }
      const input = fs.createReadStream(file), rl = readline.createInterface({ input, crlfDelay: Infinity });
      input.on('error', (e) => { errors.push(`${path.basename(file)}: ${e.code ?? 'unreadable'}`); rl.close(); });
      for await (const line of rl) {
        if (!line.trim()) continue;
        try { const r = JSON.parse(line); const t = r.t ?? Date.parse(r.at); if (t >= since && t <= end) rows.push(r); }
        catch { errors.push('invalid JSONL record (content omitted)'); }
      }
    } catch (e) { errors.push(`${path.basename(file)}: ${e.code ?? 'unreadable'}`); }
  }
  return { rows, errors };
}
export async function readRegistry({ roots = [path.join(os.homedir(), '.claude/orchestrator'), path.join(os.homedir(), 'code/.claude-data/orchestrator')], routeFile = path.join(SHARED, 'route-log.jsonl') } = {}) {
  const tasks = new Map(), projects = [], mappings = [], errors = [], seen = new Set();
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const project of fs.readdirSync(root).filter((p) => p !== '_shared' && safeId(p))) {
      const dir = path.join(root, project), ledger = path.join(dir, 'ledger.md');
      if (!fs.existsSync(ledger)) continue;
      const real = fs.realpathSync(ledger); if (seen.has(real)) continue; seen.add(real);
      try {
        const text = smallText(ledger), changedAt = fs.statSync(ledger).mtimeMs;
        const orchestrator = text.match(/Orchestrator session:\s*"([^"]+)"/)?.[1] ?? null;
        projects.push({ project, orchestrator, dir });
        const get = (task) => {
          const key = `${project}/${task}`;
          if (!tasks.has(key)) tasks.set(key, { project, task, status: 'unknown', stateSource: 'ledger', changedAt, taskDir: null, activityAt: null, ready: false, waitReason: null, paths: [], workers: [] });
          return tasks.get(key);
        };
        if (fs.existsSync(path.join(dir, 'tasks'))) for (const task of fs.readdirSync(path.join(dir, 'tasks')).filter((t) => safeId(t) && fs.statSync(path.join(dir, 'tasks', t)).isDirectory())) {
          get(task).taskDir = path.join(dir, 'tasks', task);
          get(task).paths.push(get(task).taskDir);
        }
        const resolveTask = (id) => {
          const exact = [...tasks.values()].find((t) => t.project === project && t.task === id);
          const prefixes = [...tasks.values()].filter((t) => t.project === project && t.task.startsWith(id + '-'));
          return exact?.task ?? (prefixes.length === 1 ? prefixes[0].task : id);
        };
        // Explicit status lines and table state cells only; prose mentioning DONE is not evidence.
        for (const block of text.split(/(?=^###\s+)/m)) {
          const heading = block.match(/^###\s+([TW]\d+[a-zA-Z0-9-]*)\b/m);
          if (!heading) continue;
          const t = get(resolveTask(heading[1])), status = [...block.matchAll(/^\s*-\s*status:\s*(.+)$/gmi)].at(-1)?.[1];
          if (status) t.status = stateOf(status);
          t.paths.push(...taskPaths(block.split('\n').filter((line) => /\b(?:worktree|cwd|workspace|checkout)\b/i.test(line)).join('\n')).filter((p) => /worktrees?|\/tasks\//.test(p)));
        }
        let stateColumn = -1;
        for (const line of text.split('\n')) {
          if (!line.startsWith('|')) { stateColumn = -1; continue; }
          const cells = line.split('|').slice(1, -1).map((x) => x.trim());
          const header = cells.findIndex((x) => /^(?:state|status)$/i.test(x));
          if (header >= 0) { stateColumn = header; continue; }
          if (stateColumn < 0 || !/^[TW]\d+[\w-]*$/.test(cells[0] ?? '')) continue;
          const t = get(resolveTask(cells[0])); t.status = stateOf(cells[stateColumn]);
          t.paths.push(...taskPaths(line).filter((p) => /worktrees?|\/tasks\//.test(p)));
        }
        // Optional authoritative resource state; maintained by the owner, never by the sampler.
        const meta = path.join(dir, 'resource-tasks.json');
        if (fs.existsSync(meta)) {
          const data = JSON.parse(smallText(meta));
          if (!Array.isArray(data.tasks)) throw Error('invalid resource task metadata');
          for (const row of data.tasks) {
            if (!safeId(row.task)) continue;
            const t = get(row.task); t.status = stateOf(row.status); t.stateSource = 'metadata';
            t.changedAt = Number.isFinite(row.changedAt) ? row.changedAt : changedAt;
            t.activityAt = Number.isFinite(row.activityAt) ? row.activityAt : null;
            t.ready = row.ready === true; t.waitReason = ['resource', 'load', 'memory', 'heavy-build', 'dependency', 'user', 'network'].includes(row.waitReason) ? row.waitReason : null;
            t.paths.push(...(row.paths ?? []).map(safePath).filter(Boolean));
            t.workers.push(...(row.workers ?? []).map(safeId).filter(Boolean));
          }
        }
        for (const t of tasks.values()) if (t.project === project) {
          t.paths = [...new Set(t.paths)];
          for (const p of t.paths) mappings.push({ path: p, project, task: t.task });
        }
        for (const p of taskPaths(text.split(/## (?:Tasks|Decisions)/)[0]).filter((p) => !/\/tasks\//.test(p))) mappings.push({ path: p, project, task: null });
      } catch (e) { errors.push(`${project}: ${e.code ?? e.message}`); }
    }
  }
  // Outcomes alone never authorize cleanup: later dispatch/retries reopen tasks, fail is not abandoned.
  if (fs.existsSync(routeFile)) {
    if (fs.statSync(routeFile).size > 2 ** 21) {
      errors.push('route history exceeds sampler read budget; ownership state unverified');
      return { tasks: [...tasks.values()], projects, mappings, errors, complete: false };
    }
    const read = await readJsonl([routeFile]); errors.push(...read.errors);
    const latest = new Map();
    for (const r of read.rows) if ((!r.kind || ['route', 'outcome'].includes(r.kind)) && safeId(r.project) && safeId(r.name)) {
      const candidates = [...tasks.values()].filter((t) => t.project === r.project && (r.name === t.task || r.name.startsWith(`${t.project}-${t.task}`) && /^(?:-|$)/.test(r.name.slice(t.project.length + t.task.length + 1))));
      if (candidates.length === 1) { const key = `${r.project}/${candidates[0].task}`; if (!latest.has(key) || r.t >= latest.get(key).t) latest.set(key, r); }
    }
    for (const [key, r] of latest) {
      const t = tasks.get(key); t.route = { t: r.t, terminal: r.kind === 'outcome' && ['pass', 'rework'].includes(r.result) };
      if (t.stateSource !== 'metadata' || r.t >= t.changedAt) {
        t.status = t.route.terminal ? 'done' : 'running';
        t.changedAt = r.t; t.stateSource = 'route';
      }
    }
  }
  return { tasks: [...tasks.values()], projects, mappings, errors, complete: projects.length > 0 && errors.length === 0 };
}
export function attribute(rows, registry) {
  const byPid = new Map(rows.map((p) => [p.pid, p])), owners = new Map();
  const direct = (p) => {
    const cmd = p._command ?? '', cwd = p.cwd;
    const hits = registry.mappings.filter((m) => within(cwd, m.path) || cmd.includes(m.path) && new RegExp(`${m.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:/|[\\s"']|$)`).test(cmd));
    const taskPath = cmd.match(/\/(?:\.claude\/orchestrator|\.claude-data\/orchestrator)\/([\w-]+)\/tasks\/([\w.-]+)(?:\/|[\s"']|$)/) ?? cwd?.match(/\/(?:\.claude\/orchestrator|\.claude-data\/orchestrator)\/([\w-]+)\/tasks\/([\w.-]+)(?:\/|$)/);
    if (taskPath) hits.push({ project: safeId(taskPath[1]), task: safeId(taskPath[2]), path: 'explicit-task-path' });
    const named = cmd.match(/(?:codex-worker\.mjs|codex|claude|traecli).*?\s(?:--name|-n)\s+["']?([\w.-]+)/)?.[1];
    for (const t of registry.tasks) if (named && (t.workers.includes(named) || named === `${t.project}-${t.task}` || named.startsWith(`${t.project}-${t.task}-`))) hits.push({ project: t.project, task: t.task, path: 'worker-name' });
    const specific = hits.filter((h) => h.task), selected = specific.length ? specific : hits;
    const unique = [...new Map(selected.map((h) => [`${h.project}/${h.task}`, h])).values()];
    if (unique.length !== 1) return { project: null, task: null, evidence: unique.length ? 'ambiguous' : 'unknown' };
    let h = unique[0];
    if (!h.task) {
      const worktree = cwd?.match(/\/(?:\.worktrees|\.claude\/worktrees|worktrees)\/([^/]+)/)?.[1];
      const id = worktree?.match(/^([TW]\d+[a-z]*)(?:-|$)/i)?.[1]?.toLowerCase();
      const matches = registry.tasks.filter((t) => t.project === h.project && t.task.match(/^([TW]\d+[a-z]*)(?:-|$)/i)?.[1]?.toLowerCase() === id);
      if (id && matches.length === 1) h = { ...h, task: matches[0].task, path: 'inferred-worktree-id' };
    }
    const t = registry.tasks.find((t) => t.project === h.project && t.task === h.task);
    return { project: h.project, task: h.task, status: t?.status ?? 'unknown', changedAt: t?.changedAt ?? null, activityAt: t?.activityAt ?? null, taskDir: t?.taskDir ?? null, inferred: h.path === 'inferred-worktree-id', evidence: h.path === 'worker-name' ? 'worker-name' : h.path === 'inferred-worktree-id' ? 'inferred-worktree-id' : 'path' };
  };
  for (const p of rows) owners.set(p.pid, direct(p));
  for (const p of rows) {
    if (owners.get(p.pid).evidence !== 'unknown') continue;
    let q = p; const seen = new Set([p.pid]);
    while (byPid.has(q.ppid) && q.ppid > 1 && !seen.has(q.ppid)) {
      q = byPid.get(q.ppid); seen.add(q.pid);
      const o = owners.get(q.pid); if (o.project) { owners.set(p.pid, { ...o, evidence: `ancestor:${q.pid}` }); break; }
    }
  }
  return owners;
}
