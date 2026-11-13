#!/usr/bin/env node
// Synthetic telemetry and the real quota/worker entry points with provider I/O stubbed. No live accounts or requests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { BALANCE, parseTraeModels, readTraeModels, freshLoad, freshQueue, readQueueState, writeQueueState,
  companySnapshot, readQuotaHistory } from '../lib/company-load.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'company-telemetry-'));
const now = Date.now(), min = 60000, SOL = 'gpt-6.1-sol';
const catalog = { models: [{ id: 'GPT-6.1-Sol', _meta: { trae: { load: { percent: 35 } } }, message: 'discard-me' },
  { slug: 'DeepSeek-V4.1-Flash', _meta: { trae: { load: { percent: '59' } } } },
  { id: 'bad/id', _meta: { trae: { load: { percent: 20 } } } },
  { id: 'GPT-6-Astra', _meta: { trae: { load: { percent: null } } } }] };
const exec = childProcess.execFileSync;
try {
  const parsed = parseTraeModels(catalog, now);
  assert.equal(parsed.load[SOL].percent, 35);
  assert.equal(parsed.load['deepseek-v4.1-flash'].percent, 59);
  assert.equal(parsed.load['gpt-6-astra'], undefined);
  assert.equal(parsed.modelIds['bad/id'], undefined);
  let invocation;
  const read = readTraeModels('fixture-cli', (...args) => { invocation = args; return JSON.stringify(catalog); });
  assert.equal(read.load[SOL].percent, 35);
  assert.deepEqual(invocation.slice(0, 2), ['fixture-cli', ['models', '--json']]);
  assert.equal(invocation[2].timeout, 30000);
  assert.deepEqual(readTraeModels('fixture-cli', () => { throw Error('discard-me'); }), { modelIds: {}, load: {} });
  assert.deepEqual(readTraeModels('fixture-cli', () => 'malformed'), { modelIds: {}, load: {} });
  assert.deepEqual(freshLoad({ [SOL]: { percent: 99, t: now - 31 * min } }, now), {});
  assert.deepEqual(freshLoad({ [SOL]: { percent: 99, t: now + min } }, now), {});
  assert.equal(freshLoad({ [SOL]: { percent: 0, t: now - 30 * min } }, now)[SOL].percent, 0);
  assert.deepEqual(freshQueue({ gpt: { t: now - 31 * min, position: 999 } }, now), {});

  const queueFile = path.join(tmp, 'queue-state.json');
  const event = { t: now, position: 3100, state: 'queued', lowPriority: true, message: 'discard-me' };
  assert.equal(writeQueueState(tmp, 'gpt', event, now), 0);
  let saved = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
  assert.equal(saved.gpt.high.position, 3100);
  assert.equal(saved.gpt.lowPriority, true);
  assert.equal(saved.gpt.message, undefined);
  assert.ok(writeQueueState(tmp, 'deepseek', event, now + 1) > 0); // shared throttle across families
  assert.equal(JSON.parse(fs.readFileSync(queueFile, 'utf8')).deepseek, undefined);
  fs.utimesSync(queueFile, new Date(now - 2 * min), new Date(now - 2 * min));
  assert.equal(writeQueueState(tmp, 'gpt', { t: now, state: 'ready', position: null, lowPriority: false }, now), 0);
  saved = readQueueState(tmp, now);
  assert.equal(saved.gpt.position, null);
  assert.equal(saved.gpt.high.position, 3100); // ready cannot hide recent congestion
  fs.utimesSync(queueFile, new Date(now - 2 * min), new Date(now - 2 * min));
  assert.equal(writeQueueState(tmp, 'deepseek', { t: now, position: 4, state: 'waiting', lowPriority: false }, now), 0);
  assert.deepEqual(Object.keys(readQueueState(tmp, now)).sort(), ['deepseek', 'gpt']);
  assert.equal(readQueueState(tmp, now + 31 * min).gpt, undefined);
  assert.ok(!fs.readdirSync(tmp).some((s) => s.endsWith('.lock') || /\.\d+$/.test(s)));
  const snap = companySnapshot([{ kind: 'ttadk', name: 'ttadk', usage: { used: 10, limit: 100, resetsAt: now + min, raw: 'discard-me' } },
    { kind: 'trae', name: 'trae', home: tmp, load: parsed.load,
      quota: { daily: { [SOL]: { used: 20, limit: 80, depleted: false, resetsAt: now + min, raw: 'discard-me' } }, weekly: { used: 5, limit: 300 } } }], now);
  assert.deepEqual(snap.ttadk, { name: 'ttadk', used: 10, limit: 100, resetsAt: now + min });
  assert.equal(snap.trae.daily[SOL].used, 20);
  assert.equal(snap.trae.weekly.limit, 300);
  assert.equal(snap.trae.load[SOL].percent, 35);
  assert.equal(snap.trae.queue.gpt.high.position, 3100);
  assert.ok(!JSON.stringify(snap).includes('discard-me'));
  console.log('ok   telemetry parsing, atomic shared throttle, family isolation, freshness and safe fields');

  // Exercise readState's real refresh/cache/log path. Only a synthetic TRAE profile exists; every subprocess is stubbed.
  const profiles = path.join(tmp, 'accounts.json'), cache = path.join(tmp, 'quota.json'), log = path.join(tmp, 'quota-log.jsonl');
  fs.writeFileSync(profiles, JSON.stringify({ trae: { kind: 'trae', home: tmp, hub: 'ws://127.0.0.1:1', bin: process.execPath, models: [SOL] } }));
  Object.assign(process.env, { CODEX_ACCOUNTS: profiles, QUOTA_CACHE: cache, QUOTA_LOG_FILE: log, QUOTA_LOG: '1', TRAE_PROBE: '0' });
  let catalogs = 0;
  childProcess.execFileSync = (bin, args) => {
    if (bin === 'claude') return 'Current week (all models): 10% used\n';
    if (bin === '/bin/sh') return 'Logged in\n';
    if (bin === 'lsof') return '';
    if (args[0] === 'models') { catalogs++; return JSON.stringify(catalog); }
    if (args.includes('usage')) return JSON.stringify({ dailyUsage: [{ quotaKey: 'sol', quotaUsed: '20', quotaLimit: '80',
      quotaRemaining: '60', isDepleted: false, resetTime: Math.floor(now / 1000) + 3600 }], modelQuotas: { [SOL]: 'sol' },
      usage: { quota_remaining: 295, quota_limit: 300 } });
    if (args.includes('list')) return '';
    throw Error('unexpected subprocess in telemetry fixture');
  };
  syncBuiltinESMExports();
  const { readState, analyze } = await import('../lib/state.mjs');
  const data = readState({ fresh: true });
  assert.equal(data.codexAccounts[0].healthy, true);
  assert.equal(catalogs, 1);
  assert.equal(analyze(data).codex.trae.load[SOL].percent, 35);
  const records = readQuotaHistory(log);
  assert.equal(records.length, 1);
  assert.equal(records[0].trae.daily[SOL].used, 20);
  assert.equal(records[0].trae.weekly.limit, 300);
  assert.equal(records[0].trae.queue.gpt.high.position, 3100);
  assert.equal(records[0].trae.load[SOL].percent, 35);
  readState();
  assert.equal(catalogs, 1); // cache does not issue a new load query or log a refresh
  assert.equal(readQuotaHistory(log).length, 1);
  readState({ fresh: true });
  assert.equal(readQuotaHistory(log).length, 2);
  childProcess.execFileSync = exec; syncBuiltinESMExports();
  const env = { ...process.env, QUOTA_LOG: '0', TRAE_PROBE: '0' };
  const shown = exec(process.execPath, [path.join(root, 'quota.mjs')], { env, encoding: 'utf8' });
  assert.match(shown, /gpt-6.1-sol load 35%/);
  assert.match(shown, /gpt queue \? \(ready/);
  const shownJson = JSON.parse(exec(process.execPath, [path.join(root, 'quota.mjs'), '--json'], { env, encoding: 'utf8' }));
  assert.equal(shownJson.trae.queue.gpt.high.position, 3100);
  console.log('ok   real quota refresh, cached reads, append-only snapshots and text/JSON display');

  // Real worker CLI/follow path, replacing only its WebSocket transport; no hub or provider is contacted.
  const workerHome = path.join(tmp, 'worker'); fs.mkdirSync(workerHome);
  fs.writeFileSync(profiles, JSON.stringify({ trae: { kind: 'trae', home: workerHome, hub: 'ws://127.0.0.1:1' } }));
  fs.writeFileSync(path.join(workerHome, 'thread-models.json'), JSON.stringify({ fixture: 'GPT-6.1-Sol' }));
  const transport = path.join(tmp, 'transport.mjs');
  fs.writeFileSync(transport, `
globalThis.WebSocket = class {
  constructor() { setImmediate(() => this.onopen()); }
  close() {}
  send(raw) {
    const m = JSON.parse(raw);
    if (m.id == null) return;
    setImmediate(() => {
      const result = m.method === 'thread/read' ? {thread:{turns:[{id:'turn',status:'inProgress'}]}} : {};
      this.onmessage({data:JSON.stringify({id:m.id,result})});
      if (m.method === 'thread/read') setTimeout(() => {
        const notify = (params) => this.onmessage({data:JSON.stringify({method:'queue/status',params})});
        notify({threadId:'another-thread',state:'queued',position:9999});
        notify({state:'queued',position:8888});
        notify({threadId:'fixture',turnId:'other-turn',state:'queued',position:7777});
        notify({threadId:'fixture',turnId:'turn',state:'waiting',position:42,modelQuotaLowPriority:true,message:'discard-me'});
        this.onmessage({data:JSON.stringify({method:'turn/completed',params:{threadId:'fixture',turnId:'turn',turn:{id:'turn',status:'completed',items:[{type:'agentMessage',text:'done'}]}}})});
      }, 10);
    });
  }
};
`);
  const output = exec(process.execPath, ['--import', transport, path.join(root, 'codex-worker.mjs'), '--account', 'trae', 'wait', '--thread', 'fixture'],
    { env, encoding: 'utf8', timeout: 5000 });
  assert.match(output, /queued: position 42/);
  assert.ok(!/9999|8888|7777/.test(output));
  const recorded = JSON.parse(fs.readFileSync(path.join(workerHome, 'queue-state.json'), 'utf8'));
  assert.equal(recorded.gpt.position, 42);
  assert.equal(recorded.gpt.lowPriority, true);
  assert.equal(recorded.gpt.message, undefined);
  assert.equal(recorded.gpt.high, undefined);
  console.log('ok   real worker follow records only its own queue/status against the remembered model family');
  console.log('\nall pass');
} finally {
  childProcess.execFileSync = exec; syncBuiltinESMExports();
  fs.rmSync(tmp, { recursive: true, force: true });
}
