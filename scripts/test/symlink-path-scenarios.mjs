#!/usr/bin/env node
// All launches use synthetic public account records and local mock transports.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalPath, canonicalLaunchArgv } from '../lib/launch-paths.mjs';
import { routeFixture } from './helpers/route-fixture.mjs';

const scripts = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'symlink-paths-')));
const real = path.join(tmp, 'real task'), linked = path.join(tmp, "linked task's dir");
const shared = path.join(tmp, 'shared'), accountHome = path.join(tmp, 'account');
fs.mkdirSync(real); fs.mkdirSync(shared); fs.mkdirSync(accountHome);
fs.symlinkSync(real, linked, 'dir');
const profiles = path.join(tmp, 'accounts.json'), cache = path.join(tmp, 'cache.json');
fs.writeFileSync(profiles, '{}');
const env = { ...process.env, RULES_SHARED: shared, CODEX_ACCOUNTS: profiles, CODEX_HUB: 'ws://127.0.0.1:1',
  QUOTA_CACHE: cache, QUOTA_LOG_FILE: path.join(shared, 'quota.jsonl'), ROUTE_LOG_FILE: path.join(shared, 'route.jsonl'),
  ROUTE_LOG: '0', ROUTE_NO_LIVE: '1', ROUTE_NOW: String(Date.now()), ORCHESTRATOR_PROJECT: '',
  ORCHESTRATOR_OWNER: '', CLAUDE_SESSION_ID: '', CLAUDE_JOB_DIR: '', CLAUDECODE: '', NODE_OPTIONS: '',
  PERSONAL_FALLBACK_FILE: path.join(tmp, 'fallback.json') };
