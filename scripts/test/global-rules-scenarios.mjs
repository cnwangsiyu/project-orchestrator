#!/usr/bin/env node
// User, 2026-11-13: explicit Claude Bypass/Remote Control and >=2-day SSO notice.
// Synthetic homes/settings/quota only; never launch a worker or read live credentials.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { routeFixture, parseRouteJSON } from './helpers/route-fixture.mjs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'global-rules-test-'));
fs.mkdirSync(path.join(tmp,'user-signing'),{recursive:true});
fs.writeFileSync(path.join(tmp,'user-signing/registry.json'),'{}');fs.writeFileSync(path.join(tmp,'user-signing/identities.json'),'{}');
fs.writeFileSync(path.join(tmp,'resources.tsv'),'iphone8\tphone\t1\tdevice\niphone11\tphone\t1\tdevice\ns21\tphone\t1\tdevice\n');
const originalHome = process.env.HOME;
process.env.HOME = tmp;
try {
  const { analyze, leanLines, POLICY, now } = await import('../lib/state.mjs');
  const { loadDigest } = await import('../lib/global-rules.mjs');
  const digest = loadDigest();
  const digestText = fs.readFileSync(path.join(path.dirname(root), 'references/global-rules.md'), 'utf8');
  assert.equal(digestText.match(/^version:/gm)?.length, 1, 'integration must publish one digest version');
  assert.equal(digestText.match(/^## Changes In This Version$/gm)?.length, 1);
  assert.ok(digestText.split('\n').length<=61,'digest line budget');
  assert.equal(digest.version, '2026-11-24.14');
  assert.match(digestText, /^- 2026-11-24\.\d+: /m);
  assert.match(digestText, /2026-11-24\.7: fail-closed masking scope/);
  assert.match(digestText, /^- 2026-11-24\.6:.*2026-11-24\.5:.*2026-11-24\.4:.*2026-11-24\.3: restored this history line.*2026-11-24\.2: device-app guard.*2026-11-18\.14:/m);
  assert.ok(digest.worker.includes('For printing only: never write the result back, never use perl -i/sed -i, and never redirect over the source'));
  assert.match(digest.worker, /Masking tools run only on task-dir logs; never inside a git work tree/);
  assert.match(digest.worker, /startup baseline.*size\/time-bounded untracked/);
  assert.ok(digest.worker.includes("ask `res place` (or use `claim-any`) instead of naming a machine; name a machine only with a stated reason"));
  assert.match(digest.worker, /process checks list PID and process name only.*pgrep -l.*ps -o pid,comm/);
  assert.match(digest.worker, /never print other tools' full command lines.*pgrep -a\/-f.*args\/command/);
  assert.match(digest.worker,/Declare host-bound inputs with --input/);
  assert.match(digest.worker,/never edit a slot worktree in place/);
  assert.match(digest.worker, /--exclude-host.*--exclude-slot.*--prefer-slot.*--exclude-reason.*in their report.*Declare host-bound inputs with --input/);
  assert.match(digest.worker, /Mid-turn talkback:.*ask --default.*never routine progress/);
  assert.match(digest.worker, /If `codex-worker` is not on PATH, use the launcher's absolute Node\/script command with its RULES_SHARED, account and thread/);
  assert.ok(digest.worker.includes('node <skill>/scripts/codex-worker.mjs --account <account> note --thread <thread> --kind risk "<file and issue, no value>"'));
  assert.match(digest.worker, /Save downloaded CI\/job\/build logs \(bytedcli, curl, etc\.\).*as `\.log`\/`\.txt`\/`\.out`; immediately after download and before any read/);
  assert.ok(digest.worker.includes('node <skill>/scripts/mask-logs.mjs --force <log-file>...'));
  assert.match(digest.worker, /proceed only after successful masking.*Read only named masked CI logs with credential-excluding greps/);
  assert.ok(digest.worker.includes('rg -vi "password|passwd|token|secret|apikey|api_key|credential|auth"'));
  assert.match(digest.worker, /Identity uses explicit flags, CODEX_WORKER_\*, runtime CODEX_THREAD_ID\/TRAECLI_THREAD_ID or exactly one running public context matching cwd; ambiguity exits 2/);
  assert.match(digest.worker, /bare note\/ask use runtime CODEX_THREAD_ID or TRAECLI_THREAD_ID/);
  assert.doesNotMatch(digest.worker, /newest running public context|discover the newest running/);
  assert.equal(digestText.match(/^- Day 3 /gm)?.length,1);
  assert.match(digestText,/quality first across company accounts/);
  assert.match(digestText,/without a fixed working-worker wall timeout/);
  assert.match(digest.worker, /take-build\/wait-build inside ONE long-lived wrapper.*local heavy compute/);
  assert.match(digest.worker, /elapsed and predicted-start deadlines.*exclude only the slow account\/model lane/);
  const loginAt = digest.worker.indexOf('Forbidden for every worker: never read, copy, load or inject LOGIN material');
  const signingAt = digest.worker.indexOf("Allowed with the user's 2026-11-13 authorization: sign OUR OWN TEST packages");
  assert.ok(loginAt >= 0 && signingAt > loginAt, 'worker digest must contain adjacent login and test-signing rules');
  assert.match(digest.worker, /registered shared test phones iphone8\/iphone11\/s21.*freely tap Allow\/Authorize\/Trust\/OK/);
  assert.match(digest.worker, /Before stopping, uninstalling or installing on a shared device, run the device-app guard; a bundle id owned by another project is a stop, report to both orchestrators/);
  assert.match(digest.worker, /No unattended auto-take waiter while another project is queued or has been promised the shared device/);
  assert.match(digest.worker, /waiter starts only on an explicit "returned" or at an agreed time with `res` idle/);
  assert.match(digest.worker, /Cleanup reads back and reports every state it changes, writing UNVERIFIED when readback is unavailable/);
  assert.match(digest.worker, /personal iPhone 15 Pro Max \(`policy=never`\).*device not registered in `res`/);
  assert.match(digest.worker, /lease <=2 h.*never enter personal-account credentials\/passwords\/verification codes.*no purchases/);
  assert.match(digest.worker, /never make whole-container or device backups.*pymobiledevice3 apps pull.*devicectl device copy from.*idevicebackup2.*adb backup.*adb exec-out run-as.*use in-place installs/);
  assert.match(digest.worker, /Pulling named test outputs.*card plus an APK\/IPA-only backup.*test harness.*removed or disabled/);
  assert.match(digest.worker, /Codex refuses an allowed prompt.*routes that step to Claude.*do not ask the user to tap it/);
  const h = 3600000;
  const window = { label: 'week (all models)', used: 10, resetsAt: now + 120 * h, windowMins: 10080, scoped: false };
  const main = { name: 'main', home: tmp, live: true, seenAt: now, windows: [window], resets: { count: 0, credits: [] } };
  const ttadk = { name: 'ttadk', kind: 'ttadk', home: tmp, live: true, healthy: true, active: 0,
    models: ['gpt-6.1-sol'], windows: [], resets: null, ssoExpiresAt: now + 240 * h };
  const cache = path.join(tmp, 'quota.json'), settings = path.join(tmp, '.claude', 'settings.json');
  const env = { ...process.env,RULES_SHARED:tmp, CODEX_ACCOUNTS: path.join(tmp, 'profiles.json'), QUOTA_CACHE: cache,
    QUOTA_LOG: '0', ROUTE_LOG: '0', TRAE_PROBE: '0', ROUTE_RR: path.join(tmp, 'rotation'),
    ROUTE_NOW:String(now), ROUTE_LOG_FILE:path.join(tmp,'empty-routes'), QUOTA_LOG_FILE: path.join(tmp, 'empty-history') };
  fs.writeFileSync(env.CODEX_ACCOUNTS, JSON.stringify({ main: { home: tmp, hub: 'ws://127.0.0.1:1' } }));
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const data = (left = 240) => ({ checkedAt: now, claude: [window],
    codexAccounts: [main, { ...ttadk, ssoExpiresAt: now + left * h }], errors: {}, history: {} });
  const route = (args) => {
    fs.writeFileSync(cache, JSON.stringify(data()));
    return parseRouteJSON(routeFixture(path.join(root, 'route.mjs'), [...args,
      '--cwd', tmp, '--task-dir', tmp, '--name', 'fixture', '--dry', '--json'], { env, dir:tmp, approve:true }));
  };
  const claudeLaunch = (pick) => {
    assert.equal(pick.vendor, 'claude');
    assert.equal(pick.launcher, 'claude-bg');
    assert.match(pick.command, /claude --bg --remote-control --permission-mode bypassPermissions /);
    assert.ok(pick.command.includes(` --model ${pick.model} --effort ${pick.effort} `));
  };

  for (const config of [null, '{broken', {}, { permissions: { defaultMode: 'default' } },
    { permissions: { defaultMode: 'acceptEdits' } }, { defaultMode: 'plan' },
    { permissions: { defaultMode: 'bypassPermissions' } }]) {
    if (config === null) fs.rmSync(settings, { force: true });
    else fs.writeFileSync(settings, typeof config === 'string' ? config : JSON.stringify(config));
    for (const mode of [[], ['--mode', 'default'], ['--mode', 'acceptEdits'], ['--mode', 'bypassPermissions']]) {
      claudeLaunch(route(['claude-tools', ...mode]).pick);
      const design = route(['design', ...mode]);
      assert.equal(design.pick.vendor, 'codex');
      assert.equal(design.secondOpinion, null);
    }
  }
  console.log('ok   Claude primary/second-opinion launches use Remote Control and Bypass for every default/override');

  for (const [mode, sandbox] of [[[], 'danger-full-access'], [['--mode', 'default'], 'danger-full-access'],
    [['--mode', 'acceptEdits'], 'danger-full-access'], [['--mode', 'bypassPermissions'], 'danger-full-access']]) {
    assert.ok(route(['implement', '--impact', 'service', ...mode]).pick.command.includes(` --sandbox ${sandbox} `));
    assert.ok(route(['implement', '--impact', 'service', '--read-only', ...mode]).pick.command.includes(' --sandbox read-only '));
  }
  assert.equal(route(['review']).pick.sandbox, 'read-only');
  assert.equal(route(['review', '--runs-tests']).pick.sandbox, 'workspace-write');
  assert.equal(route(['implement', '--impact', 'service', '--sandbox', 'workspace-write']).pick.sandbox, 'workspace-write');
  assert.equal(route(['implement', '--impact', 'service', '--sandbox', 'read-only']).pick.sandbox, 'read-only');
  const signing = route(['review', '--signing', '--sandbox', 'read-only']);
  assert.equal(signing.blocked,true); assert.equal(signing.pick,null);
  assert.ok(signing.plan.reasons.some(r=>r.code==='SIGNING_FULL_ACCESS_REQUIRED'));
  console.log('ok   Codex writers default full; reviewers stay read-only; tests and explicit overrides stay narrower');

  const cliNote = 'signed-in CLIs need the full-access sandbox (keychain); stay read-only by instruction: queries only, no writes';
  const sandboxNote = 'read-only sandbox: keychain-backed CLIs (lark-cli, bytedcli) will not work; add --needs-cli if the task must use them';
  for (const extra of [[], ['--sandbox', 'read-only'], ['--sandbox', 'workspace-write'], ['--runs-tests']]) {
    const cli = route(['analysis', '--read-only', '--needs-cli', 'lark,bytedcli', ...extra]);
    assert.equal(cli.pick.sandbox, 'danger-full-access');
    assert.ok(cli.pick.command.includes(' --sandbox danger-full-access '));
    assert.deepEqual(cli.plan.task.needsCli, ['bytedcli', 'lark']);
    assert.equal(cli.plan.task.writes, false);
    assert.equal(cli.plan.task.readOnlyByInstruction, true);
    assert.equal(cli.notes.filter(note => note === cliNote).length, 1);
    assert.ok(!cli.notes.includes(sandboxNote));
  }
  const query = route(['analysis', '--read-only']);
  assert.equal(query.pick.sandbox, 'read-only');
  assert.equal(query.plan.task.readOnlyByInstruction, false);
  assert.deepEqual(query.plan.task.needsCli, []);
  assert.equal(query.notes.filter(note => note === sandboxNote).length, 1);
  console.log('ok   BC-72 CLI queries use full access with read-only intent; ordinary read-only routes explain keychain limits');

  for (const project of ['evelyns-world', 'acq', 'autotrader']) {
    const notes = route(['implement', '--project', project, '--impact', 'service']).allNotes.join('\n');
    assert.match(notes, /project profile no-review/);
    assert.doesNotMatch(notes, /landing gate:/, 'BC-45 omits absent landing gate');
    assert.match(notes, /keep --out separate from any file the worker is asked to write/);
    assert.match(notes, /codex-worker ask.*Answer promptly with codex-worker reply/);
  }
  assert.match(route(['implement', '--project', 'video-agent', '--impact', 'service']).allNotes.join('\n'), /landing gate: changed-package tests/);

  for(const args of [['implement','--impact','service'],['build-run'],['debug','--impact','service'],['ui-browser']]) {
    assert.match(route(args).allNotes.join('\n'),/dependencies and build tools.*without.*(?:card|ask|question)/i);
  }
  assert.match(digest.worker,/dependencies and build tools.*without a card or question/i);
  assert.match(digest.text,/Mandatory review is ONLY explicit/);
  const buildNote = route(['build-run']).allNotes.find((n) => n.startsWith('build brief:'));
  assert.match(buildNote, /ONE-process wrapper around res take-build\/wait-build\/return-build.*res v1\.5/);
  assert.match(buildNote, /holding neither resource while waiting for the other/);
  assert.match(buildNote, /only for genuine local heavy compute/);
  assert.match(buildNote, /long-lived watched wrapper/);
  for (const flags of [['--no-local-build']]) {
    const notes = route(['build-run', ...flags]).allNotes;
    assert.ok(!notes.some((n) => n.startsWith('build brief:')));
    assert.ok(notes.some((n) => /no heavy-build\/lane lock|no local heavy-build\/lane lock/.test(n)));
  }
  console.log('ok   integrated digest and route notes retain v1.5 pair acquisition, local-only locks and reroute rules');

  assert.match(digest.worker,/Allowed with the user's 2026-11-13 authorization: sign OUR OWN TEST packages/);
  assert.match(digest.text,/resident signing worker is retired/);
  assert.ok(route(['build-run','--env','test']).plan.gates.some(g=>g.kind==='local-resource-admission'));

  assert.equal(POLICY.ttadkSsoWarnH, 72);
  for (const [left, expected] of [[73, false], [72, true], [71, true], [55, true], [48, true], [24, true]]) {
    const d = data(left);
    assert.equal(leanLines(analyze(d), d).some((line) => line.startsWith('TTADK SSO expires in ')), expected,
      `SSO notice at ${left} hours`);
    fs.writeFileSync(cache, JSON.stringify(d));
    const shown = execFileSync(process.execPath, [path.join(root, 'quota.mjs')], { env, encoding: 'utf8' });
    assert.equal(shown.includes('lean: TTADK SSO expires in '), expected, `quota CLI notice at ${left} hours`);
  }
  const traeOnly={...data(),codexAccounts:[{...main,allowed:false,windows:[{...window,used:99}]},{name:'trae',kind:'trae',home:tmp,live:true,healthy:true,models:['gpt-6.1-sol'],quota:{sampledAt:now,daily:{}}}]};
  const lean=leanLines(analyze(traeOnly),traeOnly).join(' ');
  assert.match(lean,/this company device/);assert.match(lean,/qualified company work continues/);
  assert.doesNotMatch(lean,/add.*second.opinion|at stronger settings|codex out on every account|route as if Codex has room/);
  console.log('ok   SSO warning includes 72h boundary and reaches quota.mjs before the two-day deadline');
  console.log('\nall pass');
} finally {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(tmp, { recursive: true, force: true });
}
