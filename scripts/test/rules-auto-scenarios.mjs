#!/usr/bin/env node
// Fixture-only hook delivery, acknowledgement and audit coverage. No settings or live shared-state writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditGlobalRules } from '../lib/global-rules-audit.mjs';

const scripts = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-auto-'));
const shared = path.join(tmp, '_shared'), ledgerRoot = path.join(tmp, 'ledgers'), digestFile = path.join(tmp, 'digest.md');
const stateFile = path.join(shared, 'rules-seen.json');
const env = { ...process.env, HOME: tmp, RULES_SHARED: shared, RULES_DIGEST: digestFile, RULES_LEDGER_ROOT: ledgerRoot,
  CODEX_WORKER_THREAD: '', CODEX_WORKER_ACCOUNT: '', CLAUDE_ENV_FILE: '' };
const v1 = '2026-11-16.9', v2 = '2026-11-16.10', v3 = '2026-11-16.11';
const digest = (version, extra = '') => `# Global Rules\nversion: ${version}\n\n## Changes In This Version\n- Prior change.\n\n## Orchestrator Rules\n- Unchanged orchestrator rule.\n\n## Worker Rules\n- Unchanged worker rule.\n${extra}\n## Details\nDetails link.\n`;
const event = (id, extra = {}) => ({ session_id: id, hook_event_name: 'Stop', stop_hook_active: false,
  session_title: `${id} 主对话`, project: 'fixture', cwd: tmp, ...extra });
