#!/usr/bin/env node
import { sharedCliEnv } from './lib/worker-launch.mjs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { loadDigest, workerInstructions } from './lib/global-rules.mjs';
import { appendEvent, resolveOwner, saveWorkerContext } from './lib/worker-events.mjs';

const [metadata, command, ...args] = process.argv.slice(2);
const { name, model, effort, project, owner: explicitOwner } = JSON.parse(metadata);
const owner = resolveOwner(explicitOwner);
const thread = randomUUID();
const digest = loadDigest();
const rulesVersion = digest.version;
const row = { account: 'claude', owner, thread, name, model, effort, project, rulesVersion, followerCommand: 'claude',
  runId: randomUUID(), cwd: process.cwd() };
// Publish identity before Claude's SessionStart hook can run.
if (owner) saveWorkerContext(row);
const prompt = args.pop();
const child = spawnSync(command, [...args, '--session-id', thread, '--append-system-prompt', workerInstructions(digest), prompt],
  { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL',
    env: { ...process.env, ...sharedCliEnv } });
if (child.status !== 0 && /workspace (?:is )?not trusted/i.test(`${child.stdout ?? ''}\n${child.stderr ?? ''}`)) {
  console.error(`BLOCKED: Claude task directory is not trusted: ${JSON.stringify(row.cwd)}. The user must approve workspace trust.`);
  process.exitCode = 1;
} else if (child.error?.code === 'ETIMEDOUT') {
  console.error(`BLOCKED: Claude background launch timed out after 60s in ${JSON.stringify(row.cwd)}.`);
  process.exitCode = 1;
} else {
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  if (child.status === 0) appendEvent({ ...row, event: 'running', mayRun: true });
  if (child.error) console.error(`launch-claude-worker: ${child.error.message}`);
  process.exitCode = child.status ?? 1;
}
