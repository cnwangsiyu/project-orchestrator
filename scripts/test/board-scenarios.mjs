import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { collect } from '../board/collect.mjs';
import { createBoardServer } from '../board/serve.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duty-board-'));
const data = path.join(root, 'data');
const shared = path.join(root, 'shared');
const project = 'video-agent';
const fakeHost = '10.32.45.67';
const fakeToken = 'fixture-not-a-real-credential-4C7Mx';
const fakeSerial = 'RS89J612345';
const now = Date.parse('2026-11-23T20:00:00Z');
const reset = now + 2 * 3600_000;
const w = { account: 'trae', model: 'gpt-6.2-sol', effort: 'high', project, task: 'W746-check', name: 'W746-check', owner: 'VAK 主对话',
  startedAt: now - 400_000, lastActivityAt: now - 1000, queueStalled: true,
  queue: { state: 'waiting', since: now - 390_000, position: 3, workedMinutesBefore: 4 } };
const old = { ...w, task: 'W749', name: 'W749-old' };
const lockHeader = 'ID KIND POLICY LINK HOLDER SINCE → UNTIL / PURPOSE\n';
const status = `${lockHeader}iphone11 device open connected W746-rehearsal (${project}/W746-rehearsal) 2026-11-23 11:00 → +120m · ${fakeSerial}\n`
  + 'iphone8 device open not seen FREE\ns21 device open connected FREE\niphone15pm device ask-user connected FREE\n'
  + `heavy-build-4 slot open - W746-check (${project}/W746) 2026-11-23 12:00 → ? · test\n`
  + 'heavy-lane-1 slot open - HELD\n'
  + `mini2-exec-1 remote open - W746-check (${project}/W746) 2026-11-23 12:00 → ? · test\n`;
const heldRemote = `${lockHeader}devbox-cn-66 remote open - W746-check (${project}/W746) 2026-11-23 12:00 → ? · test\n`
  + `devbox-cn-67 remote open - W7460 (${project}/W7460) 2026-11-23 12:00 → ? · test\n`
  + `Host ${fakeHost} heldSlots=2 cores=64\n  heavy admitted=2 load5=12.5 reserved_cores=3\n`;
const registry = [{ slot: 'devbox-cn-66', host: fakeHost, kind: 'remote', policy: 'open' },
  { slot: 'devbox-cn-67', host: fakeHost, kind: 'remote', policy: 'open' },
  { slot: 'heavy-build-4', host: 'main.local', kind: 'slot', policy: 'open' },
  { slot: 'mini2-exec-1', host: 'mini2.local', kind: 'remote', policy: 'open' }];
let fault, remote = heldRemote, auditHeld = 2, devboxLink, ttadkUsed = 1000;
async function command(bin, args, signal) {
  assert.ok(signal instanceof AbortSignal);
  if (bin === process.execPath) {
    if (args.includes('--running')) return JSON.stringify({ threads: [w] });
    if (fault === 'quota') throw Error('fixture: quota unavailable');
    return JSON.stringify({ checkedAt: now, trae: { quota: { daily: { gpt_6_2: { used: 1, limit: 100, resetsAt: reset } } } },
      ttadk: { usage: { used: ttadkUsed, limit: 1000, resetsAt: reset } }, claude: { week: { used: 66, resetsAt: reset } },
      codex: [{ name: 'main', email: 'private@example.invalid', week: { used: 40, resetsAt: reset }, resets: { count: 3 } }], hubs: [{ account: 'trae', state: 'up' }] });
  }
  switch (args.join(' ')) {
    case 'status --json': throw Object.assign(new Error('unsupported'), { stderr: "res: unknown resource '--json'" });
    case 'status': return status;
    case 'status devbox-cn': return remote;
    case 'devbox-registry': return JSON.stringify(registry);
    case 'holder heavy-build-4': return JSON.stringify({ state: 'held', holder: 'W746-check', task: 'W746', project });
    case 'holder mini2-exec-1': return JSON.stringify({ by: 'W746-check', task: 'W746', project });
    case 'audit --json':
      if (fault === 'audit') throw Error('fixture: audit unavailable');
      return JSON.stringify({ hosts: { [fakeHost]: { cores: 64, heldSlots: auditHeld, spareCores: 48, metricsFresh: true } } });
    case 'pool-capacity devbox-cn': return JSON.stringify({ [fakeHost]: { claims: 3, gate: 'headroom', link: devboxLink } });
    case 'pool-capacity devbox-cn-light':
      if (fault === 'pool') return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      return JSON.stringify({ [fakeHost]: { claims: 6, gate: 'headroom' } });
    case 'pool-capacity mini2': return JSON.stringify({ 'mini2.local': { held: 1, claims: 0,
      gate: 'metrics-stale-or-foreign', capacity: { cores: 10, load5: 1.2 } } });
    default:
      assert.match(args.join(' '), /^pool-capacity local(?:-light|-build)?$/);
      return JSON.stringify({ 'main.local': { cores: 14, claims: fault === 'pool' ? 1 : 2, load5: 4, pressure: 1, gate: 'headroom' } });
  }
}
const putLines = (file, items) => fs.writeFile(file, items.map((row) => JSON.stringify(row)).join('\n') + '\n');

