#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { checkTransfer } from '../lib/devbox-transfer-check.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-transfer-check-'));
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const bin = path.join(temp, 'bin'), batchLog = path.join(temp, 'cat-file-batches.log');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process');
const args=process.argv.slice(2);
if(args.includes('cat-file')&&args.includes('--batch')){
  fs.appendFileSync(process.env.DEVBOX_TEST_GIT_LOG,'batch\\n');
  const until=Date.now()+Number(process.env.DEVBOX_TEST_GIT_DELAY_MS||0);while(Date.now()<until){}
}
const child=cp.spawn(${JSON.stringify(realGit)},args,{stdio:'inherit'});
child.on('error',()=>process.exit(127));child.on('exit',(code,signal)=>process.exit(code??(signal?143:1)));
`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.DEVBOX_TEST_GIT_LOG = batchLog;

const git = (repo, ...args) => execFileSync(realGit, ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let sequence = 0;
function fixture() {
  const root = path.join(temp, `case-${++sequence}`), repo = path.join(root, 'repo'), cacheRoot = path.join(root, 'state');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'source.txt'), 'fixture\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'root');
  const repoId = 'id-' + createHash('sha256').update(repo).digest('hex');
  return { repo, cacheRoot, repoId };
}
function batches() {
  try { return fs.readFileSync(batchLog, 'utf8').trim().split('\n').filter(Boolean).length; }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
}
const head = repo => git(repo, 'rev-parse', 'HEAD');
const scan = (f, options, mode = 'HEAD') => checkTransfer(f.repo, head(f.repo), mode, f.repoId, { cacheRoot: f.cacheRoot, ...options });

try {
  const parsed = fixture(), fake = 'fixtureValue123';
  fs.writeFileSync(path.join(parsed.repo, 'settings.json'), JSON.stringify({ ACCESS_KEY: fake, padding: 'line one\nline two' }));
  const binary = execFileSync('python3', ['-c', 'import plistlib,sys;sys.stdout.buffer.write(plistlib.dumps({"SCRECT_KEY":b"fixtureValue123"},fmt=plistlib.FMT_BINARY))']);
  fs.writeFileSync(path.join(parsed.repo, 'settings.plist'), binary);
  git(parsed.repo, 'add', '.'); git(parsed.repo, 'commit', '-qm', 'batch parser inputs');
  let before = batches();
  const parsedFindings = await scan(parsed, { scope: 'snapshot' });
  assert.equal(batches() - before, 1, 'all snapshot blobs use one cat-file batch');
  assert.ok(parsedFindings.some(hit => hit.path === 'settings.json' && hit.key === 'ACCESS_KEY'));
  assert.ok(parsedFindings.some(hit => hit.path === 'settings.plist' && hit.key === 'SCRECT_KEY'));

  const lockfile = fixture(), fakeAccess = 'AKIA' + '0'.repeat(16), fakeJwt = ['eyJmaXh0dXJl', 'eyJwYXlsb2Fk', 'Zml4dHVyZQ'].join('.');
  const manifest = {
    name: 'fixture', lockfileVersion: 3,
    packages: {
      'node_modules/js-tokens': { version: '1.0.0' },
      'node_modules/path-key': { version: '2.0.0', resolved: 'https://registry.example.invalid/path-key.tgz' },
    },
    dependencies: { 'js-tokens': { version: '1.0.0' }, 'path-key': { version: '2.0.0' } },
  };
  fs.writeFileSync(path.join(lockfile.repo, 'package-lock.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(lockfile.repo, 'package.json'), JSON.stringify({ dependencies: { 'js-tokens': '1.0.0', 'path-key': '2.0.0' } }));
  fs.writeFileSync(path.join(lockfile.repo, 'dependency-path.json'), JSON.stringify({ 'node_modules/path-key': { TOKEN: fake } }));
  git(lockfile.repo, 'add', '.'); git(lockfile.repo, 'commit', '-qm', 'generated dependency manifests');
  assert.deepEqual(await scan(lockfile, { scope: 'snapshot' }), [], 'package names and dependency paths are not credential keys');
  manifest.packages['node_modules/path-key'].resolved = 'https://fixture-user:fixture-pass@registry.example.invalid/path-key.tgz';
  fs.writeFileSync(path.join(lockfile.repo, 'package-lock.json'), JSON.stringify(manifest));
  git(lockfile.repo, 'add', '.'); git(lockfile.repo, 'commit', '-qm', 'embedded registry credential fixture');
  let lockFindings = await scan(lockfile, { scope: 'snapshot' });
  assert.ok(lockFindings.some(hit => hit.path === 'package-lock.json' && hit.key === 'EMBEDDED_URL_CREDENTIAL'));
  for (const host of ['example.com', 'sub.example.org:8443', 'example.net']) {
    manifest.packages['node_modules/path-key'].resolved = `https://fixture-user:fixture-pass@${host}/path-key.tgz`;
    fs.writeFileSync(path.join(lockfile.repo, 'package-lock.json'), JSON.stringify(manifest));
    git(lockfile.repo, 'add', '.'); git(lockfile.repo, 'commit', '-qm', `reserved documentation host ${host}`);
    assert.ok(!(await scan(lockfile, { scope: 'snapshot' })).some(hit => hit.key === 'EMBEDDED_URL_CREDENTIAL'), `reserved host ${host} is a sample, not a credential`);
  }
  manifest.packages['node_modules/path-key'].resolved = 'https://fixture-user:fixture-pass@example.com.evil.invalid/path-key.tgz';
  fs.writeFileSync(path.join(lockfile.repo, 'package-lock.json'), JSON.stringify(manifest));
  git(lockfile.repo, 'add', '.'); git(lockfile.repo, 'commit', '-qm', 'lookalike host');
  assert.ok((await scan(lockfile, { scope: 'snapshot' })).some(hit => hit.key === 'EMBEDDED_URL_CREDENTIAL'), 'lookalike host is still refused');
  manifest.packages['node_modules/path-key'].resolved = 'https://registry.example.invalid/path-key.tgz';
  manifest.packages['node_modules/path-key'].integrity = fakeAccess;
  fs.writeFileSync(path.join(lockfile.repo, 'package-lock.json'), JSON.stringify(manifest));
  git(lockfile.repo, 'add', '.'); git(lockfile.repo, 'commit', '-qm', 'access-key shape fixture');
  lockFindings = await scan(lockfile, { scope: 'snapshot' });
  assert.ok(lockFindings.some(hit => hit.path === 'package-lock.json' && hit.key === 'AKIA_ACCESS_KEY'));
  manifest.packages['node_modules/path-key'].integrity = fakeJwt;
  manifest._authToken = fake;
  fs.writeFileSync(path.join(lockfile.repo, 'package-lock.json'), JSON.stringify(manifest));
  git(lockfile.repo, 'add', '.'); git(lockfile.repo, 'commit', '-qm', 'JWT and auth-line shape fixtures');
  lockFindings = await scan(lockfile, { scope: 'snapshot' });
  assert.ok(lockFindings.some(hit => hit.path === 'package-lock.json' && hit.key === 'JWT'));
  assert.ok(lockFindings.some(hit => hit.path === 'package-lock.json' && hit.key === '_authToken'));

  const jsonLiteral = fixture();
  fs.writeFileSync(path.join(jsonLiteral.repo, 'config.json'), JSON.stringify({ TOKEN: fake, PASSWORD: 12345 }));
  git(jsonLiteral.repo, 'add', '.'); git(jsonLiteral.repo, 'commit', '-qm', 'JSON literal types');
  const jsonFindings = await scan(jsonLiteral, { scope: 'snapshot' });
  assert.ok(jsonFindings.some(hit => hit.key === 'TOKEN'));
  assert.ok(!jsonFindings.some(hit => hit.key === 'PASSWORD'), 'non-string JSON values do not trigger key heuristics');

  const jsonPaths = fixture();
  fs.writeFileSync(path.join(jsonPaths.repo, 'manifest.json'), JSON.stringify({ 'src/core/fx/frame_pass.cc': fake, _authToken: '${NPM_TOKEN}' }));
  git(jsonPaths.repo, 'add', '.'); git(jsonPaths.repo, 'commit', '-qm', 'JSON path key and auth reference');
  assert.deepEqual(await scan(jsonPaths, { scope: 'snapshot' }), [], 'manifest paths and referenced auth lines are not credential literals');

  const gradle = fixture();
  fs.writeFileSync(path.join(gradle.repo, 'gradle.properties'), `ACCESS_KEY=${fake}\nSCRECT_KEY=${fake}\nNEXUS_MAGIC_WORD=${fake}\n`);
  fs.writeFileSync(path.join(gradle.repo, 'build.gradle'), "android { signingConfigs { fixture { storePassword 'x' } } }\n");
  git(gradle.repo, 'add', '.'); git(gradle.repo, 'commit', '-qm', 'Gradle credential-like literals');
  const gradleFindings = await scan(gradle, { scope: 'snapshot' });
  for (const key of ['ACCESS_KEY', 'SCRECT_KEY', 'NEXUS_MAGIC_WORD', 'storePassword'])
    assert.ok(gradleFindings.some(hit => hit.key === key), `${key} remains fail-closed in Gradle config`);

  const source = fixture(), sourceDir = path.join(source.repo, 'src');
  fs.mkdirSync(sourceDir);
  fs.writeFileSync(path.join(sourceDir, 'Playback.kt'), `
private val passStart = "${fake}"
private val passCount = "${fake}"
private val keyboardVisible = "${fake}"
private const val KEYFRAMES_PER_SHOT = "${fake}"
private const val KEYFRAME_INTERVAL = "${fake}"
`);
  git(source.repo, 'add', '.'); git(source.repo, 'commit', '-qm', 'ordinary Kotlin identifiers');
  assert.deepEqual(await scan(source, { scope: 'snapshot' }), [], 'plain source uses value-shape detectors only');
  fs.writeFileSync(path.join(sourceDir, 'Playback.kt'), `private val publicFixture = "${fakeAccess}"\n`);
  git(source.repo, 'add', '.'); git(source.repo, 'commit', '-qm', 'source value-shape fixture');
  assert.ok((await scan(source, { scope: 'snapshot' })).some(hit => hit.key === 'AKIA_ACCESS_KEY'), 'source still applies value-shape detectors');

  const localized = fixture();
  const localizationDir = path.join(localized.repo, 'app', 'i18n');
  const assetDir = path.join(localized.repo, 'Assets.xcassets', 'Fixture.imageset');
  fs.mkdirSync(localizationDir, { recursive: true }); fs.mkdirSync(assetDir, { recursive: true });
  fs.writeFileSync(path.join(localizationDir, 'zh-CN.json'), JSON.stringify({ authToken: fake, PASS_LABEL: '请输入密码', keyboardVisible: fake }));
  fs.writeFileSync(path.join(assetDir, 'Contents.json'), JSON.stringify({ info: { author: fake, version: 1 } }));
  fs.writeFileSync(path.join(localized.repo, 'Localizable.strings'), `"authToken" = "${fake}";\n`);
  git(localized.repo, 'add', '.'); git(localized.repo, 'commit', '-qm', 'localized labels and asset metadata');
  assert.deepEqual(await scan(localized, { scope: 'snapshot' }), [], 'i18n JSON, strings, and asset catalogs use shape-only checks');

  const structured = fixture();
  fs.writeFileSync(path.join(structured.repo, 'config.json'), JSON.stringify({
    author: fake, passStart: fake, keyboardVisible: fake, RENDER_TOKEN: 'public', endpoint_key: 'https://example.invalid/public', password: 'x',
  }));
  git(structured.repo, 'add', '.'); git(structured.repo, 'commit', '-qm', 'structured key strength');
  const structuredFindings = await scan(structured, { scope: 'snapshot' });
  assert.deepEqual(structuredFindings.map(hit => hit.key), ['password'], 'author/camel weak names/public values pass while an exact strong name fails');

  const yamlStructure = fixture();
  fs.writeFileSync(path.join(yamlStructure.repo, 'config.yaml'), `fixture: { password: "x" }\ncommand: "fetch('/ready',{headers:{authorization: 'fixtureValue123'}})"\n`);
  git(yamlStructure.repo, 'add', '.'); git(yamlStructure.repo, 'commit', '-qm', 'structured inline keys and quoted code');
  const yamlFindings = await scan(yamlStructure, { scope: 'snapshot' });
  assert.deepEqual(yamlFindings.map(hit => hit.key), ['password'], 'inline YAML keys are scanned without treating code inside a quoted scalar as YAML keys');

  const symlinks = fixture(), schemas = path.join(symlinks.repo, 'schemas');
  fs.mkdirSync(schemas);
  fs.writeFileSync(path.join(schemas, 'material-card.schema.source.json'), '{"type":"object"}\n');
  fs.symlinkSync('material-card.schema.source.json', path.join(schemas, 'material-card.schema.json'));
  git(symlinks.repo, 'add', '.'); git(symlinks.repo, 'commit', '-qm', 'tracked internal schema symlink');
  assert.deepEqual(await scan(symlinks, { scope: 'snapshot' }), [], 'internal symlink to a tracked regular file passes');
  assert.deepEqual(await scan(symlinks, { scope: 'history' }), [], 'internal historical symlink to a tracked regular file passes');
  fs.unlinkSync(path.join(schemas, 'material-card.schema.json'));
  fs.symlinkSync('../../outside.json', path.join(schemas, 'material-card.schema.json'));
  git(symlinks.repo, 'add', '.'); git(symlinks.repo, 'commit', '-qm', 'escaping schema symlink');
  assert.ok((await scan(symlinks, { scope: 'snapshot' })).some(hit => hit.path === 'schemas/material-card.schema.json' && hit.key === 'SYMLINK_CONFIG'), 'escaping symlink fails');
  fs.unlinkSync(path.join(schemas, 'material-card.schema.json'));
  fs.writeFileSync(path.join(schemas, 'untracked.json'), '{}\n');
  fs.symlinkSync('untracked.json', path.join(schemas, 'material-card.schema.json'));
  git(symlinks.repo, 'add', 'schemas/material-card.schema.json'); git(symlinks.repo, 'commit', '-qm', 'untracked-target schema symlink');
  assert.ok((await scan(symlinks, { scope: 'snapshot' })).some(hit => hit.key === 'SYMLINK_CONFIG'), 'symlink to an untracked target fails');
  assert.ok((await scan(symlinks, { scope: 'snapshot' }, 'worktree')).some(hit => hit.key === 'SYMLINK_CONFIG'), 'worktree symlink to an untracked target fails');

  const repeated = fixture();
  fs.writeFileSync(path.join(repeated.repo, 'config.yaml'), `MAGIC_WORD: ${fake}\n`);
  git(repeated.repo, 'add', '.'); git(repeated.repo, 'commit', '-qm', 'finding is never clean-cached');
  before = batches();
  for (let run = 0; run < 2; run++) {
    const findings = await scan(repeated, { scope: 'snapshot' });
    assert.ok(findings.some(hit => hit.path === 'config.yaml' && hit.key === 'MAGIC_WORD'));
  }
  assert.equal(batches() - before, 2, 'a finding is read and reported on every run');

  const history = fixture();
  fs.writeFileSync(path.join(history.repo, 'old.yaml'), `ACCESS_KEY: ${fake}\n`);
  git(history.repo, 'add', '.'); git(history.repo, 'commit', '-qm', 'history-only finding');
  git(history.repo, 'rm', 'old.yaml'); git(history.repo, 'commit', '-qm', 'bundle base');
  const base = head(history.repo);
  fs.writeFileSync(path.join(history.repo, 'current.json'), '{"public":true}\n');
  git(history.repo, 'add', '.'); git(history.repo, 'commit', '-qm', 'incremental head');
  const limited = await scan(history, { scope: 'history', bases: [base] });
  assert.deepEqual(limited, [], 'base-reachable history is excluded');
  const full = await scan(history, { scope: 'history', bases: [] });
  assert.ok(full.some(hit => hit.path === 'old.yaml' && hit.key === 'ACCESS_KEY'), 'first-transfer history scans from the root');

  const cached = fixture();
  for (let i = 0; i < 128; i++) fs.writeFileSync(path.join(cached.repo, `public-${i}.json`), JSON.stringify({ enabled: true, index: i }) + '\n');
  git(cached.repo, 'add', '.'); git(cached.repo, 'commit', '-qm', 'many clean configs');
  process.env.DEVBOX_TEST_GIT_DELAY_MS = '2000';
  before = batches(); let started = Date.now();
  assert.deepEqual(await scan(cached, { scope: 'snapshot' }), []);
  const coldMs = Date.now() - started;
  started = Date.now();
  assert.deepEqual(await scan(cached, { scope: 'snapshot' }), []);
  const warmMs = Date.now() - started;
  delete process.env.DEVBOX_TEST_GIT_DELAY_MS;
  assert.equal(batches() - before, 1, 'cached OIDs need no second cat-file process');
  assert.ok(warmMs < coldMs, `cached scan should be faster (${warmMs}ms warm, ${coldMs}ms cold)`);

  console.log('PASS batched blob framing/binary plist, lockfile/JSON/source/i18n/asset rules, Gradle fail-closed literals, internal/escaping symlinks, clean-OID cache, repeated findings, base-limited/full history, cached timing');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
