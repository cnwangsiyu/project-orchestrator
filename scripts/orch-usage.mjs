#!/usr/bin/env node
// orch-usage: how much of its own context each local orchestrator spent doing work itself, from its transcript.
//
//   orch-usage [--hours N] [--json] [--session <id|name>]
//
// Finds the orchestrators among `claude agents --json` (names that a ledger's "Orchestrator session:" line names, or that
// end in 主对话), streams each transcript under ~/.claude/projects/, and sums the tool results that landed in its context
// over the last N hours (default 24), by kind: browser/computer-use, Read (files, screenshots), shell output by purpose,
// subagents... Also counts source edits (tools and shell writes), test/build commands, all tool calls and minutes
// blocked in foreground calls longer than two minutes. Bookkeeping
// is excluded, as are temp/log targets; source checkouts with a .git entry below a temp root still count. Small steps
// can flag even with little output. Thresholds are in LIMITS; a flag means "hand that work to workers through route.mjs",
// not a hard error.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(`--${k}`); return i < 0 ? null : argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true; };
const H = Number(opt('hours') ?? 24), since = Date.now() - H * 3600000;
// Per orchestrator per 24h (scaled by --hours). Above any of these, the orchestrator is doing work a worker should do.
const LIMITS = { ownKB: 500, browserCalls: 20, imageReads: 10, compactions: 2, sleepPolls: 10, edits: 5, testsBuilds: 3, toolCalls: 500, blockedMinutes: 30 };
const scale = H / 24;

