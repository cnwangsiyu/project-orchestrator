import fs from 'node:fs';
const config = JSON.parse(process.env.REROUTE_FIXTURE);
const model = process.argv[process.argv.indexOf('--model') + 1]?.toLowerCase();
const source = model === config.source;
const fail = source || config.everyHop;
globalThis.WebSocket = class {
  constructor() { setImmediate(() => this.onopen()); }
  close() {}
  send(raw) {
    const m = JSON.parse(raw);
    if (m.id == null) return;
    fs.appendFileSync(config.rpc, JSON.stringify({ pid: process.pid, model, ...m }) + '\n');
    if (m.method === 'turn/interrupt' && config.cancel === 'silent') return;
    if (m.method === 'turn/interrupt') this.interrupted = true;
    setImmediate(() => {
      if (fail && ((config.mode === 'unavailable' && m.method === 'thread/start')
        || (config.mode === 'unavailable-turn' && m.method === 'turn/start'))) {
        this.failed = true;
        this.onmessage({ data: JSON.stringify({ id: m.id, error: { code: -32600, message: `model ${model} is unavailable because its metadata could not be resolved` } }) }); return;
      }
      if (fail && ['restriction-start', 'policy-start'].includes(config.mode) && m.method === 'turn/start') {
        this.failed = true;
        this.onmessage({ data: JSON.stringify({ id: m.id, error: { code: -1,
          message: config.mode === 'policy-start' ? 'cyberPolicy: flagged for possible cybersecurity risk' : 'Model access temporarily restricted. (983)' } }) }); return;
      }
      const turn = { id: 'turn', status: this.failed ? 'failed' : this.interrupted && config.cancel !== 'unconfirmed' ? 'interrupted' : 'inProgress',
        items: config.readWork && fail ? [{ type: 'commandExecution' }] : [] };
      const result = m.method === 'thread/start' ? { thread: { id: 'fixture' } }
        : m.method === 'turn/start' ? { turn } : m.method === 'thread/read' ? { thread: { turns: [turn] } } : {};
      this.onmessage({ data: JSON.stringify({ id: m.id, result }) });
      if (m.method !== 'turn/start') return;
      setTimeout(() => {
        const notify = (method, params) => this.onmessage?.({ data: JSON.stringify({ method, params: { threadId: 'fixture', turnId: 'turn', ...params } }) });
        if (!fail) {
          notify('item/started', { item: { type: 'agentMessage' } });
          notify('turn/completed', { turn: { id: 'turn', status: config.childFails ? 'failed' : 'completed',
            items: [{ type: 'agentMessage', text: 'DONE automatic replacement completed' }] } }); return;
        }
        if (config.mode === 'restriction' || config.mode === 'policy') {
          this.failed = true;
          notify('turn/completed', { turn: { id: 'turn', status: 'failed', items: [],
            error: config.mode === 'policy' ? { codexErrorInfo: 'cyberPolicy' } : { message: 'Model access temporarily restricted. (983)' } } }); return;
        }
        if (config.progress) notify('item/started', { item: { type: 'commandExecution' } });
        if (config.ready) notify('queue/status', { state: 'ready', position: 0 });
        const realNow = Date.now, base = realNow() - 120000;
        for (const [offset, position] of [[0, 100], [120000, 90]]) {
          Date.now = () => base + offset;
          notify('queue/status', { state: 'queued', position });
        }
        Date.now = realNow;
        if (config.complete) setTimeout(() => notify('turn/completed', { turn: { id: 'turn', status: 'completed',
          items: [{ type: 'agentMessage', text: 'DONE original completed' }] } }), 30);
      }, 15);
    });
  }
};
