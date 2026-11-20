import fs from 'node:fs';
import { readLeases } from './resource-data.mjs';
import { rulesShared } from './global-rules.mjs';
import { shellQuote } from './pipeline/presentation.mjs';

export const TRUNCATED_EXIT = 11;
export const isCompletedFinalItem = item => item?.type === 'agentMessage' && !!item.text && (!item.phase || ['final_answer', 'final'].includes(item.phase));
const finalItem = isCompletedFinalItem;
const lengthStop = value => typeof value === 'string' && /^(?:length|max[_ -]?(?:output[_ -]?)?tokens?|token[_ -]?limit|max[_ -]?length)$/i.test(value);
const stopFields = ['finish_reason', 'finishReason', 'stop_reason', 'stopReason'];
const stoppedAtLimit = object => object && (stopFields.some(field => lengthStop(object[field]))
  || ['response', 'metadata', 'result', 'error'].some(field => object[field] && stopFields.some(name => lengthStop(object[field][name]))));
export function completionEvidence(items = []) {
  let completedAgent = items.filter(item => item?.type === 'agentMessage').at(-1);
  let completedFinal = finalItem(completedAgent), pendingFinal = false, pendingItemId = null, limit = items.some(stoppedAtLimit);
  return {
    observe(message) {
      const params = message.params ?? {}, item = params.item;
      if (message.method === 'item/agentMessage/delta') { pendingFinal = true; pendingItemId = params.itemId; }
      if (message.method === 'item/started' && item?.type === 'agentMessage') { pendingFinal = true; pendingItemId = item.id; }
      if (message.method === 'item/completed' && item?.type === 'agentMessage') {
        completedAgent = item;
        completedFinal = finalItem(item); pendingFinal = false;
        if (stoppedAtLimit(item)) limit = true;
      }
      if (stoppedAtLimit(params) || stoppedAtLimit(params.turn)) limit = true;
    },
    snapshot() { return { completedFinal, completedAgent, pendingFinal, pendingItemId, limit }; },
  };
}
export function completionLeases({ by, account, thread, pid, project, task, name,
  shared = process.env.RES_DIR || rulesShared() } = {}) {
  if (!fs.existsSync(shared + '/resources.tsv')) return { held: [], complete: true };
  const leases = readLeases(shared);
  const holders = [by, thread && `codex:${thread}`, thread && `${account}:${thread}`].filter(Boolean);
  return { ...leases, held: leases.held.filter(hold => holders.includes(hold.holder)
    || pid && hold.pid === pid || project && hold.project === project && [task, name].filter(Boolean).includes(hold.task)) };
}
export function classifyCompletion({ turn, evidence, live = false, completedEvent = true, unconfirmed = false, leases = [],
  requiredMarker = null, final = '' }) {
  if (turn.status === 'transport-failed' || turn.status === 'failed' && isTransportError(turn.error))
    return { status: 'transport-failed', reasons: ['provider turn ended with a network/stream error'], leases: [] };
  if (turn.status === 'TRUNCATED') return { status: 'TRUNCATED', reasons: [turn.reason ?? 'previously classified truncated'],
    leases: leases.map(({ id, holder, pid }) => ({ id, holder, pid })) };
  if (turn.status === 'uncertain') return { status: 'uncertain',
    reasons: [turn.reason ?? 'previously classified uncertain completion'], leases: [] };
  const items = turn.items ?? [];
  const limit = stoppedAtLimit(turn) || items.some(stoppedAtLimit) || evidence?.limit;
  // Provider failures and owner interruptions retain their existing failure/cancellation paths.
  if (turn.status !== 'completed' && !(turn.status === 'failed' && limit)) return null;
  const reasons = [];
  if (limit) reasons.push('transport stop reason reached output limit');
  const lastAgent = items.filter(item => item?.type === 'agentMessage').at(-1) ?? evidence?.completedAgent;
  const markerComplete = requiredMarker && final.trimEnd().split(/\r?\n/).at(-1) === requiredMarker;
  const availableFinal = evidence?.completedFinal || finalItem(lastAgent) || markerComplete;
  if (live && !completedEvent && unconfirmed)
    reasons.push('stream ended without turn-completed event');
  const pendingCovered = finalItem(lastAgent) && (!evidence?.pendingItemId || lastAgent.id === evidence.pendingItemId);
  // Historical hub views may omit all items. Absence in that view is unknown;
  // a live stream or an explicit agent item supplies evidence we can classify.
  if (evidence?.pendingFinal && !pendingCovered || !availableFinal && live && !lastAgent)
    reasons.push('no completed final agent item (commentary is not a final reply)');
  if (requiredMarker && final.trimEnd().split(/\r?\n/).at(-1) !== requiredMarker) reasons.push('required final marker missing');
  if (leases.length) reasons.push('worker still holds res leases');
  if (!reasons.length && !availableFinal && lastAgent)
    return { status: 'uncertain', reasons: ['completed commentary-phase reply has no contractual final evidence'], leases: [] };
  return reasons.length ? { status: 'TRUNCATED', reasons, leases: leases.map(({ id, holder, pid }) => ({ id, holder, pid })) } : null;
}
export function continuationCommand({ script, account, thread, owner, out, log }) {
  const args = [process.execPath, script, '--account', account, 'turn', '--thread', thread,
    ...(owner ? ['--owner', owner] : []), ...(out ? ['--out', out] : []), ...(log ? ['--log', log] : []),
    'Continue from the truncated turn. Inspect the current task artifacts and held leases; finish the remaining authorized work and return owned resources.'];
  return args.map(shellQuote).join(' ');
}

// Classify provider turn failures from public terminal evidence, never task prose.
const TRANSPORT = /stream disconnected before completion|transport error|network error|error decoding response body|connection reset|\bECONNRESET\b|\b(?:HTTP|http[_ ]?status[_ ]?code|status(?:[_ ]?code)?|provider|server)[\s"':=]*5\d\d\b|\b(?:502|503|504)\b|\boverloaded\b|\binternal server error\b|\bbad gateway\b|\bservice unavailable\b/i;
export const isTransportError = error => TRANSPORT.test(typeof error === 'string' ? error : JSON.stringify(error ?? ''));
export const completionKind = turn => classifyCompletion({ turn: turn ?? {} })?.status ?? turn?.status;
export const transportOutcome = row => row?.result === 'transport-failed' || row?.failureKind === 'transport-failed' || row?.state === 'transport-failed';
export const TRANSPORT_WINDOW_MS = 30 * 60000;
export const transportLaneFailures = (rows, account, model, now) => {
  const ids = new Set();
  for (const row of rows ?? []) {
    const actual = row.actual?.at?.(-1) ?? row.actual ?? row.first;
    if (!transportOutcome(row) || !Number.isFinite(row.t) || row.t > now || now - row.t > TRANSPORT_WINDOW_MS
      || (row.account ?? actual?.accountId ?? actual?.account) !== account
      || String(row.modelId ?? actual?.modelId ?? actual?.model ?? '').toLowerCase() !== String(model ?? '').toLowerCase()) continue;
    ids.add(JSON.stringify([row.thread ?? row.name, row.turn ?? row.t]));
  }
  return ids.size;
};
