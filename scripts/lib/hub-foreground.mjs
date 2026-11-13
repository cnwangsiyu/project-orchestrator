import { spawn, execFileSync } from 'node:child_process';

export const hubListReachable = ({ script, account, env = process.env }) => {
  try {
    execFileSync(process.execPath, [script, ...(account ? ['--account', account] : []), 'list', '--limit', '1'],
      { timeout: 6000, stdio: 'ignore', env });
    return true;
  } catch { return false; }
};

// launchd owns this long-lived parent and its foreground children, not a Claude session.
export const runHubForeground = async ({ account, profile, hub, script, home, interval = 10000 }) => {
  if (!Number.isFinite(interval) || interval < 10) throw Error('invalid hub check interval');
  const children = new Set();
  let stopped = false, failed = false;
  let wake;
  const pause = () => new Promise((resolve) => {
    const timer = setTimeout(resolve, interval);
    wake = () => { clearTimeout(timer); resolve(); };
  });
  const launch = (bin, args, env = process.env) => {
    const child = spawn(bin, args, { cwd: home, env, stdio: 'inherit' });
    children.add(child);
    child.on('error', () => { failed = true; wake?.(); });
    child.on('exit', () => { children.delete(child); if (!stopped) failed = true; wake?.(); });
    return child;
  };
  const probe = () => hubListReachable({ script, account });
  const health = async (url) => {
    try { return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
  };
  const signal = () => { stopped = true; wake?.(); for (const child of children) child.kill('SIGTERM'); };
  for (const event of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(event, signal);
  try {
    // Never duplicate a reachable hub. Remain alive in standby for an existing unmanaged one.
    const reachable = probe();
    const proxy = profile?.kind === 'ttadk' && profile.searchPort ? `http://127.0.0.1:${profile.searchPort}/__health` : null;
    if (proxy && !(await health(proxy))) {
      launch(process.execPath, [script.replace(/codex-worker\.mjs$/, 'ttadk-search-proxy.mjs'),
        '--port', String(profile.searchPort), '--upstream', profile.upstream ?? 'https://llmbox-global.byteintl.net']);
      for (let i = 0; i < 20 && !stopped && !failed && !(await health(proxy)); i++) await new Promise((r) => setTimeout(r, 100));
      if (!(await health(proxy))) throw Error('TTADK proxy unavailable; login problems must be reported BLOCKED');
    }
    if (stopped || failed) return 1;
    if (!reachable) {
      const env = { ...process.env };
      if (profile?.kind === 'trae') delete env.CODEX_HOME;
      launch(profile?.kind === 'trae' ? profile.bin ?? 'traex' : 'codex', ['app-server', '--listen', hub], env);
      console.error(`hub recovered: ${account ?? 'main'}; tell the global-rules owner`);
      let ready = false;
      for (let i = 0; i < 30 && !stopped && !failed; i++) {
        if (probe()) { ready = true; break; }
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!ready) throw Error('hub did not answer list; launchd will retry');
    }
    console.log(`launchd hub supervisor: ${account ?? 'main'}${reachable ? ' (standby; reachable hub retained)' : ''}`);
    while (!stopped && !failed) {
      await pause();
      if (stopped || failed) break;
      if (proxy && !(await health(proxy))) throw Error('TTADK proxy became unreachable');
      if (!probe()) throw Error('hub unreachable; launchd will retry codex-worker hub after a list probe');
    }
    return stopped ? 0 : 1;
  } finally {
    stopped = true;
    for (const child of children) child.kill('SIGTERM');
    if (children.size) await new Promise((r) => setTimeout(r, 200));
    for (const child of children) child.kill('SIGKILL');
    for (const event of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.off(event, signal);
  }
};
