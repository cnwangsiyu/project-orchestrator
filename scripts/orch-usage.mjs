#!/usr/bin/env node
// orch-usage: how much of its own context each local orchestrator spent doing work itself, from its transcript.
//
//   orch-usage [--hours N] [--json] [--session <id|name>]
//
// Finds the orchestrators among `claude agents --json` (names that a ledger's "Orchestrator session:" line names, or that
// end in 主对话), streams each transcript under ~/.claude/projects/, and sums the tool results that landed in its context
// over the last N hours (default 24), by kind: browser/computer-use, Read (files, screenshots), shell output by purpose,
// subagents... It flags an orchestrator that did heavy work itself. The thresholds are in LIMITS; a flag means "hand that
// kind of work to workers through route.mjs", not a hard error.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(`--${k}`); return i < 0 ? null : argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true; };
const H = Number(opt('hours') ?? 24), since = Date.now() - H * 3600000;
// Per orchestrator per 24h (scaled by --hours). Above any of these, the orchestrator is doing work a worker should do.
const LIMITS = { ownKB: 500, browserCalls: 20, imageReads: 10, compactions: 2, sleepPolls: 10 };
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

const analyse = async (file) => {
  const pending = new Map(), kinds = {}, big = [];
  let compactions = 0, browserCalls = 0, imageReads = 0, sleepPolls = 0, subagents = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    const t = e.timestamp ? Date.parse(e.timestamp) : 0;
    if (t < since) continue;
    if (e.isCompactSummary || e.subtype === 'compact_boundary') compactions++;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    if (e.type === 'assistant') for (const b of content) {
      if (b.type !== 'tool_use') continue;
      const inp = b.input ?? {};
      let kind = b.name, desc = '';
      if (b.name === 'Bash') { const c = String(inp.command ?? ''); kind = `shell: ${bucket(c)}`; desc = c.replace(/\s+/g, ' ').slice(0, 120); if (isPoll(c, inp.run_in_background)) sleepPolls++; }
      else if (/claude-in-chrome|computer-use|Claude_Browser/.test(b.name)) { kind = 'browser/computer-use'; browserCalls++; desc = b.name.split('__').pop(); }
      else if (b.name === 'Read') { desc = inp.file_path ?? ''; if (/\.(png|jpe?g|gif|webp|heic)$/i.test(desc)) { kind = 'Read image'; imageReads++; } }
      else if (b.name === 'Agent' || b.name === 'Task') { kind = 'subagent'; subagents++; desc = String(inp.description ?? ''); }
      else if (/^mcp__/.test(b.name)) kind = `mcp: ${b.name.split('__')[1]}`;
      pending.set(b.id, { kind, desc });
    } else if (e.type === 'user') for (const b of content) {
      if (b.type !== 'tool_result') continue;
      const p = pending.get(b.tool_use_id); if (!p) continue;
      const kb = sizeOf(b.content) / 1024;
      (kinds[p.kind] ??= { calls: 0, kb: 0 }).calls++; kinds[p.kind].kb += kb;
      big.push({ kb, kind: p.kind, desc: p.desc });
      pending.delete(b.tool_use_id);
    }
  }
  const ownKB = Object.entries(kinds).filter(([k]) => !/^(SendMessage|ListAgents|shell: dispatch|shell: routing)/.test(k)).reduce((n, [, v]) => n + v.kb, 0);
  const flags = [];
  if (ownKB > LIMITS.ownKB * scale) flags.push(`${Math.round(ownKB)} KB of its own tool output (limit ${Math.round(LIMITS.ownKB * scale)})`);
  if (browserCalls > LIMITS.browserCalls * scale) flags.push(`${browserCalls} browser/computer-use calls — route that work to a worker`);
  if (imageReads > LIMITS.imageReads * scale) flags.push(`${imageReads} screenshots read — have a worker judge them`);
  if (compactions >= LIMITS.compactions) flags.push(`${compactions} context compactions`);
  if (sleepPolls > LIMITS.sleepPolls * scale) flags.push(`${sleepPolls} sleep/poll loops — wait on notifications instead`);
  return { ownKB: Math.round(ownKB), compactions, browserCalls, imageReads, sleepPolls, subagents, flags,
    kinds: Object.fromEntries(Object.entries(kinds).sort((a, b) => b[1].kb - a[1].kb).slice(0, 10).map(([k, v]) => [k, { calls: v.calls, kb: Math.round(v.kb) }])),
    largest: big.sort((a, b) => b.kb - a.kb).slice(0, 5).map((x) => `${Math.round(x.kb)} KB ${x.kind} ${x.desc}`) };
};

const results = [];
for (const a of orchs) {
  const f = findTranscript(a.sessionId);
  results.push({ name: a.name, id: a.id, ...(f ? await analyse(f) : { error: 'transcript not found' }) });
}
if (opt('json')) { console.log(JSON.stringify({ hours: H, limits: LIMITS, orchestrators: results }, null, 1)); process.exit(0); }
console.log(`orchestrator context use — last ${H}h (limits per 24h: ${JSON.stringify(LIMITS)})`);
if (!results.length) console.log('(no local orchestrator sessions found)');
for (const r of results) {
  console.log(`\n== ${r.name} [${r.id}]${r.error ? `: ${r.error}` : `: own output ${r.ownKB} KB, compactions ${r.compactions}, browser ${r.browserCalls}, screenshots ${r.imageReads}, sleep-polls ${r.sleepPolls}, subagents ${r.subagents}`}`);
  if (r.error) continue;
  for (const [k, v] of Object.entries(r.kinds)) console.log(`   ${String(v.kb).padStart(6)} KB ${String(v.calls).padStart(5)}  ${k}`);
  for (const l of r.largest) console.log(`   largest: ${l}`);
  for (const f of r.flags) console.log(`   FLAG: ${f}`);
}