fs.writeFileSync(env.PERSONAL_FALLBACK_FILE, '{"enabled":false}');
const rows = file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const makeStub = bin => {
  const stub = path.join(tmp, bin);
  fs.writeFileSync(stub, `#!/usr/bin/env node\nimport fs from 'node:fs';\nimport path from 'node:path';\nconst args=process.argv.slice(2);\nfs.writeFileSync(process.env.SYMLINK_CAPTURE,JSON.stringify({args,cwd:process.cwd()}));\nconst out=args[args.indexOf('-o')+1];fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,'DONE scratch\\n');\n`);
  fs.chmodSync(stub, 0o700);
  return stub;
};
const exec = (args, extra = {}) => {
  const r = spawnSync(process.execPath, args, { env: { ...env, ...extra }, encoding: 'utf8', timeout: 10000 });
  assert.equal(r.error, undefined, r.stderr + r.stdout);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return r;
};
const route = (kind, args) => {
  const now = Number(env.ROUTE_NOW);
  const account = { name: 'fixture', kind, home: accountHome, live: true, healthy: true, active: 0, seenAt: now,
    windows: [{ label: 'week', used: 10, resetsAt: now + 72 * 3600000, windowMins: 10080, scoped: false }],
    models: ['gpt-6.1-sol', 'gpt-5.6-terra', 'gpt-6-luna'], modelIds: { 'gpt-6.1-sol': 'GPT-6.1-Sol' },
    ssoExpiresAt: now + 3600000, hub: 'ws://127.0.0.1:1', windowsAvailable: true };
  fs.writeFileSync(profiles, JSON.stringify({ fixture: account }));
  fs.writeFileSync(cache, JSON.stringify({ checkedAt: now, claude: null, codexAccounts: [account], errors: {}, history: {} }));
  return JSON.parse(routeFixture(path.join(scripts, 'route.mjs'), [...args, '--cwd', linked, '--task-dir', linked,
    '--name', 'symlink-task', '--project', 'fixture', '--json'], { env, dir: tmp }));
};
let passed = 0;
const check = (label, fn) => { fn(); passed++; console.log(`ok   ${label}`); };
try {
  check('new destinations resolve through the nearest existing ancestor', () => {
    assert.equal(canonicalPath(path.join(linked, 'new', 'nested', 'last.md')), path.join(real, 'new', 'nested', 'last.md'));
    assert.equal(canonicalPath(path.relative(process.cwd(), linked)), real);
    const nested = path.join(real, 'nested'); fs.mkdirSync(nested);
    const deepLink = path.join(tmp, 'deep-link'); fs.symlinkSync(nested, deepLink, 'dir');
    assert.equal(canonicalPath(`${deepLink}/../brief.md`), path.join(real, 'brief.md'));
    assert.throws(() => canonicalPath(path.join(profiles, 'child')), { code: 'ENOTDIR' });
  });
  check('Codex exec and worker routes print canonical paths with shell quoting', () => {
    for (const args of [['image-gen'], ['implement', '--impact', 'throwaway']]) {
      const o = route('chatgpt', args);
      assert.equal(o.kind, 'launch', JSON.stringify(o.plan.reasons ?? o.needsUserOK)); assert.equal(o.plan.task.cwd, real); assert.equal(o.plan.task.taskDir, real);
      assert.ok(!o.pick.command.includes(linked));
      assert.ok(o.pick.command.includes(`Read ${real}/brief.md and follow it.`));
      assert.ok(o.pick.workerArgs.includes(path.join(real, 'codex-last.md')));
      assert.ok(o.pick.workerArgs.includes(path.join(real, 'codex.jsonl')));
      assert.equal(o.plan.task.flags['task-dir'], real);
    }
  });
  check('TRAE and TTADK routes use the same canonical task paths', () => {
    for (const kind of ['trae', 'ttadk']) {
      const o = route(kind, ['implement', '--impact', 'throwaway']);
      assert.equal(o.kind, 'launch'); assert.ok(!o.pick.command.includes(linked));
      assert.ok(o.pick.workerArgs.includes(real));
    }
  });
  check('printed image-gen shell command executes with canonical paths', () => {
    makeStub('codex');
    const o = route('chatgpt', ['image-gen']), capture = path.join(tmp, 'printed-argv.json');
    assert.equal(o.pick.launcher, 'codex-exec');
    const r = spawnSync('/bin/sh', ['-c', o.pick.command], { env: { ...env,
      PATH: `${tmp}${path.delimiter}${process.env.PATH}`, SYMLINK_CAPTURE: capture }, encoding: 'utf8', timeout: 10000 });
    assert.equal(r.error, undefined, r.stderr + r.stdout); assert.equal(r.status, 0, r.stderr + r.stdout);
    const got = JSON.parse(fs.readFileSync(capture, 'utf8'));
    assert.equal(got.args[got.args.indexOf('-C') + 1], real);
    assert.equal(got.args[got.args.indexOf('-o') + 1], path.join(real, 'codex-last.md'));
    assert.equal(got.args.at(-1), `Read ${real}/brief.md and follow it.`);
    assert.equal(fs.readFileSync(path.join(real, 'codex-last.md'), 'utf8'), 'DONE scratch\n');
    fs.unlinkSync(path.join(real, 'codex-last.md')); fs.unlinkSync(path.join(real, 'codex.jsonl'));
  });
  check('routing follows existing brief and output file symlinks', () => {
    for (const [name, target] of [['brief.md', 'source.md'], ['codex-last.md', 'final.md'], ['codex.jsonl', 'events.jsonl']]) {
      fs.writeFileSync(path.join(real, target), 'scratch'); fs.symlinkSync(target, path.join(real, name));
    }
    const o = route('chatgpt', ['image-gen']);
    assert.ok(o.pick.command.includes(`Read ${real}/source.md and follow it.`));
    assert.ok(o.pick.workerArgs.includes(path.join(real, 'final.md')));
    assert.ok(o.pick.workerArgs.includes(path.join(real, 'events.jsonl')));
  });
  check('direct Codex and TRAE exec helpers pass canonical cwd, output and brief', () => {
    for (const bin of ['codex', 'traex', 'traecli']) {
      const stub = makeStub(bin), capture = path.join(tmp, `${bin}-argv.json`);
      const out = path.join(linked, 'new', `${bin}.md`), log = path.join(linked, 'new', `${bin}.jsonl`);
      exec([path.join(scripts, 'run-tracked.mjs'), '--account', 'fixture', '--name', bin, '--cwd', linked,
        '--out', out, '--log', log, '--', stub, 'exec', '-C', linked, '-o', out,
        `Read ${linked}/brief.md and follow it.`], { SYMLINK_CAPTURE: capture });
      const got = JSON.parse(fs.readFileSync(capture, 'utf8'));
      assert.equal(got.cwd, real); assert.equal(got.args[got.args.indexOf('-C') + 1], real);
      assert.equal(got.args[got.args.indexOf('-o') + 1], path.join(real, 'new', `${bin}.md`));
      assert.equal(got.args.at(-1), `Read ${real}/source.md and follow it.`);
      assert.equal(fs.readFileSync(out, 'utf8'), 'DONE scratch\n');
      assert.equal(rows(path.join(shared, 'worker-events.jsonl')).at(-1).outFile, path.join(real, 'new', `${bin}.md`));
    }
  });
  check('exec long options and equals forms resolve file and directory paths', () => {
    assert.deepEqual(canonicalLaunchArgv(['exec', `--cd=${linked}`, '--output-last-message', path.join(linked, 'new', 'equals.md')]),
      ['exec', `--cd=${real}`, '--output-last-message', path.join(real, 'new', 'equals.md')]);
    assert.equal(canonicalLaunchArgv(['exec', '-C', linked, 'Read brief.md and follow it.']).at(-1),
      `Read ${real}/source.md and follow it.`);
  });
  check('worker start and inherited turn persist canonical launch metadata', () => {
    route('trae', ['implement', '--impact', 'throwaway']);
    const rpc = path.join(tmp, 'rpc.jsonl'), out = path.join(linked, 'worker.md'), log = path.join(linked, 'worker.jsonl');
    const transport = path.join(scripts, 'test/fixtures/worker-guards-transport.mjs');
    const prefix = ['--import', transport, path.join(scripts, 'codex-worker.mjs'), '--account', 'fixture'];
    const extra = { WORKER_GUARDS_FIXTURE: JSON.stringify({ thread: 'symlink-thread', rpc }) };
    exec([...prefix, 'start', '--cwd', linked, '--out', out, '--log', log, '--model', 'gpt-6.1-sol',
      '--effort', 'high', '--sandbox', 'read-only', 'Read brief.md and follow it.'], extra);
    assert.equal(rows(rpc).find(r => r.method === 'thread/start').params.cwd, real);
    assert.equal(rows(rpc).find(r => r.method === 'turn/start').params.input[0].text, `Read ${real}/source.md and follow it.`);
    const launch = JSON.parse(fs.readFileSync(path.join(shared, 'worker-launches/fixture/symlink-thread.json'), 'utf8'));
    assert.equal(launch.defaults.cwd, real); assert.equal(launch.defaults.out, path.join(real, 'worker.md'));
    assert.equal(launch.defaults.log, path.join(real, 'worker.jsonl'));
    fs.unlinkSync(out);
    exec([...prefix, 'turn', '--thread', 'symlink-thread', '--effort', 'high', `Read ${linked}/brief.md and follow it.`], extra);
    assert.match(fs.readFileSync(out, 'utf8'), /DONE guard fixture/);
    assert.equal(rows(path.join(shared, 'worker-events.jsonl')).at(-1).outFile, path.join(real, 'worker.md'));
  });
  console.log(`Symlink paths: ${passed}/${passed} passed`);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
