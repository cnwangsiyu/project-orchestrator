#!/usr/bin/env node
// Regression tests for route.mjs + lib/state.mjs against synthetic quota states. Run after any routing change:
//   node scripts/test/route-scenarios.mjs        (exit 0 = all pass)
// Each case fixes the quota state and the route flags and states the decision the policy must produce. When a policy
// change is intended, update the expectations here in the same commit and say why in the commit message.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROUTE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'route.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'route-test-'));
const now = Date.now(), h = 3600000, W = 10080;
const wk = (used, leftH, label = 'week') => ({ label, used, resetsAt: now + leftH * h, windowMins: W, scoped: false });
const cl = (used, leftH, fable = 0) => [wk(used, leftH, 'week (all models)'), { ...wk(fable, leftH, 'week (Fable)'), scoped: true }];
const acc = (name, used, leftH, cards = [], extra = {}) => ({ name, live: true, email: `${name}@example.com`, home: `/tmp/${name}`, plan: 'prolite', seenAt: now,
  windows: [wk(used, leftH)], resets: { count: cards.length, credits: cards.map((e, i) => ({ id: `RateLimitResetCredit_${name}card${i}`, expiresAt: now + e * h })) }, ...extra });
const five = (used, leftH) => ({ label: '5h', used, resetsAt: now + leftH * h, windowMins: 300, scoped: false });

const S = {
  fresh: { claude: cl(2, 166), codex: [acc('main', 2, 166, [76, 650])] },
  quiet: { claude: cl(30, 80), codex: [acc('main', 55, 80)] }, // on pace everywhere, no cards
  claudeOver: { claude: cl(60, 72), codex: [acc('main', 30, 72)] },
  claudeNearReset: { claude: cl(85, 2), codex: [acc('main', 50, 80)] }, // 85% with 2h left and a slow burn: spare
  codexOut: { claude: cl(30, 48), codex: [acc('main', 99, 48)] },
  codexOutClaudeOver: { claude: cl(85, 48), codex: [acc('main', 99, 48)] },
  twoAccounts: { claude: cl(10, 120), codex: [acc('main', 99, 120, [400]), acc('b', 40, 20)] },
  bothSpent: { claude: cl(10, 120), codex: [acc('main', 99, 120, [400]), acc('b', 99, 20)] },
  expiringCard: { claude: cl(10, 120), codex: [acc('main', 60, 120, [0.5])] },
  cardDeadline: { claude: cl(10, 120), codex: [acc('main', 40, 120, [30]), acc('b', 10, 20)] },
  claude5h: { claude: [...cl(10, 120), { ...five(97, 3), label: 'session' }], codex: [acc('main', 20, 120)] },
  codex5h: { claude: cl(70, 120), codex: [{ ...acc('main', 40, 120), windows: [wk(40, 120), five(99, 2)] }] },
  stale: { claude: cl(10, 120), codex: [{ ...acc('main', 20, 120), live: false, seenAt: now - 5 * h, error: 'hub down' }, acc('b', 50, 100)] },
  unreadable: { claude: null, codex: [] },
};
// [scenario, route args, expectation]; expectation: 'DEFER' or "vendor model effort [@account]"
const CASES = [
  ['fresh', ['implement', '--auto-check'], 'codex gpt-6.1-sol high @main'], // −1 auto-check, +1 front-load
  ['fresh', ['docs'], 'claude sonnet medium'],
  ['fresh', ['computer-use'], 'claude sonnet medium'],
  ['fresh', ['ui-browser'], 'claude sonnet high'],
  ['fresh', ['image-gen'], 'codex gpt-6-luna low @main'],
  ['fresh', ['image-gen', '--failures', '1'], 'codex gpt-6.1-sol medium @main'],
  ['fresh', ['lookup'], 'codex gpt-6-luna low @main'],
  ['fresh', ['debug', '--failures', '3'], 'claude fable high'],
  ['fresh', ['second-opinion', '--against', 'codex'], 'claude opus high'],
  ['fresh', ['second-opinion', '--against', 'claude'], 'codex gpt-6.1-sol xhigh @main'],
  ['quiet', ['implement'], 'codex gpt-6.1-sol high @main'],
  ['quiet', ['implement', '--stakes', 'high'], 'codex gpt-6.1-sol xhigh @main'],
  ['quiet', ['design'], 'claude opus high'],
  ['claudeOver', ['docs'], 'codex gpt-6.1-sol high @main'],
  ['claudeOver', ['design'], 'codex gpt-6.1-sol xhigh @main'],
  ['claudeOver', ['computer-use'], 'claude sonnet medium'],
  ['claudeOver', ['lookup', '--failures', '1'], 'codex gpt-6.1-sol medium @main'], // the Codex step (cheap rows get no quota notch)
  ['quiet', ['lookup', '--failures', '2'], 'claude sonnet medium'],
  ['claudeOver', ['debug', '--failures', '1'], 'codex gpt-6.1-sol max @main'],
  ['claudeOver', ['debug', '--failures', '2'], 'codex gpt-6-astra xhigh @main'],
  ['claudeNearReset', ['docs'], 'claude sonnet medium'], // spare near the reset (only 8% room: no expiring notch)
  ['codexOut', ['implement'], 'claude sonnet medium'],
  ['codexOut', ['lookup', '--stakes', 'low'], 'DEFER'],
  ['codexOutClaudeOver', ['implement'], 'DEFER'],
  ['codexOutClaudeOver', ['image-gen'], 'DEFER'],
  ['twoAccounts', ['implement'], 'codex gpt-6.1-sol xhigh @b'],
  ['bothSpent', ['implement'], 'codex gpt-6.1-sol xhigh @main'], // after redeeming main's card
  ['bothSpent', ['implement', '--no-redeem'], 'claude sonnet medium'],
  ['expiringCard', ['review'], 'codex gpt-6.1-sol xhigh @main'],
  ['claude5h', ['computer-use'], 'DEFER'],
  ['codex5h', ['image-gen'], 'DEFER'],
  ['codex5h', ['implement'], 'DEFER'],
  ['stale', ['analysis'], 'codex gpt-6.1-sol medium @b'],
  ['unreadable', ['implement'], 'DEFER'],
  // A retry a quota notch made identical to the failed attempt is flagged, not passed off as an escalation (nightly
  // review 2026-11-04: video-agent W228c, implement --failures 2, ran the same Sol xhigh as every first pick).
  ['claudeOver', ['implement', '--failures', '1'], 'codex gpt-6.1-sol xhigh @main', 'not stronger'],
  ['claudeOver', ['implement', '--failures', '2'], 'codex gpt-6.1-sol xhigh @main', 'not stronger'],
  ['quiet', ['implement', '--failures', '1'], 'codex gpt-6.1-sol xhigh @main', '!not stronger'],
];
const ERRORS = [['fresh', ['implement', '--failures', '-1']], ['fresh', ['implement', '--stakes', 'hgih']], ['fresh', ['second-opinion']], ['fresh', ['nope']]];

