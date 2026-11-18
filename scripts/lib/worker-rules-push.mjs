import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { digestFile, loadDigest, rulesShared } from './global-rules.mjs';
import { addedRuleLines, compareVersion } from './rules-delivery.mjs';
import { hubRPC } from './hub-state.mjs';
import { MAIN_PROFILE, readProfiles } from './state.mjs';
import { acquireLock, writeJson } from './shared-file.mjs';
import { contextFile, followerAlive, inbox, readEvents, workerKey } from './worker-events.mjs';
import { reconcileTurnEvents } from './worker-turn.mjs';

const runFile = promisify(execFile);
const versionPattern = /^\d{4}-\d{2}-\d{2}\.\d+$/;
const knownVersion = value => typeof value === 'string' && versionPattern.test(value);
const isOlder = (version, target) => !knownVersion(version) || compareVersion(version, target) < 0;
const MAX_MESSAGE_BYTES = 6000;
const DELIVERY_TIMEOUT_MS = 850;
const snapshotFile = version => path.join(rulesShared(), 'worker-rule-versions', `${version}.json`);
const readJson = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const ruleLines = worker => worker.split('\n').filter(line => line.startsWith('- '));
export const rememberWorkerRules = digest => {
  const file = snapshotFile(digest.version);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) writeJson(file, ruleLines(digest.worker));
  return digest.version;
};

const deliveryFile = row => {
  contextFile(row.account, row.thread); // Validate the public identifiers before using them as path components.
  return path.join(rulesShared(), 'worker-rule-deliveries', row.account, `${row.thread}.json`);
};
export const workerRulesVersion = row => {
  if (row.thread && row.turn && row.followerCommand !== 'exec') {
    const receipt = readJson(deliveryFile(row));
    if (receipt?.turn === row.turn && knownVersion(receipt.version)
      && isOlder(row.rulesVersion, receipt.version)) return receipt.version;
  }
  return knownVersion(row.rulesVersion) ? row.rulesVersion : null;
};
export const workerRulesLabel = (row, target) => {
  let version;
  try { version = workerRulesVersion(row); } catch {}
  return `rules=${version ?? 'UNKNOWN'}${target && isOlder(version, target) ? ` (stale; current=${target})` : ''}`;
};

const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
const sentences = line => Array.from(segmenter.segment(line.slice(2)), ({ segment }) => segment.trim()).filter(Boolean);
export const workerRulesMessage = (oldVersion, digest, oldLines) => {
  const before = new Set(oldLines.flatMap(sentences));
  const changes = [...new Set(addedRuleLines(ruleLines(digest.worker), oldLines).flatMap(sentences))]
    .filter(sentence => !before.has(sentence)).map(sentence => `- ${sentence}`);
  if (!changes.length) return null;
  const header = `Worker rules changed ${oldVersion} -> ${digest.version}`;
  const message = [header, ...changes].join('\n');
  if (Buffer.byteLength(message) <= MAX_MESSAGE_BYTES) return message;
  const selected = [header, `See ${digestFile()} for the full worker rules.`];
  for (const line of changes.filter(line => /\b(?:must|never)\b/i.test(line))) {
    if (Buffer.byteLength([...selected, line].join('\n')) <= MAX_MESSAGE_BYTES) selected.push(line);
  }
  return selected.join('\n');
};

export const activeClaudeWorkers = async () => {
  const { stdout } = await runFile('claude', ['agents', '--json'], { timeout: DELIVERY_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
  const sessions = JSON.parse(stdout);
  if (!Array.isArray(sessions)) throw Error('invalid Claude agent list');
  return new Set(sessions.filter(row => row && !['completed', 'finished', 'failed', 'stopped', 'idle'].includes(row.status))
    .flatMap(row => [row.sessionId, row.session_id, row.id]).filter(id => typeof id === 'string'));
};

const steer = async (row, message) => {
  const profile = readProfiles()[row.account];
  const hub = profile?.hub ?? (row.account === 'main' ? process.env.CODEX_HUB ?? MAIN_PROFILE.hub : null);
  if (!hub) throw Error('account hub is not configured');
  // The server compares the turn ID atomically. A completion or a new turn can race the local tracker.
  const result = await hubRPC(hub, 'turn/steer', { threadId: row.thread, expectedTurnId: row.turn,
    input: [{ type: 'text', text: message }] }, DELIVERY_TIMEOUT_MS);
  if (result?.turnId !== row.turn) throw Error('hub did not confirm the expected turn');
};

const running = (owner) => {
  const rows = reconcileTurnEvents(readEvents());
  const owners = owner ? [owner] : [...new Set(rows.map(row => row.owner ?? null))];
  const candidates = new Map();
  for (const id of owners) for (const row of inbox(rows, id).running) {
    if ((row.followerCommand === 'exec' || !row.thread) && !followerAlive(row)) continue;
    const key = workerKey(row), prior = candidates.get(key);
    // A reattached wait may duplicate a launch. Keep the injection evidence for the same turn.
    if (prior && prior.turn === row.turn && prior.rulesVersion && !row.rulesVersion) continue;
    candidates.set(key, row);
  }
  return [...candidates.values()];
};

export const pushWorkerRules = async ({ owner, digest = loadDigest(), onWork = () => {} } = {}) => {
  const rows = running(owner);
  if (!rows.length) return [];
  onWork();
  let claude;
  const results = await Promise.all(rows.map(async row => {
    const label = `account=${row.account} thread=${row.thread ?? '-'} worker=${String(row.name ?? row.runId).replace(/\s+/g, ' ').slice(0, 120)}`;
    const undelivered = reason => `NOT DELIVERED ${label} (${reason})`;
    try {
      let version = workerRulesVersion(row);
      if (!isOlder(version, digest.version)) return null;
      if (row.followerCommand === 'claude') {
        try { claude ??= activeClaudeWorkers(); if (!(await claude).has(row.thread)) return null; }
        catch { return undelivered('Claude running status unavailable'); }
        return undelivered('Claude background sessions have no supported steer transport');
      }
      if (row.followerCommand === 'exec') return undelivered('one-shot exec has no hub steer transport');
      if (!row.thread || !row.turn) return undelivered('tracked thread/turn ID unavailable');
      const file = deliveryFile(row);
      const unlock = acquireLock(file, { timeoutMs: 0, ownerPid: true });
      if (!unlock) return undelivered('another rules push is in progress');
      try {
        version = workerRulesVersion(row);
        if (!isOlder(version, digest.version)) return null;
        if (!version) return undelivered('launch digest version unknown');
        const oldLines = readJson(snapshotFile(version));
        if (!Array.isArray(oldLines)) return undelivered(`worker digest snapshot ${version} unavailable`);
        rememberWorkerRules(digest);
        const message = workerRulesMessage(version, digest, oldLines);
        if (message) await steer(row, message);
        writeJson(file, { turn: row.turn, version: digest.version });
        return `delivered ${label} ${version} -> ${digest.version}${message ? '' : ' (no added or changed worker rules)'}`;
      } finally { unlock(); }
    } catch { return undelivered('hub did not confirm delivery or receipt could not be recorded'); }
  }));
  return results.filter(Boolean);
};