const BUCKETS = [
  ['dispatch', /claude\s+--bg|codex-worker|codex exec|claude (stop|agents|logs)/],
  ['routing/quota', /route\.mjs|quota\.mjs|outcome\.mjs|report-summary|review-data|\bres (take|return|status)/],
  ['git integrate', /git\b.*\b(merge|rebase|cherry-pick|commit|push|am|apply)\b/],
  ['git read', /git\b.*\b(diff|log|show|status|blame)\b/],
  ['build/test', /xcodebuild|gradle|\bmake\b|cmake|ninja|swift (build|test)|cargo|bazel|\b(npm|pnpm|yarn)\b.*\b(test|run|build)|pytest|node --test/],
  ['device', /devicectl|idevice|\badb\b|simctl|pymobiledevice/],
  ['external CLIs', /bytedcli|lark-cli|bitscli|\bcurl\b|\bgh\b/],
  ['sleep/poll', /\bsleep\s+\d|^\s*(while|until)\b/],
  ['read/search files', /\b(cat|sed|head|tail|less|jq|grep|rg|find|ls|wc)\b/],
];
// A sleep poll is a foreground wait that holds the turn: a while/until loop that sleeps, or a sleep of a minute or more.
// Not counted: run_in_background watchers (`while kill -0 PID; do sleep 60; done`), which notify on exit — the pattern
// SKILL.md asks for — and the few seconds a dispatch command sleeps to confirm a launch (nightly review 2026-11-06: 115
// of 123 flagged calls were background watchers, and most of the rest were dispatches with `sleep 2–40`).
const isPoll = (cmd, background) => {
  if (background) return false;
  const secs = [...cmd.matchAll(/\bsleep\s+(\d+)/g)].reduce((n, m) => n + Number(m[1]), 0);
  return secs > 0 && (/\b(while|until)\b[^\n]*?;\s*do\b/.test(cmd) || secs >= 60);
};
const bucket = (cmd) => (BUCKETS.find(([, re]) => re.test(cmd)) ?? ['other shell'])[0];
const sizeOf = (c) => (typeof c === 'string' ? c.length : Array.isArray(c) ? c.reduce((n, x) => n + (x.type === 'image' ? 6000 : x.text?.length ?? JSON.stringify(x).length), 0) : JSON.stringify(c ?? '').length);
// Briefs often contain "make ..." or edit instructions; heredoc bodies are data unless a Python command executes them.
const HEREDOC = /(<<-?\s*(['"]?)([A-Za-z_]\w*)\2[^\n]*\n)([\s\S]*?)^\t*\3\r?$/gm;
const shellCommands = (cmd) => cmd.replace(HEREDOC, '$1').match(/(?:\\[\s\S]|'[^']*'|"(?:\\[\s\S]|[^"\\])*"|[^;&|()\n'"\\])+/g) ?? [];
const word = (s) => /^(['"])[\s\S]*\1$/.test(s) ? s.slice(1, -1) : s.replace(/\\(.)/g, '$1');
const shellArgs = (cmd) => (cmd.match(/(?:\d*>>?|<<-?|<)|(?:\\[\s\S]|'[^']*'|"(?:\\[\s\S]|[^"\\])*"|[^\s'"\\<>])+/g) ?? []).map(word);
// Match command positions, not mentions in `cat package.json`, `echo npm test` or worker briefs/dispatches.
const testBuildCommand = (cmd) => {
  const commands = shellCommands(cmd);
  return commands.find((c) => /^\s*(?:(?:then|do|env|command|[A-Za-z_]\w*=[^\s;&|]+)\s+)*(?:[^\s;&|()]+\/)?(?:(?:npm|pnpm|yarn)\s+(?:--(?:prefix|dir|cwd)\s+\S+\s+|-C\s+\S+\s+|--[\w-]+(?:=\S+)?\s+)*(?:run\s+(?:--[\w-]+\s+)*)?(?:test|build)\b|node\s+(?:--test\b|(?:[^\s;&|]+\/)?route-scenarios\.mjs\b)|pytest\b|python3?\s+-m\s+pytest\b|go\s+(?:test|build)\b|cargo\s+(?:test|build)\b|xcodebuild\b|gradle\b|gradlew\b|make\b|cmake\s+--build\b|swift\s+(?:build|test)\b|bazel\b|ninja\b)/.test(c)) ?? '';
};
const editPath = (file, cwd) => file ? path.resolve(cwd || os.homedir(), file.replace(/^~(?=\/|$)/, os.homedir())) : '';
const isDataPath = (file) => /\/(?:orchestrator|\.claude-data)\//.test('/' + file) || /^(?:brief|ledger)\.md$|\.ledger\.md$/.test(path.basename(file));
const tempRoots = [...new Set([path.join(os.homedir(), '.claude'), '/tmp', '/private/tmp', '/var/tmp', os.tmpdir(), os.tmpdir().replace(/^\/var\//, '/private/var/')])];
const under = (file, root) => file === root || file.startsWith(root + path.sep);
const isBookkeeping = (file, roots = tempRoots) => {
  if (isDataPath(file)) return true;
  const root = roots.filter((r) => r && under(file, r)).sort((a, b) => b.length - a.length)[0];
  if (!root) return false;
  // A temp worktree is source, not a scratch file. Stop at the temp root; an enclosing repo must not exempt it.
  for (let d = path.dirname(file); d !== root && under(d, root); d = path.dirname(d)) if (fs.existsSync(path.join(d, '.git'))) return false;
  return true;
};
const isShellOutput = (file) => /^\/dev\//.test(file) || /\.(log|out|jsonl)$/i.test(file);
const splitExpr = (expr, op) => {
  const parts = []; let depth = 0, start = 0;
  for (let i = 0; i < expr.length; i++) { if ('(['.includes(expr[i])) depth++; else if (')]'.includes(expr[i])) depth--; else if (!depth && expr[i] === op) { parts.push(expr.slice(start, i)); start = i + 1; } }
  return [...parts, expr.slice(start)];
};
const pythonWrites = (script, argv = [], vars = {}, cwd = null) => {
  // Mask literals/comments before looking for calls: printing an example of open(..., 'w') is not an edit.
  const strings = [], code = script.replace(/#[^\n]*|'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"/g, (s) => s.startsWith('#') ? ' ' : `@${strings.push(word(s)) - 1}@`);
  const target = (expr, at = code.length, depth = 0) => {
    expr = expr.trim(); if (depth > 8) return null;
    const literal = expr.match(/^r?@([0-9]+)@$/i); if (literal) return strings[Number(literal[1])];
    const concat = splitExpr(expr, '+');
    if (concat.length > 1) { const values = concat.map((x) => target(x, at, depth + 1)); return values.every((x) => x !== null) ? values.join('') : null; }
    const joined = expr.match(/^os\.path\.join\((.*)\)$/);
    if (joined) { const values = splitExpr(joined[1], ',').map((x) => target(x, at, depth + 1)); return values.every((x) => x !== null) ? path.join(...values) : null; }
    const wrapped = expr.match(/^(?:(?:pathlib\.)?Path|os\.path\.expanduser)\(\s*(.*?)\s*\)$/); if (wrapped) return target(wrapped[1], at, depth + 1);
    if (expr === 'os.getcwd()') return cwd;
    const arg = expr.match(/^sys\.argv\[(\d+)\]$/); if (arg) return argv[Number(arg[1])] ?? null;
    const env = expr.match(/^os\.environ\[@(\d+)@\]$|^os\.getenv\(@(\d+)@\)$/); if (env) return vars[strings[Number(env[1] ?? env[2])]] ?? null;
    if (!/^\w+$/.test(expr)) return null;
    const assigned = [...code.slice(0, at).matchAll(new RegExp(`\\b${expr}\\s*=\\s*([^;\\n]*)`, 'g'))].at(-1);
    return assigned ? target(assigned[1], assigned.index, depth + 1) : null;
  };
  const files = [];
  for (const m of code.matchAll(/\bopen\s*\(\s*((?:[^()\n]|\([^()]*\))*?),\s*(?:mode\s*=\s*)?@([0-9]+)@/g)) if (/^[rwax][bt+]*$/.test(strings[Number(m[2])] ?? '') && /[wax+]/.test(strings[Number(m[2])])) files.push(target(m[1], m.index));
  for (const m of code.matchAll(/(?:\b(?:pathlib\.)?Path\(\s*([^()]*?)\s*\)|\b(\w+))\s*\.(?:write_text|write_bytes)\s*\(/g)) files.push(target(m[1] ?? m[2], m.index));
  return files;
};
const shellEdits = (cmd, cwd, jobDir) => {
  const files = new Set(), docs = [...cmd.matchAll(HEREDOC)], vars = { HOME: os.homedir(), TMPDIR: os.tmpdir(), TMP: os.tmpdir(), TEMP: os.tmpdir(), CLAUDE_JOB_DIR: jobDir };
  let dir = cwd || os.homedir();
  const resolve = (s) => {
    if (!s) return null;
    s = word(s);
    for (let i = 0; i < 8 && /\$/.test(s); i++) { const next = s.replace(/\$(?:\{(\w+)\}|(\w+))/g, (m, a, b) => vars[a ?? b] ?? m); if (next === s) break; s = next; }
    return /[$`]/.test(s) || !dir && !path.isAbsolute(s) && !s.startsWith('~') ? null : editPath(s, dir);
  };
  const add = (s) => {
    if (s && (isDataPath(s) || /\.(log|out|jsonl)$/i.test(s))) return;
    // An unresolved subdirectory cannot move a literal relative path out of a known task-data directory.
    if (s && dir && !/^(?:[~/$`])/.test(s) && isDataPath(path.resolve(dir, s))) return;
    const file = resolve(s);
    const roots = [...tempRoots, resolve(vars.CLAUDE_JOB_DIR), resolve(vars.TMPDIR)];
    if (file ? !isBookkeeping(file, roots) && !isShellOutput(file) : true) files.add(file ?? cmd.slice(0, 60).replace(/\s+/g, ' '));
  };
  const python = (args) => /^python\d*(?:\.\d+)?$/.test(path.basename(args[0] ?? ''));
  for (const c of shellCommands(cmd)) {
    const args = shellArgs(c);
    while (/^(?:(?:then|do|env|command)$|[A-Za-z_]\w*=)/.test(args[0] ?? '')) {
      const m = args.shift().match(/^([A-Za-z_]\w*)=(.*)$/); if (m) vars[m[1]] = word(m[2]);
    }
    const name = path.basename(args[0] ?? '');
    if (name === 'cd') { dir = resolve(args[1] ?? '~'); continue; }
    if (['sed', 'perl'].includes(name) && args.slice(1).some((s) => /^--in-place(?:=|$)|^-[^-]*i/.test(s))) {
      const targets = []; let script = false;
      for (let i = 1; i < args.length; i++) {
        const s = args[i];
        if (/^(?:\d*>>?|<<-?|<)$/.test(s)) { i++; continue; }
        if (s === '-i' && (args[i + 1] === '' || /^\.\w+$/.test(args[i + 1] ?? ''))) { i++; continue; }
        if (s === '-e' || s === '-f' || name === 'perl' && /^-[^-]*[ef]$/.test(s)) { script = true; i++; continue; }
        if (/^-[ef].+/.test(s)) { script = true; continue; }
        if (!s.startsWith('-')) targets.push(s);
      }
      if (!script) targets.shift();
      for (const s of targets) add(s);
    }
    if (['cat', 'tee', 'printf'].includes(name)) for (let i = 1; i < args.length; i++) {
      if (/^(?:1)?>>?$/.test(args[i])) add(args[++i]);
      else if (/^(?:\d*>>?|<<-?|<)$/.test(args[i])) i++;
      else if (name === 'tee' && !args[i].startsWith('-')) add(args[i]);
    }
    const entry = args.includes('-c') ? args.indexOf('-c') + 1 : args.indexOf('-'), end = args.findIndex((s) => /^(?:\d*>>?|<<-?|<)$/.test(s));
    const argv = entry < 0 ? [] : args.slice(entry, end < 0 ? args.length : end);
    if (python(args) && args.includes('-c')) for (const s of pythonWrites(args[entry] ?? '', argv, vars, dir)) add(s);
    const here = args.findIndex((s) => /^<<-?$/.test(s)), at = here < 0 ? -1 : docs.findIndex((d) => d[3] === args[here + 1]);
    if (at >= 0) { const doc = docs.splice(at, 1)[0]; if (python(args)) for (const s of pythonWrites(doc[4], argv, vars, dir)) add(s); }
  }
  return [...files];
};
const top = (counts) => [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5);

// ---- find the orchestrators ----
const ledgerNames = new Set();
const orchDir = path.join(os.homedir(), '.claude', 'orchestrator');
for (const p of fs.existsSync(orchDir) ? fs.readdirSync(orchDir) : []) {
  try { const m = fs.readFileSync(path.join(orchDir, p, 'ledger.md'), 'utf8').match(/Orchestrator session:\s*"([^"]+)"/); if (m) ledgerNames.add(m[1]); } catch {}
}
let agents = [];
try { agents = JSON.parse(execFileSync('claude', ['agents', '--json'], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] })); } catch {}
const want = opt('session');
const orchs = agents.filter((a) => a.sessionId && (want ? a.id === want || a.name === want || a.sessionId === want : ledgerNames.has(a.name) || /主对话$/.test(a.name ?? '')));
const projects = path.join(os.homedir(), '.claude', 'projects');
const findTranscript = (sid) => { for (const d of fs.readdirSync(projects)) { const f = path.join(projects, d, `${sid}.jsonl`); if (fs.existsSync(f)) return f; } return null; };

const analyse = async (file, jobDir) => {
  const pending = new Map(), kinds = {}, big = [], blocked = [];
  const edited = new Map(), tests = new Map(), tools = new Map();
  let blockedMs = 0;
  let compactions = 0, browserCalls = 0, imageReads = 0, sleepPolls = 0, subagents = 0, edits = 0, testsBuilds = 0, toolCalls = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    const t = e.timestamp ? Date.parse(e.timestamp) : 0;
    if (!Number.isFinite(t) || t < since) continue;
    if (e.isCompactSummary || e.subtype === 'compact_boundary') compactions++;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    if (e.type === 'assistant') for (const b of content) {
      if (b.type !== 'tool_use') continue;
      const inp = b.input ?? {};
      // Count calls even without a result: a tiny/failed/unreturned step still means the orchestrator did the work.
      toolCalls++; tools.set(b.name, (tools.get(b.name) ?? 0) + 1);
      let kind = b.name, desc = '';
      if (b.name === 'Bash') {
        const c = String(inp.command ?? ''); kind = `shell: ${bucket(c)}`; desc = c.replace(/\s+/g, ' ').slice(0, 120);
        if (isPoll(c, inp.run_in_background)) sleepPolls++;
        const test = testBuildCommand(c).replace(/\s+\d?>.*$/, '').replace(/\s+/g, ' ').trim().slice(0, 120);
        if (test) { testsBuilds++; tests.set(test, (tests.get(test) ?? 0) + 1); }
        const paths = shellEdits(c, e.cwd, jobDir);
        if (paths.length) { edits++; for (const p of paths) edited.set(p, (edited.get(p) ?? 0) + 1); }
      }
      else if (['Edit', 'Write', 'NotebookEdit'].includes(b.name)) { desc = editPath(inp.file_path ?? inp.notebook_path, e.cwd); if (desc && !isBookkeeping(desc, [...tempRoots, jobDir])) { edits++; edited.set(desc, (edited.get(desc) ?? 0) + 1); } }
      else if (/claude-in-chrome|computer-use|Claude_Browser/.test(b.name)) { kind = 'browser/computer-use'; browserCalls++; desc = b.name.split('__').pop(); }
      else if (b.name === 'Read') { desc = inp.file_path ?? ''; if (/\.(png|jpe?g|gif|webp|heic)$/i.test(desc)) { kind = 'Read image'; imageReads++; } }
      else if (b.name === 'Agent' || b.name === 'Task') { kind = 'subagent'; subagents++; desc = String(inp.description ?? ''); }
      else if (/^mcp__/.test(b.name)) kind = `mcp: ${b.name.split('__')[1]}`;
      const command = String(inp.command ?? `${b.name}${desc ? ` ${desc}` : ''}`).replace(/\s+/g, ' ').slice(0, 60);
      pending.set(b.id, { kind, desc, timestamp: t, foreground: !inp.run_in_background, command });
    } else if (e.type === 'user') for (const b of content) {
      if (b.type !== 'tool_result') continue;
      const p = pending.get(b.tool_use_id); if (!p) continue;
      const kb = sizeOf(b.content) / 1024;
      (kinds[p.kind] ??= { calls: 0, kb: 0 }).calls++; kinds[p.kind].kb += kb;
      big.push({ kb, kind: p.kind, desc: p.desc });
      // Sum completed call durations, even when calls overlap; background launches don't hold the turn.
      const ms = t - p.timestamp;
      if (p.foreground && ms > 120000) { blockedMs += ms; blocked.push({ ms, command: p.command }); }
      pending.delete(b.tool_use_id);
    }
  }
  const ownKB = Object.entries(kinds).filter(([k]) => !/^(SendMessage|ListAgents|shell: dispatch|shell: routing)/.test(k)).reduce((n, [, v]) => n + v.kb, 0);
  const editedPaths = top(edited).map(([path, calls]) => ({ path, calls })), testBuildCommands = top(tests).map(([command, calls]) => ({ command, calls }));
  const minutes = (ms) => Number((ms / 60000).toFixed(2));
  const blockedMinutes = minutes(blockedMs), blockingExamples = blocked.sort((a, b) => b.ms - a.ms).slice(0, 3).map((x) => ({ minutes: minutes(x.ms), command: x.command }));
  const flags = [];
  if (ownKB > LIMITS.ownKB * scale) flags.push(`${Math.round(ownKB)} KB of its own tool output (limit ${Math.round(LIMITS.ownKB * scale)})`);
  if (browserCalls > LIMITS.browserCalls * scale) flags.push(`${browserCalls} browser/computer-use calls — route that work to a worker`);
  if (imageReads > LIMITS.imageReads * scale) flags.push(`${imageReads} screenshots read — have a worker judge them`);
  if (compactions >= LIMITS.compactions) flags.push(`${compactions} context compactions`);
  if (sleepPolls > LIMITS.sleepPolls * scale) flags.push(`${sleepPolls} sleep/poll loops — wait on notifications instead`);
  if (edits > LIMITS.edits * scale) flags.push(`edits source files itself: ${edits} calls (${editedPaths.map((x) => `${x.calls} ${x.path}`).join('; ')}) - route that work as a task through route.mjs`);
  if (testsBuilds > LIMITS.testsBuilds * scale) flags.push(`runs tests/builds itself: ${testsBuilds} calls (${testBuildCommands.map((x) => `${x.calls} ${x.command}`).join('; ')}) - route that work as a task through route.mjs`);
  if (toolCalls > LIMITS.toolCalls * scale) flags.push(`many tool calls: ${toolCalls} (${top(tools).map(([name, calls]) => `${calls} ${name}`).join('; ')}) - route that work as a task through route.mjs`);
  if (blockedMs / 60000 > LIMITS.blockedMinutes * scale) flags.push(`blocks in the foreground: ${blockedMinutes} min (${blockingExamples.map((x) => `${x.minutes} min ${x.command}`).join('; ')}) — run it in the background and dispatch other ready tasks meanwhile`);
  return { ownKB: Math.round(ownKB), compactions, browserCalls, imageReads, sleepPolls, subagents, edits, testsBuilds, toolCalls, blockedMinutes, blockingExamples, editedPaths, testBuildCommands, flags,
    kinds: Object.fromEntries(Object.entries(kinds).sort((a, b) => b[1].kb - a[1].kb).slice(0, 10).map(([k, v]) => [k, { calls: v.calls, kb: Math.round(v.kb) }])),
    largest: big.sort((a, b) => b.kb - a.kb).slice(0, 5).map((x) => `${Math.round(x.kb)} KB ${x.kind} ${x.desc}`) };
};

const results = [];
for (const a of orchs) {
  const f = findTranscript(a.sessionId);
  const jobDir = path.join(os.homedir(), '.claude', 'jobs', a.id ?? a.sessionId.slice(0, 8));
  results.push({ name: a.name, id: a.id, ...(f ? await analyse(f, jobDir) : { error: 'transcript not found' }) });
}
if (opt('json')) { console.log(JSON.stringify({ hours: H, limits: LIMITS, orchestrators: results }, null, 1)); process.exit(0); }
console.log(`orchestrator context use — last ${H}h (limits per 24h: ${JSON.stringify(LIMITS)})`);
if (!results.length) console.log('(no local orchestrator sessions found)');
for (const r of results) {
  console.log(`\n== ${r.name} [${r.id}]${r.error ? `: ${r.error}` : `: own output ${r.ownKB} KB, compactions ${r.compactions}, browser ${r.browserCalls}, screenshots ${r.imageReads}, sleep-polls ${r.sleepPolls}, subagents ${r.subagents}, edits ${r.edits}, tests/builds ${r.testsBuilds}, tool calls ${r.toolCalls}, blocked ${r.blockedMinutes} min`}`);
  if (r.error) continue;
  for (const [k, v] of Object.entries(r.kinds)) console.log(`   ${String(v.kb).padStart(6)} KB ${String(v.calls).padStart(5)}  ${k}`);
  for (const l of r.largest) console.log(`   largest: ${l}`);
  for (const x of r.editedPaths) console.log(`   edited: ${x.calls} ${x.path}`);
  for (const x of r.blockingExamples) console.log(`   blocked: ${x.minutes} min ${x.command}`);
  for (const f of r.flags) console.log(`   FLAG: ${f}`);
}
