import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { queueDecisionFile } from '../../lib/queue-decision.mjs';
const config = JSON.parse(process.env.REROUTE_FIXTURE);
if (config.functionalSetupBudget) {
  // This case tests the 60 ms follow stall against queue patience, not cold startup/fsync timing.
  const timeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => timeout(fn, ms === 60 ? 1000 : ms, ...args);
}
if (config.authGuard) {
  fs.appendFileSync(config.authGuard, JSON.stringify({ kind: 'guard-active', pid: process.pid }) + '\n');
  const guarded = (fn) => function (file, ...args) {
    if (/(?:^|[/\\])auth\.json(?:$|[?#])/.test(String(file))) {
      fs.appendFileSync(config.authGuard, JSON.stringify({ kind: 'auth-read', pid: process.pid }) + '\n');
      throw Error('fixture blocked a credential-file read');
    }
    return fn.call(this, file, ...args);
  };
  for (const key of ['readFileSync', 'readFile', 'openSync', 'open']) fs[key] = guarded(fs[key]);
  for (const key of ['readFile', 'open']) fs.promises[key] = guarded(fs.promises[key]);
  syncBuiltinESMExports();
}
if (process.argv[1]?.endsWith('/route.mjs') && config.routeFailure) {
  if (config.routeFailure === 'json') { process.stdout.write('{invalid'); process.exit(0); }
  process.exit(Number(config.routeFailure));
}
const flag = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : null; };
const model = flag('model')?.toLowerCase(), account = flag('account');
const source = model === config.source && account === (config.sourceAccount ?? 'trae');
const fail = source || config.everyHop;
globalThis.WebSocket = class {
  constructor() { setImmediate(() => this.onopen()); }
  close() {}
  send(raw) {
    const m = JSON.parse(raw);
    if (m.id == null) return;
    fs.appendFileSync(config.rpc, JSON.stringify({ pid: process.pid, model, account, ...m }) + '\n');
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
      const result = m.method === 'account/rateLimits/read' ? config.usage ?? {}
        : m.method === 'thread/start' ? { thread: { id: 'fixture' } }
        : m.method === 'turn/start' ? { turn } : m.method === 'thread/read' ? { thread: { turns: [turn] } } : {};
      this.onmessage({ data: JSON.stringify({ id: m.id, result }) });
      if (m.method !== 'turn/start') return;
      setTimeout(() => {
        const notify = (method, params) => this.onmessage?.({ data: JSON.stringify({ method, params: { threadId: 'fixture', turnId: 'turn', ...params } }) });
        if (!fail) {
          notify('thread/tokenUsage/updated', { context: { model } });
          notify('item/started', { item: { type: 'agentMessage' } });
          notify('turn/completed', { turn: { id: 'turn', status: config.childFails ? 'failed' : 'completed',
            items: [{ type: 'agentMessage', text: 'DONE automatic replacement completed' }] } }); return;
        }
        if (config.mode === 'restriction' || config.mode === 'policy') {
          this.failed = true;
          notify('turn/completed', { turn: { id: 'turn', status: 'failed', items: [],
            error: config.mode === 'policy' ? { codexErrorInfo: 'cyberPolicy' } : { message: 'Model access temporarily restricted. (983)' } } }); return;
        }
        if(config.queueOwnerSelect) {
          const timer=setInterval(()=>{
            let state;try{state=JSON.parse(fs.readFileSync(queueDecisionFile({account,thread:'fixture',turn:'turn'})));}catch{return;}
            if(state.status!=='waiting'||!state.options)return;
            const option=state.options.find(o=>Object.entries(config.queueOwnerSelect).every(([k,v])=>o[k]===v));
            if(!option)return;
            clearInterval(timer);
            let choice=option.command;
            if(option.needsUserApproval&&config.queueOwnerApprove) {
              const grant=option.approvalCommand.replace('<actual user decision reference>','fixture-explicit-user-decision')
                .replace('<approval expiry ISO>',new Date(Date.now()+3600000).toISOString());
              const granted=spawnSync('/bin/sh',['-c',grant],{env:process.env,encoding:'utf8',timeout:5000});
              if(granted.status!==0){console.error('fixture scoped approval failed');return;}
              const snapshot=JSON.parse(fs.readFileSync(process.env.ROUTE_SNAPSHOT_FILE));
              snapshot.approvals=JSON.parse(fs.readFileSync(`${process.env.RULES_SHARED}/route-approvals.json`));
              fs.writeFileSync(process.env.ROUTE_SNAPSHOT_FILE,JSON.stringify(snapshot));
              choice+=` --user-ok ${granted.stdout.trim()}`;
            }
            const result=spawnSync('/bin/sh',['-c',choice],{env:process.env,encoding:'utf8',timeout:5000});
            if(result.status!==0)console.error(`fixture queue choice failed: ${result.stdout} ${result.stderr}`);
          },100);timer.unref();
        }
        if (config.progress) notify('item/started', { item: { type: 'commandExecution' } });
        if (config.ready) notify('queue/status', { state: 'ready', position: 0 });
        const realNow = Date.now, base = realNow() - (config.queueAgeMin!=null?config.queueAgeMin*60000:config.quiet?0:120000);
        for (const [offset, position] of config.samples ?? (config.quiet ? [[0, 100]] : [[0, 100], [120000, 90]])) {
          Date.now = () => base + offset;
          notify('queue/status', { state: 'queued', position });
        }
        Date.now = realNow;
        if (config.quiet) setTimeout(() => {}, config.quietKeepAliveMs ?? 3000);
        if (config.complete) setTimeout(() => notify('turn/completed', { turn: { id: 'turn', status: 'completed',
          items: [{ type: 'agentMessage', text: 'DONE original completed' }] } }), config.completeDelayMs??30);
      }, 15);
    });
  }
};
