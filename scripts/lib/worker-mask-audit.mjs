import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { findMaskArtifacts } from '../find-mask-artifacts.mjs';
import { assertMaskTarget, checkedMaskPath, worktreeFor, prepareRunOutput } from './masking-scope.mjs';

const bounds = { allUntrackedText: true, maxDurationMs: 3000, maxBytes: 32 * 2 ** 20, maxFiles: 10000 };
const id = item => `${item.kind}:${item.file}`;

export function captureMaskAudit({ cwd, paths = [], taskDirectory, startedAt = Date.now(), resumed = false, limits = bounds } = {}) {
  const audit = { startedAt, taskDirectory, roots: new Map(), limits };
  for (const file of [cwd, ...paths].filter(Boolean)) {
    try {
      const tree = worktreeFor(file);
      if (!tree?.root || audit.roots.has(tree.root)) continue;
      const scan = findMaskArtifacts(tree.root, [], limits);
      // A reattached observer has no original baseline. Only older files can be
      // grandfathered; atomic masking updates ctime even when it preserves mtime.
      const baseline = resumed ? scan.findings.filter(item => {
        try { return fs.lstatSync(path.join(tree.root, item.file)).ctimeMs < startedAt; } catch { return false; }
      }) : scan.findings;
      audit.roots.set(tree.root, { signatures: new Map(baseline.map(item => [id(item), item.signature])), complete: !resumed && !scan.bounded && !scan.skipped.length });
    } catch { /* Unknown paths never grant masking permission. */ }
  }
  return audit;
}

function rewritePaths(audit) {
  if (!audit.taskDirectory) return [];
  const directory = checkedMaskPath(audit.taskDirectory);
  if (worktreeFor(directory)) return [];
  const paths = [];
  for (const name of fs.readdirSync(directory).filter(name => /^mask-rewrites-.*\.txt$/.test(name))) {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 || stat.mtimeMs < audit.startedAt) continue;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      for (const line of fs.readFileSync(fd, 'utf8').split('\n').filter(Boolean)) {
        const value = JSON.parse(line);
        if (typeof value === 'string' && path.isAbsolute(value)) paths.push(value);
      }
    } finally { fs.closeSync(fd); }
  }
  return paths;
}

export function finishMaskAudit(audit, { paths = [], note = () => {}, warn = () => {} } = {}) {
  if (!audit) return [];
  if (audit.finished) return audit.results || [];
  audit.finished = true;
  try { paths.push(...rewritePaths(audit)); } catch { warn('mask artifact audit: rewrite inventory unavailable'); }
  for (const file of paths) {
    try {
      const tree = worktreeFor(file);
      if (tree?.root && !audit.roots.has(tree.root)) audit.roots.set(tree.root, { signatures: new Map(), complete: false });
    } catch { /* No symlink traversal or unsafe-path recovery. */ }
  }
  const results = [];
  for (const [repo, prior] of audit.roots) {
    try {
      const scan = findMaskArtifacts(repo, [], audit.limits);
      const added = scan.findings.filter(item => {
        if (prior.signatures.get(id(item)) === item.signature) return false;
        if (prior.complete || prior.signatures.has(id(item))) return true;
        try { return fs.lstatSync(path.join(repo, item.file)).ctimeMs >= audit.startedAt; } catch { return false; }
      });
      if (scan.bounded || scan.skipped.length) warn(`mask artifact audit: bounded/incomplete scan for ${repo}`);
      if (!added.length) continue;
      const files = [...new Set(added.map(item => item.file))];
      let directory = audit.taskDirectory;
      if (!directory || worktreeFor(directory)) directory = prepareRunOutput(undefined, { prefix: 'mask-artifact-audit-' }).directory;
      directory = checkedMaskPath(directory); fs.mkdirSync(directory, { recursive: true });
      const report = path.join(directory, `mask-artifact-audit-${randomUUID()}.txt`);
      assertMaskTarget(report);
      fs.writeFileSync(report, files.map(file => JSON.stringify(file)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
      const prefix = `New mask markers: repo=${repo}; files=${files.length}; `, suffix = `; inventory=${report}`;
      let preview = '';
      for (const file of files) {
        const next = (preview ? preview + ', ' : '') + JSON.stringify(file);
        if (prefix.length + next.length + suffix.length > 500) break;
        preview = next;
      }
      results.push({ repo, files, report });
      try { note(prefix + preview + suffix); } catch { warn(`mask artifact audit: owner note unavailable; inventory=${report}`); }
    } catch { warn(`mask artifact audit: could not inspect ${repo}`); }
  }
  audit.results = results;
  return results;
}
