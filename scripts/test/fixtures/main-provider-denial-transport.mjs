// In-memory hub and scratch public metadata only; no network or real accounts.
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';

const nativeSpawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (!args?.[0]?.endsWith('/board.mjs')) return nativeSpawn(command, args, options);
  const child = new EventEmitter(); child.unref = () => {}; child.kill = () => {};
  setImmediate(() => child.emit('exit', 0)); return child;
};
syncBuiltinESMExports();
const config = JSON.parse(process.env.MAIN_DENIAL_FIXTURE);
const index = process.argv.indexOf('--account');
const account = index < 0 ? 'main' : process.argv[index + 1];
const threadId = `${account}-denial-thread`;
globalThis.WebSocket = class {
  constructor() { this.turns = []; setImmediate(() => this.onopen?.()); }
  close() {}
  notify(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  send(raw) {
    const call = JSON.parse(raw);
    if (call.id == null) return;
    fs.appendFileSync(config.rpc, JSON.stringify({ account, method: call.method, params: call.params }) + '\n');
    let result = {};
    if (['thread/start', 'thread/resume', 'thread/read'].includes(call.method))
      result = { thread: { id: threadId, turns: this.turns, ...(config.unknownHub && this.turns.length ? { status: { type: 'unknown' } } : {}) } };
    if (call.method === 'thread/list') result = { data: [{ id: threadId, status: { type: 'idle' } }], nextCursor: null };
    let turn;
    if (call.method === 'turn/start') {
      const denied = account === 'main';
      turn = { id: `${account}-denial-turn`, status: denied ? 'failed' : 'completed',
        ...(denied ? { error: { codexErrorInfo: 'usageLimitExceeded', message: 'stream disconnected before completion: usage limit exceeded' } } : {}),
        items: [{ type: 'agentMessage', phase: denied ? 'commentary' : 'final_answer', text: denied ? 'Completed a scoped edit before the limit.' : 'DONE company fallback fixture' }] };
      this.turns.push(turn); result = { turn: { id: turn.id, status: 'inProgress' } };
    }
    setImmediate(() => {
      this.notify({ id: call.id, result });
      if (turn) setTimeout(() => {
        if (config.workStarted !== false || account !== 'main') this.notify({ method: 'item/completed', params: { threadId, turnId: turn.id, item: turn.items[0] } });
        this.notify({ method: 'turn/completed', params: { threadId, turn } });
      }, 5);
    });
  }
};
