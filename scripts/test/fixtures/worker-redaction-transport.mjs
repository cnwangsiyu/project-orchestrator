// Entirely synthetic transport and rollout data. No real hub or account state.
import fs from 'node:fs';
const config = JSON.parse(process.env.WORKER_REDACTION_FIXTURE);
if (config.unreadable) {
  const open = fs.openSync;
  fs.openSync = function(file, ...args) {
    if (file === config.rollout) { const error = Error('fixture I/O failure'); error.code = 'EACCES'; throw error; }
    return open.call(this, file, ...args);
  };
}
globalThis.WebSocket = class {
  constructor() { this.status = config.idleStatus ?? 'inProgress'; setImmediate(() => this.onopen?.()); }
  close() { clearInterval(this.keepAlive); }
  send(raw) {
    const request = JSON.parse(raw);
    if (request.id == null) return;
    const turn = () => ({ id: 'redaction-turn', status: this.status, items: [] });
    if (request.method === 'turn/interrupt') this.status = 'interrupted';
    const result = request.method === 'thread/start' ? { thread: { id: config.thread } }
      : request.method === 'turn/start' ? { turn: turn() }
        : request.method === 'thread/read' ? { thread: { turns: [turn(), ...(config.otherRunning ? [{ id: 'other', status: 'inProgress' }] : [])] } } : {};
    setImmediate(() => {
      this.onmessage?.({ data: JSON.stringify({ id: request.id, result }) });
      if (request.method !== 'turn/start') return;
      this.onmessage?.({ data: JSON.stringify({ method: 'item/commandExecution/outputDelta',
        params: { threadId: config.thread, turnId: 'redaction-turn', delta: config.output ?? 'password=fake-secret-123' } }) });
      if (config.signal) {
        this.keepAlive = setInterval(() => {}, 1000);
        setTimeout(() => process.kill(process.pid, 'SIGTERM'), 20);
        return;
      }
      setTimeout(() => {
        this.status = config.stillRunning ? 'inProgress' : config.status ?? 'completed';
        this.onmessage?.({ data: JSON.stringify({ method: 'turn/completed', params: { threadId: config.thread,
          turn: { ...turn(), status: config.status ?? 'completed', items: [{ type: 'agentMessage', text: config.message ?? 'DONE fixture\nsecret=fake-secret-123' }] } } }) });
      }, 20);
    });
  }
};
