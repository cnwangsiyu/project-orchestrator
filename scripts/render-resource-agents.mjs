#!/usr/bin/env node
// Render only; no launchctl, mode elevation, overwrite or installation side effects.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--directory') throw Error('usage: node render-resource-agents.mjs --directory <new output directory>');
const directory = path.resolve(args[1]), skill = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
fs.mkdirSync(directory, { recursive: true });
for (const name of ['com.user.resource-sample', 'com.user.resource-cleanup']) {
  const template = fs.readFileSync(path.join(skill, 'references', `${name}.plist.template`), 'utf8');
  const values = { HOME: os.homedir(), SKILL: skill, NODE: process.execPath, PATH: `${path.dirname(process.execPath)}:${os.homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` };
  const rendered = template.replace(/\{\{(\w+)\}\}/g, (_, k) => { if (!values[k]) throw Error('unknown placeholder'); return xml(values[k]); });
  const target = path.join(directory, `${name}.plist`);
  fs.writeFileSync(target, rendered, { flag: 'wx', mode: 0o600 });
  console.log(target);
}
