import fs from 'node:fs';
const config = JSON.parse(process.env.WORKER_EVENTS_FIXTURE);
if (config.fastStall) {
  const originalInterval = globalThis.setInterval;
  globalThis.setInterval = (callback, ms, ...args) => originalInterval(callback, ms === 5000 ? 20 : ms, ...args);
}
globalThis.WebSocket = class {
  constructor() { setImmediate(() => this.onopen?.()); }
  close() { clearInterval(this.keepAlive); }
  send(raw) {
    const m = JSON.parse(raw);
    if (m.id == null) return;
    if (config.rpc) fs.appendFileSync(config.rpc, JSON.stringify(m) + '\n');
    if (config.lostAtTurnStart && m.method === 'turn/start') { setImmediate(() => this.onclose?.()); return; }
    const turn = { id: config.turn ?? 'turn-fixture', status: config.status ?? 'inProgress', items: [] };
    const result = m.method === 'thread/start' ? { thread: { id: config.thread ?? 'thread-fixture' } }
      : m.method === 'turn/start' ? { turn } : m.method === 'thread/read' ? { thread: { name: 'fixture', turns: [turn] } } : {};
    setImmediate(() => {
      this.onmessage?.({ data: JSON.stringify({ id: m.id, result }) });
      if (m.method !== 'turn/start') return;
      if (config.hold) this.keepAlive = setInterval(() => {}, 1000);
      else setTimeout(() => this.onmessage?.({ data: JSON.stringify({ method: 'turn/completed', params: { threadId: config.thread ?? 'thread-fixture',
        turn: { ...turn, status: config.fail ? 'failed' : 'completed', items: [{ type: 'agentMessage', text: config.final ?? 'DONE fixture completed\nsecond line' }] } } }) }), 20);
    });
  }
};
