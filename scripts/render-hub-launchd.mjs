#!/usr/bin/env node
// Render templates only. Never copy to LaunchAgents or call launchctl.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SKILL_ROOT } from './lib/global-rules.mjs';

const argv = process.argv.slice(2), opts = {};
for (let i = 0; i < argv.length; i += 2) opts[argv[i].replace(/^--/, '')] = argv[i + 1];
if (!opts.out) throw Error('usage: render-hub-launchd.mjs --out <template-directory> [--node <absolute binary>] [--skill <installed skill>] [--home <home>]');
const out = path.resolve(opts.out), home = path.resolve(opts.home ?? os.homedir());
if (out === path.join(home, 'Library/LaunchAgents') || out.startsWith(`${path.join(home, 'Library/LaunchAgents')}/`))
  throw Error('render to a staging directory, never install automatically');
const node = path.resolve(opts.node ?? process.execPath), skill = path.resolve(opts.skill ?? SKILL_ROOT);
const escape = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
fs.mkdirSync(out, { recursive: true });
for (const account of ['ttadk', 'trae', 'main', 'b']) {
  const name = `dev.project-orchestrator.hub.${account}.plist`;
  let text = fs.readFileSync(path.join(SKILL_ROOT, 'templates/launchd', `${name}.in`), 'utf8');
  for (const [key, value] of Object.entries({ NODE: node, NODE_DIR: path.dirname(node), SKILL: skill, HOME: home }))
    text = text.replaceAll(`__${key}__`, escape(value));
  if (/__[A-Z_]+__/.test(text)) throw Error(`unresolved template variable: ${name}`);
  fs.writeFileSync(path.join(out, name), text);
  console.log(path.join(out, name));
}
