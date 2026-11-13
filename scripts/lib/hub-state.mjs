import fs from 'node:fs';
import path from 'node:path';

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
    if (!['HEALTHY', 'BACKOFF', 'BLOCKED'].includes(row.mode) || !Number.isSafeInteger(row.failures) || row.failures < 0
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
    try { state = readHubState(home, account); } catch { errors.push(`${account}: supervisor state UNKNOWN`); }
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
