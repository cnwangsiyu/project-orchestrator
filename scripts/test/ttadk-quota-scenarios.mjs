#!/usr/bin/env node
// Regression tests for the TTADK daily-quota reader in lib/state.mjs (the LLMBox `/api/v1/user/quota` shape).
// Synthetic responses only — no live LLMBox call, no credential: every request goes to a stub fetch or a local server.
//   node scripts/test/ttadk-quota-scenarios.mjs      (exit 0 = all pass)
import http from 'node:http';
import { selectDailyQuota, fetchTtadkQuota, ttadkQuotaUrl, TTADK_QUOTA_URL } from '../lib/state.mjs';

let fail = 0;
const check = (name, cases) => {
  const bad = cases.map(([got, want], i) => (JSON.stringify(got) === JSON.stringify(want) ? null : `#${i} want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)).filter(Boolean);
  if (bad.length) fail++;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} ${name.padEnd(34)}${bad.length ? ` — ${bad.join('; ')}` : ''}`);
};
const RESET = '2026-11-13T16:00:00.000Z';
const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/api/v1/user/quota` }));
});
const close = (server) => new Promise((resolve) => server.close(resolve));

// ---- bucket selection (pure) ----
{
  const r = selectDailyQuota({ quotas: [{ used: 185000000, limit: 500000000, utilization: 0.37, resets_at: RESET }] });
  check('one bucket', [[r.error, null], [r.usage.used, 185000000], [r.usage.limit, 500000000], [r.usage.remaining, 315000000],
    [r.usage.utilization, 37], [r.usage.resetsAt, Date.parse(RESET)], [r.usage.source, 'llmbox'], [r.usage.buckets.length, 1]]);
}
{
  // The daily bucket is second: position must not decide it, its 16:00 UTC reset must.
  const r = selectDailyQuota({ quotas: [
    { window: 'week', used: 4000000000, limit: 5000000000, resets_at: '2026-11-16T00:00:00Z' },
    { window: 'day', used: 50000000, limit: 500000000, resets_at: RESET },
  ] });
  check('several: daily by reset', [[r.error, null], [r.usage.used, 50000000], [r.usage.limit, 500000000], [r.usage.utilization, 10], [r.usage.buckets.length, 2]]);
}
{
  const r = selectDailyQuota({ quotas: [
    { used: 10, limit: 100, resets_at: '2026-11-13T00:00:00Z' },
    { used: 20, limit: 100, resets_at: RESET },
    { used: 30, limit: 100, resets_at: '2026-11-13T08:00:00Z' },
  ] });
  check('several: one resets 16:00', [[r.error, null], [r.usage.used, 20], [r.usage.utilization, 20]]);
}
{
  // A window/period that says day is the other tell, even when its reset is not 16:00 UTC.
  const r = selectDailyQuota({ quotas: [
    { window: 'hour', used: 1, limit: 10, resets_at: '2026-11-13T11:00:00Z' },
    { window: 'daily', used: 5, limit: 10, resets_at: '2026-11-13T08:00:00Z' },
  ] });
  check('several: daily marker', [[r.error, null], [r.usage.used, 5], [r.usage.utilization, 50]]);
}
{
  const r = selectDailyQuota({ quotas: [
    { used: 10, limit: 100, resets_at: '2026-11-13T00:00:00Z' },
    { used: 20, limit: 100, resets_at: '2026-11-13T06:00:00Z' },
  ] });
  check('several: ambiguous', [[r.usage.used, null], [r.usage.buckets.length, 2], [/cannot tell/.test(r.error), true]]);
}
{
  const r = selectDailyQuota({ quotas: [{ used: 1000 }] });
  check('missing limit/utilization', [[r.usage.used, 1000], [r.usage.limit, null], [r.usage.remaining, null],
    [r.usage.utilization, null], [/no utilization/.test(r.error), true]]);
}
{
  // The API's own share: 0–1 is a fraction, above 1 is already a percent.
  const a = selectDailyQuota({ quotas: [{ utilization: 0.42, resets_at: RESET }] });
  const b = selectDailyQuota({ quotas: [{ utilization: 42, resets_at: RESET }] });
  check('utilization without tokens', [[a.usage.utilization, 42], [b.usage.utilization, 42]]);
}
{
  const a = selectDailyQuota({}), b = selectDailyQuota({ quotas: [] }), c = selectDailyQuota(null);
  check('malformed payloads', [[a.usage, null], [/no quotas array/.test(a.error), true], [b.usage, null],
    [/lists no quotas/.test(b.error), true], [c.usage, null]]);
}
check('quota URL override', [[ttadkQuotaUrl({ TTADK_QUOTA_URL: 'http://127.0.0.1:9/q' }), 'http://127.0.0.1:9/q'],
  [ttadkQuotaUrl({}), TTADK_QUOTA_URL]]);

// ---- request failures (stub fetch) ----
{
  const r = await fetchTtadkQuota({ token: 'tok-secret', fetchImpl: async () => new Response('{"error":"unauthorized"}', { status: 401 }) });
  check('stub fetch: HTTP 401', [[r.usage, null], [r.status, 401], [/HTTP 401/.test(r.error), true], [JSON.stringify(r).includes('tok-secret'), false]]);
}
{
  const r = await fetchTtadkQuota({ token: 't', fetchImpl: () => Promise.reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })) });
  check('stub fetch: timeout', [[r.usage, null], [/timed out after 5000ms/.test(r.error), true]]);
}
{
  const r = await fetchTtadkQuota({ token: 't', fetchImpl: async () => new Response('<html>', { status: 200 }) });
  check('stub fetch: non-JSON 200', [[r.usage, null], [/non-JSON/.test(r.error), true]]);
}
{
  const r = await fetchTtadkQuota({ token: '' });
  check('no token', [[r.usage, null], [/no TTADK token/.test(r.error), true]]);
}

// ---- the real fetch path against a local stub server ----
{
  let seen = null;
  const { server, url } = await listen((req, res) => {
    seen = req.headers;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ quotas: [{ window: 'day', used: 250000000, limit: 500000000, resets_at: RESET }] }));
  });
  const r = await fetchTtadkQuota({ token: 'tok-abc', url });
  await close(server);
  check('stub server: x-jwt-token', [[seen?.['x-jwt-token'], 'tok-abc'], [r.usage?.used, 250000000], [r.usage?.utilization, 50]]);
}
{
  let seen = null;
  const { server, url } = await listen((req, res) => {
    seen = req.headers;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ quotas: [{ used: 1, limit: 10, resets_at: RESET }] }));
  });
  const r = await fetchTtadkQuota({ token: 'Bearer at-sso', header: 'authorization', url });
  await close(server);
  check('stub server: authorization', [[seen?.authorization, 'Bearer at-sso'], [r.usage?.utilization, 10]]);
}
{
  const { server, url } = await listen((req, res) => setTimeout(() => { res.writeHead(200); res.end('{}'); }, 300));
  const r = await fetchTtadkQuota({ token: 't', url, timeoutMs: 100 });
  await close(server);
  check('stub server: timeout', [[r.usage, null], [/timed out after 100ms/.test(r.error), true]]);
}
{
  const { server, url } = await listen((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":"unauthorized","code":10001}');
  });
  const r = await fetchTtadkQuota({ token: 't', url });
  await close(server);
  check('stub server: 401', [[r.usage, null], [r.status, 401], [/HTTP 401/.test(r.error), true]]);
}

console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
