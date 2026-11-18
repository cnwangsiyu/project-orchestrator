#!/usr/bin/env node
// MCP launcher for the Playwright Extension bridge (TRAE browser threads).
// The hub spawns this as the `playwright` MCP server. It reads the user-pasted pairing token from its file and hands it
// to @playwright/mcp through the child's environment only, so the token is never in the hub's environment (which every
// worker shell inherits), on argv, in config or in any output. Arguments are passed through to @playwright/mcp.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const file = process.env.PLAYWRIGHT_EXTENSION_TOKEN_FILE || path.join(os.homedir(), '.trae', 'playwright-extension-token');
let token = '';
try { token = fs.readFileSync(file, 'utf8').trim(); } catch {}
if (!token) { process.stderr.write(`playwright-extension-mcp: pairing token file missing or empty: ${file}\n`); process.exit(1); }
// Resolve the installed cache without a registry metadata request on every
// thread. A registry outage otherwise leaves the hub at "starting" indefinitely.
const child = spawn('npx', ['--offline', '-y', '@playwright/mcp@latest', '--extension', ...process.argv.slice(2)],
  { stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_MCP_EXTENSION_TOKEN: token } });
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => { process.stderr.write(`playwright-extension-mcp: ${error.message}\n`); process.exit(1); });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
