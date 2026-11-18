#!/usr/bin/env node
// Inspect source locally. Only path/key/count metadata can leave this process.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { passwordStyleFindings } from './nightly-audit.mjs';

const credentialKey = key => !/(?:^|\.)keyAlias$/i.test(key) && /ACCESS|SECRET|SCRECT|KEY|TOKEN|PASS|PWD|AUTH|CREDENTIAL|NEXUS|MAGIC|PRIVATE/i.test(key);
const configPath = file => /(?:^|\/)\.env[^/]*$|\.(?:properties|gradle(?:\.kts)?|ya?ml|toml|ini|cfg|conf|json|plist|xcconfig|groovy|kt|kts)$/i.test(file);
const privateBlock = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g;
const accessKey = /\bAKIA[A-Z0-9]{16}\b/g;
const quoted = String.raw`"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'`;
const reference = value => /(?<!\\)\$(?:[A-Za-z_]\w*|\{[^}]*\})/.test(value)
  || /^(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*\s*\(/.test(value);
const publicValue = value => /^(?:true|false|null|none|nil)$/i.test(value)
  || /^(?:[a-z][a-z\d+.-]*:\/\/|\/\/)/i.test(value);

export function transferFindings(text, { dsl = false, plist = false } = {}) {
  const hits = new Map(), excluded = new Set();
  const lineAt = offset => text.slice(0, offset).split('\n').length;
  const add = (key, offset) => {
    if (/(?:^|\.)keyAlias$/i.test(key)) return;
    const id = `${key.toLowerCase()}:${offset}`;
    if (!hits.has(id)) hits.set(id, { key, offset });
  };
  const literal = (key, raw, offset, expression = false) => {
    if (!credentialKey(key)) return;
    const isQuoted = /^["']/.test(raw);
    const width = raw.startsWith('"""') || raw.startsWith("'''") ? 3 : 1;
    let value = (isQuoted ? raw.slice(width, -width) : raw).trim();
    if (raw.startsWith('"')) { try { value = JSON.parse(raw).trim(); } catch { /* DSL strings need not be valid JSON. */ } }
    if (!isQuoted && /^[{\[]/.test(value)) return;
    if (!value || reference(value) || publicValue(value)) { excluded.add(`${key.toLowerCase()}:${lineAt(offset)}`); return; }
    if (expression && !isQuoted && /^[A-Za-z_$][\w$]*(?:\.[\w$]+)*$/.test(value)) { excluded.add(`${key.toLowerCase()}:${lineAt(offset)}`); return; }
    add(key, offset);
  };
  // Reuse the audit detector's string/DSL handling; extend its key vocabulary
  // and strict literal handling for transfer admission rather than log prose.
  const assignments = new RegExp(String.raw`(["']?)([A-Za-z_$][\w$.-]*)\1[\t ]*\]?[\t ]*(?:\:[\t ]*[A-Za-z_][\w?.<>\[\]]*[\t ]*)?(?:=|:(?!:))[\t ]*(${quoted}|\$\{[^}]*\}|[^\s,;\}\]\r\n]+)`, 'g');
  for (const match of text.matchAll(assignments)) {
    if (dsl && /^["']/.test(match[3]) && /^\s*[+.([]/.test(text.slice(match.index + match[0].length))) { excluded.add(`${match[2].toLowerCase()}:${lineAt(match.index)}`); continue; }
    literal(match[2], match[3], match.index, dsl);
  }
  if (dsl) {
    const calls = new RegExp(String.raw`([A-Za-z_$][\w$.-]*)\s*(?:\.set\s*\(\s*|\(\s*|\s+)(${quoted})`, 'g');
    for (const match of text.matchAll(calls)) literal(match[1].replace(/\.set$/, ''), match[2], match.index, true);
    const pairs = new RegExp(String.raw`["']([A-Za-z_$][\w$.-]*)["'][\t ]+to[\t ]+(${quoted}|\$\{[^}]*\}|[^\s,;\}\]\r\n]+)`, 'g');
    for (const match of text.matchAll(pairs)) literal(match[1], match[2], match.index, true);
  }
  if (plist) {
    const entries = /<key>\s*([^<]+)\s*<\/key>\s*<(string|data|integer|real|date)>([\s\S]*?)<\/\2>/g;
    for (const match of text.matchAll(entries)) literal(match[1].trim(), JSON.stringify(match[3]), match.index);
  }
  try {
    const parsed = JSON.parse(text), pending = [parsed];
    while (pending.length) {
      const item = pending.pop();
      if (!item || typeof item !== 'object') continue;
      for (const [key, value] of Object.entries(item)) {
        if (value && typeof value === 'object') {
          pending.push(value);
          if (Array.isArray(value)) for (const member of value) if (typeof member === 'string') literal(key, JSON.stringify(member), Math.max(0, text.indexOf(JSON.stringify(key))));
        }
        else if (value !== null) literal(key, typeof value === 'string' ? JSON.stringify(value) : String(value), Math.max(0, text.indexOf(JSON.stringify(key))));
      }
    }
  } catch { /* Other configuration formats use the text matchers above. */ }
  for (const finding of passwordStyleFindings(text)) {
    if (!credentialKey(finding.field) || excluded.has(`${finding.field}:${finding.line}`)) continue;
    const offset = text.split('\n').slice(0, finding.line - 1).join('\n').length + (finding.line > 1 ? 1 : 0);
    add(finding.field, offset);
  }
  for (const match of text.matchAll(privateBlock)) add('PRIVATE_KEY_BLOCK', match.index);
  for (const match of text.matchAll(accessKey)) add('AKIA_ACCESS_KEY', match.index);
  const counts = new Map();
  // Audit and transfer matchers can identify the same field on the same line.
  const seen = new Set();
  for (const hit of hits.values()) {
    const line = lineAt(hit.offset);
    const id = `${hit.key.toLowerCase()}:${line}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const key = [...counts.keys()].find(key => key.toLowerCase() === hit.key.toLowerCase()) || hit.key;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts].map(([key, count]) => ({ key, count }));
}

function allowEntries() {
  const doc = fs.readFileSync(fileURLToPath(new URL('../../references/devbox-run.md', import.meta.url)), 'utf8');
  const section = /<!-- devbox-nonsecret-allow -->\s*```json\s*([\s\S]*?)```\s*<!-- \/devbox-nonsecret-allow -->/.exec(doc);
  if (!section) return [];
  const entries = JSON.parse(section[1]);
  if (!Array.isArray(entries) || entries.some(entry => !/^id-[a-f0-9]{64}$/.test(entry.repoId || '') || !entry.path || !entry.key || !entry.reason?.trim())) throw Error('invalid nonsecret allow entries');
  return entries;
}

export function checkTransfer(repo, commit, mode, repoId) {
  const git = args => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  const allow = allowEntries(), seen = new Set(), findings = [];
  const check = (bytes, file, identity) => {
    if (!configPath(file) || seen.has(file + ':' + identity)) return;
    seen.add(file + ':' + identity);
    let text = bytes.toString('utf8');
    if (/\.plist$/i.test(file) && bytes.subarray(0, 6).toString() === 'bplist') {
      // plistlib parses binary plists without printing their contents to a log.
      const xml = execFileSync('python3', ['-c', 'import plistlib,sys;sys.stdout.buffer.write(plistlib.dumps(plistlib.loads(sys.stdin.buffer.read()),fmt=plistlib.FMT_XML))'],
        { input: bytes, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'] });
      text = xml.toString('utf8');
    }
    const hits = transferFindings(text, { dsl: /\.(?:gradle(?:\.kts)?|groovy|kt|kts)$/i.test(file), plist: /\.plist$/i.test(file) });
    if (text !== bytes.toString('utf8')) {
      for (const marker of transferFindings(bytes.toString('utf8')).filter(hit => ['PRIVATE_KEY_BLOCK', 'AKIA_ACCESS_KEY'].includes(hit.key))) {
        const existing = hits.find(hit => hit.key === marker.key);
        if (existing) existing.count = Math.max(existing.count, marker.count);
        else hits.push(marker);
      }
    }
    for (const hit of hits) {
      if (!allow.some(entry => entry.repoId === repoId && entry.path === file && entry.key.toLowerCase() === hit.key.toLowerCase())) findings.push({ path: file, ...hit });
    }
  };
  const blob = (oid, file, type) => {
    if (!configPath(file)) return;
    if (type === '120000') { findings.push({ path: file, key: 'SYMLINK_CONFIG', count: 1 }); return; }
    if (!seen.has(file + ':' + oid)) check(git(['cat-file', 'blob', oid]), file, oid);
  };
  const tree = git(['ls-tree', '-rz', commit]).toString('utf8').split('\0').filter(Boolean);
  for (const entry of tree) {
    const tab = entry.indexOf('\t'), [type, kind, oid] = entry.slice(0, tab).split(' ');
    if (kind === 'blob') blob(oid, entry.slice(tab + 1), type);
  }
  const patterns = ['**/*.properties', '**/.env*', '**/*.gradle', '**/*.gradle.kts', '**/*.yml', '**/*.yaml', '**/*.toml', '**/*.ini', '**/*.cfg', '**/*.conf', '**/*.json', '**/*.plist', '**/*.xcconfig', '**/*.groovy', '**/*.kt', '**/*.kts'].map(pattern => ':(glob,icase)' + pattern);
  const changes = args => {
    const records = git(args).toString('utf8').split('\0');
    for (let i = 0; i < records.length - 1; i += 2) {
      const [, type, , oid] = records[i].trim().split(/\s+/);
      if (/^(100|120000)/.test(type || '')) blob(oid, records[i + 1], type);
    }
  };
  changes(['log', '--full-history', '-m', '--root', '--format=', '--raw', '-z', '--no-renames', '--no-abbrev', commit, '--', ...patterns]);
  if (mode === 'worktree') {
    changes(['diff', '--cached', '--raw', '-z', '--no-renames', '--no-abbrev', 'HEAD']);
    const changed = git(['diff', '--name-only', '--no-renames', '-z', 'HEAD']).toString('utf8').split('\0');
    const extra = git(['ls-files', '--others', '--exclude-standard', '-z']).toString('utf8').split('\0');
    for (const file of new Set([...changed, ...extra].filter(Boolean))) {
      if (!configPath(file)) continue;
      const location = path.join(repo, file);
      let stat;
      try { stat = fs.lstatSync(location); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (stat.isSymbolicLink()) { findings.push({ path: file, key: 'SYMLINK_CONFIG', count: 1 }); continue; }
      if (stat.isFile()) {
        if (fs.realpathSync(location) !== location) { findings.push({ path: file, key: 'SYMLINK_CONFIG', count: 1 }); continue; }
        check(fs.readFileSync(location), file, 'worktree');
      }
    }
  }
  return findings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const findings = checkTransfer(...process.argv.slice(2));
    if (findings.length) { console.log(JSON.stringify(findings)); process.exitCode = 1; }
  } catch {
    console.log(JSON.stringify([{ path: '[source scan]', key: 'SCAN_UNAVAILABLE', count: 1 }]));
    process.exitCode = 1;
  }
}
