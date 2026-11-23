#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { probeBrowserRuntime, bundledCodexCliPath, chromeExtensionHostConnected } from '../lib/browser-runtime.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-setup-env-'));
const worker = new URL('../codex-worker.mjs', import.meta.url).pathname;
const app = path.join(tmp, 'ChatGPT.app'), bin = path.join(tmp, 'bin');
const cli = path.join(app, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
const repl = path.join(app, 'Contents/Resources/cua_node/bin/node_repl');
const installedCli = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
for (const executable of [cli, repl]) {
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, 'fixture executable', { mode: 0o700 });
}
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'ps'), `#!${process.execPath}\nconsole.log(process.env.HOST_MODE === 'down' ? '/fixture/node ChatGPT for Chrome' : '/fixture/extension-host/macos/arm64/ChatGPT for Chrome');\n`, { mode: 0o700 });
const preload = path.join(tmp, 'preload.mjs');
// Every app filesystem operation is redirected to the fixture bundle. Plugin
// installs and version queries are simulated; no live config or profile is used.
fs.writeFileSync(preload, `import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const map=p=>typeof p==='string'&&p.startsWith('/Applications/ChatGPT.app')?${JSON.stringify(app)}+p.slice('/Applications/ChatGPT.app'.length):p;
for(const k of ['existsSync','statSync','accessSync']){const real=fs[k];fs[k]=(p,...a)=>real(map(p),...a);}
const real=cp.execFileSync;cp.execFileSync=(file,...a)=>file==='/usr/libexec/PlistBuddy'?'26.1117':file==='codex'?'fixture plugin installed':real(file,...a);syncBuiltinESMExports();`);

