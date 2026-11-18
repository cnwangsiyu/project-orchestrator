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
import { routeFixture, parseRouteJSON } from './helpers/route-fixture.mjs';
import { loadDigest } from '../lib/global-rules.mjs';

const ROUTE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'route.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'route-test-'));
// Legacy route expectations predate the standing personal-fallback policy; personal-fallback-scenarios covers it.
if (!process.env.PERSONAL_FALLBACK_FILE) { process.env.PERSONAL_FALLBACK_FILE = path.join(tmp, 'personal-fallback-off.json'); fs.writeFileSync(process.env.PERSONAL_FALLBACK_FILE, '{"enabled":false}'); }
const absentPlaywrightToken = path.join(tmp, 'no-playwright-extension-token');
const now = Date.now(), h = 3600000, W = 10080;
const wk = (used, leftH, label = 'week') => ({ label, used, resetsAt: now + leftH * h, windowMins: W, scoped: false });
const cl = (used, leftH, fable = 0) => [wk(used, leftH, 'week (all models)'), { ...wk(fable, leftH, 'week (Fable)'), scoped: true }];
const acc = (name, used, leftH, cards = [], extra = {}) => ({ name, live: true, email: `${name}@example.com`, home: path.join(tmp, name), plan: 'prolite', seenAt: now,
  windows: [wk(used, leftH)], resets: { count: cards.length, credits: cards.map((e, i) => ({ id: `RateLimitResetCredit_${name}card${i}`, expiresAt: now + e * h })) }, ...extra });
const tt = (extra = {}) => ({ name: 'ttadk', kind: 'ttadk', home: path.join(tmp, 'ttadk'), hub: 'ws://127.0.0.1:47399', healthy: true, reason: null, live: true, active: 2,
  models: ['gpt-6.1-sol', 'gpt-5.6-terra', 'gpt-5.5'], browser: true, desktop:true, chromePlugin: '/tmp/chrome-plugin', ssoExpiresAt: now + 240 * h, windows: [], resets: null, ...extra });
// TRAE CLI (second company account, 2026-11-08): no windows, no browser, its own model ids.
const tr = (extra = {}) => ({ name: 'trae', kind: 'trae', home: path.join(tmp, 'trae'), hub: 'ws://127.0.0.1:47398', healthy: true, reason: null, live: true, active: 0,
  models: ['gpt-6.1-sol', 'gpt-6-astra', 'gemini-3.1-pro-preview'], modelIds: { 'gpt-6.1-sol': 'GPT-6.1-Sol', 'gpt-6-astra': 'GPT-6-Astra', 'gemini-3.1-pro-preview': 'Gemini-3.1-Pro-Preview' },
  search: true, searchLive: true, browser: false, windows: [], resets: null, ...extra,
  ...(extra.quota ? { quota: { sampledAt: now, ...extra.quota } } : {}) });
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
  macBrowser: { claude: cl(10, 120), codex: [acc('main', 20, 120, [], { browser: true, desktop:true, chromePlugin: '/tmp/chrome-main' })] },
  traeBrowserB: { claude: cl(10, 120), codex: [acc('main', 20, 120), acc('b', 30, 100, [], { browser: true,desktop:true }), tr()] },
  ttChatOut: { claude: cl(10, 48), codex: [acc('main', 99, 48), tt()] },
  // From the 2026-11-07 review: a hub never read; a spent account with a card next to TTADK; an excluded pick next to
  // a spent account with an urgent card; two accounts that must both be spent soon.
  unreadHub: { claude: cl(10, 120), codex: [{ name: 'main', live: false, email: 'm@example.com', home: path.join(tmp, 'main'), seenAt: null, windows: null, resets: null }] },
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
  ['fresh', ['docs'], 'codex gpt-6.1-sol high @main'],
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
  ['quiet', ['design'], 'codex gpt-6.1-sol xhigh @main'],
  ['claudeOver', ['docs'], 'codex gpt-6.1-sol high @main'],
  ['claudeOver', ['design'], 'codex gpt-6.1-sol xhigh @main'],
  ['claudeOver', ['computer-use'], 'claude sonnet medium'],
  ['claudeOver', ['lookup', '--failures', '1'], 'codex gpt-6.1-sol medium @main'], // the Codex step (cheap rows get no quota notch)
  ['quiet', ['lookup', '--failures', '2'], 'claude sonnet medium'],
  ['claudeOver', ['debug', '--failures', '1'], 'codex gpt-6.1-sol max @main'],
  ['claudeOver', ['debug', '--failures', '2'], 'codex gpt-6-astra xhigh @main'],
  ['claudeNearReset', ['docs'], 'codex gpt-6.1-sol high @main'], // spare near the reset (only 8% room: no expiring notch)
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
  ['quiet', ['implement', '--impact', 'release'], 'codex gpt-6.1-sol high @main', 'route.mjs review-high --review-class A'],
  ['quiet', ['implement', '--impact', 'release', '--stakes', 'high'], 'codex gpt-6.1-sol xhigh @main', 'route.mjs review-high'],
  ['quiet', ['implement', '--impact', 'service'], 'codex gpt-6.1-sol high @main', 'no review'],
  ['quiet', ['implement', '--impact', 'service', '--stakes', 'high'], 'codex gpt-6.1-sol xhigh @main', 'no review'],
  ['quiet', ['debug', '--impact', 'throwaway', '--stakes', 'high'], 'codex gpt-6.1-sol xhigh @main', 'no review'],
  ['quiet', ['docs'], 'codex gpt-6.1-sol medium @main', '!review'],
  // TTADK preferred when healthy (user, 2026-11-07); no quota notches on it; fallback via --exclude-account or ill health.
  ['ttFresh', ['implement'], 'codex gpt-6.1-sol high @ttadk', 'retry it once'],
  ['ttFresh', ['lookup'], 'codex gpt-5.6-terra medium @ttadk'], // light row: TTADK's light list starts at 5.6-Terra
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
  ['ttChatOut', ['lookup'], 'codex gpt-5.6-terra medium @ttadk'], // light row: light list, not Sol
  ['ttChatOut', ['image-gen'], 'DEFER'],
  // Browser order is TTADK Codex → token-ready TRAE → browser-ready personal ChatGPT → Claude.
  // These baseline fixtures have no TRAE token, so their expected picks exercise the remaining rungs.
  ['ttFresh', ['browser'], 'codex gpt-6.1-sol medium @ttadk', 'Chrome must be running'],
  ['ttFresh', ['browser', '--failures', '2'], 'codex gpt-6.1-sol xhigh @ttadk'],
  ['ttFresh', ['browser', '--failures', '3'], 'claude sonnet medium'],
  ['ttNoBrowser', ['browser'], 'claude sonnet medium', 'never switch to another connected browser'],
  ['fresh', ['browser'], 'claude sonnet medium'],
  ['ttFresh', ['browser', '--exclude-account', 'ttadk'], 'claude sonnet medium'],
  // ui-browser uses the same browser order and keeps its hard effort floor for writes.
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
  // A light first rung (5.6-Terra) is rung 0, so the Sol escalation starts at medium on failure 1.
  ['ttFresh', ['lookup', '--failures', '2'], 'codex gpt-6.1-sol high @ttadk'], // cheap rows climb to xhigh, not max
  ['ttFresh', ['lookup', '--failures', '3'], 'codex gpt-6.1-sol xhigh @ttadk'],
  ['ttFresh', ['lookup', '--failures', '4'], 'claude sonnet medium'],
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
  ['ttFresh', ['lookup', '--stakes', 'low'], 'codex gpt-5.6-terra medium @ttadk'], // low stakes stays light
  // A Codex-written change is reviewed by Claude first.
  ['ttFresh', ['review', '--author', 'codex'], 'codex gpt-6.1-sol xhigh @ttadk', 'second TTADK reviewer'],
  ['ttKimi', ['review', '--author', 'codex'], 'codex gpt-6.1-sol xhigh @ttadk', 'Kimi-K3, a different model family'],
  ['ttFresh', ['review-high', '--author', 'codex'], 'claude opus xhigh'],
  ['fresh', ['review', '--author', 'codex'], 'claude sonnet high'],
  // Claude has no room: a fresh TTADK reviewer stands in instead of deferring or dropping the second opinion.
  ['ttClaudeOver', ['second-opinion', '--against', 'codex'], 'codex gpt-6.1-sol xhigh @ttadk'],
  ['ttClaudeOver', ['design'], 'codex gpt-6.1-sol xhigh @ttadk', 'stands in'],
  ['ttFresh', ['review', '--author', 'claude'], 'codex gpt-6.1-sol high @ttadk'],
  ['ttFresh', ['browser'], 'codex gpt-6.1-sol medium @ttadk', 'Scope safety'],
  // Browser workers get the Chrome pairing clause; code work doesn't (nightly review 2026-11-05: video-agent W258).
  ['claudeOver', ['computer-use'], 'claude sonnet medium', 'select_browser'],
  ['fresh', ['ui-browser'], 'claude sonnet high', 'select_browser'],
  ['fresh', ['implement', '--auto-check'], 'codex gpt-6.1-sol high @main', '!select_browser'],
  // Credential clause in every brief (user-approved 2026-11-11).
  ['quiet', ['lookup'], 'codex gpt-6-luna low @main', 'Forbidden for every worker'],
  ['ttOutTrae', ['analysis'], 'codex gpt-6.1-sol high @trae', 'Forbidden for every worker'],
  // Security excludes TRAE GPT for this task; TTADK GPT and personal accounts are untouched (2026-11-12).
  // A security review is adversarial by default (2026-11-13): no GPT on any account, and with no company non-GPT
  // model listed here the pick is Claude Opus behind the personal-quota gate.
  ['ttOutTrae', ['review-high', '--security'], 'claude opus xhigh', 'describe defensive intent'],
  ['ttOutTrae', ['implement', '--impact', 'service', '--security'], 'codex gpt-6.1-sol high @main'],
  ['ttAndTrae', ['review-high', '--security'], 'claude opus xhigh', 'describe defensive intent'],
  ['ttFresh', ['--security', 'review-high'], 'claude opus xhigh'],
  ['ttFresh', ['implement', '--impact', 'service', '--security'], 'codex gpt-6.1-sol high @ttadk'],
  ['fresh', ['review-high', '--security'], 'claude opus xhigh', 'describe defensive intent'],
  ['fresh', ['implement', '--impact', 'service', '--security'], 'codex gpt-6.1-sol xhigh @main'],
];
const ERRORS = [['fresh', ['implement', '__noimpact']], ['fresh', ['implement', '--impact', 'prod']], ['fresh', ['implement', '--failures', '-1']], ['fresh', ['implement', '--stakes', 'hgih']], ['fresh', ['implement', '--sandbox', 'danger-full-access']], ['fresh', ['second-opinion']], ['fresh', ['nope']], ['fresh', ['review', '--defensive']], ['fresh', ['implement', '--impact', 'service', '--security', '--defensive']], ['fresh', ['review-high', '--security', '--defensive', '--adversarial']], ['fresh', ['second-opinion', '--against', 'codex', '--defensive']]];

