import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { exportSource, forbiddenPath, loadProfile } from '../lib/devbox-export.mjs';
import { entropyIdentifierExempt, highEntropy, sanitizeText, validateProfile } from '../lib/devbox-sanitize.mjs';
import { checkTransfer } from '../lib/devbox-transfer-check.mjs';
import { snapshot, makeBundle } from '../devbox-run.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-export-fixtures-'));
const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo);
const git = (dir, args, input) => execFileSync('git', ['-C', dir, ...args], { input, stdio: ['pipe', 'pipe', 'ignore'], env: {
  ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).toString().trim();
const put = (dir, file, content) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), content); };
const commit = () => { git(repo, ['add', '--all']); git(repo, ['commit', '-qm', 'Synthetic fixture']); return git(repo, ['rev-parse', 'HEAD']); };
const profile = loadProfile('vesdk-mainline'); let tests = 0;
const ok = (condition, message) => { assert(condition, message + '; fixture values suppressed'); tests++; };
try {
  git(repo, ['init', '-q']);
  ok(loadProfile('lynx-view').requirements.localUnpushedRefs, 'Lynx local refs required');
  ok(loadProfile('lynx-view').buildEnvironmentNames.includes('ORG_GRADLE_PROJECT_VEMO_SOURCE_VMSDK_VERSION'), 'VMSDK environment name missing');
  assert.throws(() => loadProfile('../anything')); tests++;
  assert.throws(() => loadProfile('unknown')); tests++;
  for (const file of ['.env', '.npmrc', 'local.properties', '.gradle/gradle.properties', 'signing/debug.keystore', '.remoteX/config', 'proj/ios/fixture.txt']) ok(forbiddenPath(file, profile), 'forbidden path filter');
  ok(!forbiddenPath('Dependencies/bach/version.yml', profile), 'Bach build dependency retained');

  for (const rule of profile.rules.filter(r => r.action === 'bach-empty')) {
    const file = rule.path.replace('*', 'fixture-version');
    const content = 'namespace fixture {\nstd::string m_authCode = "synthetic-bach-fixture";\n}\n';
    const result = sanitizeText(content, file, profile);
    ok(result.findings.length === 0 && result.text === content.replace('"synthetic-bach-fixture"', '""'), 'Bach staged rewrite');
    ok(result.receipts[0].rewritten === 1, 'Bach rewrite receipt');
    const noOp = sanitizeText(result.text, file, profile);
    ok(noOp.findings.length === 0 && noOp.receipts[0].noOp === 1, 'Bach no-op');
    for (const changed of [content + content, content.replace('std::string', 'auto'), content.replace('"synthetic-bach-fixture"', 'factory()'), content.replace('"synthetic-bach-fixture"', '"one" "two"')])
      ok(sanitizeText(changed, file, profile).findings.length > 0, 'Bach changed declaration rejected');
  }
  ok(sanitizeText('apiKey = "syntheticfixturevalue";', 'fixture.properties', profile).findings.length > 0, 'unresolved finding refused');
  const shape = 'AKIA' + 'ABCDEFGHIJKLMNOP';
  ok(sanitizeText(`const char *ordinary = "${shape}";`, 'fixture.hpp', profile).findings.length > 0, 'C++ header exact shape detected');
  const exactRule = { id: 'fixture-shape', path: 'fixture.hpp', field: 'ordinary', ordinal: 1, count: 1, state: 'approved', action: 'rewrite', detector: 'shape:AKIA_ACCESS_KEY', anchor: { before: 'const char *ordinary =', after: ';' }, reason: 'Synthetic precise shape fixture' };
  const exact = sanitizeText(`const char *ordinary = "${shape}";`, 'fixture.hpp', { ...profile, rules: [exactRule] });
  ok(exact.findings.length === 0 && exact.text === 'const char *ordinary = "";', 'reviewed compiled value-shape rewrite');
  const text = 'const char *alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";\n';
  const keepRule = { id: 'fixture-keep', path: 'fixture.hpp', field: 'alphabet', ordinal: 1, count: 1, state: 'approved', action: 'KEEP', detector: 'highEntropyReview', anchor: { before: 'const char *alphabet =', after: ';' }, reason: 'Synthetic alphabet fixture only' };
  const keep = validateProfile({ ...profile, rules: [keepRule] });
  ok(sanitizeText(text, 'fixture.hpp', keep).findings.length === 0, 'anchored KEEP');
  ok(sanitizeText(text.replace('const char *', 'std::string '), 'fixture.hpp', keep).findings.length > 0, 'KEEP anchor drift');
  ok(sanitizeText(text + text, 'fixture.hpp', keep).findings.length > 0, 'KEEP duplicate drift');
  ok(sanitizeText(text, 'fixture.hpp', { ...keep, rules: [{ ...keepRule, state: 'proposed' }] }).observations.some(h => h.state === 'report-only'), 'unapproved entropy KEEP remains report-only');
  ok(sanitizeText(text, 'fixture.hpp', { ...profile, rules: [] }).findings.length === 0, 'entropy heuristic never blocks');
  const rewrite = { ...keepRule, action: 'rewrite' };
  ok(sanitizeText(text, 'fixture.hpp', { ...keep, rules: [rewrite] }).findings.some(h => h.detector === 'compiled-name-rewrite-refused'), 'compiled name rewrites refused');
  for (const [sample, expected] of [['enable_shader_render_graph', true], ['Enable_shader_render', false], ['render_abcdefabcdef_graph', false], ['render_abcdefghijklmnopqrst_graph', true], ['render_abcdefghijklmnopqrstu_graph', false]])
    ok(entropyIdentifierExempt(sample) === expected, 'entropy exemption boundary');
  const identifier = 'enable_shader_render_graph_pipeline';
  ok(!highEntropy(identifier), 'identifier entropy exemption');
  ok(sanitizeText(`String apiKey = "${identifier}";`, 'fixture.java', { ...profile, rules: [] }).text.includes(identifier), 'compiled identifier bytes preserved');
  ok(sanitizeText('String ordinary = "sk_enable_shader_render_graph_pipeline";', 'fixture.java', profile).findings.some(h => h.detector === 'known-prefix'), 'entropy exemption cannot suppress known prefix');

  // Only synthetic fields and shapes are used for rewrite activation tests.
  for (const [file, content, field, syntax] of [
    ['fixture.properties', 'NEXUS_MAGIC_WORD=syntheticfixture\n', 'NEXUS_MAGIC_WORD', 'properties-assignment'],
    ['fixture.gradle', 'password NEXUS_MAGIC_WORD\n', 'password', 'gradle-reference'],
    ['fixture.gradle', 'def cmd = "curl -H \'postman-token: 00000000-0000-4000-8000-000000000000\'"\n', 'postman-token', 'curl-header']]) {
    const rule = { id: 'fixture-rewrite', path: file, field, detector: 'transfer:' + field, action: 'rewrite', state: 'approved', count: 1, anchor: { syntax }, reason: 'Synthetic reviewed configuration fixture' };
    ok(sanitizeText(content, file, { ...profile, rules: [rule] }).findings.length === 0, 'reviewed configuration rewrite');
    ok(sanitizeText(content + content, file, { ...profile, rules: [rule] }).findings.length > 0, 'configuration count drift');
  }
  const gradleKotlinRule = { id: 'fixture-kotlin-config', path: 'fixture.gradle.kts', field: 'keyPassword', detector: 'transfer:keyPassword', action: 'rewrite', state: 'approved', count: 1, anchor: { before: 'keyPassword =', after: '' }, reason: 'Synthetic Gradle configuration fixture' };
  const kotlinConfig = sanitizeText('keyPassword = "syntheticfixture"\n', 'fixture.gradle.kts', { ...profile, rules: [gradleKotlinRule] });
  ok(kotlinConfig.findings.length === 0 && kotlinConfig.text === 'keyPassword = ""\n' && kotlinConfig.receipts[0]?.rewritten === 1, 'Gradle Kotlin DSL follows configuration rewrite rules');

  put(repo, 'ordinary.cpp', 'int main() { return 0; }\n');
  fs.symlinkSync('ordinary.cpp', path.join(repo, 'safe-link.cpp'));
  put(repo, 'Dependencies/bach/version.yml', 'version: fixture\n');
  put(repo, 'proj/ios/excluded.txt', 'fixture\n');
  // Filename filtering happens before any contents are read; this symlink target is never opened.
  fs.symlinkSync(path.join(tmp, 'does-not-exist'), path.join(repo, '.env'));
  const first = commit();
  put(repo, 'local-overlay.cpp', 'int local_fixture = 34;\n'); const local = commit();
  ok(local !== first && git(repo, ['remote']) === '', 'unpushed local commit fixture');
  let result = await exportSource({ repo, ref: local, profile: 'lynx-view', out: path.join(tmp, 'local-export') });
  ok(result.status === 'passed', 'local commit export');
  const source = path.join(tmp, 'local-export/source');
  ok(fs.existsSync(path.join(source, 'local-overlay.cpp')), 'local overlay included');
  ok(fs.existsSync(path.join(source, 'Dependencies/bach/version.yml')), 'Bach pin included');
  ok(!fs.existsSync(path.join(source, '.env')), 'forbidden symlink excluded before reading');
  ok(fs.lstatSync(path.join(source, 'safe-link.cpp')).isSymbolicLink() && fs.readlinkSync(path.join(source, 'safe-link.cpp')) === 'ordinary.cpp', 'in-tree link preserved without following');
  ok(git(source, ['ls-tree', 'HEAD', 'safe-link.cpp']).startsWith('120000 blob'), 'Git preserves symlink mode');
  ok(git(source, ['rev-list', '--count', 'HEAD']) === '1' && git(source, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ').length === 1, 'parentless source history');
  for (const scope of ['snapshot', 'history']) ok((await checkTransfer(source, result.commit, 'HEAD', null, { scope })).length === 0, 'unchanged transfer scope');
  await assert.rejects(() => exportSource({ repo, ref: local, profile: 'lynx-view', out: path.join(tmp, 'local-export') })); tests++;

  const donor = path.join(tmp, 'dependency'); fs.mkdirSync(donor);
  put(donor, 'pub/inc/smash/avatar_base_model.h', 'std::string m_authCode = "synthetic-bach-fixture";\n');
  const original = fs.readFileSync(path.join(donor, 'pub/inc/smash/avatar_base_model.h'));
  result = await exportSource({ repo, ref: local, profile: 'lynx-view', out: path.join(tmp, 'dependency-export'), dependencies: [{ dir: donor, prefix: 'native-deps/bach-sdk', expectedBachHeaders: ['pub/inc/smash/avatar_base_model.h'] }] });
  ok(result.status === 'passed' && result.receipts.some(r => r.rewritten === 1), 'staged dependency sanitized');
  ok(fs.readFileSync(path.join(donor, 'pub/inc/smash/avatar_base_model.h')).equals(original), 'donor bytes untouched');
  result = await exportSource({ repo, ref: local, profile: 'lynx-view', out: path.join(tmp, 'missing-header'), dependencies: [{ dir: donor, prefix: 'native-deps/bach-sdk', expectedBachHeaders: ['pub/inc/smash/missing.h'] }] });
  ok(result.status === 'failed', 'expected missing header refused');

  const payload = Buffer.from('Synthetic LFS payload for local fixtures\n');
  const oid = createHash('sha256').update(payload).digest('hex');
  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${payload.length}\n`;
  put(repo, '.gitattributes', '*.zip filter=lfs diff=lfs merge=lfs -text\n');
  put(repo, 'lynx-games/effect-packages/android/sticker/fixture.zip', pointer);
  // Avoid installing any Git LFS filter in this fixture repository.
  const blob = git(repo, ['hash-object', '-w', '--stdin'], Buffer.from(pointer));
  git(repo, ['add', '.gitattributes']);
  git(repo, ['update-index', '--add', '--cacheinfo', `100644,${blob},lynx-games/effect-packages/android/sticker/fixture.zip`]);
  git(repo, ['commit', '-qm', 'Synthetic LFS pointer']); const lfsRef = git(repo, ['rev-parse', 'HEAD']);
  const object = path.join(repo, '.git/lfs/objects', oid.slice(0, 2), oid.slice(2, 4), oid); put(repo, path.relative(repo, object), payload);
  result = await exportSource({ repo, ref: lfsRef, profile: 'lynx-view', out: path.join(tmp, 'lfs-export') });
  ok(result.status === 'passed' && result.hydratedLfs.length === 1, 'LFS hydration');
  const hydratedRepo = fs.realpathSync(path.join(tmp, 'lfs-export/source'));
  ok(fs.readFileSync(path.join(hydratedRepo, 'lynx-games/effect-packages/android/sticker/fixture.zip')).equals(payload), 'hydrated bytes match');
  ok(git(hydratedRepo, ['show', 'HEAD:lynx-games/effect-packages/android/sticker/fixture.zip']) === payload.toString().trim(), 'Git snapshot has payload rather than pointer');
  // Exercise the runner snapshot and bundle, then a fresh local receiver. No SSH.
  const state = { children: new Set(), cleanup: [], timings: {}, events: [] };
  const runnerTemp = path.join(tmp, 'runner'); fs.mkdirSync(runnerTemp);
  const snap = await snapshot({ repo: hydratedRepo, ref: 'HEAD', project: 'fixture', submodules: false }, runnerTemp, state);
  const bundle = await makeBundle(snap, [], state);
  const receiver = path.join(tmp, 'receiver'); fs.mkdirSync(receiver); git(receiver, ['init', '-q']);
  git(receiver, ['fetch', bundle, 'refs/heads/export']);
  ok(git(receiver, ['show', 'FETCH_HEAD:lynx-games/effect-packages/android/sticker/fixture.zip']) === payload.toString().trim(), 'runner bundle carries hydrated LFS');
  fs.rmSync(object);
  result = await exportSource({ repo, ref: lfsRef, profile: 'lynx-view', out: path.join(tmp, 'lfs-missing') });
  ok(result.status === 'failed' && !fs.existsSync(path.join(tmp, 'lfs-missing/source')), 'missing LFS fails and discards stage');
  put(repo, path.relative(repo, object), Buffer.alloc(payload.length, 120));
  result = await exportSource({ repo, ref: lfsRef, profile: 'lynx-view', out: path.join(tmp, 'lfs-mismatch') });
  ok(result.status === 'failed', 'LFS digest mismatch');
  put(repo, path.relative(repo, object), Buffer.from('short'));
  result = await exportSource({ repo, ref: lfsRef, profile: 'lynx-view', out: path.join(tmp, 'lfs-size') });
  ok(result.status === 'failed', 'LFS size mismatch');
  console.log(JSON.stringify({ pass: true, checks: tests }));
} catch (error) {
  console.error(JSON.stringify({ failedAfterChecks: tests, at: String(error.stack).split('\n').filter(line => /^\s+at /.test(line)).slice(0, 3) }));
  console.error('Exporter regression failed; synthetic fixture contents suppressed.'); process.exitCode = 1;
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
