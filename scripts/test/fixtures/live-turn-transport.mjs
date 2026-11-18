import fs from 'node:fs';

const config = JSON.parse(process.env.LIVE_TURN_FIXTURE);
const read = () => JSON.parse(fs.readFileSync(config.state, 'utf8'));
const save = state => {
  const tmp = `${config.state}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, config.state);
};

// Each CLI sees the same isolated hub registry, but thread/read can lag its live turn.
globalThis.WebSocket = class {
  constructor() { setImmediate(() => this.onopen?.()); }
  close() { clearInterval(this.poll); }
  notify(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  send(raw) {
    const request = JSON.parse(raw);
    if (request.id == null) return;
    fs.appendFileSync(config.rpc, JSON.stringify(request) + '\n');
    const state = read(), thread = { id: config.thread, name: 'resumed-fixture', turns: state.persisted };
    let result = {};
    if (['thread/read', 'thread/resume'].includes(request.method)) result = { thread };
    if (request.method === 'thread/read' && state.readError) {
      setImmediate(() => this.notify({ id: request.id, error: { code: -1, message: 'isolated read unavailable' } }));
      return;
    }
    if (request.method === 'turn/start') {
      state.live = { id: config.turn, status: 'inProgress', items: [] };
      save(state); result = { turn: state.live };
      this.poll = setInterval(() => {
        const live = read().live;
        if (live?.status === 'inProgress') return;
        clearInterval(this.poll);
        this.notify({ method: 'turn/completed', params: { threadId: config.thread, turn: live } });
      }, 20);
    }
    if (['turn/steer', 'turn/interrupt'].includes(request.method)) {
      const target = request.params.expectedTurnId ?? request.params.turnId;
      if (state.live?.status !== 'inProgress' || target !== state.live.id) {
        setImmediate(() => this.notify({ id: request.id, error: { code: -1, message: 'wrong live turn' } }));
        return;
      }
      result = { turnId: state.live.id };
      if (request.method === 'turn/interrupt') {
        state.live.status = 'interrupted';
        state.live.items = [{ type: 'agentMessage', text: 'DONE interrupted fixture' }];
        save(state);
      }
    }
    setImmediate(() => this.notify({ id: request.id, result }));
  }
};
