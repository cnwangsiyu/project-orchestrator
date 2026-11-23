#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromeExtensionHostConnected, probeBrowserRuntime } from '../lib/browser-runtime.mjs';
import { acquireRoute } from '../lib/route-data.mjs';
import { parseTaskSpec, routePure, renderPlan, createSnapshot } from '../lib/pipeline/index.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-runtime-test-'));
const root = new URL('../../', import.meta.url).pathname;
const app = path.join(tmp, 'ChatGPT.app'), command = path.join(app, 'Contents/Resources/cua_node/bin/node_repl');
const now = Date.now(), week = { used: 10, windowMins: 10080, resetsAt: now + 7 * 86400000 };
fs.mkdirSync(path.dirname(command), { recursive: true });
fs.writeFileSync(command, 'fixture executable', { mode: 0o700 });
const profiles = Object.fromEntries(['ttadk', 'main'].map(name => {
  const home = path.join(tmp, name); fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.toml'), `[mcp_servers.node_repl]\ncommand = ${JSON.stringify(command)}\n`);
  return [name, { kind: name === 'ttadk' ? 'ttadk' : 'chatgpt', home, browser: true, models: ['gpt-6.1-sol'] }];
}));
const accounts = path.join(tmp, 'accounts.json'), cache = path.join(tmp, 'quota.json');
fs.writeFileSync(accounts, JSON.stringify(profiles));
fs.writeFileSync(cache, JSON.stringify({ checkedAt: now, claude: [week], codexAccounts: Object.entries(profiles).map(([name, p]) => ({
  ...p, name, healthy: true, live: true, seenAt: now, windows: name === 'main' ? [week] : [],
  usage: name === 'ttadk' ? { used: 1, limit: 500000000, resetsAt: now + 12 * 3600000 } : undefined,
})) }));
fs.writeFileSync(path.join(tmp, 'personal-fallback.json'), '{"enabled":false}');
const env = { RULES_SHARED: tmp, CODEX_ACCOUNTS: accounts, QUOTA_CACHE: cache, ROUTE_LOG_FILE: path.join(tmp, 'routes.jsonl') };
let probes = 0, connected = true, appVersion = '26.1115';
const readBrowserRuntime = (name, profile, options) => {
  probes++; return probeBrowserRuntime(name, profile, { ...options, app, appVersion, hostConnected: () => connected });
};
const acquire = (category = 'browser', extra = {}) => acquireRoute(parseTaskSpec([category,
  '--impact', 'throwaway', ...(category === 'computer-use' ? ['--apps', 'com.apple.calculator'] : [])],
  { taskId: 'runtime-fixture', requestId: 'runtime-fixture' }), { root, env, readBrowserRuntime,
  readAccount: () => { throw Error('unexpected account refresh'); }, readClaude: () => { throw Error('unexpected Claude refresh'); }, ...extra });
