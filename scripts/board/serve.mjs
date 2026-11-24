#!/usr/bin/env node
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const cookieName = 'mini_duty_board';
const digest = (value) => createHash('sha256').update(value).digest();
const matches = (value, expected) => typeof value === 'string' && timingSafeEqual(digest(value), expected);
const pageFile = new URL('./page.html', import.meta.url);
const defaultData = path.join(os.homedir(), '.claude/orchestrator/_shared/board');
const routes = new Set(['/', '/snapshot.json', '/history', '/healthz']);
const text = 'text/plain; charset=utf-8';
const json = 'application/json; charset=utf-8';

function policy(page) {
  const hashes = (tag) => [...page.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))]
    .map(([, source]) => `'sha256-${digest(source).toString('base64')}'`).join(' ');
  return `default-src 'none'; script-src 'self' ${hashes('script')}; style-src 'self' ${hashes('style')}; `
    + "connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
}

export async function createBoardServer({ data = defaultData, tokenFile = path.join(data, 'token') } = {}) {
  const tokenHandle = await fs.open(tokenFile, 'r');
  let token;
  try {
    const info = await tokenHandle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 512) throw new Error('Access file must be private');
    token = (await tokenHandle.readFile('utf8')).trim();
  } finally { await tokenHandle.close(); }
  if (!/^[\x21-\x7e]{16,256}$/.test(token)) throw new Error('Invalid access file');
  const keyDigest = digest(token);
  const session = createHmac('sha256', token).update('mini-duty-board/session/v1').digest('hex');
  const sessionDigest = digest(session);
  const page = (await fs.readFile(pageFile, 'utf8')).replace(/\r\n?/g, '\n');
  const headers = { 'Cache-Control': 'no-store', 'Content-Security-Policy': policy(page),
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  return http.createServer({ requestTimeout: 10_000, headersTimeout: 10_000 }, async (req, res) => {
    function send(status, type, body, extra = {}) {
      res.writeHead(status, { ...headers, ...extra, 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
      res.end(req.method === 'HEAD' ? undefined : body);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, text, '只读', { Allow: 'GET, HEAD' });
    // Compare the raw path before URL normalization. No filesystem paths ever
    // come from the request, including percent escapes or dot segments.
    const [pathname, query = ''] = (req.url ?? '').split(/\?(.*)/s, 2);
    if (!routes.has(pathname)) return send(404, text, '找不到页面');
    const keys = new URLSearchParams(query).getAll('k');
    if (pathname === '/' && keys.length) {
      if (keys.length !== 1 || !matches(keys[0], keyDigest)) return send(401, text, '需要访问口令');
      return send(303, text, '', { Location: '/', 'Set-Cookie': `${cookieName}=${session}; Path=/; HttpOnly; SameSite=Lax` });
    }
    const cookies = (req.headers.cookie ?? '').split(';').map((part) => part.trim().split('='));
    const presented = cookies.filter(([name]) => name === cookieName);
    if (presented.length !== 1 || presented[0].length !== 2 || !matches(presented[0][1], sessionDigest)) return send(401, text, '需要访问口令');
    if (pathname === '/') return send(200, 'text/html; charset=utf-8', page);
    if (pathname === '/healthz') return send(200, json, '{"ok":true}\n');
    if (pathname === '/history') return send(404, text, '暂不提供历史回看');
    try { return send(200, json, await fs.readFile(path.join(data, 'snapshot.json'))); }
    catch { return send(503, json, '{"error":"快照尚未就绪"}\n'); }
  });
}

async function main() {
  const { values } = parseArgs({ options: { host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '8765' }, data: { type: 'string', default: defaultData }, 'token-file': { type: 'string' } } });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const server = await createBoardServer({ data: values.data, tokenFile: values['token-file'] });
  server.on('error', () => { console.error('board server: could not listen'); process.exitCode = 1; });
  server.listen(port, values.host);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {
  console.error('board server: check --host, --port, --data and the private --token-file');
  process.exitCode = 1;
});
