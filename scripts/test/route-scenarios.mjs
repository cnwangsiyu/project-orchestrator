#!/usr/bin/env node
// Regression tests for route.mjs + lib/state.mjs against synthetic quota states. Run after any routing change:
//   node scripts/test/route-scenarios.mjs        (exit 0 = all pass)
// Each case fixes the quota state and the route flags and states the decision the policy must produce. When a policy
// change is intended, update the expectations here in the same commit and say why in the commit message.
import fs from 'node:fs';
import assert from 'node:assert/strict';
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
  // Browser work on Codex without a company account (2026-11-10: the MacBook sent it all to Claude).
  macBrowser: { claude: cl(10, 120), codex: [acc('main', 20, 120, [], { browser: true, chromePlugin: '/tmp/chrome-main' })] },
  traeBrowserB: { claude: cl(10, 120), codex: [acc('main', 20, 120), acc('b', 30, 100, [], { browser: true }), tr()] },
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
  // Never held silently (user, 2026-11-09): these used to DEFER; now a pick behind the user's OK (checked below).
  ['codexOut', ['lookup', '--stakes', 'low'], 'claude haiku low'],
  ['codexOutClaudeOver', ['implement'], 'claude opus high'],
  ['codexOutClaudeOver', ['image-gen'], 'DEFER'],
  ['twoAccounts', ['implement'], 'codex gpt-6.1-sol xhigh @b'],
  ['bothSpent', ['implement'], 'codex gpt-6.1-sol xhigh @main'], // after redeeming main's card
  ['bothSpent', ['implement', '--no-redeem'], 'claude sonnet medium'],
  ['expiringCard', ['review'], 'codex gpt-6.1-sol xhigh @main'],
  ['claude5h', ['computer-use'], 'DEFER'],
  ['codex5h', ['image-gen'], 'DEFER'],
  ['codex5h', ['implement'], 'claude opus high'],
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
  ['ttUnhealthy', ['implement'], 'codex gpt-6.1-sol high @main'],
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
  ['macBrowser', ['browser'], 'codex gpt-6.1-sol high @main'],
  ['macBrowser', ['computer-use'], 'codex gpt-6.1-sol high @main'],
  ['macBrowser', ['ui-browser'], 'codex gpt-6.1-sol xhigh @main'],
  ['fresh', ['browser'], 'claude sonnet medium'],
  ['traeBrowserB', ['browser'], 'codex gpt-6.1-sol medium @b'],
  ['traeBrowserB', ['implement'], 'codex gpt-6.1-sol high @trae'],
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
  // Credential clause in every brief (user-approved 2026-11-11).
  ['quiet', ['lookup'], 'codex gpt-6-luna low @main', 'credential clause'],
  ['ttOutTrae', ['analysis'], 'codex gpt-6.1-sol high @trae', 'credential clause'],
  // Security excludes TRAE GPT for this task; TTADK GPT and personal accounts are untouched (2026-11-12).
  ['ttOutTrae', ['review-high', '--security'], 'codex gemini-3.1-pro-preview high @trae', 'describe defensive intent'],
  ['ttOutTrae', ['implement', '--impact', 'service', '--security'], 'codex gemini-3.1-pro-preview high @trae'],
  ['ttAndTrae', ['review-high', '--security'], 'codex gpt-6.1-sol xhigh @ttadk', 'describe defensive intent'],
  ['ttFresh', ['--security', 'review-high'], 'codex gpt-6.1-sol xhigh @ttadk'],
  ['ttFresh', ['implement', '--impact', 'service', '--security'], 'codex gpt-6.1-sol high @ttadk'],
  ['fresh', ['review-high', '--security'], 'claude opus xhigh', 'describe defensive intent'],
  ['fresh', ['implement', '--impact', 'service', '--security'], 'codex gpt-6.1-sol xhigh @main'],
];
const ERRORS = [['fresh', ['implement', '__noimpact']], ['fresh', ['implement', '--impact', 'prod']], ['fresh', ['implement', '--failures', '-1']], ['fresh', ['implement', '--stakes', 'hgih']], ['fresh', ['second-opinion']], ['fresh', ['nope']]];

