#!/usr/bin/env node
// Record a user's scoped personal-quota approval for one routed task (BC-86).
//   approval.mjs add --account <id> --ref <user decision ref> --until <ISO time> [--note "..."] -- <route.mjs args>
//   approval.mjs list [--all]
//   approval.mjs revoke <id>
// `add` runs route.mjs with the given args, takes the personal-quota gate scope for that account
// from the plan, and appends an approval entry that expires at --until. It prints the id to pass
// back to route.mjs as --user-ok. Only record approvals the user actually gave (verbatim ref).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withLock } from './lib/shared-file.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const shared = process.env.RULES_SHARED || path.join(os.homedir(), '.claude/orchestrator/_shared');
const file = process.env.ROUTE_APPROVAL_FILE || path.join(shared, 'route-approvals.json');
const die = (msg, code = 2) => { process.stderr.write(`approval: ${msg}\n`); process.exit(code); };
const read = () => { try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(v) ? v : []; } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };
const write = (rows) => { const tmp = `${file}.${process.pid}`; fs.writeFileSync(tmp, JSON.stringify(rows, null, 1)); fs.renameSync(tmp, file); };
const idSafe = (s) => String(s).replace(/[^a-zA-Z0-9_.:@/-]+/g, '-').replace(/\.\.+/g, '.').replace(/^[^a-zA-Z0-9]+|-+$/g, '').slice(0, 120);

const argv = process.argv.slice(2);
const cmd = argv[0];
if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log('usage: approval.mjs add --account <id> --ref <user decision ref> --until <ISO> [--note "..."] -- <route.mjs args>\n       approval.mjs list [--all]\n       approval.mjs revoke <id>');
  process.exit(cmd ? 0 : 2);
}
if (cmd === 'list') {
  const now = Date.now(), all = argv.includes('--all');
  for (const a of read()) {
    const live = !a.revoked && a.grantedAt <= now && now < a.expiresAt;
    if (!all && !live) continue;
    const scope = a.scopes?.[0] ?? {};
    console.log(`${live ? 'LIVE' : a.revoked ? 'REVOKED' : 'EXPIRED'}\t${a.id}\t${(scope.accounts ?? []).join(',')}\t${scope.taskId ?? '?'}\tuntil ${new Date(a.expiresAt).toISOString()}`);
  }
  process.exit(0);
}
if (cmd === 'revoke') {
  const id = argv[1]; if (!id) die('revoke needs an id');
  let hit = false;
  withLock(file, () => { const rows = read(); for (const a of rows) if (a.id === id) { a.revoked = true; hit = true; } write(rows); });
  if (!hit) die(`no approval ${id}`, 1);
  console.log(`revoked ${id}`); process.exit(0);
}
if (cmd !== 'add') die(`unknown command ${cmd}`);
const sep = argv.indexOf('--');
if (sep < 0) die('add needs -- <route.mjs args> after its own flags');
const own = argv.slice(1, sep), routeArgs = argv.slice(sep + 1);
const opt = (k) => { const i = own.indexOf(`--${k}`); return i >= 0 ? own[i + 1] : undefined; };
const account = opt('account'), ref = opt('ref'), until = Date.parse(opt('until') ?? '');
if (!account || !ref || !Number.isFinite(until)) die('add needs --account, --ref and --until <ISO time>');
if (until <= Date.now()) die('--until is in the past');
const r = spawnSync(process.execPath, [path.join(here, 'route.mjs'), ...routeArgs.filter((a) => a !== '--json'), '--json'], { encoding: 'utf8', maxBuffer: 32 * 2 ** 20 });
let plan; try { plan = JSON.parse(r.stdout).plan; } catch { die(`route.mjs did not return a plan: ${(r.stderr || r.stdout).slice(0, 400)}`, 1); }
const gates = (plan?.gates ?? []).filter((g) => g.kind === 'personal-quota' && g.scope?.accounts?.includes(account));
if (!gates.length) {
  const asked = (plan?.gates ?? []).map((g) => g.scope?.accounts?.join(',')).filter(Boolean);
  die(asked.length ? `the route asks for ${asked.join(' / ')}, not ${account}; add --exclude-account for the others to the route args`
    : `the route needs no personal-quota approval for ${account} (it may already run on company quota)`, 1);
}
// allowPersonalWithCompany: the user chose this personal account explicitly; without it the gate
// still blocks whenever company lane status is UNKNOWN or stale.
const scopes = gates.map((g) => ({ ...g.scope, allowPersonalWithCompany: true }));
const taskId = scopes[0].taskId, id = idSafe(`user-${account}-${taskId}-${new Date(until).toISOString().slice(0, 13)}`);
withLock(file, () => {
  const rows = read().filter((a) => a.id !== id);
  rows.push({ id, userDecisionRef: idSafe(ref), grantedAt: Date.now(), expiresAt: until, revoked: false, consumed: false,
    note: opt('note') ?? null, scopes });
  write(rows);
});
console.log(id);
console.error(`approval: recorded ${id} (${account}, task ${taskId}, until ${new Date(until).toISOString()}); route again with --user-ok ${id}`);
