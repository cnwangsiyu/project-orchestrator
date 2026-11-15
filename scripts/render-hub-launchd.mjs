#!/usr/bin/env node
// Render templates only. Never copy to LaunchAgents or call launchctl.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SKILL_ROOT } from './lib/global-rules.mjs';

const argv = process.argv.slice(2), opts = {};
for (let i = 0; i < argv.length; i += 2) {
  if (!['--out', '--node', '--skill', '--home', '--accounts'].includes(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--'))
    throw Error('expected --out/--node/--skill/--home/--accounts with a value');
  opts[argv[i].slice(2)] = argv[i + 1];
}
if (!opts.out) throw Error('usage: render-hub-launchd.mjs --out <template-directory> [--node <absolute binary>] [--skill <installed skill>] [--home <home>] [--accounts a,b]');
const out = path.resolve(opts.out), home = path.resolve(opts.home ?? os.homedir());
if (out === path.join(home, 'Library/LaunchAgents') || out.startsWith(`${path.join(home, 'Library/LaunchAgents')}/`))
  throw Error('render to a staging directory, never install automatically');
const node = opts.node ?? process.execPath;
if (!path.isAbsolute(node)) throw Error('--node must be an absolute binary path; omit it to use process.execPath');
const skill = path.resolve(opts.skill ?? SKILL_ROOT);
let accounts;
if (opts.accounts !== undefined) accounts = opts.accounts.split(',').map((name) => name.trim());
else {
  const registry = process.env.CODEX_ACCOUNTS ?? path.join(home, '.claude/orchestrator/_shared/codex-accounts.json');
  try {
    const registered = JSON.parse(fs.readFileSync(registry, 'utf8'));
    if (!registered || typeof registered !== 'object' || Array.isArray(registered)) throw Error('invalid account registry');
    accounts = Object.keys(registered);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    accounts = ['ttadk', 'trae', 'main', 'b'];
  }
}
if (accounts.some((name) => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(name))) throw Error('invalid account name');
const escape = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
fs.mkdirSync(out, { recursive: true });
for (const account of new Set(accounts)) {
  const name = `dev.project-orchestrator.hub.${account}.plist`;
  const template = path.join(SKILL_ROOT, 'templates/launchd', `${name}.in`);
  let text;
  try { text = fs.readFileSync(template, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    text = fs.readFileSync(path.join(SKILL_ROOT, 'templates/launchd/dev.project-orchestrator.hub.main.plist.in'), 'utf8')
      .replaceAll('hub.main', `hub.${account}`).replaceAll('<string>main</string>', `<string>${account}</string>`)
      .replaceAll('/main.', `/${account}.`);
  }
  for (const [key, value] of Object.entries({ NODE: node, NODE_DIR: path.dirname(node), SKILL: skill, HOME: home }))
    text = text.replaceAll(`__${key}__`, escape(value));
  if (/__[A-Z_]+__/.test(text)) throw Error(`unresolved template variable: ${name}`);
  fs.writeFileSync(path.join(out, name), text);
  console.log(path.join(out, name));
}