let server;
try {
  const boardRoot = path.join(root, '.claude/orchestrator', project);
  const briefRoot = path.join(root, 'code/.claude-data/orchestrator', project, 'tasks', old.task);
  const vakRoot = path.join(root, 'vak-state');
  const nightlyRoot = path.join(root, 'nightly');
  const rulesFile = path.join(root, 'global-rules.md');
  await Promise.all([shared, path.join(shared, 'devbox-metrics'), boardRoot, briefRoot, path.join(data, 'history'),
    vakRoot, path.join(nightlyRoot, 'vak-ppe-release'), path.join(nightlyRoot, 'vak-web/runs/2026-11-23T19-00-00Z'),
    path.join(nightlyRoot, 'vak-web/runs/2026-11-23T20-00-00Z')]
    .map((dir) => fs.mkdir(dir, { recursive: true })));
  const freshMetric = (at = now - 5 * 60_000) => ({ at: at / 1000, cores: 64, load5: 3.1, memAvailableGiB: 40, freeGiB: 300 });
  await fs.writeFile(path.join(shared, 'devbox-metrics', `${fakeHost}.json`), JSON.stringify(freshMetric()));
  await fs.writeFile(path.join(shared, 'mini2-metrics.json'), JSON.stringify({ at: (now - 4 * 60_000) / 1000,
    cores: 10, load5: 1.1, availableGiB: 12, freeGiB: 100 }));
  await fs.writeFile(path.join(boardRoot, 'board.json'), JSON.stringify({ tasks: [{ id: 'W746', title: '编辑后画面检查', next: '检查第 3 组' }] }));
  await fs.writeFile(path.join(briefRoot, 'brief.md'), '# 旧任务标题\n\n正文不可见\n');
  await fs.writeFile(path.join(vakRoot, 'ppe-state.json'), JSON.stringify({
    mainPpe: { version: '1.0.0.201', scm: 176799342, deployedAt: new Date(now - 30 * 60_000).toISOString() },
    autoRelease: {
      lastTransaction: { prodVersion: '1.0.0.105', updatedAt: new Date(now - 3 * 3600_000).toISOString() },
      history: [{ version: '1.0.0.201', deployedAt: new Date(now - 30 * 60_000).toISOString() }],
    },
  }));
  await putLines(path.join(nightlyRoot, 'vak-ppe-release/cycle-events.jsonl'), [
    { at: new Date(now - 45 * 60_000).toISOString(), release: true },
  ]);
  await fs.writeFile(path.join(nightlyRoot, 'vak-web/runs/2026-11-23T19-00-00Z/report.json'), JSON.stringify({
    start: new Date(now - 70 * 60_000).toISOString(), end: new Date(now - 60 * 60_000).toISOString(),
    rows: [{ job: 'render-basic', status: 'PASS' }, ...Array.from({ length: 6 }, (_, i) => ({ job: `failed-${i + 1}`, status: 'FAIL' }))],
  }));
  await fs.writeFile(path.join(nightlyRoot, 'vak-web/runs/2026-11-23T20-00-00Z/report.json'), JSON.stringify({ rows: [] }));
  await fs.writeFile(rulesFile, '# Rules\nversion: 2026-11-23.2\n');
  await fs.utimes(rulesFile, (now - 20 * 60_000) / 1000, (now - 20 * 60_000) / 1000);
  await putLines(path.join(shared, 'worker-events.jsonl'), [
    { ...w, t: now - 6_000, event: 'message', text: '最早的进展' },
    { ...w, t: now - 2, event: 'message', text: `token=${fakeToken} run ${fakeHost} fd12::1234 test.user@example.invalid serial=${fakeSerial}` },
    { ...w, t: now - 4_000, event: 'message', text: '第三条进展' },
    { ...w, t: now - 3_000, event: 'message', text: '最新进展' },
    { ...w, t: now - 2_000, event: 'message', kind: 'queue-stalled', noticeId: 'notice-1', ackAt: null, text: '队列等待需要处理' },
    { ...old, t: now - 2_500, event: 'message', kind: 'queue-stalled', noticeId: 'notice-closed',
      ackAt: new Date(now - 2_000).toISOString(), text: '已处理的队列通知' },
    { ...w, t: now - 14_000, event: 're-routed', account: 'trae' },
    { ...w, name: 'W750-finished', task: 'W750-finished', t: now - 12_000, event: 'finished' },
    { ...w, name: 'W751-interrupted', task: 'W751-interrupted', t: now - 11_000, event: 'failed', status: 'interrupted' },
    { ...old, t: now - 1_000, event: 'failed' },
  ]);
  await putLines(path.join(shared, 'route-log.jsonl'), [
    { ...w, t: now - 3, kind: 'route', why: ['旧理由'] }, { ...w, t: now - 2, kind: 'route', why: ['公司通道优先'] },
    { ...w, t: now - 1, kind: 'launch', why: ['不是路由理由'] },
    { ...w, t: now - 15_000, kind: 'launch-model', state: 'queued', actualStatus: 'KNOWN', account: 'ttadk' },
    { ...w, t: now - 14_000, kind: 'launch-model', state: 'running', account: 'trae' },
  ]);
  const asked = { event: 'asked', at: new Date(now - 40 * 60_000).toISOString(), title: '确认出包', project };
  await putLines(path.join(data, 'cards.ndjson'), [
    { ...asked, id: 'open', default: '继续走公司通道', defaultAt: new Date(now - 10 * 60_000).toISOString() },
    { ...asked, id: 'closed' }, { id: 'closed', event: 'answered', at: new Date(now - 100).toISOString(), answer: '先不出包' },
    { ...asked, id: 'withdrawn' }, { id: 'withdrawn', event: 'withdrawn', at: new Date(now - 100).toISOString() },
  ]);
  await fs.appendFile(path.join(data, 'cards.ndjson'), '{malformed\n');
  const history = path.join(data, 'history');
  await putLines(path.join(history, '2026-11-20.ndjson'), [{ at: '2026-11-20T15:00:00.000Z' }]);
  await putLines(path.join(history, '2026-11-21.ndjson'), [{ at: '2026-11-21T19:59:00.000Z' }, { at: '2026-11-21T20:01:00.000Z' }]);
  await putLines(path.join(history, '2026-11-23.ndjson'), [{ at: new Date(now - 2 * 3600_000).toISOString(),
    quota: { items: [{ id: 'ttadk', label: 'TTADK 今日', exhausted: false, percent: 80, resetsAt: new Date(reset).toISOString() }] } }]);
  const sampleFile = path.join(root, 'latest.json');
  const sourcePaths = { vakRoot, nightlyRoot, rulesFile };
  const options = { data, home: root, shared, sampleFile, sourcePaths, command, now };
  const first = await collect(options);
  assert.deepEqual(Object.values(first.blocks).filter((b) => b.stale), []);
  const task = first.tasks.find((row) => row.task === w.task);
  assert.equal(task.model, 'gpt-6.2-sol'); assert.equal(task.state, 'stalled'); assert.equal(task.queuePosition, 3);
  assert.equal(Math.round(task.queueWaitMinutes * 10) / 10, 6.5); assert.equal(task.queueWorkedMinutes, 4);
  assert.equal(task.ownerNoticeOpen, true); assert.equal(task.lastNotes.length, 3);
  assert.equal(task.title, '编辑后画面检查'); assert.equal(task.summary, '检查第 3 组'); assert.equal(task.routeWhy, '公司通道优先');
  assert.match(task.latestNote, /MASKED|隐藏/);
  assert.equal(first.tasks.find((row) => row.task === old.task).title, '旧任务标题');
  assert.equal(first.tasks.find((row) => row.task === old.task).ownerNoticeOpen, false);
  assert.equal(first.machines.find((m) => m.name === '开发机 9').load5, 3.1);
  assert.equal(first.machines.find((m) => m.name === '开发机 9').sampleOnDemand, true);
  assert.equal(first.machines.find((m) => m.name === '开发机 9').fault, false);
  assert.equal(first.machines.find((m) => m.name === '开发机 9').holders.length, 2);
  assert.equal(first.machines.find((m) => m.name === '主 mini').holders[0].task, 'W746');
  assert.equal(first.machines.find((m) => m.name === '主 mini').holders[1].holder, '');
  assert.equal(first.machines.find((m) => m.name === 'mini2').claims.mini2.gate, 'metrics-stale-or-foreign');
  assert.deepEqual(task.resources.map((r) => r.host ?? r.label), ['开发机 9', '主 mini', 'mini2', 'iPhone 11']);
  assert.equal(Date.parse(first.devices[0].until) - Date.parse(first.devices[0].since), 120 * 60_000);
  assert.equal(first.devices.length, 3); assert.equal(first.cards.length, 1); assert.equal(first.cards[0].title, '确认出包');
  assert.equal(first.cards[0].default, '继续走公司通道'); assert.ok(Date.parse(first.cards[0].defaultAt) < now);
  assert.equal(first.recentCards.length, 1); assert.equal(first.recentCards[0].answer, '先不出包'); assert.equal(first.cardMalformed, 1);
  assert.deepEqual(first.releases.ppe, { version: '1.0.0.201', build: '176799342', at: new Date(now - 30 * 60_000).toISOString() });
  assert.equal(first.releases.production.version, '1.0.0.105'); assert.equal(first.releases.production.build, '');
  assert.equal(first.releases.lastCycle.result, '已发布');
  assert.deepEqual(first.releases.nightly, { at: new Date(now - 60 * 60_000).toISOString(), passed: 1, total: 7,
    failed: true, failures: ['failed-1', 'failed-2', 'failed-3', 'failed-4', 'failed-5'] });
  assert.equal(first.releases.productionToday, null);
  assert.ok(first.events.some((row) => row.text === 'W749 失败'));
  assert.ok(first.events.some((row) => row.text === 'W750-finished 已完成'));
  assert.ok(first.events.some((row) => row.text === 'W751-interrupted 已中断'));
  assert.equal(first.tasks.find((row) => row.task === 'W751-interrupted').state, 'interrupted');
  assert.equal(first.events.filter((row) => row.text === 'W746-check 已改派到 TRAE').length, 1);
  assert.ok(first.events.some((row) => row.text === '规则升到 2026-11-23.2'));
  assert.ok(first.events.some((row) => row.text === '提出待确认事项：确认出包'));
  assert.ok(first.events.some((row) => row.text === 'TTADK 今日 额度用完'));
  assert.equal(first.quota.items.find((q) => q.id === 'ttadk').exhausted, true);
  assert.equal(first.quota.items.find((q) => q.id === 'main').resetCards, 3);
  const daily = await fs.readFile(path.join(history, '2026-11-23.ndjson'), 'utf8');
  const snapshot = await fs.readFile(path.join(data, 'snapshot.json'), 'utf8');
  for (const raw of [daily, snapshot]) {
    for (const hidden of [fakeToken, fakeHost, fakeSerial, 'fd12::1234', 'example.invalid', 'main.local', 'mini2.local', 'iphone15pm', '正文不可见']) assert.ok(!raw.includes(hidden), `unexpected ${hidden}`);
  }
  assert.ok(daily.endsWith(snapshot));
  assert.deepEqual(await fs.readdir(history), ['2026-11-21.ndjson', '2026-11-23.ndjson']);
  assert.match(await fs.readFile(path.join(history, '2026-11-21.ndjson'), 'utf8'), /^\{"at":"2026-11-21T20:01:00.000Z"\}\n$/);

  await fs.writeFile(sampleFile, JSON.stringify({ schema: 1, hosts: {
    [fakeHost]: { at: (now - 60_000) / 1000, ok: true, cores: 64, load1: 8, load5: 7.7, load15: 6,
      memAvailableGiB: 38, freeGiB: 290 },
    'mini2.local': { at: (now - 50_000) / 1000, ok: true, cores: 10, load1: 2, load5: 1.8, load15: 1,
      memAvailableGiB: 11, freeGiB: 99 },
  } }));
  ttadkUsed = 100;
  const sharedFresh = await collect({ ...options, now: now + 1_000 });
  assert.equal(sharedFresh.machines.find((m) => m.name === '开发机 9').load5, 7.7);
  assert.equal(sharedFresh.machines.find((m) => m.name === '开发机 9').sampleSource, 'shared');
  assert.ok(sharedFresh.events.some((row) => row.text === 'TTADK 今日 额度已重置'));
  ttadkUsed = 1000;
  await fs.writeFile(sampleFile, JSON.stringify({ schema: 1, hosts: {
    [fakeHost]: { at: now / 1000, ok: false, errorClass: 'auth' },
  } }));
  const sharedAuth = await collect({ ...options, now: now + 2_000 });
  assert.equal(sharedAuth.machines.find((m) => m.name === '开发机 9').sampleSource, 'scheduler');
  assert.ok(sharedAuth.machines.find((m) => m.name === '开发机 9').faults.includes('sampler-auth'));
  await fs.writeFile(sampleFile, JSON.stringify({ schema: 1, hosts: {
    [fakeHost]: { at: (now - 4 * 60_000) / 1000, ok: true, cores: 64, load1: 8, load5: 9.9, load15: 6,
      memAvailableGiB: 38, freeGiB: 290 },
  } }));
  const sharedOld = await collect({ ...options, now: now + 3_000 });
  assert.equal(sharedOld.machines.find((m) => m.name === '开发机 9').load5, 3.1);
  assert.equal(sharedOld.machines.find((m) => m.name === '开发机 9').sampleSource, 'scheduler');
  await fs.rm(sampleFile);

  const metricFile = path.join(shared, 'devbox-metrics', `${fakeHost}.json`);
  await fs.rm(metricFile);
  const missingMetric = await collect({ ...options, now: now + 10_000 });
  assert.deepEqual(missingMetric.machines.find((m) => m.name === '开发机 9').faults, ['metrics-missing']);
  await fs.writeFile(metricFile, '{');
  const invalidMetric = await collect({ ...options, now: now + 20_000 });
  assert.deepEqual(invalidMetric.machines.find((m) => m.name === '开发机 9').faults, ['metrics-invalid']);
  await fs.writeFile(metricFile, JSON.stringify(freshMetric(now - 7 * 3600_000)));
  remote = `${lockHeader}Host ${fakeHost} heldSlots=0 cores=64\n  heavy admitted=0 load5=3.1 reserved_cores=0\n`;
  auditHeld = 0;
  const oldIdleMetric = await collect({ ...options, now: now + 30_000 });
  assert.equal(oldIdleMetric.machines.find((m) => m.name === '开发机 9').fault, false);
  remote = heldRemote; auditHeld = 2;
  const oldHeldMetric = await collect({ ...options, now: now + 40_000 });
  assert.ok(oldHeldMetric.machines.find((m) => m.name === '开发机 9').faults.includes('metrics-old-with-lease'));
  await fs.writeFile(metricFile, JSON.stringify(freshMetric()));
  devboxLink = 'DOWN';
  const linkDown = await collect({ ...options, now: now + 50_000 });
  assert.ok(linkDown.machines.find((m) => m.name === '开发机 9').faults.includes('link-down'));
  devboxLink = undefined; fault = 'audit';
  const resFailure = await collect({ ...options, now: now + 60_000 });
  assert.ok(resFailure.machines.find((m) => m.name === '开发机 9').faults.includes('res-failed'));
  fault = undefined;
  fault = 'pool';
  const second = await collect({ ...options, now: now + 70_000, timeout: 180 });
  const pool = 'pool:devbox-cn-light';
  assert.deepEqual(second.blocks[pool].data, first.blocks[pool].data);
  assert.equal(second.blocks[pool].since, second.at);
  assert.equal(second.blocks[pool].updatedAt, resFailure.at);
  assert.match(second.blocks[pool].error, /超时/);
  assert.equal(second.blocks['pool:local'].data[0].claims, 1);
  assert.equal(Object.values(second.blocks).filter((b) => b.stale).length, 1);
  const third = await collect({ ...options, now: now + 100_000, timeout: 180 });
  assert.equal(third.blocks[pool].since, second.at);
  fault = 'quota';
  await fs.writeFile(path.join(shared, 'quota.json'), JSON.stringify({ checkedAt: now, codexAccounts: [
    { name: 'main', windows: [{ windowMins: 10080, used: 21, resetsAt: reset }], resets: { count: 2 } }],
    claude: [{ windowMins: 10080, used: 33, resetsAt: reset }] }));
  const fallback = await collect({ ...options, now: now + 130_000 });
  assert.equal(fallback.quota.fallback, true);
  assert.equal(fallback.quota.items.find((q) => q.id === 'main').percent, 21);
  assert.equal(fallback.blocks[pool].stale, false);

  const tokenFile = path.join(root, 'fixture-access');
  const access = randomBytes(16).toString('hex');
  await fs.writeFile(tokenFile, `${access}\n`, { mode: 0o600 });
  server = await createBoardServer({ data, tokenFile });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const request = (url, { cookie, method = 'GET' } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: url, method,
      headers: cookie ? { Cookie: cookie } : {} }, (res) => {
      let body = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject); req.end();
  });
  for (const url of ['/', '/snapshot.json', '/healthz', '/history?at=2026-11-23']) assert.equal((await request(url)).status, 401);
  assert.equal((await request('/?k=wrong')).status, 401);
  const initial = await request(`/?k=${access}`);
  assert.equal(initial.status, 303); assert.equal(initial.headers.location, '/');
  const setCookie = initial.headers['set-cookie'][0];
  assert.match(setCookie, /HttpOnly; SameSite=Lax/);
  assert.ok(!setCookie.includes(access));
  const cookie = setCookie.split(';')[0];
  assert.equal((await request('/?k=wrong', { cookie })).status, 401);
  assert.equal((await request('/healthz', { cookie })).status, 200);
  assert.equal((await request('/history?at=2026-11-23', { cookie })).status, 404);
  assert.equal((await request('/snapshot.json', { cookie, method: 'POST' })).status, 405);
  for (const url of ['/x/../snapshot.json', '/%2e%2e/snapshot.json', '//snapshot.json', '/fixture-access', '/history/2026-11-23.ndjson']) {
    assert.equal((await request(url, { cookie })).status, 404);
  }
  const result = await request('/snapshot.json', { cookie });
  assert.deepEqual(JSON.parse(result.body), JSON.parse(JSON.stringify(fallback)));
  const head = await request('/snapshot.json', { cookie, method: 'HEAD' });
  assert.equal(head.body, ''); assert.equal(head.headers['content-length'], result.headers['content-length']);
  const page = await request('/', { cookie });
  assert.equal(page.status, 200); assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal(page.headers['cache-control'], 'no-store'); assert.equal(page.headers['referrer-policy'], 'no-referrer');
  const csp = page.headers['content-security-policy'];
  assert.match(csp, /default-src 'none';/); assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  for (const tag of ['style', 'script']) {
    const [, text] = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(page.body);
    assert.ok(csp.includes(`sha256-${createHash('sha256').update(text).digest('base64')}`));
    if (tag === 'script') new vm.Script(text);
  }
  assert.doesNotMatch(page.body, /(?:https?:\/\/|\b(?:src|href)=["']\/\/|url\s*\()/i);
  assert.match(page.body, /fetch\('\/snapshot\.json'/);
  assert.match(page.body, /最近发生的事/);
  assert.match(page.body, /发布与回归/);
  assert.match(page.body, /复制给秘书/);
  assert.match(page.body, /每分钟共享采样 · 调度和板面共用/);
  assert.match(page.body, /申请时计算/);
  assert.match(page.body, /持有者未知/);
  assert.match(page.body, /需要登录（Kerberos 票据过期）/);
  execFileSync('python3', ['-c', `
from html.parser import HTMLParser
import sys
class Page(HTMLParser):
 def __init__(self): super().__init__(); self.stack=[]; self.tags=set(); self.ids=set()
 def handle_starttag(self, tag, attrs):
  self.tags.add(tag)
  v=dict(attrs).get('id')
  if v: assert v not in self.ids; self.ids.add(v)
  if tag not in ['meta','link','input','img','br','hr']: self.stack.append(tag)
 def handle_endtag(self, tag): assert self.stack.pop() == tag
p=Page(); p.feed(sys.stdin.read()); p.close()
assert not p.stack and {'html','main','nav','section','script','style'} <= p.tags
`], { input: page.body });
  console.log('PASS board: independent snapshots, masking, retention, joins, access gates, strict CSP and self-contained HTML');
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
