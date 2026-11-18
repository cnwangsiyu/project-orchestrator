// App-server startup notifications can precede the thread/start reply. Keep
// them by thread so a browser turn never starts while its tools are loading.
export function mcpStartupMonitor(name = 'playwright') {
  const states = new Map(), listeners = new Map();
  const update = (threadId, status, reason) => {
    if (!threadId || !['starting', 'ready', 'failed'].includes(status)) return;
    const state = { status, reason }; states.set(threadId, state);
    listeners.get(threadId)?.(state);
  };
  return {
    observe(message) {
      const p = message.params;
      if (message.method === 'mcpServer/startupStatus/updated' && p?.name === name)
        update(p.threadId, p.status, p.failureReason ?? p.error?.message ?? p.error);
    },
    wait(threadId, { timeoutMs = 130000, readStatus } = {}) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
          if (settled) return; settled = true; clearTimeout(timer); listeners.delete(threadId);
          error ? reject(error) : resolve();
        };
        const check = state => {
          if (state?.status === 'ready') finish();
          else if (state?.status === 'failed') finish(Error(`BLOCKED browser preflight: MCP ${name} failed to start${state.reason ? ` (${state.reason})` : ''}; no browser turn was sent.`));
        };
        const timer = setTimeout(() => finish(Error(`BLOCKED browser preflight: MCP ${name} did not become ready within ${timeoutMs}ms (last status: ${states.get(threadId)?.status ?? 'unknown'}); no browser turn was sent.`)), timeoutMs);
        listeners.set(threadId, check); check(states.get(threadId));
        if (!settled && readStatus) Promise.resolve().then(readStatus).then(result => {
          if (settled) return;
          const server = result?.data?.find(s => s.name === name);
          if (server?.runtimeStatus === 'ready') {
            const tools = Object.keys(server.tools ?? {});
            if (!tools.some(t => t.endsWith('browser_navigate')) || !tools.some(t => t.endsWith('browser_snapshot')))
              finish(Error(`BLOCKED browser preflight: MCP ${name} is ready but browser tools are missing; no browser turn was sent.`));
            else update(threadId, 'ready');
          } else if (server) update(threadId, server.runtimeStatus, server.toolsError);
        }).catch(() => {}); // Notifications remain authoritative when status reads fail.
      });
    },
  };
}
