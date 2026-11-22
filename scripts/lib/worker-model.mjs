import fs from 'node:fs';
import path from 'node:path';
import { rolloutReadPath } from './rollout-redaction.mjs';

export const modelFamily = (model) => String(model ?? '').toLowerCase().match(/^(gpt|deepseek|kimi|seed|doubao|gemini|claude)/)?.[1]
  ?.replace('doubao', 'seed') ?? String(model ?? '').toLowerCase();

// Usage belongs to the executing thread/turn. A collab item describes its child.
export const modelObservation = (message, threadId, turnId) => {
  const p = message.params ?? {};
  if (p.threadId !== threadId || (p.turnId !== undefined && p.turnId !== turnId)) return null;
  if (message.method === 'thread/tokenUsage/updated') {
    const model = p.context?.model ?? p.context?.contextUsage?.model ?? p.contextUsage?.model;
    return typeof model === 'string' && model ? { model, source: 'usage-context', scope: 'execution' } : null;
  }
  const item = p.item;
  if (message.method === 'item/completed' && item?.type === 'collabAgentToolCall'
    && item.senderThreadId === threadId && typeof item.model === 'string' && item.model && item.receiverThreadIds?.length) {
    return { model: item.model, effort: item.reasoningEffort ?? null, source: 'collab-agent',
      scope: 'delegation', childThreads: item.receiverThreadIds };
  }
  return null;
};

// Read only the hub-returned session rollout, confined to the account's sessions tree.
// turn_context confirms the client's setting, not a gateway's backend substitution.
export const rolloutTurnModel = (home, file, threadId, turnId) => {
  if (!home || !file || !turnId) return null;
  try {
    const real = fs.realpathSync(file);
    const roots = ['sessions', 'cli/sessions'].map((rel) => path.join(fs.realpathSync(home), rel) + path.sep);
    if (!roots.some((root) => real.startsWith(root)) || !real.endsWith('.jsonl')
      || !path.basename(real).endsWith(`-${threadId}.jsonl`)) return null;
    let found = null, provider = null;
    for (const line of fs.readFileSync(rolloutReadPath(real), 'utf8').split('\n')) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      const settings = row.type === 'thread_settings_applied'
        || (row.type === 'event_msg' && row.payload?.type === 'thread_settings_applied');
      if (row.type === 'session_meta' || settings) {
        provider = row.payload?.model_provider ?? provider;
        if (settings && found && (row.payload?.turn_id == null || row.payload.turn_id === turnId))
          found.provider ??= provider;
      }
      if (row.type === 'turn_context' && row.payload?.turn_id === turnId && row.payload.model) {
        found = { model: row.payload.model, effort: row.payload.effort ?? null,
          provider: row.payload.model_provider ?? provider, source: 'turn-context', scope: 'execution' };
      }
    }
    return found;
  } catch { return null; }
};
