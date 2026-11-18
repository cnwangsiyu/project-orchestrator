import fs from 'node:fs';
import path from 'node:path';

// realpath also needs to work for a new output file or a not-yet-created task
// directory. Resolve the nearest existing ancestor, then append the missing tail.
export function canonicalPath(value, cwd = process.cwd()) {
  // Keep dot segments until realpath: a symlink followed by /.. belongs to the
  // target's parent, which can differ from the link's lexical parent.
  let parent = path.isAbsolute(value) ? value : `${cwd}${path.sep}${value}`;
  const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(parent), ...tail); }
    catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(parent) === parent) throw error;
      tail.unshift(path.basename(parent));
      parent = path.dirname(parent);
    }
  }
}

const optionKeys = ['cwd', 'task-dir', 'out', 'log', 'brief', 'trusted-cwd'];
export function canonicalPathOptions(opts) {
  for (const key of optionKeys) if (typeof opts[key] === 'string') opts[key] = canonicalPath(opts[key]);
  return opts;
}

// This is the router's generated prompt contract; arbitrary prose stays intact.
export const canonicalBriefPrompt = (prompt, cwd = process.cwd()) => prompt.replace(/\bRead ([^\n]*?brief\.md) and follow it\./g,
  (_, brief) => `Read ${canonicalPath(brief, cwd)} and follow it.`);

const pathFlags = new Set(['--cwd', '--task-dir', '--out', '--log', '--brief', '-C', '--cd', '-o', '--output-last-message']);
export function canonicalLaunchArgv(args, cwd = process.cwd()) {
  const next = [...args];
  let promptCwd = cwd;
  for (let i = 0; i < next.length; i++) {
    const equal = next[i].indexOf('='), key = equal < 0 ? next[i] : next[i].slice(0, equal);
    if (pathFlags.has(key)) {
      let resolved;
      if (equal >= 0) { resolved = canonicalPath(next[i].slice(equal + 1), cwd); next[i] = `${key}=${resolved}`; }
      else if (typeof next[i + 1] === 'string') { i++; resolved = canonicalPath(next[i], cwd); next[i] = resolved; }
      if (resolved && ['--cwd', '-C', '--cd'].includes(key)) promptCwd = resolved;
    }
  }
  return next.map(arg => canonicalBriefPrompt(arg, promptCwd));
}

export function taskLaunchPaths(taskDir, role) {
  const suffix = role === 'primary' ? '' : `-${role}`;
  return { brief: canonicalPath(path.join(taskDir, 'brief.md')),
    out: canonicalPath(path.join(taskDir, `codex${suffix}-last.md`)),
    log: canonicalPath(path.join(taskDir, `codex${suffix}.jsonl`)) };
}