const route = context => { const plan = routePure(context.task, context.snapshot); return { plan, view: renderPlan(plan, context) }; };
try {
  const hostPath = '/Applications/ChatGPT.app/Contents/Resources/extension-host/macos/arm64/ChatGPT for Chrome';
  const processes = [
    { executable: '/bin/zsh', args: ['-c', `echo ${hostPath}`] },
    { executable: '/usr/bin/grep', args: ['ChatGPT for Chrome'] },
    { executable: '/Applications/Editor.app/Contents/MacOS/Editor', args: [hostPath] },
  ];
  const exec = (file, args, options) => {
    assert.equal(file, 'ps'); assert.deepEqual(args, ['-axo', 'comm='], 'never inspect process arguments');
    assert.ok(options.timeout < 1500);
    return processes.map(p => p.executable).join('\n') + '\n';
  };
  assert.equal(chromeExtensionHostConnected({ exec }), false, 'arguments mentioning the host do not connect it');
  processes.push({ executable: hostPath, args: [] });
  assert.equal(chromeExtensionHostConnected({ exec }), true, 'real native host executable connects it');
  processes.at(-1).executable = hostPath.replace('/arm64/', '/x64/');
  assert.equal(chromeExtensionHostConnected({ exec }), true, 'architecture is not hardcoded');
  for (const executable of ['/tmp/ChatGPT for Chrome', hostPath + ' helper', hostPath.replace('/macos/', '/linux/')]) {
    processes.at(-1).executable = executable;
    assert.equal(chromeExtensionHostConnected({ exec }), false, 'only the exact native host path matches');
  }
  processes.length = 0;
  assert.equal(chromeExtensionHostConnected({ exec }), false, 'no process is not connected');
  assert.equal(chromeExtensionHostConnected({ exec: () => { throw Error('process query unavailable'); } }), false);
  console.log('PASS Chrome native host: executable-only query, argument false positives, exact path, architectures, absent process and query failure');
  for (const category of ['browser', 'ui-browser', 'computer-use']) {
    const { plan, view } = route(acquire(category));
    assert.equal(plan.kind, 'launch', JSON.stringify(view.why));
    assert.equal(view.pick.account, 'ttadk');
    if (category === 'browser') assert.equal(view.pick.sandbox, 'read-only');
  }
  assert.equal(probes, 6, 'each route rechecks both accounts inside the cache TTL');
  const missingConfig = path.join(profiles.ttadk.home, 'config.toml');
  fs.writeFileSync(missingConfig, '[mcp_servers.node_repl]\ncommand = "/missing/bin/node_repl"\n');
  let result = route(acquire());
  assert.equal(result.view.pick.account, 'main'); assert.equal(result.plan.kind, 'blocked', 'personal quota still asks');
  assert.match(JSON.stringify(result.plan.rejected), /ttadk browser runtime command missing or not executable/);
  assert.match(result.view.why.join(' '), /ttadk browser runtime/);
  fs.writeFileSync(path.join(profiles.main.home, 'config.toml'), '[mcp_servers.other]\ncommand = "fixture"\n');
  result = route(acquire()); assert.equal(result.view.pick.vendor, 'claude'); assert.equal(result.plan.kind, 'blocked');
  fs.writeFileSync(missingConfig, `[mcp_servers.node_repl]\ncommand = '${command}' # literal TOML string\n`);
  connected = false;
  result = route(acquire()); assert.equal(result.view.pick.vendor, 'claude');
  assert.match(JSON.stringify(result.plan.rejected), /Chrome extension host is not connected/);
  assert.equal(route(acquire('computer-use')).view.pick.account, 'ttadk', 'desktop does not need the Chrome host');
  connected = true;
  fs.chmodSync(command, 0o600);
  assert.match(probeBrowserRuntime('ttadk', profiles.ttadk, { app }).why, /not executable/);
  fs.chmodSync(command, 0o700);
  fs.writeFileSync(missingConfig, `[mcp_servers.node_repl]\nenabled = false\ncommand = ${JSON.stringify(command)}\n`);
  assert.match(probeBrowserRuntime('ttadk', profiles.ttadk, { app }).why, /not configured/);
  assert.match(probeBrowserRuntime('ttadk', profiles.ttadk, { app: path.join(tmp, 'missing.app') }).why, /ttadk browser runtime missing:/);
  fs.writeFileSync(missingConfig, `[mcp_servers.node_repl]\ncommand = ${JSON.stringify(command)}\n`);
  appVersion = '26.1117';
  result = route(acquire());
  assert.equal(result.view.pick.vendor, 'claude', 'managed runtime skips every home missing the CLI env');
  assert.match(JSON.stringify(result.plan.rejected), /ttadk browser runtime not configured: CODEX_CLI_PATH/);
  const cli = path.join(app, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, 'fixture executable', { mode: 0o700 });
  fs.appendFileSync(missingConfig, `[mcp_servers.node_repl.env]\nCODEX_CLI_PATH = ${JSON.stringify(cli)}\n`);
  assert.equal(route(acquire()).view.pick.account, 'ttadk', 'configured company home resumes routing');
  const present = acquire();
  const stale = createSnapshot({ ...present.snapshot, accounts: present.snapshot.accounts.map(a => ({ ...a,
    ...(a.browserRuntime ? { browserRuntime: { ...a.browserRuntime, sampledAt: present.now - 31000 } } : {}) })) }, { now: present.now });
  assert.equal(routePure(present.task, stale).primary?.candidate.accountId, undefined);
  const before = probes;
  acquire('browser', { env: { ...env, ROUTE_NOW: String(now) }, readBrowserRuntime: () => { throw Error('offline replay probed host'); } });
  assert.equal(probes, before);
  console.log('PASS fresh browser runtime: present/missing app and executable, host down, desktop, TTL, replay, fallback order and why');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
