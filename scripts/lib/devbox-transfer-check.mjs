#!/usr/bin/env node
// Inspect source locally. Only path/key/count metadata can leave this process.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { passwordStyleFindings } from './nightly-audit.mjs';

const scannerVersion = '2026-11-18.1';

const normalizedKey = key => key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
const strongKeys = new Set(['password', 'passwd', 'secret', 'token', 'apikey', 'accesskey', 'secretkey', 'screctkey', 'privatekey', 'clientsecret', 'auth', 'authtoken', 'authorization', 'bearer', 'storepassword', 'keypassword']);
const strongCredentialKey = key => {
  const normalized = normalizedKey(key);
  return strongKeys.has(normalized) || /^nexus(?:[._-]|$)/i.test(key) || normalized.includes('magicword');
};
const credentialKey = key => {
  if (/(?:^|\.)keyAlias$/i.test(key) || /(?:^|[._-])author(?:$|[._-])/i.test(key)) return false;
  if (strongCredentialKey(key)) return true;
  // Weak names count only as complete separator-delimited tokens. In
  // particular, camelCase source identifiers such as passStart and author do
  // not become credential fields merely because they contain PASS or AUTH.
  const tokens = key.split(/[._-]+/).map(token => token.toLowerCase()).filter(Boolean);
  // A bare/generic `key` field commonly identifies map entries, content
  // hashes, and object-storage paths. Credential compounds such as api_key,
  // access_key, secret_key, and private_key are already exact strong names.
  return tokens.some(token => ['access', 'secret', 'screct', 'token', 'pass', 'pwd', 'auth', 'credential', 'private', 'nexus', 'magic'].includes(token));
};
const lockfilePath = file => /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.ya?ml|Podfile\.lock|Gemfile\.lock|Cargo\.lock|poetry\.lock|gradle\.lockfile|Package\.resolved)$/i.test(file);
const gradleConfigPath = file => /(?:^|\/)(?:[^/]+\.gradle(?:\.kts)?|settings\.gradle[^/]*|gradle\.properties|local\.properties)$/i.test(file);
const gradleDslPath = file => /(?:^|\/)(?:[^/]+\.gradle(?:\.kts)?|settings\.gradle[^/]*)$/i.test(file);
const structuredConfigPath = file => /(?:^|\/)\.env[^/]*$|\.(?:properties|ya?ml|toml|ini|cfg|conf|json|plist|xcconfig)$/i.test(file);
const sourcePath = file => /\.(?:groovy|kt|kts|swift|ts|tsx|js|jsx|java|m|mm)$/i.test(file) && !gradleConfigPath(file);
const assetCatalogContentsPath = file => /(?:^|\/)[^/]+\.xcassets\/(?:.*\/)?Contents\.json$/i.test(file);
const stringsPath = file => /\.strings$/i.test(file);
const i18nJsonPath = file => /(?:^|\/)(?:i18n|l10n|locali[sz]ation|locales?|translations?|languages?|strings)(?:\/|$).*\.json$/i.test(file)
  || /(?:^|\/)[a-z]{2,3}(?:[-_][A-Za-z]{2,4})?\.lproj\/.*\.json$/i.test(file);
