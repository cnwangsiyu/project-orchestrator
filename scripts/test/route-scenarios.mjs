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
// TRAE CLI (second company account, 2026-11-08): no windows, no browser, its own model ids.
const tr = (extra = {}) => ({ name: 'trae', kind: 'trae', home: '/tmp/trae', hub: 'ws://127.0.0.1:47398', healthy: true, reason: null, live: true, active: 0,
  models: ['gpt-6.1-sol', 'gpt-6-astra', 'gemini-3.1-pro-preview'], modelIds: { 'gpt-6.1-sol': 'GPT-6.1-Sol', 'gpt-6-astra': 'GPT-6-Astra', 'gemini-3.1-pro-preview': 'Gemini-3.1-Pro-Preview' },
  search: true, searchLive: true, browser: false, windows: [], resets: null, ...extra });
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
  // TTADK's daily token quota used up (2026-11-08): personal-quota pick, gated on the user's OK (go on or wait).
  ttQuotaOut: { claude: cl(10, 120), codex: [acc('main', 20, 120), tt({ healthy: false, reason: 'its daily token quota is used up', quotaOut: { kind: 'daily', resetsAt: now + 10 * h } })] },
  // TTADK first, then TRAE CLI, then personal quota (user, 2026-11-08).
  ttAndTrae: { claude: cl(10, 120), codex: [acc('main', 20, 120), tt(), tr()] },
  ttOutTrae: { claude: cl(10, 120), codex: [acc('main', 20, 120), tt({ healthy: false, reason: 'its daily token quota is used up', quotaOut: { kind: 'daily', resetsAt: now + 10 * h } }), tr()] },
  ttOutTraeDown: { claude: cl(10, 120), codex: [acc('main', 20, 120), tt({ healthy: false, reason: 'its daily token quota is used up', quotaOut: { kind: 'daily', resetsAt: now + 10 * h } }), tr({ healthy: false, reason: 'TRAE CLI not logged in' })] },
  traeOnly: { claude: cl(10, 120), codex: [acc('main', 20, 120), tr()] },
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
  // TTADK's quota is daily (user, 2026-11-09): throwaway code work starts at Sol high on the company accounts, climbs on
  // failure; release/service work and personal-quota picks are unchanged.
  ['ttFresh', ['implement-hard', '--impact', 'throwaway'], 'codex gpt-6.1-sol high @ttadk'],
  ['ttFresh', ['implement-hard', '--impact', 'throwaway', '--failures', '1'], 'codex gpt-6.1-sol xhigh @ttadk'],
  ['ttFresh', ['implement-hard', '--impact', 'throwaway', '--failures', '2'], 'codex gpt-6.1-sol max @ttadk'],
  ['ttFresh', ['debug', '--impact', 'throwaway', '--stakes', 'high'], 'codex gpt-6.1-sol xhigh @ttadk'],
  ['ttFresh', ['implement', '--impact', 'throwaway'], 'codex gpt-6.1-sol high @ttadk'],
  ['ttFresh', ['implement-hard', '--impact', 'release'], 'codex gpt-6.1-sol xhigh @ttadk'],
  ['ttOutTrae', ['debug', '--impact', 'throwaway'], 'codex gpt-6.1-sol high @trae'],
  ['quiet', ['debug', '--impact', 'throwaway'], 'codex gpt-6.1-sol xhigh @main'],
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
  ['ttQuotaOut', ['implement'], 'codex gpt-6.1-sol high @main'],
  ['ttQuotaOut', ['analysis'], 'codex gpt-6.1-sol medium @main'],
  ['ttQuotaOut', ['implement', '--urgent'], 'codex gpt-6.1-sol high @main'],
  ['ttQuotaOut', ['implement', '--stakes', 'high'], 'codex gpt-6.1-sol xhigh @main'],
  ['ttQuotaOut', ['image-gen'], 'codex gpt-6-luna low @main'],
  ['ttAndTrae', ['analysis'], 'codex gpt-6.1-sol high @ttadk'],
  ['ttAndTrae', ['implement'], 'codex gpt-6.1-sol high @ttadk'],
  ['ttOutTrae', ['analysis'], 'codex gpt-6.1-sol high @trae'],
  ['ttOutTrae', ['implement'], 'codex gpt-6.1-sol high @trae'],
  ['ttOutTrae', ['research'], 'codex gpt-6.1-sol high @trae'],
  ['ttOutTrae', ['image-gen'], 'codex gpt-6-luna low @main'],
  ['ttOutTrae', ['browser'], 'claude sonnet medium'],
  ['ttOutTraeDown', ['analysis'], 'codex gpt-6.1-sol medium @main'],
  ['traeOnly', ['implement'], 'codex gpt-6.1-sol high @trae'],
  ['ttAndTrae', ['implement', '--exclude-account', 'ttadk'], 'codex gpt-6.1-sol high @trae'],
  ['ttAndTrae', ['implement', '--exclude-account', 'ttadk,trae'], 'codex gpt-6.1-sol high @main'],
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
// Model catalog (review-data.mjs): read from main's home even when the caller runs under TTADK's CODEX_HOME (the nightly
// TTADK worker did, 2026-11-08, and saved TTADK's catalog as the main baseline).
{
  const { codexCatalog } = await import('../lib/state.mjs');
  const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nprintf \'{"models":[{"slug":"%s"}]}\' "$CODEX_HOME"\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: path.join(tmp, 'ttadk') };
  const reg = { main: { home: path.join(tmp, 'main') }, ttadk: { kind: 'ttadk', home: path.join(tmp, 'ttadk') } };
  const got = codexCatalog({ reg, env }).codex.map((m) => m.slug).join(',');
  const ok = got === path.join(tmp, 'main');
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} catalog source      caller CODEX_HOME=ttadk               ${ok ? 'main' : `got ${got}`}`);
}
// TTADK quota used up: normal work asks the user (needs OK); --urgent and high stakes don't (user, 2026-11-08).
{
  const gate = (args) => JSON.parse(run('ttQuotaOut', args)).needsUserOK.some((n) => /TTADK is paused/.test(n));
  const cases = [[gate(['analysis']), true], [gate(['implement', '--impact', 'service']), true], [gate(['analysis', '--urgent']), false], [gate(['implement', '--impact', 'service', '--stakes', 'high']), false]];
  const bad = cases.map(([got, want], i) => (got === want ? null : i)).filter((i) => i !== null);
  if (bad.length) fail++;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} ttQuotaOut gate     ${cases.length} cases${bad.length ? ` — failing #${bad.join(', #')}` : ''}`);
}
// TRAE: no OK gate while it can take TTADK's work; the gate returns when both company accounts are out; TRAE launches use
// its own model ids and traecli for exec.
{
  const o = (sc, args) => JSON.parse(run(sc, args));
  const gate = (sc, args) => o(sc, args).needsUserOK.some((n) => /TTADK is paused/.test(n));
  const exec = o('ttOutTrae', ['lookup']).pick?.command ?? '';
  const worker = o('ttOutTrae', ['implement', '--impact', 'service']).pick?.command ?? '';
  const cases = [[gate('ttOutTrae', ['analysis']), false], [gate('ttOutTraeDown', ['analysis']), true],
    [/^traecli exec .*-m GPT-6\.1-Sol /.test(exec), true], [/--account trae start .*--model GPT-6\.1-Sol /.test(worker), true]];
  const bad = cases.map(([got, want], i) => (got === want ? null : i)).filter((i) => i !== null);
  if (bad.length) fail++;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} trae gate/launch    ${cases.length} cases${bad.length ? ` — failing #${bad.join(', #')} (exec: ${exec.slice(0, 90)})` : ''}`);
}
// TRAE vs native Codex comparison (review-data.mjs, user 2026-11-08): harness attribution, Fisher's exact test, verdicts.
{
  const { harnessOf, fisherExact, compareHarness } = await import('../lib/state.mjs');
  const pk = (account, model = 'gpt-6.1-sol', vendor = 'codex') => ({ vendor, model, effort: 'high', account });
  const outs = (n, pass, account, category = 'implement') => Array.from({ length: n }, (_, i) => ({ first: pk(account), category, result: i < pass ? 'pass' : 'rework', rounds: i < pass ? 0 : 1 }));
  const worse = compareHarness([...outs(10, 2, 'trae'), ...outs(10, 9, 'ttadk')], { trae: { kind: 'trae' } });
  const even = compareHarness([...outs(10, 8, 'trae'), ...outs(10, 8, 'main')], { trae: { kind: 'trae' } });
  const few = compareHarness([...outs(3, 0, 'trae'), ...outs(3, 3, 'b')], { trae: { kind: 'trae' } });
  const cases = [
    [harnessOf(pk('trae'), { trae: { kind: 'trae' } }), 'trae'], [harnessOf(pk('ttadk')), 'codex'], [harnessOf(pk('main', 'opus', 'claude')), 'claude'],
    [Math.abs(fisherExact(1, 9, 11, 3) - 0.0028) < 0.0005, true], [fisherExact(5, 5, 5, 5) > 0.99, true],
    [worse.rows.find((r) => r.key === 'gpt-6.1-sol')?.verdict, 'TRAE significantly worse'],
    [even.rows.find((r) => r.key === 'gpt-6.1-sol')?.verdict, 'no significant difference'],
    [/too few/.test(few.rows.find((r) => r.key === 'gpt-6.1-sol')?.verdict ?? ''), true],
    [worse.rows.some((r) => r.key === 'gpt-6.1-sol / implement'), true],
  ];
  const bad = cases.map(([got, want], i) => (got === want ? null : i)).filter((i) => i !== null);
  if (bad.length) fail++;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} trae vs codex       ${cases.length} cases${bad.length ? ` — failing #${bad.join(', #')}` : ''}`);
}
// TRAE pause (lib/trae-health.mjs, user 2026-11-08): transient failures back off 5/10/20/30 min; auth and hard ones
// pause 30 min; a success clears everything; an auth pause lifts once logged in again.
{
  const { pauseDecision, failureKind, noteFailure, noteSuccess, readPause, liftAuthPause } = await import('../lib/trae-health.mjs');
  const t0 = 1_800_000_000_000, m = 60000, q = "We're sorry, the request queue size is exceed. Please wait and try again later.";
  const home = fs.mkdtempSync(path.join(tmp, 'trae-'));
  noteFailure(home, q, t0); const one = readPause(home, t0 + m);
  const p1 = noteFailure(home, q, t0 + 2 * m);                       // 1st pause: 5 min
  noteFailure(home, q, t0 + 8 * m); const p2 = noteFailure(home, q, t0 + 9 * m);   // after it: 10 min
  noteFailure(home, q, t0 + 20 * m); const p3 = noteFailure(home, q, t0 + 21 * m); // 20 min
  noteSuccess(home); const cleared = readPause(home, t0 + 22 * m);
  noteFailure(home, q, t0 + 30 * m); const p4 = noteFailure(home, q, t0 + 31 * m); // back to 5 after a success
  const ah = fs.mkdtempSync(path.join(tmp, 'trae-auth-'));
  const pa = noteFailure(ah, '401 Unauthorized: token expired', t0); liftAuthPause(ah); const lifted = readPause(ah, t0 + m);
  const cases = [
    [failureKind(q), 'transient'], [failureKind('403 Forbidden: quota exceeded'), 'hard'], [failureKind('not logged in'), 'auth'],
    [pauseDecision([{ t: t0, why: q }], t0 + m), null],
    [pauseDecision([{ t: t0, why: q }, { t: t0 + 20 * m, why: q }], t0 + 21 * m), null],
    [pauseDecision([{ t: t0, why: 'account banned' }], t0 + m)?.pausedUntil, t0 + 30 * m],
    [pauseDecision([{ t: t0, why: q }, { t: t0 + m, why: q }], t0 + 2 * m, 9)?.pausedUntil, t0 + 31 * m],
    [one, null], [p1?.pausedUntil, t0 + 7 * m], [p2?.pausedUntil, t0 + 19 * m], [p3?.pausedUntil, t0 + 41 * m],
    [cleared, null], [p4?.pausedUntil, t0 + 36 * m], [pa?.pausedUntil, t0 + 30 * m], [lifted, null],
  ];
  const bad = cases.map(([got, want], i) => (got === want ? null : i)).filter((i) => i !== null);
  if (bad.length) fail++;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} trae pause          ${cases.length} cases${bad.length ? ` — failing #${bad.join(', #')}` : ''}`);
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
// One outcome per task (review-data.mjs, nightly review 2026-11-09): duplicates merge — latest result, most rounds.
{
  const { dedupeOutcomes } = await import('../lib/state.mjs');
  const pk = { vendor: 'codex', model: 'gpt-6.1-sol', effort: 'high', account: 'ttadk' };
  const o = (t, project, name, result, rounds, extra = {}) => ({ t, kind: 'outcome', project, name, result, rounds, first: pk, ...extra });
  const out = dedupeOutcomes([
    o(1, 'lynx-view', 'lynx-view-T17', 'pass', 2), o(5, 'lynx-view', 'lynx-view-T17', 'pass', 0),             // re-record said 0 rounds
    o(2, 'video-agent', 'W285G', 'pass', 0), o(3, 'video-agent', 'W285G', 'rework', 2, { first: null }), o(4, 'video-agent', 'W285G', 'rework', 3),
    o(2, 'lynx-view', 'T18', 'pass', 0), o(6, 'lynx-view', 'lynx-view-T18', 'fail', null, { reviewed: true }), // prefix-tolerant
    o(1, 'video-agent', 'W27', 'pass', 0), o(1, 'video-agent', 'W277', 'pass', 0),                             // different tasks
    o(1, 'p', 'X', 'pass', 0), o(2, 'q', 'X', 'pass', 0),                                                       // different projects
  ]);
  const get = (p, n) => out.find((x) => x.project === p && x.name.endsWith(n));
  const cases = [
    [out.length, 7],
    [get('lynx-view', 'T17').rounds, 2], [get('lynx-view', 'T17').t, 5], [get('lynx-view', 'T17').dupes, 2],
    [get('video-agent', 'W285G').result, 'rework'], [get('video-agent', 'W285G').rounds, 3], [get('video-agent', 'W285G').first?.account, 'ttadk'],
    [get('lynx-view', 'T18').result, 'fail'], [get('lynx-view', 'T18').reviewed, true], [get('lynx-view', 'T18').rounds, 0],
    [get('video-agent', 'W27').dupes, 1],
  ];
  const bad = cases.map(([got, want], i) => (got === want ? null : i)).filter((i) => i !== null);
  if (bad.length) fail++;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} outcome dedupe      ${cases.length} cases${bad.length ? ` — failing #${bad.join(', #')}` : ''}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
