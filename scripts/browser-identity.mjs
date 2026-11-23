#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const usage = 'usage: browser-identity.mjs serve [--minutes N] [--once]\nBind 127.0.0.1 on a free port, print a URL and random machine-proof token, and serve it as plain text for N minutes (default 10). --once stops after the first valid hit.\n';
export function parseIdentityArgs(args) {
  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0])) return { help: true };
  if (args[0] !== 'serve') throw Error(usage.trim());
  let minutes = 10, once = false, durationSet = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--once' && !once) once = true;
    else if (args[i] === '--minutes' && !durationSet) {
      minutes = Number(args[++i]); durationSet = true;
    } else throw Error(usage.trim());
  }
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes * 60000 > 2147483647)
    throw Error('--minutes must be positive and fit a Node timer');
  return { minutes, once };
}

export async function serveIdentity({ minutes = 10, once = false } = {}) {
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes * 60000 > 2147483647)
    throw Error('--minutes must be positive and fit a Node timer');
  // This random marker only proves which machine answered a loopback URL. It
  // is never used to authenticate an account or read any browser storage.
  const token = randomBytes(24).toString('hex');
  let timer, stopping = false, resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const server = http.createServer((req, res) => {
    if (req.url !== '/identity' || req.method !== 'GET') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('Not found\n'); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    if (once) res.once('finish', () => close());
    res.end(token + '\n');
  });
  const close = () => {
    if (stopping) return;
    stopping = true; clearTimeout(timer);
    server.close(() => resolveClosed());
    server.closeAllConnections();
  };
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const expiresAt = Date.now() + minutes * 60000;
  timer = setTimeout(close, minutes * 60000);
  return { url: `http://127.0.0.1:${server.address().port}/identity`, token, expiresAt, server, close, closed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseIdentityArgs(process.argv.slice(2));
    if (options.help) process.stdout.write(usage);
    else {
      const service = await serveIdentity(options);
      process.stdout.write(JSON.stringify({ url: service.url, token: service.token, expiresAt: service.expiresAt, pid: process.pid }) + '\n');
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, service.close);
      await service.closed;
    }
  } catch (error) { console.error('browser-identity: ' + error.message); process.exitCode = 2; }
}
