// Local runtime facts only. Never open login stores or Chrome profiles, run the
// configured executable, or change account setup while selecting a route.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function chromeExtensionHostConnected({ exec = execFileSync } = {}) {
  try {
    // comm contains executable paths only. Command arguments can mention the
    // host name while Chrome's native messaging process is absent.
    const executables = exec('ps', ['-axo', 'comm='], { encoding: 'utf8', timeout: 1000, maxBuffer: 1024 * 1024 });
    return executables.split('\n').some(line => /^\/.*\/extension-host\/macos\/[^/]+\/ChatGPT for Chrome$/.test(line.trim()));
  } catch { return false; }
}

function usableExecutable(command) {
  if (!command || !path.isAbsolute(command)) return false;
  try {
    if (!fs.statSync(command).isFile()) return false;
    fs.accessSync(command, fs.constants.X_OK);
    return true;
  }
  catch { return false; }
}

export function bundledCodexCliPath(app = '/Applications/ChatGPT.app') {
  const command = path.join(app, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  return usableExecutable(command) ? command : null;
}

export function chatGPTAppVersion(app = '/Applications/ChatGPT.app') {
  try { return execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(app, 'Contents/Info.plist')], { encoding: 'utf8', timeout: 1500 }).trim(); }
  catch { return ''; }
}

function managedCliRequired(app, version) {
  const parts = /^(\d+)\.(\d+)(?:\.|$)/.exec(version);
  // 26.1117 introduced the managed-execution requirement. If version metadata
  // is unavailable, the bundled executable is the local capability signal.
  return parts ? Number(parts[1]) > 26 || (Number(parts[1]) === 26 && Number(parts[2]) >= 1117) : Boolean(bundledCodexCliPath(app));
}

function tomlString(section, key) {
  const literal = new RegExp(`^\\s*${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*')\\s*(?:#.*)?$`, 'm').exec(section ?? '')?.[1];
  try { return literal?.startsWith('"') ? JSON.parse(literal) : literal?.slice(1, -1); } catch {}
}

export function probeBrowserRuntime(name, profile, { desktop = false, now = Date.now(),
  app = '/Applications/ChatGPT.app', appVersion = chatGPTAppVersion(app), hostConnected = chromeExtensionHostConnected } = {}) {
  const fail = why => ({ ready: false, why: `${name} browser runtime ${why}`, checkedAt: now });
  try { if (!fs.statSync(app).isDirectory()) return fail(`missing: ${app}`); }
  catch { return fail(`missing: ${app}`); }
  // Retain only command/enabled and the managed CLI path from this MCP server.
  // Other environment values and provider settings never enter the observation.
  let section, envSection;
  try {
    const settings = fs.readFileSync(path.join(profile.home, 'config.toml'), 'utf8');
    section = /^\s*\[mcp_servers\.node_repl\]\s*(?:#.*)?\r?\n([\s\S]*?)(?=^\s*\[|$(?![\s\S]))/m.exec(settings)?.[1];
    envSection = /^\s*\[mcp_servers\.node_repl\.env\]\s*(?:#.*)?\r?\n([\s\S]*?)(?=^\s*\[|$(?![\s\S]))/m.exec(settings)?.[1];
  } catch { return fail('configuration unavailable: node_repl command'); }
  if (!section || /^\s*enabled\s*=\s*false\b/m.test(section)) return fail('not configured: node_repl');
  const command = tomlString(section, 'command');
  if (!command || !path.isAbsolute(command) || path.basename(command) !== 'node_repl') return fail('not configured: absolute node_repl command');
  try {
    if (!fs.statSync(command).isFile()) return fail('command missing: node_repl');
    fs.accessSync(command, fs.constants.X_OK);
  } catch { return fail('command missing or not executable: node_repl'); }
  if (managedCliRequired(app, appVersion) && !usableExecutable(tomlString(envSection, 'CODEX_CLI_PATH')))
    return fail('not configured: CODEX_CLI_PATH');
  if (!desktop && !hostConnected()) return fail('unavailable: Chrome extension host is not connected');
  return { ready: true, why: `${name} browser runtime ready`, checkedAt: now };
}
