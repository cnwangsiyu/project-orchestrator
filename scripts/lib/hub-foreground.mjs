import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { readHubState, writeHubState, writeHubLog } from './hub-state.mjs';

export const hubListReachable = ({ script, account, env = process.env, timeoutMs = 6000 }) => {
  try {
    execFileSync(process.execPath, [script, ...(account ? ['--account', account] : []), 'list', '--limit', '1'],
      { timeout: timeoutMs, stdio: 'ignore', env });
    return true;
  } catch { return false; }
};

// launchd owns this long-lived parent and its foreground children, not a Claude session.
export const runHubForeground = async ({ account, profile, hub, script, home, interval = 10000,
  configError = false, baseBackoffMs = 30000, maxFailures = 5, stableMs = 60000, probeTimeoutMs = 6000 }) => {
  if (!Number.isFinite(interval) || interval < 10) throw Error('invalid hub check interval');
  const name = account ?? 'main';
  const log = (text, error = false) => writeHubLog(home, name, text + '\n', error);
  const children = new Set();
  let stopped = false, failed = false, failureReason = 'START_FAILED';
  let wake;
  const pause = () => new Promise((resolve) => {
    const timer = setTimeout(resolve, interval);
    wake = () => { clearTimeout(timer); resolve(); };
  });
  const launch = (bin, args, env = process.env) => {
    const child = spawn(bin, args, { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    child.stdout.on('data', (part) => { try { writeHubLog(home, name, part); } catch { failed = true; failureReason = 'LOG_FAILED'; wake?.(); } });
    child.stderr.on('data', (part) => { try { writeHubLog(home, name, part, true); } catch { failed = true; failureReason = 'LOG_FAILED'; wake?.(); } });
    child.on('error', () => { failed = true; failureReason = 'CHILD_START_FAILED'; wake?.(); });
    child.on('exit', () => { children.delete(child); if (!stopped) { failed = true; failureReason = 'CHILD_EXIT'; } wake?.(); });
    return child;
  };
  const probe = () => hubListReachable({ script, account, timeoutMs: probeTimeoutMs });
  const health = async (url) => {
    try { return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
  };
  const signal = () => { stopped = true; wake?.(); for (const child of children) child.kill('SIGTERM'); };
  for (const event of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(event, signal);
  try {
    let state = readHubState(home, name);
    let announced = false;
    while (!stopped && (state?.mode === 'BLOCKED' || state?.retryAt > Date.now())) {
      if (!announced) { log(`hub ${state.mode}: ${name}; failures=${state.failures}; tell the global-rules owner; repair then clear ${name}.state.json and restart the reviewed agent`, true); announced = true; }
      await pause();
      state = readHubState(home, name);
      // Owner-started reachable hubs may recover a blocked supervisor without duplication.
      if (!configError && probe()) break;
    }
    if (stopped) return 0;
    if (configError) { failureReason = 'UNREGISTERED_ACCOUNT'; throw Error('account registration required'); }
    // Never duplicate a reachable hub. Remain alive in standby for an existing unmanaged one.
    const reachable = probe();
    const proxy = profile?.kind === 'ttadk' && profile.searchPort ? `http://127.0.0.1:${profile.searchPort}/__health` : null;
    if (proxy && !(await health(proxy))) {
      launch(process.execPath, [script.replace(/codex-worker\.mjs$/, 'ttadk-search-proxy.mjs'),
        '--port', String(profile.searchPort), '--upstream', profile.upstream ?? 'https://llmbox-global.byteintl.net',
        '--log', path.join(profile.home ?? process.env.CODEX_HOME ?? home, 'search-proxy.log')]);
      for (let i = 0; i < 20 && !stopped && !failed && !(await health(proxy)); i++) await new Promise((r) => setTimeout(r, 100));
      if (!(await health(proxy))) { failureReason = 'PROXY_UNREACHABLE'; throw Error('TTADK proxy unavailable; login problems must be reported BLOCKED'); }
    }
    if (stopped) return 0;
    if (failed) throw Error('owned child failed');
    if (!reachable) {
      const env = { ...process.env };
      if (profile?.kind === 'trae') delete env.CODEX_HOME;
      launch(profile?.kind === 'trae' ? profile.bin ?? 'traex' : 'codex', ['app-server', '--listen', hub], env);
      log(`hub recovered: ${name}; tell the global-rules owner`, true);
      let ready = false;
      for (let i = 0; i < 30 && !stopped && !failed; i++) {
        if (probe()) { ready = true; break; }
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!ready) { if (!failed) failureReason = 'HUB_UNREACHABLE'; throw Error('hub did not answer list'); }
    }
    const healthyAt = Date.now(), priorFailures = readHubState(home, name)?.failures ?? 0;
    let stable = false;
    writeHubState(home, name, { mode: 'HEALTHY', failures: priorFailures, t: healthyAt, retryAt: null, reason: 'NONE' });
    log(`launchd hub supervisor: ${name}${reachable ? ' (standby; reachable hub retained)' : ''}`);
    while (!stopped && !failed) {
      await pause();
      if (stopped || failed) break;
      if (proxy && !(await health(proxy))) { failureReason = 'PROXY_UNREACHABLE'; throw Error('TTADK proxy became unreachable'); }
      if (!probe()) { failureReason = 'HUB_UNREACHABLE'; throw Error('hub unreachable'); }
      if (!stable && Date.now() - healthyAt >= stableMs) {
        stable = true;
        writeHubState(home, name, { mode: 'HEALTHY', failures: 0, t: Date.now(), retryAt: null, reason: 'NONE' });
      }
    }
    if (stopped) return 0;
    throw Error('owned child failed');
  } catch {
    if (stopped) return 0;
    let previous;
    try { previous = readHubState(home, name); } catch {}
    const failures = (previous?.failures ?? 0) + 1;
    const row = { mode: failures >= maxFailures ? 'BLOCKED' : 'BACKOFF', failures, t: Date.now(),
      retryAt: failures >= maxFailures ? null : Date.now() + Math.min(900000, baseBackoffMs * 2 ** (failures - 1)), reason: failureReason };
    writeHubState(home, name, row);
    log(`hub ${row.mode}: ${name}, ${row.reason}, failures=${failures}; tell the global-rules owner; nightly resource review reports this state`, true);
    return 1;
  } finally {
    stopped = true;
    for (const child of children) child.kill('SIGTERM');
    if (children.size) await new Promise((r) => setTimeout(r, 200));
    for (const child of children) child.kill('SIGKILL');
    for (const event of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.off(event, signal);
  }
};