const configPath = file => lockfilePath(file) || gradleConfigPath(file) || structuredConfigPath(file) || sourcePath(file) || stringsPath(file);
const privateBlock = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g;
const accessKey = /\bAKIA[A-Z0-9]{16}\b/g;
const jwt = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const embeddedUrlCredential = /\b[a-z][a-z\d+.-]*:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/gi;
const quoted = String.raw`"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'` + '|`(?:\\\\.|[^`\\\\])*`';
const reference = value => /(?<!\\)\$(?:[A-Za-z_]\w*|\{[^}]*\})/.test(value)
  // CI/template placeholders such as "{{NPM_TOKEN}}" or {{ secrets.X }} are references, not values (BC-116).
  || /^["']?\{\{\s*[\w.-]+\s*\}\}["']?$/.test(value.trim())
  || /^(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*\s*\(/.test(value);
const publicValue = value => /^(?:true|false|null|none|nil)$/i.test(value)
  || /^(?:[a-z][a-z\d+.-]*:\/\/|\/\/)/i.test(value);
const secretLikeValue = value => {
  const characters = [...value];
  if (characters.length < 8 || /\s/.test(value) || publicValue(value)) return false;
  if (characters.filter(character => character.codePointAt(0) > 0x7f).length * 2 >= characters.length) return false;
  if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) || /^(?:true|false|null|none|nil)$/i.test(value)) return false;
  if (/^[a-z][a-z0-9_.-]*$/.test(value)) return false;
  return true;
};

export function transferFindings(text, { dsl = false, plist = false, lockfile = false, keyNames = true, lineKeys = false } = {}) {
  const hits = new Map(), excluded = new Set();
  const lineAt = offset => text.slice(0, offset).split('\n').length;
  const insideQuotedScalar = offset => {
    let quote;
    for (let index = Math.max(text.lastIndexOf('\n', offset - 1), text.lastIndexOf('\r', offset - 1)) + 1; index < offset; index++) {
      const character = text[index];
      if (character === '\\') { index++; continue; }
      if (quote) { if (character === quote) quote = undefined; }
      else if (character === '"' || character === "'" || character === '`') quote = character;
    }
    return Boolean(quote);
  };
  const add = (key, offset) => {
    if (/(?:^|\.)keyAlias$/i.test(key)) return;
    const id = `${key.toLowerCase()}:${offset}`;
    if (!hits.has(id)) hits.set(id, { key, offset });
  };
  const literal = (key, raw, offset, expression = false, force = false) => {
    if (!force && (!keyNames || !credentialKey(key))) return;
    const isQuoted = /^["'`]/.test(raw);
    const width = raw.startsWith('"""') || raw.startsWith("'''") ? 3 : 1;
    let value = (isQuoted ? raw.slice(width, -width) : raw).trim();
    if (raw.startsWith('"')) { try { value = JSON.parse(raw).trim(); } catch { /* DSL strings need not be valid JSON. */ } }
    if (!isQuoted && /^[{\[]/.test(value)) return;
    if (!value || reference(value) || publicValue(value)) { excluded.add(`${key.toLowerCase()}:${lineAt(offset)}`); return; }
    if (expression && !isQuoted && /^[A-Za-z_$][\w$]*(?:\.[\w$]+)*$/.test(value)) { excluded.add(`${key.toLowerCase()}:${lineAt(offset)}`); return; }
    if (!force && !strongCredentialKey(key) && !secretLikeValue(value)) { excluded.add(`${key.toLowerCase()}:${lineAt(offset)}`); return; }
    add(key, offset);
  };
  let parsed, json = false;
  try {
    parsed = JSON.parse(text); json = true;
  } catch { /* Other configuration formats use the text matchers below. */ }
  if (keyNames && !lockfile && !json) {
    // Reuse the audit detector's string/DSL handling; extend its key vocabulary
    // and strict literal handling for transfer admission rather than log prose.
    const assignments = new RegExp(String.raw`(["']?)([A-Za-z_$][\w$.-]*)\1[\t ]*\]?[\t ]*(?:\:[\t ]*[A-Za-z_][\w?.<>\[\]]*[\t ]*)?(?:=|:(?!:))[\t ]*(${quoted}|\$\{[^}]*\}|[^\s,;\}\]\r\n]+)`, 'g');
    for (const match of text.matchAll(assignments)) {
      if (lineKeys && insideQuotedScalar(match.index)) continue;
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
      const entries = /<key>\s*([^<]+)\s*<\/key>\s*<(string|data)>([\s\S]*?)<\/\2>/g;
      for (const match of text.matchAll(entries)) literal(match[1].trim(), JSON.stringify(match[3]), match.index);
    }
  }
  if (keyNames && !lockfile && json) {
    const packageMaps = new Set(['dependencies', 'devdependencies', 'peerdependencies', 'optionaldependencies', 'bundleddependencies']);
    const pending = [{ item: parsed, parent: '', dependency: false }];
    while (pending.length) {
      const { item, parent, dependency } = pending.pop();
      if (!item || typeof item !== 'object') continue;
      if (Array.isArray(item)) { for (const value of item) if (value && typeof value === 'object') pending.push({ item: value, parent, dependency }); continue; }
      for (const [key, value] of Object.entries(item)) {
        const packageEntry = packageMaps.has(parent.toLowerCase()) || key.split('/').includes('node_modules')
          || (key.includes('/') && /(?:^|\/)[^/]+\.[A-Za-z0-9]{1,10}$/.test(key));
        if (value && typeof value === 'object') pending.push({ item: value, parent: key, dependency: dependency || packageEntry });
        else if (typeof value === 'string' && !dependency && !packageEntry)
          literal(key, JSON.stringify(value), Math.max(0, text.indexOf(JSON.stringify(key))));
      }
    }
  }
  if (keyNames && !lineKeys && !lockfile && !json) for (const finding of passwordStyleFindings(text)) {
      if (!credentialKey(finding.field) || excluded.has(`${finding.field}:${finding.line}`)) continue;
      const offset = text.split('\n').slice(0, finding.line - 1).join('\n').length + (finding.line > 1 ? 1 : 0);
      add(finding.field, offset);
    }
  const authLine = /(?:^|[\r\n])[^\r\n]*?(_authToken|_auth)["']?[\t ]*(?:=|:)[\t ]*(\$\{[^}]*\}|[^,\r\n#;]+)/gi;
  for (const match of text.matchAll(authLine)) literal(match[1], match[2].trim(), match.index, false, true);
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

function scanOptions(file, content) {
  const lockfile = content.generatedLockfile || lockfilePath(file);
  if (lockfile || sourcePath(file) || assetCatalogContentsPath(file) || stringsPath(file) || i18nJsonPath(file)) return { lockfile, keyNames: false };
  if (gradleConfigPath(file)) return { dsl: gradleDslPath(file), keyNames: true };
  return { plist: /\.plist$/i.test(file), keyNames: structuredConfigPath(file), lineKeys: !/\.plist$/i.test(file) };
}

function contentFindings(content, file) {
  const options = scanOptions(file, content);
  const hits = transferFindings(content.text, options);
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
  const entries = [], snapshotTree = new Map(), snapshotConfigSymlinks = [], historyConfigSymlinks = [], symlinkOids = new Set();
  const blob = (oid, file, type, symlinkBucket) => {
    if (!configPath(file)) return;
    if (type === '120000') {
      if (symlinkBucket) { symlinkBucket.push({ oid, file }); symlinkOids.add(oid); }
      return;
    }
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid) || seen.has(file + ':' + oid)) return;
    seen.add(file + ':' + oid); entries.push({ oid, file });
  };
  const patterns = ['**/*.properties', '**/.env*', '**/*.gradle', '**/*.gradle.kts', '**/settings.gradle*', '**/*.yml', '**/*.yaml', '**/*.toml', '**/*.ini', '**/*.cfg', '**/*.conf', '**/*.json', '**/*.plist', '**/*.xcconfig', '**/*.strings', '**/*.groovy', '**/*.kt', '**/*.kts', '**/*.swift', '**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.java', '**/*.m', '**/*.mm',
    '**/yarn.lock', '**/Podfile.lock', '**/Gemfile.lock', '**/Cargo.lock', '**/poetry.lock', '**/gradle.lockfile', '**/Package.resolved'].map(pattern => ':(glob,icase)' + pattern);
  const changes = (args, phase) => {
    report(phase);
    const records = git(args).toString('utf8').split('\0');
    for (let i = 0; i < records.length - 1; i += 2) {
      const [, type, , oid] = records[i].trim().split(/\s+/);
      if (/^(100|120000)/.test(type || '')) blob(oid, records[i + 1], type);
    }
  };
  const historyChanges = () => {
    report('history-list');
    const records = git(['log', '--full-history', '-m', '--root', '--format=commit:%H%x00', '--raw', '-z', '--no-renames', '--no-abbrev', commit,
      ...bases.map(oid => '^' + oid), '--', ...patterns]).toString('utf8').split('\0');
    let historyCommit;
    for (let i = 0; i < records.length; i++) {
      const marker = /^commit:([a-f0-9]{40,64})$/.exec(records[i]);
      if (marker) { historyCommit = marker[1]; continue; }
      const raw = records[i].trim();
      if (!raw.startsWith(':') || !records[i + 1]) continue;
      const [, type, , oid] = raw.split(/\s+/);
      if (/^(100|120000)/.test(type || '')) {
        const before = historyConfigSymlinks.length;
        blob(oid, records[++i], type, historyConfigSymlinks);
        if (historyConfigSymlinks.length !== before) historyConfigSymlinks.at(-1).commit = historyCommit;
      }
    }
  };
  if (scope !== 'history') {
    report('tree-list');
    const tree = git(['ls-tree', '-rz', commit]).toString('utf8').split('\0').filter(Boolean);
    for (const entry of tree) {
      const tab = entry.indexOf('\t'), [type, kind, oid] = entry.slice(0, tab).split(' ');
      const file = entry.slice(tab + 1);
      snapshotTree.set(file, { type, kind, oid });
      if (kind === 'blob') {
        if (type === '120000') symlinkOids.add(oid);
        blob(oid, file, type, snapshotConfigSymlinks);
      }
    }
    if (mode === 'worktree') changes(['diff', '--cached', '--raw', '-z', '--no-renames', '--no-abbrev', 'HEAD'], 'staged-list');
  }
  if (scope !== 'snapshot') {
    historyChanges();
  }
  const byOid = new Map();
  for (const entry of entries) {
    if (!byOid.has(entry.oid)) byOid.set(entry.oid, []);
    byOid.get(entry.oid).push(entry.file);
  }
  const unread = [], dirtyOids = new Set();
  for (const oid of byOid.keys()) {
    if (clean.has(oid)) progress.cacheHits++;
    else { unread.push(oid); dirtyOids.add(oid); }
  }
  for (const oid of symlinkOids) if (!unread.includes(oid)) unread.push(oid);
  progress.blobsDiscovered = byOid.size;
  report(scope === 'history' ? 'history-blobs' : 'snapshot-blobs');
  const newlyClean = [], symlinkTargets = new Map();
  await readBatch(repo, unread, (oid, bytes) => {
    if (symlinkOids.has(oid)) symlinkTargets.set(oid, bytes.toString('utf8'));
    if (!dirtyOids.has(oid)) return;
    const content = decodedContent(bytes), files = byOid.get(oid);
    for (const file of files) addHits(contentFindings(content, file), file);
    // Cache only when every supported interpretation is clean. The finding
    // reported for this run remains path-specific, preserving existing DSL
    // reference handling while keeping the OID verdict path-independent.
    const cacheable = (content.generatedLockfile
      ? [transferFindings(content.text, { lockfile: true, keyNames: false })]
      : [transferFindings(content.text), transferFindings(content.text, { dsl: true }), transferFindings(content.text, { plist: true })])
      .every(hits => !hits.length);
    if (cacheable) { clean.add(oid); newlyClean.push(oid); }
    progress.blobsProcessed++;
    if (progress.blobsProcessed % 1000 === 0) report(progress.phase);
  });
  const resolveSnapshotSymlink = (file, oid) => {
    const visited = new Set();
    for (let depth = 0; depth < 32; depth++) {
      const visit = `${file}:${oid}`;
      if (visited.has(visit)) return false;
      visited.add(visit);
      const target = symlinkTargets.get(oid);
      if (target === undefined || !target || target.includes('\0') || path.posix.isAbsolute(target)) return false;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
      if (resolved === '..' || resolved.startsWith('../') || resolved === '.') return false;
      const entry = snapshotTree.get(resolved);
      if (!entry || entry.kind !== 'blob') return false;
      if (entry.type === '100644' || entry.type === '100755') return true;
      if (entry.type !== '120000') return false;
      file = resolved; oid = entry.oid;
    }
    return false;
  };
  for (const entry of snapshotConfigSymlinks) if (!resolveSnapshotSymlink(entry.file, entry.oid)) findings.push({ path: entry.file, key: 'SYMLINK_CONFIG', count: 1 });
  const resolveHistorySymlink = entry => {
    const target = symlinkTargets.get(entry.oid);
    if (!entry.commit || target === undefined || !target || target.includes('\0') || path.posix.isAbsolute(target)) return false;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entry.file), target));
    if (resolved === '..' || resolved.startsWith('../') || resolved === '.') return false;
    const record = git(['ls-tree', '-z', entry.commit, '--', resolved]).toString('utf8').replace(/\0$/, '');
    const tab = record.indexOf('\t');
    if (tab === -1 || record.slice(tab + 1) !== resolved) return false;
    const [type, kind] = record.slice(0, tab).split(' ');
    return kind === 'blob' && (type === '100644' || type === '100755');
  };
  for (const entry of historyConfigSymlinks) if (!resolveHistorySymlink(entry)) findings.push({ path: entry.file, key: 'SYMLINK_CONFIG', count: 1 });
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
      if (stat.isSymbolicLink()) {
        let resolved;
        try { resolved = fs.realpathSync(location); } catch { findings.push({ path: file, key: 'SYMLINK_CONFIG', count: 1 }); continue; }
        const root = fs.realpathSync(repo), relative = path.relative(root, resolved);
        let tracked = false;
        if (relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) {
          try { tracked = git(['ls-files', '-z', '--error-unmatch', '--', relative]).toString('utf8') === `${relative}\0`; }
          catch { /* Untracked, ignored, and absent targets are refused. */ }
        }
        let targetStat;
        try { targetStat = fs.statSync(resolved); } catch { /* handled below */ }
        if (!tracked || !targetStat?.isFile()) findings.push({ path: file, key: 'SYMLINK_CONFIG', count: 1 });
        continue;
      }
      if (stat.isFile()) {
        if (fs.realpathSync(location) !== location) { findings.push({ path: file, key: 'SYMLINK_CONFIG', count: 1 }); continue; }
        const content = decodedContent(fs.readFileSync(location));
        addHits(contentFindings(content, file), file);
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
