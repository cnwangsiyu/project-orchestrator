// Named recipients come from the existing ledger/ack, local session and roster union.
import { appendEvent, readEvents, validOwner } from './worker-events.mjs';
import fs from 'node:fs';
import path from 'node:path';
const secretaryName = name => /^(?:工作秘书|秘书|secretary)(?:主对话)?(?:$|[\s（(])/i.test(name ?? '');

export function nightlyRecipients(review, agents = [], roster = '') {
  const named = new Map();
  for (const a of review?.globalRules?.acknowledgements ?? []) {
    const previous = named.get(a.orchestrator);
    if (!previous || (a.at ?? 0) >= (previous.at ?? 0)) named.set(a.orchestrator, a);
  }
  const rows = [...named.values()].map(a => ({ name: a.orchestrator, owner: a.session, project: a.project, host: a.host }));
  for (const a of Array.isArray(agents) ? agents : []) {
    if (!/主对话$/.test(a?.name ?? '') && !secretaryName(a?.name)) continue;
    const match = rows.find(r => r.name === a.name || a.sessionId && r.owner === a.sessionId);
    // Only sessionId can be used by hooks; a job id is not a session identity.
    if (match) match.owner = a.sessionId ?? match.owner;
    else rows.push({ name: a.name, owner: a.sessionId ?? null, project: a.project ?? null, host: a.host ?? null });
  }
  for (const name of roster.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'))) if (!rows.some(r => r.name === name)) rows.push({ name, owner: null });
  return rows;
}

export function secretaryRecipient(recipients) {
  const matches = recipients.filter(r => secretaryName(r.name));
  const mini = matches.filter(r => /mini/i.test(`${r.name} ${r.host ?? ''}`));
  if (mini.length === 1) return mini[0];
  if (matches.length === 1) return matches[0];
  return null;
}

export function decisionMessage(day, decisions, reportPath) {
  for (const d of decisions) {
    if (typeof d.question !== 'string' || !Array.isArray(d.options) || d.options.length < 2 || d.options.length > 4
      || !Number.isInteger(d.recommended) || d.recommended < 0 || d.recommended >= d.options.length
      || !d.options.every(o => typeof o.label === 'string' && typeof o.description === 'string')
      || typeof d.default !== 'string' || !/^不回答则(?:保持现状|\s+.+起按推荐项执行)$/.test(d.default)) throw Error(`decision ${d.id ?? '?'} requires options, recommendation and explicit default`);
  }
  return `夜间复盘 ${day}：请秘书为以下 ${decisions.length} 个决定向用户出卡；报告 ${reportPath}。\n` + decisions.map(d =>
    `${d.id}: ${d.question}\n${d.options.map((o, i) => `${i + 1}. ${o.label}${i === d.recommended ? '（推荐）' : ''}：${o.description}`).join('\n')}\n${d.default}`).join('\n\n');
}

export function deliveryPlan(result, notify, recipients, reportPath) {
  const groups = new Map(), unresolved = [];
  const resolve = key => typeof key === 'string' && key ? recipients.find(r => r.owner === key || r.name === key || r.project === key) : undefined;
  const routing = resolve('routing') ?? resolve('orchestrator') ?? recipients.find(r => /全局规则/.test(r.name ?? ''));
  const push = (recipient, text, findingId) => {
    if (!recipient || !validOwner(recipient.owner)) { unresolved.push({ recipient: recipient?.name ?? 'unknown routing owner', findingId, text }); return; }
    if (!groups.has(recipient.owner)) groups.set(recipient.owner, { owner: recipient.owner, name: recipient.name, items: [] });
    const items = groups.get(recipient.owner).items;
    if (!items.includes(text)) items.push(text);
  };
  for (const f of result.findings.filter(f => f.class !== 'weekly')) {
    if (f.items?.length) {
      const own = new Map();
      for (const i of f.items) {
        const r = resolve(i.owner) ?? resolve(i.project) ?? routing;
        const key = r?.owner ?? r?.name ?? 'unknown';
        if (!own.has(key)) own.set(key, { r, names: [] });
        own.get(key).names.push(i.name ?? '(unnamed)');
      }
      const advice = f.id === 'lane-devbox-imbalance' ? `mini lane p90 ${f.laneWaitP90Minutes} min; devbox occupancy ${f.devboxOccupancyPct}%; ${f.recommendation}; ` : '';
      for (const { r, names } of own.values()) push(r, `${f.id}: ${names.length} own items (${names.join(', ')}); ${advice}${f.evidence.join(', ')}`, f.id);
    } else push(resolve(f.owner) ?? resolve(f.project) ?? routing, `${f.id}: ${f.value}; threshold ${f.comparison ?? ''} ${f.threshold ?? ''}; ${f.evidence.join(', ')}`, f.id);
  }
  for (const a of notify.actions ?? []) {
    if (typeof a.text !== 'string' || !a.text.trim()) throw Error('model action requires concrete text');
    const recipient = resolve(a.orchestrator);
    const ownedFindings = recipient ? result.findings.filter(f => f.class !== 'weekly' && !f.scriptOnly &&
      (f.items?.length ? f.items.some(i => (resolve(i.owner) ?? resolve(i.project) ?? routing)?.owner === recipient.owner)
        : (resolve(f.owner) ?? resolve(f.project) ?? routing)?.owner === recipient.owner)) : [];
    const weekly = result.findings.find(f => f.id === 'weekly-full-review');
    if (weekly && recipient?.project && a.project === recipient.project && Array.isArray(a.evidence) && a.evidence.length
      && a.evidence.every(p => typeof p === 'string' && weekly.evidence.some(e => p === e || p.startsWith(e + '#')))) ownedFindings.push(weekly);
    if (!Array.isArray(a.findingIds) || !a.findingIds.length || !a.findingIds.every(id => ownedFindings.some(f => f.id === id))) throw Error('model action must reference only findings owned by its recipient');
    push(recipient, a.text, a.findingIds.join(','));
  }
  const messages = [...groups.values()].map(g => ({ owner: g.owner, recipient: g.name,
    text: `夜间复盘 ${result.day}：${g.items.join('; ')}。报告 ${reportPath}。无需回复。` }));
  const secretary = secretaryRecipient(recipients);
  if (notify.decisions?.length) messages.push({ owner: validOwner(secretary?.owner) ? secretary.owner : null,
    recipient: secretary?.name ?? null, secretary: true, text: decisionMessage(result.day, notify.decisions, reportPath) });
  return { messages, unresolved };
}

export async function deliverNightly(plan, { day, outFile, append = appendEvent, events = readEvents, relaySecretary } = {}) {
  const sent = [], unresolved = [...plan.unresolved];
  for (const m of plan.messages) {
    if (m.secretary && !m.owner) {
      if (!m.recipient || !relaySecretary) { unresolved.push(m); continue; }
      await relaySecretary(m); sent.push({ recipient: m.recipient, delivery: 'secretary-relay', confirmed: false }); continue;
    }
    if (!validOwner(m.owner)) { unresolved.push(m); continue; }
    const runId = `nightly/${day}/${m.owner}/${m.secretary ? 'decisions' : 'findings'}`;
    // A replay after a receipt-write crash must not duplicate the retained event.
    let event = events().find(r => r.runId === runId && r.owner === m.owner && r.event === 'message');
    if (!event) {
      // The hook renders at most 2000 chars. A longer message keeps its complete body in the outbox artifact.
      let messageFile = outFile;
      if (m.text.length > 1900) {
        messageFile = `${outFile}.${encodeURIComponent(m.owner)}.${m.secretary ? 'decisions' : 'findings'}.txt`;
        fs.mkdirSync(path.dirname(messageFile), {recursive: true});
        fs.writeFileSync(messageFile, m.text + '\n', {mode: 0o600});
      }
      const text = m.text.length <= 1900 ? m.text : `${m.text.slice(0, 1400)} … 完整本会话消息（必须读取，包含所有选项和默认项） ${messageFile}`;
      event = append({ runId, owner: m.owner, event: 'message', kind: 'info', wake: false,
        name: `nightly-review-${day}`, text, outFile: messageFile });
    }
    sent.push({ recipient: m.recipient, owner: m.owner, eventId: event.id, delivery: 'inbox', confirmed: false });
  }
  return { delivery: unresolved.length ? 'blocked' : 'sent', sent, unresolved,
    note: unresolved.length ? 'Recipient session unavailable; no guessed owner or delivery acknowledgement' : 'queued in worker-event inbox; receipt is enqueue, not task acceptance' };
}
