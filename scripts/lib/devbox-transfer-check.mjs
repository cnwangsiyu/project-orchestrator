#!/usr/bin/env node
// Inspect source locally. Only path/key/count metadata can leave this process.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { passwordStyleFindings } from './nightly-audit.mjs';

const scannerVersion = '2026-11-17.2';

const credentialKey = key => !/(?:^|\.)keyAlias$/i.test(key) && /ACCESS|SECRET|SCRECT|KEY|TOKEN|PASS|PWD|AUTH|CREDENTIAL|NEXUS|MAGIC|PRIVATE/i.test(key);
const lockfilePath = file => /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.ya?ml|Podfile\.lock|Gemfile\.lock|Cargo\.lock|poetry\.lock|gradle\.lockfile|Package\.resolved)$/i.test(file);
const configPath = file => lockfilePath(file) || /(?:^|\/)\.env[^/]*$|\.(?:properties|gradle(?:\.kts)?|ya?ml|toml|ini|cfg|conf|json|plist|xcconfig|groovy|kt|kts)$/i.test(file);
const privateBlock = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g;
const accessKey = /\bAKIA[A-Z0-9]{16}\b/g;
const jwt = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const embeddedUrlCredential = /\b[a-z][a-z\d+.-]*:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/gi;
const quoted = String.raw`"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'`;
const reference = value => /(?<!\\)\$(?:[A-Za-z_]\w*|\{[^}]*\})/.test(value)
  || /^(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*\s*\(/.test(value);
const publicValue = value => /^(?:true|false|null|none|nil)$/i.test(value)
  || /^(?:[a-z][a-z\d+.-]*:\/\/|\/\/)/i.test(value);

export function transferFindings(text, { dsl = false, plist = false, lockfile = false } = {}) {
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
  let parsed, json = false;
  try {
    parsed = JSON.parse(text); json = true;
  } catch { /* Other configuration formats use the text matchers below. */ }
  if (!lockfile && !json) {
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
  }
  if (!lockfile && json) {
    const packageMaps = new Set(['dependencies', 'devdependencies', 'peerdependencies', 'optionaldependencies', 'bundleddependencies']);
    const pending = [{ item: parsed, parent: '', dependency: false }];
    while (pending.length) {
      const { item, parent, dependency } = pending.pop();
      if (!item || typeof item !== 'object') continue;
      if (Array.isArray(item)) { for (const value of item) if (value && typeof value === 'object') pending.push({ item: value, parent, dependency }); continue; }
      for (const [key, value] of Object.entries(item)) {
        const packageEntry = packageMaps.has(parent.toLowerCase()) || key.split('/').includes('node_modules');
        if (value && typeof value === 'object') pending.push({ item: value, parent: key, dependency: dependency || packageEntry });
        else if (typeof value === 'string' && !dependency && !packageEntry)
          literal(key, JSON.stringify(value), Math.max(0, text.indexOf(JSON.stringify(key))));
      }
    }
  }
  if (!lockfile && !json) for (const finding of passwordStyleFindings(text)) {
      if (!credentialKey(finding.field) || excluded.has(`${finding.field}:${finding.line}`)) continue;
      const offset = text.split('\n').slice(0, finding.line - 1).join('\n').length + (finding.line > 1 ? 1 : 0);
      add(finding.field, offset);
    }
  const authLine = /(?:^|[\r\n])[^\r\n]*?(_authToken|_auth)["']?[\t ]*(?:=|:)[\t ]*([^,}\r\n#;]+)/gi;
  for (const match of text.matchAll(authLine)) literal(match[1], match[2].trim(), match.index);
  for (const match of text.matchAll(privateBlock)) add('PRIVATE_KEY_BLOCK', match.index);
  for (const match of text.matchAll(accessKey)) add('AKIA_ACCESS_KEY', match.index);
  for (const match of text.matchAll(jwt)) add('JWT', match.index);
  for (const match of text.matchAll(embeddedUrlCredential)) add('EMBEDDED_URL_CREDENTIAL', match.index);
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

function cacheFile(cacheRoot, repoId) {
  if (!cacheRoot) return null;
  if (!/^id-[a-f0-9]{64}$/.test(repoId || '')) throw Error('invalid repository scan identity');
  return path.join(cacheRoot, 'scan-cache', scannerVersion, `${repoId}.oids`);
}

function readCleanOids(file) {
  if (!file) return new Set();
  try { return new Set(fs.readFileSync(file, 'utf8').split('\n').filter(oid => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid))); }
  catch (error) { if (error.code === 'ENOENT') return new Set(); throw error; }
}

function appendCleanOids(file, oids) {
  if (!file || !oids.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${oids.join('\n')}\n`, { mode: 0o600 });
}

let activeBatch;
async function readBatch(repo, oids, consume) {
  if (!oids.length) return;
  await new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repo, 'cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'ignore'] });
    activeBatch = child;
    let pending = Buffer.alloc(0), current, index = 0, failure;
    const fail = error => {
      failure ||= error;
      child.kill('SIGTERM');
    };
    const parse = () => {
      try {
        while (true) {
          if (!current) {
            const newline = pending.indexOf(10);
            if (newline === -1) return;
            const header = pending.subarray(0, newline).toString('ascii');
            pending = pending.subarray(newline + 1);
            const match = /^([a-f0-9]+) (\S+) (\d+)$/.exec(header);
            if (!match || match[1] !== oids[index] || match[2] !== 'blob') throw Error('invalid git cat-file batch response');
            current = { oid: match[1], size: Number(match[3]) };
            if (!Number.isSafeInteger(current.size) || current.size < 0) throw Error('invalid git blob size');
          }
          if (pending.length < current.size + 1) return;
          if (pending[current.size] !== 10) throw Error('invalid git cat-file batch framing');
          consume(current.oid, pending.subarray(0, current.size));
          pending = pending.subarray(current.size + 1);
          current = null; index++;
        }
      } catch (error) { fail(error); }
    };
    child.stdout.on('data', chunk => { pending = pending.length ? Buffer.concat([pending, chunk]) : chunk; parse(); });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') fail(error); });
    child.on('error', fail);
    child.on('close', code => {
      if (activeBatch === child) activeBatch = undefined;
      if (!failure && (code || current || pending.length || index !== oids.length)) failure = Error('git cat-file batch did not return every blob');
      if (failure) reject(failure); else resolve();
    });
    child.stdin.end(`${oids.join('\n')}\n`);
  });
}

function decodedContent(bytes) {
  const rawText = bytes.toString('utf8');
  let text = rawText;
  if (bytes.subarray(0, 6).toString() === 'bplist') {
    // plistlib parses binary plists without printing their contents to a log.
    text = execFileSync('python3', ['-c', 'import plistlib,sys;sys.stdout.buffer.write(plistlib.dumps(plistlib.loads(sys.stdin.buffer.read()),fmt=plistlib.FMT_XML))'],
      { input: bytes, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'] }).toString('utf8');
  }
  let generatedLockfile = /(?:^|\n)# (?:This file is automatically @generated by (?:Cargo|Poetry)|yarn lockfile v\d)|(?:^|\n)lockfileVersion\s*:/i.test(text)
    || /(?:^|\n)(?:PODS\s*:|GEM\s*(?:\n|$))/.test(text);
  if (!generatedLockfile) try {
    const value = JSON.parse(text);
    generatedLockfile = Boolean(value && typeof value === 'object'
      && (Object.hasOwn(value, 'lockfileVersion') || (Array.isArray(value.pins) && Object.hasOwn(value, 'version'))));
  } catch { /* Non-JSON lockfiles use their generated headers. */ }
  return { rawText, text, generatedLockfile };
}

function contentFindings(content, { dsl = false, plist = false, lockfile = false } = {}) {
  const hits = transferFindings(content.text, { dsl, plist, lockfile });
  if (content.text !== content.rawText) {
    for (const marker of transferFindings(content.rawText, { lockfile: true })) {
      const existing = hits.find(hit => hit.key === marker.key);
      if (existing) existing.count = Math.max(existing.count, marker.count);
      else hits.push(marker);
    }
  }
  return hits;
}

export async function checkTransfer(repo, commit, mode, repoId, { scope = 'all', bases = [], cacheRoot, onProgress } = {}) {
  if (!['snapshot', 'history', 'all'].includes(scope)) throw Error('invalid scan scope');
  if (bases.some(oid => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid))) throw Error('invalid scan base');
  const git = args => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  const allow = allowEntries(), seen = new Set(), findings = [], cleanFile = cacheFile(cacheRoot, repoId), clean = readCleanOids(cleanFile);
  const progress = { phase: 'start', blobsDiscovered: 0, blobsProcessed: 0, cacheHits: 0 };
  const report = phase => { progress.phase = phase; onProgress?.({ ...progress }); };
  const addHits = (hits, file) => {
    for (const hit of hits) {
      if (!allow.some(entry => entry.repoId === repoId && entry.path === file && entry.key.toLowerCase() === hit.key.toLowerCase())) findings.push({ path: file, ...hit });
    }
  };
  const entries = [];
  const blob = (oid, file, type) => {
    if (!configPath(file)) return;
    if (type === '120000') { findings.push({ path: file, key: 'SYMLINK_CONFIG', count: 1 }); return; }
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid) || seen.has(file + ':' + oid)) return;
    seen.add(file + ':' + oid); entries.push({ oid, file });
  };
  const patterns = ['**/*.properties', '**/.env*', '**/*.gradle', '**/*.gradle.kts', '**/*.yml', '**/*.yaml', '**/*.toml', '**/*.ini', '**/*.cfg', '**/*.conf', '**/*.json', '**/*.plist', '**/*.xcconfig', '**/*.groovy', '**/*.kt', '**/*.kts',
    '**/yarn.lock', '**/Podfile.lock', '**/Gemfile.lock', '**/Cargo.lock', '**/poetry.lock', '**/gradle.lockfile', '**/Package.resolved'].map(pattern => ':(glob,icase)' + pattern);
  const changes = (args, phase) => {
    report(phase);
    const records = git(args).toString('utf8').split('\0');
    for (let i = 0; i < records.length - 1; i += 2) {
      const [, type, , oid] = records[i].trim().split(/\s+/);
      if (/^(100|120000)/.test(type || '')) blob(oid, records[i + 1], type);
    }
  };
  if (scope !== 'history') {
    report('tree-list');
    const tree = git(['ls-tree', '-rz', commit]).toString('utf8').split('\0').filter(Boolean);
    for (const entry of tree) {
      const tab = entry.indexOf('\t'), [type, kind, oid] = entry.slice(0, tab).split(' ');
      if (kind === 'blob') blob(oid, entry.slice(tab + 1), type);
    }
    if (mode === 'worktree') changes(['diff', '--cached', '--raw', '-z', '--no-renames', '--no-abbrev', 'HEAD'], 'staged-list');
  }
  if (scope !== 'snapshot') {
    changes(['log', '--full-history', '-m', '--root', '--format=', '--raw', '-z', '--no-renames', '--no-abbrev', commit,
      ...bases.map(oid => '^' + oid), '--', ...patterns], 'history-list');
  }
  const byOid = new Map();
  for (const entry of entries) {
    if (!byOid.has(entry.oid)) byOid.set(entry.oid, []);
    byOid.get(entry.oid).push(entry.file);
  }
  const unread = [];
  for (const oid of byOid.keys()) {
    if (clean.has(oid)) progress.cacheHits++;
    else unread.push(oid);
  }
  progress.blobsDiscovered = byOid.size;
  report(scope === 'history' ? 'history-blobs' : 'snapshot-blobs');
  const newlyClean = [];
  await readBatch(repo, unread, (oid, bytes) => {
    const content = decodedContent(bytes), files = byOid.get(oid);
    for (const file of files) addHits(contentFindings(content, {
      dsl: /\.(?:gradle(?:\.kts)?|groovy|kt|kts)$/i.test(file), plist: /\.plist$/i.test(file),
      lockfile: content.generatedLockfile || lockfilePath(file),
    }), file);
    // Cache only when every supported interpretation is clean. The finding
    // reported for this run remains path-specific, preserving existing DSL
    // reference handling while keeping the OID verdict path-independent.
    const cacheable = (content.generatedLockfile
      ? [contentFindings(content, { lockfile: true })]
      : [contentFindings(content), contentFindings(content, { dsl: true }), contentFindings(content, { plist: true })])
      .every(hits => !hits.length);
    if (cacheable) { clean.add(oid); newlyClean.push(oid); }
    progress.blobsProcessed++;
    if (progress.blobsProcessed % 1000 === 0) report(progress.phase);
  });
  appendCleanOids(cleanFile, newlyClean);
  if (scope !== 'history' && mode === 'worktree') {
    report('worktree-files');
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
        const content = decodedContent(fs.readFileSync(location));
        addHits(contentFindings(content, { dsl: /\.(?:gradle(?:\.kts)?|groovy|kt|kts)$/i.test(file), plist: /\.plist$/i.test(file),
          lockfile: content.generatedLockfile || lockfilePath(file) }), file);
      }
    }
  }
  report('complete');
  return findings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let lastProgress = { phase: 'startup', blobsDiscovered: 0, blobsProcessed: 0, cacheHits: 0 };
  const printProgress = () => process.stderr.write(`scanProgress phase=${lastProgress.phase} blobsDiscovered=${lastProgress.blobsDiscovered} blobsProcessed=${lastProgress.blobsProcessed} cacheHits=${lastProgress.cacheHits}\n`);
  process.on('SIGTERM', () => { activeBatch?.kill('SIGTERM'); printProgress(); process.exit(143); });
  try {
    const args = process.argv.slice(2), options = { bases: [] };
    const value = name => { const index = args.indexOf(name); if (index === -1 || !args[index + 1]) throw Error(`missing ${name}`); return args[index + 1]; };
    const repo = value('--repo'), commit = value('--commit'), mode = value('--mode'), repoId = value('--repo-id');
    options.scope = value('--scope'); options.cacheRoot = value('--cache-dir');
    for (let i = 0; i < args.length; i++) if (args[i] === '--base') options.bases.push(args[++i]);
    options.onProgress = progress => {
      lastProgress = progress;
      if (progress.phase !== 'snapshot-blobs' && progress.phase !== 'history-blobs' || progress.blobsProcessed % 1000 === 0) printProgress();
    };
    const findings = await checkTransfer(repo, commit, mode, repoId, options);
    if (findings.length) { console.log(JSON.stringify(findings)); process.exitCode = 1; }
  } catch {
    printProgress();
    console.log(JSON.stringify([{ path: '[source scan]', key: 'SCAN_UNAVAILABLE', count: 1 }]));
    process.exitCode = 1;
  }
}
