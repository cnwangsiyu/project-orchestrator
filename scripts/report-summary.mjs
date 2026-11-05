#!/usr/bin/env node
// report-summary: what the orchestrator reads of a worker's report — the summary only, capped.
//
//   report-summary <task dir | report.md> [--max BYTES]   (default 3000)
//
// Prints the report's "## Summary" section (the brief asks every worker to open its report with one, ≤20 lines), and
// the first line of a Codex worker's final message (codex-last.md) if there is one. Without a Summary section it
// prints the report's first lines and says the summary is missing. Ask the worker for anything else rather than
// reading the full report into the orchestrator's context.
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const mi = argv.indexOf('--max');
const max = mi >= 0 ? Number(argv[mi + 1]) : 3000;
const target = argv.find((a, i) => !a.startsWith('--') && !(mi >= 0 && i === mi + 1));
if (!target) { console.error('usage: report-summary <task dir | report.md> [--max BYTES]'); process.exit(2); }
const dir = fs.existsSync(target) && fs.statSync(target).isDirectory() ? target : path.dirname(target);
const report = fs.existsSync(target) && fs.statSync(target).isFile() ? target : path.join(dir, 'report.md');
const cap = (s) => (Buffer.byteLength(s) > max ? `${Buffer.from(s).subarray(0, max).toString()}\n… [cut at ${max} bytes — ask the worker instead of reading on]` : s);

const out = [];
const last = path.join(dir, 'codex-last.md');
if (fs.existsSync(last)) out.push(`final: ${(fs.readFileSync(last, 'utf8').split('\n').find((l) => l.trim()) ?? '').slice(0, 300)}`);
if (!fs.existsSync(report)) out.push(`(no report at ${report})`);
else {
  const text = fs.readFileSync(report, 'utf8');
  const m = text.match(/^#{1,3}\s*(Summary|摘要|Summary for (the )?orchestrator)\b.*$([\s\S]*?)(?=^#{1,3}\s|\Z)/im);
  if (m) out.push(m[0].trim());
  else out.push(`(no "## Summary" section — first lines; ask the worker to add one)\n${text.split('\n').slice(0, 15).join('\n')}`);
}
console.log(cap(out.join('\n\n')));