let fail = 0;
const CODE = ['implement', 'implement-hard', 'debug', 'science'];
const run = (sc, args0, overrides = {}) => {
  // Code categories need --impact; default it to service unless the case says otherwise ('__noimpact' tests the error).
  let args = args0.filter((a) => a !== '__noimpact');
  if (CODE.includes(args[0]) && !args.includes('--impact') && !args0.includes('__noimpact')) args = [...args, '--impact', 'service'];
  const cache = path.join(tmp, 'q.json');
  fs.writeFileSync(cache, JSON.stringify({ checkedAt: now, claude: S[sc].claude, codexAccounts: S[sc].codex, errors: {}, history: {} }));
  const env = { ...process.env, QUOTA_CACHE: cache, CODEX_ACCOUNTS: path.join(tmp, 'none.json'), ROUTE_LOG: '0', QUOTA_LOG: '0', TRAE_PROBE: '0', ROUTE_RR: path.join(tmp, 'rr.txt'), QUOTA_LOG_FILE: path.join(tmp, 'empty-company-history'), ...overrides };
  return execFileSync(process.execPath, [ROUTE, ...args, '--mode', 'default', '--json'], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
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
// user-approved 2026-11-11 retro: shell parsing must deliver the whole credential rule as one config argument.
for (const [sc, args] of [['quiet', ['lookup']], ['ttSearch', ['lookup']], ['ttOutTrae', ['lookup']], ['quiet', ['draft']], ['quiet', ['second-opinion', '--against', 'claude']]]) {
  let ok = false;
  try {
    const command = JSON.parse(run(sc, args)).pick.command;
    const quoted = command.match(/ -c ('developer_instructions=.*') --json/)[1];
    const config = execFileSync('/bin/sh', ['-c', `printf '%s' ${quoted}`], { encoding: 'utf8' });
    const rule = JSON.parse(config.slice('developer_instructions='.length));
    ok = rule === "Never read, copy or load any login session or credential file (cookies, SSO/session tokens, CLI auth files such as bytedcli's, keychain items, .netrc, API keys), and never inject a session into a browser or tool to get past a login. Wherever a login or authorization is needed, stop and report BLOCKED with what needs signing in.";
  } catch {}
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} exec credential     ${sc} ${args.join(' ')}`);
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
// TTADK quota used up (no TRAE): personal quota needs the user's OK, high stakes too (user, 2026-11-09); --urgent doesn't.
{
  const gate = (args) => JSON.parse(run('ttQuotaOut', args)).needsUserOK.some((n) => /^personal quota:/.test(n));
  const cases = [[gate(['analysis']), true], [gate(['implement', '--impact', 'service']), true], [gate(['analysis', '--urgent']), false], [gate(['implement', '--impact', 'service', '--stakes', 'high']), true]];
  const bad = cases.map(([got, want], i) => (got === want ? null : i)).filter((i) => i !== null);
  if (bad.length) fail++;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} ttQuotaOut gate     ${cases.length} cases${bad.length ? ` — failing #${bad.join(', #')}` : ''}`);
}
// TRAE: no personal-quota gate while it can take TTADK's work; the gate returns when both company accounts are out; TRAE launches use
// its own model ids and traecli for exec.
{
  const o = (sc, args) => JSON.parse(run(sc, args));
  const gate = (sc, args) => o(sc, args).needsUserOK.some((n) => /^personal quota:/.test(n));
  const exec = o('ttOutTrae', ['lookup']).pick?.command ?? '';
  const worker = o('ttOutTrae', ['implement', '--impact', 'service']).pick?.command ?? '';
  const cases = [[gate('ttOutTrae', ['analysis']), false], [gate('ttOutTraeDown', ['analysis']), true],
    [/^traecli exec .*-m GPT-6\.1-Sol /.test(exec), true], [/--account trae start .*--model GPT-6\.1-Sol /.test(worker), true]];
  const bad = cases.map(([got, want], i) => (got === want ? null : i)).filter((i) => i !== null);
  if (bad.length) fail++;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} trae gate/launch    ${cases.length} cases${bad.length ? ` — failing #${bad.join(', #')} (exec: ${exec.slice(0, 90)})` : ''}`);
}
// Only TTADK has the max-effort exemption. The 2026-11-10 review found T39-m1a-device routed to TRAE/max with no gate.
// Company-account selection must not extend TTADK's exemption to TRAE, including a TRAE-only device or --urgent.
{
  const maxGate = (sc, args) => {
    const o = JSON.parse(run(sc, args));
    return [o.pick?.account, o.pick?.effort, o.needsUserOK.includes('max effort')];
  };
  const max = ['implement-hard', '--impact', 'release', '--failures', '1'], max2 = ['implement-hard', '--impact', 'release', '--failures', '2'];
  const cases = [
    [maxGate('ttFresh', max), ['ttadk', 'max', false]],
    [maxGate('ttAndTrae', max), ['ttadk', 'max', false]],
    // On TRAE a fallback family (Gemini in this fixture) sits between Sol xhigh and Sol max, so max is one step later.
    [maxGate('ttOutTrae', max), ['trae', 'high', false]],
    [maxGate('ttOutTrae', max2), ['trae', 'max', true]],
    [maxGate('traeOnly', max2), ['trae', 'max', true]],
    [maxGate('ttOutTrae', [...max2, '--urgent']), ['trae', 'max', true]],
    [maxGate('ttOutTrae', ['build-run', '--failures', '4']), ['trae', 'max', true]],
    [maxGate('ttOutTrae', ['debug', '--impact', 'throwaway', '--failures', '3']), ['trae', 'max', true]],
    [maxGate('ttOutTrae', ['implement-hard', '--impact', 'release']), ['trae', 'xhigh', false]],
    [maxGate('claudeOver', ['debug', '--impact', 'release', '--failures', '1']), ['main', 'max', true]],
  ];
  const bad = cases.map(([got, want], i) => (JSON.stringify(got) === JSON.stringify(want) ? null : i)).filter((i) => i !== null);
  if (bad.length) fail++;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} max account gate    ${cases.length} cases${bad.length ? ` — failing #${bad.join(', #')}` : ''}`);
}
// TRAE vs native Codex comparison (review-data.mjs, user 2026-11-08): harness attribution, Fisher's exact test, verdicts.
{
  const { harnessOf, fisherExact, compareHarness, effectiveFirst, effectiveAccepted } = await import('../lib/state.mjs');
  const pk = (account, model = 'gpt-6.1-sol', vendor = 'codex') => ({ vendor, model, effort: 'high', account });
  const outs = (n, pass, account, category = 'implement') => Array.from({ length: n }, (_, i) => ({ first: pk(account), category, result: i < pass ? 'pass' : 'rework', rounds: i < pass ? 0 : 1 }));
  const worse = compareHarness([...outs(10, 2, 'trae'), ...outs(10, 9, 'ttadk')], { trae: { kind: 'trae' } });
  const even = compareHarness([...outs(10, 8, 'trae'), ...outs(10, 8, 'main')], { trae: { kind: 'trae' } });
  const few = compareHarness([...outs(3, 0, 'trae'), ...outs(3, 3, 'b')], { trae: { kind: 'trae' } });
  const substituted = { project: 'p', name: 'actual', first: pk('ttadk'), accepted: pk('main'), actual: [pk('trae'), pk('trae', 'deepseek-v4-pro')], result: 'pass' };
  const mixedRun = { ...substituted, name: 'mixed', actual: [pk('main'), pk('trae')], result: 'fail', cause: 'infra' };
  const actualComparison = compareHarness([substituted, mixedRun, ...outs(1, 1, 'ttadk')]);
  const cases = [
    [harnessOf(pk('trae'), { trae: { kind: 'trae' } }), 'trae'], [harnessOf(pk('ttadk')), 'codex'], [harnessOf(pk('main', 'opus', 'claude')), 'claude'],
    [Math.abs(fisherExact(1, 9, 11, 3) - 0.0028) < 0.0005, true], [fisherExact(5, 5, 5, 5) > 0.99, true],
    [worse.rows.find((r) => r.key === 'gpt-6.1-sol')?.verdict, 'TRAE significantly worse'],
    [even.rows.find((r) => r.key === 'gpt-6.1-sol')?.verdict, 'no significant difference'],
    [/too few/.test(few.rows.find((r) => r.key === 'gpt-6.1-sol')?.verdict ?? ''), true],
    [worse.rows.some((r) => r.key === 'gpt-6.1-sol / implement'), true],
    [effectiveFirst(substituted).account, 'trae'], [effectiveAccepted(substituted).model, 'deepseek-v4-pro'],
    [effectiveFirst({ first: pk('main') }).account, 'main'], [effectiveAccepted({ accepted: pk('b') }).account, 'b'],
    [actualComparison.rows[0].trae.tasks, 1], [actualComparison.rows[0].codex.tasks, 1],
    [actualComparison.mixed.length, 1], [actualComparison.mixed[0].task, 'p/mixed'], [actualComparison.mixed[0].cause, 'infra'],
    [compareHarness([substituted]).onlyTrae[0], 'gpt-6.1-sol: 1 on TRAE, none on Codex'],
    [compareHarness([{ ...substituted, actual: [pk('main'), pk('main', 'opus', 'claude')] }]).mixed.length, 1],
  ];
  const bad = cases.map(([got, want], i) => (got === want ? null : i)).filter((i) => i !== null);
  if (bad.length) fail++;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} trae vs codex       ${cases.length} cases${bad.length ? ` — failing #${bad.join(', #')}` : ''}`);
}
// TRAE whole-account pauses (lib/trae-health.mjs, user 2026-11-08): transient failures back off 5/10/20/30 min;
// auth starts at 30 min, hard failures back off; a success clears everything; auth lifts once logged in again.
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
    [failureKind('stream disconnected before completion: Model access temporarily restricted.'), 'hard'],
    [pauseDecision([{ t: t0, why: q }], t0 + m), null],
    [pauseDecision([{ t: t0, why: q }, { t: t0 + 20 * m, why: q }], t0 + 21 * m), null],
    [pauseDecision([{ t: t0, why: 'account banned' }], t0 + m)?.pausedUntil, t0 + 30 * m],
    [pauseDecision([{ t: t0, why: '403 Forbidden: quota exceeded' }], t0 + m, 1)?.pausedUntil, t0 + 60 * m],
    [pauseDecision([{ t: t0, why: '403 Forbidden: quota exceeded' }], t0 + m, 7)?.pausedUntil, t0 + 240 * m],
    [pauseDecision([{ t: t0, why: q }, { t: t0 + m, why: q }], t0 + 2 * m, 9)?.pausedUntil, t0 + 31 * m],
    [one, null], [p1?.pausedUntil, t0 + 7 * m], [p2?.pausedUntil, t0 + 19 * m], [p3?.pausedUntil, t0 + 41 * m],
    [cleared, null], [p4?.pausedUntil, t0 + 36 * m], [pa?.pausedUntil, t0 + 30 * m], [lifted, null],
  ];
  const bad = cases.map(([got, want], i) => (got === want ? null : i)).filter((i) => i !== null);
  if (bad.length) fail++;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} trae pause          ${cases.length} cases${bad.length ? ` — failing #${bad.join(', #')}` : ''}`);
}
// Personal quota only after asking (user, 2026-11-09): company accounts excluded by the orchestrator, or a TRAE-only
// device with TRAE down, still ask; image generation (a standing exception) and company work don't.
{
  const ok = (sc, args) => JSON.parse(run(sc, args)).needsUserOK.some((n) => /^personal quota:/.test(n));
  const cases = [[ok('ttAndTrae', ['implement', '--impact', 'service', '--exclude-account', 'ttadk,trae']), true],
    [ok('ttAndTrae', ['implement', '--impact', 'service', '--exclude-account', 'ttadk']), false],
    [ok('ttAndTrae', ['implement', '--impact', 'service']), false], [ok('ttOutTrae', ['image-gen']), false],
    [ok('ttOutTraeDown', ['analysis', '--stakes', 'high']), true], [ok('ttOutTraeDown', ['analysis', '--urgent']), false],
    [ok('traeOnly', ['implement', '--impact', 'service', '--exclude-account', 'trae']), true], [ok('fresh', ['implement', '--impact', 'service']), false]];
  const bad = cases.map(([got, want], i) => (got === want ? null : i)).filter((i) => i !== null);
  if (bad.length) fail++;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} personal-quota ask  ${cases.length} cases${bad.length ? ` — failing #${bad.join(', #')}` : ''}`);
}
// No silent holds (user, 2026-11-09): what used to be deferred by policy now carries a needs-OK; --urgent skips it.
{
  const ok = (sc, args) => JSON.parse(run(sc, args)).needsUserOK.length > 0;
  const cases = [[ok('codexOut', ['lookup', '--stakes', 'low']), true], [ok('codexOutClaudeOver', ['implement', '--impact', 'service']), true],
    [ok('codex5h', ['implement', '--impact', 'service']), true], [ok('ttUnhealthy', ['implement', '--impact', 'service']), true],
    [ok('ttUnhealthy', ['implement', '--impact', 'service', '--urgent']), false], [ok('codexOut', ['lookup', '--stakes', 'low', '--urgent']), false]];
  const bad = cases.map(([got, want], i) => (got === want ? null : i)).filter((i) => i !== null);
  if (bad.length) fail++;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} no silent hold      ${cases.length} cases${bad.length ? ` — failing #${bad.join(', #')}` : ''}`);
}
// Hub panic window (lib/state.mjs recentPanic, 2026-11-09): only panics in the last 30 min, since the last banner.
{
  const { recentPanic } = await import('../lib/state.mjs');
  const now = Date.parse('2026-11-10T06:30:00Z');
  const banner = 'TRAE CLI app-server (WebSockets)\n  listening on: ws://127.0.0.1:47324\n';
  const at = (t) => `\x1b[2m${t}\x1b[0m ERROR codex_core: something\n`;
  const panic = "thread 'tokio-runtime-worker' (1) panicked at core-plugins/src/store.rs:98:35:\nplugin cache root should be absolute: Too many open files in system\n";
  const cases = [
    [recentPanic(banner + at('2026-11-10T05:26:12Z') + panic + at('2026-11-10T06:12:25Z'), now, now), null],
    [recentPanic(banner + at('2026-11-10T06:20:00Z') + panic, now, now) != null, true],
    [recentPanic('codex app-server (WebSockets)\n' + panic + banner, now, now), null],
    [recentPanic(banner + panic, now, now) != null, true],
    [recentPanic(banner + panic, now, now - 3 * 3600000), null],
  ];
  const bad = cases.map(([got, want], i) => (got === want ? null : i)).filter((i) => i !== null);
  if (bad.length) fail++;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} hub panic window    ${cases.length} cases${bad.length ? ` — failing #${bad.join(', #')}` : ''}`);
}
// Outcome causes (rework retro 2026-11-10): model comparisons count code rework only; route.mjs tells the orchestrator
// to re-scope instead of patching again from the second failure of code work.
{
  const { modelView, dedupeOutcomes } = await import('../lib/state.mjs');
  const r = (cause) => modelView({ result: 'rework', rounds: 2, cause }).result;
  const note = (args) => JSON.parse(run('fresh', args)).notes.some((n) => /new defect of the same kind/.test(n));
  const cases = [[r('code'), 'rework'], [r(undefined), 'rework'], [r('infra'), 'pass'], [r('spec'), 'pass'], [r('scope'), 'pass'],
    [note(['implement', '--impact', 'service', '--failures', '2']), true], [note(['implement', '--impact', 'service', '--failures', '1']), false],
    [note(['research', '--failures', '2']), false],
    [modelView(dedupeOutcomes([{ t: 1, project: 'p', name: 'cause', result: 'rework', rounds: 2, cause: 'code' },
      { t: 2, project: 'p', name: 'cause', correction: true, cause: 'infra' }])[0]).result, 'pass']];
  const bad = cases.map(([got, want], i) => (got === want ? null : i)).filter((i) => i !== null);
  if (bad.length) fail++;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} rework causes       ${cases.length} cases${bad.length ? ` — failing #${bad.join(', #')}` : ''}`);
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
  const base = o(1, 'p', 'fix', 'rework', 2, { reviewed: true, cause: 'code', retries: 3, minutes: 40 });
  const correction = { t: 2, project: 'p', name: 'p-fix', correction: true, result: 'pass', rounds: 0 };
  const fixed = dedupeOutcomes([correction, base])[0];
  const laterNormal = dedupeOutcomes([base, correction, o(3, 'p', 'fix', 'rework', 9)])[0];
  const twice = dedupeOutcomes([{ ...correction, t: 4, result: 'fail', rounds: null, reviewed: false, cause: null, retries: 0 }, base, correction])[0];
  const cases = [
    [out.length, 7],
    [get('lynx-view', 'T17').rounds, 2], [get('lynx-view', 'T17').t, 5], [get('lynx-view', 'T17').dupes, 2],
    [get('video-agent', 'W285G').result, 'rework'], [get('video-agent', 'W285G').rounds, 3], [get('video-agent', 'W285G').first?.account, 'ttadk'],
    [get('lynx-view', 'T18').result, 'fail'], [get('lynx-view', 'T18').reviewed, true], [get('lynx-view', 'T18').rounds, 0],
    [get('video-agent', 'W27').dupes, 1],
    [fixed.result, 'pass'], [fixed.rounds, 0], [fixed.corrected, true], [fixed.dupes, 1], [fixed.reviewed, true], [fixed.retries, 3],
    [fixed.minutes, 40], [fixed.correctionFrom.rounds, 2], [fixed.correctedAt, 2],
    [laterNormal.result, 'pass'], [laterNormal.rounds, 0], [laterNormal.dupes, 2], [laterNormal.t, 3],
    [twice.result, 'fail'], [twice.rounds, null], [twice.reviewed, false], [twice.cause, null], [twice.retries, 0],
    [twice.corrections, 2], [twice.correctedAt, 4], [dedupeOutcomes([correction]).length, 0],
  ];
  const bad = cases.map(([got, want], i) => (got === want ? null : i)).filter((i) => i !== null);
  if (bad.length) fail++;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} outcome dedupe      ${cases.length} cases${bad.length ? ` — failing #${bad.join(', #')}` : ''}`);
}
// Fallback models on the company account (user, 2026-11-10: "gpt 不可用/失败也按照评测结果做一下路由"): per-family
// TRAE pauses; GPT out → DeepSeek-V4.1-Flash → Gemini-3.1-Pro → DeepSeek-V4-Pro → Claude; with GPT up, a different
// family between Sol xhigh and Sol max; fallback-written service code gets a review by another family.
{
  const { noteFailure, noteSuccess, readPause, readPoolPauses, poolOf } = await import('../lib/trae-health.mjs');
  const ids = ['gpt-6.1-sol', 'gpt-6-astra', 'deepseek-v4.1-flash', 'gemini-3.1-pro-preview', 'deepseek-v4-pro', 'seed-evolving'];
  const full = (home) => tr({ home, models: ids, modelIds: Object.fromEntries(ids.map((i) => [i, i.toUpperCase()])) });
  const out = { healthy: false, reason: 'its daily token quota is used up', quotaOut: { kind: 'daily', resetsAt: now + 10 * h } };
  const okHome = fs.mkdtempSync(path.join(tmp, 'trae-ok-')), gptHome = fs.mkdtempSync(path.join(tmp, 'trae-gpt-')), allHome = fs.mkdtempSync(path.join(tmp, 'trae-all-'));
  // TRAE dropped Gemini (2026-11-13): this fixture mirrors the live list; Seed-Evolving is the only vision row.
  const idsNoGem = ['gpt-6.1-sol', 'gpt-6-astra', 'deepseek-v4.1-flash', 'deepseek-v4-pro', 'seed-evolving'];
  const noGem = (home) => tr({ home, models: idsNoGem, modelIds: Object.fromEntries(idsNoGem.map((i) => [i, i.toUpperCase()])) });
  const noGemHome = fs.mkdtempSync(path.join(tmp, 'trae-nogem-')), mpHome = fs.mkdtempSync(path.join(tmp, 'trae-mp-'));
  // One model-unavailable failure (2026-11-13): it pauses deepseek-v4.1-flash only; deepseek-v4-pro keeps routing.
  noteFailure(mpHome, '-32600: model `deepseek-v4.1-flash` is unavailable because its metadata could not be resolved', Date.now(), 'deepseek-v4.1-flash');
  const t = Date.now(), R = 'stream disconnected: Model access temporarily restricted. (983)';
  const gptPause = noteFailure(gptHome, R, t, 'GPT-6.1-Sol');
  const reset = new Date(t); reset.setUTCHours(24, 0, 0, 0);
  for (const mm of ['GPT-6.1-Sol', 'DeepSeek-V4.1-Flash', 'Gemini-3.1-Pro-Preview', 'DeepSeek-V4-Pro', 'Seed-Evolving']) noteFailure(allHome, R, t, mm);
  S.traeFull = { claude: cl(10, 120), codex: [acc('main', 20, 120), tt(out), full(okHome)] };
  S.traeGptOut = { claude: cl(10, 120), codex: [acc('main', 20, 120), tt(out), full(gptHome)] };
  S.traeAllOut = { claude: cl(10, 120), codex: [acc('main', 20, 120), tt(out), full(allHome)] };
  S.traeNoGem = { claude: cl(10, 120), codex: [acc('main', 20, 120), tt(out), noGem(noGemHome)] };
  S.traeNoGemPaused = { claude: cl(10, 120), codex: [acc('main', 20, 120), tt(out), noGem(mpHome)] };
  const o = (sc, args) => JSON.parse(run(sc, args));
  const pk = (sc, args) => { const r = o(sc, args); return r.deferred ? 'DEFER' : `${r.pick.model} ${r.pick.effort} @${r.pick.account}`; };
  const hasNote = (sc, args, re) => o(sc, args).notes.some((n) => re.test(n));
  const personal = (sc, args) => o(sc, args).needsUserOK.some((n) => /^personal quota:/.test(n));
  // trae-health: a restriction on one family pauses that family only; a success elsewhere leaves it paused; auth pauses all.
  const hh = fs.mkdtempSync(path.join(tmp, 'trae-h-'));
  noteFailure(hh, R, t, 'GPT-6.1-Sol'); noteSuccess(hh, 'DeepSeek-V4.1-Flash');
  const gptStill = !!readPoolPauses(hh).gpt, acctFree = readPause(hh) === null;
  noteSuccess(hh, 'GPT-6.1-Sol'); const gptCleared = !readPoolPauses(hh).gpt;
  const ah = fs.mkdtempSync(path.join(tmp, 'trae-ha-')); noteFailure(ah, '401 Unauthorized', t, 'DeepSeek-V4.1-Flash');
  const cases = [
    [poolOf('Gemini-3.1-Pro-Preview'), 'gemini'], [poolOf('gpt-6.1-sol'), 'gpt'], [poolOf(null), null],
    [gptStill, true], [acctFree, true], [gptCleared, true], [!!readPause(ah), true],
    [gptPause?.pausedUntil, reset.getTime()], [gptPause?.restricted, true],
    [/vendor's policy until 08:00 China time \(00:00 UTC\); probed then/.test(gptPause?.reason), true],
    // GPT up: Sol, then a different family before Sol max, the second fallback after it, then Claude.
    [pk('traeFull', ['implement']), 'gpt-6.1-sol high @trae'],
    [pk('traeFull', ['implement', '--failures', '2']), 'deepseek-v4.1-flash high @trae'],
    [pk('traeFull', ['implement', '--failures', '3']), 'gpt-6.1-sol max @trae'],
    [pk('traeFull', ['implement', '--failures', '4']), 'gemini-3.1-pro-preview high @trae'],
    // GPT-6-Astra on the company account after Sol max and the fallbacks (live test 2026-11-13): company quota, no OK.
    [pk('traeFull', ['implement', '--failures', '5']), 'gpt-6-astra high @trae'],
    [pk('traeFull', ['implement', '--failures', '6']), 'opus high @undefined'],
    [o('traeFull', ['implement', '--failures', '5']).needsUserOK.some((n) => /Astra/.test(n)), false],
    [hasNote('traeFull', ['implement', '--failures', '5'], /Astra on TRAE queues TRAE-wide/), true],
    // A ChatGPT-account Astra still asks first (5x Sol usage).
    [o('ttFresh', ['science', '--impact', 'service', '--failures', '2']).needsUserOK.includes('Astra (5x Sol usage)'), true],
    [pk('traeFull', ['lookup', '--failures', '3']), 'deepseek-v4.1-flash high @trae'],
    // GPT paused on TRAE: the fallbacks in order, no personal-quota question, then Claude.
    [pk('traeGptOut', ['implement']), 'deepseek-v4.1-flash high @trae'],
    [pk('traeGptOut', ['implement', '--failures', '1']), 'gemini-3.1-pro-preview high @trae'],
    [pk('traeGptOut', ['implement', '--failures', '2']), 'deepseek-v4-pro high @trae'],
    [pk('traeGptOut', ['implement', '--failures', '3']), 'opus high @undefined'],
    [personal('traeGptOut', ['implement']), false],
    [pk('traeGptOut', ['image-read']), 'gemini-3.1-pro-preview high @trae'],
    [pk('traeGptOut', ['lookup']), 'deepseek-v4.1-flash high @trae'],
    [o('traeGptOut', ['lookup']).pick.command.includes('-m DEEPSEEK-V4.1-FLASH '), true],
    // The same through --exclude-model (an infrastructure miss on one task).
    [pk('traeFull', ['implement', '--exclude-model', 'gpt']), 'deepseek-v4.1-flash high @trae'],
    [pk('traeFull', ['implement', '--exclude-model', 'gpt,deepseek-v4.1-flash']), 'gemini-3.1-pro-preview high @trae'],
    // With Gemini gone from TRAE (2026-11-13), Seed-Evolving is the image reader only: image-read falls back to it,
    // implement never picks it; a model-unavailable pause drops only that model, its family-mate keeps routing.
    [pk('traeNoGem', ['image-read', '--exclude-model', 'gpt']), 'seed-evolving medium @trae'],
    [pk('traeNoGem', ['implement', '--exclude-model', 'gpt']), 'deepseek-v4.1-flash high @trae'],
    [pk('traeNoGemPaused', ['implement', '--exclude-model', 'gpt']), 'deepseek-v4-pro high @trae'],
    [pk('traeNoGemPaused', ['implement']), 'gpt-6.1-sol high @trae'],
    // The task flag uses that same exclusion path, scoped to TRAE, with the normal fallback ladder and gates.
    [pk('traeFull', ['review-high', '--security']), 'gemini-3.1-pro-preview high @trae'],
    [pk('traeFull', ['implement', '--impact', 'service', '--security']), 'deepseek-v4.1-flash high @trae'],
    [pk('traeFull', ['implement', '--security', '--failures', '1']), 'gemini-3.1-pro-preview high @trae'],
    [pk('traeFull', ['implement', '--security', '--exclude-model', 'deepseek']), 'gemini-3.1-pro-preview high @trae'],
    [personal('traeFull', ['implement', '--security']), false],
    [o('traeFull', ['review-high', '--security']).security, true],
    [o('traeFull', ['review-high']).security, false],
    [o('traeFull', ['review-high', '--security']).why.some((n) => /security task: TRAE's GPT excluded.*gemini-3\.1-pro-preview/.test(n)), true],
    [o('ttAndTrae', ['review-high', '--security']).why.some((n) => /security task:/.test(n)), false],
    [hasNote('traeFull', ['implement', '--security'], /review required.*written by fallback model/), true],
    [hasNote('traeFull', ['review-high', '--security'], /brief: describe defensive intent and ask for findings with impact and fix; avoid requesting step-by-step exploit code/), true],
    [hasNote('fresh', ['review-high'], /describe defensive intent/), false],
    // Fallback-written service code gets a review that keeps its family off the reviewer seat.
    [hasNote('traeGptOut', ['implement', '--impact', 'service'], /route\.mjs review --author codex --exclude-model deepseek/), true],
    [hasNote('traeGptOut', ['implement', '--impact', 'throwaway'], /review required/), false],
    [pk('traeGptOut', ['review', '--author', 'codex', '--exclude-model', 'deepseek']), 'gemini-3.1-pro-preview high @trae'],
    // A second free reviewer on TRAE comes from another family, not a fresh Sol.
    [o('traeFull', ['review', '--author', 'codex']).secondOpinion?.model, 'deepseek-v4.1-flash'],
    [hasNote('traeGptOut', ['review', '--author', 'codex'], /independent other-family GPT\/Claude reviewer/), true],
    [hasNote('traeGptOut', ['review-high'], /independent other-family GPT\/Claude reviewer/), true],
    [hasNote('traeGptOut', ['build-run'], /health thresholds.*rollback triggers.*stronger-model judgment/), true],
    [hasNote('traeGptOut', ['analysis'], /playwright MCP is for public\/local pages only.*missing login means BLOCKED/), true],
    [hasNote('traeGptOut', ['implement', '--failures', '1'], /Gemini-3\.1-Pro ran past 40 minutes/), true],
    [hasNote('traeGptOut', ['implement'], /can't see images/), true], [hasNote('traeGptOut', ['image-read'], /can't see images/), false],
    // Every family out: personal quota, behind the user's OK.
    [personal('traeAllOut', ['implement']), true],
  ];
  const bad = cases.map(([got, want], i) => (got === want ? null : `${i} (${got})`)).filter((i) => i !== null);
  if (bad.length) fail++;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} fallback models     ${cases.length} cases${bad.length ? ` — failing #${bad.join(', #')}` : ''}`);
  // A Codex author's review must use eligible company fallbacks before personal quota, even when Claude is over
  // budget. Seed remains listed when all eligible review families are excluded: an account alone isn't capacity.
  S.traeReviewFull = { ...S.traeFull, claude: cl(93, 30) };
  S.traeReviewGptOut = { ...S.traeGptOut, claude: cl(93, 30) };
  S.traeReviewChatOut = { ...S.traeReviewFull, codex: [acc('main', 99, 120), ...S.traeFull.codex.slice(1)] };
  for (const [args, claudePick] of [
    [['review', '--author', 'codex'], 'sonnet high @undefined'],
    [['review-high', '--author', 'codex'], 'opus xhigh @undefined'],
    [['second-opinion', '--against', 'codex'], 'opus high @undefined'],
  ]) {
    const personalPick = args[0] === 'second-opinion' ? claudePick : 'gpt-6.1-sol xhigh @main';
    for (const [sc, flags, want, gate] of [
      ['traeReviewFull', ['--security', '--exclude-model', 'deepseek', '--dry'], 'gemini-3.1-pro-preview high @trae', false],
      ['traeFull', ['--security', '--exclude-model', 'deepseek'], 'gemini-3.1-pro-preview high @trae', false],
      ['traeReviewGptOut', ['--exclude-model', 'deepseek'], 'gemini-3.1-pro-preview high @trae', false],
      ['traeReviewFull', ['--exclude-model', 'gpt,deepseek'], 'gemini-3.1-pro-preview high @trae', false],
      // High-stakes/security review now excludes DeepSeek; the remaining ladder is Gemini then Claude.
      ['traeReviewGptOut', [], args[0] === 'review-high' ? 'gemini-3.1-pro-preview high @trae' : 'deepseek-v4.1-flash high @trae', false],
      ['traeFull', ['--security', '--failures', '2'], args[0] === 'review' ? 'gemini-3.1-pro-preview high @trae' : 'opus xhigh @undefined', false],
      ['traeReviewFull', ['--security', '--exclude-model', 'deepseek,gemini'], personalPick, true],
      ['traeReviewFull', ['--security', '--exclude-model', 'deepseek,gemini', '--urgent'], personalPick, false],
      ['traeReviewGptOut', ['--exclude-model', 'deepseek,gemini'], personalPick, true],
      ['traeReviewGptOut', ['--exclude-model', 'deepseek,gemini', '--urgent'], personalPick, false],
      ['traeReviewFull', ['--exclude-model', 'gpt,deepseek,gemini'], claudePick, true],
      ['traeReviewChatOut', ['--security', '--exclude-model', 'deepseek,gemini'], claudePick, true],
      ['traeReviewFull', [], 'gpt-6.1-sol xhigh @trae', false],
      ['traeFull', [], args[0] === 'review' ? 'gpt-6.1-sol xhigh @trae' : claudePick, false],
      ['ttFresh', ['--security', '--exclude-model', 'deepseek'], args[0] === 'review' ? 'gpt-6.1-sol xhigh @ttadk' : claudePick, false],
    ]) {
      const routeArgs = [...args, ...flags];
      const result = o(sc, routeArgs);
      const got = result.deferred ? 'DEFER' : `${result.pick.model} ${result.pick.effort} @${result.pick.account}`;
      const gotGate = result.needsUserOK.some((n) => /^personal quota:/.test(n));
      const checkFreeSecond = args[0] === 'review' && want === 'gemini-3.1-pro-preview high @trae';
      const freeSecond = !checkFreeSecond
        || (result.secondOpinion?.account === 'trae' && result.secondOpinion.model === 'gemini-3.1-pro-preview'
          && result.notes.some((n) => /same model family; no other eligible company family/.test(n)));
      const ok = got === want && gotGate === gate && freeSecond;
      if (!ok) fail++;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${sc.padEnd(19)} ${routeArgs.join(' ')} (review pick/gate) ${ok ? `${got}, personal quota: ${gotGate}` : `want "${want}" / ${gate}, got "${got}" / ${gotGate}${checkFreeSecond && !freeSecond ? ' (extra reviewer must stay on the eligible company family)' : ''}`}`);
    }
  }
}
// Task-duration retro: brief amendments, model fit and build/device advice without new required flags.
{
  const o = (sc, args) => JSON.parse(run(sc, args));
  const hasNote = (r, re) => r.notes.some((n) => re.test(n));
  const cases = [];
  for (const cat of CODE) for (const failures of [0, 1, 2]) {
    cases.push([hasNote(o('traeFull', [cat, '--failures', String(failures)]), /if the last miss was spec\/process, amend the brief's acceptance first/), failures >= 1]);
  }
  cases.push([hasNote(o('traeFull', ['analysis', '--failures', '1']), /last miss was spec\/process/), false]);
  for (const cat of ['implement', 'implement-hard', 'debug']) {
    cases.push([hasNote(o('traeGptOut', [cat]), /DeepSeek: read-only analysis and simple edits only; not full-package builds, auth\/storage reviews or acceptance.*--exclude-model deepseek/), true]);
  }
  for (const args of [['build-run'], ['review-high'], ['review', '--impact', 'release'], ['review', '--stakes', 'high'], ['review', '--security']]) {
    for (const sc of ['traeFull', 'traeGptOut', 'traeNoGem']) for (const failures of [0, 1, 2, 3, 4, 5, 6]) {
      const r = o(sc, [...args, '--failures', String(failures)]);
      cases.push([r.pick?.model.startsWith('deepseek') ?? false, false], [r.secondOpinion?.model.startsWith('deepseek') ?? false, false]);
    }
    // With GPT excluded and Gemini absent, DeepSeek cannot bypass the personal-quota approval gate.
    const r = o('traeNoGem', [...args, '--exclude-model', 'gpt']);
    cases.push([r.needsUserOK.some((n) => /^personal quota:/.test(n)), true]);
  }
  for (const cat of ['analysis', 'review', 'implement']) cases.push([o('traeGptOut', [cat]).pick.model, 'deepseek-v4.1-flash']);
  for (const cat of ['build-run', 'ui-browser', 'computer-use']) {
    const r = o('ttFresh', [cat]);
    cases.push([hasNote(r, /finished tasks by task directory.*never kill other tasks' processes/), true],
      [hasNote(r, /at most 3 concurrent heavy builds unless the ledger sets N otherwise/), true],
      [hasNote(r, /at most 2 h, then return the device and report.*device connected, unlocked, app data backed up/), true]);
  }
  cases.push([hasNote(o('traeFull', ['implement', '--impact', 'release']), /route\.mjs review --author codex --impact release/), true]);
  const bad = cases.map(([got, want], i) => (got === want ? null : `${i} (${got})`)).filter((i) => i !== null);
  if (bad.length) fail++;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} task-duration rules ${cases.length} cases${bad.length ? ` — failing #${bad.join(', #')}` : ''}`);
}
// A model TRAE no longer resolves pauses only that model for 6 h (2026-11-13, after TRAE dropped Gemini): its
// family-mates keep routing, the account and family never pause, and no probe is needed — the next launch tries again.
{
  const { failureKind, pauseDecision, noteFailure, noteSuccess, readModelPauses, readPoolPauses, readPause } = await import('../lib/trae-health.mjs');
  const t0 = Date.parse('2026-11-13T08:00:00Z'), H = 3600000, m = 60000;
  const e1 = '-32600: model `gemini-3.1-pro-preview` is unavailable because its metadata could not be resolved';
  const e2 = 'model `gpt-does-not-exist` is unavailable because its metadata could not be resolved (code -32600)';
  const home = fs.mkdtempSync(path.join(tmp, 'trae-unavail-'));
  const p = noteFailure(home, e1, t0, 'gemini-3.1-pro-preview');
  const live = readModelPauses(home, t0 + 6 * H - 1), expired = readModelPauses(home, t0 + 6 * H + 1);
  const pools = readPoolPauses(home, t0 + m), acct = readPause(home, t0 + m);
  noteFailure(home, e1, t0 + m, 'gemini-3.1-pro-preview');
  const one = Object.keys(readModelPauses(home, t0 + 2 * m)).length;
  const sh = fs.mkdtempSync(path.join(tmp, 'trae-unavail-s-'));
  noteFailure(sh, e2, t0, 'gpt-does-not-exist'); noteSuccess(sh, 'gpt-does-not-exist');
  const cleared = Object.keys(readModelPauses(sh, t0 + m)).length;
  const cases = [
    [failureKind(e1), 'unavailable'], [failureKind(e2), 'unavailable'],
    [failureKind('request queue size is exceed'), 'transient'], [failureKind('401 Unauthorized'), 'auth'], [failureKind('403 Forbidden: quota exceeded'), 'hard'],
    [pauseDecision([{ t: t0, why: e1 }], t0 + m), null], [pauseDecision([{ t: t0, why: e1 }, { t: t0 + m, why: e1 }], t0 + 2 * m), null],
    [p?.modelPause, true], [p?.model, 'gemini-3.1-pro-preview'], [p?.pool, 'gemini'], [p?.pausedUntil, t0 + 6 * H],
    [/model unavailable; paused 6 h/.test(p?.reason), true],
    [Object.keys(live).join(), 'gemini-3.1-pro-preview'], [Object.keys(expired).length, 0],
    [Object.keys(pools).length, 0], [acct, null], [one, 1], [cleared, 0],
  ];
  const bad = cases.map(([got, want], i) => (got === want ? null : `${i} (${got})`)).filter((i) => i !== null);
  if (bad.length) fail++;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} model unavailable   ${cases.length} cases${bad.length ? ` — failing #${bad.join(', #')}` : ''}`);
}
// Recovery probes (user, 2026-11-12): vendor restrictions wait for the next UTC midnight, including failed probes;
// other hard failures keep 30-minute probes. A family stays out until a probe succeeds; transient pauses just end.
{
  const { noteFailure, readPoolPauses, claimProbes, probeResult } = await import('../lib/trae-health.mjs');
  const t0 = Date.parse('2026-11-12T12:00:00Z'), midnight = Date.parse('2026-11-13T00:00:00Z'), day = 86400000,
    m = 60000, R = 'Model access temporarily restricted. (983)', hard = '403 Forbidden: quota exceeded', q = 'request queue size is exceed';
  const home = fs.mkdtempSync(path.join(tmp, 'trae-probe-'));
  const p1 = noteFailure(home, R, t0, 'GPT-6.1-Sol');
  const during = Object.keys(readPoolPauses(home, t0 + 31 * m)), early = claimProbes(home, t0 + 31 * m);
  const before = claimProbes(home, midnight - 1), after = readPoolPauses(home, midnight);
  const due = claimProbes(home, midnight), again = claimProbes(home, midnight + m), stale = claimProbes(home, midnight + 11 * m);
  // The persisted restriction schedule survives a probe that reports a different failure.
  probeResult(home, 'GPT-6.1-Sol', false, 'probe timed out', midnight + 12 * m);
  const failed = readPoolPauses(home, midnight + 13 * m).gpt;
  const failedEarly = claimProbes(home, midnight + day - 1), nextDue = claimProbes(home, midnight + day);
  probeResult(home, 'GPT-6.1-Sol', true, '', midnight + day + m);
  const back = Object.keys(readPoolPauses(home, midnight + day + m));
  const hh = fs.mkdtempSync(path.join(tmp, 'trae-probe-hard-'));
  const hp = noteFailure(hh, hard, t0, 'GPT-6.1-Sol');
  const hardEarly = claimProbes(hh, t0 + 29 * m), hardDue = claimProbes(hh, t0 + 30 * m);
  probeResult(hh, 'GPT-6.1-Sol', false, hard, t0 + 31 * m);
  const hardFailed = readPoolPauses(hh, t0 + 32 * m).gpt, hardRetry = claimProbes(hh, t0 + 61 * m);
  // A restriction reported by a probe also switches a previously ordinary hard pause to the vendor reset.
  probeResult(hh, 'GPT-6.1-Sol', false, R, t0 + 62 * m);
  const newlyRestricted = readPoolPauses(hh, t0 + 63 * m).gpt;
  const th = fs.mkdtempSync(path.join(tmp, 'trae-probe-q-'));
  noteFailure(th, q, t0, 'GPT-6.1-Sol'); noteFailure(th, q, t0 + m, 'GPT-6.1-Sol');
  const qDuring = Object.keys(readPoolPauses(th, t0 + 3 * m)), qAfter = Object.keys(readPoolPauses(th, t0 + 10 * m)), qProbe = claimProbes(th, t0 + 10 * m);
  // A restriction replaces a short pause even when it arrives while that pause is active.
  noteFailure(th, hard, t0 + 11 * m, 'GPT-6.1-Sol');
  const upgraded = noteFailure(th, R, t0 + 12 * m, 'GPT-6.1-Sol');
  // A pre-change restriction record is recognized when its probe fails, even without the new marker.
  const legacyHome = fs.mkdtempSync(path.join(tmp, 'trae-probe-legacy-'));
  fs.writeFileSync(path.join(legacyHome, 'worker-health.json'), JSON.stringify({ failures: [], pools: {
    gpt: { failures: [], kind: 'hard', model: 'GPT-6.1-Sol', pausedUntil: t0 + 30 * m, reason: R + ' (paused 30 min, then probed)' },
  } }));
  probeResult(legacyHome, 'GPT-6.1-Sol', false, 'probe timed out', midnight + m);
  const legacyFailed = readPoolPauses(legacyHome, midnight + 2 * m).gpt;
  const cases = [[p1?.pausedUntil, midnight], [p1?.restricted, true], [during.join(), 'gpt'], [early.length, 0],
    [before.length, 0], [Object.keys(after).join(), 'gpt'], [/awaiting a recovery probe/.test(after.gpt?.reason), true],
    [JSON.stringify(due), JSON.stringify([{ pool: 'gpt', model: 'GPT-6.1-Sol' }])], [again.length, 0], [stale.length, 1],
    [failed?.pausedUntil, midnight + day], [failed?.restricted, true], [failedEarly.length, 0], [nextDue.length, 1], [back.length, 0],
    [hp?.pausedUntil, t0 + 30 * m], [hardEarly.length, 0], [hardDue.length, 1], [hardFailed?.pausedUntil, t0 + 61 * m],
    [hardFailed?.restricted, false], [hardRetry.length, 1], [newlyRestricted?.pausedUntil, midnight], [newlyRestricted?.restricted, true],
    [qDuring.join(), 'gpt'], [qAfter.length, 0], [qProbe.length, 0], [upgraded?.pausedUntil, midnight],
    [legacyFailed?.pausedUntil, midnight + day], [legacyFailed?.restricted, true]];
  // Strict UTC boundaries and both restriction match forms; no two-minute grace period rounds back or skips a reset.
  for (const [t, message, want] of [
    [midnight - 2 * m, R, midnight], [midnight - m, 'ACCESS RESTRICTED', midnight],
    [midnight - 1, 'vendor error code 983', midnight], [midnight, R, midnight + day], [midnight + 1, R, midnight + day],
  ]) {
    const boundaryHome = fs.mkdtempSync(path.join(tmp, 'trae-probe-boundary-'));
    const p = noteFailure(boundaryHome, message, t, 'GPT-6.1-Sol');
    cases.push([p?.pausedUntil, want], [p?.pausedUntil > t, true], [claimProbes(boundaryHome, want - 1).length, 0],
      [claimProbes(boundaryHome, want).length, 1]);
  }
  const bad = cases.map(([got, want], i) => (got === want ? null : `${i} (${got})`)).filter((i) => i !== null);
  if (bad.length) fail++;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} recovery probes     ${cases.length} cases${bad.length ? ` — failing #${bad.join(', #')}` : ''}`);
}
// Company quota must never change a browser-ready personal pick, its approvals or browser launch flags.
{
  const SOL = 'gpt-6.1-sol', ASTRA = 'gpt-6-astra';
  const home = fs.mkdtempSync(path.join(tmp, 'browser-quota-'));
  const bucket = (depleted) => ({ used: depleted ? 100 : 20, limit: 100, remaining: depleted ? 0 : 80,
    depleted, resetsAt: now + h });
  try {
    for (const company of [[], [tt({ healthy: false, quotaOut: { resetsAt: now + h } })], [tt({ browser: false })]]) {
      for (const astraDepleted of [false, true]) {
        const personal = [acc('main', 20, 120), acc('b', 30, 100, [], { browser: true })];
        const trae = tr({ home, models: [SOL, ASTRA, 'deepseek-v4.1-flash'],
          quota: { daily: { [SOL]: bucket(true), [ASTRA]: bucket(astraDepleted) } } });
        S.browserQuota = { claude: cl(10, 120), codex: [...personal, ...company, trae] };
        S.browserQuotaBaseline = { ...S.browserQuota, codex: [...personal, ...company, { ...trae, quota: null }] };
        for (const cat of ['browser', 'ui-browser', 'computer-use']) {
          const args = [cat, ...(cat === 'computer-use' ? ['--apps', 'com.apple.Notes'] : ['--origins', 'example.com'])];
          const baseline = JSON.parse(run('browserQuotaBaseline', args)), routed = JSON.parse(run('browserQuota', args));
          assert.equal(routed.pick.model, SOL); assert.equal(routed.pick.account, 'b');
          assert.deepEqual(routed.pick, baseline.pick); assert.deepEqual(routed.needsUserOK, baseline.needsUserOK);
          assert.equal(routed.balance?.selected ?? false, false);
          assert.ok(!routed.why.some((s) => /bucket is depleted|background:|balanced to TRAE/.test(s)));
          const exhaustedArgs = [...args, '--failures', '20'];
          const exhausted = JSON.parse(run('browserQuota', exhaustedArgs));
          assert.ok(exhausted.needsUserOK.length > 0);
          assert.deepEqual(exhausted.needsUserOK, JSON.parse(run('browserQuotaBaseline', exhaustedArgs)).needsUserOK);
          const background = JSON.parse(run('browserQuota', [...args, '--background']));
          assert.equal(background.pick, null); assert.ok(background.deferred); assert.deepEqual(background.needsUserOK, []);
        }
      }
    }
    console.log('ok   browser quota isolation: absent/out/unready TTADK, depleted Sol/Astra, personal approvals and background');
  } catch (e) { fail++; console.log(`FAIL browser quota isolation: ${e.stack}`); }
}
// TRAE's per-model daily high-priority quota and weekly pool (user-approved 2026-11-13): a depleted bucket only moves
// that model into TRAE's low-priority queue; new dispatches prefer comparable GPT quota, then eligible fallbacks.
{
  const { traeQuota, analyze, leanLines } = await import('../lib/state.mjs');
  const sec = 1_800_000_000, day = 86400;
  const q = traeQuota({
    dailyUsage: [
      { quotaKey: 'gpt_6_1', quotaLimit: '80', quotaUsed: '80', quotaRemaining: '0', usagePercent: 100, isDepleted: true, periodStart: sec, resetTime: sec + 6 * 3600 },
      { quotaKey: 'gpt_6_astra', quotaLimit: '40', quotaUsed: '10', quotaRemaining: '30', isDepleted: false, resetTime: sec + 6 * 3600 },
      { quotaKey: 'gpt_6', quotaLimit: '10', quotaUsed: '4' },
    ],
    usage: { usage_percent: 50, quota_remaining: '1000', quota_limit: '2000', is_depleted: false, reset_time: sec + day },
    modelQuotas: { 'gpt-6.1-sol': 'gpt_6_1', 'gpt-6-astra': 'gpt_6_astra', 'seed-evolving': null },
  });
  const noModel = traeQuota({ dailyUsage: [{ quotaKey: 'gpt_6_1', quotaLimit: '10', quotaUsed: '10', quotaRemaining: '0', isDepleted: true }] });
  const cases = [
    [q.daily['gpt-6.1-sol'].depleted, true], [q.daily['gpt-6.1-sol'].used, 80], [q.daily['gpt-6.1-sol'].limit, 80],
    [q.daily['gpt-6.1-sol'].remaining, 0], [q.daily['gpt-6.1-sol'].resetsAt, (sec + 6 * 3600) * 1000], [q.daily['gpt-6.1-sol'].quotaKey, 'gpt_6_1'],
    [q.daily['gpt-6-astra'].depleted, false], [q.daily['gpt-6-astra'].remaining, 30],
    [q.daily.gpt_6.remaining, 6], [q.daily.gpt_6.depleted, false], [q.daily.gpt_6.resetsAt, null],
    [q.weekly.used, 1000], [q.weekly.limit, 2000], [q.weekly.remaining, 1000], [q.weekly.depleted, false], [q.weekly.resetsAt, (sec + day) * 1000],
    [noModel.daily.gpt_6_1.depleted, true], [noModel.weekly, null],
    [traeQuota({ dailyUsage: [], usage: null }), null], [traeQuota({}), null], [traeQuota(null), null], [traeQuota('nope'), null],
  ];
  const bucket = (used, extra = {}) => ({ used, limit: 100, remaining: 100 - used, depleted: used >= 100, resetsAt: now + 6 * h, ...extra });
  const quota = { daily: { 'gpt-6.1-sol': bucket(100), 'gpt-6-astra': bucket(20) }, weekly: null };
  const qh = fs.mkdtempSync(path.join(tmp, 'trae-quota-'));
  const data = { claude: cl(10, 120), codexAccounts: [acc('main', 20, 120), tr({ home: qh, quota })] };
  process.env.TRAE_PROBE = '0';
  const st = analyze(data);
  const lean = leanLines(st, data).join('\n');
  delete process.env.TRAE_PROBE;
  S.traeQuota = { claude: cl(10, 120), codex: [acc('main', 20, 120), tr({ home: qh, quota })] };
  const ro = JSON.parse(run('traeQuota', ['implement']));
  cases.push(
    [lean.includes("TRAE gpt-6.1-sol's daily high-priority quota is used up"), true],
    [ro.pick.model, 'gpt-6-astra'], [ro.pick.account, 'trae'],
    [ro.why.some((n) => /bucket is depleted.*comparable GPT with quota left/.test(n)), true],
    [ro.needsUserOK.length, 0], [ro.failures, 0],
  );
  const ids = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.6-sol', 'deepseek-v4.1-flash', 'deepseek-v4-pro'];
  const scenario = (name, daily, extra = {}) => {
    S[name] = { claude: cl(10, 120), codex: [acc('main', 20, 120), tr({ home: qh, models: ids,
      modelIds: Object.fromEntries(ids.map((m) => [m, m.toUpperCase()])), quota: daily == null ? null : { daily, weekly: null }, ...extra })] };
  };
  scenario('quotaAstra', quota.daily);
  scenario('quotaPreferred', { ...quota.daily, 'gpt-5.6-sol': bucket(10) });
  scenario('quota56Depleted', { ...quota.daily, 'gpt-5.6-sol': bucket(100) });
  scenario('quota56Expired', { ...quota.daily, 'gpt-5.6-sol': bucket(10, { resetsAt: now - 1 }) });
  scenario('quotaBoth', { ...quota.daily, 'gpt-6-astra': bucket(100), 'gpt-5.6-sol': bucket(10) });
  scenario('quotaMissing', null);
  scenario('quotaMissingModel', { 'gpt-6-astra': bucket(100) });
  scenario('quotaUnknownAstra', { 'gpt-6.1-sol': bucket(100) });
  scenario('quotaBusy', quota.daily, { active: 1000 });
  scenario('quotaAllBusy', { ...quota.daily, 'gpt-6-astra': bucket(100) }, { models: ['gpt-6.1-sol', 'gpt-6-astra'] });
  scenario('quota80', { 'gpt-6.1-sol': bucket(80) });
  scenario('quota79', { 'gpt-6.1-sol': bucket(79) });
  scenario('quotaNoLimit', { 'gpt-6.1-sol': bucket(80, { limit: null }) });
  scenario('quotaNoReset', { 'gpt-6.1-sol': bucket(80, { resetsAt: null }) });
  scenario('quotaChosen80', { 'gpt-6.1-sol': bucket(100), 'gpt-6-astra': bucket(80) });
  scenario('quotaFallbackBusy', { ...quota.daily, 'deepseek-v4.1-flash': bucket(100) });
  scenario('quotaNoAstra', quota.daily, { models: ids.filter((m) => m !== 'gpt-6-astra') });
  scenario('quotaSecondFallback', { ...quota.daily, 'gpt-6-astra': bucket(100), 'deepseek-v4.1-flash': bucket(100) });
  scenario('quotaExpiredSol', { ...quota.daily, 'gpt-6.1-sol': bucket(100, { resetsAt: now - 1 }) });
  scenario('quotaExpiredAstra', { ...quota.daily, 'gpt-6-astra': bucket(20, { resetsAt: now - 1 }) });
  scenario('quotaExpiredFallback', { 'gpt-6.1-sol': bucket(100), 'deepseek-v4.1-flash': bucket(100, { resetsAt: now - 1 }) });
  const pausedHome = fs.mkdtempSync(path.join(tmp, 'quota-astra-paused-'));
  const { noteFailure } = await import('../lib/trae-health.mjs');
  noteFailure(pausedHome, '-32600: model `gpt-6-astra` is unavailable because its metadata could not be resolved', now, 'gpt-6-astra');
  scenario('quotaPausedAstra', quota.daily, { home: pausedHome });
  const paused56Home = fs.mkdtempSync(path.join(tmp, 'quota-56-paused-'));
  noteFailure(paused56Home, '-32600: model `gpt-5.6-sol` is unavailable because its metadata could not be resolved', now, 'gpt-5.6-sol');
  scenario('quota56Paused', S.quotaPreferred.codex.at(-1).quota.daily, { home: paused56Home });
  S.quotaTT = { ...S.quotaAstra, codex: [tt({ usage: { used: 80, limit: 100, utilization: 80, resetsAt: now + 6 * h } }), ...S.quotaAstra.codex] };
  const route = (sc, args = ['implement']) => JSON.parse(run(sc, args));
  const note = (r, re) => r.notes.some((n) => re.test(n));
  for (const [sc, args, want] of [
    ['quotaAstra', ['implement'], 'gpt-6-astra'],
    ['quotaPreferred', ['implement'], 'gpt-5.6-sol'],
    ['quotaPreferred', ['implement', '--failures', '1'], 'gpt-5.6-sol'],
    ['quotaPreferred', ['implement', '--stakes', 'high'], 'gpt-5.6-sol'],
    ['quotaPreferred', ['review'], 'gpt-5.6-sol'],
    ['quotaPreferred', ['review-high'], 'gpt-5.6-sol'],
    ['quotaPreferred', ['build-run'], 'gpt-5.6-sol'],
    ['quotaPreferred', ['image-read'], 'gpt-6-astra'], // 5.6-Sol vision is not qualified
    ['quotaPreferred', ['implement', '--security'], 'deepseek-v4.1-flash'],
    ['quotaPreferred', ['implement', '--exclude-model', 'gpt-5.6-sol'], 'gpt-6-astra'],
    ['quota56Depleted', ['implement'], 'gpt-6-astra'],
    ['quota56Expired', ['implement'], 'gpt-6-astra'],
    ['quota56Paused', ['implement'], 'gpt-6-astra'],
    ['quotaBoth', ['implement'], 'gpt-5.6-sol'],
    ['quotaBoth', ['implement', '--failures', '5'], 'gpt-5.6-sol'], // the raw pick is depleted Astra
    ['quotaBoth', ['implement-hard'], 'gpt-5.6-sol'],
    ['quotaBoth', ['lookup'], 'gpt-5.6-sol'],
    ['quotaBoth', ['extract'], 'gpt-5.6-sol'],
    ['quotaBoth', ['draft'], 'gpt-5.6-sol'],
    ['quotaBoth', ['lookup', '--stakes', 'high'], 'gpt-5.6-sol'],
    ['quotaBoth', ['lookup', '--failures', '1'], 'gpt-5.6-sol'],
    ['quotaBoth', ['build-run'], 'gpt-5.6-sol'],
    ['quotaMissing', ['implement'], 'gpt-6.1-sol'],
    ['quotaMissingModel', ['implement'], 'gpt-6.1-sol'],
    ['quotaUnknownAstra', ['implement'], 'deepseek-v4.1-flash'],
    ['quotaNoAstra', ['implement'], 'deepseek-v4.1-flash'],
    ['quotaPausedAstra', ['implement'], 'deepseek-v4.1-flash'],
    ['quotaSecondFallback', ['implement'], 'deepseek-v4-pro'],
    ['quotaAstra', ['implement', '--exclude-model', 'gpt-6-astra'], 'deepseek-v4.1-flash'],
    ['quotaAstra', ['implement', '--exclude-model', 'gpt'], 'deepseek-v4.1-flash'],
    ['quotaAstra', ['implement', '--security'], 'deepseek-v4.1-flash'],
    ['quotaAstra', ['implement', '--failures', '1'], 'gpt-6-astra'],
    ['quotaFallbackBusy', ['implement', '--failures', '2'], 'gpt-6-astra'],
    ['quotaAllBusy', ['implement'], 'gpt-6.1-sol'],
    ['quotaTT', ['implement'], 'gpt-6.1-sol'], // healthy TTADK remains first
    ['quotaExpiredSol', ['implement'], 'gpt-6.1-sol'],
    ['quotaExpiredAstra', ['implement'], 'deepseek-v4.1-flash'],
    ['quotaExpiredFallback', ['implement'], 'deepseek-v4.1-flash'],
  ]) {
    const r = route(sc, args);
    cases.push([r.pick.model, want], [r.failures, args.includes('--failures') ? Number(args[args.indexOf('--failures') + 1]) : 0]);
  }
  const idle = route('quotaAstra'), busy = route('quotaBusy'), missing = route('quotaMissing');
  cases.push(
    [route('quotaPreferred').pick.effort, idle.pick.effort],
    [route('quotaPreferred', ['implement', '--failures', '1']).pick.effort, 'xhigh'],
    [route('quotaPreferred').pick.command.includes('--model GPT-5.6-SOL'), true],
    [route('quotaPreferred', ['lookup']).pick.command.includes('-m GPT-5.6-SOL'), true],
    [route('quotaPreferred', ['implement', '--failures', '1']).notes.some((n) => /rework thread rule.*continued original thread because/.test(n)), true],
    [route('quotaPreferred').notes.some((n) => /rework thread rule/.test(n)), false],
    [JSON.stringify(busy.pick), JSON.stringify(idle.pick)], [JSON.stringify(busy.needsUserOK), JSON.stringify(idle.needsUserOK)],
    [busy.deferred, null], [note(busy, /parallel task concurrency unchanged/), true],
    [missing.why.some((n) => /bucket is depleted/.test(n)), false],
    [route('quotaExpiredSol').why.some((n) => /bucket is depleted/.test(n)), false],
    [note(idle, /above ~300.*depleted.*--exclude-model <that model>.*same --failures/), true],
    [note(idle, /non-depleted or unknown buckets let it wait.*Accepted queued turns stay pending/), true],
    [note(route('quotaAllBusy'), /--exclude-model gpt-6.1-sol.*same --failures/), true],
    [route('quotaBoth').needsUserOK.length, 0], [route('quotaAllBusy').deferred, null],
    [route('quotaAstra', ['lookup']).pick.launcher, 'codex-worker'],
    [route('quotaBoth', ['lookup']).pick.launcher, 'traecli-exec'],
    [note(route('quotaBoth', ['lookup', '--failures', '1']), /this retry is not stronger/), false],
    [route('quotaTT').pick.account, 'ttadk'],
    [note(route('quotaAstra', ['review', '--author', 'codex']), /second TRAE reviewer/), true],
    [route('quotaAstra', ['review', '--author', 'codex']).secondOpinion?.model, 'deepseek-v4.1-flash'],
  );
  // Advice uses the chosen bucket, is inclusive at 80%, and never defers work or changes the pick.
  for (const cat of ['build-run', 'review', 'review-high']) {
    for (const [sc, expected] of [['quota80', true], ['quota79', false], ['quotaNoLimit', false], ['quotaMissing', false], ['quotaChosen80', true], ['quotaTT', true], ['quotaNoReset', true]]) {
      const r = route(sc, [cat]);
      cases.push([note(r, /long builds\/large reviews:.*daily reset/), expected], [r.deferred, null]);
    }
  }
  cases.push([note(route('quota80'), /long builds\/large reviews:/), false],
    [note(route('quota80', ['build-run']), /quota resetTime.*TRAE normally 22:00 UTC, TTADK 16:00 UTC/), true],
    [note(route('quotaNoReset', ['build-run']), /normally 22:00 UTC/), true]);
  const bad = cases.map(([got, want], i) => (got === want ? null : `${i} (${got})`)).filter((i) => i !== null);
  if (bad.length) fail++;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} trae daily quota    ${cases.length} cases${bad.length ? ` — failing #${bad.join(', #')}` : ''}`);
}
// Approved nightly decision 2026-11-10-1: an idle weekly deadline can move without a card redemption.
// Exercise the real review-data CLI on quota history, with all external reads isolated from live accounts.
{
  const bin = path.join(tmp, 'quota-bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nprintf \'{"models":[]}\\n\'\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nprintf \'fixture\\n\'\n', { mode: 0o755 });
  const cards = [{ id: 'keep', expiresAt: now + 200 * h }, { id: 'spent', expiresAt: now + 200 * h }];
  const a = (name, used, resetsAt, cs = cards) => ({ name, used, resetsAt, cards: cs });
  const before = { t: now - 2 * h, claude: { used: 99, resetsAt: now - h }, codex: [
    a('idle', 0, now + 165 * h), a('natural', 100, now - h), a('redeemed', 99, now + 24 * h),
    a('expired', 80, now + 24 * h, [{ id: 'expired', expiresAt: now - h }]),
    a('unknown', 50, now + 24 * h), a('backward', 40, now + 168 * h),
    a('near-expiry', 90, now - 0.4 * h),
  ] };
  const after = { t: now - 0.5 * h, claude: { used: 0, resetsAt: now + 167 * h }, codex: [
    a('idle', 0, now + 167 * h), a('natural', 0, now + 167 * h), a('redeemed', 0, now + 167 * h, cards.slice(0, 1)),
    a('expired', 0, now + 167 * h, []),
    a('unknown', 0, now + 167 * h), a('backward', 40, now + 165 * h),
    a('near-expiry', 0, now + 167 * h, cards.slice(0, 1)),
  ] };
  const history = path.join(tmp, 'quota-history.jsonl');
  fs.writeFileSync(history, [before, after, { ...after, t: now - 0.25 * h }].map((s) => JSON.stringify(s)).join('\n') + '\n');
  const cache = path.join(tmp, 'quota-review-cache.json');
  fs.writeFileSync(cache, JSON.stringify({ checkedAt: now, claude: cl(10, 120), codexAccounts: [], errors: {}, history: {} }));
  const profiles = path.join(tmp, 'quota-profiles.json'); fs.writeFileSync(profiles, '{}');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, QUOTA_CACHE: cache, CODEX_ACCOUNTS: profiles,
    ROUTE_LOG_FILE: path.join(tmp, 'empty-route-log'), QUOTA_LOG_FILE: history, ROUTE_LOG: '0', QUOTA_LOG: '0', TRAE_PROBE: '0' };
  const review = path.join(path.dirname(ROUTE), 'review-data.mjs');
  const q = JSON.parse(execFileSync(process.execPath, [review, '--hours', '24', '--json'], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] })).quota;
  const reset = (who) => q.resets.find((r) => r.who === who);
  const cases = [
    [q.resets.length, 4], [reset('claude')?.kind, 'natural reset'], [reset('claude')?.unused, 1],
    [reset('codex:natural')?.kind, 'natural reset'], [reset('codex:natural')?.unused, 0],
    [reset('codex:redeemed')?.kind, 'early restart (card)'], [reset('codex:redeemed')?.usedBefore, 99],
    [reset('codex:near-expiry')?.kind, 'early restart (card)'],
    [!!reset('codex:idle'), false], [!!reset('codex:expired'), false],
    [!!reset('codex:unknown'), false], [!!reset('codex:backward'), false],
    [q.cardsExpired.length, 1], [q.cardsRedeemed.length, 2],
  ];
  const bad = cases.map(([got, want], i) => (got === want ? null : `${i} (${got})`)).filter((i) => i !== null);
  if (bad.length) fail++;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} quota reset history ${cases.length} cases${bad.length ? ` — failing #${bad.join(', #')}` : ''}`);
}
// Company balancing leaves the model/effort, escalation and number of launches alone.
{
  const { BALANCE, balanceFactors, ttadkBurn } = await import('../lib/company-load.mjs');
  const SOL = 'gpt-6.1-sol', ASTRA = 'gpt-6-astra', min = 60000;
  const home = fs.mkdtempSync(path.join(tmp, 'balance-'));
  const usage = (used = 40, resetsAt = now + 8 * h) => ({ used, limit: 100, resetsAt });
  const bucket = (used = 38, extra = {}) => ({ ...usage(used), depleted: false, ...extra });
  const load = (percent = 35, t = now) => ({ [SOL]: { percent, t } });
  const queue = (position = 100, t = now, extra = {}) => ({ gpt: { t, position, state: 'queued', lowPriority: false, ...extra } });
  const scenario = (key, trExtra = {}, ttExtra = {}) => {
    S[key] = { claude: cl(10, 120), codex: [acc('main', 20, 120), tt({ search: true, usage: usage(), seenAt: now, ...ttExtra }),
      tr({ home, load: load(), quota: { daily: { [SOL]: bucket() } }, ...trExtra })] };
  };
  scenario('balanced');
  scenario('balancedBusy', { active: 10000 }, { active: 10000 });
  scenario('balancedReserve', { quota: { daily: { [SOL]: bucket(85) } } });
  scenario('balancedBelow', { quota: { daily: { [SOL]: bucket(85.1) } } });
  scenario('balancedDepleted', { quota: { daily: { [SOL]: bucket(38, { depleted: true }) } } });
  scenario('balancedNoBucket', { quota: null });
  scenario('balancedOldBucket', { quota: { daily: { [SOL]: bucket(38, { resetsAt: now - 1 }) } } });
  scenario('balancedNoLimit', { quota: { daily: { [SOL]: bucket(38, { limit: null }) } } });
  scenario('balancedHot', { load: load(60) });
  scenario('balancedCool', { load: load(59.9) });
  scenario('balancedNoLoad', { load: {} });
  scenario('balancedOldLoad', { load: load(90, now - 31 * min) });
  scenario('balancedExpires', { quota: { daily: { [SOL]: bucket(38, { resetsAt: now + 5 * h }) } } });
  scenario('balancedLater', { quota: { daily: { [SOL]: bucket(38, { resetsAt: now + 7 * h }) } } });
  scenario('balancedLessLeft', { quota: { daily: { [SOL]: bucket(60, { resetsAt: now + 5 * h }) } } });
  scenario('balancedDown', { healthy: false });
  scenario('balancedOut', {}, { healthy: false, quotaOut: { resetsAt: now + h } });
  const history = path.join(home, 'history.jsonl');
  const samples = [120, 90, 60].map((m, i) => ({ t: now - m * min + 1000, ttadk: { name: 'ttadk', ...usage(10 + i * 10) } }));
  fs.writeFileSync(history, samples.map((r) => JSON.stringify(r)).join('\n') + '\nnot-json\n');
  const r = (key = 'balanced', args = ['lookup'], q = queue(), env = {}) => {
    fs.writeFileSync(path.join(home, 'queue-state.json'), JSON.stringify(q));
    return JSON.parse(run(key, args, env));
  };
  const cases = [];
  const account = (key, args, q, env) => r(key, args, q, env).pick.account;
  for (const args of [['lookup'], ['extract'], ['draft'], ['analysis', '--stakes', 'low'], ['implement', '--impact', 'throwaway']])
    cases.push([account('balanced', args), 'trae']);
  for (const key of ['balancedBelow', 'balancedDepleted', 'balancedNoBucket', 'balancedOldBucket', 'balancedNoLimit', 'balancedHot', 'balancedDown'])
    cases.push([account(key), 'ttadk']);
  for (const key of ['balancedReserve', 'balancedCool', 'balancedBusy', 'balancedNoLoad', 'balancedOldLoad'])
    cases.push([account(key), 'trae']);
  for (const args of [['analysis'], ['implement'], ['review'], ['build-run', '--stakes', 'low'], ['browser'], ['ui-browser'], ['computer-use'], ['image-read', '--stakes', 'low'], ['lookup', '--security'], ['lookup', '--exclude-account', 'trae']])
    cases.push([account('balanced', args), 'ttadk']);
  cases.push([r('balanced', ['image-gen']).pick.account, 'main']);
  cases.push([account('balanced', ['lookup'], queue(300)), 'trae'], [account('balanced', ['lookup'], queue(301)), 'ttadk']);
  cases.push([account('balanced', ['lookup'], queue(301, now - 31 * min)), 'trae'], [account('balanced', ['lookup'], {}), 'trae']);
  cases.push([account('balanced', ['lookup'], queue(1, now, { high: { t: now - 10 * min, position: 3100 } })), 'ttadk']);
  cases.push([account('balanced', ['lookup'], queue(1, now, { high: { t: now - 31 * min, position: 3100 } })), 'trae']);
  // Family isolation: other families' queues never count against GPT.
  cases.push([account('balanced', ['lookup'], { ...queue(), deepseek: { t: now, position: 5000, state: 'queued' } }), 'trae']);
  cases.push([account('balancedExpires', ['analysis']), 'trae'], [account('balancedLater', ['analysis']), 'ttadk'],
    [account('balancedLessLeft', ['analysis']), 'ttadk'], [account('balancedExpires', ['analysis'], {}), 'ttadk']);
  const env = { QUOTA_LOG_FILE: history };
  const projected = r('balanced', ['implement'], queue(), env);
  cases.push([projected.pick.account, 'trae'], [projected.balance.burn.beforeReset, true],
    [projected.why.some((s) => /balanced to TRAE:.*TTADK projected to run out at .* UTC.*62% left.*load 35%/.test(s)), true],
    [account('balancedNoLoad', ['implement'], queue(), env), 'ttadk'], [account('balanced', ['implement'], {}, env), 'ttadk'],
    [account('balanced', ['implement'], queue(400), env), 'ttadk'], [account('balancedOut', ['implement'], queue(400)), 'trae']);
  // Balancing transfers the current rung; it never substitutes an excluded/paused model or changes review count.
  scenario('balancedAstra', { quota: { daily: { [ASTRA]: bucket() } }, load: { [ASTRA]: { t: now, percent: 10 } } }, { models: [SOL, ASTRA] });
  const pausedHome = fs.mkdtempSync(path.join(tmp, 'balance-paused-'));
  const { noteFailure } = await import('../lib/trae-health.mjs');
  noteFailure(pausedHome, 'Model access temporarily restricted. (983)', now, SOL);
  scenario('balancedPaused', { home: pausedHome });
  cases.push([account('balancedPaused'), 'ttadk']);
  const idle = r(), busy = r('balancedBusy'), review = r('balanced', ['review', '--author', 'codex', '--stakes', 'low']);
  cases.push([idle.pick.account, busy.pick.account], [idle.pick.effort, busy.pick.effort], [idle.deferred, null],
    [idle.needsUserOK.length, 0], [review.pick.account, 'trae'], [review.secondOpinion.account, 'ttadk'],
    [r('balanced', ['review', '--author', 'codex']).secondOpinion.model, review.secondOpinion.model],
    [idle.notes.some((s) => /balanced from TTADK/.test(s)), true]);
  // Exact time/share boundaries and synthetic burn-rate failures.
  const ttAccount = { name: 'ttadk', usage: usage() };
  const factors = (q) => balanceFactors({ ttadk: ttAccount, trae: { quota: { daily: { [SOL]: q } }, load: load(), queue: queue() },
    model: SOL, category: 'analysis', stakes: 'normal', now });
  cases.push([factors(bucket(38, { resetsAt: now + BALANCE.expiresH * h })).expiresSoon, false],
    [factors(bucket(40, { resetsAt: now + h })).expiresSoon, false]);
  const burn = (rows, a = ttAccount, stamp = now) => ttadkBurn(rows, a, stamp, now);
  cases.push([burn(samples).beforeReset, true], [burn([]), null], [burn(samples, ttAccount, now - 31 * min), null],
    [burn(samples.map((s) => ({ ...s, ttadk: { ...s.ttadk, used: 40 } }))), null],
    [burn(samples.map((s) => ({ ...s, ttadk: { ...s.ttadk, resetsAt: now - h } }))), null],
    [burn(samples.map((s) => ({ ...s, ttadk: { ...s.ttadk, limit: 200 } }))), null],
    [burn(samples.map((s) => ({ ...s, t: now - 5 * min }))), null],
    [burn(samples.map((s) => ({ ...s, ttadk: { ...s.ttadk, used: 90 } }))), null]);
  const log = path.join(home, 'route-log.jsonl');
  r('balanced', ['implement'], queue(), { ...env, ROUTE_LOG: '1', ROUTE_LOG_FILE: log });
  const logged = JSON.parse(fs.readFileSync(log, 'utf8').trim());
  cases.push([logged.company, 'trae'], [logged.balance.selected, true], [logged.balance.load.percent, 35], [logged.balance.burn.beforeReset, true]);
  const bad = cases.map(([got, want], i) => JSON.stringify(got) === JSON.stringify(want) ? null : `${i + 1}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`).filter(Boolean);
  if (bad.length) fail++;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} company balancing ${cases.length} cases${bad.length ? ` — ${bad.join('; ')}` : ''}`);
}
// Explicit background work can wait on TRAE and must never consume personal quota, even on later ladder rungs.
{
  const SOL = 'gpt-6.1-sol', FLASH = 'deepseek-v4.1-flash';
  const home = fs.mkdtempSync(path.join(tmp, 'background-'));
  const depleted = { used: 100, limit: 100, remaining: 0, depleted: true, resetsAt: now + h };
  const trae = tr({ home, models: [SOL, 'gpt-6-astra', FLASH], load: { [SOL]: { percent: 99, t: now } },
    quota: { daily: { [SOL]: depleted, 'gpt-6-astra': { ...depleted, depleted: false, remaining: 50 } } } });
  fs.writeFileSync(path.join(home, 'queue-state.json'), JSON.stringify({ gpt: { t: now, position: 4000, state: 'queued', lowPriority: true } }));
  S.background = { claude: cl(10, 120), codex: [acc('main', 20, 120), tt(), trae] };
  S.backgroundOnly = { ...S.background, codex: [acc('main', 20, 120), trae] };
  S.backgroundNoModels = { ...S.background, codex: [acc('main', 20, 120), tr({ home, models: ['seed-evolving'] })] };
  S.backgroundGemini = { ...S.background, codex: [tr({ home, live: false, models: ['gemini-3.1-pro-preview'] })] };
  const r = (args, scenario = 'background', env) => JSON.parse(run(scenario, args, env));
  try {
    for (const args of [['lookup'], ['analysis'], ['implement'], ['docs'], ['research']]) {
      const o = r([...args, '--background']);
      assert.equal(o.pick.account, 'trae'); assert.equal(o.pick.model, SOL);
      assert.equal(o.pick.launcher, 'codex-worker'); assert.equal(o.background, true);
      assert.ok(o.why.some((n) => /background: GPT-6.1-Sol bucket depleted.*no high-priority quota spent \(step 1\)/.test(n)));
      assert.ok(o.notes.some((n) => /expect hours.*each model request queues separately/.test(n)));
      assert.ok(!o.notes.some((n) => /Above ~300, consider|hub queue position above ~300/.test(n)));
    }
    assert.equal(r(['lookup']).pick.account, 'ttadk');
    assert.equal(r(['--background', 'lookup']).pick.account, 'trae');
    const gemini = r(['lookup', '--background'], 'backgroundGemini');
    assert.equal(gemini.pick.launcher, 'codex-worker');
    assert.ok(gemini.notes.some((n) => /hub is down.*start it first/.test(n)));
    assert.ok(!gemini.notes.some((n) => /twice what the task should take|codex exec still works/.test(n)));
    assert.equal(r(['implement'], 'backgroundOnly').pick.model, 'gpt-6-astra');
    assert.equal(r(['implement', '--background'], 'backgroundOnly').pick.model, SOL);
    assert.equal(r(['lookup', '--background', '--security']).pick.model, FLASH);
    assert.equal(r(['lookup', '--background', '--security']).pick.account, 'trae');
    for (const args of [['review', '--security'], ['review-high', '--security'], ['lookup', '--exclude-model', 'gpt,deepseek']]) {
      const o = r([...args, '--background'], 'backgroundOnly');
      assert.equal(o.pick, null); assert.ok(o.deferred); assert.equal(o.secondOpinion, null);
      assert.ok(o.tellUser.some((n) => /queued for later/.test(n))); assert.deepEqual(o.needsUserOK, []);
    }
    assert.equal(r(['image-read', '--background']).pick.account, 'trae');
    for (const args of [['browser'], ['ui-browser'], ['computer-use'], ['build-run'], ['image-read', '--device-lease'], ['lookup', '--device-lease'], ['lookup', '--shared-lock']]) {
      const o = r([...args, '--background']);
      assert.equal(o.pick.account, 'ttadk'); assert.ok(!o.why.some((n) => n.startsWith('background:')));
    }
    assert.equal(r(['lookup', '--background', '--exclude-account', 'trae']).pick.account, 'ttadk');
    assert.equal(r(['lookup', '--background', '--exclude-model', SOL]).pick.model, FLASH);
    for (const scenario of ['backgroundNoModels', 'ttOutTraeDown', 'fresh', 'unreadable']) {
      const o = r(['lookup', '--background', '--urgent'], scenario);
      assert.equal(o.pick, null); assert.equal(o.secondOpinion, null); assert.equal(o.redeemFirst, null);
      assert.ok(o.tellUser.some((n) => /queued for later/.test(n))); assert.deepEqual(o.needsUserOK, []);
    }
    for (const args of [['implement', '--failures', '20'], ['design'], ['review-high'], ['review', '--author', 'codex'], ['second-opinion', '--against', 'codex']]) {
      const o = r([...args, '--background']);
      for (const p of [o.pick, o.secondOpinion].filter(Boolean)) { assert.equal(p.vendor, 'codex'); assert.equal(p.account, 'trae'); }
      assert.ok(!o.needsUserOK.some((n) => /personal quota/.test(n)));
    }
    const log = path.join(home, 'routes.jsonl');
    r(['lookup', '--background', '--project', 'p', '--name', 'nightly'], 'background', { ROUTE_LOG: '1', ROUTE_LOG_FILE: log });
    const logged = JSON.parse(fs.readFileSync(log, 'utf8'));
    assert.equal(logged.background, true); assert.equal(logged.pick.account, 'trae');
    console.log('ok   background lane: depletion, congestion, security, exclusions, launch, log and company-only escalation');
  } catch (e) { fail++; console.log(`FAIL background lane: ${e.stack}`); }
}
// Background chooses depleted GPT buckets, then eligible no-bucket models, then reports normal quota spend.
{
  const SOL = 'gpt-6.1-sol', ASTRA = 'gpt-6-astra', FLASH = 'deepseek-v4.1-flash', PRO = 'deepseek-v4-pro', SEED = 'seed-evolving';
  const home = fs.mkdtempSync(path.join(tmp, 'background-order-'));
  const ids = [SOL, ASTRA, FLASH, PRO, SEED];
  const bucket = (depleted = false) => ({ used: depleted ? 100 : 20, limit: 100, remaining: depleted ? 0 : 80, depleted, resetsAt: now + h });
  const active = { [SOL]: bucket(), [ASTRA]: bucket() };
  const expired = (depleted = false) => ({ ...bucket(depleted), resetsAt: now - 1 });
  const scenario = (daily, models = ids, extra = {}) => {
    S.backgroundOrder = { claude: cl(10, 120), codex: [acc('main', 20, 120), tr({ home, models,
      modelIds: Object.fromEntries(models.map((id) => [id, id])), quota: daily === null ? null : { daily }, ...extra })] };
  };
  const r = (args = ['analysis']) => JSON.parse(run('backgroundOrder', [...args, '--background']));
  const cases = [
    [{ ...active, [SOL]: bucket(true) }, ['analysis'], SOL, 1],
    [{ ...active, [ASTRA]: bucket(true) }, ['analysis'], ASTRA, 1],
    [{ [SOL]: bucket(true), [ASTRA]: bucket(true) }, ['lookup'], SOL, 1],
    [{ [ASTRA]: bucket(true) }, ['analysis'], ASTRA, 1, [ASTRA]],
    [{ ...active, [ASTRA]: bucket(true) }, ['analysis', '--exclude-model', ASTRA], FLASH, 2],
    [{ [SOL]: bucket(true), [ASTRA]: bucket(true) }, ['analysis', '--exclude-model', SOL], ASTRA, 1],
    [active, ['analysis'], FLASH, 2],
    [active, ['analysis', '--exclude-model', FLASH], PRO, 2],
    [{ ...active, [FLASH]: bucket() }, ['analysis'], PRO, 2],
    [{ ...active, [FLASH]: { used: null, limit: null, remaining: null, depleted: false, resetsAt: null }, [PRO]: bucket() }, ['analysis'], SOL, 3],
    [{ ...active, [FLASH]: bucket(), [PRO]: bucket() }, ['analysis'], SOL, 3],
    [active, ['analysis', '--exclude-model', 'deepseek'], SOL, 3],
    [active, ['review-high'], SOL, 3],
    [active, ['review', '--impact', 'release'], SOL, 3],
    [active, ['second-opinion', '--against', 'claude', '--stakes', 'high'], SOL, 3],
    [null, ['analysis'], SOL, 3],
    [{}, ['analysis'], SOL, 3],
    [undefined, ['analysis'], SOL, 3],
    [{ [SOL]: bucket(true), [ASTRA]: bucket(true) }, ['analysis', '--security'], FLASH, 2],
    [active, ['analysis', '--security', '--exclude-model', FLASH], PRO, 2],
    [{ ...active, [FLASH]: bucket(), [PRO]: bucket() }, ['analysis', '--security'], FLASH, 3],
    [null, ['analysis', '--security'], FLASH, 3],
    [{ ...active, [SOL]: bucket(true) }, ['image-read'], SOL, 1],
    [{ ...active, [ASTRA]: bucket(true) }, ['image-read'], ASTRA, 1],
    [active, ['image-read'], SEED, 2],
    [{ ...active, [SOL]: bucket(true) }, ['image-read', '--security'], SEED, 2],
    [{ ...active, [SEED]: bucket() }, ['image-read'], SOL, 3],
    [{ ...active, [SEED]: bucket() }, ['image-read', '--security'], SEED, 3],
    [null, ['image-read'], SOL, 3],
    [null, ['image-read', '--security'], SEED, 3],
    [active, ['image-read', '--exclude-model', SEED], SOL, 3],
    [{ ...active, [SOL]: expired(true) }, ['analysis'], FLASH, 2],
    [{ [SOL]: expired(true), [ASTRA]: expired(true) }, ['analysis'], SOL, 3],
    [{ ...active, [FLASH]: expired(), [PRO]: bucket() }, ['analysis'], SOL, 3],
  ];
  try {
    for (const [daily, args, model, step, models = ids] of cases) {
      scenario(daily, models);
      const o = r(args);
      assert.equal(o.pick?.model, model, `${args.join(' ')} step ${step}`);
      assert.equal(o.pick.account, 'trae'); assert.equal(o.pick.launcher, 'codex-worker');
      assert.ok(o.why.some((n) => n.startsWith('background:') && n.includes(`(step ${step})`)), JSON.stringify(o.why));
      if (step === 3) assert.ok(o.why.some((n) => /normal TRAE pick.*spend[s]? high-priority quota/.test(n)));
      if (args[0] === 'image-read') assert.ok([SOL, ASTRA, SEED].includes(o.pick.model));
      if (args.includes('--security')) assert.ok(!o.pick.model.startsWith('gpt-'));
      assert.ok(!o.needsUserOK.some((n) => /personal quota/.test(n)));
    }
    scenario(active);
    for (const args of [['review-high', '--security'], ['review', '--security'], ['image-read', '--security', '--exclude-model', SEED]]) {
      const o = r(args); assert.equal(o.pick, null); assert.ok(o.tellUser.some((n) => /queued for later/.test(n)));
    }
    // Unknown quota retains the ordinary rung; an Astra rung keeps its tier even if Sol is depleted.
    const args = ['implement', '--failures', '5'];
    scenario(null); assert.equal(r(args).pick.model, ASTRA);
    scenario({ ...active, [SOL]: bucket(true) }); assert.equal(r(args).pick.model, ASTRA);
    // Fallback service code still requires review; sensitive acceptance keeps the stronger family.
    scenario(active);
    assert.ok(r(['implement']).notes.some((n) => /review required.*fallback model/.test(n)));
    const reviewed = r(['review', '--author', 'codex', '--impact', 'release']);
    assert.ok(!reviewed.pick.model.startsWith('deepseek'));
    assert.ok(!reviewed.secondOpinion?.model.startsWith('deepseek'));
    // Model pauses and explicit exclusions apply before quota preference.
    const pausedHome = fs.mkdtempSync(path.join(tmp, 'background-order-paused-'));
    const { noteFailure } = await import('../lib/trae-health.mjs');
    noteFailure(pausedHome, '-32600: model `gpt-6.1-sol` is unavailable because its metadata could not be resolved', now, SOL);
    scenario({ [SOL]: bucket(true), [ASTRA]: bucket(true) }, ids, { home: pausedHome });
    assert.equal(r().pick.model, ASTRA);
    console.log(`ok   background model order: ${cases.length} quota/security/vision cases, tiers, quality gates and pauses`);
  } catch (e) { fail++; console.log(`FAIL background model order: ${e.stack}`); }
}
// 2026-11-13 GPT benchmark: bucket-free GPTs precede depleted lanes and DeepSeek, on TRAE only.
{
  const SOL = 'gpt-6.1-sol', ASTRA = 'gpt-6-astra', SOL56 = 'gpt-5.6-sol', GPT55 = 'gpt-5.5', TERRA56 = 'gpt-5.6-terra';
  const FLASH = 'deepseek-v4.1-flash', PRO = 'deepseek-v4-pro', SEED = 'seed-evolving';
  const ids = [SOL, ASTRA, SOL56, GPT55, TERRA56, FLASH, PRO, SEED, 'gpt-5.6-luna', 'gpt-5.4'];
  const home = fs.mkdtempSync(path.join(tmp, 'bucket-free-gpt-'));
  const bucket = (depleted = false) => ({ used: depleted ? 80 : 20, limit: 80, remaining: depleted ? 0 : 60, depleted, resetsAt: now + h });
  const active = { [SOL]: bucket(), [ASTRA]: bucket(), [SOL56]: bucket() };
  const r = (args, { daily = active, models = ids, company = true, queue = 100, extra = {}, env = {} } = {}) => {
    const trae = tr({ home, models, modelIds: Object.fromEntries(ids.map((id) => [id, id.toUpperCase()])),
      quota: daily === null ? null : { daily }, ...extra });
    fs.writeFileSync(path.join(trae.home, 'queue-state.json'), JSON.stringify({ gpt: { t: now, position: queue, state: 'queued' } }));
    S.bucketFreeGPT = { claude: cl(10, 120), codex: [acc('main', 20, 120), ...(company ? [tt({ models: [SOL] })] : []), trae] };
    return JSON.parse(run('bucketFreeGPT', args, env));
  };
  try {
    for (const cat of ['lookup', 'extract', 'draft']) {
      const balanced = r([cat]), direct = r([cat], { company: false });
      for (const o of [balanced, direct]) {
        assert.equal(o.pick.model, GPT55); assert.equal(o.pick.account, 'trae');
        assert.equal(o.pick.effort, 'medium'); assert.equal(o.pick.launcher, 'traecli-exec');
        assert.ok(o.pick.command.includes('-m GPT-5.5'));
        assert.ok(o.why.some((n) => /no daily bucket.*no high-priority quota spent.*no low-priority lane/.test(n)));
        assert.deepEqual(o.needsUserOK, []);
      }
      assert.equal(balanced.balance.bucketFree, true); assert.equal(balanced.balance.remainingShare, null);
      assert.equal(r([cat], { daily: { ...active, [SOL]: bucket(true) } }).pick.model, GPT55);
      assert.equal(r([cat], { queue: 301 }).pick.account, 'ttadk');
      assert.equal(r([cat, '--exclude-account', 'trae']).pick.account, 'ttadk');
      assert.equal(r([cat, '--security']).pick.account, 'ttadk');
      assert.equal(r([cat, '--exclude-model', GPT55]).pick.model, TERRA56);
      assert.equal(r([cat], { daily: { ...active, [GPT55]: bucket() } }).pick.model, TERRA56);
    }
    for (const args of [['analysis'], ['implement'], ['docs'], ['research'], ['design'], ['review-high']]) {
      const o = r([...args, '--background'], { queue: 4000, extra: { load: { [GPT55]: { t: now, percent: 99 } } } });
      assert.equal(o.pick.account, 'trae'); assert.equal(o.pick.model, GPT55); assert.equal(o.pick.launcher, 'codex-worker');
      assert.ok(o.pick.command.includes('--model GPT-5.5'));
      assert.ok(o.why.some((n) => /background:.*no daily bucket.*no low-priority lane/.test(n)));
      assert.ok(!o.needsUserOK.some((n) => /personal quota/.test(n)));
    }
    assert.equal(r(['analysis', '--background'], { daily: { ...active, [SOL]: bucket(true), [ASTRA]: bucket(true) } }).pick.model, GPT55);
    const terra = r(['analysis', '--background', '--exclude-model', GPT55]);
    assert.equal(terra.pick.model, TERRA56); assert.ok(terra.pick.command.includes('--model GPT-5.6-TERRA'));
    assert.equal(r(['analysis', '--background', '--exclude-model', `${GPT55},${TERRA56}`]).pick.model, FLASH);
    assert.equal(r(['analysis', '--background'], { daily: { ...active, [GPT55]: bucket(), [TERRA56]: bucket() } }).pick.model, FLASH);
    assert.equal(r(['analysis', '--background'], { daily: { ...active, [GPT55]: { ...bucket(), resetsAt: now - 1 } } }).pick.model, TERRA56);
    assert.equal(r(['analysis', '--background'], { models: [GPT55], company: false }).pick.model, GPT55);
    assert.equal(r(['lookup'], { models: [GPT55], company: false }).pick.account, 'trae');
    assert.equal(r(['analysis', '--background', '--security']).pick.model, FLASH);
    assert.equal(r(['analysis', '--background', '--exclude-model', 'gpt']).pick.model, FLASH);
    for (const args of [['review', '--security'], ['review-high', '--security']]) {
      const o = r([...args, '--background'], { company: false });
      assert.equal(o.pick, null); assert.ok(o.deferred); assert.deepEqual(o.needsUserOK, []);
    }
    for (const daily of [null, {}, { [SOL]: null }, { [SOL]: { ...bucket(), resetsAt: now - 1 } }]) {
      assert.equal(r(['analysis', '--background'], { daily }).pick.model, SOL);
      assert.equal(r(['lookup'], { daily }).pick.account, 'ttadk');
      assert.equal(r(['lookup'], { daily, company: false }).pick.model, SOL);
    }
    // Non-cheap foreground work and vision/capability routes are unchanged.
    assert.equal(r(['analysis', '--stakes', 'low']).pick.model, SOL);
    assert.equal(r(['analysis'], { company: false }).pick.model, SOL);
    assert.equal(r(['image-read', '--background']).pick.model, SEED);
    assert.equal(r(['image-read', '--background'], { daily: { ...active, [SOL]: bucket(true) } }).pick.model, SOL);
    assert.equal(r(['image-read'], { company: false, daily: { ...active, [SOL]: bucket(true) } }).pick.model, ASTRA);
    for (const args of [['build-run', '--background'], ['browser', '--background'], ['lookup', '--shared-lock'], ['lookup', '--background', '--device-lease']])
      assert.equal(r(args).pick.account, 'ttadk');
    // Astra escalation and the review count/account survive the new preferences.
    assert.equal(r(['implement', '--background', '--failures', '5'], { company: false }).pick.model, ASTRA);
    const baselineReview = r(['review', '--author', 'codex'], { models: ids.filter((id) => ![GPT55, TERRA56].includes(id)) });
    const review = r(['review', '--author', 'codex']);
    assert.deepEqual(review.pick, baselineReview.pick); assert.deepEqual(review.secondOpinion, baselineReview.secondOpinion);
    const pausedHome = fs.mkdtempSync(path.join(tmp, 'bucket-free-paused-'));
    const { noteFailure } = await import('../lib/trae-health.mjs');
    noteFailure(pausedHome, '-32600: model `gpt-5.5` is unavailable because its metadata could not be resolved', now, GPT55);
    assert.equal(r(['analysis', '--background'], { extra: { home: pausedHome } }).pick.model, TERRA56);
    assert.equal(r(['lookup'], { extra: { home: pausedHome } }).pick.model, TERRA56);
    noteFailure(pausedHome, 'Model access temporarily restricted. (983)', now, SOL);
    assert.equal(r(['analysis', '--background'], { extra: { home: pausedHome } }).pick.model, FLASH);
    assert.equal(r(['lookup'], { extra: { home: pausedHome } }).pick.account, 'ttadk');
    const log = path.join(home, 'routes.jsonl');
    r(['lookup', '--project', 'p', '--name', 'free-gpt'], { env: { ROUTE_LOG: '1', ROUTE_LOG_FILE: log } });
    const logged = JSON.parse(fs.readFileSync(log, 'utf8').trim());
    assert.equal(logged.company, 'trae'); assert.equal(logged.pick.model, GPT55); assert.equal(logged.balance.bucketFree, true);
    console.log('ok   bucket-free TRAE GPT: cheap/background preference, quota, mapping, security, vision, balancing, tiers and pauses');
  } catch (e) { fail++; console.log(`FAIL bucket-free TRAE GPT: ${e.stack}`); }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
