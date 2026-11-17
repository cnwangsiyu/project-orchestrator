// Offline runtime evidence: isolated home, stdio app-server, loopback model fixture.
// Usage: node scripts/test/fixtures/runtime-thread-env-probe.mjs /absolute/path/to/codex
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';

const bin = process.argv[2];
assert.ok(bin && path.isAbsolute(bin), 'supply an absolute runtime executable path');
fs.accessSync(bin, fs.constants.X_OK);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-thread-env-'));
const env = { PATH: process.env.PATH, HOME: tmp, CODEX_HOME: tmp, TRAE_HOME: tmp, TRAECLI_HOME: tmp,
  TMPDIR: tmp, XDG_CONFIG_HOME: tmp, XDG_DATA_HOME: tmp, XDG_CACHE_HOME: tmp };
const version = spawnSync(bin, ['--version'], { env, encoding: 'utf8', timeout: 10000 });
if (version.status !== 0) {
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.equal(version.status, 0, version.stderr);
}
const command = 'printf \'CODEX_THREAD_ID=%s\\nTRAECLI_THREAD_ID=%s\\n\' "${CODEX_THREAD_ID-}" "${TRAECLI_THREAD_ID-}"';
let toolName, child, fixtureError;
const server = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    let output;
    if (body.input.some((item) => item.type === 'function_call_output')) {
      output = [{ id: 'msg-fixture', type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'DONE fixture', annotations: [] }] }];
    } else {
      const tool = body.tools.find((item) => ['exec_command', 'shell_command', 'shell', 'Bash'].includes(item.name));
      assert.ok(tool, `no shell tool in fixture request: ${body.tools.map((item) => item.name).join(', ')}`);
      toolName = tool.name;
      const args = tool.name === 'Bash' ? { command, timeout: 5000 }
        : tool.name === 'exec_command' ? { cmd: command, workdir: tmp, yield_time_ms: 10000, login: false }
          : tool.name === 'shell' ? { command: ['/bin/sh', '-c', command], workdir: tmp, timeout_ms: 5000 }
            : { command, workdir: tmp, timeout_ms: 5000 };
      output = [{ id: 'fc-fixture', type: 'function_call', call_id: 'call-fixture', name: tool.name,
        arguments: JSON.stringify(args), status: 'completed' }];
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const event = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    event('response.created', { response: { id: 'resp-fixture', object: 'response', status: 'in_progress', output: [] } });
    for (const [index, item] of output.entries()) {
      event('response.output_item.added', { output_index: index, item });
      event('response.output_item.done', { output_index: index, item });
    }
    event('response.completed', { response: { id: 'resp-fixture', object: 'response', status: 'completed', output,
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    res.end();
  } catch (error) {
    fixtureError = error;
    res.writeHead(500); res.end('offline fixture error');
    child?.kill('SIGTERM');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
child = spawn(bin, ['app-server', '--listen', 'stdio://',
  '-c', 'model_provider="fixture"', '-c', 'model="fixture"',
  '-c', 'model_providers.fixture.name="Offline fixture"',
  '-c', `model_providers.fixture.base_url="http://127.0.0.1:${port}/v1"`,
  '-c', 'model_providers.fixture.wire_api="responses"',
  '-c', 'model_providers.fixture.requires_openai_auth=false',
  '-c', 'model_providers.fixture.supports_websockets=false',
  '-c', 'features.shell_snapshot=false', '-c', 'features.plugins=false', '-c', 'features.memories=false',
  '-c', 'memories.generate_memories=false', '-c', 'memories.use_memories=false',
  '-c', 'otel.exporter="none"'], { cwd: tmp, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
const stop = (signal) => { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
let stderr = '', id = 0;
child.stderr.on('data', (data) => stderr += data);
const pending = new Map(), notifications = [];
const lines = readline.createInterface({ input: child.stdout });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined) {
    const waiter = pending.get(message.id); pending.delete(message.id);
    if (message.error) waiter?.reject(Error(JSON.stringify(message.error)));
    else waiter?.resolve(message.result);
  } else notifications.push(message);
});
const rpc = (method, params) => new Promise((resolve, reject) => {
  const requestId = ++id; pending.set(requestId, { resolve, reject });
  child.stdin.write(JSON.stringify({ id: requestId, method, params }) + '\n');
});
const timer = setTimeout(() => { fixtureError = Error(`runtime probe timed out: ${stderr}`); stop('SIGTERM'); }, 90000);
const closed = new Promise((resolve) => child.on('close', resolve));
child.on('close', (code) => {
  fixtureError ??= Error(`runtime exited ${code}: ${stderr}`);
  for (const waiter of pending.values()) waiter.reject(fixtureError);
  pending.clear();
});
try {
  await rpc('initialize', { clientInfo: { name: 'offline_thread_env_fixture', version: '1' },
    capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  for (let index = 0; index < 2; index++) {
    const { thread } = await rpc('thread/start', { cwd: tmp, approvalPolicy: 'never', sandbox: 'danger-full-access',
      model: 'fixture', modelProvider: 'fixture', config: { shell_environment_policy: { inherit: 'none' } } });
    const { turn } = await rpc('turn/start', { threadId: thread.id,
      input: [{ type: 'text', text: 'Print only the runtime thread variables.', text_elements: [] }] });
    while (!notifications.some((message) => message.method === 'turn/completed'
      && message.params.threadId === thread.id && message.params.turn.id === turn.id)) {
      if (fixtureError) throw fixtureError;
      assert.equal(child.exitCode, null, stderr);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const completed = notifications.find((message) => message.method === 'turn/completed'
      && message.params.threadId === thread.id && message.params.turn.id === turn.id);
    assert.equal(completed.params.turn.status, 'completed', JSON.stringify(completed));
    const commands = notifications.filter((message) => message.method === 'item/completed'
      && message.params.threadId === thread.id && message.params.item.type === 'commandExecution');
    assert.equal(commands.length, 1, `no completed shell execution (${stderr})`);
    const item = commands[0].params.item;
    const output = item.aggregatedOutput ?? item.rawOutput?.stdout;
    const variable = /traecli/i.test(version.stdout) ? 'TRAECLI_THREAD_ID' : 'CODEX_THREAD_ID';
    assert.match(output, new RegExp(`(?:^|\\n)${variable}=${thread.id}(?:\\n|$)`));
    console.log(`PASS ${version.stdout.trim().replaceAll('\n', '; ')}: ${toolName}, app-server pid=${child.pid}, cwd=${tmp}, ${variable}=${thread.id}; launcher env absent, inherit=none`);
  }
} finally {
  clearTimeout(timer);
  const forceStop = setTimeout(() => stop('SIGKILL'), 3000);
  stop('SIGTERM'); await closed;
  clearTimeout(forceStop);
  lines.close(); server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
