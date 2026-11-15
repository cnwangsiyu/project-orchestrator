import fs from 'node:fs';
import path from 'node:path';
import { rulesShared } from './global-rules.mjs';
import { notifyMonitorFailure } from './monitor-notify.mjs';

export const HUB_LOG_LIMIT = 8 * 2 ** 20;
export const hubDirectory = (home) => path.join(home, '.claude/orchestrator/_shared/hub-launchd');
const accountId = (account) => {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(account)) throw Error('invalid hub account ID');
  return account;
};
const stateFile = (home, account) => path.join(hubDirectory(home), `${accountId(account)}.state.json`);

export function readHubState(home, account) {
  const file = stateFile(home, account);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw Error('unsafe hub state');
    const row = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!row||typeof row!=='object'||Array.isArray(row)||!['HEALTHY', 'BACKOFF', 'BLOCKED'].includes(row.mode) || !Number.isSafeInteger(row.failures) || row.failures < 0
      || !Number.isFinite(row.t) || (row.retryAt !== null && !Number.isFinite(row.retryAt))
      || !/^[A-Z_]{1,80}$/.test(row.reason ?? '')) throw Error('invalid hub state');
    return { mode: row.mode, failures: row.failures, t: row.t, retryAt: row.retryAt, reason: row.reason };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function writeHubState(home, account, row) {
  const file = stateFile(home, account), tmp = `${file}.${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw Error('symlink hub state refused');
  try {
    fs.writeFileSync(tmp, JSON.stringify(row), { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
  if (row.mode !== 'HEALTHY' && hubDirectory(home) === path.join(rulesShared(), 'hub-launchd')) {
    try { notifyMonitorFailure(`hub/${account}/${row.reason}`, { event: row.mode === 'BLOCKED' ? 'failed' : 'stalled' }); }
    catch { process.stderr.write('hub monitoring event NOT RECORDED\n'); }
  }
}

// A small transport probe avoids the expensive thread/list endpoint. Only local, registered endpoints are probed.
export async function hubRPC(url, method = null, params = {}, timeoutMs = 1200) {
  const endpoint = new URL(url);
  if (!['ws:', 'wss:'].includes(endpoint.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
    || endpoint.username || endpoint.password) throw Error('hub endpoint must be local');
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint), timer = setTimeout(() => finish(Error('hub probe timeout')), timeoutMs);
    let settled = false;
    function finish(error, result) {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.close();
      error ? reject(error) : resolve(result);
    }
    socket.addEventListener('error', () => finish(Error('hub probe unavailable')));
    socket.addEventListener('close', () => finish(Error('hub probe closed')));
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'initialize',
      params: { clientInfo: { name: 'quota-monitor', version: '1' } } })));
    socket.addEventListener('message', message => {
      let row; try { row = JSON.parse(String(message.data)); } catch { return; }
      if (![1, 2].includes(row.id)) return;
      if (row.error) { finish(Error('hub RPC unavailable')); return; }
      if (row.id === 1 && method) {
        socket.send(JSON.stringify({ method: 'initialized', params: {} }));
        socket.send(JSON.stringify({ id: 2, method, params }));
      } else finish(null, row.result);
    });
  });
}

export async function probeHub({ home, account, hub, timeoutMs = 1200, health, probe } = {}) {
  let supervisor = null;
  try { supervisor = readHubState(home, account); } catch {}
  let endpoint;
  try {
    const url = new URL(hub);
    if (!['ws:', 'wss:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password) throw Error('non-local hub');
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = `${url.pathname.replace(/\/$/, '')}/healthz`; endpoint = String(url);
  } catch { return { account, state: 'down', supervisor, health: false, probe: false, reason: 'hub endpoint unavailable' }; }
  const [http, rpc] = await Promise.allSettled([
    health ? health(endpoint) : fetch(endpoint, { signal: AbortSignal.timeout(timeoutMs) }).then(r => r.ok),
    probe ? probe() : hubRPC(hub, null, {}, timeoutMs),
  ]);
  const healthy = http.status === 'fulfilled' && http.value === true, reachable = rpc.status === 'fulfilled' && rpc.value !== false;
  const state = reachable ? 'up' : healthy ? 'slow-probe' : 'down';
  return { account, state, supervisor, health: healthy, probe: reachable,
    reason: state === 'down' && supervisor?.mode === 'HEALTHY' ? 'supervisor says HEALTHY; current probes failed' : null };
}

export function writeHubLog(home, account, chunk, error = false, limit = HUB_LOG_LIMIT) {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw Error('invalid hub log limit');
  const file = path.join(hubDirectory(home), `${accountId(account)}${error ? '.err' : ''}.log`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (data.length > limit) data = data.subarray(data.length - limit);
  for (const target of [file, `${file}.1`]) if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw Error('symlink hub log refused');
  if (fs.existsSync(file) && fs.statSync(file).size + data.length > limit) {
    // Bring an oversized pre-supervisor log into the same bounded archive policy.
    const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw Error('nonregular hub log refused');
      if (stat.size > limit) {
        const tail = Buffer.alloc(limit);
        const bytes = fs.readSync(fd, tail, 0, limit, stat.size - limit);
        fs.writeSync(fd, tail, 0, bytes, 0); fs.ftruncateSync(fd, bytes);
      }
    } finally { fs.closeSync(fd); }
    if (fs.existsSync(`${file}.1`)) fs.unlinkSync(`${file}.1`);
    fs.renameSync(file, `${file}.1`);
  }
  fs.appendFileSync(file, data, { mode: 0o600 });
}

// Metadata only: never read hub/proxy log contents or account/login files.
export function readHubDiagnostics(home, accounts = ['ttadk', 'trae', 'main', 'b']) {
  const errors = [];
  const entries = accounts.map((account) => {
    let state = null;
    try { state = readHubState(home, account);if(!state) errors.push(`${account}: supervisor state UNKNOWN (missing)`); } catch { errors.push(`${account}: supervisor state UNKNOWN`); }
    const logs = ['.log', '.err.log', '.log.1', '.err.log.1'].map((suffix) => {
      const file = path.join(hubDirectory(home), `${accountId(account)}${suffix}`);
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw Error('unsafe log');
        return { name: path.basename(file), bytes: stat.size, oversized: stat.size > HUB_LOG_LIMIT };
      } catch (error) { if (error.code !== 'ENOENT') errors.push(`${account}: log size UNKNOWN`); return { name: path.basename(file), bytes: null, oversized: null }; }
    });
    return { account, state, logs };
  });
  return { complete: errors.length === 0, entries, errors, logLimitBytes: HUB_LOG_LIMIT, source: 'job-owned hub supervisor state and log sizes only' };
}
