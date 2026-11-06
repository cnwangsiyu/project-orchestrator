#!/usr/bin/env node
// outcome: record how a routed task ended, so the nightly review can compare vendors, models and categories on data.
//
//   outcome --project SLUG --name NAME --result pass|rework|fail [--rounds N] [--minutes M] [--reviewed] [--note "..."]
//
// Call it once per task when it is finally accepted or given up (not per round):
//   pass   — accepted at its first check with no fix round (a review verdict of MERGE or MERGE-WITH-NOTES is a pass;
//            P2 notes are not rework)
//   rework — accepted after N fix rounds (--rounds N, counting every vendor's rounds)
//   fail   — abandoned, or the ladder was exhausted without an accepted result
// --reviewed marks that an independent review (not just your own look) judged it. --minutes is the wall-clock time from
// the first launch to acceptance. The record joins the task's routing decisions in route-log.jsonl by project + name,
// so it carries the vendor, model, effort and category of the first attempt and of the attempt that was accepted.
import fs from 'node:fs';
import { ROUTE_LOG } from './lib/state.mjs';

const argv = process.argv.slice(2), opts = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) {
  const k = argv[i].slice(2);
  opts[k] = k === 'reviewed' || argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[++i];
}
const die = (m) => { console.error(`outcome: ${m}`); process.exit(2); };
if (typeof opts.project !== 'string' || typeof opts.name !== 'string') die('needs --project and --name (the same ones passed to route.mjs)');
if (!['pass', 'rework', 'fail'].includes(opts.result)) die('--result takes pass, rework or fail');
const rounds = opts.rounds === undefined ? (opts.result === 'pass' ? 0 : null) : Number(opts.rounds);
if (rounds !== null && (!Number.isInteger(rounds) || rounds < 0)) die('--rounds takes a whole number ≥ 0');
if (opts.result === 'rework' && !rounds) die('rework needs --rounds N (N ≥ 1)');
// A fix round means the first attempt was not accepted: `pass --rounds N` (N ≥ 1) is rework (nightly review 2026-11-06:
// 10 of 22 records said pass with 1–7 rounds, which showed a 100% first-pass rate).
if (opts.result === 'pass' && rounds) { console.error(`outcome: ${rounds} fix round(s) is rework, not pass — recording rework`); opts.result = 'rework'; }
const minutes = opts.minutes === undefined ? null : Number(opts.minutes);
if (minutes !== null && !(minutes >= 0)) die('--minutes takes a number ≥ 0');

let routes = [];
try { routes = fs.readFileSync(ROUTE_LOG, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch {}
// The task's own decisions: same project and name, or a fix-round name derived from it (NAME-fix…, NAME-r2, NAME-R…).
// Reviews of the task (NAME-R, review / second-opinion rows) are checks, not attempts, so they don't count as the pick.
const mine = routes.filter((r) => r.kind !== 'outcome' && r.project === opts.project && r.name && (r.name === opts.name || r.name.startsWith(`${opts.name}-`)) && r.pick
  && !['review', 'review-high', 'second-opinion'].includes(r.category) && !/-R\d*$/.test(r.name));
const first = mine[0]?.pick ?? null, last = mine.at(-1)?.pick ?? null;
const rec = {
  t: Date.now(), kind: 'outcome', project: opts.project, name: opts.name, result: opts.result, rounds, minutes,
  reviewed: !!opts.reviewed, note: typeof opts.note === 'string' ? opts.note : null,
  category: mine[0]?.category ?? null, impact: mine[0]?.impact ?? null, first, accepted: opts.result === 'fail' ? null : last, decisions: mine.length,
};
fs.appendFileSync(ROUTE_LOG, JSON.stringify(rec) + '\n');
console.log(`recorded ${opts.project}/${opts.name}: ${opts.result}${rounds ? ` after ${rounds} round(s)` : ''}`
  + (first ? ` — first ${first.vendor} ${first.model} ${first.effort}${last && last !== first ? `, accepted on ${last.vendor} ${last.model} ${last.effort}` : ''}` : ' — no routing decision found for this name (pass the same --project/--name as route.mjs)'));
