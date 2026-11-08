#!/usr/bin/env node
// ttadk-search-proxy: gives Codex-on-TTADK web search (verified 2026-11-07).
//
//   node ttadk-search-proxy.mjs --port N --upstream https://llmbox-global.byteintl.net [--log FILE]
//
// Codex sends its hosted `web_search` tool only to OpenAI's own provider; to a custom provider such as TTADK it sends
// none, and with `supports_standalone_web_search` it calls OpenAI's standalone `/alpha/search` endpoint instead, which
// the gateway doesn't have (404). The gateway does run the hosted tool itself when a Responses request carries it. So
// this local pass-through adds `{ type: "web_search" }` to every `POST …/responses` body and forwards everything else
// unchanged, streaming the response back. The TTADK account's provider (`ttadk_app`, written by `codex-worker
// ttadk-setup`) points here, so every TTADK worker can search, as official Codex and Claude Code do by default.
//
// Binds 127.0.0.1 only. Logs method, path, status and whether a tool was added — never headers, tokens or bodies.
// GET /__health answers 200 "ttadk-search-proxy" (codex-worker and quota.mjs check it).
import http from 'node:http';
import fs from 'node:fs';

const args = process.argv.slice(2), opt = {};
for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) opt[args[i].slice(2)] = args[i + 1]?.startsWith('--') ? true : args[++i];
const port = Number(opt.port), upstream = typeof opt.upstream === 'string' ? opt.upstream.replace(/\/+$/, '') : '';
if (!Number.isInteger(port) || port <= 0 || !/^https:\/\//.test(upstream)) {
  process.stderr.write('usage: ttadk-search-proxy.mjs --port N --upstream https://<gateway> [--log FILE]\n'); process.exit(2);
}
const log = (line) => { if (typeof opt.log === 'string') try { fs.appendFileSync(opt.log, `${new Date().toISOString()} ${line}\n`); } catch {} };
const HOP = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'transfer-encoding', 'keep-alive']);

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/__health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ttadk-search-proxy'); }
  const chunks = [];
  try { for await (const c of req) chunks.push(c); } catch { res.writeHead(400); return res.end(); }
  let body = Buffer.concat(chunks), added = false;
  if (req.method === 'POST' && /\/responses(\?|$)/.test(req.url)) {
    try {
      const j = JSON.parse(body.toString('utf8'));
      const tools = Array.isArray(j.tools) ? j.tools : [];
      if (!tools.some((t) => t?.type === 'web_search' || t?.type === 'web_search_preview')) {
        j.tools = [...tools, { type: 'web_search' }]; body = Buffer.from(JSON.stringify(j)); added = true;
      }
    } catch { /* not JSON: forward as is */ }
  }
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  let up;
  try {
    up = await fetch(upstream + req.url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body, signal: ac.signal });
  } catch (e) {
    log(`${req.method} ${req.url} -> upstream error ${e.name}`);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    return res.end('ttadk-search-proxy: upstream unreachable');
  }
  log(`${req.method} ${req.url.split('?')[0]} -> ${up.status}${added ? ' (+web_search)' : ''}`);
  const out = {};
  up.headers.forEach((v, k) => { if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) out[k] = v; });
  res.writeHead(up.status, out);
  try { if (up.body) for await (const c of up.body) res.write(c); } catch { /* client or upstream went away */ }
  res.end();
});
server.on('error', (e) => { process.stderr.write(`ttadk-search-proxy: ${e.message}\n`); process.exit(1); });
server.listen(port, '127.0.0.1', () => log(`listening on 127.0.0.1:${port} -> ${upstream}`));
