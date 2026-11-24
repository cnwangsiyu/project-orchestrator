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
  startedAt: now - 400_000, lastActivityAt: now - 1000, queue: { state: 'waiting', since: now - 390_000, position: 3 } };
const old = { ...w, task: 'W749', name: 'W749-old' };
const lockHeader = 'ID KIND POLICY LINK HOLDER SINCE → UNTIL / PURPOSE\n';
const status = `${lockHeader}iphone11 device open connected W746-rehearsal (${project}/W746-rehearsal) 2026-11-23 11:00 → +120m · ${fakeSerial}\n`
  + 'iphone8 device open not seen FREE\ns21 device open connected FREE\niphone15pm device ask-user connected FREE\n';
const remote = `${lockHeader}devbox-cn-66 remote open - W746-check (${project}/W746) 2026-11-23 12:00 → ? · test\n`
  + `devbox-cn-67 remote open - W7460 (${project}/W7460) 2026-11-23 12:00 → ? · test\n`
  + `Host ${fakeHost} heldSlots=2 cores=64\n  heavy admitted=2 load5=12.5 reserved_cores=3\n`;
const registry = [{ slot: 'devbox-cn-66', host: fakeHost, kind: 'remote', policy: 'open' },
  { slot: 'devbox-cn-67', host: fakeHost, kind: 'remote', policy: 'open' },
  { slot: 'heavy-build-4', host: 'main.local', kind: 'slot', policy: 'open' },
  { slot: 'mini2-exec-1', host: 'mini2.local', kind: 'remote', policy: 'open' }];
