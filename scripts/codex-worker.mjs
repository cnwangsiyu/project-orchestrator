#!/usr/bin/env node
// codex-worker: run and steer Codex workers through a shared Codex app-server ("hub") over WebSocket.
//
//   codex-worker [--account NAME] <command> …                             (any command, on that account's home and hub)
//   codex-worker accounts | account-add NAME [--home DIR] [--port N]      (list / add an account profile)
//   codex-worker hub                                                       (start the hub if it isn't up)
//   codex-worker start  --cwd DIR --effort E --sandbox S [--network on|off] [--model M] [--name N] --log FILE [--out FILE]  "<prompt>"
//   codex-worker turn   --thread ID --effort E --log FILE [--out FILE] [--model M] [--sandbox S [--network on|off]]      "<prompt>"
//                       start/turn also take --browser-origins <origins/host globs> and --computer-use-apps <bundle ids>
//   codex-worker browser-setup [--account NAME]                           (Chrome + Computer Use config for that home)
//   codex-worker ttadk-setup [--name ttadk] [--home DIR] [--port N] [--search-port N]   (the TTADK gateway as an account)
//   codex-worker [--account ttadk] proxy                                   (start/check TTADK's local proxy: web search)
//   codex-worker trae-setup [--name trae] [--port N]                      (TRAE CLI as an account: its app-server is the hub)
//   codex-worker wait   --thread ID [--log FILE] [--out FILE]            (start/turn/wait take --stall-min M, default 30)
//   codex-worker steer  --thread ID                                                                     "<message>"
//   codex-worker interrupt --thread ID
//   codex-worker status --thread ID
//   codex-worker list   [--cwd DIR] [--search TEXT] [--limit N]
//   codex-worker quota                                                     (the account's rate-limit windows, JSON)
//   codex-worker usage                                                     (account id, windows and reset cards, JSON)
//   codex-worker reset-credits                                             (reset cards: count and expiries, JSON)
//   codex-worker reset-credit-use --key UUID [--credit ID]                 (redeem one reset card; irreversible)
//
// `start` and `turn` follow the turn until it ends: every notification is appended to --log as JSONL, the first stdout
// line is `thread=<id> turn=<id>`, and the process exits 0 on completed, 1 on failed/interrupted, 4 when the turn has
// been silent for --stall-min minutes (default 30; the turn keeps running — re-attach with `wait`). On exit it prints
// `turn <status>`, the token usage and `final: <first line of the final message>`, and writes the whole final message
// to --out. Run them as a harness background task so their exit notifies the orchestrator. `wait` re-attaches to a
// thread's running turn (e.g. after the orchestrator restarted) and exits the same way, at once if the turn already
// ended. `steer` injects a message into the running turn, `interrupt` stops it. `list` shows recent worker threads.
// Sandbox S is read-only | workspace-write | danger-full-access. In workspace-write the network follows Codex's config
// (`[sandbox_workspace_write] network_access`) unless --network on|off, and Codex keeps every git metadata dir
// read-only (so the worker can edit files but not add, commit or fetch).
// Requires the account's hub (localhost only; `hub` starts one detached so it outlives any one session): `main` is
// ws://127.0.0.1:47321 on ~/.codex, other accounts come from ~/.claude/orchestrator/_shared/codex-accounts.json via
// --account; CODEX_HOME / CODEX_HUB override both.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// --account NAME (anywhere on the line) picks a profile from the accounts file: its own CODEX_HOME, so its own login,
// and its own hub. Without it: CODEX_HOME / CODEX_HUB from the environment, else ~/.codex and the default hub.
const ACCOUNTS = process.env.CODEX_ACCOUNTS || path.join(os.homedir(), '.claude', 'orchestrator', '_shared', 'codex-accounts.json');
const readAccounts = () => { try { return JSON.parse(fs.readFileSync(ACCOUNTS, 'utf8')); } catch { return {}; } };
const writeAccounts = (reg) => {
  fs.mkdirSync(path.dirname(ACCOUNTS), { recursive: true });
  const t = `${ACCOUNTS}.${process.pid}`; fs.writeFileSync(t, JSON.stringify(reg, null, 1)); fs.renameSync(t, ACCOUNTS);
};
const argv = process.argv.slice(2);
const ai = argv.indexOf('--account');
const account = ai >= 0 ? argv.splice(ai, 2)[1] : null;
if (account) {
  const prof = readAccounts()[account] ?? (account === 'main' ? { home: path.join(os.homedir(), '.codex'), hub: 'ws://127.0.0.1:47321' } : null);
  if (!prof) { process.stderr.write(`codex-worker: unknown account ${account} (codex-worker accounts; add one with account-add)\n`); process.exit(2); }
  process.env.CODEX_HOME = prof.home; process.env.CODEX_HUB = prof.hub;
}
const PROF = account ? readAccounts()[account] ?? null : null;
// TTADK web search: the account's provider points at a local proxy that adds Codex's hosted web_search tool to the
// requests (ttadk-search-proxy.mjs says why), so every TTADK worker can search, as on ChatGPT accounts (user,
// 2026-11-07). The proxy runs detached, like the hub; hub/start/turn/wait bring it up when it isn't running.
const searchUrl = (prof) => `http://127.0.0.1:${prof.searchPort}`;
const searchUp = (prof) => fetch(`${searchUrl(prof)}/__health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
const ensureSearchProxy = async (prof) => {
  if (!prof?.searchPort) return false;
  if (await searchUp(prof)) return true;
  const logPath = path.join(prof.home, 'search-proxy.log');
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ttadk-search-proxy.mjs');
  spawn(process.execPath, [script, '--port', String(prof.searchPort), '--upstream', prof.upstream ?? 'https://llmbox-global.byteintl.net', '--log', logPath],
    { detached: true, stdio: 'ignore', cwd: os.homedir() }).unref();
  for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 250)); if (await searchUp(prof)) return true; }
  return false;
};
const [cmd, ...rest] = argv;
const opts = {}; const pos = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) opts[rest[i].slice(2)] = rest[i + 1]?.startsWith('--') || rest[i + 1] === undefined ? true : rest[++i];
  else pos.push(rest[i]);
}
// TRAE names its models in its own case (GPT-6.1-Sol); accept the router's lower-case ids too.
if (PROF?.kind === 'trae' && typeof opts.model === 'string') opts.model = PROF.modelIds?.[opts.model.toLowerCase()] ?? opts.model;
const text = pos.join(' ');
const die = (msg, code = 2) => { process.stderr.write(`codex-worker: ${msg}\n`); process.exit(code); };
if (!cmd) die('usage: codex-worker [--account NAME] hub|start|turn|wait|steer|interrupt|status|list|quota|usage|reset-credits|reset-credit-use|accounts|account-add ...');
if ((cmd === 'start' || cmd === 'turn') && typeof opts.effort !== 'string') die(`${cmd} needs --effort (the catalog default may be low)`);
if (cmd === 'start' && typeof opts.sandbox !== 'string') die('start needs --sandbox (read-only | workspace-write | danger-full-access; never wider than the orchestrator)');
const SANDBOX_POLICY = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' };
if (opts.sandbox !== undefined && !SANDBOX_POLICY[opts.sandbox]) die(`unknown --sandbox ${opts.sandbox}`);
if (opts.network === true) opts.network = 'on';
if (opts.network !== undefined && !['on', 'off'].includes(opts.network)) die('--network takes on or off');
if (opts.network !== undefined && opts.sandbox !== 'workspace-write') die('--network goes with --sandbox workspace-write');
// Codex's own default for workspace-write network, so an explicit turn-level policy doesn't silently change it.
const configNetwork = () => {
  try {
    const toml = fs.readFileSync(PROF?.kind === 'trae' ? path.join(PROF.home, 'traecli.toml') : path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'), 'utf8');
    const section = toml.split(/^\[/m).find((s) => s.startsWith('sandbox_workspace_write]')) ?? '';
    return /^\s*network_access\s*=\s*true\b/m.test(section);
  } catch { return false; }
};
// The turn-level sandbox policy. Don't add git dirs as writable roots: Codex overrides them read-only on purpose, since
// a sandboxed write to .git/hooks or .git/config would run outside the sandbox at the next git command.
const sandboxPolicy = (mode) => mode === 'workspace-write'
  ? { type: 'workspaceWrite', networkAccess: opts.network === undefined ? configNetwork() : opts.network === 'on' }
  : { type: SANDBOX_POLICY[mode] };

if (cmd === 'accounts') {
  const reg = readAccounts();
  if (!Object.keys(reg).length) console.log('main\t~/.codex\tws://127.0.0.1:47321\t(default; no accounts file yet)');
  for (const [name, a] of Object.entries(reg)) console.log([name, a.home, a.hub, a.email ?? '-', a.plan ?? '-'].join('\t'));
  process.exit(0);
}
// Browser use and Computer Use on a Codex worker (verified 2026-11-07 with the TTADK gateway's gpt-6.1-sol). Both drive the
// local pieces the ChatGPT app uses: its bundled `chrome` and `computer-use` plugins (instructions + browser-client) and
// ChatGPT.app's node_repl MCP server, which loads @oai/browser-desktop (Chrome, via the ChatGPT Chrome extension and its
// native host) and @oai/sky (desktop apps, via the "Codex Computer Use" helper).
// `browser-setup` gives the account the main home's plugins (user, 2026-11-07: align the accounts) and writes what a CLI
// run needs into its config.toml (backed up first):
// - installs (`codex plugin add`, which a config entry alone does not do) the bundled chrome, computer-use and visualize
//   plugins, and documents / pdf / spreadsheets / presentations / template-creator from the primary runtime the app
//   unpacks under ~/.cache/codex-runtimes (their dependencies live there, shared by every home). The name
//   `openai-bundled` is reserved and resolves only on the app's own home, so another home lists the same plugin dirs
//   through a small local marketplace `chatgpt-bundled` (<home>/marketplaces/chatgpt-bundled, plugins symlinked to the
//   app's unpacked copy). App-only plugins stay off: in-app `browser`, `codex-app-tools`, and `unified-computer-use`,
//   whose cua_repl needs the app's browser access host ("The browser access host is unavailable" on a CLI run, tested
//   2026-11-07); so do ChatGPT connectors;
// - node_repl as an MCP server, as the ChatGPT app writes it into the main home's config.toml (the chrome and
//   computer-use plugins are instructions + hooks on that server, not servers themselves);
// - node_repl with tool calls auto-approved (under approvalPolicy never they would be refused outright);
// - NODE_REPL_TRUSTED_SERVICES for sky + browser (the ChatGPT app sets it itself; a CLI launch has to).
// Per-site and per-app access stays per task: `start/turn --browser-origins` / `--computer-use-apps` answer those approvals.
// The official [browser_use.origins] / [computer_use.macos.bundle_ids] config is not consulted on CLI runs (tested).
if (cmd === 'browser-setup' || cmd === 'computer-use-setup') {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const cfg = path.join(home, 'config.toml');
  const repl = '/Applications/ChatGPT.app/Contents/Resources/cua_node';
  const market = path.join(os.homedir(), '.codex', '.tmp', 'bundled-marketplaces', 'openai-bundled');
  const chromePlugin = path.join(market, 'plugins', 'chrome');
  if (!fs.existsSync(path.join(repl, 'bin', 'node_repl'))) die(`ChatGPT.app's node_repl not found under ${repl}: install the ChatGPT desktop app`, 1);
  if (!fs.existsSync(chromePlugin)) die(`bundled chrome plugin not found under ${market}: open the ChatGPT desktop app once (it unpacks the bundled plugins)`, 1);
  try { if (fs.lstatSync(cfg).isSymbolicLink()) die(`${cfg} is a symlink to another home's config; browser-setup only writes an account's own config (TTADK homes have one)`, 1); } catch {}
  // The ChatGPT Chrome extension must be installed and enabled, with its native host registered.
  try { execFileSync(process.execPath, [path.join(chromePlugin, 'scripts', 'check-extension-installed.js'), '--browser', 'chrome', '--json'], { encoding: 'utf8', timeout: 20000 }); }
  catch (e) { die(`ChatGPT Chrome extension check failed (${String(e.stdout || e.message).split('\n')[0]}): in the ChatGPT app, Settings > Computer use > Google Chrome > install the browser extension`, 1); }
  const MARK = '# --- Browser/Computer Use (codex-worker browser-setup) ---', END = '# --- end browser-setup ---';
  const runtime = path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'plugins', 'openai-primary-runtime');
  const docPlugins = ['documents', 'pdf', 'spreadsheets', 'presentations', 'template-creator'];
  const hasRuntime = fs.existsSync(path.join(runtime, 'plugins', 'documents'));
  if (!hasRuntime) console.error(`note: the ChatGPT app's primary runtime is not under ${runtime} (open the ChatGPT app once to unpack it); document plugins skipped`);
  // The bundled plugins through a local marketplace of our own name (see above); rebuilt on every run, so a rerun after
  // a ChatGPT app update picks up the new plugin versions.
  const bundled = ['chrome', 'computer-use', 'visualize'];
  const ownMarket = path.join(home, 'marketplaces', 'chatgpt-bundled');
  fs.mkdirSync(path.join(ownMarket, '.agents', 'plugins'), { recursive: true });
  try { fs.rmSync(path.join(ownMarket, 'plugins'), { force: true }); } catch {}
  fs.symlinkSync(path.join(market, 'plugins'), path.join(ownMarket, 'plugins'));
  const manifest = JSON.parse(fs.readFileSync(path.join(market, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  fs.writeFileSync(path.join(ownMarket, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ ...manifest, name: 'chatgpt-bundled', plugins: manifest.plugins.filter((x) => bundled.includes(x.name)) }, null, 2));
  const runtimeBlock = hasRuntime ? `
[marketplaces.openai-primary-runtime]
source_type = "local"
source = "${runtime}"
${docPlugins.map((p) => `\n[plugins."${p}@openai-primary-runtime"]\nenabled = true\n`).join('')}` : '';
  // The same node_repl environment the ChatGPT app writes for itself, with the app's own version (the Chrome backend
  // checks it: without these, the browser runtime reports "Browser is not available: chrome").
  let appVersion = '';
  try { appVersion = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', '/Applications/ChatGPT.app/Contents/Info.plist'], { encoding: 'utf8' }).trim(); } catch {}
  const block = `${MARK}
[marketplaces.chatgpt-bundled]
source_type = "local"
source = "${ownMarket}"
${bundled.map((p) => `\n[plugins."${p}@chatgpt-bundled"]\nenabled = true\n`).join('')}${runtimeBlock}
[mcp_servers.node_repl]
args = []
command = "${repl}/bin/node_repl"
env_vars = ["BROWSER_USE_ACCESS_EXECUTOR_ID", "BROWSER_USE_ACCESS_PIPE_PATH", "BROWSER_USE_ACCESS_VERIFYING_IDENTITY"]
startup_timeout_sec = 120
default_tools_approval_mode = "approve"

[mcp_servers.node_repl.env]
NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS = "1000"
NODE_REPL_NODE_MODULE_DIRS = "${repl}/lib/node_modules"
NODE_REPL_NODE_PATH = "${repl}/bin/node"
NODE_REPL_TRUSTED_CODE_PATHS = "${home}:${os.homedir()}/.codex:${repl}/lib/node_modules"
NODE_REPL_TRUSTED_SERVICES = '{"sky":"@oai/sky/service","browser":"@oai/browser-desktop/service"}'
BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab,mcpapps"
BROWSER_USE_TINYSKY_ENABLED = "1"
BROWSER_USE_CODEX_APP_BUILD_FLAVOR = "prod"
BROWSER_USE_CODEX_APP_VERSION = "${appVersion}"
CODEX_HOME = "${home}"
${END}
`;
  let toml = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8') : '';
  if (toml.includes(MARK)) {
    // Rewrite our own block in place (rerun after a ChatGPT app update); an older block without END ran to the end.
    const i = toml.indexOf(MARK), j = toml.indexOf(END, i);
    toml = toml.slice(0, i) + block + (j >= 0 ? toml.slice(j + END.length).replace(/^\n/, '') : '');
  } else {
    if (/^\[mcp_servers\.node_repl\]/m.test(toml) || /^\[plugins\."[^"]+@(openai-bundled|openai-primary-runtime|chatgpt-bundled)"\]/m.test(toml) || /^\[marketplaces\.(openai-bundled|openai-primary-runtime|chatgpt-bundled)\]/m.test(toml))
      die(`${cfg} already has node_repl / plugin / openai-bundled sections that differ from what this writes; edit them by hand (references/codex-workers.md, "Browser use on a Codex worker")`, 1);
    toml += `\n${block}`;
  }
  if (fs.existsSync(cfg)) fs.copyFileSync(cfg, `${cfg}.bak-browser-${Date.now()}`);
  fs.writeFileSync(cfg, toml);
  // Install them; `plugin add` keeps the entries above as they are.
  const installed = [], failed = [];
  for (const id of [...bundled.map((p) => `${p}@chatgpt-bundled`), ...(hasRuntime ? docPlugins.map((p) => `${p}@openai-primary-runtime`) : [])]) {
    try { execFileSync('codex', ['plugin', 'add', id], { env: { ...process.env, CODEX_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 60000 }); installed.push(id); }
    catch (e) { failed.push(`${id} (${String(e.stderr || e.message).trim().split('\n')[0]})`); }
  }
  // Remember on the account profile that this home can take browser work (route.mjs reads it).
  const reg = readAccounts();
  const name = account ?? Object.keys(reg).find((k) => path.resolve(reg[k].home) === path.resolve(home));
  if (name && reg[name]) { reg[name].browser = true; reg[name].chromePlugin = chromePlugin; writeAccounts(reg); }
  console.log(`plugins installed: ${installed.join(', ') || 'none'}${failed.length ? `; FAILED: ${failed.join('; ')}` : ''}`);
  console.log(`browser use configured in ${cfg}${name ? ` (account ${name} marked browser-ready)` : ''}. Launch workers through the hub with --browser-origins <patterns> (and --computer-use-apps <bundle ids> for desktop apps); keep Chrome running.`);
  process.exit(failed.length ? 1 : 0);
}
// The TTADK company gateway as a Codex account (user, 2026-11-07: prefer it whenever it works). Its own CODEX_HOME whose
// config points the model provider at the gateway, authenticated by `ttadk get_params --sso sso` (SSO, no key).
if (cmd === 'ttadk-setup') {
  const name = typeof opts.name === 'string' ? opts.name : 'ttadk';
  let ttadkBin = '';
  try { ttadkBin = execFileSync('/bin/zsh', ['-lc', 'command -v ttadk'], { encoding: 'utf8' }).trim(); } catch {}
  if (!ttadkBin) die('ttadk not found: npm install -g @byted/ttadk@latest --registry=https://bnpm.byted.org', 1);
  let st = null;
  try { st = JSON.parse(execFileSync(ttadkBin, ['auth', 'status', '-f', 'json'], { encoding: 'utf8', timeout: 30000 })); } catch {}
  const sso = (st?.providers ?? []).find((x) => x.provider === 'sso');
  if (sso?.status !== 'active') die('TTADK SSO is not logged in: ask the user to run `! ttadk auth login sso`', 1);
  let models = [];
  try { models = ((j) => (Array.isArray(j) ? j : j.models ?? []))(JSON.parse(execFileSync(ttadkBin, ['models', '-f', 'json'], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] }))).filter((m) => (m.availableAgents ?? []).includes('codex')).map((m) => m.id); } catch {}
  if (!models.includes('gpt-6.1-sol')) die(`the TTADK gateway lists no gpt-6.1-sol for codex (models: ${models.join(', ') || 'none'})`, 1);
  const reg = readAccounts();
  reg.main ??= { home: path.join(os.homedir(), '.codex'), hub: 'ws://127.0.0.1:47321' };
  const home = path.resolve(typeof opts.home === 'string' ? opts.home : reg[name]?.home ?? path.join(os.homedir(), `.codex-${name}`));
  const ports = Object.entries(reg).filter(([k]) => k !== name).map(([, a]) => Number(new URL(a.hub).port));
  const port = Number(opts.port ?? (reg[name] ? new URL(reg[name].hub).port : Math.max(...ports) + 1));
  fs.mkdirSync(home, { recursive: true });
  for (const f of ['AGENTS.md', 'skills', 'rules']) {
    const src = path.join(os.homedir(), '.codex', f), dst = path.join(home, f);
    if (fs.existsSync(src) && !fs.existsSync(dst)) fs.symlinkSync(src, dst);
  }
  const cfg = path.join(home, 'config.toml');
  if (!fs.existsSync(cfg) || !fs.readFileSync(cfg, 'utf8').includes('model_provider = "ttadk_app"')) {
    if (fs.existsSync(cfg)) fs.copyFileSync(cfg, `${cfg}.bak-ttadk-${Date.now()}`);
    const keep = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8') : '';
    fs.writeFileSync(cfg, `# TTADK company gateway (codex-worker ttadk-setup). Models: ${models.join(', ')}
model = "gpt-6.1-sol"
model_provider = "ttadk_app"

[model_providers.ttadk_app]
name = "ttadk_app"
base_url = "https://llmbox-global.byteintl.net/"
wire_api = "responses"

[model_providers.ttadk_app.http_headers]
X-Source = "ttadk"

[model_providers.ttadk_app.auth]
command = "${ttadkBin}"
args = ["get_params", "--sso", "sso"]
timeout_ms = 5000
refresh_interval_ms = 2000000

[sandbox_workspace_write]
network_access = true
${keep ? `\n# --- previous config ---\n${keep}` : ''}`);
  }
  // Web search: the provider's base_url is the local proxy (ttadk-search-proxy.mjs), which forwards to the gateway.
  const searchPort = Number(opts['search-port'] ?? reg[name]?.searchPort ?? port + 100);
  let ctoml = fs.readFileSync(cfg, 'utf8');
  const sec = ctoml.match(/^\[model_providers\.ttadk_app\]\n(?:(?!^\[)[^\n]*\n?)*/m);
  if (!sec) die(`${cfg} has no [model_providers.ttadk_app] section; move it aside and rerun ttadk-setup`, 1);
  ctoml = ctoml.replace(sec[0], sec[0].replace(/^base_url\s*=.*$/m, `base_url = "http://127.0.0.1:${searchPort}/" # local proxy → https://llmbox-global.byteintl.net/ (web search)`));
  // Drop the earlier second provider (research-only search, 2026-11-07), if this home has it.
  const SM = '# --- TTADK web search provider (codex-worker ttadk-setup) ---', SE = '# --- end TTADK web search provider ---';
  if (ctoml.includes(SM)) { const i = ctoml.indexOf(SM), j = ctoml.indexOf(SE, i); ctoml = ctoml.slice(0, i) + (j >= 0 ? ctoml.slice(j + SE.length).replace(/^\n/, '') : ''); }
  fs.writeFileSync(cfg, ctoml);
  const { searchHub: _drop, ...prev } = reg[name] ?? {};
  reg[name] = { ...prev, home, hub: `ws://127.0.0.1:${port}`, kind: 'ttadk', models, ttadkBin, searchPort, upstream: 'https://llmbox-global.byteintl.net' };
  writeAccounts(reg);
  console.log(`TTADK account ${name}: ${home}, hub ws://127.0.0.1:${port}; codex models: ${models.join(', ')}`);
  console.log(`start its hub:   node ${process.argv[1]} --account ${name} hub`);
  console.log(`browser use:     node ${process.argv[1]} --account ${name} browser-setup   (also enables the main home's document plugins)`);
  console.log(`web search:      through the local proxy on 127.0.0.1:${searchPort} (started with the hub, and by start/turn/wait)`);
  process.exit(0);
}
// TRAE CLI as a Codex account (user, 2026-11-08: TTADK first, then TRAE, then personal quota). TRAE CLI is the company's
// official agent CLI, a fork of Codex: `traex app-server` speaks the hub protocol, `traecli exec` mirrors `codex exec`,
// and its GPT-6.1-Sol gets the official Codex prompt and tools (compared 2026-11-08). Its model pool is separate from
// TTADK's. It has no ChatGPT browser/computer-use (the Chrome extension accepts only the OpenAI-signed client) and no
// image generation; it gets Playwright MCP for its own headless Chrome. This writes into ~/.trae/traecli.toml: commits
// without TRAE's co-author line, live web search, the playwright MCP server, and network in workspace-write (as TTADK);
// then registers the account.
if (cmd === 'trae-setup') {
  const name = typeof opts.name === 'string' ? opts.name : 'trae';
  let bin = '';
  try { bin = execFileSync('/bin/zsh', ['-lc', 'command -v traex || ls ~/.local/bin/traex'], { encoding: 'utf8' }).trim().split('\n')[0]; } catch {}
  if (!bin) die('TRAE CLI not found: sh -c "$(curl -fsSL https://code.byted.org/api/tos-proxy/download/traex_install.sh)"', 1);
  let status = '';
  try { status = execFileSync('/bin/sh', ['-c', '"$0" login status 2>&1', bin], { encoding: 'utf8', timeout: 30000 }); } catch (e) { status = String(e.stdout ?? ''); } // it prints to stderr
  if (!/logged in/i.test(status) || /not logged in/i.test(status)) die('TRAE CLI is not logged in: run `traecli login --git-code` (or ask the user to run `! traecli login --sso`)', 1);
  let ids = [];
  try { ids = execFileSync(bin, ['models'], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').map((l) => l.trim()).filter((l) => /^[A-Za-z0-9][\w.-]*$/.test(l)); } catch {}
  if (!ids.some((i) => i.toLowerCase() === 'gpt-6.1-sol')) die(`TRAE CLI lists no GPT-6.1-Sol (models: ${ids.join(', ') || 'none'})`, 1);
  const home = path.join(os.homedir(), '.trae'), cfg = path.join(home, 'traecli.toml');
  let toml = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8') : '';
  const strip = (t, a, b) => { const i = t.indexOf(a); if (i < 0) return t; const j = t.indexOf(b, i); return t.slice(0, i) + (j >= 0 ? t.slice(j + b.length).replace(/^\n/, '') : ''); };
  const TA = '# --- worker settings (codex-worker trae-setup) ---', TB = '# --- end worker settings ---';
  const MA = '# --- playwright MCP (codex-worker trae-setup) ---', MB = '# --- end playwright MCP ---';
  toml = strip(strip(toml, TA, TB), MA, MB);
  // Top-level keys must come before every [table].
  toml = `${TA}\ncommit_attribution = ""\nweb_search = "live"\n${TB}\n${toml}`;
  toml = `${toml.replace(/\n*$/, '\n')}\n${MA}\n[mcp_servers.playwright]\ncommand = "npx"\nargs = ["-y", "@playwright/mcp@latest", "--browser", "chrome", "--headless", "--isolated"]\nstartup_timeout_sec = 120\ndefault_tools_approval_mode = "approve"\n\n[sandbox_workspace_write]\nnetwork_access = true\n${MB}\n`;
  if (fs.existsSync(cfg)) fs.copyFileSync(cfg, `${cfg}.bak-worker-${Date.now()}`);
  fs.writeFileSync(cfg, toml);
  const reg = readAccounts();
  reg.main ??= { home: path.join(os.homedir(), '.codex'), hub: 'ws://127.0.0.1:47321' };
  const ports = Object.entries(reg).filter(([k]) => k !== name).map(([, a]) => Number(new URL(a.hub).port));
  const port = Number(opts.port ?? (reg[name] ? new URL(reg[name].hub).port : Math.max(...ports) + 1));
  const modelIds = Object.fromEntries(ids.map((i) => [i.toLowerCase(), i]));
  reg[name] = { ...(reg[name] ?? {}), home, hub: `ws://127.0.0.1:${port}`, kind: 'trae', bin, models: Object.keys(modelIds), modelIds, search: true };
  writeAccounts(reg);
  console.log(`TRAE account ${name}: hub ws://127.0.0.1:${port} (traex app-server); models: ${ids.join(', ')}`);
  console.log(`config: ${cfg} (no co-author line, live web search, playwright MCP)`);
  console.log(`start its hub:   node ${process.argv[1]} --account ${name} hub`);
  process.exit(0);
}
// The console session is locked: Computer Use sees no windows (cgWindowNotFound). The ChatGPT app's "Locked use" unlock is
// reserved to its own turns by design, so a CLI worker can't use it; fail early instead.
const screenLocked = () => {
  try {
    const out = execFileSync('python3', ['-c', "import ctypes,ctypes.util,re\ncf=ctypes.cdll.LoadLibrary(ctypes.util.find_library('CoreFoundation'))\nq=ctypes.cdll.LoadLibrary('/System/Library/Frameworks/Quartz.framework/Quartz')\nq.CGSessionCopyCurrentDictionary.restype=ctypes.c_void_p\ncf.CFCopyDescription.restype=ctypes.c_void_p;cf.CFCopyDescription.argtypes=[ctypes.c_void_p]\ncf.CFStringGetCString.argtypes=[ctypes.c_void_p,ctypes.c_char_p,ctypes.c_long,ctypes.c_uint32]\nb=ctypes.create_string_buffer(8192);cf.CFStringGetCString(cf.CFCopyDescription(q.CGSessionCopyCurrentDictionary()),b,8192,0x08000100)\nprint('locked' if re.search(r'CGSSessionScreenIsLocked\\W+=\\W*1',b.value.decode()) else 'unlocked')"], { encoding: 'utf8', timeout: 10000 });
    return out.trim() === 'locked';
  } catch { return false; }
};
if (cmd === 'account-add') {
  // A second (third, …) account: its own CODEX_HOME sharing the main home's config, instructions, skills and rules (not
  // its sessions, logins or databases), and its own hub port. The user logs it in once; it then runs side by side.
  const name = pos[0];
  if (!name || !/^[a-z0-9_-]+$/i.test(name)) die('usage: codex-worker account-add <name> [--home DIR] [--port N]');
  const reg = readAccounts();
  const main = path.join(os.homedir(), '.codex');
  reg.main ??= { home: main, hub: 'ws://127.0.0.1:47321' };
  if (reg[name]) die(`account ${name} exists: ${reg[name].home} ${reg[name].hub}`);
  const ports = Object.values(reg).map((a) => Number(new URL(a.hub).port));
  const port = Number(opts.port ?? Math.max(...ports) + 1);
  const home = path.resolve(typeof opts.home === 'string' ? opts.home : path.join(os.homedir(), `.codex-${name}`));
  fs.mkdirSync(home, { recursive: true });
  for (const f of ['config.toml', 'AGENTS.md', 'skills', 'rules']) {
    const src = path.join(main, f), dst = path.join(home, f);
    if (fs.existsSync(src) && !fs.existsSync(dst)) fs.symlinkSync(src, dst);
  }
  reg[name] = { home, hub: `ws://127.0.0.1:${port}` };
  writeAccounts(reg);
  console.log(`account ${name}: ${home}, hub ws://127.0.0.1:${port}`);
  console.log(`log it in once:  CODEX_HOME=${home} codex login`);
  console.log(`then:            node ${process.argv[1]} --account ${name} hub`);
  process.exit(0);
}
const CU_APPS = typeof opts['computer-use-apps'] === 'string' ? opts['computer-use-apps'].split(',').map((x) => x.trim()).filter(Boolean) : [];
// --browser-origins: exact origins (https://x.y) or host globs (*.bytedance.net matches the host and its subdomains).
const BU_ORIGINS = typeof opts['browser-origins'] === 'string' ? opts['browser-origins'].split(',').map((x) => x.trim()).filter(Boolean) : [];
const originAllowed = (origin) => {
  let host = ''; try { host = new URL(origin).hostname; } catch { return false; }
  return BU_ORIGINS.some((p) => p === '*' || p === origin || (p.startsWith('*.') ? host === p.slice(2) || host.endsWith(p.slice(1)) : host === p));
};
// The per-app / per-site approvals only reach this client when the thread asks on request; under never, Codex declines
// them itself. Other requests still get the refusals in REPLIES, so the sandbox stays the only bound.
const APPROVAL_POLICY = CU_APPS.length || BU_ORIGINS.length ? 'on-request' : 'never';
if (CU_APPS.length && (cmd === 'start' || cmd === 'turn') && screenLocked()) die("the screen is locked: Computer Use sees no windows while the Mac is locked (the ChatGPT app's Locked use is reserved to its own turns). Unlock it, or keep it unlocked while computer-use workers run.", 5);
const hub = process.env.CODEX_HUB || 'ws://127.0.0.1:47321';
const ready = () => fetch(hub.replace(/^ws/, 'http') + '/readyz', { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
const proxied = PROF?.kind === 'ttadk' && !!PROF.searchPort;
if (cmd === 'proxy' || cmd === 'search-proxy') {
  if (PROF?.kind !== 'ttadk') die('proxy is for a TTADK account (--account <name>, set up by ttadk-setup)');
  if (!proxied) die(`account ${account} has no proxy yet: rerun ttadk-setup`, 1);
  if (await ensureSearchProxy(PROF)) { console.log(`TTADK proxy up at ${searchUrl(PROF)}`); process.exit(0); }
  die(`TTADK proxy did not start; see ${PROF.home}/search-proxy.log`, 1);
}
// Every model call of this account goes through the proxy: bring it up before work starts; exit 6 when that fails, so
// the orchestrator re-routes without TTADK.
if (proxied && ['hub', 'start', 'turn', 'wait'].includes(cmd) && !(await ensureSearchProxy(PROF))) {
  console.log(`proxy-unavailable: TTADK's local proxy is not running (codex-worker --account ${account} proxy; log ${PROF.home}/search-proxy.log); re-route with route.mjs ... --exclude-account ${account}`);
  process.exit(6);
}
const searchNote = async () => (proxied ? `; proxy up at ${searchUrl(PROF)} (web search)` : '');
if (cmd === 'hub') {
  if (await ready()) { console.log(`hub up at ${hub}${await searchNote()}`); process.exit(0); }
  const logPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hub.log');
  const out = fs.openSync(logPath, 'a');
  // From $HOME, never the caller's cwd: a hub outlives the session that started it, and once that directory is gone
  // (a removed worktree) the TTADK provider's auth command can't run and every new thread panics ("provider auth cwd
  // must resolve", 2026-11-08).
  // A TRAE account's hub is TRAE CLI's own app-server (`traex`, a Codex fork speaking the same protocol); it keeps its
  // home in ~/.trae, so CODEX_HOME is not passed on.
  const trae = PROF?.kind === 'trae';
  const env = { ...process.env }; if (trae) delete env.CODEX_HOME;
  spawn(trae ? PROF.bin : 'codex', ['app-server', '--listen', hub], { detached: true, stdio: ['ignore', out, out], cwd: os.homedir(), env }).unref();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await ready()) { console.log(`hub started at ${hub} (log: ${logPath})${await searchNote()}`); process.exit(0); }
  }
  die(`hub did not become ready; see ${logPath}`, 1);
}

const ws = new WebSocket(hub);
let done = false, nextId = 0;
const pending = new Map();
const handlers = [];
const logFile = opts.log ? path.resolve(opts.log) : null;
const write = (obj) => ws.send(JSON.stringify(obj));
const call = (method, params) => new Promise((resolve, reject) => {
  const id = ++nextId; pending.set(id, { resolve, reject }); write({ jsonrpc: '2.0', id, method, params });
});
const finish = (code) => { done = true; try { ws.close(); } catch {} process.exit(code); };
// Nobody is at the hub to answer a worker, so every server→client request gets a valid refusal. Approvals don't
// arrive under approvalPolicy never; a question tells the worker to report it instead of waiting.
const NO_USER = 'No user is available to answer in this session. Do not wait for one: finish what you can, then end '
  + 'the turn with a final message whose first line starts with QUESTION (after your task id, if you have one) and states the question.';
const REPLIES = {
  'item/commandExecution/requestApproval': () => ({ decision: 'decline' }),
  'item/fileChange/requestApproval': () => ({ decision: 'decline' }),
  'execCommandApproval': () => ({ decision: 'denied' }),
  'applyPatchApproval': () => ({ decision: 'denied' }),
  'item/permissions/requestApproval': () => ({ permissions: {} }),
  // Computer Use asks (an MCP elicitation from node_repl) before it uses each app, and Browser use before each site it
  // reaches. Accept only the apps / sites this worker was launched with (--computer-use-apps / --browser-origins), for
  // this session; decline everything else, as before. Each decision is logged to --log for audit.
  'mcpServer/elicitation/request': (p) => {
    const blob = JSON.stringify(p ?? {});
    const fromRepl = p?.serverName === 'node_repl';
    const app = (blob.match(/"tool_params":\{"app":"([^"]+)"/) || [])[1] ?? null;
    const origin = (blob.match(/"tool_params":\{"origin":"([^"]+)"/) || [])[1] ?? null;
    const isCU = fromRepl && /"connector_id":"computer-use"/.test(blob);
    const isBU = fromRepl && /"connector_id":"browser-use"/.test(blob);
    const ok = (isCU && app && CU_APPS.includes(app)) || (isBU && origin && originAllowed(origin));
    if ((isCU || isBU) && opts.log) try { fs.appendFileSync(path.resolve(opts.log), JSON.stringify({ accessApproval: { kind: isCU ? 'app' : 'origin', target: app ?? origin, decision: ok ? 'accept' : 'decline', at: Date.now() } }) + '\n'); } catch {}
    return ok ? { action: 'accept', content: {}, _meta: { persist: 'session' } } : { action: 'decline' };
  },
  'item/tool/call': () => ({ contentItems: [{ type: 'inputText', text: 'Not available in this session.' }], success: false }),
  'item/tool/requestUserInput': (p) => ({ answers: Object.fromEntries((p.questions ?? []).map((q) => [q.id, { answers: [NO_USER] }])) }),
};
ws.onclose = () => { if (!done) die(`hub connection closed (${hub}); is it running? (codex-worker hub)`); };
ws.onerror = () => { if (!done) die(`cannot reach the hub at ${hub}; start it with: codex-worker hub`); };
ws.onmessage = (ev) => {
  const line = String(ev.data);
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && pending.has(m.id) && !m.method) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(`${m.error.code}: ${m.error.message}`)) : p.resolve(m.result); return;
  }
  if (logFile) fs.appendFileSync(logFile, line + '\n');
  if (m.id !== undefined && m.method) {
    const reply = REPLIES[m.method];
    write(reply ? { jsonrpc: '2.0', id: m.id, result: reply(m.params || {}) }
      : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `${m.method} is not supported by codex-worker` } });
    return;
  }
  for (const h of handlers) h(m);
};
await new Promise((resolve) => { ws.onopen = resolve; });

const init = async () => { await call('initialize', { clientInfo: { name: 'codex-worker', version: '1.1.0' } }); write({ jsonrpc: '2.0', method: 'initialized', params: {} }); };
const textInput = (t) => [{ type: 'text', text: t }];
const readTurns = async (threadId) => (await call('thread/read', { threadId, includeTurns: true })).thread?.turns ?? [];
const currentTurn = async (threadId) => {
  const turns = await readTurns(threadId);
  return turns.filter((t) => t.status === 'inProgress').at(-1) ?? turns.at(-1);
};
const lastMessage = (items) => (items ?? []).filter((i) => i.type === 'agentMessage' && i.text).at(-1)?.text;
// Prints the outcome and exits: status, usage, the final message's first line (whole message to --out).
const report = async (threadId, turn, final, usage) => {
  console.log(`turn ${turn.status}${turn.error ? ' error=' + JSON.stringify(turn.error) : ''}`);
  // A rate-limited / concurrency failure (e.g. the TTADK gateway's QPM limit): retry once on the same account, then
  // re-route without it (user, 2026-11-07).
  // The TTADK token quota (daily / hourly, shared by all models) is used up: retrying or switching models can't help.
  const quota = /(Daily|Hourly) Limits exceeded\. Resets at (\d{4}-\d\d-\d\dT[\d:.]+Z?)/i.exec(JSON.stringify(turn.error ?? ''));
  if (turn.status === 'failed' && quota) {
    console.log(`quota-exhausted: ${account ?? 'this account'}'s ${quota[1].toLowerCase()} token quota is used up until ${quota[2]} (all models). Don't retry: re-route with route.mjs ... --exclude-account ${account ?? '<account>'} only for --urgent or high-stakes work; route.mjs holds the rest until the reset`);
  } else if (turn.status === 'failed' && /rate.?limit|qpm|too many requests|429|concurren/i.test(JSON.stringify(turn.error ?? ''))) {
    console.log(`rate-limited: retry this task once on ${account ?? 'this account'} (codex-worker turn); if it fails again, re-route with route.mjs ... --exclude-account ${account ?? '<account>'}`);
  }
  // The Chrome extension's native host ("ChatGPT for Chrome") comes and goes; while it is down the browser runtime
  // says "Browser is not available: chrome" (seen 2026-11-07; back within a minute on its own).
  if (/Browser is not available: chrome/.test(JSON.stringify(turn.error ?? '') + (final ?? lastMessage(turn.items) ?? ''))) {
    console.log('browser-unavailable: the Chrome extension host is not connected (pgrep -f "ChatGPT for Chrome"). Make sure Chrome is running, wait a minute and retry once; if it fails again, re-route the task to a Claude worker (route.mjs browser --exclude-account ' + (account ?? '<account>') + ')');
  }
  if (usage) console.log(`usage (thread total) input=${usage.inputTokens} cached=${usage.cachedInputTokens} output=${usage.outputTokens}`);
  final ??= lastMessage(turn.items);
  if (!final) final = lastMessage((await readTurns(threadId).catch(() => [])).find((t) => t.id === turn.id)?.items);
  if (final) {
    if (opts.out) fs.writeFileSync(path.resolve(opts.out), final + '\n');
    console.log(`final: ${final.split('\n').find((l) => l.trim()) ?? ''}`);
  }
  finish(turn.status === 'completed' ? 0 : 1);
};
// Stall alarm: no event for this turn in --stall-min minutes (default 30, 0 = off) ends the follower with exit 4 so the
// orchestrator wakes up. The turn keeps running on the hub. A worker waiting on its own sub-agents can be quiet that long,
// so check before acting: `status`, child threads (parent_thread_id) under <home>/sessions/, then `wait` again, steer
// or interrupt.
const STALL_MIN = opts['stall-min'] === undefined ? 30 : Number(opts['stall-min']);
const follow = (threadId, turnId) => {
  console.log(`thread=${threadId} turn=${turnId}`);
  let final, usage, last = Date.now();
  if (STALL_MIN > 0) setInterval(() => {
    const idle = (Date.now() - last) / 60000;
    if (idle < STALL_MIN) return;
    const line = `stalled: no events for ${idle < 1 ? `${Math.round(idle * 60)}s` : `${Math.round(idle)}m`} on turn ${turnId} (thread ${threadId}); the turn is still running on the hub — check status and sub-agent threads, then wait again, steer or interrupt`;
    console.log(line);
    if (opts.log) try { fs.appendFileSync(path.resolve(opts.log), JSON.stringify({ stalled: true, idleMin: Math.round(idle), at: Date.now() }) + '\n'); } catch {}
    finish(4);
  }, Math.min(60000, Math.max(5000, STALL_MIN * 30000))).unref();
  handlers.push((m) => {
    const p = m.params || {};
    if (p.turnId !== undefined && p.turnId !== turnId) return;
    // Only this turn's or thread's own events count as progress; account-wide updates (rate limits…) don't.
    if (p.turnId === turnId || p.threadId === threadId || p.turn?.id === turnId) last = Date.now();
    if (m.method === 'item/completed' && p.item?.type === 'agentMessage' && p.item.text) final = p.item.text;
    else if (m.method === 'thread/tokenUsage/updated') usage = p.tokenUsage?.total;
    else if (m.method === 'turn/completed' && (p.turn?.id ?? p.turnId) === turnId) report(threadId, p.turn ?? { id: turnId, status: 'completed' }, final, usage);
  });
};

try {
  await init();
  if (cmd === 'start') {
    if (!opts.cwd || !text) die('start needs --cwd and a prompt');
    const th = await call('thread/start', {
      cwd: path.resolve(opts.cwd), model: opts.model, sandbox: opts.sandbox, approvalPolicy: APPROVAL_POLICY,
    });
    const threadId = th.thread?.id ?? th.threadId;
    if (opts.name) await call('thread/name/set', { threadId, name: opts.name }).catch(() => {});
    const ts = await call('turn/start', {
      threadId, input: textInput(text), effort: opts.effort, model: opts.model,
      sandboxPolicy: opts.network !== undefined ? sandboxPolicy(opts.sandbox) : undefined,
    });
    follow(threadId, ts.turn?.id ?? ts.turnId);
  } else if (cmd === 'turn') {
    if (!opts.thread || !text) die('turn needs --thread and a prompt');
    await call('thread/resume', { threadId: opts.thread, model: opts.model }).catch(() => {});
    const ts = await call('turn/start', {
      threadId: opts.thread, input: textInput(text), effort: opts.effort, model: opts.model,
      sandboxPolicy: opts.sandbox && sandboxPolicy(opts.sandbox), approvalPolicy: CU_APPS.length || BU_ORIGINS.length ? APPROVAL_POLICY : undefined,
    });
    follow(opts.thread, ts.turn?.id ?? ts.turnId);
  } else if (cmd === 'wait') {
    if (!opts.thread) die('wait needs --thread');
    await call('thread/resume', { threadId: opts.thread }).catch(() => {});
    const t = await currentTurn(opts.thread);
    if (!t) die('thread has no turns', 3);
    if (t.status === 'inProgress') follow(opts.thread, t.id);
    else { console.log(`thread=${opts.thread} turn=${t.id}`); await report(opts.thread, t); }
  } else if (cmd === 'steer') {
    if (!opts.thread || !text) die('steer needs --thread and a message');
    await call('thread/resume', { threadId: opts.thread }).catch(() => {});
    const t = await currentTurn(opts.thread);
    if (!t || t.status !== 'inProgress') die(`no turn in progress (last: ${t?.status ?? 'none'}); use \`turn\` to start a new one`, 3);
    const r = await call('turn/steer', { threadId: opts.thread, expectedTurnId: t.id, input: textInput(text) });
    console.log(`steered turn ${r.turnId ?? t.id}`); finish(0);
  } else if (cmd === 'interrupt') {
    if (!opts.thread) die('interrupt needs --thread');
    await call('thread/resume', { threadId: opts.thread }).catch(() => {});
    const t = await currentTurn(opts.thread);
    if (!t || t.status !== 'inProgress') die(`no turn in progress (last: ${t?.status ?? 'none'})`, 3);
    await call('turn/interrupt', { threadId: opts.thread, turnId: t.id });
    console.log(`interrupted turn ${t.id}`); finish(0);
  } else if (cmd === 'status') {
    if (!opts.thread) die('status needs --thread');
    const r = await call('thread/read', { threadId: opts.thread, includeTurns: true });
    const turns = r.thread?.turns ?? [];
    console.log(JSON.stringify({ thread: opts.thread, name: r.thread?.name, turns: turns.length, last: turns.at(-1) && { id: turns.at(-1).id, status: turns.at(-1).status, error: turns.at(-1).error } }));
    finish(0);
  } else if (cmd === 'list') {
    const r = await call('thread/list', {
      sourceKinds: ['appServer', 'exec', 'cli'], limit: Number(opts.limit ?? 20),
      cwd: typeof opts.cwd === 'string' ? path.resolve(opts.cwd) : undefined, searchTerm: typeof opts.search === 'string' ? opts.search : undefined,
    });
    for (const t of r.data ?? []) {
      const when = new Date((t.updatedAt ?? t.createdAt) * 1000).toLocaleString('sv-SE').slice(0, 16);
      console.log([t.id, when, t.status?.type ?? '-', t.source ?? '-', t.name ?? '-', t.cwd].join('\t'));
    }
    finish(0);
  } else if (cmd === 'quota') {
    const r = await call('account/rateLimits/read', {});
    console.log(JSON.stringify(r.rateLimitsByLimitId ?? { [r.rateLimits?.limitId ?? 'codex']: r.rateLimits }));
    finish(0);
  } else if (cmd === 'usage') {
    // One read of everything quota.mjs needs: the logged-in account, its windows, its reset cards.
    const r = await call('account/rateLimits/read', {});
    console.log(JSON.stringify({
      accountId: r.accountId ?? null, ordinaryUsageAllowed: r.ordinaryUsageAllowed ?? null,
      buckets: r.rateLimitsByLimitId ?? { [r.rateLimits?.limitId ?? 'codex']: r.rateLimits }, resetCredits: r.rateLimitResetCredits ?? null,
    }));
    finish(0);
  } else if (cmd === 'reset-credits') {
    // Rate-limit reset credits ("reset cards"): available count plus, when the backend lists them, each credit's
    // grant and expiry (unix seconds; expiresAt null = never). credits null = only the count is known.
    const r = await call('account/rateLimits/read', {});
    console.log(JSON.stringify(r.rateLimitResetCredits ?? null));
    finish(0);
  } else if (cmd === 'reset-credit-use') {
    // Redeems one reset credit: the eligible windows go back to 0% and their reset clock restarts now. Irreversible;
    // --key makes a retry of the same attempt safe (the backend answers alreadyRedeemed instead of spending another).
    if (typeof opts.key !== 'string') die('reset-credit-use needs --key <uuid> (reuse it when retrying the same attempt)');
    const r = await call('account/rateLimitResetCredit/consume', { idempotencyKey: opts.key, creditId: typeof opts.credit === 'string' ? opts.credit : null });
    console.log(JSON.stringify(r));
    finish(r.outcome === 'reset' || r.outcome === 'alreadyRedeemed' ? 0 : 1);
  } else die(`unknown command ${cmd}`);
} catch (e) { die(e.message, 1); }
