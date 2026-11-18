#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withLock, writeJson } from './lib/shared-file.mjs';
import { PERSONAL_PRIORITY_FILE, personalPriorityWindow, activePersonalPriority } from './lib/pipeline/personal-priority.mjs';

const shared = process.env.RULES_SHARED || path.join(os.homedir(), '.claude/orchestrator/_shared');
const file = path.join(shared, PERSONAL_PRIORITY_FILE);
const usage = `usage: personal-priority.mjs add <from UTC> <until UTC> <standing:personal-priority-ref> <verbatim quote>
       personal-priority.mjs inspect
       personal-priority.mjs revoke <standing:personal-priority-ref>`;

function readWindow() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const window = personalPriorityWindow(raw);
  if (!window) throw Error('invalid stored window');
  return window;
}

function run([command, ...args]) {
  if (command === 'inspect' && !args.length) {
    const window = readWindow();
    return { file, active: !!activePersonalPriority(window, Date.now()), window };
  }
  if (command === 'add' && args.length === 4) {
    const [from, until, userDecisionRef, quote] = args;
    const window = personalPriorityWindow({ account: 'main', mode: 'prefer-first', from, until, userDecisionRef, quote, revoked: false });
    if (!window) throw Error('invalid window bounds, decision reference, or quote');
    return withLock(file, () => {
      const now = Date.now();
      if (Date.parse(window.until) <= now) throw Error('window expiry is in the past');
      const existing = readWindow();
      if (JSON.stringify(existing) === JSON.stringify(window)) return window;
      if (existing && !existing.revoked && Date.parse(existing.until) > now) throw Error('revoke the existing window before replacing it');
      writeJson(file, window, 2);
      return window;
    });
  }
  if (command === 'revoke' && args.length === 1) return withLock(file, () => {
    const window = readWindow();
    if (window?.userDecisionRef !== args[0]) throw Error('no window with that decision reference');
    if (!window.revoked) writeJson(file, { ...window, revoked: true }, 2);
    return { ...window, revoked: true };
  });
  throw Error(usage);
}

try {
  const args = process.argv.slice(2);
  console.log(args.length === 1 && args[0] === '--help' ? usage : JSON.stringify(run(args), null, 2));
} catch (error) {
  console.error(`personal-priority: ${error.message}`);
  process.exitCode = 2;
}