let fail = 0;
const CODE = ['implement', 'implement-hard', 'debug', 'science'];
const run = (sc, args0, overrides = {}) => {
  // Code categories need --impact; default it to service unless the case says otherwise ('__noimpact' tests the error).
  let args = args0.filter((a) => a !== '__noimpact');
  if (CODE.includes(args[0]) && !args.includes('--impact') && !args0.includes('__noimpact')) args = [...args, '--impact', 'service'];
  const cache = path.join(tmp, 'q.json');
  fs.writeFileSync(cache, JSON.stringify({ checkedAt: now, claude: S[sc].claude, codexAccounts: S[sc].codex, errors: {}, history: S[sc].history ?? {} }));
  const category=args.find(v=>['review','review-high','second-opinion'].includes(v));
  if(!args.includes('--review-class')) {
    const cls=args.includes('release')?'A':category&&!args.includes('--defensive')&&(args.includes('--security')||args.includes('--adversarial'))?'D':category==='review-high'?'B':null;
    if(cls)args.push('--review-class',cls,'--review-reason','synthetic classified review basis');
  }
  const env = { ...process.env, RULES_SHARED: tmp, QUOTA_CACHE: cache, CODEX_ACCOUNTS: path.join(tmp, 'none.json'), ROUTE_LOG: '0', ROUTE_NOW: String(now), ROUTE_LOG_FILE: path.join(tmp, 'empty-route-history.jsonl'), QUOTA_LOG: '0', TRAE_PROBE: '0', ROUTE_RR: path.join(tmp, 'rr.txt'), QUOTA_LOG_FILE: path.join(tmp, 'empty-company-history'), PLAYWRIGHT_EXTENSION_TOKEN_FILE: absentPlaywrightToken, ...overrides };
  return routeFixture(ROUTE,[...args,'--artifact-ref','fixture-artifact','--json'],{env,dir:tmp,approve:overrides.TEST_APPROVE===true||args0.includes('--user-ok')});
};
{
  const shared = path.join(tmp, 'priority-window');
  const env = { RULES_SHARED: shared, ROUTE_REQUEST_ID: 'window-fixture' };
  const noWindow = { ...env, RULES_SHARED: tmp };
  const until = now + 10 * h, ref = 'standing:personal-priority-fixture';
  const policy = (...args) => JSON.parse(execFileSync(process.execPath, [path.join(path.dirname(ROUTE), 'personal-priority.mjs'), ...args], {
    env: { ...process.env, ...env }, encoding: 'utf8',
  }));
  const read = (args, overrides = env) => JSON.parse(run('priority', [...args, '--dry'], overrides));
  try {
    S.priority = { claude: cl(10, 120), codex: [acc('main', 50, 10, [], { browser: true }), acc('b', 10, 3), tt(), tr()] };
    const normal = read(['analysis'], noWindow);
    assert.ok(normal.pick.company);
    policy('add', new Date(now).toISOString(), new Date(until).toISOString(), ref, 'synthetic decision');
    assert.equal(policy('inspect').active, true);
    for (const args of [['analysis'], ['browser', '--origins', 'example.com'], ['design'], ['analysis', '--background']]) {
      const preferred = read(args);
      assert.equal(preferred.pick.account, 'main', args.join(' '));
      assert.equal(preferred.pick.approvalRef, ref);
      assert.deepEqual(preferred.needsUserOK, []);
      assert.ok(preferred.why.some(line => line.includes(new Date(until).toISOString())));
    }
    for (const args of [['claude-tools'], ['analysis', '--exclude-account', 'main'],
      ['analysis', '--exclude-account', 'main,ttadk,trae,claude'], ['implement', '--security'],
      ['review', '--author', 'codex']]) {
      const actual = read(args), expected = read(args, noWindow);
      assert.deepEqual((actual.plan.primary ?? actual.plan.primaryProposal)?.candidate,
        (expected.plan.primary ?? expected.plan.primaryProposal)?.candidate, args.join(' '));
      assert.equal(actual.pick?.approvalRef, expected.pick?.approvalRef);
      assert.equal(actual.executable, expected.executable);
      assert.deepEqual(actual.needsUserOK, expected.needsUserOK);
      assert.deepEqual(actual.why, expected.why);
    }
    const hardAstra = { ...env, PERSONAL_FALLBACK_FILE: path.join(path.dirname(ROUTE), '../references/personal-fallback.json') };
    const hard = read(['implement-hard'], hardAstra);
    assert.equal(hard.pick.account, 'main');
    assert.equal(hard.pick.model, 'gpt-6-astra');
    assert.equal(hard.pick.astraApprovalRef, 'standing:hard-astra-2026-11-17');
    assert.equal(read(['analysis'], hardAstra).pick.model, 'gpt-6.1-sol');
    for (const [used, earlier, reason] of [[87, 83, /projected at reset 95%/], [90, 90, /used 90%/]]) {
      S.priority.codex[0].windows = [wk(used, 10)];
      S.priority.history = { 'codex:main': [{ t: now - 5 * h, used: earlier, resetsAt: until }] };
      const guarded = read(['analysis']);
      assert.equal(guarded.pick.account, normal.pick.account);
      assert.ok(guarded.why.some(line => line.includes('weekly quota guard') && reason.test(line)));
    }
    {
      const file = path.join(shared, 'personal-priority-window.json');
      if (fs.existsSync(file)) {
        const saved = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(saved), exhaustAtUsed: 98 }));
        S.priority.history = { 'codex:main': [{ t: now - 5 * h, used: 83, resetsAt: until }] };
        S.priority.codex[0].windows = [wk(97, 10)];
        assert.equal(read(['analysis']).pick.account, 'main', 'spend-until keeps main below the threshold despite the projection');
        S.priority.codex[0].windows = [wk(98, 10)];
        const spent = read(['analysis']);
        assert.equal(spent.pick.account, normal.pick.account);
        assert.ok(spent.why.some(line => line.includes('weekly quota used up')));
        fs.writeFileSync(file, saved);
      } else assert.fail('window fixture file expected');
    }
    S.priority.codex[0].windows = [wk(10, 11)];
    const unknown = read(['analysis']);
    assert.equal(unknown.pick.account, normal.pick.account);
    assert.ok(unknown.why.some(line => line.includes('fresh weekly quota for this reset is unavailable')));
    const activeAccounts = S.priority.codex;
    S.priority.codex = activeAccounts.map(a => ({ ...a, seenAt: until, ...(a.name === 'main' ? { windows: [wk(5, 178)] } : {}) }));
    const atExpiry = { ROUTE_NOW: String(until), ROUTE_REQUEST_ID: env.ROUTE_REQUEST_ID };
    const expired = run('priority', ['analysis', '--dry'], { ...env, ...atExpiry });
    assert.deepEqual(expired, run('priority', ['analysis', '--dry'], { ...noWindow, ...atExpiry }));
    assert.equal(JSON.parse(expired).pick.account, normal.pick.account);
    S.priority.codex = activeAccounts;
    policy('revoke', ref);
    assert.equal(policy('inspect').active, false);
    assert.deepEqual(read(['analysis']), read(['analysis'], noWindow));
    console.log('ok   personal main-first window, scoped approval, quota thresholds and exact expiry');
  } catch (error) {
    fail++;
    console.error('FAIL personal main-first window', error.message);
  }
}
const expectationChanges=[];
const revisedCase=(sc,args,want,note)=>{
  const category=args.find(a=>['lookup','extract','analysis','research','implement','implement-hard','debug','science','review','review-high','design','docs','draft','build-run','browser','ui-browser','computer-use','claude-tools','image-gen','image-read','second-opinion'].includes(a));
  let next=want,reason=null;
  if(args.includes('--failures')&&Number(args[args.indexOf('--failures')+1])>0) { next='RETRY';reason='B4: absent actual history uses the first category rung with an explanation and retains the tier floor'; }
  else if(category==='computer-use'&&(!args.includes('--apps')||!S[sc].codex.some(a=>a.desktop))) {next='BLOCKED';reason='V05/V06: require independent desktop evidence and explicit app scope';}

  else if(['ttQuotaOut','ttOutTraeDown'].includes(sc)&&!['image-gen','claude-tools'].includes(category)) {next='PERSONAL';reason='B1/B3: show the ready personal choice and ask before waiting for a company reset';}
  else if(sc==='unreadHub') {next=category==='image-gen'?'BLOCKED':'claude sonnet medium';reason='V03: unknown personal auth is no longer assumed usable';note=null;}
  else if(category==='review'&&args.includes('codex')) {next='claude sonnet high';reason='V16: vendor prose does not attest the author; routine review uses one independent family';note=null;}
  else if(sc==='ttClaudeOver'&&category==='second-opinion') {next='claude opus high';reason='V16/V08: unknown actual author cannot authorize same-family GPT; personal proposal remains gated';}
  if(sc==='ttClaudeOver'&&category==='design') {note=null;reason='Routine design no longer appends a second reviewer';}
  if(category==='docs'&&note==='!review') {note='!review required';reason='Check absence of review requirement, not incidental words in the injected digest';}
  if(category==='debug'&&args.includes('throwaway')&&args.includes('high')) {note='no review';reason='Mandatory review only explicit A–D';}
  if(sc==='ttOutTrae'&&category==='browser') {next='PERSONAL';reason='B7: Claude in Chrome is a ready personal browser choice when company browser quota is unavailable';note=null;}
  if(next!==want||reason) expectationChanges.push({scenario:sc,args,old:want,next,reason});
  return [next,['BLOCKED','DEFER','RETRY','PERSONAL'].includes(next)?null:note];
};
// Optional 4th field: a substring the notes must contain ('!text': must not contain).
for (const [sc,args,oldWant,oldNote] of CASES) {
  const [want,note]=revisedCase(sc,args,oldWant,oldNote);
  try { fs.rmSync(path.join(tmp, 'rr.txt'), { force: true }); } catch {}
  let got;
  try {
    const o = parseRouteJSON(run(sc, args));
    if(want==='RETRY') {
      assert.ok(o.pick||o.plan.rejected.some(r=>r.reason.code==='PROVIDER_QUOTA_DENIED'),'retry has a proposal or explicit quota denial');
      assert.ok(o.why.some(w=>/assumed first category ladder rung/.test(w)));
      assert.ok(!o.plan.reasons?.some(r=>r.code==='PREVIOUS_ATTEMPT_UNKNOWN'));
      if(CODE.includes(args[0])) assert.equal(o.tier,'hard');
    }
    if(want==='PERSONAL') {assert.ok(o.pick&&!o.pick.company);assert.equal(o.kind,'blocked');assert.equal(o.deferred,null);assert.equal(o.pick.command,null);assert.ok(o.needsUserOK.some(w=>/personal quota/.test(w)));}
    got = want==='PERSONAL'?'PERSONAL':want==='RETRY'?'RETRY':want==='BLOCKED'&&o.blocked ? 'BLOCKED' : o.deferred ? 'DEFER' : `${o.pick.vendor} ${o.pick?.model} ${o.pick?.effort}${o.pick?.account ? ` @${o.pick?.account}` : ''}`;
    if (note) {
      const has = (o.allNotes || []).some((x) => x.includes(note.replace(/^!/, '')));
      if (has === note.startsWith('!')) got += ` (notes ${note.startsWith('!') ? 'contain' : 'lack'} "${note.replace(/^!/, '')}")`;
    }
  } catch (e) { got = `ERROR ${String(e.stderr || e.message).split('\n')[0]}`; }
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${sc.padEnd(19)} ${args.join(' ').padEnd(36)} ${ok ? got : `want "${want}", got "${got}"`}`);
}
// A user-pasted Playwright Extension token makes TRAE web-browser capable without making it desktop-capable.
// Every subprocess gets an explicit fake path, so this suite never probes or reads the user's real token file.
{
  const browserStates=Object.fromEntries(['ttOutTrae','traeBrowserB','ttAndTrae'].map(sc=>[sc,structuredClone(S[sc])]));
  try {
    const token = path.join(tmp, 'playwright-extension-token');
    fs.writeFileSync(token, 'fixture-playwright-token-do-not-log\n', { mode: 0o600 });
    const env = { PLAYWRIGHT_EXTENSION_TOKEN_FILE: token };
    for(const sc of ['ttOutTrae','traeBrowserB','ttAndTrae']) {
      const a=S[sc].codex.find(a=>a.kind==='trae');
      a.load={'gpt-6.1-sol':{percent:42,t:now}};
      a.quota={sampledAt:now,daily:{'gpt-6.1-sol':{used:20,limit:80,depleted:false,resetsAt:now+h}}};
    }
    const ttFirst = parseRouteJSON(run('ttFresh', ['browser'], env));
    assert.equal(ttFirst.pick.account, 'ttadk');
    assert.equal(parseRouteJSON(run('ttAndTrae',['browser'],env)).pick.account,'trae');
    const healthyBridge = S.ttAndTrae.codex.find(a=>a.kind==='trae');
    healthyBridge.traeBrowser = false;
    assert.equal(parseRouteJSON(run('ttAndTrae',['browser'],env)).pick.account,'ttadk', 'MCP health failure survives a present pairing file');
    delete healthyBridge.traeBrowser;
    assert.equal(parseRouteJSON(run('ttAndTrae',['ui-browser','--impact','service'],env)).pick.account,'trae');
    const trae = parseRouteJSON(run('ttOutTrae', ['browser', '--origins', 'example.com'], env));
    assert.equal(trae.pick.account, 'trae'); assert.equal(trae.pick.launcher, 'codex-worker');
    assert.ok(trae.why.some((s) => /TRAE via Playwright extension in the user's Chrome/.test(s)));
    assert.ok(trae.allNotes.some((s) => /not enforced technically on TRAE/.test(s)));
    assert.match(trae.pick.command, /--browser-origins/); assert.match(trae.pick.command, /example\.com/);
    const beforePersonal = parseRouteJSON(run('traeBrowserB', ['browser'], env));
    assert.equal(beforePersonal.pick.account, 'trae');
    const ui = parseRouteJSON(run('ttOutTrae', ['ui-browser'], env));
    assert.equal(ui.pick.account, 'trae'); assert.equal(ui.pick.effort, 'high');
    const desktop = parseRouteJSON(run('traeBrowserB', ['computer-use', '--apps', 'com.apple.Notes'], env));
    assert.equal(desktop.pick.account, 'b'); assert.notEqual(desktop.pick.account, 'trae');
    assert.ok(desktop.needsUserOK.some((s) => /personal quota/.test(s)));
    S.noDesktopPath={...S.ttOutTrae,codex:S.ttOutTrae.codex.filter(a=>a.kind!=='ttadk')};
    const noPersonalDesktop = parseRouteJSON(run('noDesktopPath', ['computer-use', '--apps', 'com.apple.Notes'], env));
    assert.equal(noPersonalDesktop.pick, null); assert.equal(noPersonalDesktop.blocked, true); assert.ok(noPersonalDesktop.plan.rejected.some(p=>p.reason.code==='CAPABILITY_DESKTOP_TOOL'));
    const absent = parseRouteJSON(run('ttOutTrae', ['browser']));
    assert.equal(absent.pick.vendor, 'claude'); assert.ok(absent.needsUserOK.some((s) => /personal quota/.test(s)));
    const personal = parseRouteJSON(run('traeBrowserB', ['browser']));
    assert.equal(personal.pick.account, 'b'); assert.ok(personal.needsUserOK.some((s) => /personal quota/.test(s)));
    console.log('ok   TRAE Playwright browser capability: observed free TRAE first, TTADK fallback, personal/Claude, UI floor, token gate, computer-use exclusion');
  } catch (e) { fail++; console.log(`FAIL TRAE Playwright browser capability: ${e.stack}`); }
  finally {Object.assign(S,browserStates);}
}
// User decision 2026-11-13: Codex-family writers default to full access on every account. Reviewers remain read-only;
// test-running reviews get workspace-write, and --sandbox is the only explicit narrower per-task override.
{
  try {
    const routed = (sc, args) => parseRouteJSON(run(sc, args));
    for (const [sc, account] of [['quiet', 'main'], ['ttFresh', 'ttadk'], ['ttOutTrae', 'trae']]) {
      for (const mode of [[], ['--mode', 'default'], ['--mode', 'bypassPermissions']]) {
        const writing = routed(sc, ['implement', '--impact', 'service', ...mode]);
        assert.equal(writing.pick?.account, account); assert.equal(writing.pick.sandbox, 'danger-full-access');
        assert.match(writing.pick?.command, /(?:--sandbox|-s) danger-full-access/);
        assert.match(writing.allNotes[0], /never overwrite, delete or move files outside the task's scope/);
        assert.ok(writing.allNotes.some((n) => /full access: the worker may commit on its task branch if the brief says so; never push to main, never force-push; commits carry no co-author\/tool trailer/.test(n)));
        assert.ok(writing.allNotes.some((n) => /Forbidden for every worker/.test(n)));
        assert.ok(writing.allNotes.some((n) => /follow the Device tasks rule for installs, wipes and backups/.test(n)));
        assert.ok(!writing.allNotes.some((n) => /workspace-write can't run git writes/.test(n)));
      }
      const review = routed(sc, ['review']);
      assert.equal(review.pick?.account, account); assert.equal(review.pick.sandbox, 'read-only');
      assert.equal(routed(sc, ['review', '--runs-tests']).pick.sandbox, 'workspace-write');
      const signing = routed(sc, ['review', '--signing', '--sandbox', 'read-only']);
      assert.equal(signing.blocked,true); assert.equal(signing.pick,null);
      assert.equal(signing.signing, true);
      assert.ok(signing.plan.reasons.some(r=>r.code==='SIGNING_FULL_ACCESS_REQUIRED'));
    }
    const narrower = routed('quiet', ['implement', '--impact', 'service', '--sandbox', 'workspace-write']);
    assert.equal(narrower.pick.sandbox, 'workspace-write'); assert.match(narrower.pick?.command, /(?:--sandbox|-s) workspace-write/);
    assert.equal(routed('quiet', ['implement', '--impact', 'service', '--sandbox', 'read-only']).pick.sandbox, 'read-only');
    const testedReview = routed('ttFresh', ['review', '--runs-tests']);
    assert.ok(testedReview.allNotes.some((n) => /workspace-write only for test-generated files; the reviewer must not edit/.test(n)));
    const signingLog = path.join(tmp, 'signing-route-log.jsonl');
    parseRouteJSON(run('quiet', ['review', '--signing', '--project', 'fixture', '--name', 'fixture-sign'],
      { ROUTE_LOG: '1', ROUTE_LOG_FILE: signingLog }));
    const signingRecord = parseRouteJSON(fs.readFileSync(signingLog, 'utf8').trim());
    assert.equal(signingRecord.signing, true); assert.equal(signingRecord.pick.account,'main'); assert.equal(signingRecord.executable,true);
    console.log('ok   sandbox/signing defaults: main, TTADK and TRAE signing full; reviews read-only; test runs workspace-write');
  } catch (e) { fail++; console.log(`FAIL sandbox defaults/overrides: ${e.stack}`); }
}
// Both sides of the global-rules/tier-routing merge must survive in commands, notes and route evidence.
{
  try {
    const log = path.join(tmp, 'merged-route-log.jsonl');
    const merged = parseRouteJSON(run('ttFresh', ['review-high', '--author', 'codex', '--project', 'fixture', '--name', 'fixture-T1', '--urgent', '--user-ok', 'ledger:fixture/card-1'], { ROUTE_LOG: '1', ROUTE_LOG_FILE: log }));
    const rec = parseRouteJSON(fs.readFileSync(log, 'utf8').trim());
    assert.equal(rec.tier, 'hard'); assert.equal(rec.tier, merged.tier);
    assert.equal(rec.second?.account, merged.secondOpinion?.account);
    assert.equal(rec.personalApproved, true); assert.equal(merged.blocked,false); assert.equal(rec.approvalRef, 'fixture-approval');
    assert.ok(merged.pick?.command);
    for (const sc of ['ttFresh', 'ttOutTraeDown', 'fresh']) {
      const routed = parseRouteJSON(run(sc, ['build-run']));
      assert.ok(routed.allNotes.some((s) => /heavy-build\.sh.*ONE-process wrapper.*res take-build\/wait-build\/return-build.*res v1\.5.*acquire heavy-build plus one free admitted lane together.*holding neither resource while waiting for the other/.test(s)));
      assert.ok(routed.allNotes.some((s) => /only for genuine local heavy compute.*remote pipeline deploys and CI runs never take one.*--no-local-build/.test(s)));
      assert.ok(routed.allNotes.some((s) => /Normal gate remains min\(20, 12 \+ 8 \* other lanes\), memory >=16 GiB; STALE and caller-owned locks excluded/.test(s)));
      assert.ok(routed.allNotes.some((s) => /lane 3 is available only after reviewed owner switch.*load1m <=8 AND available memory >=32 GiB.*lane3=OPEN\|CLOSED/.test(s)));
      assert.ok(!routed.allNotes.some((s) => /at most 3 concurrent heavy builds/.test(s)));
    }
    for (const sc of ['unreadHub']) {
      const routed = parseRouteJSON(run(sc, ['analysis']));
      assert.ok(routed.allNotes.some((s) => /list --limit 1.*only if unreachable.*global-rules owner/.test(s)));
    }
    console.log('ok   merged tier routing, worker digest, approvals and resource/hub notes');
  } catch (e) { fail++; console.log(`FAIL merged tier/global rules: ${e.message}`); }
}
// Second-opinion account: the extra underused-quota Codex review spends ChatGPT quota (never TTADK); a cross-vendor
// Codex second opinion follows TTADK first.
// The extra underused review follows the review policy (user, 2026-11-07): only code that needs a review anyway, never on
// a review itself, and never on a TTADK device.
for (const [sc, args, want] of [
  ['ttFresh', ['review'], 'none'],
  ['ttFresh', ['review-high', '--failures', '2'], 'none'], // Opus pick (after Sol xhigh, Sol max) → Sol second on TTADK
  ['ttFresh', ['review-high'], 'none'], // Sol pick → Opus second (Claude keeps the high-stakes pair)
  ['fresh', ['review'], 'none'],
  ['fresh', ['implement-hard', '--impact', 'release'], 'none'],
  ['fresh', ['implement-hard', '--impact', 'throwaway'], 'none'],
  ['fresh', ['implement-hard', '--impact', 'service'], 'none'],
  ['ttFresh', ['implement-hard', '--impact', 'release', '--exclude-account', 'ttadk'], 'none'],
]) {
  let got;
  try { got = parseRouteJSON(run(sc, args)).secondOpinion?.account ?? 'none'; } catch (e) { got = `ERROR ${String(e.stderr || e.message).split('\n')[0]}`; }
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${sc.padEnd(19)} ${(args.join(' ') + ' (2nd account)').padEnd(36)} ${ok ? got : `want "${want}", got "${got}"`}`);
}
// user-approved 2026-11-11 retro: shell parsing must deliver the whole credential rule as one config argument.
for (const [sc, args] of [['quiet', ['lookup']], ['ttSearch', ['lookup']], ['ttOutTrae', ['lookup']], ['quiet', ['draft']], ['quiet', ['second-opinion', '--against', 'claude']]]) {
  let ok = false;
  try {
    const printed = parseRouteJSON(run(sc,args,{TEST_APPROVE:true})).pick?.command;
    if(!printed.includes('-- sh -c')) {assert.ok(parseRouteJSON(run(sc,args,{TEST_APPROVE:true})).allNotes.some(n=>n===`Global worker rules ${loadDigest().version}: ${loadDigest().coreWorker}`));ok=true;continue;}
    const inner = printed.match(/-- sh -c (.*)$/);
    const command = inner ? execFileSync('/bin/sh', ['-c', `printf '%s' ${inner[1]}`], { encoding: 'utf8' }) : printed;
    assert.match(printed, /--inject-rules on /);
    const quoted = command.match(/ -c ("\$ORCHESTRATOR_WORKER_RULES_CONFIG") --json/)[1];
    const config = execFileSync(process.execPath, [path.join(path.dirname(ROUTE), 'run-tracked.mjs'), '--inject-rules', 'on',
      '--', '/bin/sh', '-c', `printf '%s' ${quoted}`], { encoding: 'utf8', env: { ...process.env, RULES_SHARED: tmp, ORCHESTRATOR_OWNER: '' } });
    const rule = parseRouteJSON(config.slice('developer_instructions='.length));
    const digest = loadDigest();
    ok = rule.startsWith(`Global worker rules ${digest.version}\n`)&&rule.includes('never read, copy, load or inject LOGIN')
      &&rule.split('\n').slice(1).every(line=>digest.worker.includes(line));
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
  try { got = /--account ttadk proxy >\/dev\/null && /.test(parseRouteJSON(run(sc, args)).pick?.command ?? ''); } catch (e) { got = `ERROR ${String(e.stderr || e.message).split('\n')[0]}`; }
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${sc.padEnd(19)} ${(args.join(' ') + ' (proxy first)').padEnd(36)} ${ok ? got : `want ${want}, got ${got}`}`);
}
// The second reviewer of Codex-written code is Kimi-K3 on TTADK when the gateway lists it, else Sol.
for (const [sc, want] of [['ttKimi', 'none'], ['ttFresh', 'none']]) {
  let got;
  try { const so = parseRouteJSON(run(sc, ['review', '--author', 'codex'])).secondOpinion; got = so ? `${so.model} ${so.effort} @${so.account}` : 'none'; } catch (e) { got = 'ERROR'; }
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${sc.padEnd(19)} ${'review --author codex (2nd)'.padEnd(36)} ${ok ? got : `want "${want}", got "${got}"`}`);
}
// computer-use passes the allowed apps to the worker.
{
  let got;
  try { got = parseRouteJSON(run('ttFresh', ['computer-use', '--apps', 'com.apple.calculator,com.apple.Notes'])).pick?.command ?? ''; } catch (e) { got = 'ERROR'; }
  const ok = got.includes("--computer-use-apps 'com.apple.Notes,com.apple.calculator'");
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
  try { const o = parseRouteJSON(run(sc, args)); got = !!o.redeemFirst; } catch (e) { got = `ERROR ${String(e.stderr || e.message).split('\n')[0]}`; }
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${sc.padEnd(19)} ${(args.join(' ') + ' (redeem)').padEnd(36)} ${ok ? got : `want ${want}, got ${got}`}`);
}
// Rotation: two accounts with deadlines inside 48h alternate across launches.
{
  try { fs.rmSync(path.join(tmp, 'rr.txt'), { force: true }); } catch {}
  const a = parseRouteJSON(run('cardDeadline', ['implement'])).pick?.account, b = parseRouteJSON(run('cardDeadline', ['implement'])).pick?.account;
  const ok = a === 'b' && b === 'main'; // BC-30: nondry personal dispatches advance the locked counter.
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
  const gate = (args) => parseRouteJSON(run('ttQuotaOut', args)).needsUserOK.some((n) => /^personal quota:/.test(n));
  const cases = [[gate(['analysis']), true], [gate(['implement', '--impact', 'service']), true], [gate(['analysis', '--urgent']), true], [gate(['implement', '--impact', 'service', '--stakes', 'high']), true]];
  const bad = cases.map(([got, want], i) => (got === want ? null : i)).filter((i) => i !== null);
  if (bad.length) fail++;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} ttQuotaOut gate     ${cases.length} cases${bad.length ? ` — failing #${bad.join(', #')}` : ''}`);
}
// TRAE: no personal-quota gate while it can take TTADK's work; the gate returns when both company accounts are out; TRAE launches use
// its own model ids and traecli for exec.
{
  const o = (sc, args) => parseRouteJSON(run(sc, args));
  const gate = (sc, args) => o(sc, args).needsUserOK.some((n) => /^personal quota:/.test(n));
  const exec = o('ttOutTrae', ['lookup']).pick?.command ?? '';
  const worker = o('ttOutTrae', ['implement', '--impact', 'service']).pick?.command ?? '';
  const cases = [[gate('ttOutTrae', ['analysis']), false], [gate('ttOutTraeDown', ['analysis']), true],
    [/--account trae start .*--model GPT-6\.1-Sol /.test(exec), true], [/--account trae start .*--model GPT-6\.1-Sol /.test(worker), true],
    [exec.includes('--route-args'), true]];
  const bad = cases.map(([got, want], i) => (got === want ? null : i)).filter((i) => i !== null);
  if (bad.length) fail++;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} trae gate/launch    ${cases.length} cases${bad.length ? ` — failing #${bad.join(', #')} (exec: ${exec.slice(0, 90)})` : ''}`);
}
// Both company accounts have the max-effort exemption (user, 2026-11-15).
{
  const maxGate = (sc, args) => {
    const o = parseRouteJSON(run(sc, args));
    return [o.pick?.account, o.pick?.effort, o.needsUserOK.includes('max effort')];
  };
  // Explicit actuals test the max exemption independently of history fallback.
  const max = ['implement-hard','--impact','release','--failures','1','--actual','codex:gpt-6.1-sol:xhigh@trae','--exclude-model','gpt-6-astra'];
  const cases = [
    [maxGate('ttFresh',max),['ttadk','max',false]],
    [maxGate('ttAndTrae',max),['ttadk','max',false]],
    [maxGate('ttOutTrae',max),['trae','max',false]],
    [maxGate('traeOnly',max),['trae','max',false]],
    [maxGate('ttOutTrae',[...max,'--urgent']),['trae','max',false]],
    [maxGate('ttOutTrae',['implement-hard','--impact','release']),['trae','xhigh',false]],
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
  const ok = (sc, args) => parseRouteJSON(run(sc, args)).needsUserOK.some((n) => /^personal quota:/.test(n));
  const cases = [[ok('ttAndTrae', ['implement', '--impact', 'service', '--exclude-account', 'ttadk,trae']), true],
    [ok('ttAndTrae', ['implement', '--impact', 'service', '--exclude-account', 'ttadk']), false],
    [ok('ttAndTrae', ['implement', '--impact', 'service']), false], [ok('ttOutTrae', ['image-gen']), false],
    [ok('ttOutTraeDown', ['analysis', '--stakes', 'high']), true], [ok('ttOutTraeDown', ['analysis', '--urgent']), true],
    [ok('traeOnly', ['implement', '--impact', 'service', '--exclude-account', 'trae']), true], [ok('fresh', ['implement', '--impact', 'service']), false]];
  const bad = cases.map(([got, want], i) => (got === want ? null : i)).filter((i) => i !== null);
  if (bad.length) fail++;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} personal-quota ask  ${cases.length} cases${bad.length ? ` — failing #${bad.join(', #')}` : ''}`);
}
// No silent holds: company-device personal fallbacks ask; personal-only devices have standing permission.
{
  const ok = (sc, args) => parseRouteJSON(run(sc, args)).needsUserOK.length > 0;
  const cases = [[ok('codexOut', ['lookup', '--stakes', 'low']), true], [ok('codexOutClaudeOver', ['implement', '--impact', 'service']), true],
    [ok('codex5h', ['implement', '--impact', 'service']), true], [ok('ttUnhealthy', ['implement', '--impact', 'service']), true],
    [ok('ttUnhealthy', ['implement', '--impact', 'service', '--urgent']), true], [ok('codexOut', ['lookup', '--stakes', 'low', '--urgent']), true]];
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
// AU-6: non-code rework stays separate from first-pass success and model code-rework rounds.
// Unknown causes retain legacy code-rework treatment; retry guidance is unchanged.
{
  const { modelView, dedupeOutcomes } = await import('../lib/state.mjs');
  const view = (outcome) => {
    const row = modelView(outcome);
    return { result: row.result, nonCodeRework: row.nonCodeRework === true, rounds: row.rounds };
  };
  const r = (cause) => view({ result: 'rework', rounds: 2, cause });
  const codeRework = { result: 'rework', nonCodeRework: false, rounds: 2 };
  const nonCodeRework = { result: 'rework', nonCodeRework: true, rounds: null };
  const note = (args) => parseRouteJSON(run('fresh', args)).allNotes.some((n) => /new defect of the same kind/.test(n));
  const corrected = dedupeOutcomes([{ t: 1, project: 'p', name: 'cause', result: 'rework', rounds: 2, cause: 'code' },
    { t: 2, project: 'p', name: 'cause', correction: true, cause: 'infra' }])[0];
  const cases = [[r('code'), codeRework], [r(undefined), codeRework],
    [r('infra'), nonCodeRework], // #2: infrastructure rework is not first-pass success.
    [r('spec'), nonCodeRework], // #3: specification rework is not first-pass success.
    [r('scope'), nonCodeRework], // #4: scope rework is not first-pass success.
    [note(['implement', '--impact', 'service', '--failures', '2']), true], [note(['implement', '--impact', 'service', '--failures', '1']), false],
    [note(['research', '--failures', '2']), false],
    // #8: correcting the cause reclassifies rework without moving its completion date.
    [{ ...view(corrected), completedAt: corrected.completedAt, correctedAt: corrected.correctedAt, t: corrected.t },
      { ...nonCodeRework, completedAt: 1, correctedAt: 2, t: 1 }]];
  const bad = cases.flatMap(([got, want], i) => { try { assert.deepEqual(got, want); return []; } catch { return [i]; } });
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
// TRAE pauses; GPT out → DeepSeek-V4.1-Flash → Gemini-3.1-Pro → Claude; with GPT up, a different
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
  // One model-unavailable failure pauses Flash only; Pro remains listed but is not an eligible fallback.
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
  const o = (sc, args) => parseRouteJSON(run(sc, args));
  const pk = (sc, args) => { const r = o(sc,args);if(args.includes('--failures')) {assert.ok(!r.plan.reasons?.some(p=>p.code==='PREVIOUS_ATTEMPT_UNKNOWN'));return 'RETRY';} return r.deferred ? 'DEFER' : `${r.pick?.model} ${r.pick?.effort} @${r.pick?.account}`; };
  const hasNote = (sc, args, re) => o(sc, args).allNotes.some((n) => re.test(n));
  const personal = (sc, args) => o(sc, args).needsUserOK.some((n) => /^personal quota:/.test(n));
  // trae-health: a restriction on one family pauses that family only; a success elsewhere leaves it paused; auth pauses all.
  const hh = fs.mkdtempSync(path.join(tmp, 'trae-h-'));
  noteFailure(hh, R, t, 'GPT-6.1-Sol'); noteSuccess(hh, 'DeepSeek-V4.1-Flash');
  const gptStill = !!readPoolPauses(hh).gpt, acctFree = readPause(hh) === null;
  noteSuccess(hh, 'GPT-6.1-Sol'); const gptCleared = !readPoolPauses(hh).gpt;
  const ah = fs.mkdtempSync(path.join(tmp, 'trae-ha-')); noteFailure(ah, '401 Unauthorized', t, 'DeepSeek-V4.1-Flash');
  const cases = [
    [poolOf('Gemini-3.1-Pro-Preview'), 'gemini'], [poolOf('gpt-6.1-sol'), 'gpt'], [poolOf(null), null],
    [gptStill, true], [acctFree, true], [gptCleared, false], [!!readPause(ah), true],
    [gptPause?.pausedUntil, reset.getTime()], [gptPause?.restricted, true],
    [/vendor's policy until 08:00 China time \(00:00 UTC\); probed then/.test(gptPause?.reason), true],
    // Hard work (a code retry) is Sol/Astra only: Sol notches, then Astra, then personal Claude. No fallback family.
    [pk('traeFull', ['implement']), 'gpt-6.1-sol high @trae'],
    [pk('traeFull', ['implement', '--failures', '2']), 'RETRY'],
    [pk('traeFull', ['implement', '--failures', '3']), 'RETRY'],
    [pk('traeFull', ['implement', '--failures', '4']), 'RETRY'],
    // GPT-6-Astra on the company account after Sol max (live test 2026-11-13): company quota, no OK.
    [pk('traeFull', ['implement', '--failures', '5']), 'RETRY'],
    [pk('traeFull', ['implement', '--failures', '6']), 'RETRY'],
    [o('traeFull', ['implement', '--failures', '5']).needsUserOK.some((n) => /Astra/.test(n)), false],
    [o('traeFull', ['implement', '--failures', '3']).blocked, false],
    // A ChatGPT-account Astra still asks first (5x Sol usage).
    [o('ttFresh', ['science', '--impact', 'service', '--failures', '2']).blocked, false],
    // A light lookup starts on TRAE's light list (DeepSeek) and escalates to Sol; the third retry is Sol xhigh.
    [pk('traeFull', ['lookup', '--failures', '3']), 'RETRY'],
    // GPT paused on TRAE: normal work walks the fallbacks, no personal-quota question, then Claude. A hard retry
    // (implement --failures 1) has no fallback family: it goes to Sol on the company ChatGPT account, then Claude.
    [pk('traeGptOut', ['implement']), 'deepseek-v4.1-flash high @trae'],
    [pk('traeGptOut', ['implement', '--failures', '1']), 'RETRY'],
    [pk('traeGptOut', ['implement', '--failures', '2']), 'RETRY'],
    [pk('traeGptOut', ['implement', '--failures', '3']), 'RETRY'],
    [personal('traeGptOut', ['implement']), false],
    [pk('traeGptOut', ['image-read']), 'seed-evolving medium @trae'],
    [pk('traeGptOut', ['lookup']), 'deepseek-v4.1-flash high @trae'],
    [o('traeGptOut', ['lookup']).pick?.command.includes('--model DEEPSEEK-V4.1-FLASH '), true],
    // The same through --exclude-model (an infrastructure miss on one task).
    [pk('traeFull', ['implement', '--exclude-model', 'gpt']), 'deepseek-v4.1-flash high @trae'],
    [pk('traeFull', ['implement', '--exclude-model', 'gpt,deepseek-v4.1-flash']), 'gpt-6.1-sol high @main'],
    // With Gemini gone from TRAE (2026-11-13), Seed-Evolving is the image reader only: image-read falls back to it,
    // implement never picks it; a model-unavailable pause drops only that model, its family-mate keeps routing.
    [pk('traeNoGem', ['image-read', '--exclude-model', 'gpt']), 'seed-evolving medium @trae'],
    [pk('traeNoGem', ['implement', '--exclude-model', 'gpt']), 'deepseek-v4.1-flash high @trae'],
    [pk('traeNoGemPaused', ['implement', '--exclude-model', 'gpt']), 'gpt-6.1-sol high @main'],
    [pk('traeNoGemPaused', ['implement']), 'gpt-6.1-sol high @trae'],
    // The task flag uses that same exclusion path, scoped to TRAE, with the normal fallback ladder and gates.
    // Security reviews are adversarial by default: DeepSeek-V4.1-Flash is the only company non-GPT model here.
    [pk('traeFull', ['review-high', '--security']), 'deepseek-v4.1-flash high @trae'],
    [pk('traeFull', ['implement', '--impact', 'service', '--security']), 'deepseek-v4.1-flash high @trae'],
    [pk('traeFull', ['implement', '--security', '--failures', '1']), 'RETRY'],
    [pk('traeFull', ['implement', '--security', '--exclude-model', 'deepseek']), 'gpt-6.1-sol high @main'],
    [personal('traeFull', ['implement', '--security']), false],
    [o('traeFull', ['review-high', '--security']).security, true],
    [o('traeFull', ['review-high']).security, false],
    [o('traeFull', ['review-high', '--security']).why.some((n) => /adversarial: no GPT model on any account.*Kimi-K3, DeepSeek/.test(n)), true],
    [o('ttAndTrae', ['review-high', '--security']).why.some((n) => /security task:/.test(n)), false],
    [hasNote('traeFull', ['implement', '--security'], /no review/), true],
    [hasNote('traeFull', ['review-high', '--security'], /describe defensive intent and ask for findings with impact and fix; avoid requesting step-by-step exploit code/), true],
    [hasNote('fresh', ['review-high'], /describe defensive intent/), false],
    // Fallback-written service code gets a review that keeps its family off the reviewer seat.
    [hasNote('traeGptOut', ['implement', '--impact', 'service'], /route\.mjs review --author codex --exclude-model deepseek/), false],
    [hasNote('traeGptOut', ['implement', '--impact', 'throwaway'], /review required/), false],
    [pk('traeGptOut', ['review', '--author', 'codex', '--exclude-model', 'deepseek']), 'sonnet high @undefined'],
    // A second free reviewer on TRAE comes from another family, not a fresh Sol.
    [o('traeFull', ['review', '--author', 'codex']).secondOpinion?.model, undefined],
    [hasNote('traeGptOut', ['review', '--author', 'codex'], /independent other-family GPT\/Claude reviewer/), false],
    // A hard review (review-high) has no fallback family: with GPT paused on TRAE it drops to Claude behind the gate.
    [hasNote('traeGptOut', ['review-high'], /independent other-family GPT\/Claude reviewer/), false],
    [hasNote('traeGptOut', ['build-run'], /health thresholds.*rollback triggers.*stronger-model judgment/), true],
    [hasNote('traeGptOut', ['analysis'], /default headless Playwright MCP is for public\/local pages only.*Missing login means BLOCKED/), true],
    [hasNote('traeFull', ['implement', '--exclude-model', 'gpt,deepseek'], /Gemini-3\.1-Pro ran past 40 minutes/), false],
    [hasNote('traeGptOut', ['implement'], /can't see images/), true], [hasNote('traeGptOut', ['image-read'], /can't see images/), false],
    // Every family out: personal quota, behind the user's OK.
    [o('traeAllOut', ['implement']).kind, 'blocked'],
  ];
  const bad = cases.map(([got, want,label], i) => (got === want ? null : `${i} ${label??''} (${got})`)).filter((i) => i !== null);
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
    const personalPick = claudePick;
    // A --security review is adversarial: with no company non-GPT model eligible it lands on Opus behind the gate.
    const advPick = args[0] === 'second-opinion' ? 'opus high @undefined' : 'opus xhigh @undefined';
    // A hard review (review-high) uses Sol/Astra only; with those paused or excluded the rung drops to Claude behind
    // the gate. Normal reviews keep the fallback ladder.
    const hardRow = args[0] === 'review-high';
    for (const [sc, flags, priorWant, priorGate] of [
      ['traeReviewFull', ['--security', '--exclude-model', 'deepseek', '--dry'], advPick, true],
      ['traeFull', ['--security', '--exclude-model', 'deepseek'], advPick, true],
      ['traeReviewGptOut', ['--exclude-model', 'deepseek'], hardRow ? claudePick : 'gpt-6.1-sol high @main', hardRow],
      ['traeReviewFull', ['--exclude-model', 'gpt,deepseek'], hardRow ? 'opus xhigh @undefined' : 'gpt-6.1-sol high @main', hardRow],
      // High-stakes reviews exclude DeepSeek; normal reviews keep Gemini then Claude, hard reviews are Sol/Astra only.
      ['traeReviewGptOut', [], hardRow ? claudePick : 'deepseek-v4.1-flash high @trae', hardRow],
      ['traeFull', ['--security', '--failures', '2'], advPick, true], // the adversarial ladder is DeepSeek → Claude
      ['traeReviewFull', ['--security', '--exclude-model', 'deepseek,gemini'], advPick, true],
      ['traeReviewFull', ['--security', '--exclude-model', 'deepseek,gemini', '--urgent'], advPick, false],
      ['traeReviewGptOut', ['--exclude-model', 'deepseek,gemini'], personalPick, true],
      ['traeReviewGptOut', ['--exclude-model', 'deepseek,gemini', '--urgent'], personalPick, false],
      ['traeReviewFull', ['--exclude-model', 'gpt,deepseek,gemini'], claudePick, true],
      ['traeReviewChatOut', ['--security', '--exclude-model', 'deepseek,gemini'], advPick, true],
      ['traeReviewFull', [], 'gpt-6.1-sol xhigh @trae', false],
      ['traeFull', [], args[0] === 'review' ? 'gpt-6.1-sol xhigh @trae' : claudePick, false],
      ['ttFresh', ['--security', '--exclude-model', 'deepseek'], advPick, true],
    ]) {
      const routeArgs = [...args, ...flags];
      let want=priorWant,gate=priorGate;
      if(flags.includes('--failures')) {want='DEFER';gate=false;}
      else if(!flags.length&&['traeReviewFull','traeFull'].includes(sc)) {want=hardRow?claudePick:'deepseek-v4.1-flash high @trae';gate=hardRow;}
      else if(flags.includes('--urgent')&&want.includes('@undefined')) gate=true;
      if(want==='gpt-6.1-sol high @main') {want=args[0]==='second-opinion'?'opus high @undefined':'sonnet high @undefined';gate=true;}
      if(want!==priorWant||gate!==priorGate) expectationChanges.push({scenario:sc,args:routeArgs,old:priorWant,next:want,oldGate:priorGate,gate,reason:'V08/V10/V16: scoped consent, real actual floor and routine single independent reviewer'});
      const result = o(sc, routeArgs);
      const got = result.deferred ? 'DEFER' : `${result.pick?.model} ${result.pick?.effort} @${result.pick?.account}`;
      const gotGate = result.needsUserOK.some((n) => /^personal quota:/.test(n));
      const checkFreeSecond=false;
      const freeSecond=args[0]!=='review'||flags.includes('--security')||result.secondOpinion===null;
      const ok=got===want&&gotGate===gate&&freeSecond;
      if (!ok) fail++;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${sc.padEnd(19)} ${routeArgs.join(' ')} (review pick/gate) ${ok ? `${got}, personal quota: ${gotGate}` : `want "${want}" / ${gate}, got "${got}" / ${gotGate}${checkFreeSecond && !freeSecond ? ' (extra reviewer must stay on the eligible company family)' : ''}`}`);
    }
  }
}
// Task-duration retro: brief amendments, model fit and build/device advice without new required flags.
{
  const o = (sc, args) => parseRouteJSON(run(sc, args));
  const hasNote = (r, re) => r.allNotes.some((n) => re.test(n));
  const cases = [];
  for (const cat of CODE) for (const failures of [0, 1, 2]) {
    cases.push([hasNote(o('traeFull', [cat, '--failures', String(failures)]), /if the last miss was spec\/process, amend the brief's acceptance first/), failures >= 1]);
  }
  cases.push([hasNote(o('traeFull', ['analysis', '--failures', '1']), /last miss was spec\/process/), false]);
  for (const cat of ['implement', 'implement-hard', 'debug']) {
    cases.push([hasNote(o('traeGptOut', [cat]), /DeepSeek: read-only analysis and simple edits only; not full-package builds, auth\/storage reviews or acceptance.*--exclude-model deepseek/), cat === 'implement', `${cat}: limits only for selected/listed DeepSeek`]);
  }
  // Adversarial --security reviews are the approved DeepSeek exception; the non-adversarial sensitive rows keep it out.
  for (const args of [['build-run'], ['review-high'], ['review', '--impact', 'release'], ['review', '--stakes', 'high']]) {
    for (const sc of ['traeFull', 'traeGptOut', 'traeNoGem']) for (const failures of [0, 1, 2, 3, 4, 5, 6]) {
      const r = o(sc, [...args, '--failures', String(failures)]);
      cases.push([r.pick?.model.startsWith('deepseek') ?? false, false,`${sc}/${args.join(' ')}/${failures}/primary`], [r.secondOpinion?.model.startsWith('deepseek') ?? false, false,`${sc}/${args.join(' ')}/${failures}/second`]);
    }
    // With GPT excluded and Gemini absent, DeepSeek cannot bypass the personal-quota approval gate.
    const r = o('traeNoGem', [...args, '--exclude-model', 'gpt']);
    cases.push([r.needsUserOK.some((n) => /^personal quota:/.test(n)), true]);
  }
  for (const cat of ['analysis', 'review', 'implement']) cases.push([o('traeGptOut', [cat]).pick?.model, 'deepseek-v4.1-flash']);
  for (const cat of ['build-run', 'ui-browser', 'computer-use']) {
    const r = o('ttFresh', [cat]);
    cases.push([hasNote(r, /guarded executor.*continuous idle evidence.*every orchestrator's release/), true],
      [hasNote(r, /at most 3 concurrent heavy builds unless the ledger sets N otherwise/), false],
      [hasNote(r, /at most 2 h, then return the device and report.*device connected and unlocked/), true],
      [hasNote(r, /iphone8, iphone11 and s21.*Allow\/Authorize\/Trust\/OK.*no per-prompt approval or button whitelist/), false],
      [/personal iPhone 15 Pro Max \(`policy=never`\).*device not registered in `res`/.test(loadDigest().worker), true],
      [hasNote(r, /Codex refuses an allowed device prompt.*re-route that step to Claude instead of asking the user to tap it/), true]);
  }
  const leased = o('ttFresh', ['lookup', '--device-lease']);
  cases.push([hasNote(leased, /iphone8, iphone11 and s21.*camera, microphone, photos, notifications, local network, tracking, developer trust, USB debugging and install confirmations/), false],
    [hasNote(leased, /Take\/return through res.*lease <=2 h.*never enter personal-account credentials, passwords or verification codes.*no purchases/), true]);
  const ordinary = o('ttFresh', ['lookup']);
  cases.push([hasNote(ordinary, /^registered shared test phones iphone8/), false]);
  cases.push([hasNote(o('traeFull', ['implement', '--impact', 'release']), /route\.mjs review-high --review-class A/), true]);
  const bad = cases.map(([got, want,label], i) => (got === want ? null : `${i} ${label??''} (${got})`)).filter((i) => i !== null);
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
    [Object.keys(pools).length, 0], [acct, null], [one, 1], [cleared, 1],
  ];
  const bad = cases.map(([got, want,label], i) => (got === want ? null : `${i} ${label??''} (${got})`)).filter((i) => i !== null);
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
  probeResult(home, 'GPT-6.1-Sol', false, 'probe timed out', midnight + 12 * m,stale[0]?.claim);
  const failed = readPoolPauses(home, midnight + 13 * m).gpt;
  const failedEarly = claimProbes(home, midnight + day - 1), nextDue = claimProbes(home, midnight + day);
  probeResult(home, 'GPT-6.1-Sol', true, '', midnight + day + m,nextDue[0]?.claim);
  const back = Object.keys(readPoolPauses(home, midnight + day + m));
  const hh = fs.mkdtempSync(path.join(tmp, 'trae-probe-hard-'));
  const hp = noteFailure(hh, hard, t0, 'GPT-6.1-Sol');
  const hardEarly = claimProbes(hh, t0 + 29 * m), hardDue = claimProbes(hh, t0 + 30 * m);
  probeResult(hh, 'GPT-6.1-Sol', false, hard, t0 + 31 * m,hardDue[0]?.claim);
  const hardFailed = readPoolPauses(hh, t0 + 32 * m).gpt, hardRetry = claimProbes(hh, t0 + 61 * m);
  // A restriction reported by a probe also switches a previously ordinary hard pause to the vendor reset.
  probeResult(hh, 'GPT-6.1-Sol', false, R, t0 + 62 * m,hardRetry[0]?.claim);
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
  probeResult(legacyHome, 'GPT-6.1-Sol', false, 'probe timed out', midnight + m,claimProbes(legacyHome,midnight)[0]?.claim);
  const legacyFailed = readPoolPauses(legacyHome, midnight + 2 * m).gpt;
  const cases = [[p1?.pausedUntil, midnight], [p1?.restricted, true], [during.join(), 'gpt'], [early.length, 0],
    [before.length, 0], [Object.keys(after).join(), 'gpt'], [/awaiting a recovery probe/.test(after.gpt?.reason), true],
    [JSON.stringify(due.map(({pool,model})=>({pool,model}))), JSON.stringify([{ pool: 'gpt', model: 'GPT-6.1-Sol' }])], [again.length, 0], [stale.length, 1],
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
  const bad = cases.map(([got, want,label], i) => (got === want ? null : `${i} ${label??''} (${got})`)).filter((i) => i !== null);
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
    for (const company of [[], [tt({ healthy: false, quotaOut: { resetsAt: now + h } })], [tt({ browser: false,desktop:false })]]) {
      for (const astraDepleted of [false, true]) {
        const personal = [acc('main', 20, 120), acc('b', 30, 100, [], { browser: true,desktop:true })];
        const trae = tr({ home, models: [SOL, ASTRA, 'deepseek-v4.1-flash'],
          quota: { daily: { [SOL]: bucket(true), [ASTRA]: bucket(astraDepleted) } } });
        S.browserQuota = { claude: cl(10, 120), codex: [...personal, ...company, trae] };
        S.browserQuotaBaseline = { ...S.browserQuota, codex: [...personal, ...company, { ...trae, quota: null }] };
        for (const cat of ['browser', 'ui-browser', 'computer-use']) {
          const args = [cat, ...(cat === 'computer-use' ? ['--apps', 'com.apple.Notes'] : ['--origins', 'example.com'])];
          const baseline = parseRouteJSON(run('browserQuotaBaseline', args)), routed = parseRouteJSON(run('browserQuota', args));
          if(company.some(a=>a.quotaOut)) {assert.equal(routed.kind,'blocked');assert.equal(baseline.kind,'blocked');assert.equal(routed.deferred,null);assert.equal(routed.pick?.account,'b');}
          assert.equal(routed.pick?.model, SOL); assert.equal(routed.pick?.account, 'b');
          assert.deepEqual(routed.pick, baseline.pick); assert.deepEqual(routed.needsUserOK, baseline.needsUserOK);
          assert.equal(routed.balance?.selected ?? false, false);
          assert.ok(!routed.why.some((s) => /bucket is depleted|background:|balanced to TRAE/.test(s)));
          const exhaustedArgs = [...args, '--failures', '20'];
          const exhausted = parseRouteJSON(run('browserQuota', exhaustedArgs));
          assert.ok(exhausted.pick);assert.ok(!exhausted.plan.reasons?.some(r=>r.code==='PREVIOUS_ATTEMPT_UNKNOWN'));assert.ok(exhausted.why.some(w=>/assumed first/.test(w)));
          assert.deepEqual(exhausted.needsUserOK, parseRouteJSON(run('browserQuotaBaseline', exhaustedArgs)).needsUserOK);
          const background = parseRouteJSON(run('browserQuota', [...args, '--background']));
          assert.equal(background.kind,'blocked');assert.equal(background.pick.account,'b');assert.equal(background.pick.command,null);assert.ok(background.plan.gates.some(g=>g.kind==='personal-quota'));
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
  // Priority alternatives beat this measured slow Sol lane. Depletion alone is no longer evidence of a wait.
  fs.writeFileSync(path.join(qh, 'lane-state.json'), JSON.stringify({
    'gpt-6.1-sol': { t: now, state: 'queued', position: 500, drainPerMin: 0.5 },
  }));
  process.env.TRAE_PROBE = '0';
  const st = analyze(data);
  const lean = leanLines(st, data).join('\n');
  delete process.env.TRAE_PROBE;
  S.traeQuota = { claude: cl(10, 120), codex: [acc('main', 20, 120), tr({ home: qh, quota })] };
  const ro = parseRouteJSON(run('traeQuota', ['implement', '--stakes', 'high']));
  cases.push(
    [lean.includes("TRAE gpt-6.1-sol's daily high-priority quota is used up"), true],
    [ro.pick?.model, 'gpt-6-astra'], [ro.pick?.account, 'trae'],
    [ro.why.some((n) => /ETA:.*company.*gpt-6-astra/.test(n)), true],
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
  scenario('quotaHardUnknown', S.quotaBoth.codex.at(-1).quota.daily,
    { home: fs.mkdtempSync(path.join(tmp, 'quota-hard-unknown-')) });
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
  const route = (sc, args = ['implement']) => parseRouteJSON(run(sc, args));
  const note = (r, re) => r.allNotes.some((n) => re.test(n));
  for (const [sc, args, want] of [
    ['quotaAstra', ['implement'], 'deepseek-v4.1-flash'],
    ['quotaPreferred', ['implement'], 'gpt-5.6-sol'],
    ['quotaPreferred', ['implement', '--failures', '1'], 'gpt-6-astra'],
    ['quotaPreferred', ['implement', '--stakes', 'high'], 'gpt-6-astra'],
    ['quotaPreferred', ['review'], 'gpt-5.6-sol'],
    ['quotaPreferred', ['review-high'], 'gpt-6-astra'],
    ['quotaPreferred', ['build-run'], 'gpt-5.6-sol'],
    ['quotaPreferred', ['image-read'], 'gpt-6-astra'], // 5.6-Sol vision is not qualified
    ['quotaPreferred', ['implement', '--security'], 'deepseek-v4.1-flash'],
    ['quotaPreferred', ['implement', '--exclude-model', 'gpt-5.6-sol'], 'deepseek-v4.1-flash'],
    ['quota56Depleted', ['implement'], 'deepseek-v4.1-flash'],
    ['quota56Expired', ['implement'], 'deepseek-v4.1-flash'],
    ['quota56Paused', ['implement'], 'deepseek-v4.1-flash'],
    ['quotaBoth', ['implement'], 'gpt-5.6-sol'],
    ['quotaBoth', ['implement', '--failures', '4'], 'opus'], // Availability fallbacks do not become retry rungs.
    ['quotaBoth', ['implement-hard'], 'gpt-6-astra'], // both hard buckets depleted: keep a hard model, never demote to 5.6/DeepSeek
    ['quotaBoth', ['lookup'], 'deepseek-v4.1-flash'],
    ['quotaBoth', ['extract'], 'deepseek-v4.1-flash'],
    ['quotaBoth', ['draft'], 'deepseek-v4.1-flash'],
    ['quotaBoth', ['lookup', '--stakes', 'high'], 'gpt-6-astra'], // hard tier keeps Sol/Astra on the low-priority lane
    // Without lane evidence, tied hard ETAs retain main's Sol preference; measured slow Sol above prefers Astra.
    ['quotaHardUnknown', ['implement-hard'], 'gpt-6.1-sol'],
    ['quotaHardUnknown', ['lookup', '--stakes', 'high'], 'gpt-6.1-sol'],
    ['quotaBoth', ['implement-hard', '--exclude-model', 'gpt-6-astra'], 'gpt-6.1-sol'],
    ['quotaBoth', ['implement-hard', '--exclude-model', 'gpt-6.1-sol'], 'gpt-6-astra'],
    // Light lookup (DeepSeek) escalates to Sol medium; Sol's bucket is depleted, so the comparable GPT with quota
    // (5.6-Sol) takes the escalation — company quota, not personal Sonnet and not another light model.
    ['quotaBoth', ['lookup', '--failures', '1'], 'gpt-5.6-sol'],
    ['quotaBoth', ['build-run'], 'gpt-5.6-sol'],
    ['quotaMissing', ['implement'], 'gpt-5.6-sol'],
    ['quotaMissingModel', ['implement'], 'deepseek-v4.1-flash'], // fresh slow Sol telemetry beats an unknown bucket
    ['quotaUnknownAstra', ['implement'], 'deepseek-v4.1-flash'],
    ['quotaNoAstra', ['implement'], 'deepseek-v4.1-flash'],
    ['quotaPausedAstra', ['implement'], 'deepseek-v4.1-flash'],
    ['quotaSecondFallback', ['implement'], 'deepseek-v4.1-flash'],
    ['quotaAstra', ['implement', '--exclude-model', 'gpt-6-astra'], 'deepseek-v4.1-flash'],
    ['quotaAstra', ['implement', '--exclude-model', 'gpt'], 'deepseek-v4.1-flash'],
    ['quotaAstra', ['implement', '--security'], 'deepseek-v4.1-flash'],
    ['quotaAstra', ['implement', '--failures', '1'], 'gpt-6-astra'],
    ['quotaFallbackBusy', ['implement', '--failures', '2'], 'gpt-6-astra'],
    ['quotaAllBusy', ['implement'], 'gpt-6.1-sol'],
    ['quotaTT', ['implement'], 'gpt-6.1-sol'], // healthy TTADK remains first
    ['quotaExpiredSol', ['implement'], 'deepseek-v4.1-flash'], // expiry does not erase fresh model queue evidence
    ['quotaExpiredAstra', ['implement'], 'deepseek-v4.1-flash'],
    ['quotaExpiredFallback', ['implement'], 'gpt-5.6-sol'], // no 5.6 quota, DeepSeek expired: depleted Sol low-priority lane
  ]) {
    const r = route(sc, args);
    if(args.includes('--failures')&&Number(args[args.indexOf('--failures')+1])>0) {
      cases.push([!!r.pick&&!r.plan.reasons?.some(p=>p.code==='PREVIOUS_ATTEMPT_UNKNOWN'),true,`${sc} first-rung fallback retry`]); continue;
    }
    // Fresh Astra units supply its missing-load readiness; do not overwrite that
    // explicit hard/vision expectation with the legacy unmeasured Sol fallback.
    const astraUnitsReady=sc==='quotaPreferred'&&want==='gpt-6-astra';
    const qualityWant=!astraUnitsReady&&!args.includes('--security')&&!args.includes('gpt')&&!args.includes('gpt-6.1-sol')&&(args.includes('high')||args[0]!=='lookup'&&args[0]!=='extract'&&args[0]!=='draft')?'gpt-6.1-sol':want;
    cases.push([r.pick?.model, qualityWant, `${sc} ${args.join(' ')} quality-first model`], [r.failures, args.includes('--failures') ? Number(args[args.indexOf('--failures') + 1]) : 0, `${sc} ${args.join(' ')} failures`]);
  }
  const idle = route('quotaAstra'), busy = route('quotaBusy'), missing = route('quotaMissing');
  for (const sc of ['quotaBoth', 'quotaHardUnknown']) {
    for (const args of [['implement-hard'], ['debug'], ['science'], ['review-high'], ['design'], ['lookup', '--stakes', 'high']]) {
      for (const flags of [[], ['--background']]) {
        const r = route(sc, [...args, ...flags]);
        const label = `${sc} ${[...args, ...flags].join(' ')}`;
        if(args[0]==='review-high') {cases.push([r.executable,true,`${label} primary launches while independent reviewer remains pending`]);continue;}
        cases.push([['gpt-6.1-sol', 'gpt-6-astra'].includes(r.pick?.model), true, `${label} hard floor`],
          [r.pick?.account, 'trae', `${label} company lane`], [r.needsUserOK.length, 0, `${label} no personal quota`],
          [(r.eta ?? []).every((row) => ['gpt-6.1-sol', 'gpt-6-astra'].includes(row.model)), true, `${label} ETA floor`]);
      }
    }
  }
  cases.push(
    [route('quotaPreferred').pick?.effort, idle.pick?.effort],
    [route('quotaPreferred', ['implement', '--failures', '1']).blocked, false],
    [route('quotaPreferred').pick?.command.includes('--model GPT-6.1-SOL'), true],
    [route('quotaPreferred', ['lookup']).pick?.command.includes('-m DEEPSEEK-V4.1-FLASH'), true],
    [route('quotaPreferred', ['implement', '--failures', '1']).allNotes.some((n) => /rework thread rule.*continued original thread because/.test(n)), true],
    [route('quotaPreferred').allNotes.some((n) => /rework thread rule/.test(n)), false],
    [JSON.stringify([busy.pick.model,busy.pick.effort,busy.pick.account,busy.pick.sandbox]), JSON.stringify([idle.pick.model,idle.pick.effort,idle.pick.account,idle.pick.sandbox])], [JSON.stringify(busy.needsUserOK), JSON.stringify(idle.needsUserOK)],
    [busy.deferred, null], [note(busy, /parallel task concurrency unchanged/), true],
    [missing.why.some((n) => /bucket is depleted/.test(n)), false],
    [route('quotaExpiredSol').why.some((n) => /bucket is depleted/.test(n)), false],
    [note(idle, /queue patience.*cancellation/), true],
    [note(idle, /provider-assigned low-priority\/depleted lanes remain capacity/), true],
    [note(route('quotaAllBusy'), /real model\/effort floor/), true],
    [route('quotaBoth').needsUserOK.length, 0], [route('quotaAllBusy').deferred, null],
    [route('quotaAstra', ['lookup']).pick?.launcher, 'traecli-exec'],
    [route('quotaBoth', ['lookup']).pick?.launcher, 'traecli-exec'],
    [note(route('quotaBoth', ['lookup', '--failures', '1']), /this retry is not stronger/), false],
    [route('quotaTT').pick?.account, 'ttadk'],
    [note(route('quotaAstra', ['review', '--author', 'codex']), /second TRAE reviewer/), false],
    [route('quotaAstra', ['review', '--author', 'codex']).secondOpinion?.model, undefined],
  );
  // Advice never tells the user to wait for a reset: a company candidate that can start now is launched.
  for (const cat of ['build-run', 'review', 'review-high']) {
    for (const [sc] of [['quota80'], ['quota79'], ['quotaNoLimit'], ['quotaMissing'], ['quotaChosen80'], ['quotaTT'], ['quotaNoReset']]) {
      const r = route(sc, [cat]);
      cases.push([note(r, /long builds\/large reviews:.*daily reset/), false, `${sc} ${cat}`], [r.deferred, null, `${sc} ${cat} deferred`]);
    }
  }
  cases.push([note(route('quota80'), /long builds\/large reviews:/), false],
    [note(route('quota80', ['build-run']), /quota resetTime.*TRAE normally 22:00 UTC, TTADK 16:00 UTC/), false],
    [note(route('quotaNoReset', ['build-run']), /normally 22:00 UTC/), false]);
  const bad = cases.map(([got, want, label], i) => (got === want ? null : `${i} ${label ?? ''} (${got} != ${want})`)).filter((i) => i !== null);
  if (bad.length) fail++;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} trae daily quota    ${cases.length} cases${bad.length ? ` — failing #${bad.join(', #')}` : ''}`);
}
// ETA-based hard-lane choice (addendum, 2026-11-13 night): "depleted" alone says little, so compare expected completion
// (start delay + work minutes × slowdown) across the hard lanes and a TTADK reset. A wait is only an explicit
// scheduled dispatch; a resource-bound task never waits in a queue holding its lease/lock.
{
  const laneHome = (name, lanes) => {
    const home = fs.mkdtempSync(path.join(tmp, `lane-${name}-`));
    fs.writeFileSync(path.join(home, 'lane-state.json'), JSON.stringify(lanes));
    return home;
  };
  const ttOut = (resetMin) => tt({ healthy: false, reason: 'its daily token quota is used up',
    usage: { used: 100, limit: 100, utilization: 100, resetsAt: now + resetMin * 60000 } });
  const laneTr = (name, lanes) => tr({ home: laneHome(name, lanes),
    models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.6-sol', 'deepseek-v4.1-flash'],
    modelIds: Object.fromEntries(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.6-sol', 'deepseek-v4.1-flash'].map((m) => [m, m])),
    quota: { daily: { 'gpt-6.1-sol': { used: 100, limit: 100, remaining: 0, depleted: true, resetsAt: now + 6 * h },
      'gpt-6-astra': { used: 100, limit: 100, remaining: 0, depleted: true, resetsAt: now + 6 * h } }, weekly: null } });
  const lanes = (sol, astra) => ({ 'gpt-6.1-sol': { t: now, state: 'queued', ...sol },
    'gpt-6-astra': { t: now, state: 'queued', ...astra } });
  // Hopeless queue (≈0.5 positions/min) and TTADK resets in 40 min: an explicit scheduled dispatch.
  S.etaDefer = { claude: cl(10, 120), codex: [acc('main', 20, 120), ttOut(40),
    laneTr('defer', lanes({ position: 500, drainPerMin: 0.5 }, { position: 600, drainPerMin: 0.5 }))] };
  // Sol progresses with no queue cycles: it can start now and beats the TTADK reset.
  S.etaProgressing = { claude: cl(10, 120), codex: [acc('main', 20, 120), ttOut(540),
    laneTr('progress', lanes({ position: null, drainPerMin: null, lastProgressAt: now - 60000, itemsPerMin: 1.2 },
      { position: 600, drainPerMin: 0.2 }))] };
  // TTADK resets in 20 min, but the TRAE lane can finish sooner: launch, do not hold.
  S.etaResetSoon = { claude: cl(10, 120), codex: [acc('main', 20, 120), ttOut(20),
    laneTr('soon', lanes({ position: null, drainPerMin: null, lastProgressAt: now - 60000 },
      { position: 50, drainPerMin: 5 }))] };
  const parse = (sc, args) => parseRouteJSON(run(sc, args));
  const defer = parse('etaDefer', ['implement-hard']);
  const progress = parse('etaProgressing', ['implement-hard']);
  const soon = parse('etaResetSoon', ['implement-hard']);
  const bound = parse('etaDefer', ['implement-hard', '--shared-lock']);
  const { laneEta, patienceMinutes } = await import('../lib/eta.mjs');
  const queuedEta = (workMin, requests) => laneEta({ workMin, requests, bucketDepleted: true, position: 100, drainPerMin: 2 });
  const lightQ = queuedEta(5, 10), hardQ = queuedEta(90, 120);
  const checks = [
    ['queued company launches before reset', defer.kind, 'launch'],
    ['queued company has command', !!defer.pick?.command, true],
    ['no reset hold', defer.deferUntil, null],
    ['defer eta rows include TTADK', (defer.eta ?? []).some((r) => r.account === 'ttadk'), true],
    ['defer eta rows include both TRAE hard models', ['gpt-6.1-sol', 'gpt-6-astra'].every((m) => (defer.eta ?? []).some((r) => r.model === m && r.account === 'trae')), true],
    ['progressing picks Sol', progress.pick?.model, 'gpt-6.1-sol'],
    ['progressing no defer', progress.deferred, null],
    ['progressing why names lane + telemetry', progress.why.some((s) => /low-priority lane \(bucket depleted\): slower .*progressing without queue cycles/.test(s)), true],
    ['progressing patience set', typeof progress.queuePatienceMin === 'number' && progress.queuePatienceMin > 0, true],
    ['progressing launch passes patience/alt', /--queue-patience-min \d+ --alt /.test(progress.pick?.command), true],
    ['reset-soon launches', soon.deferred, null],
    ['reset-soon keeps the hard model', soon.pick?.model, 'gpt-6.1-sol'],
    ['resource-bound no defer', bound.deferred, null],
    ['resource-bound note', bound.allNotes.some((s) => /take the lease\/lock only after the first model response/.test(s)), true],
    ['resource-bound hard pick', ['gpt-6.1-sol', 'gpt-6-astra'].includes(bound.pick?.model), true],
    ['eta size: light beats a 10h reset', lightQ.completionMin < 10 * 60 + 5, true],
    ['eta size: hard loses to a 10h reset', hardQ.completionMin > 10 * 60 + 90, true],
    ['patience cap 30m', patienceMinutes({ now, ttadk: { usage: { resetsAt: now + 600 * 60000 } } }), 30],
    ['patience quarter of a 40m reset', patienceMinutes({ now, ttadk: { usage: { resetsAt: now + 40 * 60000 } } }), 10],
  ];
  // --json purity: the whole stdout is one JSON document for a code category, not a substring.
  const raw = run('etaProgressing', ['implement-hard']);
  const trimmed = raw.trim();
  checks.push(['json purity parses whole stdout', (() => { try { return !!parseRouteJSON(trimmed).pick; } catch { return false; } })(), true]);
  checks.push(['json purity is one line', trimmed.split('\n').length, 1]);
  checks.push(['json purity braces', trimmed.startsWith('{') && trimmed.endsWith('}'), true]);
  const bad = checks.map(([label, got, want], i) => (JSON.stringify(got) === JSON.stringify(want) ? null : `${i} ${label} (${JSON.stringify(got)} != ${JSON.stringify(want)})`)).filter(Boolean);
  if (bad.length) fail++;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} ETA hard-lane choice ${checks.length} cases${bad.length ? ` — ${bad.join(', ')}` : ''}`);
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
  const q = parseRouteJSON(execFileSync(process.execPath, [review, '--hours', '24', '--json'], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] })).quota;
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
  const bad = cases.map(([got, want,label], i) => (got === want ? null : `${i} ${label??''} (${got})`)).filter((i) => i !== null);
  if (bad.length) fail++;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} quota reset history ${cases.length} cases${bad.length ? ` — failing #${bad.join(', #')}` : ''}`);
}
// Sol-only quota/congestion boundaries use normal throwaway work. Light tasks require a listed light-tier model.
{
  const { BALANCE, balanceFactors, ttadkBurn } = await import('../lib/company-load.mjs');
  const SOL = 'gpt-6.1-sol', ASTRA = 'gpt-6-astra', min = 60000;
  const home = fs.mkdtempSync(path.join(tmp, 'balance-'));
  const usage = (used = 40, resetsAt = now + 8 * h) => ({ used, limit: 100, resetsAt });
  const bucket = (used = 38, extra = {}) => ({ ...usage(used), depleted: false, ...extra });
  const load = (percent = 35, t = now) => ({ [SOL]: { percent, t } });
  const queue = (position = 0, t = now, extra = {}) => ({ gpt: { t, position, state: position>0?'queued':'ready', lowPriority: false, ...extra } });
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
  const r = (key = 'balanced', args = ['implement', '--impact', 'throwaway'], q = queue(), env = {}) => {
    fs.writeFileSync(path.join(home, 'queue-state.json'), JSON.stringify(q));
    return parseRouteJSON(run(key, args, env));
  };
  const cases = [];
  const account = (key, args, q, env) => r(key, args, q, env).pick?.account;
  for (const args of [['lookup'], ['extract'], ['draft'], ['analysis', '--stakes', 'low'], ['implement', '--impact', 'throwaway']])
    cases.push([account('balanced', args), args[0] === 'implement' ? 'trae' : 'ttadk']);
  for (const key of ['balancedDepleted', 'balancedNoBucket','balancedOldBucket', 'balancedNoLimit', 'balancedHot', 'balancedDown'])
    cases.push([account(key), 'ttadk']);
  for (const key of ['balancedNoLoad','balancedOldLoad']) cases.push([account(key),'ttadk']);
  for (const key of ['balancedBelow', 'balancedReserve', 'balancedCool', 'balancedBusy'])
    cases.push([account(key), 'trae']);
  for (const args of [['analysis'], ['implement'], ['review'], ['build-run', '--stakes', 'low'], ['browser'], ['ui-browser'], ['computer-use','--apps','com.apple.Notes'], ['image-read', '--stakes', 'low'], ['lookup', '--security'], ['lookup', '--exclude-account', 'trae']])
    cases.push([account('balanced', args), ['analysis','implement','review','build-run','image-read'].includes(args[0])?'trae':'ttadk',args.join(' ')]);
  cases.push([r('balanced', ['image-gen']).pick?.account, 'main']);
  cases.push([account('balanced', ['implement', '--impact', 'throwaway'], queue(300)), 'ttadk'], [account('balanced', ['implement', '--impact', 'throwaway'], queue(301)), 'ttadk']);
  cases.push([account('balanced', ['implement', '--impact', 'throwaway'], queue(301, now - 31 * min)), 'trae'], [account('balanced', ['implement', '--impact', 'throwaway'], {}), 'trae']);
  cases.push([account('balanced', ['implement', '--impact', 'throwaway'], queue(1, now, { high: { t: now - 10 * min, position: 3100 } })), 'ttadk']);
  cases.push([account('balanced', ['implement', '--impact', 'throwaway'], queue(1, now, { high: { t: now - 31 * min, position: 3100 } })), 'ttadk']);
  // Family isolation: other families' queues never count against GPT.
  cases.push([account('balanced', ['implement', '--impact', 'throwaway'], { ...queue(), deepseek: { t: now, position: 5000, state: 'queued' } }), 'trae']);
  cases.push([account('balancedExpires', ['analysis']), 'trae'], [account('balancedLater', ['analysis']), 'trae'],
    [account('balancedLessLeft', ['analysis']), 'trae'], [account('balancedExpires', ['analysis'], {}), 'trae']);
  const env = { QUOTA_LOG_FILE: history };
  const projected = r('balanced', ['implement'], queue(), env);
  cases.push([projected.pick?.account, 'trae'], [projected.balance?.burn?.beforeReset, true],
    [projected.why.some((s) => /TRAE lane free: saving TTADK quota.*gpt-6.1-sol load 35%/.test(s)), true],
    [account('balancedNoLoad', ['implement'], queue(), env), 'ttadk'], [account('balanced', ['implement'], {}, env), 'trae'],
    [account('balanced', ['implement'], queue(400), env), 'ttadk'], [account('balancedOut', ['implement'], queue(400)), 'trae']);
  // Balancing transfers the current rung; it never substitutes an excluded/paused model or changes review count.
  scenario('balancedAstra', { quota: { daily: { [ASTRA]: bucket() } }, load: { [ASTRA]: { t: now, percent: 10 } } }, { models: [SOL, ASTRA] });
  const pausedHome = fs.mkdtempSync(path.join(tmp, 'balance-paused-'));
  const { noteFailure } = await import('../lib/trae-health.mjs');
  noteFailure(pausedHome, 'Model access temporarily restricted. (983)', now, SOL);
  scenario('balancedPaused', { home: pausedHome });
  cases.push([account('balancedPaused'), 'ttadk']);
  const idle = r(), busy = r('balancedBusy'), review = r('balanced', ['review', '--author', 'codex', '--stakes', 'low']);
  cases.push([idle.pick?.account, busy.pick?.account], [idle.pick?.effort, busy.pick?.effort], [idle.deferred, null],
    [idle.needsUserOK.length, 0], [review.pick?.model, 'sonnet'], [review.secondOpinion?.account, undefined],
    [r('balanced', ['review', '--author', 'codex']).secondOpinion?.model, review.secondOpinion?.model],
    [idle.why.some((s) => /TRAE lane free: saving TTADK quota/.test(s)), true]);
  // Exact time/share boundaries and synthetic burn-rate failures.
  const ttAccount = { name: 'ttadk', usage: usage() };
  const factors = (q) => balanceFactors({ ttadk: ttAccount, trae: { quota: { sampledAt: now, daily: { [SOL]: q } }, load: load(), queue: queue() },
    model: SOL, category: 'analysis', stakes: 'normal', now });
  cases.push([factors(bucket(38, { resetsAt: now + BALANCE.expiresH * h })).expiresSoon, false],
    [factors(bucket(40, { resetsAt: now + h })).expiresSoon, false]);
  const burn = (rows, a = ttAccount, stamp = now) => ttadkBurn(rows, a, stamp, now);
  cases.push([burn(samples).beforeReset, true], [burn([]), null], [burn(samples, ttAccount, now - 31 * min), null],
    [burn(samples.map((s) => ({ ...s, ttadk: { ...s.ttadk, used: 40 } }))).beforeReset, false],
    [burn(samples.map((s) => ({ ...s, ttadk: { ...s.ttadk, used: 40 } }))).projectedAtReset, 40],
    [burn(samples.map((s) => ({ ...s, ttadk: { ...s.ttadk, resetsAt: now - h } }))), null],
    [burn(samples.map((s) => ({ ...s, ttadk: { ...s.ttadk, limit: 200 } }))), null],
    [burn(samples.map((s) => ({ ...s, t: now - 5 * min }))), null],
    [burn(samples.map((s) => ({ ...s, ttadk: { ...s.ttadk, used: 90 } }))), null]);
  const log = path.join(home, 'route-log.jsonl');
  r('balanced', ['implement'], queue(), { ...env, ROUTE_LOG: '1', ROUTE_LOG_FILE: log });
  const logged = parseRouteJSON(fs.readFileSync(log, 'utf8').trim());
  cases.push([logged.company, 'trae'], [logged.balance.selected, true], [logged.balance.load.percent, 35], [logged.balance?.burn?.beforeReset, true]);
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
  const r = (args, scenario = 'background', env) => parseRouteJSON(run(scenario, args, env));
  try {
    for (const args of [['lookup'], ['analysis'], ['implement'], ['docs'], ['research']]) {
      const o = r([...args, '--background']);
      assert.equal(o.pick?.account,args[0]==='research'?'trae':'ttadk'); assert.equal(o.pick?.model,args[0]==='research'?FLASH:'gpt-5.6-terra');
      assert.equal(o.pick?.launcher, 'codex-worker'); assert.equal(o.background, true);
      assert.ok(!o.why.some(n=>/TRAE lane free/.test(n)),'missing Flash load cannot displace ready TTADK');
      assert.ok(o.allNotes.some((n)=>/dependencies and build tools|launch as a background task/.test(n)));
      assert.ok(!o.allNotes.some((n) => /Above ~300, consider|hub queue position above ~300/.test(n)));
    }
    assert.equal(r(['lookup']).pick?.account, 'ttadk'); // Missing Flash load falls back to the hot account; foreground balancing is vetoed.
    assert.equal(r(['--background', 'lookup']).pick?.account, 'ttadk');
    const gemini = r(['lookup', '--background'], 'backgroundGemini');
    assert.equal(gemini.kind,'blocked');assert.equal(gemini.pick.command,null);assert.ok(!gemini.pick.company);assert.ok(gemini.plan.gates.some(g=>g.kind==='personal-quota'));
    assert.ok(gemini.allNotes.some((n) => /list --limit 1.*only if unreachable.*global-rules owner/.test(n)));
    assert.ok(!gemini.allNotes.some((n) => /twice what the task should take|codex exec still works/.test(n)));
    assert.equal(r(['implement'], 'backgroundOnly').pick?.model, SOL); // Sol's hot load does not establish Flash congestion; its free bucket remains usable when TTADK is out.
    assert.equal(r(['implement', '--background'], 'backgroundOnly').pick?.model, FLASH);
    assert.equal(r(['lookup','--background','--security']).pick?.model,'gpt-5.6-terra');
    assert.equal(r(['lookup','--background','--security']).pick?.account,'ttadk');
    for (const args of [['review', '--security'], ['review-high', '--security']]) {
      const o = r([...args, '--background'], 'backgroundOnly');
      // Adversarial reviews use the company non-GPT model in the background lane too; no second family here.
      assert.equal(o.kind,'launch');assert.equal(o.pick.account,'trae');assert.ok(o.plan.gates.some(g=>g.phase==='acceptance'));assert.ok(o.secondOpinion);assert.equal(o.secondOpinion.command,null);
    }
    {
      const o = r(['lookup', '--exclude-model', 'gpt,deepseek', '--background'], 'backgroundOnly');
      assert.equal(o.kind,'blocked');assert.equal(o.pick.command,null);assert.ok(o.plan.gates.some(g=>g.kind==='personal-quota'));assert.equal(o.secondOpinion,null);
      assert.ok(o.tellUser.some((n) => /No runnable authorized background lane|personal quota/.test(n)));if(o.kind==='defer') assert.ok(o.needsUserOK.some(n=>/personal quota now, or wait/.test(n)));
    }
    assert.equal(r(['image-read', '--background']).pick?.account, 'ttadk');
    for (const args of [['browser'], ['ui-browser'], ['computer-use'], ['build-run'], ['image-read', '--device-lease'], ['lookup', '--device-lease'], ['lookup', '--shared-lock']]) {
      const o = r([...args, '--background']);
      if(args.includes('--device-lease')||args[0]==='computer-use') {assert.equal(o.blocked,true);continue;}
      assert.equal(o.pick?.account, 'ttadk'); assert.ok(!o.why.some((n) => n.startsWith('background:')));
    }
    assert.equal(r(['lookup', '--background', '--exclude-account', 'trae']).pick?.account, 'ttadk');
    assert.equal(r(['lookup', '--background', '--exclude-model', SOL]).pick?.model,'gpt-5.6-terra');
    for (const scenario of ['backgroundNoModels', 'ttOutTraeDown', 'fresh', 'unreadable']) {
      const o = r(['lookup', '--background', '--urgent'], scenario);
      if(scenario==='fresh') {assert.equal(o.kind,'launch');assert.equal(o.pick.account,'main');continue;}
      assert.ok(!o.pick||o.pick.command===null); assert.equal(o.secondOpinion, null); assert.equal(o.redeemFirst, null);
      assert.ok(o.tellUser.some((n) => /No runnable authorized background lane|personal quota/.test(n)));
      if(o.kind==='defer') assert.equal(o.needsUserOK.some(n=>/personal quota now, or wait/.test(n)), S[scenario].codex.some(a=>['ttadk','trae'].includes(a.kind)));
    }
    for (const args of [['implement', '--failures', '20'], ['design'], ['review-high'], ['review', '--author', 'codex'], ['second-opinion', '--against', 'codex']]) {
      const o = r([...args, '--background']);
      for (const p of [o.pick,o.secondOpinion].filter(Boolean)) {if(p.company) {assert.equal(p.vendor,'codex');assert.ok(['trae','ttadk'].includes(p.account));} else {assert.equal(p.command,null);assert.ok(o.needsUserOK.some(n=>/personal quota/.test(n)));}}
    }
    const log = path.join(home, 'routes.jsonl');
    r(['lookup', '--background', '--project', 'p', '--name', 'nightly'], 'background', { ROUTE_LOG: '1', ROUTE_LOG_FILE: log });
    const logged = parseRouteJSON(fs.readFileSync(log, 'utf8'));
    assert.equal(logged.background, true); assert.equal(logged.pick?.account, 'ttadk');
    console.log('ok   background lane: depletion, congestion, security, exclusions, launch, log and company-only escalation');
  } catch (e) { fail++; console.log(`FAIL background lane: ${e.stack}`); }
}
// Background uses the light tier unless hard rules apply; image-reading keeps its vision-specific order.
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
  const r = (args = ['analysis']) => parseRouteJSON(run('backgroundOrder', [...args, '--background']));
  const cases = [
    [{ ...active, [SOL]: bucket(true) }, ['analysis'], FLASH, 2],
    [{ ...active, [ASTRA]: bucket(true) }, ['analysis'], FLASH, 2],
    [{ [SOL]: bucket(true), [ASTRA]: bucket(true) }, ['lookup'], FLASH, 2],
    [{ [ASTRA]: bucket(true) }, ['analysis', '--stakes', 'high'], ASTRA, 1, [ASTRA]],
    [{ ...active, [ASTRA]: bucket(true) }, ['analysis', '--exclude-model', ASTRA], FLASH, 2],
    [{ [SOL]: bucket(true), [ASTRA]: bucket(true) }, ['analysis', '--exclude-model', SOL], FLASH, 2],
    [active, ['analysis'], FLASH, 2],
    [active, ['analysis', '--exclude-model', FLASH], SOL, 3],
    // Light background work starts on the light list even when its bucket is known/bucketed or quota is unknown; it
    // does not detour to Sol first (the difficulty policy makes ordinary background analysis a light row).
    [{ ...active, [FLASH]: bucket() }, ['analysis'], FLASH, 3],
    [{ ...active, [FLASH]: { used: null, limit: null, remaining: null, depleted: false, resetsAt: null }, [PRO]: bucket() }, ['analysis'], FLASH, 3],
    [{ ...active, [FLASH]: bucket(), [PRO]: bucket() }, ['analysis'], FLASH, 3],
    [active, ['analysis', '--exclude-model', 'deepseek'], SOL, 3],
    [active, ['review-high'], SOL, 3],
    [active, ['review', '--impact', 'release'], SOL, 3],
    [active, ['second-opinion', '--against', 'claude', '--stakes', 'high'], ASTRA, 3],
    [null, ['analysis'], FLASH, 3],
    [{}, ['analysis'], FLASH, 3],
    [undefined, ['analysis'], FLASH, 3],
    [{ [SOL]: bucket(true), [ASTRA]: bucket(true) }, ['analysis', '--security'], FLASH, 2],
    [{ ...active, [FLASH]: bucket(), [PRO]: bucket() }, ['analysis', '--security'], FLASH, 3],
    [null, ['analysis', '--security'], FLASH, 3],
    [{ ...active, [SOL]: bucket(true) }, ['image-read'], ASTRA, 3],
    [{ ...active, [ASTRA]: bucket(true) }, ['image-read'], SOL, 3],
    [active, ['image-read'], SOL, 3],
    [{ ...active, [SOL]: bucket(true) }, ['image-read', '--security'], SEED, 2],
    [{ ...active, [SEED]: bucket() }, ['image-read'], SOL, 3],
    [{ ...active, [SEED]: bucket() }, ['image-read', '--security'], SEED, 3],
    [null, ['image-read'], SOL, 3],
    [null, ['image-read', '--security'], SEED, 3],
    [active, ['image-read', '--exclude-model', SEED], SOL, 3],
    [{ ...active, [SOL]: expired(true) }, ['analysis'], FLASH, 2],
    [{ [SOL]: expired(true), [ASTRA]: expired(true) }, ['analysis'], FLASH, 3],
    [{ ...active, [FLASH]: expired(), [PRO]: bucket() }, ['analysis'], FLASH, 3],
  ];
  try {
    for (const [daily, args, model, step, models = ids] of cases) {
      scenario(daily, models, args[0]==='image-read'?{load:{[SOL]:{percent:35,t:now}}}:{});
      const o = r(args);
      if(['review-high'].includes(args[0])||args.includes('release')) {assert.ok(o.pick);assert.equal(o.kind,'launch');assert.ok(o.plan.gates.some(g=>g.phase==='acceptance'),JSON.stringify({args,category:o.category,cls:o.plan.task.reviewClass,impact:o.plan.task.impact,gates:o.plan.gates}));continue;}
      assert.equal(o.pick?.model, model, `${args.join(' ')} step ${step}`);
      assert.equal(o.pick?.account, 'trae'); assert.equal(o.pick?.launcher, 'codex-worker');
      assert.ok(o.why.some((n) => n.startsWith('background:') && n.includes(`(step ${step})`)), JSON.stringify(o.why));
      if (step === 3&&o.plan.primary.estimate.noPrioritySpend!==true) assert.ok(o.why.some((n) => /normal TRAE pick.*spend[s]? high-priority quota/.test(n)));
      if (args[0] === 'image-read') assert.ok([SOL, ASTRA, SEED].includes(o.pick?.model));
      if (args.includes('--security')) assert.ok(!o.pick?.model.startsWith('gpt-'));
      assert.ok(!o.needsUserOK.some((n) => /personal quota/.test(n)));
    }
    scenario(active);
    // Security reviews are adversarial: the company non-GPT model runs even in the background lane.
    for (const args of [['review-high', '--security'], ['review', '--security']]) {
      const o = r(args);assert.equal(o.kind,'launch');assert.equal(o.pick.account,'trae');assert.ok(o.plan.gates.some(g=>g.phase==='acceptance'));
    }
    for (const args of [['image-read', '--security', '--exclude-model', SEED], ['analysis', '--security', '--exclude-model', FLASH]]) {
      const o=r(args);assert.equal(o.kind,'blocked');assert.equal(o.pick.command,null);assert.ok(o.plan.gates.some(g=>g.kind==='personal-quota'));assert.ok(o.tellUser.some((n)=>/No runnable authorized background lane|personal quota/.test(n)));
    }
    // Unknown quota retains the ordinary rung; an Astra rung keeps its tier even if Sol is depleted.
    const args = ['implement', '--failures', '5'];
    scenario(null);assert.ok(r(args).pick);assert.ok(!r(args).plan.reasons?.some(p=>p.code==='PREVIOUS_ATTEMPT_UNKNOWN'));
    scenario({ ...active, [SOL]: bucket(true) });assert.ok(r(args).pick);assert.ok(!r(args).plan.reasons?.some(p=>p.code==='PREVIOUS_ATTEMPT_UNKNOWN'));
    // Fallback service code still requires review; sensitive acceptance keeps the stronger family.
    scenario(active);
    assert.ok(r(['implement']).allNotes.some((n) => /no review/.test(n)));
    const reviewed = r(['review', '--author', 'codex', '--impact', 'release']);
    assert.ok(!reviewed.pick?.model.startsWith('deepseek'));
    assert.ok(!reviewed.secondOpinion?.model.startsWith('deepseek'));
    // Model pauses and explicit exclusions apply before quota preference.
    const pausedHome = fs.mkdtempSync(path.join(tmp, 'background-order-paused-'));
    const { noteFailure } = await import('../lib/trae-health.mjs');
    noteFailure(pausedHome, '-32600: model `gpt-6.1-sol` is unavailable because its metadata could not be resolved', now, SOL);
    scenario({ [SOL]: bucket(true), [ASTRA]: bucket(true) }, ids, { home: pausedHome });
    assert.equal(r().pick?.model, FLASH);
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
  const r = (args, { daily = active, models = ids, company = true, queue = 0, extra = {}, env = {} } = {}) => {
    const trae = tr({ home, models, modelIds: Object.fromEntries(ids.map((id) => [id, id.toUpperCase()])),
      quota: daily === null ? null : { daily },load:Object.fromEntries(ids.map(id=>[id,{percent:35,t:now}])), ...extra });
    fs.writeFileSync(path.join(trae.home, 'queue-state.json'), JSON.stringify({
      gpt: { t: now, position: queue, state: queue>0?'queued':'ready' }, deepseek: { t: now, position: queue, state: queue>0?'queued':'ready' },
    }));
    S.bucketFreeGPT = { claude: cl(10, 120), codex: [acc('main', 20, 120), ...(company ? [tt({ models: [SOL] })] : []), trae] };
    return parseRouteJSON(run('bucketFreeGPT', args, env));
  };
  try {
    for (const cat of ['lookup', 'extract', 'draft']) {
      const balanced = r([cat]), direct = r([cat], { company: false });
      for (const o of [balanced, direct]) {
        assert.equal(o.pick?.model, TERRA56); assert.equal(o.pick?.account, 'trae');
        assert.equal(o.pick?.effort, 'medium'); assert.equal(o.pick?.launcher, 'traecli-exec');
        assert.ok(o.pick?.command.includes('-m GPT-5.6-TERRA'));
        assert.ok(o.why.some((n) => /no daily bucket.*no high-priority quota spent.*no low-priority lane/.test(n)));
        assert.deepEqual(o.needsUserOK, []);
      }
      assert.equal(balanced.balance.bucketFree, true); assert.equal(balanced.balance.remainingShare, null);
      assert.equal(r([cat], { daily: { ...active, [SOL]: bucket(true) } }).pick?.model, TERRA56);
      assert.equal(r([cat], { queue: 301 }).pick?.account, 'ttadk');
      assert.equal(r([cat, '--exclude-account', 'trae']).pick?.account, 'ttadk');
      assert.equal(r([cat, '--security']).pick?.model, FLASH); // Security blocks GPT, not safe fallback balancing.
      assert.equal(r([cat, '--exclude-model', TERRA56]).pick?.model, GPT55);
      assert.equal(r([cat], { daily: { ...active, [TERRA56]: bucket() } }).pick?.model, TERRA56); // First light-tier candidate passes reserve.
    }
    for (const args of [['analysis'], ['implement'], ['docs'], ['research']]) {
      const o = r([...args, '--background'], { queue: 4000, extra: { load: { [GPT55]: { t: now, percent: 99 } } } });
      assert.equal(o.pick?.account,args[0]==='research'?'trae':'ttadk'); assert.equal(o.pick?.model,args[0]==='research'?TERRA56:SOL); assert.equal(o.pick?.launcher, 'codex-worker');
      assert.ok(o.pick?.command.includes(args[0]==='research'?'--model GPT-5.6-TERRA':'--model gpt-6.1-sol'));
      assert.ok(!o.why.some(n=>/TRAE lane free/.test(n)),'unknown model load is a bounded fallback, not observed free capacity');
      assert.ok(!o.needsUserOK.some((n) => /personal quota/.test(n)));
    }
    assert.equal(r(['design','--background']).pick.model,ASTRA); assert.equal(r(['review-high','--background']).pick.account,'trae');
    assert.equal(r(['analysis', '--background'], { daily: { ...active, [SOL]: bucket(true), [ASTRA]: bucket(true) } }).pick?.model, TERRA56);
    const cheap = r(['analysis', '--background', '--exclude-model', TERRA56]);
    assert.equal(cheap.pick?.model, GPT55); assert.ok(cheap.pick?.command.includes('--model GPT-5.5'));
    assert.equal(r(['analysis', '--background', '--exclude-model', `${GPT55},${TERRA56}`]).pick?.model, FLASH);
    assert.equal(r(['analysis', '--background'], { daily: { ...active, [GPT55]: bucket(), [TERRA56]: bucket() } }).pick?.model, TERRA56);
    assert.equal(r(['analysis', '--background'], { daily: { ...active, [GPT55]: { ...bucket(), resetsAt: now - 1 } } }).pick?.model, TERRA56);
    assert.equal(r(['analysis', '--background'], { models: [GPT55], company: false }).pick?.model, GPT55);
    assert.equal(r(['lookup'], { models: [GPT55], company: false }).pick?.account, 'trae');
    assert.equal(r(['analysis', '--background', '--security']).pick?.model, FLASH);
    assert.equal(r(['analysis', '--background', '--exclude-model', 'gpt']).pick?.model, FLASH);
    for (const args of [['review', '--security'], ['review-high', '--security']]) {
      const o = r([...args, '--background'], { company: false });
      // Adversarial reviews stay on the company non-GPT model; the missing second family is surfaced as a question.
      assert.equal(o.kind,'launch');assert.equal(o.pick.account,'trae');assert.ok(o.plan.gates.some(g=>g.phase==='acceptance'));
    }
    for (const daily of [null, {}, { [SOL]: null }, { [SOL]: { ...bucket(), resetsAt: now - 1 } }]) {
      // Light background work starts on the light list even when quota is unknown: no evidence to prefer Sol's bucket.
      assert.equal(r(['analysis','--background'],{daily}).pick?.model,SOL,'unknown TRAE capacity does not displace ready TTADK');
      assert.equal(r(['lookup'], { daily }).pick?.account, 'ttadk');
      assert.equal(r(['lookup'], { daily, company: false }).pick?.model, TERRA56);
    }
    // Non-cheap foreground work and vision/capability routes are unchanged.
    assert.equal(r(['analysis', '--stakes', 'low']).pick?.model, TERRA56);
    assert.equal(r(['analysis'], { company: false }).pick?.model, SOL);
    assert.equal(r(['image-read', '--background']).pick?.model, SOL);
    assert.equal(r(['image-read', '--background'], { daily: { ...active, [SOL]: bucket(true) } }).pick?.model, SOL);
    assert.equal(r(['image-read'],{company:false,daily:{...active,[SOL]:bucket(true)}}).pick?.model,ASTRA); // Sol lacks a direct free-lane signal here; ready Astra is the first free company vision lane.
    for (const args of [['build-run', '--background'], ['browser', '--background'], ['lookup', '--shared-lock'], ['lookup', '--background', '--device-lease']])
      if(args.includes('--device-lease')) assert.equal(r(args).blocked,true); else assert.equal(r(args).pick?.account,args[0]==='build-run'||args.includes('--shared-lock')?'trae':'ttadk',args.join(' '));
    // Astra escalation and the review count/account survive the new preferences. A light row first walks its light
    // list (Terra, 5.5, DeepSeek), then Sol's effort notches, and only then Astra — never sideways to a light model.
    assert.ok(r(['implement','--background','--failures','4'],{company:false}).pick?.company);
    assert.ok(r(['implement','--background','--failures','5'],{company:false}).pick?.company);
    const baselineReview = r(['review', '--author', 'codex'], { models: ids.filter((id) => ![GPT55, TERRA56].includes(id)) });
    const review = r(['review', '--author', 'codex']);
    const tuple=p=>p?[p.vendor,p.model,p.effort,p.account,p.sandbox]:null;
    assert.deepEqual(tuple(review.pick),tuple(baselineReview.pick)); assert.deepEqual(tuple(review.secondOpinion),tuple(baselineReview.secondOpinion));
    const pausedHome = fs.mkdtempSync(path.join(tmp, 'bucket-free-paused-'));
    const { noteFailure } = await import('../lib/trae-health.mjs');
    noteFailure(pausedHome, '-32600: model `gpt-5.6-terra` is unavailable because its metadata could not be resolved', now, TERRA56);
    assert.equal(r(['analysis', '--background'], { extra: { home: pausedHome } }).pick?.model, GPT55);
    assert.equal(r(['lookup'], { extra: { home: pausedHome } }).pick?.model, GPT55);
    noteFailure(pausedHome, 'Model access temporarily restricted. (983)', now, SOL);
    assert.equal(r(['analysis', '--background'], { extra: { home: pausedHome } }).pick?.model, FLASH);
    assert.equal(r(['lookup'], { extra: { home: pausedHome } }).pick?.model, FLASH);
    const log = path.join(home, 'routes.jsonl');
    r(['lookup', '--project', 'p', '--name', 'free-gpt'], { env: { ROUTE_LOG: '1', ROUTE_LOG_FILE: log } });
    const logged = parseRouteJSON(fs.readFileSync(log, 'utf8').trim());
    assert.equal(logged.company, 'trae'); assert.equal(logged.pick?.model, TERRA56); assert.equal(logged.balance.bucketFree, true);
    console.log('ok   bucket-free TRAE GPT: cheap/background preference, quota, mapping, security, vision, balancing, tiers and pauses');
  } catch (e) { fail++; console.log(`FAIL bucket-free TRAE GPT: ${e.stack}`); }
}
// Fix-round regressions: approval follows actual accounts, and company GPT floors/telemetry survive Sol loss.
{
  const SOL = 'gpt-6.1-sol', ASTRA = 'gpt-6-astra', SOL56 = 'gpt-5.6-sol', GPT55 = 'gpt-5.5', TERRA56 = 'gpt-5.6-terra';
  const home = fs.mkdtempSync(path.join(tmp, 'actual-personal-quota-'));
  const bucket = (depleted = false) => ({ used: depleted ? 80 : 20, limit: 80, remaining: depleted ? 0 : 60, depleted, resetsAt: now + 72 * h });
  const active = { [SOL]: bucket(), [ASTRA]: bucket(), [SOL56]: bucket() };
  const r = (args, { models = [GPT55], daily = active, sampledAt = now, company = false } = {}) => {
    S.actualPersonalQuota = { claude: cl(10, 120), codex: [acc('main', 20, 120), ...(company ? [tt()] : []),
      tr({ home, models, quota: { daily, sampledAt } })] };
    return parseRouteJSON(run('actualPersonalQuota', args));
  };
  const gated = (o) => o.needsUserOK.some((n) => n.startsWith('personal quota:'));
  try {
    // V10/V11: every retry is tied to a real preceding tuple; count-only retries are blocked.
    const next = r(['lookup','--failures','1','--actual',`codex:${GPT55}:medium@trae`]);
    assert.equal(next.pick.model,SOL); assert.equal(next.pick.effort,'medium'); assert.ok(gated(next)); // Retry promotes the light task to normal; GPT-5.5 is below that tier.
    for(const model of [GPT55,TERRA56,SOL,ASTRA,SOL56]) {
      const missing=r(['lookup','--failures','3'],{models:[model]});
      assert.ok(missing.pick);assert.ok(!missing.plan.reasons?.some(r=>r.code==='PREVIOUS_ATTEMPT_UNKNOWN'));assert.ok(missing.why.some(w=>/assumed first/.test(w)));
    }
    for(const urgent of [[],['--urgent']]) {
      const proposal=r(['science','--failures','2','--actual',`codex:${SOL}:max@trae`,...urgent],{models:[SOL]});
      assert.equal(proposal.pick.model,ASTRA); assert.equal(proposal.pick.account,'main'); assert.ok(gated(proposal));
      assert.equal(proposal.pick.command,null);
    }
    for(const flags of [['--exclude-model','gpt'],['--exclude-account','trae'],['--security']])
      assert.ok(gated(r(['lookup',...flags])));
    const depleted=Object.fromEntries([SOL,ASTRA,SOL56,GPT55,TERRA56].map(id=>[id,bucket(true)]));
    const allGPTs=[SOL,ASTRA,SOL56,GPT55,TERRA56];
    assert.ok(!gated(r(['lookup'],{models:[SOL],daily:depleted})));
    for(const args of [['image-gen'],['claude-tools'],['second-opinion','--against','codex'],['review-high','--author','codex']])
      assert.equal(gated(r(args,{models:[SOL]})),!['image-gen','claude-tools'].includes(args[0]),`personal consent/standing exception: ${args[0]}`);
    assert.equal(r(['computer-use']).blocked,true);
    const design=r(['design'],{models:[SOL]});
    assert.equal(design.pick.account,'trae'); assert.equal(design.secondOpinion,null); assert.ok(!gated(design));
    for(const urgent of [[],['--urgent']]) {
      const fallback=r(['design',...urgent],{models:['deepseek-v4.1-flash']});
      assert.equal(fallback.pick.vendor,'claude'); assert.ok(gated(fallback));
    }
    for(const options of [{},{models:[SOL],daily:depleted},{models:allGPTs,daily:depleted}]) {
      const blocked=r(['lookup','--background','--failures','20','--urgent'],options);
      assert.ok(!blocked.plan.reasons?.some(p=>p.code==='PREVIOUS_ATTEMPT_UNKNOWN'));if(blocked.kind==='launch') assert.ok(blocked.pick.company);else assert.ok(blocked.blocked);if(blocked.kind==='launch')assert.ok(!gated(blocked));else assert.ok(blocked.plan.gates.length>0,'background capacity needs a decision');
    }
    // Losing Sol must not lower the floor for judgment rows, alternate-Sol tiers, high stakes or authorship.
    for (const args of [['analysis'], ['docs'], ['research'], ['design'], ['review', '--author', 'codex'],
      ['analysis', '--stakes', 'high'], ['lookup', '--stakes', 'high'], ['implement-hard', '--impact', 'throwaway']]) {
      const hard = ['design', 'implement-hard'].includes(args[0]) || args.includes('high');
      const candidate = hard ? ASTRA : GPT55;
      const withSol = r([...args, '--background'], { models: [SOL, candidate] });
      const withoutSol = r([...args, '--background'], { models: [candidate] });
      if(args.includes('--author')) {assert.equal(withoutSol.kind,'blocked');assert.equal(withoutSol.pick.command,null);assert.ok(gated(withoutSol));continue;}
      assert.equal(withoutSol.pick?.model, candidate); assert.equal(withoutSol.pick?.effort, withSol.pick?.effort, args.join(' '));
      if (hard) {const fallback=r([...args,'--background']);assert.equal(fallback.kind,'blocked');assert.ok(!fallback.pick?.company,'hard work cannot use GPT-5.5');assert.ok(gated(fallback),'personal hard option remains gated');}
    }
    // A future reset cannot make an old or missing reading current; state-cache checkedAt is not the quota sample.
    // With no current bucket reading, a light row starts on the light list (no evidence to prefer Sol's bucket).
    const models = [SOL, ASTRA, SOL56, GPT55, TERRA56];
    for (const sampledAt of [null, now - 31 * 60000, now - 48 * h, now + h]) {
      assert.equal(r(['analysis', '--background'], { models, sampledAt }).pick?.model, TERRA56);
      assert.equal(r(['lookup'], { models, sampledAt }).pick?.model, TERRA56);
      assert.equal(r(['lookup'], { models, sampledAt, company: true }).pick?.account, 'ttadk');
      assert.equal(r(['analysis'], { models, sampledAt, daily: { ...active, [SOL]: bucket(true) } }).pick?.model, SOL);
    }
    assert.equal(r(['analysis', '--background'], { models, sampledAt: now - 29 * 60000 }).pick?.model, TERRA56);
    const deterministic=r(['analysis'],{models,sampledAt:now-29*60000,daily:{...active,[SOL]:bucket(true)}});
    assert.equal(deterministic.pick.model,SOL); assert.ok(deterministic.why.length>0);
    console.log('ok   actual personal approval, one-model/excluded/depleted neighbours, background isolation, company effort floors and quota reading age');
  } catch (e) { fail++; console.log(`FAIL fix-round routing regressions: ${e.stack}`); }
}
// Adversarial security review (user decision 2026-11-13, option A): no GPT on any account. Exact order: TTADK
// Kimi-K3 high -> DeepSeek-V4.1-Flash high on TTADK or TRAE -> Claude Opus behind the personal-quota gate; a second
// reviewer always comes from the other non-GPT family, and one-family-only asks the user (Claude second or one reviewer).
{
  const KIMI = 'kimi-k3', FLASH = 'deepseek-v4.1-flash';
  const out = { healthy: false, reason: 'its daily token quota is used up', quotaOut: { kind: 'daily', resetsAt: now + 10 * h } };
  const kimiTt = (extra = {}) => tt({ models: ['gpt-6.1-sol', KIMI, FLASH], ...extra });
  const dsTrae = (extra = {}) => tr({ models: ['gpt-6.1-sol', FLASH], modelIds: { 'gpt-6.1-sol': 'GPT-6.1-Sol', [FLASH]: 'DEEPSEEK-V4.1-FLASH' }, ...extra });
  S.advBoth = { claude: cl(10, 120), codex: [acc('main', 20, 120), kimiTt()] };
  S.advDsOnly = { claude: cl(10, 120), codex: [acc('main', 20, 120), tt({ models: ['gpt-6.1-sol', FLASH] })] };
  S.advTtadkOut = { claude: cl(10, 120), codex: [acc('main', 20, 120), kimiTt(out), dsTrae()] };
  S.advSearch = { claude: cl(10, 120), codex: [acc('main', 20, 120), kimiTt({ search: true, searchLive: true })] };
  S.advMatrix = { claude: cl(10, 120), codex: [acc('main', 20, 120), kimiTt({ search: true, searchLive: true })] };
  // Kimi is named for TTADK only: a TRAE-listed Kimi must not jump ahead of DeepSeek.
  S.advTraeKimi = { claude: cl(10, 120), codex: [acc('main', 20, 120), tt(out), tr({ models: ['gpt-6.1-sol', KIMI, FLASH], modelIds: {} })] };
  S.advNone = { claude: cl(10, 120), codex: [acc('main', 20, 120), tt(out), tr()] };
  const o = (sc, args, env) => parseRouteJSON(run(sc, args, env));
  const pick = (sc, args) => { const r = o(sc, args); return r.deferred ? 'DEFER' : `${r.pick.vendor} ${r.pick?.model} ${r.pick?.effort} @${r.pick?.account ?? '-'}`; };
  const second = (sc, args) => { const s = o(sc, args).secondOpinion; return s ? `${s.model} ${s.effort} @${s.account}` : null; };
  const gated = (sc, args) => o(sc, args).needsUserOK.some((n) => /^personal quota:/.test(n));
  const secondAsk = (sc, args) => o(sc, args).needsUserOK.some((n) => /^adversarial second reviewer:/.test(n));
  const cases = [
    // TTADK Kimi-K3 first, DeepSeek second from the other family.
    [pick('advBoth', ['review-high', '--security']), 'codex kimi-k3 high @ttadk'],
    [second('advBoth', ['review-high', '--security']), `${FLASH} high @ttadk`],
    [pick('advBoth', ['review', '--security']), 'codex kimi-k3 high @ttadk'],
    [pick('advBoth', ['second-opinion', '--against', 'codex', '--security']), 'codex kimi-k3 high @ttadk'],
    // One failure moves to DeepSeek, the other family (Kimi) becomes the second reviewer.
    [pick('advBoth', ['review-high', '--security', '--failures', '1']), 'codex kimi-k3 xhigh @ttadk'],
    [second('advBoth', ['review-high', '--security', '--failures', '1']), `${FLASH} high @ttadk`],
    // The next failure falls to Claude Opus, never a GPT model, and asks for personal quota.
    [pick('advBoth', ['review-high', '--security', '--failures', '2']), 'codex kimi-k3 xhigh @ttadk'],
    [gated('advBoth', ['review-high', '--security', '--failures', '2']), false],
    // DeepSeek alone: it runs, the missing other family is surfaced as a question.
    [pick('advDsOnly', ['review-high', '--security']), `codex ${FLASH} high @ttadk`],
    [second('advDsOnly', ['review-high', '--security']), 'opus xhigh @undefined'],
    [gated('advDsOnly', ['review-high', '--security']), true],
    // TTADK out: DeepSeek on TRAE, still no GPT, still the single-family question.
    [pick('advTtadkOut', ['review-high', '--security']), `codex ${FLASH} high @trae`],
    [gated('advTtadkOut', ['review-high', '--security']), true],
    // Kimi on TRAE is not part of the approved order; DeepSeek takes it there.
    [pick('advTraeKimi', ['review-high', '--security']), `codex ${FLASH} high @trae`],
    // No company non-GPT model: Claude Opus, explicitly behind the personal-quota gate.
    [pick('advNone', ['review-high', '--security']), 'claude opus xhigh @-'],
    [gated('advNone', ['review-high', '--security']), true],
    // Other --security work keeps today's rule; --adversarial work is non-GPT too.
    [pick('advBoth', ['implement', '--impact', 'service', '--security']), 'codex gpt-6.1-sol high @ttadk'],
    [pick('advBoth', ['implement', '--impact', 'service', '--adversarial']), 'codex kimi-k3 high @ttadk'],
    [second('advBoth', ['implement', '--impact', 'service', '--adversarial']), null],
    // Company adversarial picks must fit the task. Neither approved company family generates or reads images, and a
    // TTADK account without its search proxy cannot research, so those use the Claude-only adversarial fallback.
    [pick('advBoth', ['image-gen', '--adversarial']), 'DEFER'],
    [pick('advBoth', ['image-read', '--adversarial']), 'claude opus high @-'],
    [pick('advBoth', ['research', '--adversarial']), 'claude opus high @-'],
    [pick('advBoth', ['claude-tools', '--adversarial']), 'claude opus high @-'],
    [gated('advBoth', ['image-read', '--adversarial']), true],
    // The same research task remains on company quota when the selected account really has search capability.
    [pick('advSearch', ['research', '--adversarial']), 'codex kimi-k3 high @ttadk'],
    [pick('advTtadkOut', ['research', '--adversarial']), `codex ${FLASH} high @trae`],
    // Background can use the company non-GPT lane; it never falls through to Claude.
    [pick('advBoth', ['review', '--security', '--background']), 'codex kimi-k3 high @ttadk'],
    [pick('advNone', ['review', '--security', '--background']), 'claude opus xhigh @-'],
    // Exact Astra reproductions: Kimi remains eligible in the background lane, while build-run retry excludes DeepSeek.
    [pick('advBoth', ['review', '--background', '--adversarial', '--author', 'codex', '--exclude-model', 'deepseek', '--impact', 'service']), 'codex kimi-k3 high @ttadk'],
    [pick('advBoth', ['build-run', '--adversarial', '--impact', 'release', '--failures', '1']), 'codex kimi-k3 xhigh @ttadk'],
    [gated('advBoth', ['build-run', '--adversarial', '--impact', 'release', '--failures', '1']), false],
  ];
  // Never a GPT pick or second reviewer anywhere in the adversarial lane.
  for (const sc of ['advBoth', 'advDsOnly', 'advTtadkOut', 'advTraeKimi', 'advNone']) {
    for (const args of [['review', '--security'], ['review-high', '--security'], ['second-opinion', '--against', 'codex', '--security'],
      ['review', '--adversarial'], ['image-gen', '--adversarial'], ['image-read', '--adversarial'], ['research', '--adversarial']]) {
      const r = o(sc, args);
      for (const p of [r.pick, r.secondOpinion].filter(Boolean)) cases.push([p.model.startsWith('gpt-'), false]);
    }
  }
  const bad = cases.map(([got, want], i) => (got === want ? null : `${i} (${JSON.stringify(got)} != ${JSON.stringify(want)})`)).filter((i) => i !== null);
  if (bad.length) fail++;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} adversarial review   ${cases.length} cases${bad.length ? ` — failing #${bad.join(', #')}` : ''}`);
  try {
    // Every route category under both policy flags and both dispatch modes. This stays synthetic and bounded:
    // 21 categories x 2 flags x 2 foreground/background modes = 84 decisions.
    const categories = ['lookup', 'extract', 'analysis', 'research', 'implement', 'implement-hard', 'ui-browser', 'debug',
      'review', 'review-high', 'design', 'docs', 'draft', 'build-run', 'browser', 'computer-use', 'claude-tools',
      'science', 'image-gen', 'image-read', 'second-opinion'];
    const tableCategories = execFileSync(process.execPath, [ROUTE, '--table'], { encoding: 'utf8' })
      .split('\n').filter((line) => /^\S/.test(line)).map((line) => line.trim().split(/\s+/)[0]);
    assert.deepEqual(categories, tableCategories, 'matrix category list must match route --table');
    const reviewCategories = new Set(['review', 'review-high', 'second-opinion']);
    const noCompanyAdversarial = new Set(['image-gen', 'image-read', 'claude-tools','browser','ui-browser','computer-use','implement-hard','debug','science','design']);
    const noCompanySecurity = new Set(['image-gen', 'claude-tools','computer-use']);
    let decisions = 0, companyExpected = 0;
    for (const category of categories) {
      for (const policyFlag of ['--adversarial', '--security']) {
        for (const dispatchFlags of [[], ['--background']]) {
          const args = [category, policyFlag, ...dispatchFlags];
          if (CODE.includes(category)) args.push('--impact', 'service');
          if (category === 'build-run') args.push('--impact', 'release');
          if (category === 'second-opinion') args.push('--against', 'codex');
          const routed = o('advMatrix', args);
          const isAdversarial = policyFlag === '--adversarial' || reviewCategories.has(category);
          if (isAdversarial && routed.pick) assert.ok(!routed.pick?.model.startsWith('gpt-'), `${args.join(' ')} picked GPT`);
          if (category === 'build-run' && routed.pick) assert.ok(!routed.pick?.model.startsWith('deepseek'), `${args.join(' ')} picked DeepSeek`);
          const companyEligible = isAdversarial ? !noCompanyAdversarial.has(category) : !noCompanySecurity.has(category);
          if (companyEligible) {
            companyExpected++;
            assert.ok(routed.pick && ['ttadk', 'trae'].includes(routed.pick?.account), `${args.join(' ')} missed eligible company model`);
          }
          decisions++;
        }
      }
    }
    assert.equal(decisions, categories.length * 4);
    const pinnedRetry = o('advMatrix', ['lookup', '--failures', '1']);
    assert.equal(Object.hasOwn(pinnedRetry.pick??{}, 'pinned'), false, 'internal balance pin leaked into public JSON pick');
    console.log(`ok   category policy matrix: ${categories.length} categories x 2 policy flags x 2 dispatch modes = ${decisions}; ${companyExpected} eligible-company assertions; no public pin metadata`);
  } catch (e) { fail++; console.log(`FAIL category policy matrix: ${e.stack}`); }
  // The route log carries the adversarial flag for the nightly review.
  try {
    const log = path.join(tmp, 'adv-route-log.jsonl');
    o('advBoth', ['review-high', '--security', '--project', 'p', '--name', 'adv-1'], { ROUTE_LOG: '1', ROUTE_LOG_FILE: log });
    const rec = parseRouteJSON(fs.readFileSync(log, 'utf8').trim());
    const ok = rec.adversarial === true && rec.security === true && rec.pick?.model === KIMI && rec.second.model === FLASH;
    if (!ok) fail++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} adversarial route log records flag, Kimi pick and DeepSeek second`);
  } catch (e) { fail++; console.log(`FAIL adversarial route log: ${e.message}`); }
}
// Defensive security confirmation (user ruling 2026-11-13): --defensive is valid only with --security on
// review/review-high/second-opinion. It keeps ordinary security routing (TRAE GPT excluded, TTADK GPT allowed)
// instead of the adversarial lane; without it, --security reviews stay adversarial. Invalid contexts are usage errors.
{
  const o = (sc, args, overrides) => parseRouteJSON(run(sc, args, overrides));
  const pick = (sc, args) => { const r = o(sc, args); return r.deferred ? 'DEFER' : `${r.pick.vendor} ${r.pick?.model} ${r.pick?.effort} @${r.pick?.account ?? '-'}`; };
  try {
    const tt = o('ttFresh', ['review-high', '--security', '--defensive']);
    assert.equal(pick('ttFresh', ['review-high', '--security', '--defensive']), 'codex gpt-6.1-sol xhigh @ttadk');
    assert.equal(tt.security, true); assert.equal(tt.defensive, true); assert.equal(tt.adversarial, false);
    assert.ok(!tt.allNotes.some((n) => /adversarial second reviewer/.test(n)));
    assert.ok(tt.allNotes.some((n) => /defensive confirmation \(--defensive\).*only the rule to hold and its acceptance conditions.*no bypass description/.test(n)));
    assert.ok(tt.allNotes.some((n) => /cyber-policy block.*do not retry that thread.*do not resend it to any GPT account.*--adversarial.*Kimi-K3 plus a DeepSeek-V4\.1-Flash second reviewer/.test(n)));
    assert.ok(tt.allNotes.some((n) => /whichever side reproduces it with an executable test/.test(n)));
    assert.ok(tt.why.join(' ').includes('defensive confirmation'));
    // Without --defensive the same row stays adversarial by default: no GPT, Claude behind the personal-quota gate.
    const defaultAdversarial = o('ttFresh', ['review-high', '--security']);
    assert.equal(defaultAdversarial.adversarial, true);
    assert.equal(pick('ttFresh', ['review-high', '--security']), 'claude opus xhigh @-');
    assert.ok(defaultAdversarial.needsUserOK.some((n) => /^personal quota:/.test(n)));
    // Defensive hard reviews still exclude TRAE GPT: with TTADK out, no eligible hard company model remains.
    const trae = o('ttOutTrae', ['review-high', '--security', '--defensive']);
    assert.equal(trae.adversarial, false); assert.equal(trae.tier, 'hard');
    assert.equal(pick('ttOutTrae', ['review-high', '--security', '--defensive']), 'claude opus xhigh @-');
    assert.ok(trae.needsUserOK.some((n) => /^personal quota:/.test(n)));
    // Normal defensive reviews may still use the eligible non-GPT TRAE fallback, never its excluded GPT family.
    assert.equal(pick('ttOutTrae', ['review', '--security', '--defensive']), 'codex gpt-6.1-sol high @main');
    // review and second-opinion keep TTADK GPT on the ordinary security route.
    assert.equal(pick('ttFresh', ['review', '--security', '--defensive']), 'codex gpt-6.1-sol high @ttadk');
    assert.equal(pick('ttFresh', ['second-opinion', '--against', 'claude', '--security', '--defensive']), 'codex gpt-6.1-sol high @ttadk');
    // Other --security work is unchanged, and --adversarial work is untouched.
    assert.equal(pick('ttFresh', ['implement', '--impact', 'service', '--security']), 'codex gpt-6.1-sol high @ttadk');
    assert.equal(o('advBoth', ['review-high', '--security', '--defensive']).pick?.model, 'gpt-6.1-sol');
    console.log('ok   defensive security confirmation: non-adversarial routing, TRAE GPT excluded, notes and adversarial default preserved');
  } catch (e) { fail++; console.log(`FAIL defensive security confirmation: ${e.stack}`); }
  // The route log carries the flag for the nightly review.
  try {
    const log = path.join(tmp, 'def-route-log.jsonl');
    o('ttFresh', ['review-high', '--security', '--defensive', '--project', 'p', '--name', 'def-1'], { ROUTE_LOG: '1', ROUTE_LOG_FILE: log });
    const rec = parseRouteJSON(fs.readFileSync(log, 'utf8').trim());
    const ok = rec.defensive === true && rec.security === true && rec.adversarial === false && rec.pick?.model === 'gpt-6.1-sol';
    if (!ok) fail++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} defensive route log records the flag, TTADK GPT and no adversarial lane`);
  } catch (e) { fail++; console.log(`FAIL defensive route log: ${e.message}`); }
}
fs.rmSync(tmp, { recursive: true, force: true });
// Reports are opt-in so fixture runs do not overwrite another task's temporary report.
if(process.env.ROUTE_EXPECTATION_REPORT)fs.writeFileSync(process.env.ROUTE_EXPECTATION_REPORT,JSON.stringify(expectationChanges,null,2));
console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