let fail = 0;
const run = (sc, args) => {
  const cache = path.join(tmp, 'q.json');
  fs.writeFileSync(cache, JSON.stringify({ checkedAt: now, claude: S[sc].claude, codexAccounts: S[sc].codex, errors: {}, history: {} }));
  const env = { ...process.env, QUOTA_CACHE: cache, CODEX_ACCOUNTS: path.join(tmp, 'none.json'), ROUTE_LOG: '0', QUOTA_LOG: '0', ROUTE_RR: path.join(tmp, 'rr.txt') };
  return execFileSync(process.execPath, [ROUTE, ...args, '--json'], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
};
// Optional 4th field: a substring the notes must contain ('!text': must not contain).
for (const [sc, args, want, note] of CASES) {
  try { fs.rmSync(path.join(tmp, 'rr.txt'), { force: true }); } catch {}
  let got;
  try {
    const o = JSON.parse(run(sc, args));
    got = o.deferred ? 'DEFER' : `${o.pick.vendor} ${o.pick.model} ${o.pick.effort}${o.pick.account ? ` @${o.pick.account}` : ''}`;
    if (note) {
      const has = (o.notes || []).some((x) => x.includes(note.replace(/^!/, '')));
      if (has === note.startsWith('!')) got += ` (notes ${note.startsWith('!') ? 'contain' : 'lack'} "${note.replace(/^!/, '')}")`;
    }
  } catch (e) { got = `ERROR ${String(e.stderr || e.message).split('\n')[0]}`; }
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${sc.padEnd(19)} ${args.join(' ').padEnd(36)} ${ok ? got : `want "${want}", got "${got}"`}`);
}
// Rotation: two accounts with deadlines inside 48h alternate across launches.
{
  try { fs.rmSync(path.join(tmp, 'rr.txt'), { force: true }); } catch {}
  const a = JSON.parse(run('cardDeadline', ['implement'])).pick.account, b = JSON.parse(run('cardDeadline', ['implement'])).pick.account;
  const ok = a !== b && [a, b].sort().join() === 'b,main';
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} cardDeadline        rotation                             ${a} then ${b}`);
}
for (const [sc, args] of ERRORS) {
  let ok = false;
  try { run(sc, args); } catch (e) { ok = e.status === 2; }
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${sc.padEnd(19)} ${args.join(' ').padEnd(36)} rejected`);
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