let fault;
async function command(bin, args, signal) {
  assert.ok(signal instanceof AbortSignal);
  if (bin === process.execPath) {
    if (args.includes('--running')) return JSON.stringify({ threads: [w] });
    if (fault === 'quota') throw Error('fixture: quota unavailable');
    return JSON.stringify({ checkedAt: now, trae: { quota: { daily: { gpt_6_2: { used: 1, limit: 100, resetsAt: reset } } } },
      ttadk: { usage: { used: 1000, limit: 1000, resetsAt: reset } }, claude: { week: { used: 66, resetsAt: reset } },
      codex: [{ name: 'main', email: 'private@example.invalid', week: { used: 40, resetsAt: reset }, resets: { count: 3 } }], hubs: [{ account: 'trae', state: 'up' }] });
  }
  switch (args.join(' ')) {
    case 'status --json': throw Object.assign(new Error('unsupported'), { stderr: "res: unknown resource '--json'" });
    case 'status': return status;
    case 'status devbox-cn': return remote;
    case 'devbox-registry': return JSON.stringify(registry);
    case 'holder heavy-build-4': return JSON.stringify({ state: 'held', holder: 'W746-check', task: 'W746', project });
    case 'holder mini2-exec-1': return JSON.stringify({ by: 'W746-check', task: 'W746', project });
    case 'audit --json': return JSON.stringify({ hosts: { [fakeHost]: { cores: 64, heldSlots: 2, spareCores: 48, metricsFresh: true } } });
    case 'pool-capacity devbox-cn': return JSON.stringify({ [fakeHost]: { claims: 3, gate: 'headroom' } });
    case 'pool-capacity devbox-cn-light':
      if (fault === 'pool') return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      return JSON.stringify({ [fakeHost]: { claims: 6, gate: 'headroom' } });
    case 'pool-capacity mini2': return JSON.stringify({ 'mini2.local': { held: 1, gate: 'headroom', capacity: { cores: 10, load5: 1.2 } } });
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
  await Promise.all([shared, boardRoot, briefRoot, path.join(data, 'history')].map((dir) => fs.mkdir(dir, { recursive: true })));
  await fs.writeFile(path.join(boardRoot, 'board.json'), JSON.stringify({ tasks: [{ id: 'W746', title: '编辑后画面检查', next: '检查第 3 组' }] }));
  await fs.writeFile(path.join(briefRoot, 'brief.md'), '# 旧任务标题\n\n正文不可见\n');
  await putLines(path.join(shared, 'worker-events.jsonl'), [
    { ...w, t: now - 3, event: 'message', text: '较早的进展' },
    { ...w, t: now - 2, event: 'message', text: `token=${fakeToken} run ${fakeHost} fd12::1234 test.user@example.invalid serial=${fakeSerial}` },
    { ...old, t: now - 1, event: 'failed' },
  ]);
  await putLines(path.join(shared, 'route-log.jsonl'), [
    { ...w, t: now - 3, kind: 'route', why: ['旧理由'] }, { ...w, t: now - 2, kind: 'route', why: ['公司通道优先'] },
    { ...w, t: now - 1, kind: 'launch', why: ['不是路由理由'] },
  ]);
  const asked = { event: 'asked', at: new Date(now - 200).toISOString(), title: '确认出包', project };
  await putLines(path.join(data, 'cards.ndjson'), [
    { ...asked, id: 'open' }, { ...asked, id: 'closed' }, { id: 'closed', event: 'answered', at: new Date(now - 100).toISOString() },
    { ...asked, id: 'withdrawn' }, { id: 'withdrawn', event: 'withdrawn', at: new Date(now - 100).toISOString() },
    { ...asked, id: 'expired', defaultAt: new Date(now - 50).toISOString() },
  ]);
  const history = path.join(data, 'history');
  await putLines(path.join(history, '2026-11-20.ndjson'), [{ at: '2026-11-20T15:00:00.000Z' }]);
  await putLines(path.join(history, '2026-11-21.ndjson'), [{ at: '2026-11-21T19:59:00.000Z' }, { at: '2026-11-21T20:01:00.000Z' }]);
  const options = { data, home: root, shared, command, now };
  const first = await collect(options);
  assert.deepEqual(Object.values(first.blocks).filter((b) => b.stale), []);
  const task = first.tasks.find((row) => row.task === w.task);
  assert.equal(task.model, 'gpt-6.2-sol'); assert.equal(task.state, 'queued'); assert.equal(task.queuePosition, 3);
  assert.equal(task.title, '编辑后画面检查'); assert.equal(task.summary, '检查第 3 组'); assert.equal(task.routeWhy, '公司通道优先');
  assert.match(task.latestNote, /MASKED|隐藏/);
  assert.equal(first.tasks.find((row) => row.task === old.task).title, '旧任务标题');
  assert.equal(first.machines.find((m) => m.name === '开发机 9').load5, 12.5);
  assert.equal(first.machines.find((m) => m.name === '开发机 9').holders.length, 2);
  assert.deepEqual(task.resources.map((r) => r.host ?? r.label), ['开发机 9', '主 mini', 'mini2', 'iPhone 11']);
  assert.equal(Date.parse(first.devices[0].until) - Date.parse(first.devices[0].since), 120 * 60_000);
  assert.equal(first.devices.length, 3); assert.equal(first.cards.length, 1); assert.equal(first.cards[0].title, '确认出包');
  assert.equal(first.quota.items.find((q) => q.id === 'ttadk').exhausted, true);
  assert.equal(first.quota.items.find((q) => q.id === 'main').resetCards, 3);
  const daily = await fs.readFile(path.join(history, '2026-11-23.ndjson'), 'utf8');
  const snapshot = await fs.readFile(path.join(data, 'snapshot.json'), 'utf8');
  for (const raw of [daily, snapshot]) {
    for (const hidden of [fakeToken, fakeHost, fakeSerial, 'fd12::1234', 'example.invalid', 'main.local', 'mini2.local', 'iphone15pm', '正文不可见']) assert.ok(!raw.includes(hidden), `unexpected ${hidden}`);
  }
  assert.equal(daily, snapshot);
  assert.deepEqual(await fs.readdir(history), ['2026-11-21.ndjson', '2026-11-23.ndjson']);
  assert.match(await fs.readFile(path.join(history, '2026-11-21.ndjson'), 'utf8'), /^\{"at":"2026-11-21T20:01:00.000Z"\}\n$/);
  fault = 'pool';
  const second = await collect({ ...options, now: now + 30_000, timeout: 180 });
  const pool = 'pool:devbox-cn-light';
  assert.deepEqual(second.blocks[pool].data, first.blocks[pool].data);
  assert.equal(second.blocks[pool].since, second.at);
  assert.equal(second.blocks[pool].updatedAt, first.at);
  assert.match(second.blocks[pool].error, /超时/);
  assert.equal(second.blocks['pool:local'].data[0].claims, 1);
  assert.equal(Object.values(second.blocks).filter((b) => b.stale).length, 1);
  const third = await collect({ ...options, now: now + 60_000, timeout: 180 });
  assert.equal(third.blocks[pool].since, second.at);
  fault = 'quota';
  await fs.writeFile(path.join(shared, 'quota.json'), JSON.stringify({ checkedAt: now, codexAccounts: [
    { name: 'main', windows: [{ windowMins: 10080, used: 21, resetsAt: reset }], resets: { count: 2 } }],
    claude: [{ windowMins: 10080, used: 33, resetsAt: reset }] }));
  const fallback = await collect({ ...options, now: now + 90_000 });
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
  assert.doesNotMatch(page.body, /最近发生的事|发布与回归/);
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
