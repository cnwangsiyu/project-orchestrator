// Local runtime facts only. Never open login stores or Chrome profiles, run the
// configured executable, or change account setup while selecting a route.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function probeBrowserRuntime(name, profile, { desktop = false, now = Date.now(),
  app = '/Applications/ChatGPT.app', hostConnected = () => {
    try { execFileSync('pgrep', ['-f', 'ChatGPT for Chrome'], { stdio: 'ignore', timeout: 1500 }); return true; }
    catch { return false; }
  } } = {}) {
  const fail = why => ({ ready: false, why: `${name} browser runtime ${why}`, checkedAt: now });
  try { if (!fs.statSync(app).isDirectory()) return fail(`missing: ${app}`); }
  catch { return fail(`missing: ${app}`); }
  // Retain only the MCP server's command/enabled settings. No environment,
  // arguments, provider settings or other sections enter the observation.
  let section;
  try {
    const settings = fs.readFileSync(path.join(profile.home, 'config.toml'), 'utf8');
    section = /^\s*\[mcp_servers\.node_repl\]\s*(?:#.*)?\r?\n([\s\S]*?)(?=^\s*\[|$(?![\s\S]))/m.exec(settings)?.[1];
  } catch { return fail('configuration unavailable: node_repl command'); }
  if (!section || /^\s*enabled\s*=\s*false\b/m.test(section)) return fail('not configured: node_repl');
  const literal = /^\s*command\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/m.exec(section)?.[1];
  let command;
  try { command = literal?.startsWith('"') ? JSON.parse(literal) : literal?.slice(1, -1); } catch {}
  if (!command || !path.isAbsolute(command) || path.basename(command) !== 'node_repl') return fail('not configured: absolute node_repl command');
  try {
    if (!fs.statSync(command).isFile()) return fail('command missing: node_repl');
    fs.accessSync(command, fs.constants.X_OK);
  } catch { return fail('command missing or not executable: node_repl'); }
  if (!desktop && !hostConnected()) return fail('unavailable: Chrome extension host is not connected');
  return { ready: true, why: `${name} browser runtime ready`, checkedAt: now };
}
