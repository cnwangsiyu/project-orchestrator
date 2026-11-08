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
const tt = (extra = {}) => ({ name: 'ttadk', kind: 'ttadk', home: '/tmp/ttadk', hub: 'ws://127.0.0.1:47399', healthy: true, reason: null, live: true, active: 2,
  models: ['gpt-6.1-sol', 'gpt-5.6-terra', 'gpt-5.5'], browser: true, chromePlugin: '/tmp/chrome-plugin', ssoExpiresAt: now + 240 * h, windows: [], resets: null, ...extra });
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
  // TTADK (company gateway) account: no rate-limit windows; healthy = ttadk CLI + SSO + gpt-6.1-sol listed.
  ttFresh: { claude: cl(10, 120), codex: [acc('main', 20, 120), tt()] },
  ttNoBrowser: { claude: cl(10, 120), codex: [acc('main', 20, 120), tt({ browser: false })] },
  ttUnhealthy: { claude: cl(10, 120), codex: [acc('main', 20, 120), tt({ healthy: false, reason: 'TTADK SSO not logged in or expired' })] },
  ttChatOut: { claude: cl(10, 48), codex: [acc('main', 99, 48), tt()] },
  // From the 2026-11-07 review: a hub never read; a spent account with a card next to TTADK; an excluded pick next to
  // a spent account with an urgent card; two accounts that must both be spent soon.
  unreadHub: { claude: cl(10, 120), codex: [{ name: 'main', live: false, email: 'm@example.com', home: '/tmp/main', seenAt: null, windows: null, resets: null }] },
  ttCard: { claude: cl(10, 120), codex: [acc('main', 99, 100, [400]), tt()] },
  ttClaudeOver: { claude: cl(93, 30), codex: [acc('main', 20, 120), tt()] },
  ttKimi: { claude: cl(10, 120), codex: [acc('main', 20, 120), tt({ models: ['gpt-6.1-sol', 'gpt-5.6-terra', 'kimi-k3'] })] },
  // TTADK with its web search hub + proxy set up (ttadk-setup).
  ttSearch: { claude: cl(10, 120), codex: [acc('main', 20, 120), tt({ search: true, searchLive: true })] },
  pickExcluded: { claude: cl(10, 120), codex: [acc('main', 50, 100), acc('b', 99, 100, [10])] },
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
  // Review policy by impact (user, 2026-11-04).
  ['quiet', ['implement', '--impact', 'release'], 'codex gpt-6.1-sol high @main', 'route.mjs review --'],
  ['quiet', ['implement', '--impact', 'release', '--stakes', 'high'], 'codex gpt-6.1-sol xhigh @main', 'route.mjs review-high'],
  ['quiet', ['implement', '--impact', 'service'], 'codex gpt-6.1-sol high @main', 'no review'],
  ['quiet', ['implement', '--impact', 'service', '--stakes', 'high'], 'codex gpt-6.1-sol xhigh @main', 'route.mjs review-high'],
  ['quiet', ['debug', '--impact', 'throwaway', '--stakes', 'high'], 'codex gpt-6.1-sol xhigh @main', 'no review'],
  ['quiet', ['docs'], 'claude sonnet medium', '!review'],
  // TTADK preferred when healthy (user, 2026-11-07); no quota notches on it; fallback via --exclude-account or ill health.
  ['ttFresh', ['implement'], 'codex gpt-6.1-sol high @ttadk', 'retry it once'],
  ['ttFresh', ['lookup'], 'codex gpt-6.1-sol medium @ttadk'],
  // Everything TTADK Sol can handle goes there first (user, 2026-11-07), Claude-strength rows included.
  ['ttFresh', ['docs'], 'codex gpt-6.1-sol high @ttadk'], // judgment rows start at high on TTADK (free)
  ['ttFresh', ['design'], 'codex gpt-6.1-sol xhigh @ttadk'], // the higher of Opus high and its Sol alternative (xhigh)
  ['ttFresh', ['review-high'], 'codex gpt-6.1-sol xhigh @ttadk'],
  ['ttFresh', ['implement', '--failures', '1'], 'codex gpt-6.1-sol xhigh @ttadk'],
  // Not TTADK-capable: images, Claude-only rows, a second opinion on Codex's work.
  ['ttFresh', ['image-gen'], 'codex gpt-6-luna low @main'],
  // Image generation never lands on TTADK, its Sol fallback step included (no image tool on the gateway).
  ['ttFresh', ['image-gen', '--failures', '1'], 'codex gpt-6.1-sol medium @main'],
  ['ttChatOut', ['image-gen', '--failures', '1'], 'DEFER'],
  // Rows starting at xhigh have no Sol notch short of max: they follow their own vendor-alternating ladder.
  ['ttFresh', ['implement-hard', '--impact', 'service'], 'codex gpt-6.1-sol xhigh @ttadk'],
  // Free Sol max (no OK on TTADK) before personal Claude.
  ['ttFresh', ['implement-hard', '--impact', 'service', '--failures', '1'], 'codex gpt-6.1-sol max @ttadk'],
  ['ttFresh', ['implement-hard', '--impact', 'service', '--failures', '2'], 'claude opus xhigh'],
  // Desktop apps go to TTADK when browser-setup is done (it enables computer use); Claude-only tools stay on Claude.
  ['ttFresh', ['computer-use', '--apps', 'com.apple.calculator'], 'codex gpt-6.1-sol medium @ttadk', 'Computer Use via node_repl'],
  ['ttFresh', ['computer-use'], 'codex gpt-6.1-sol medium @ttadk', 'pass them to route.mjs with --apps'],
  ['ttNoBrowser', ['computer-use'], 'claude sonnet medium', 'no desktop computer-use tool'],
  ['ttFresh', ['claude-tools'], 'claude sonnet medium'],
  ['fresh', ['claude-tools'], 'claude sonnet medium'],
  ['ttFresh', ['second-opinion', '--against', 'codex'], 'claude opus high'],
  // A TTADK device leaves ChatGPT/Claude quota for the user's other device: no underused effort raise (user, 2026-11-07).
  ['ttFresh', ['implement', '--exclude-account', 'ttadk'], 'codex gpt-6.1-sol high @main'],
  // TTADK down for a fixable reason: normal work waits (tell the user); high stakes or --urgent run on personal quota.
  ['ttUnhealthy', ['implement'], 'DEFER'],
  ['ttUnhealthy', ['implement', '--urgent'], 'codex gpt-6.1-sol high @main'],
  ['ttUnhealthy', ['implement', '--stakes', 'high'], 'codex gpt-6.1-sol xhigh @main'],
  ['ttUnhealthy', ['image-gen'], 'codex gpt-6-luna low @main'],
  ['ttUnhealthy', ['computer-use'], 'claude sonnet medium'],
  ['ttChatOut', ['lookup'], 'codex gpt-6.1-sol medium @ttadk'],
  ['ttChatOut', ['image-gen'], 'DEFER'],
  // Browser work: TTADK Codex when it is browser-ready, else Claude.
  ['ttFresh', ['browser'], 'codex gpt-6.1-sol medium @ttadk', 'Chrome must be running'],
  ['ttFresh', ['browser', '--failures', '2'], 'codex gpt-6.1-sol xhigh @ttadk'],
  ['ttFresh', ['browser', '--failures', '3'], 'claude sonnet medium'],
  ['ttNoBrowser', ['browser'], 'claude sonnet medium', 'never switch to another connected browser'],
  ['fresh', ['browser'], 'claude sonnet medium'],
  ['ttFresh', ['browser', '--exclude-account', 'ttadk'], 'claude sonnet medium'],
  // ui-browser: TTADK when browser-ready (localhost reachable), else Claude Sonnet high as before.
  ['ttFresh', ['ui-browser'], 'codex gpt-6.1-sol high @ttadk', 'Chrome must be running'],
  ['ttNoBrowser', ['ui-browser'], 'claude sonnet high'],
  ['ttFresh', ['ui-browser', '--exclude-account', 'ttadk'], 'claude sonnet high'],
  // Never-read hub: route as if Codex has room (as before TTADK existed).
  ['unreadHub', ['implement', '--impact', 'service'], 'codex gpt-6.1-sol high @main', 'routing as if it has room'],
  ['unreadHub', ['image-gen'], 'codex gpt-6-luna low @main'],
  // Low-stakes browser work on the Claude path doesn't wait for Codex.
  ['codexOut', ['browser', '--stakes', 'low'], 'claude sonnet low'],
  // research needs web search: on TTADK only with its search hub set up, else the earlier routing. image-read works there.
  ['ttFresh', ['research'], 'claude sonnet medium'],
  ['ttSearch', ['research'], 'codex gpt-6.1-sol high @ttadk', 'local proxy'],
  ['ttSearch', ['docs'], 'codex gpt-6.1-sol high @ttadk', 'never put internal code'],
  ['fresh', ['implement', '--impact', 'service'], 'codex gpt-6.1-sol xhigh @main', 'never put internal code'],
  ['ttSearch', ['research'], 'codex gpt-6.1-sol high @ttadk', 'never put internal code'],
  ['ttSearch', ['research', '--exclude-account', 'ttadk'], 'claude sonnet medium'],
  // Without the proxy, research's Codex fallback step stays on a ChatGPT account, never TTADK (no search there).
  ['ttClaudeOver', ['research'], 'codex gpt-6.1-sol medium @main'],
  ['ttFresh', ['image-read'], 'codex gpt-6.1-sol high @ttadk', 'no web search'],
  // TTADK ladders never step back to a weaker Codex model or effort.
  ['ttFresh', ['lookup', '--failures', '2'], 'codex gpt-6.1-sol xhigh @ttadk'], // cheap rows climb to xhigh, not max
  ['ttFresh', ['lookup', '--failures', '3'], 'claude sonnet medium'],
  ['ttChatOut', ['debug', '--impact', 'service', '--failures', '1'], 'codex gpt-6.1-sol max @ttadk'],
  ['ttChatOut', ['debug', '--impact', 'service', '--failures', '2'], 'claude opus xhigh'],
  ['ttChatOut', ['debug', '--impact', 'service', '--failures', '3'], 'claude fable high'],
  // Astra (ChatGPT) after free Sol max; with ChatGPT out the science ladder no longer dead-ends after one failure.
  ['ttFresh', ['science', '--impact', 'service', '--failures', '1'], 'codex gpt-6.1-sol max @ttadk'],
  ['ttFresh', ['science', '--impact', 'service', '--failures', '2'], 'codex gpt-6-astra high @main'],
  ['ttChatOut', ['science', '--impact', 'service', '--failures', '1'], 'codex gpt-6.1-sol max @ttadk'],
  // No cost notches on TTADK; high stakes starts a notch up without repeating it.
  ['ttFresh', ['debug', '--impact', 'service', '--auto-check'], 'codex gpt-6.1-sol xhigh @ttadk'],
  ['ttFresh', ['debug', '--impact', 'service', '--auto-check', '--failures', '1'], 'codex gpt-6.1-sol max @ttadk'],
  ['ttFresh', ['implement', '--impact', 'service', '--stakes', 'high'], 'codex gpt-6.1-sol xhigh @ttadk'],
  ['ttFresh', ['implement', '--impact', 'service', '--stakes', 'high', '--failures', '1'], 'codex gpt-6.1-sol max @ttadk'],
  ['ttFresh', ['lookup', '--stakes', 'low'], 'codex gpt-6.1-sol medium @ttadk'],
  // A Codex-written change is reviewed by Claude first.
  ['ttFresh', ['review', '--author', 'codex'], 'codex gpt-6.1-sol xhigh @ttadk', 'second TTADK reviewer'],
  ['ttKimi', ['review', '--author', 'codex'], 'codex gpt-6.1-sol xhigh @ttadk', 'Kimi-K3, a different model family'],
  ['ttFresh', ['review-high', '--author', 'codex'], 'claude opus xhigh'],
  ['fresh', ['review', '--author', 'codex'], 'claude sonnet high'],
  // Claude has no room: a fresh TTADK reviewer stands in instead of deferring or dropping the second opinion.
  ['ttClaudeOver', ['second-opinion', '--against', 'codex'], 'codex gpt-6.1-sol xhigh @ttadk'],
  ['ttClaudeOver', ['design'], 'codex gpt-6.1-sol xhigh @ttadk', 'stands in'],
  ['ttFresh', ['review', '--author', 'claude'], 'codex gpt-6.1-sol high @ttadk'],
  ['ttFresh', ['browser'], 'codex gpt-6.1-sol medium @ttadk', 'safety clause'],
  // Browser workers get the Chrome pairing clause; code work doesn't (nightly review 2026-11-05: video-agent W258).
  ['claudeOver', ['computer-use'], 'claude sonnet medium', 'select_browser'],
  ['fresh', ['ui-browser'], 'claude sonnet high', 'select_browser'],
  ['fresh', ['implement', '--auto-check'], 'codex gpt-6.1-sol high @main', '!select_browser'],
];
const ERRORS = [['fresh', ['implement', '__noimpact']], ['fresh', ['implement', '--impact', 'prod']], ['fresh', ['implement', '--failures', '-1']], ['fresh', ['implement', '--stakes', 'hgih']], ['fresh', ['second-opinion']], ['fresh', ['nope']]];

