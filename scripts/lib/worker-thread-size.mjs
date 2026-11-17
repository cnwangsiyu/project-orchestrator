import fs from 'node:fs/promises';
import path from 'node:path';

export const sizeLimits = (opts = {}, env = process.env) => {
  const bytes = Number(opts['max-rollout-mb'] ?? env.CODEX_WORKER_MAX_ROLLOUT_MB ?? 5) * 1024 * 1024;
  const tokens = Number(opts['max-input-tokens'] ?? env.CODEX_WORKER_MAX_INPUT_TOKENS ?? 20000000);
  if (![bytes, tokens].every(n => Number.isFinite(n) && n > 0)) throw Error('thread size limits must be positive finite numbers');
  return { bytes, tokens };
};
// Walk only dated session directories and stat the exact thread's rollout.
// Old threads can live outside the most recent days; never scan rollout bodies.
export async function threadRollouts(home, thread) {
  if (!home || typeof thread !== 'string' || !/^[A-Za-z0-9_-]+$/.test(thread)) return [];
  const dirs = async dir => (await fs.readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter(e => e.isDirectory() && /^\d+$/.test(e.name)).map(e => e.name).sort().reverse();
  const files = [];
  for (const root of [path.join(home, 'sessions'), path.join(home, 'cli/sessions')]) {
    for (const y of await dirs(root)) for (const m of await dirs(path.join(root, y))) for (const d of await dirs(path.join(root, y, m))) {
      const dir = path.join(root, y, m, d);
      for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith(`-${thread}.jsonl`)) continue;
        files.push(path.join(dir, entry.name));
      }
    }
  }
  return files;
}

export async function threadSize(home, thread) {
  let bytes = 0, inputTokens = 0;
  for (const file of await threadRollouts(home, thread)) {
    let fd;
    try {
      fd = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = await fd.stat(); if (!stat.isFile()) continue;
      bytes = Math.max(bytes, stat.size);
      // Only the bounded tail is needed for already-recorded cumulative usage.
      const n = Math.min(stat.size, 65536), buffer = Buffer.alloc(n);
      const read = await fd.read(buffer, 0, n, stat.size - n);
      for (const line of buffer.subarray(0, read.bytesRead).toString().split('\n')) {
        try {
          const row = JSON.parse(line), p = row.payload ?? row.params ?? row;
          const value = p.info?.total_token_usage?.input_tokens ?? p.tokenUsage?.total?.inputTokens
            ?? p.total_token_usage?.input_tokens;
          if (Number.isFinite(value) && value >= 0) inputTokens = Math.max(inputTokens, value);
        } catch {}
      }
    } catch {} finally { await fd?.close().catch(() => {}); }
  }
  return { bytes, inputTokens };
}
export const freshThreadRoute = (args, root) => {
  const clean = [...(args ?? [])];
  for (let at; (at = clean.indexOf('--failure-kind')) >= 0;) clean.splice(at, 2);
  for (let at; (at = clean.findIndex(a => a.startsWith('--failure-kind='))) >= 0;) clean.splice(at, 1);
  const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  return [process.execPath, path.join(root, 'route.mjs'), ...clean, '--failure-kind', 'infra'].map(quote).join(' ');
};
