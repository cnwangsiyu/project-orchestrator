import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { appendNote } from '../../lib/worker-events.mjs';
import { queueDecisionFile, notifyQueueOwner } from '../../lib/queue-decision.mjs';
import { saveQueue } from '../../lib/worker-queue.mjs';
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
      const turn = { id: 'turn', status: config.readStatus ?? (this.failed ? 'failed' : this.interrupted && config.cancel !== 'unconfirmed' ? 'interrupted' : 'inProgress'),
        items: config.midTurn && fail && this.midWorked ? [{id:'mid-tool',type:config.midToolType??'commandExecution',status:this.toolLive||config.midReadRunning?'inProgress':'completed'}]
          : config.readWork && fail ? [{ type: 'commandExecution' }] : [] };
      if(this.interrupted&&config.cancel==='completed') {
        turn.status='completed';turn.items.push({type:'agentMessage',text:'DONE original completed during queue choice'});
      }
      const result = m.method === 'account/rateLimits/read' ? config.usage ?? {}
        : m.method === 'thread/start' ? { thread: { id: 'fixture' } }
        : m.method === 'turn/start' ? { turn } : m.method === 'thread/read' ? { thread: { turns: [turn] } } : {};
      if (m.method==='thread/read' && this.readyDuringRead) { const notify=this.readyDuringRead;this.readyDuringRead=null;notify(); }
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
        if (config.watcherOnlyQueue) {
          // Another observer records the queue and emits its notice; this follower
          // receives no queue/status event, so its own idle alarm still expires.
          const profiles = JSON.parse(fs.readFileSync(process.env.CODEX_ACCOUNTS));
          const queue = { state: 'queued', turnId: 'turn', since: Date.now() - 6 * 60000, position: 270, drainPerMin: 0 };
          saveQueue(profiles[account].home, 'fixture', queue);
          const defaults = Object.fromEntries(['owner', 'name', 'cwd', 'project', 'log', 'out', 'route-args', 'sandbox']
            .map(name => [name, flag(name)]));
          notifyQueueOwner({ account, thread: 'fixture', turn: 'turn', owner: defaults.owner,
            name: defaults.name, project: defaults.project, model, effort: flag('effort'), pid: process.pid }, queue, { defaults });
          if (config.disconnect) setTimeout(() => this.onclose?.(), 30);
          setTimeout(() => {}, 10000);
          return;
        }
        if(config.queueOwnerSelect) {
          const timer=setInterval(()=>{
            let state;try{state=JSON.parse(fs.readFileSync(queueDecisionFile({account,thread:'fixture',turn:'turn'})));}catch{return;}
            if(state.status!=='waiting'||!state.options||config.chooseDuringTool&&!this.toolLive)return;
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
            const chooser=spawn('/bin/sh',['-c',choice],{env:process.env,stdio:['ignore','pipe','pipe']});
            let stdout='',stderr='';
            chooser.stdout.on('data',chunk=>{stdout+=chunk;});chooser.stderr.on('data',chunk=>{stderr+=chunk;});
            chooser.on('close',status=>{
              fs.appendFileSync(config.rpc,JSON.stringify({method:'fixture/choice-result',status,stdout,stderr})+'\n');
              if(config.chooseDuringTool && !config.endWithPending) {
                // A new waiting notification, not the cached sample during the
                // tool, is the authority to attempt the recorded choice.
                this.toolLive=false;
                const realNow=Date.now;
                Date.now=()=>realNow()-61000;
                notify('item/completed',{item:{id:'mid-tool',type:config.midToolType??'commandExecution',status:'completed'}});
                Date.now=realNow;
                if(!config.noFreshQueue)notify('queue/status',{state:'queued',position:490});
              }
            });
          },50);timer.unref();
        }
        if (config.midTurn) {
          const realNow=Date.now, at=realNow(), queuedAt=at-(config.queueAgeMin??6)*60000;
          Date.now=()=>queuedAt-(config.midWorkMinutes??24)*60000;
          if(!config.midWithoutReady)notify('queue/status',{state:'ready',position:0});
          const item={id:'mid-tool',type:config.midToolType??'commandExecution',status:'inProgress'};
          if(config.midServerRequest) this.onmessage({data:JSON.stringify({id:990,method:'item/tool/call',params:{threadId:'fixture',turnId:'turn'}})});
          else {
            notify('item/started',{item});
            if(!config.midToolRunning)notify('item/completed',{item:{...item,status:'completed'}});
          }
          this.midWorked=true;
          this.toolLive=!!config.midToolRunning;
          Date.now=()=>queuedAt;
          if (config.midNote) appendNote({ account,thread:'fixture',turn:'turn',owner:flag('owner'),runId:'fixture-stage-note' },'progress','Tool stage completed');
          notify('queue/status',{state:'queued',position:501});
          for(const age of config.midSamples??[]) {
            Date.now=()=>queuedAt+age*60000;
            notify('queue/status',{state:'queued',position:501});
          }
          Date.now=realNow;
          if (config.chooseDuringTool) setTimeout(()=>{
            this.toolLive=true;
            notify('item/started',{item:{...item,status:'inProgress'}});
            notify('queue/status',{state:'queued',position:500});
          },125);
          if (config.readyDuringRead) this.readyDuringRead=()=>notify('queue/status',{state:'ready',position:0});
        } else {
        if (config.progress) notify('item/started', { item: { type: 'commandExecution' } });
        if (config.ready) notify('queue/status', { state: 'ready', position: 0 });
        const realNow = Date.now, base = realNow() - (config.queueAgeMin!=null?config.queueAgeMin*60000:config.quiet?0:120000);
        for (const [offset, position] of config.samples ?? (config.quiet ? [[0, 100]] : [[0, 100], [120000, 90]])) {
          Date.now = () => base + offset;
          notify('queue/status', { state: 'queued', position });
        }
        Date.now = realNow;
        }
        if (config.quiet) setTimeout(() => {}, config.quietKeepAliveMs ?? 3000);
        if (config.complete) setTimeout(() => {
          notify('turn/completed', {turn:{id:'turn',status:'completed',items:[{type:'agentMessage',text:'DONE original completed'}]}});
          if(config.queueWhileReporting) {
            const realNow=Date.now;
            notify('queue/status',{state:'queued',position:501});
            const later=realNow()+6*60000;Date.now=()=>later;
            notify('queue/status',{state:'queued',position:501});Date.now=realNow;
          }
        },config.completeDelayMs??30);
      }, 15);
    });
  }
};
