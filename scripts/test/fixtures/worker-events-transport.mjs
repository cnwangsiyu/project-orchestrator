import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
const config = JSON.parse(process.env.WORKER_EVENTS_FIXTURE);
if (config.stallProbe) {
  const originalNow = Date.now, interval = globalThis.setInterval;
  let elapsed = 0;
  Date.now = () => originalNow() + elapsed;
  globalThis.setInterval = (callback, ms, ...args) => {
    if (ms !== 30000) return interval(callback, ms, ...args);
    const timer = interval(() => {}, ms);
    setImmediate(() => { elapsed = 120000; callback(...args); });
    return timer;
  };
}
if (config.fastStall) {
  const originalInterval = globalThis.setInterval;
  globalThis.setInterval = (callback, ms, ...args) => originalInterval(callback, ms === 5000 ? 20 : ms, ...args);
}
globalThis.WebSocket = class {
  constructor() { setImmediate(() => this.onopen?.()); }
  close() { clearInterval(this.keepAlive); this.child?.kill('SIGTERM'); }
  notify(method, params) { this.onmessage?.({ data: JSON.stringify({ method, params }) }); }
  shellEnv() {
    // Synthetic values only. Never pass the fixture runner's whole environment
    // to /usr/bin/env or a worker subprocess.
    const env = Object.fromEntries(['PATH', 'HOME', 'RULES_SHARED', 'CODEX_ACCOUNTS'].map((k) => [k, process.env[k]]).filter(([, v]) => v !== undefined));
    if (config.shellEnvMode !== 'ignore') Object.assign(env, this.threadConfig?.shell_environment_policy?.set ?? {});
    // Runtime-owned IDs are independent of the launcher's shell env policy.
    if (config.runtimeThreadEnv) env[config.runtimeThreadEnv] = config.thread;
    if (config.denyShared) Object.assign(env, { TALKBACK_DENY_SHARED: process.env.RULES_SHARED, TALKBACK_DENY_CODE: config.denyCode ?? 'EACCES' });
    return env;
  }
  runShell(turn, index = 0) {
    if (index >= config.shellSequence.length) {
      if (config.holdAfterShell) { this.keepAlive = setInterval(() => {}, 1000); return; }
      this.notify('turn/completed', { threadId: config.thread, turn: { ...turn, status: 'completed', items: [{ type: 'agentMessage', text: 'DONE shell fixture' }] } }); return;
    }
    const step = config.shellSequence[index], id = `shell-${index}`;
    const params = { threadId: config.thread, turnId: turn.id };
    this.notify('item/started', { ...params, item: { id, type: 'commandExecution' } });
    const args = step.map((value) => value === '@await-id' ? this.questionId : value);
    const fixtureDir = path.dirname(new URL(import.meta.url).pathname);
    this.child = spawn(process.execPath, [...(config.denyShared ? ['--import', path.join(fixtureDir, 'worker-talkback-deny.mjs')] : []),
      path.join(fixtureDir, '../../codex-worker.mjs'), ...args], { env: this.shellEnv(), cwd: config.shellCwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const chunk = (data) => {
      output += data;
      const match = output.match(/@@codex-worker-talkback (\{[^\n]+\})/);
      if (match) try { const request = JSON.parse(match[1]); if (request.type === 'question') this.questionId = request.id; } catch {}
      if (config.streamOutput !== false) this.notify('item/commandExecution/outputDelta', { ...params, itemId: id, delta: data.toString() });
    };
    this.child.stdout.on('data', chunk); this.child.stderr.on('data', chunk);
    this.child.on('close', (code) => {
      if (config.shellResults) fs.appendFileSync(config.shellResults, JSON.stringify({ index, code, output }) + '\n');
      this.notify('item/completed', { ...params, item: { id, type: 'commandExecution', aggregatedOutput: output, exitCode: code } });
      this.runShell(turn, index + 1);
    });
  }
  send(raw) {
    const m = JSON.parse(raw);
    if (m.id == null) return;
    if (config.rpc) fs.appendFileSync(config.rpc, JSON.stringify(m) + '\n');
    if (config.rejectContext && m.method === 'thread/resume') {
      setImmediate(() => this.onmessage?.({ data: JSON.stringify({ id: m.id, error: { message: 'fixture rejects thread config' } }) })); return;
    }
    if (m.method === 'thread/resume') this.threadConfig = m.params.config;
    if (config.lostAtTurnStart && m.method === 'turn/start') { setImmediate(() => this.onclose?.()); return; }
    const turn = { id: config.turn ?? 'turn-fixture', status: config.status ?? 'inProgress', items: config.items ?? [] };
    const result = m.method === 'thread/start' ? { thread: { id: config.thread ?? 'thread-fixture' } }
      : m.method === 'turn/start' ? { turn } : m.method === 'thread/read' ? { thread: { name: 'fixture', turns: [turn] } } : {};
    setImmediate(() => {
      this.onmessage?.({ data: JSON.stringify({ id: m.id, result }) });
      if (m.method !== 'turn/start') return;
      if (config.captureEnv) fs.writeFileSync(config.captureEnv, spawnSync('/usr/bin/env', [], { env: this.shellEnv(), encoding: 'utf8' }).stdout);
      if (config.shellSequence) { setImmediate(() => this.runShell(turn)); return; }
      if (config.hold) {
        if (config.commandRunning) this.onmessage?.({ data: JSON.stringify({ method: 'item/started', params: {
          threadId: config.thread ?? 'thread-fixture', turnId: turn.id, item: { id: 'ask-shell', type: 'commandExecution' } } }) });
        this.keepAlive = setInterval(() => {}, 1000);
      }
      else setTimeout(() => {
        if (config.writeOut) fs.writeFileSync(config.writeOut, 'worker deliverable\n');
        this.onmessage?.({ data: JSON.stringify({ method: 'turn/completed', params: { threadId: config.thread ?? 'thread-fixture',
        turn: { ...turn, status: config.fail ? 'failed' : 'completed', items: [{ type: 'agentMessage', text: config.final ?? 'DONE fixture completed\nsecond line' }] } } }) });
      }, 20);
    });
  }
};