const start = (id, extra = {}) => event(id, { hook_event_name: 'SessionStart', source: 'startup', ...extra });
const run = (script, input, extra = {}) => {
  const r = spawnSync(process.execPath, [path.join(scripts, script)], { env: { ...env, ...extra }, input: JSON.stringify(input),
    encoding: 'utf8', timeout: 5000 });
  assert.equal(r.status, 0, r.stderr + String(r.error ?? '')); assert.equal(r.stderr, '');
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
};
const stop = (id, extra = {}) => run('worker-inbox-hook.mjs', event(id, extra));
const seen = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const invokeAsync = (input) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(scripts, 'worker-inbox-hook.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (b) => { out += b; }); child.stderr.on('data', (b) => { err += b; });
  child.on('error', reject);
  child.on('close', (code) => { try { assert.equal(code, 0, err); assert.equal(err, ''); resolve(out ? JSON.parse(out) : null); } catch (e) { reject(e); } });
  child.stdin.end(JSON.stringify(input));
});
try {
  fs.mkdirSync(shared); fs.mkdirSync(ledgerRoot);
  fs.writeFileSync(digestFile, digest(v1));
  assert.match(run('rules-digest-hook.mjs', start('mid')).hookSpecificOutput.additionalContext, /First injection/);
  const initial = seen().mid;
  assert.equal(initial.version, v1); assert.equal(initial.host, os.hostname()); assert.equal(initial.title, 'mid 主对话');
  assert.equal(initial.project, 'fixture'); assert.ok(Number.isFinite(initial.at));
  fs.writeFileSync(digestFile, digest(v2, '- New version test rule.'));
  assert.equal(stop('mid', { stop_hook_active: true }), null); assert.equal(seen().mid.version, v1);
  const delivered = stop('mid');
  assert.deepEqual(delivered, { decision: 'block', reason: `Changes since the version you last saw (${v1} -> ${v2}):\nAdded/changed:\n- New version test rule.` });
  assert.equal(seen().mid.version, v2); assert.ok(seen().mid.at >= initial.at);
  assert.equal(stop('mid'), null); assert.equal(stop('mid', { stop_hook_active: true }), null);
  console.log('PASS mid-session numeric version bump: delta-only Stop blocks once, then records host/title/project/time acknowledgement');

  assert.equal(stop('worker', { session_title: 'Worker', cwd: tmp }), null);
  assert.equal(stop('ordinary', { session_title: 'Ordinary session', cwd: tmp }), null);
  assert.equal(run('rules-digest-hook.mjs', start('ordinary', { session_title: 'Ordinary session' })), null);
  fs.mkdirSync(path.join(shared, 'worker-context/fixture'), { recursive: true });
  // A worker's explicit public identity must win even if its cwd/title/cache would otherwise match.
  const beforeWorker = seen(); beforeWorker.worker = { ...initial, orchestrator: true }; fs.writeFileSync(stateFile, JSON.stringify(beforeWorker));
  fs.writeFileSync(path.join(shared, 'worker-context/fixture/worker.json'), JSON.stringify({ account: 'fixture', thread: 'worker', owner: 'owner' }));
  for (const input of [event('worker', { cwd: path.dirname(scripts) }), start('worker', { cwd: path.dirname(scripts) })]) {
    assert.equal(run(input.hook_event_name === 'Stop' ? 'worker-inbox-hook.mjs' : 'rules-digest-hook.mjs', input), null);
  }
  assert.equal(seen().worker.version, v1);
  delete beforeWorker.worker; fs.writeFileSync(stateFile, JSON.stringify(beforeWorker));
  assert.equal(run('rules-digest-hook.mjs', start('env-worker'), { CODEX_WORKER_THREAD: 'env-worker' }), null);
  assert.equal(run('rules-digest-hook.mjs', start('agent-worker', { agent_id: 'subagent' })), null);
  console.log('PASS worker/non-orchestrator exclusions, including worker metadata before cached/cwd/title recognition');

  // Resume through the inbox hook and compact through the digest hook race on the same saved version.
  fs.writeFileSync(digestFile, digest(v3, '- Latest version rule.'));
  const resumed = run('worker-inbox-hook.mjs', start('mid', { source: 'resume' }));
  assert.match(resumed.hookSpecificOutput.additionalContext, /Latest version rule/);
  assert.doesNotMatch(resumed.hookSpecificOutput.additionalContext, /Unchanged|# Global Rules/);
  assert.match(resumed.hookSpecificOutput.additionalContext, /Removed\/replaced:\n- New version test rule/);
  assert.equal(seen().mid.version, v3);
  assert.match(run('rules-digest-hook.mjs', start('mid', { source: 'compact' })).hookSpecificOutput.additionalContext, /No changes/);
  assert.equal(run('worker-inbox-hook.mjs', start('mid', { source: 'compact' })), null);
  console.log('PASS SessionStart reuses delta and ack; the other existing hook never repeats it');

  fs.writeFileSync(digestFile, digest(v1)); run('rules-digest-hook.mjs', start('combined'));
  const previousShared = process.env.RULES_SHARED; process.env.RULES_SHARED = shared;
  const { appendEvent, readAck, readEvents, inbox } = await import('../lib/worker-events.mjs');
  const row = appendEvent({ owner: 'combined', runId: 'finished-fixture', event: 'finished', name: 'fixture-work',
    outFile: path.join(tmp, 'result.md'), finalLine: 'DONE fixture', launcher: { sessionId: 'combined' } });
  if (previousShared === undefined) delete process.env.RULES_SHARED; else process.env.RULES_SHARED = previousShared;
  fs.writeFileSync(digestFile, digest(v2, '- New version test rule.'));
  const combined = stop('combined');
  assert.equal(combined.decision, 'block'); assert.match(combined.reason, /fixture-work/); assert.match(combined.reason, /result.md/);
  assert.match(combined.reason, /Changes since.*2026-11-16.9 -> 2026-11-16.10/);
  assert.doesNotMatch(combined.reason, /Unchanged/); assert.equal(seen().combined.version, v2);
  process.env.RULES_SHARED = shared;
  assert.ok(readAck('combined').highWater >= row.seq); assert.equal(inbox(readEvents(), 'combined', readAck('combined')).pending.length, 0);
  if (previousShared === undefined) delete process.env.RULES_SHARED; else process.env.RULES_SHARED = previousShared;
  assert.equal(stop('combined'), null);
  console.log('PASS inbox and rules produce one block reason and both acknowledgements');

  const goodState = fs.readFileSync(stateFile, 'utf8');
  for (const corrupt of ['{broken', '[]', 'null', '', '{"mid":null}', '{"__versions":[]}']) {
    fs.writeFileSync(stateFile, corrupt);
    assert.equal(stop('combined'), null); assert.equal(run('rules-digest-hook.mjs', start('combined')), null);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), corrupt);
  }
  fs.writeFileSync(stateFile, goodState);
  fs.mkdirSync(`${stateFile}.lock`);
  fs.writeFileSync(digestFile, digest(v3, '- Latest version rule.'));
  assert.equal(stop('combined'), null); assert.equal(seen().combined.version, v2);
  fs.rmdirSync(`${stateFile}.lock`);
  assert.ok(stop('combined')); assert.equal(fs.existsSync(`${stateFile}.lock`), false);
  console.log('PASS corrupt/empty state and contention fail open without overwriting acknowledgements');

  fs.writeFileSync(digestFile, digest(v1)); run('rules-digest-hook.mjs', start('fault'));
  fs.writeFileSync(digestFile, digest(v2, '- New version test rule.'));
  const faultModule = path.join(tmp, 'fault.mjs');
  fs.writeFileSync(faultModule, `import fs from 'node:fs/promises';
const write=fs.writeFile;
fs.writeFile=(file,...args)=>String(file).includes('rules-seen.json.')
  ? process.env.RULES_FAULT==='stall' ? new Promise(()=>{}) : Promise.reject(Error('fixture write failure')) : write(file,...args);
`);
  for (const mode of ['error', 'stall']) {
    const at = Date.now();
    const r = spawnSync(process.execPath, ['--import', faultModule, path.join(scripts, 'worker-inbox-hook.mjs')], {
      env: { ...env, RULES_FAULT: mode }, input: JSON.stringify(event('fault')), encoding: 'utf8', timeout: 2000 });
    assert.equal(r.status, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
    assert.ok(Date.now() - at < 2000, 'stalled rules I/O stays within the hook timeout');
    assert.equal(seen().fault.version, v1); assert.equal(fs.existsSync(`${stateFile}.lock`), false);
  }
  const outputFault = path.join(tmp, 'output-fault.mjs');
  fs.writeFileSync(outputFault, `process.stdout.write=(text,cb)=>{queueMicrotask(()=>cb(Error('fixture closed output')));return true;};`);
  const closed = spawnSync(process.execPath, ['--import', outputFault, path.join(scripts, 'worker-inbox-hook.mjs')], {
    env, input: JSON.stringify(event('fault')), encoding: 'utf8', timeout: 2000 });
  assert.equal(closed.status, 0); assert.equal(closed.stdout, ''); assert.equal(closed.stderr, '');
  assert.equal(seen().fault.version, v1); assert.equal(fs.existsSync(`${stateFile}.lock`), false);
  assert.ok(stop('fault')); assert.equal(seen().fault.version, v2);
  console.log('PASS failed/stalled state writes and closed output do not acknowledge; deadline cleanup and retry recover');

  fs.writeFileSync(digestFile, digest(v1));
  for (const id of ['race', 'merge-a', 'merge-b']) run('rules-digest-hook.mjs', start(id));
  fs.writeFileSync(digestFile, digest(v2, '- New version test rule.'));
  const raced = await Promise.all([invokeAsync(event('race')), invokeAsync(event('race'))]);
  assert.equal(raced.filter(Boolean).length, 1); assert.equal(seen().race.version, v2);
  await Promise.all([invokeAsync(event('merge-a')), invokeAsync(event('merge-b'))]);
  // Nonblocking contention retries on the next Stop, without overwriting the other session's ack.
  stop('merge-a'); stop('merge-b');
  assert.equal(seen()['merge-a'].version, v2); assert.equal(seen()['merge-b'].version, v2);
  console.log('PASS concurrent hooks deliver one delta and retain independent session acknowledgements');

  const project = path.join(ledgerRoot, 'fixture'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'ledger.md'), `Orchestrator session: combined 主对话\nrules-ack ${v1}\n`);
  const legacy = path.join(ledgerRoot, 'legacy'); fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, 'ledger.md'), `- **Orchestrator session**: "Legacy 主对话"\n- **rules-ack**: \`${v2}\`\n`);
  fs.writeFileSync(path.join(shared, 'orchestrators.txt'), '# roster\ncombined 主对话\nRemote 主对话\n');
  const list = spawnSync(process.execPath, [path.join(scripts, 'rules-worker-digest.mjs'), '--acks'], { env, encoding: 'utf8' });
  assert.equal(list.status, 0); assert.match(list.stdout, /session\thost\tproject\/title\tversion seen\tseen at/);
  assert.match(list.stdout, /combined\t.*fixture.*2026-11-16.11\t\d{4}-.*\thook/);
  assert.match(list.stdout, /Legacy 主对话.*2026-11-16.10.*UNKNOWN.*ledger/);
  assert.match(list.stdout, /Remote 主对话.*UNKNOWN.*roster/);
  const audit = auditGlobalRules({ records: [], version: v3, since: 0, ledgerRoot, shared });
  const automatic = audit.acknowledgements.find((ack) => ack.session === 'combined');
  assert.equal(automatic.source, 'hook'); assert.equal(automatic.version, v3); assert.equal(automatic.current, true);
  assert.equal(audit.acknowledgements[0].session, 'combined', 'exact ledger identity wins over newer acks in the same project');
  assert.equal(audit.acknowledgements.find((ack) => ack.project === 'legacy').source, 'ledger');
  assert.equal(audit.acknowledgements.find((ack) => ack.orchestrator === 'Remote 主对话').status, 'UNKNOWN');
  assert.ok(!audit.byOrchestrator['combined 主对话']);
  console.log('PASS --acks listing and nightly audit prefer code acknowledgements, preserve ledger fallback and remote UNKNOWN');

  // A quiet orchestrator still needs its snapshot after more than eight owner revisions.
  fs.writeFileSync(digestFile, digest(v1)); run('rules-digest-hook.mjs', start('quiet'));
  for (let revision = 12; revision <= 21; revision++) {
    fs.writeFileSync(digestFile, digest(`2026-11-16.${revision}`, `- Revision ${revision} rule.`));
    if (revision === 12) run('rules-digest-hook.mjs', start('active')); else stop('active');
  }
  assert.ok(seen().__versions[v1]);
  assert.match(stop('quiet').reason, /Revision 21 rule/); assert.equal(seen().quiet.version, '2026-11-16.21');
  console.log('PASS quiet-session snapshots survive more than eight revisions for exact later deltas');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
