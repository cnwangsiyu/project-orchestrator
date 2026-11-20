#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyCompletion, completionEvidence, completionLeases, TRUNCATED_EXIT } from '../lib/worker-completion.mjs';
import { resolveTurnState } from '../lib/worker-turn.mjs';
import { terminalWorker } from '../lib/worker-running.mjs';
import { readEventHistory, eventLine, hookEventLine } from '../lib/worker-events.mjs';

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-completion-'));
const owner = '053283ad-1bc8-5a31-ad44-d68e6b199eb6';
const final = 'DONE synthetic work.';
const item = (text = final, phase = 'final_answer') => ({ id: 'final-item', type: 'agentMessage', phase, text });
const completed = { id: 'guard-turn', status: 'completed', items: [item()] };
const messages = [{ method: 'item/completed', params: { threadId: 'guard-thread', turnId: 'guard-turn', item: item() } }];
const records = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
let serial = 0;
function run(config = {}, options = {}) {
  const dir = path.join(tmp, String(++serial)), home = path.join(dir, 'account'); fs.mkdirSync(home, { recursive: true });
  const profiles = path.join(dir, 'accounts.json'), out = path.join(dir, 'last.md'), rpc = path.join(dir, 'rpc.log');
  fs.writeFileSync(profiles, JSON.stringify({ fixture: { kind: 'trae', home, hub: 'ws://127.0.0.1:1', modelIds: { 'gpt-6.1-sol': 'GPT-6.1-Sol' } } }));
  if (options.lease) {
    fs.mkdirSync(path.join(dir, 'locks', 'devbox-cn-light-1.d'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'resources.tsv'), 'devbox-cn-light-1\tdevbox\topen\t-\tfixture\n');
    fs.writeFileSync(path.join(dir, 'locks', 'devbox-cn-light-1.d', 'info'), `by\t${options.lease}\nproject\tfixture\ntask\tfixture\npid\t12345\n`);
  }
  fs.writeFileSync(path.join(dir, 'fallback.json'), '{"enabled":false}');
  const env = { ...process.env, HOME: dir, RULES_SHARED: dir, RES_DIR: dir, QUOTA_CACHE: path.join(dir, 'quota.json'),
    CODEX_HOME: home, CODEX_ACCOUNTS: profiles, ROUTE_LOG_FILE: path.join(dir, 'route.log'),
    PERSONAL_FALLBACK_FILE: path.join(dir, 'fallback.json'), NODE_OPTIONS: '', ORCHESTRATOR_OWNER: '',
    CLAUDE_JOB_DIR: '', CLAUDECODE: '', CODEX_WORKER_PERIODIC_MS: '30',
    WORKER_GUARDS_FIXTURE: JSON.stringify({ thread: 'guard-thread', rpc, final, messages, ...config }) };
  const args = ['--import', path.join(scripts, 'test/fixtures/worker-completion-transport.mjs'), path.join(scripts, 'codex-worker.mjs'),
    '--account', 'fixture', options.wait ? 'wait' : 'start', '--thread', 'guard-thread',
    ...(options.wait ? [] : ['--cwd', dir, '--sandbox', 'read-only', '--model', 'gpt-6.1-sol', '--effort', 'high']),
    '--owner', owner, '--name', 'fixture', '--out', out, '--by', 'worker-holder',
    ...(options.wait ? [] : ['Complete the synthetic brief.'])];
  const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 7000 });
  assert.equal(result.error, undefined, result.stderr + result.stdout);
  return { ...result, dir, env, out, events: records(path.join(dir, 'worker-events.jsonl')), rpc: records(rpc) };
}
const truncated = result => {
  assert.equal(result.status, TRUNCATED_EXIT, result.stderr + result.stdout);
  const event = result.events.find(event => event.event === 'truncated'); assert.ok(event);
  assert.equal(event.status, 'TRUNCATED'); assert.equal(event.exit, TRUNCATED_EXIT);
  const note = result.events.find(event => event.kind === 'risk'); assert.ok(note?.wake);
  assert.ok(note.text.includes('Reply tail: ')); assert.doesNotMatch(note.text, /\[object Object\]/);
  assert.match(note.text, /Continue: .*turn.*--thread.*guard-thread/);
  assert.equal(result.rpc.filter(rpc => rpc.method === 'turn/start').length, 1, 'no automatic continuation');
  return event;
};
try {
  for (const field of ['finish_reason', 'stopReason']) {
    const result = run({ terminal: { [field]: 'max_tokens' } });
    assert.match(truncated(result).reason, /output limit/);
    assert.equal(fs.readFileSync(result.out, 'utf8').trim(), final);
  }
  console.log('PASS transport stop reasons produce TRUNCATED exit 11, preserve output, wake owner, and never auto-continue');

  const missing = run({ omitCompletion: true, disconnect: true, messages: [{ method: 'item/agentMessage/delta',
    params: { threadId: 'guard-thread', turnId: 'guard-turn', itemId: 'final-item', delta: 'The controller is' } }] });
  const missingEvent = truncated(missing); assert.match(missingEvent.reason, /without turn-completed/);
  assert.equal(missingEvent.mayRun, true); assert.equal(fs.readFileSync(missing.out, 'utf8').trim(), 'The controller is');
  assert.equal(resolveTurnState({ account: 'fixture', thread: 'guard-thread', rows: missing.events,
    result: { thread: { turns: [{ id: missingEvent.turn, status: 'inProgress' }] } }, alive: () => false }).turn.status, 'inProgress');
  console.log('PASS disconnected stream without final item or completion event preserves partial text and uncertain live state');

  const earlyComplete = run({ terminal: { items: [] }, messages: [{ method: 'item/agentMessage/delta',
    params: { threadId: 'guard-thread', turnId: 'guard-turn', itemId: 'final-item', delta: 'The controller is' } }] });
  assert.match(truncated(earlyComplete).reason, /no completed final agent item/);
  assert.equal(fs.readFileSync(earlyComplete.out, 'utf8').trim(), 'The controller is');
  console.log('PASS completed frame with an unfinished final item preserves the streamed fragment');

  const lostEvent = run({ omitCompletion: true, status: 'completed' });
  assert.equal(lostEvent.status, 0, lostEvent.stderr + lostEvent.stdout);
  assert.equal(lostEvent.events.some(event => event.event === 'truncated'), false);
  assert.equal(lostEvent.rpc.filter(rpc => rpc.method === 'turn/start').length, 1);
  console.log('PASS confirmed complete final from periodic read succeeds when the completion event was omitted');

  const commentary = run({ messages: [{ method: 'item/completed', params: { threadId: 'guard-thread', turnId: 'guard-turn', item: item('The controller is', 'commentary') } }],
    terminal: { items: [item('The controller is', 'commentary')] } });
  assert.match(truncated(commentary).reason, /commentary/);
  console.log('PASS W511 pattern: a completed turn containing only commentary is TRUNCATED');

  for (const holder of ['worker-holder', 'codex:guard-thread']) {
    const result = run({}, { lease: holder });
    assert.deepEqual(truncated(result).leases.map(lease => lease.id), ['devbox-cn-light-1']);
    assert.equal(fs.existsSync(path.join(result.dir, 'locks/devbox-cn-light-1.d/info')), true);
  }
  const unrelated = run({}, { lease: 'another-task' });
  // Task labels are also bound in this fixture; verify unrelated holder through the pure lease reader.
  assert.equal(completionLeases({ shared: unrelated.dir, by: 'worker-holder', thread: 'other-thread' }).held.length, 0);
  console.log('PASS worker --by and thread identities detect held leases without returning or modifying resources');

  const normal = run(); assert.equal(normal.status, 0, normal.stderr + normal.stdout);
  assert.equal(normal.events.at(-1).event, 'finished'); assert.equal(normal.events.some(event => event.kind === 'risk'), false);
  const legacy = run({ messages: [], terminal: { items: [{ type: 'agentMessage', text: final }] } });
  assert.equal(legacy.status, 0, legacy.stderr + legacy.stdout);
  const reattach = run({ status: 'completed' }, { wait: true }); assert.equal(reattach.status, 0, reattach.stderr + reattach.stdout);
  const emptyHistory = run({ status: 'completed', historyItems: [[]] }, { wait: true });
  assert.equal(emptyHistory.status, 0, emptyHistory.stderr + emptyHistory.stdout);
  const recoveredCommentary = run({ status: 'completed', historyItems: [[], [item('The controller is', 'commentary')]] }, { wait: true });
  assert.equal(recoveredCommentary.status, TRUNCATED_EXIT, recoveredCommentary.stderr + recoveredCommentary.stdout);
  assert.match(recoveredCommentary.events.find(event => event.event === 'truncated').reason, /commentary/);
  const failed = run({ failure: 'synthetic provider failure', messages: [] }); assert.equal(failed.status, 1);
  assert.equal(failed.events.some(event => event.event === 'truncated'), false);
  console.log('PASS normal completion, legacy final items, completed wait reattachment, and provider failures retain existing paths');

  const evidence = completionEvidence(); evidence.observe(messages[0]);
  assert.equal(classifyCompletion({ turn: completed, evidence: evidence.snapshot(), final }), null);
  assert.equal(classifyCompletion({ turn: completed, evidence: evidence.snapshot(), final, live: true, completedEvent: false }), null);
  assert.ok(classifyCompletion({ turn: completed, evidence: evidence.snapshot(), final, live: true, completedEvent: false, unconfirmed: true }));
  const recovered = run({ messages: [{ method: 'error', params: { threadId: 'guard-thread', turnId: 'guard-turn',
    error: { message: 'retriable stream disconnect', willRetry: true } } }, ...messages] });
  assert.equal(recovered.status, 0, recovered.stderr + recovered.stdout);
  const limited = completionEvidence();
  limited.observe({ method: 'response/metadata', params: { finish_reason: 'length' } });
  limited.observe(messages[0]);
  assert.ok(classifyCompletion({ turn: completed, evidence: limited.snapshot(), final }),
    'later item completion cannot erase an observed output-limit stop');
  assert.equal(classifyCompletion({ turn: { ...completed, items: [] } }), null,
    'an empty historical completed view supplies no truncation evidence');
  assert.ok(classifyCompletion({ turn: { ...completed, items: [] }, live: true }),
    'a live completed turn must supply a completed final item');
  assert.ok(classifyCompletion({ turn: { ...completed, items: [] }, leases: [{ id: 'held' }] }));
  assert.ok(classifyCompletion({ turn: { ...completed, status: 'failed', stop_reason: 'length' }, final }));
  assert.ok(classifyCompletion({ turn: { ...completed, items: [item(), item('cut off', 'commentary')] }, final }));
  evidence.observe({ method: 'item/agentMessage/delta', params: { itemId: 'next-final', delta: 'cut off' } });
  assert.ok(classifyCompletion({ turn: completed, evidence: evidence.snapshot(), final }));
  assert.match(classifyCompletion({ turn: completed, final, requiredMarker: 'WORKER-END' }).reasons.join(';'), /marker/);
  assert.equal(classifyCompletion({ turn: completed, final: final + '\nWORKER-END', requiredMarker: 'WORKER-END' }), null);
  const event = commentary.events.find(event => event.event === 'truncated');
  const printed = eventLine({ ...commentary.events.find(event => event.alertId?.startsWith('truncated:')),
    text: 'delivery skipped finished' });
  assert.match(printed, /^\[truncated\]/); assert.doesNotMatch(printed, /deliver|skip|finish/i);
  assert.match(eventLine(event), /^\[truncated\]/);
  assert.match(hookEventLine(event), /^\[truncated\]/); assert.doesNotMatch(hookEventLine(event), /deliver|skip|finish/i);
  assert.equal(terminalWorker(event), true);
  assert.equal(classifyCompletion({ turn: { ...completed, status: 'TRUNCATED', reason: event.reason }, final }).status, 'TRUNCATED');
  assert.equal(resolveTurnState({ account: 'fixture', thread: 'guard-thread', rows: commentary.events,
    result: { thread: { turns: [{ ...completed, id: event.turn }] } }, alive: () => false }).turn.status, 'TRUNCATED');
  const display = spawnSync(process.execPath, [path.join(scripts, 'quota.mjs'), '--running', '--json'], {
    env: commentary.env, encoding: 'utf8', timeout: 5000 });
  assert.equal(display.status, 0, display.stderr);
  assert.equal(JSON.parse(display.stdout).truncated[0].status, 'TRUNCATED');
  const priorShared = process.env.RULES_SHARED; process.env.RULES_SHARED = commentary.dir;
  assert.ok(readEventHistory().some(row => row.status === 'TRUNCATED'));
  if (priorShared === undefined) delete process.env.RULES_SHARED; else process.env.RULES_SHARED = priorShared;
  console.log('PASS marker checking stays opt-in; local TRUNCATED overrides hub completed and appears in quota/history');
  console.log('all pass');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
