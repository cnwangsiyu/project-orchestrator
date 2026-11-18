#!/usr/bin/env node
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
  { stdio: 'inherit' });
if (child.status === 0) appendEvent({ ...row, event: 'running', mayRun: true });
if (child.error) console.error(`launch-claude-worker: ${child.error.message}`);
process.exitCode = child.status ?? 1;
