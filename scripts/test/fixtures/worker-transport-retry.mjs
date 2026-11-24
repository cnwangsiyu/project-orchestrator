// In-memory public hub; no network, accounts or real sessions.
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { appendEvent, readEvents } from '../../lib/worker-events.mjs';
// Board refresh is outside these scenarios; keep its unref'd subprocesses out
// of fixture teardown while leaving worker launch and quota behavior intact.
const nativeSpawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (!args?.[0]?.endsWith('/board.mjs')) return nativeSpawn(command,args,options);
  const child = new EventEmitter(); child.unref = () => {}; child.kill = () => {};
  setImmediate(() => child.emit('exit',0)); return child;
};
syncBuiltinESMExports();
const config = JSON.parse(process.env.TRANSPORT_RETRY_FIXTURE);
const nativeTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, ms, ...args) => {
  // The continuation is a Promise delay; unrelated 60-second RPC watchdogs
  // must not be accelerated or counted as automatic retries.
  const continuationDelay = ms === 60000 && /\[native code\]/.test(Function.prototype.toString.call(callback));
  if (continuationDelay) {
    fs.appendFileSync(config.rpc,JSON.stringify({backoffMs:ms})+'\n');
    config.backedOff = true;
    if (config.cachedTerminalAfterBackoff) {
      const row = readEvents().findLast(row=>row.thread==='transport-thread'&&row.turn==='transport-turn-1');
      appendEvent({...row,event:'failed',status:'failed',mayRun:false,settled:true,runId:'peer-fixture-run',pid:process.pid});
    }
  }
  return nativeTimeout(callback,continuationDelay ? 10 : ms === 5000 && config.loseContinuationAck ? 50 : ms,...args);
};
globalThis.WebSocket = class {
  constructor() {
    this.turns = config.existingTurns ?? (config.wait ? [{id:'transport-turn-1',status:'failed',error:{message:config.errors[0]},items:[]}] : []);
    this.started = this.turns.length;
    setImmediate(() => this.onopen?.());
  }
  close() {}
  notify(message) { this.onmessage?.({data:JSON.stringify(message)}); }
  send(raw) {
    const call = JSON.parse(raw);
    if (call.id == null) return;
    fs.appendFileSync(config.rpc,JSON.stringify(call)+'\n');
    let result = {};
    if (['thread/start','thread/resume'].includes(call.method)) result = {thread:{id:'transport-thread',turns:this.turns}};
    if (call.method === 'thread/read') result = {thread:{id:'transport-thread',turns:this.turns}};
    if (call.method === 'thread/list') result = {data:[{id:'transport-thread',status:{type:'idle'}}],nextCursor:null};
    if (call.method === 'model/internalUsage/read') result = {usage:{quota_limit:1000,quota_remaining:config.exhausted ? 0 : 900}};
    let turn;
    if (call.method === 'turn/start') {
      const error = config.errors[this.started++];
      turn = {id:`transport-turn-${this.started}`,status:error ? 'failed' : 'completed',
        ...(error ? {error:{message:error}} : {}),items:[{type:'agentMessage',text:error ? 'Partial progress' : config.final ?? 'DONE transport fixture'}]};
      this.turns.push(turn); result = {turn:{...turn,status:'inProgress'}};
    }
    setImmediate(() => {
      if (call.method==='thread/read' && config.backedOff && config.hubReadFailureAfterBackoff) {
        this.notify({id:call.id,error:{code:-32000,message:'fixture fresh hub read failed'}}); return;
      }
      if (!(call.method==='turn/start' && this.started===2 && config.loseContinuationAck)) this.notify({id:call.id,result});
      if (turn) nativeTimeout(() => {
        this.notify({method:'item/completed',params:{threadId:'transport-thread',turnId:turn.id,item:{type:'agentMessage',text:turn.items[0].text}}});
        this.notify({method:'turn/completed',params:{threadId:'transport-thread',turn}});
      },5);
    });
  }
};