function setup(id, { manifest = 'healthy', host = 'up', command = 'browser-setup' } = {}) {
  const home = path.join(tmp, id), cfg = path.join(home, 'config.toml');
  const market = path.join(home, '.codex/.tmp/bundled-marketplaces/openai-bundled');
  const scripts = path.join(market, 'plugins/chrome/scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(path.join(market, '.agents/plugins'), { recursive: true });
  fs.writeFileSync(path.join(market, '.agents/plugins/marketplace.json'), JSON.stringify({ plugins: ['chrome', 'computer-use', 'visualize'].map(name => ({ name })) }));
  fs.writeFileSync(path.join(scripts, 'check-extension-installed.js'), `throw Error('Chrome profile must never be read');`);
  fs.writeFileSync(path.join(scripts, 'check-native-host-manifest.js'), `
if(['EPERM','EACCES'].includes(process.env.MANIFEST_MODE)){console.error(process.env.MANIFEST_MODE);process.exit(1);}
if(process.env.MANIFEST_MODE==='broken'){console.error('invalid manifest');process.exit(2);}
console.log(JSON.stringify({correct:process.env.MANIFEST_MODE!=='missing'}));`);
  fs.writeFileSync(cfg, '[sandbox_workspace_write]\nnetwork_access = false\n');
  const accounts = path.join(home, 'accounts.json');
  fs.writeFileSync(accounts, JSON.stringify({ fixture: { home, kind: 'ttadk', hub: 'ws://127.0.0.1:1' } }));
  const result = spawnSync(process.execPath, ['--import', preload, worker, '--account', 'fixture', command], {
    encoding: 'utf8', timeout: 10000,
    env: { ...process.env, HOME: home, CODEX_HOME: home, CODEX_ACCOUNTS: accounts, RULES_SHARED: path.join(home, 'shared'),
      PATH: `${bin}:${process.env.PATH}`, NODE_OPTIONS: '', MANIFEST_MODE: manifest, HOST_MODE: host },
  });
  return { ...result, config: fs.readFileSync(cfg, 'utf8'), home };
}

try {
  for (const command of ['browser-setup', 'computer-use-setup']) {
    const result = setup(command, { command });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.config.includes(`CODEX_CLI_PATH = ${JSON.stringify(installedCli)}`));
    assert.ok(result.config.includes(`CODEX_HOME = "${result.home}"`));
    assert.ok(result.config.includes(`NODE_REPL_TRUSTED_CODE_PATHS = "${result.home}:${result.home}/.codex:`));
    assert.match(result.config, /env_vars = \["BROWSER_USE_ACCESS_EXECUTOR_ID", "BROWSER_USE_ACCESS_PIPE_PATH", "BROWSER_USE_ACCESS_VERIFYING_IDENTITY"\]/);
    assert.match(result.config, /network_access = false/);
    // Rewriting our existing block remains idempotent and updates the app path.
    const cfg = path.join(result.home, 'config.toml');
    fs.writeFileSync(cfg, result.config.replace(installedCli, '/old/codex'));
    const accounts = path.join(result.home, 'accounts.json');
    const rerun = spawnSync(process.execPath, ['--import', preload, worker, '--account', 'fixture', command], {
      encoding: 'utf8', timeout: 10000, env: { ...process.env, HOME: result.home, CODEX_HOME: result.home,
        CODEX_ACCOUNTS: accounts, RULES_SHARED: path.join(result.home, 'shared'), PATH: `${bin}:${process.env.PATH}`, NODE_OPTIONS: '' },
    });
    assert.equal(rerun.status, 0, rerun.stderr);
    const updated = fs.readFileSync(cfg, 'utf8');
    assert.equal((updated.match(/CODEX_CLI_PATH =/g) ?? []).length, 1);
    assert.ok(updated.includes(installedCli));
  }
  for (const manifest of ['EPERM', 'EACCES']) {
    const result = setup(manifest, { manifest });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /note: cannot verify .* from this session/);
  }
  for (const manifest of ['missing', 'broken']) {
    const result = setup(manifest, { manifest });
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.config, /mcp_servers\.node_repl/);
  }
  assert.equal(setup('host-down', { host: 'down' }).status, 1);
  fs.chmodSync(cli, 0o600);
  assert.equal(bundledCodexCliPath(app), null);
  const noCli = setup('no-cli');
  assert.equal(noCli.status, 0, noCli.stderr);
  assert.doesNotMatch(noCli.config, /CODEX_CLI_PATH/);
  fs.chmodSync(cli, 0o700);
  assert.equal(bundledCodexCliPath(app), cli);

  const home = path.join(tmp, 'runtime'); fs.mkdirSync(home);
  const cfg = path.join(home, 'config.toml');
  const config = `[mcp_servers.node_repl]\ncommand = ${JSON.stringify(repl)}\n`;
  const probe = (extra = {}) => probeBrowserRuntime('fixture', { home }, { app, appVersion: '26.1117', hostConnected: () => true, ...extra });
  fs.writeFileSync(cfg, config);
  assert.match(probe().why, /not configured: CODEX_CLI_PATH/);
  assert.match(probe({ desktop: true }).why, /not configured: CODEX_CLI_PATH/);
  assert.equal(probe({ appVersion: '26.1115' }).ready, true);
  assert.match(probe({ appVersion: '' }).why, /not configured: CODEX_CLI_PATH/);
  for (const value of ['"/missing/codex"', '"relative/codex"', '42', JSON.stringify(path.dirname(cli))]) {
    fs.writeFileSync(cfg, `${config}[mcp_servers.node_repl.env]\nCODEX_CLI_PATH = ${value}\n`);
    assert.match(probe().why, /not configured: CODEX_CLI_PATH/);
  }
  fs.writeFileSync(cfg, `${config}[unrelated]\nCODEX_CLI_PATH = ${JSON.stringify(cli)}\n`);
  assert.equal(probe().ready, false);
  fs.writeFileSync(cfg, `${config}[mcp_servers.node_repl.env]\nCODEX_CLI_PATH = '${cli}' # fixture\n`);
  assert.equal(probe().ready, true);
  fs.chmodSync(cli, 0o600);
  assert.equal(probe().ready, false);
  fs.chmodSync(cli, 0o700);
  assert.equal(chromeExtensionHostConnected({ exec: () => '/fixture/node ChatGPT for Chrome\n' }), false);
  assert.equal(chromeExtensionHostConnected({ exec: () => '/fixture/extension-host/macos/arm64/ChatGPT for Chrome\n' }), true);
  console.log('PASS browser setup env: bundled CLI, per-home settings, idempotence, manifest-only checks, permissions, exact host and managed-runtime readiness');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