let fail = 0;
const CODE = ['implement', 'implement-hard', 'debug', 'science'];
const run = (sc, args0) => {
  // Code categories need --impact; default it to service unless the case says otherwise ('__noimpact' tests the error).
  let args = args0.filter((a) => a !== '__noimpact');
  if (CODE.includes(args[0]) && !args.includes('--impact') && !args0.includes('__noimpact')) args = [...args, '--impact', 'service'];
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
// Second-opinion account: the extra underused-quota Codex review spends ChatGPT quota (never TTADK); a cross-vendor
// Codex second opinion follows TTADK first.
// The extra underused review follows the review policy (user, 2026-11-07): only code that needs a review anyway, never on
// a review itself, and never on a TTADK device.
for (const [sc, args, want] of [
  ['ttFresh', ['review'], 'none'],
  ['ttFresh', ['review-high', '--failures', '2'], 'ttadk'], // Opus pick (after Sol xhigh, Sol max) → Sol second on TTADK
  ['ttFresh', ['review-high'], 'none'], // Sol pick → Opus second (Claude keeps the high-stakes pair)
  ['fresh', ['review'], 'none'],
  ['fresh', ['implement-hard', '--impact', 'release'], 'main'],
  ['fresh', ['implement-hard', '--impact', 'throwaway'], 'none'],
  ['fresh', ['implement-hard', '--impact', 'service'], 'none'],
  ['ttFresh', ['implement-hard', '--impact', 'release', '--exclude-account', 'ttadk'], 'none'],
]) {
  let got;
  try { got = JSON.parse(run(sc, args)).secondOpinion?.account ?? 'none'; } catch (e) { got = `ERROR ${String(e.stderr || e.message).split('\n')[0]}`; }
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${sc.padEnd(19)} ${(args.join(' ') + ' (2nd account)').padEnd(36)} ${ok ? got : `want "${want}", got "${got}"`}`);
}
// Every TTADK worker searches through the proxy: a TTADK codex exec brings the proxy up first; nothing else does.
for (const [sc, args, want] of [
  ['ttSearch', ['lookup'], true],
  ['ttSearch', ['research'], false],
  ['ttFresh', ['lookup'], false],
  ['fresh', ['lookup'], false],
]) {
  let got;
  try { got = /--account ttadk proxy >\/dev\/null && /.test(JSON.parse(run(sc, args)).pick?.command ?? ''); } catch (e) { got = `ERROR ${String(e.stderr || e.message).split('\n')[0]}`; }
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${sc.padEnd(19)} ${(args.join(' ') + ' (proxy first)').padEnd(36)} ${ok ? got : `want ${want}, got ${got}`}`);
}
// The second reviewer of Codex-written code is Kimi-K3 on TTADK when the gateway lists it, else Sol.
for (const [sc, want] of [['ttKimi', 'kimi-k3 high @ttadk'], ['ttFresh', 'gpt-6.1-sol xhigh @ttadk']]) {
  let got;
  try { const so = JSON.parse(run(sc, ['review', '--author', 'codex'])).secondOpinion; got = so ? `${so.model} ${so.effort} @${so.account}` : 'none'; } catch (e) { got = 'ERROR'; }
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${sc.padEnd(19)} ${'review --author codex (2nd)'.padEnd(36)} ${ok ? got : `want "${want}", got "${got}"`}`);
}
// computer-use passes the allowed apps to the worker.
{
  let got;
  try { got = JSON.parse(run('ttFresh', ['computer-use', '--apps', 'com.apple.calculator,com.apple.Notes'])).pick?.command ?? ''; } catch (e) { got = 'ERROR'; }
  const ok = got.includes("--computer-use-apps 'com.apple.calculator,com.apple.Notes'");
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ttFresh             computer-use --apps (command)        ${ok ? 'has --computer-use-apps' : got.slice(0, 120)}`);
}
// Redemption prompt only when the work really lands on the card account.
for (const [sc, args, want] of [
  ['ttCard', ['docs'], false],
  ['ttCard', ['image-gen'], true],
  ['pickExcluded', ['implement', '--impact', 'service', '--exclude-account', 'main'], true],
  ['bothSpent', ['implement', '--impact', 'service'], true],
]) {
  let got;
  try { const o = JSON.parse(run(sc, args)); got = !!o.redeemFirst; } catch (e) { got = `ERROR ${String(e.stderr || e.message).split('\n')[0]}`; }
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${sc.padEnd(19)} ${(args.join(' ') + ' (redeem)').padEnd(36)} ${ok ? got : `want ${want}, got ${got}`}`);
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
// Outcome join (outcome.mjs / review-data.mjs): prefix-tolerant, fix rounds fold in, reviews and look-alike suffixes don't.
{
  const { outcomeOwns, isReviewDecision } = await import('../lib/state.mjs');
  const d = (name, category = 'implement', project = 'p') => ({ project, name, category });
  const cases = [
    [outcomeOwns('lynx-view', 'T17', d('lynx-view-T17', 'debug', 'lynx-view')), true],
    [outcomeOwns('lynx-view', 'lynx-view-T17', d('T17', 'debug', 'lynx-view')), true],
    [outcomeOwns('p', 'W1', d('W1-fix2')), true],
    [outcomeOwns('p', 'cloud-device', d('cloud-device-research')), true],
    [outcomeOwns('p', 'macbook', d('macbook-repo-audit', 'implement', 'q')), false],
    [outcomeOwns('p', 'W27', d('W277')), false],
    [isReviewDecision(d('W277-R', 'implement')), true],
    [isReviewDecision(d('W268-mr2-review', 'review')), true],
    [isReviewDecision(d('secretary-macbook-repo-audit', 'analysis')), false],
  ];
  const bad = cases.map(([got, want], i) => (got === want ? null : i)).filter((i) => i !== null);
  if (bad.length) fail++;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} outcome join        ${cases.length} cases${bad.length ? ` — failing #${bad.join(', #')}` : ''}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
