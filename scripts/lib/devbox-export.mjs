import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkTransfer } from './devbox-transfer-check.mjs';
import { transferFindings } from './devbox-transfer-check.mjs';
import { sanitizeText, validateProfile, runnerScansPath } from './devbox-sanitize.mjs';

const profilesDir = fileURLToPath(new URL('../../references/devbox-export-profiles/', import.meta.url));
const gitEnv = () => {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const name of Object.keys(env)) if (/^GIT_(?:CONFIG_|INDEX_FILE$|WORK_TREE$|DIR$|OBJECT_DIRECTORY$|ALTERNATE_OBJECT_DIRECTORIES$)/.test(name)) delete env[name];
  return env;
};
function git(repo, args, input, env = gitEnv()) {
  try { return execFileSync('git', ['-C', repo, ...args], { input, env, maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'] }); }
  catch { throw Error('local Git operation failed; contents suppressed'); }
}
export function loadProfile(name) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw Error('invalid profile name');
  let profile;
  try { profile = JSON.parse(fs.readFileSync(path.join(profilesDir, name + '.json'), 'utf8')); }
  catch { throw Error('unknown exporter profile'); }
  if (profile.name !== name) throw Error('profile identity mismatch');
  return validateProfile(profile);
}
export function forbiddenPath(file, profile) {
  const parts = file.split('/');
  if (!file || path.posix.isAbsolute(file) || parts.some(p => !p || p === '..' || p === '.')) return true;
  if (parts.some(p => /^(?:\.git|\.ssh|\.claude|\.trae|\.remoteX|\.gradle|node_modules|DerivedData|\.venv)$/i.test(p))) return true;
  if (/(?:^|\/)(?:\.env(?:\..*)?|\.netrc|\.npmrc|\.pypirc|local\.properties|gradle-user\.properties|cookies?(?:\..*)?|credentials?(?:\..*)?|id_(?:rsa|ed25519|ecdsa)|.*\.(?:keystore|jks|p12|pfx|pem|key|mobileprovision))$/i.test(file)) return true;
  return profile.excludePrefixes.some(prefix => file === prefix.replace(/\/$/, '') || file.startsWith(prefix.endsWith('/') ? prefix : prefix + '/'));
}
function treeEntries(repo, ref) {
  return git(repo, ['ls-tree', '-rz', ref]).toString('utf8').split('\0').filter(Boolean).map(record => {
    const tab = record.indexOf('\t');
    const [mode, type, oid] = record.slice(0, tab).split(' ');
    return { mode, type, oid, path: record.slice(tab + 1) };
  });
}

// Stream one object at a time, preserving backpressure and never printing contents.
async function blobs(repo, entries, consume) {
  if (!entries.length) return;
  const child = spawn('git', ['-C', repo, 'cat-file', '--batch'], { env: gitEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
  const closed = new Promise((resolve, reject) => {
    child.once('error', () => reject(Error('Git blob reader failed')));
    child.once('close', code => code ? reject(Error('Git blob reader failed')) : resolve());
  });
  // Attach immediately, including when parsing fails before close.
  closed.catch(() => {});
  const iterator = child.stdout[Symbol.asyncIterator](); let pending = Buffer.alloc(0);
  const fill = async () => { const next = await iterator.next(); if (next.done) throw Error('incomplete Git blob response'); pending = Buffer.concat([pending, next.value]); };
  try {
    for (const entry of entries) {
      child.stdin.write(entry.oid + '\n');
      while (pending.indexOf(10) < 0) await fill();
      const end = pending.indexOf(10), header = pending.subarray(0, end).toString('ascii'); pending = pending.subarray(end + 1);
      const m = /^([a-f0-9]+) blob (\d+)$/.exec(header);
      if (!m || m[1] !== entry.oid || !Number.isSafeInteger(Number(m[2]))) throw Error('invalid Git blob response');
      const size = Number(m[2]);
      while (pending.length < size + 1) await fill();
      if (pending[size] !== 10) throw Error('invalid Git blob framing');
      const bytes = pending.subarray(0, size); pending = pending.subarray(size + 1);
      await consume(entry, bytes);
    }
    child.stdin.end(); await closed;
  } catch (e) { child.kill('SIGTERM'); child.stdin.destroy(); await closed.catch(() => {}); throw e; }
}

function lfsAttributes(repo, ref, entries, index) {
  const env = { ...gitEnv(), GIT_INDEX_FILE: index };
  git(repo, ['read-tree', ref], undefined, env);
  try {
    const output = git(repo, ['check-attr', '--cached', '-z', '--stdin', 'filter'], Buffer.from(entries.map(e => e.path + '\0').join('')), env).toString('utf8').split('\0');
    const names = new Set();
    for (let i = 0; i + 2 < output.length; i += 3) if (output[i + 1] === 'filter' && output[i + 2] === 'lfs') names.add(output[i]);
    return names;
  } finally { fs.rmSync(index, { force: true }); }
}
export function parseLfsPointer(bytes) {
  if (bytes.length > 1024 || !/^version https:\/\/git-lfs.github.com\/spec\/v1\r?\n/.test(bytes.toString('utf8'))) return null;
  const match = /^version https:\/\/git-lfs.github.com\/spec\/v1\r?\n(?:ext-[^\r\n]+\r?\n)*oid sha256:([a-f0-9]{64})\r?\nsize (\d+)\r?\n?$/.exec(bytes.toString('utf8'));
  if (!match || !Number.isSafeInteger(Number(match[2]))) throw Error('invalid LFS pointer');
  return { oid: match[1], size: Number(match[2]) };
}
async function hydrate(repo, pointer, target) {
  const common = git(repo, ['rev-parse', '--git-common-dir']).toString('utf8').trim();
  const location = path.resolve(repo, common, 'lfs', 'objects', pointer.oid.slice(0, 2), pointer.oid.slice(2, 4), pointer.oid);
  const stat = fs.lstatSync(location);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== pointer.size) throw Error('LFS object size mismatch');
  fs.copyFileSync(location, target, fs.constants.COPYFILE_EXCL);
  const hash = createHash('sha256'); let size = 0;
  // Verify the actual staged asset bytes before accepting hydration or creating Git objects.
  for await (const chunk of fs.createReadStream(target)) { hash.update(chunk); size += chunk.length; }
  if (size !== pointer.size || hash.digest('hex') !== pointer.oid) throw Error('LFS object digest mismatch');
}
function scanBytes(bytes, name, profile) {
  if (bytes.subarray(0, 6).toString() === 'bplist') {
    let decoded;
    try { decoded = execFileSync('python3', ['-c', 'import plistlib,sys;sys.stdout.buffer.write(plistlib.dumps(plistlib.loads(sys.stdin.buffer.read()),fmt=plistlib.FMT_XML))'], { input: bytes, stdio: ['pipe', 'pipe', 'ignore'] }).toString('utf8'); }
    catch { const hit = { path: name, field: '[plist]', detector: 'unreadable-plist', line: 1 };
      return { findings: runnerScansPath(name) ? [hit] : [], observations: runnerScansPath(name) ? [] : [{ ...hit, state: 'report-only' }], receipts: [], observed: [], bytes }; }
    const result = sanitizeText(decoded, name, profile);
    if (result.text !== decoded) throw Error('binary plist rewrite is unsupported');
    return { ...result, bytes };
  }
  if (bytes.includes(0)) {
    // Bounded overlapping windows detect exact markers without interpreting binary as source.
    const findings = [], seen = new Set();
    for (let i = 0; i < bytes.length; i += 64 * 1024) {
      for (const hit of transferFindings(bytes.subarray(Math.max(0, i - 4096), i + 64 * 1024).toString('latin1'), { keyNames: false, lineKeys: false, lockfile: true })) {
        if (!seen.has(hit.key)) { seen.add(hit.key); findings.push({ path: name, field: hit.key, detector: 'binary-shape:' + hit.key, line: 1, count: hit.count }); }
      }
    }
    const blocking = findings.filter(h => runnerScansPath(name) || /^(?:PRIVATE_KEY_BLOCK|AKIA_ACCESS_KEY|JWT)$/.test(h.field));
    return { findings: blocking, observations: findings.filter(h => !blocking.includes(h)).map(h => ({ ...h, state: 'report-only' })), receipts: [], observed: [], bytes };
  }
  const result = sanitizeText(bytes.toString('utf8'), name, profile);
  if (result.text !== bytes.toString('utf8') && !Buffer.from(bytes.toString('utf8')).equals(bytes))
    return { findings: [{ path: name, field: '[encoding]', detector: 'rewrite-encoding-refused', line: 1 }], observations: result.observations, receipts: [], observed: [] };
  return { ...result, bytes: result.text === bytes.toString('utf8') ? bytes : Buffer.from(result.text) };
}

export async function exportSource({ repo, ref, profile: profileName, out, dependencies = [] }) {
  repo = fs.realpathSync(repo); out = path.resolve(out);
  out = path.join(fs.realpathSync(path.dirname(out)), path.basename(out));
  const profile = loadProfile(profileName);
  // Neither the source worktree nor its Git database may contain the output.
  const relative = path.relative(repo, out);
  if (!relative.startsWith('..' + path.sep) && relative !== '..') throw Error('output must be outside the source repository');
  for (const dependency of dependencies) {
    const donor = fs.realpathSync(dependency.dir || dependency.repo);
    const relative = path.relative(donor, out);
    if (!relative.startsWith('..' + path.sep) && relative !== '..') throw Error('output must be outside every dependency donor');
  }
  fs.mkdirSync(out, { mode: 0o700 }); // Existing directories are always refused.
  const staged = path.join(out, 'source'); fs.mkdirSync(staged, { mode: 0o700 });
  const report = { version: 1, profile: profileName, status: 'failed', findings: [], observations: [], symlinks: [], receipts: [], hydratedLfs: [], excluded: [], sources: [], transfer: {} };
  const observed = new Set(), included = new Set(), links = new Map();
  const writeReport = () => fs.writeFileSync(path.join(out, 'export-report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  try {
    const inputs = [{ repo, ref, prefix: '' }, ...dependencies];
    for (let n = 0; n < inputs.length; n++) {
      const input = inputs[n];
      if (n && (!input.prefix || forbiddenPath(input.prefix, profile) || input.prefix.includes('*'))) throw Error('invalid staged dependency prefix');
      if (input.dir) {
        const donor = fs.realpathSync(input.dir);
        const pending = [''];
        report.sources.push({ prefix: input.prefix, kind: 'staged-directory' });
        while (pending.length) {
          const sub = pending.pop();
          for (const entry of fs.readdirSync(path.join(donor, sub), { withFileTypes: true })) {
            const relative = sub ? sub + '/' + entry.name : entry.name;
            const name = input.prefix + '/' + relative;
            if (forbiddenPath(name, profile) || forbiddenPath(relative, profile)) { report.excluded.push({ path: name, reason: 'forbidden-path-or-profile' }); continue; }
            if (entry.isDirectory()) { pending.push(relative); continue; }
            if (entry.isSymbolicLink()) { if (included.has(name)) throw Error('duplicate staged dependency path'); included.add(name); links.set(name, fs.readlinkSync(path.join(donor, relative))); continue; }
            if (!entry.isFile()) { report.findings.push({ path: name, field: '[path]', detector: 'dependency-nonregular-path', line: 1 }); continue; }
            if (/\.(?:zip|tar|tar\.gz|tgz|7z|rar)$/i.test(name)) { report.findings.push({ path: name, field: '[archive]', detector: 'dependency-archive-requires-unpack', line: 1 }); continue; }
            if (included.has(name)) throw Error('duplicate staged dependency path'); included.add(name);
            const bytes = fs.readFileSync(path.join(donor, relative));
            if (parseLfsPointer(bytes)) { report.findings.push({ path: name, field: '[LFS]', detector: 'unhydrated-dependency-lfs-pointer', line: 1 }); continue; }
            const result = scanBytes(bytes, name, profile);
            report.findings.push(...result.findings); report.observations.push(...(result.observations || [])); report.receipts.push(...result.receipts); result.observed.forEach(id => observed.add(id));
            if (result.findings.length) continue;
            const destination = path.join(staged, name); fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.writeFileSync(destination, result.bytes, { mode: fs.statSync(path.join(donor, relative)).mode & 0o111 ? 0o755 : 0o644 });
          }
        }
        for (const expected of input.expectedBachHeaders || []) {
          const name = input.prefix + '/' + expected;
          if (!included.has(name)) report.findings.push({ path: name, field: 'm_authCode', detector: 'missing-expected-bach-header', line: 1 });
        }
        continue;
      }
      const donor = fs.realpathSync(input.repo);
      const commit = git(donor, ['rev-parse', '--verify', '--end-of-options', input.ref + '^{commit}']).toString('utf8').trim();
      report.sources.push({ prefix: input.prefix, commit });
      const entries = treeEntries(donor, commit).filter(entry => {
        const name = input.prefix ? input.prefix + '/' + entry.path : entry.path;
        if (forbiddenPath(name, profile) || forbiddenPath(entry.path, profile)) { report.excluded.push({ path: name, reason: 'forbidden-path-or-profile' }); return false; }
        const deletion = profile.rules.find(rule => rule.state === 'approved' && rule.action === 'delete-path' && rule.path === name);
        if (deletion) {
          if (deletion.count !== 1 || deletion.anchor?.mode !== entry.mode) report.findings.push({ path: name, field: deletion.field, detector: 'reviewed-deletion-anchor-drift', line: 1 });
          else { observed.add(deletion.id); report.receipts.push({ path: name, field: deletion.field, rule: deletion.id, deleted: 1 }); }
          return false;
        }
        if (entry.type === 'commit' && dependencies.some(d => d.prefix === name && d.repo && git(fs.realpathSync(d.repo), ['rev-parse', '--verify', '--end-of-options', d.ref + '^{commit}']).toString('utf8').trim() === entry.oid)) return false;
        if (entry.type !== 'blob') {
          report.findings.push({ path: name, field: '[path]', detector: 'unstaged-submodule', line: 1 }); return false;
        }
        return true;
      });
      const attributes = lfsAttributes(donor, commit, entries, path.join(out, '.attributes-index-' + n));
      await blobs(donor, entries, async (entry, original) => {
        const name = input.prefix ? input.prefix + '/' + entry.path : entry.path;
        if (included.has(name)) throw Error('duplicate staged path'); included.add(name);
        if (entry.mode === '120000') { links.set(name, original.toString('utf8')); return; }
        if (n && /\.(?:zip|tar|tar\.gz|tgz|7z|rar)$/i.test(name)) { report.findings.push({ path: name, field: '[archive]', detector: 'dependency-archive-requires-unpack', line: 1 }); return; }
        const destination = path.join(staged, name);
        let bytes = original, pointer;
        try { pointer = parseLfsPointer(original); }
        catch { report.findings.push({ path: name, field: '[LFS]', detector: 'invalid-lfs-pointer', line: 1 }); return; }
        if (attributes.has(entry.path) && !pointer) {
          report.findings.push({ path: name, field: '[LFS]', detector: 'lfs-attribute-without-pointer', line: 1 }); return;
        }
        if (pointer) {
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          try {
            await hydrate(donor, pointer, destination);
            bytes = fs.readFileSync(destination);
            report.hydratedLfs.push({ path: name, oid: pointer.oid, size: pointer.size });
          } catch {
            report.findings.push({ path: name, field: '[LFS]', detector: 'missing-or-mismatched-lfs-object', line: 1 }); return;
          }
        }
        const result = scanBytes(bytes, name, profile);
        report.findings.push(...result.findings); report.observations.push(...(result.observations || [])); report.receipts.push(...result.receipts);
        result.observed.forEach(id => observed.add(id));
        if (result.findings.length) { if (pointer) fs.rmSync(destination, { force: true }); return; }
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, result.bytes, { mode: entry.mode === '100755' ? 0o755 : 0o644 });
      });
      for (const expected of input.expectedBachHeaders || []) {
        const name = input.prefix ? input.prefix + '/' + expected : expected;
        if (!included.has(name)) report.findings.push({ path: name, field: 'm_authCode', detector: 'missing-expected-bach-header', line: 1 });
      }
    }
    const resolveLink = name => {
      let current = name; const seen = new Set();
      for (let depth = 0; depth < 32; depth++) {
        if (seen.has(current)) return 'cyclic'; seen.add(current);
        const parts = current.split('/'); let replaced = false;
        for (let i = 1; i <= parts.length; i++) {
          const prefix = parts.slice(0, i).join('/'); if (!links.has(prefix)) continue;
          const target = links.get(prefix);
          if (!target || target.includes('\0') || path.posix.isAbsolute(target) || /^[A-Za-z]:[\\/]/.test(target)) return 'absolute-or-invalid';
          const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(prefix), target, ...parts.slice(i)));
          if (resolved === '..' || resolved.startsWith('../')) return 'escaping';
          if (resolved !== '.' && forbiddenPath(resolved, profile)) return 'forbidden';
          current = resolved; replaced = true; break;
        }
        if (!replaced) return current === '.' && included.size || included.has(current) || [...included].some(p => p.startsWith(current + '/')) ? 'in-tree' : 'missing-target';
      }
      return 'depth-limit';
    };
    for (const [name, target] of links) {
      const classification = resolveLink(name); report.symlinks.push({ path: name, classification });
      if (classification !== 'in-tree') {
        const proposal = profile.rules.find(r => r.path === name && r.action === 'delete-path' && r.state === 'proposed');
        report.findings.push({ path: name, field: '[symlink]', detector: 'symlink-' + classification, line: 1, ...(proposal ? { state: 'proposed', proposal: proposal.id } : {}) }); continue;
      }
      const destination = path.join(staged, name); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.symlinkSync(target, destination);
    }
    for (const rule of profile.rules.filter(r => r.state === 'approved' && r.required)) {
      if (!observed.has(rule.id)) report.findings.push({ path: rule.path, field: rule.field, detector: 'missing-reviewed-rule-target', line: 1 });
    }
    if (report.findings.length) { writeReport(); fs.rmSync(staged, { recursive: true, force: true }); return report; }
    git(staged, ['init', '--quiet']);
    // An explicit index avoids .gitignore and attributes filters. Only sanitized bytes become objects.
    const rows = [];
    const regular = [...included].filter(name => !links.has(name) && fs.existsSync(path.join(staged, name))).sort();
    const oids = regular.length ? git(staged, ['hash-object', '-w', '--no-filters', '--stdin-paths'], Buffer.from(regular.map(name => JSON.stringify(path.join(staged, name)) + '\n').join(''))).toString('utf8').trim().split('\n') : [];
    if (oids.length !== regular.length || oids.some(oid => !/^[a-f0-9]{40,64}$/.test(oid))) throw Error('invalid staged object inventory');
    const oidByPath = new Map(regular.map((name, i) => [name, oids[i]]));
    for (const name of [...included].sort()) {
      const file = path.join(staged, name);
      if (links.has(name)) {
        const oid = git(staged, ['hash-object', '-w', '--stdin'], Buffer.from(links.get(name))).toString('utf8').trim();
        rows.push(`120000 ${oid}\t${name}\0`); continue;
      }
      if (!fs.existsSync(file)) continue;
      const oid = oidByPath.get(name);
      rows.push(`${fs.statSync(file).mode & 0o111 ? '100755' : '100644'} ${oid}\t${name}\0`);
    }
    git(staged, ['update-index', '-z', '--index-info'], Buffer.from(rows.join('')));
    const tree = git(staged, ['write-tree']).toString('utf8').trim();
    const env = { ...gitEnv(), GIT_AUTHOR_NAME: 'Source Export', GIT_AUTHOR_EMAIL: 'source-export@example.invalid', GIT_COMMITTER_NAME: 'Source Export', GIT_COMMITTER_EMAIL: 'source-export@example.invalid' };
    const commit = git(staged, ['commit-tree', tree], Buffer.from('Sanitized parentless source export\n'), env).toString('utf8').trim();
    git(staged, ['update-ref', 'refs/heads/export', commit]); git(staged, ['symbolic-ref', 'HEAD', 'refs/heads/export']);
    for (const scope of ['snapshot', 'history']) {
      const hits = await checkTransfer(staged, commit, 'HEAD', null, { scope });
      report.transfer[scope] = { pass: hits.length === 0, findings: hits.length };
      report.findings.push(...hits.map(hit => ({ path: hit.path, field: hit.key, detector: 'runner-' + scope, line: 1, count: hit.count })));
    }
    if (report.findings.length) { writeReport(); fs.rmSync(staged, { recursive: true, force: true }); return report; }
    report.status = 'passed'; report.commit = commit;
    fs.writeFileSync(path.join(out, 'source-provenance.json'), JSON.stringify({ version: 1, profile: profileName, sources: report.sources, exportCommit: commit, parentless: true,
      buildEnvironmentNames: profile.buildEnvironmentNames, hydratedLfs: report.hydratedLfs, rewrites: report.receipts }, null, 2) + '\n', { mode: 0o600 });
    writeReport(); return report;
  } catch {
    report.findings.push({ path: '[export]', field: '[operation]', detector: 'export-operation-failed', line: 1 });
    writeReport(); fs.rmSync(staged, { recursive: true, force: true }); return report;
  }
}
