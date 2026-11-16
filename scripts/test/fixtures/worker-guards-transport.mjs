import fs from 'node:fs';
const config = JSON.parse(process.env.WORKER_GUARDS_FIXTURE);
globalThis.WebSocket = class {
  constructor() { if (config.hang !== 'websocket/open') setImmediate(() => this.onopen?.()); }
  close() { clearInterval(this.chatter); }
  notify(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  send(raw) {
    const m = JSON.parse(raw);
    if (m.id == null) return;
    fs.appendFileSync(config.rpc, JSON.stringify(m) + '\n');
    if (m.method === config.hang) return;
    const turn = { id: config.turn ?? 'guard-turn', status: this.interrupted ? 'interrupted' : config.status ?? 'inProgress',
      items: config.status === 'completed' ? [{ type: 'agentMessage', text: config.final ?? 'DONE guard fixture' }] : [] };
    const result = ['thread/start', 'thread/resume'].includes(m.method) ? { thread: { id: config.thread, path: config.rollout,
      model: config.metadataModel ?? 'metadata-is-not-execution-evidence' } }
      : m.method === 'turn/start' ? { turn } : m.method === 'thread/read' ? { thread: { name: 'guard-fixture', turns: [turn] } } : {};
    if (m.method === 'turn/interrupt') this.interrupted = true;
    setImmediate(() => {
      if (m.method === 'turn/start' && config.beforeReply) for (const message of config.messages ?? []) this.notify(message);
      if (m.method === config.rpcFailure) { this.notify({ id: m.id, error: { message: 'fixture launcher failure' } }); return; }
      this.notify({ id: m.id, result });
      if (m.method !== 'turn/start') return;
      setTimeout(() => {
        if (!config.beforeReply) for (const message of config.messages ?? []) this.notify(message);
        if (config.unrelatedChatter) this.chatter = setInterval(() => this.notify({ method: 'thread/tokenUsage/updated',
          params: { threadId: 'other-thread', turnId: 'other-turn', context: { model: 'DeepSeek-V4.1-Flash' } } }), 10);
        if (!config.quiet) this.notify({ method: 'turn/completed', params: { threadId: config.thread,
          turn: config.failure?{...turn,status:'failed',error:{message:config.failure},items:[]}:{ ...turn, status: 'completed', items: [{ type: 'agentMessage', text: config.final ?? 'DONE guard fixture' }] } } });
      }, 10);
    });
  }
};
