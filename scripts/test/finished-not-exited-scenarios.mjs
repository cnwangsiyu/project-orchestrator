import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { finishedNotExited, retireCommand } from '../lib/finished-not-exited.mjs';
import { runningWorkers } from '../lib/running-workers.mjs';
import { taskStatus } from '../board/collect.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finished-not-exited-'));
const now = Date.parse('2026-11-24T03:00:00Z');
const activity = now - 20 * 60_000;
const owner = '1c4bda11-327e-4d6e-93a7-7d46e99b4279';
const report = path.join(dir, 'report.md');

try {
  fs.writeFileSync(report, 'final report\n');
  fs.utimesSync(report, (activity + 1_000) / 1000, (activity + 1_000) / 1000);
  const row = { account: 'trae', runId: 'run-finished', owner, taskDir: dir, outFile: path.join(dir, 'codex-last.md'), lastActivityAt: activity };
  const detected = finishedNotExited(row, { now });
  assert.ok(detected); assert.equal(detected.file, report); assert.equal(Math.floor(detected.inactiveMs / 60_000), 19);
  assert.equal(retireCommand(row), `node scripts/codex-worker.mjs --account trae retire --run run-finished --owner ${owner}`);

  fs.writeFileSync(report, 'DONE report\n');
  fs.utimesSync(report, activity / 1000, activity / 1000);
  assert.ok(finishedNotExited(row, { now }), 'a final DONE message remains final at the same activity timestamp');

  fs.writeFileSync(report, 'ordinary retained report\n');
  fs.utimesSync(report, (activity - 1_000) / 1000, (activity - 1_000) / 1000);
  assert.equal(finishedNotExited(row, { now }), null, 'an earlier report cannot settle a newer continuation');

  fs.writeFileSync(report, 'final report\n');
  fs.utimesSync(report, (activity + 1_000) / 1000, (activity + 1_000) / 1000);
  const live = await runningWorkers({ rows: [{ ...row, pid: 1, event: 'running', t: activity, followerCommand: 'exec' }],
    alive: pid => pid === 1, activityOf: () => null });
  assert.ok(live.threads[0].finishedNotExited, 'quota live-worker collection marks an abandoned final report');
  const display = taskStatus({ ...live.threads[0], finishedNotExited: detected, state: 'running', startedAt: activity - 1_000, runningTools: 0 }, {}, now);
  assert.equal(display.state, 'finished-not-exited');
  assert.match(display.stateReason, /^已完成，会话未退出（19 分钟）$/);
  const boardDisplay = taskStatus({ ...row, state: 'running', lastActivityAt: new Date(activity).toISOString(), startedAt: activity - 1_000, runningTools: 0 }, {}, now);
  assert.equal(boardDisplay.state, 'finished-not-exited', 'the board independently evaluates its ISO activity timestamps');
  console.log('PASS final report evidence marks only inactive followers and is shared by quota and board');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
