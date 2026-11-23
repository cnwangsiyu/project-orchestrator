#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { serveIdentity, parseIdentityArgs } from '../browser-identity.mjs';

const services = [], children = [];
const script = new URL('../browser-identity.mjs', import.meta.url).pathname;
const request = (url, method = 'GET') => new Promise((resolve, reject) => {
  const req = http.request(url, { method, agent: false }, res => {
    let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
  });
  req.on('error', reject); req.setTimeout(2000, () => req.destroy(Error('fixture request timed out'))); req.end();
});
const start = async options => { const service = await serveIdentity(options); services.push(service); return service; };
try {
  assert.deepEqual(parseIdentityArgs(['serve']), { minutes: 10, once: false });
  assert.deepEqual(parseIdentityArgs(['serve', '--minutes', '2', '--once']), { minutes: 2, once: true });
  for (const args of [[], ['serve', '--host', '0.0.0.0'], ['serve', '--minutes', '0'], ['serve', '--minutes', '-1'],
    ['serve', '--minutes', 'NaN'], ['serve', '--minutes'], ['serve', '--once', '--once']])
    assert.throws(() => parseIdentityArgs(args));
  const first = await start({ minutes: 1 }), second = await start({ minutes: 1 });
  for (const service of [first, second]) {
    assert.equal(service.server.address().address, '127.0.0.1');
    assert.match(service.url, /^http:\/\/127\.0\.0\.1:\d+\/identity$/);
    assert.match(service.token, /^[a-f0-9]{48}$/);
    const page = await request(service.url);
    assert.equal(page.status, 200); assert.equal(page.text, service.token + '\n');
    assert.match(page.headers['content-type'], /^text\/plain/); assert.equal(page.headers['cache-control'], 'no-store');
  }
  assert.notEqual(first.token, second.token, 'candidate servers have different machine-proof markers');
  assert.notEqual((await request(second.url)).text, first.token + '\n', 'wrong candidate cannot prove the expected machine');
  for (const path of ['/', '/identity?query', '/favicon.ico', '/package.json', '/..']) {
    const page = await request(new URL(path, first.url));
    assert.equal(page.status, 404); assert.ok(!page.text.includes(first.token));
  }
  assert.equal((await request(first.url, 'POST')).status, 404);
  console.log('PASS browser identity: loopback/free ports, independent plain-text markers, no caching, exact route and no directory/file routes');

  const began = Date.now(), expiring = await start({ minutes: 0.002 });
  await expiring.closed;
  assert.ok(Date.now() - began >= 100 && Date.now() - began < 2000, 'configured duration closes the listener');
  await assert.rejects(request(expiring.url));
  const once = await start({ minutes: 1, once: true });
  assert.equal((await request(new URL('/wrong', once.url))).status, 404, 'invalid hit does not consume --once');
  assert.equal((await request(once.url)).text, once.token + '\n');
  await once.closed; await assert.rejects(request(once.url));
  console.log('PASS browser identity: expiration and first-valid-hit shutdown');

  const child = spawn(process.execPath, [script, 'serve', '--once'], { stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
  let stderr = '', stdout = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  const metadata = await new Promise((resolve, reject) => {
    const watchdog = setTimeout(() => reject(Error('helper did not publish a URL')), 3000);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.includes('\n')) { clearTimeout(watchdog); resolve(JSON.parse(stdout.split('\n')[0])); }
    });
    child.once('error', error => { clearTimeout(watchdog); reject(error); });
  });
  assert.equal(metadata.pid, child.pid); assert.ok(metadata.expiresAt > Date.now());
  assert.equal((await request(metadata.url)).text, metadata.token + '\n');
  assert.equal(await exit, 0, stderr);
  for (const executable of [script, new URL('../route.mjs', import.meta.url).pathname, new URL('../codex-worker.mjs', import.meta.url).pathname]) {
    const help = spawnSync(process.execPath, [executable, '--help'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /browser-identity|machine-proof/);
  }
  console.log('PASS browser identity CLI: announced URL/marker/pid, --once exits, helper/route/worker help');
} finally {
  for (const service of services) service.close();
  await Promise.all(services.map(service => service.closed));
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
}
