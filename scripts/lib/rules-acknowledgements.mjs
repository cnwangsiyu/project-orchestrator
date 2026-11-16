import fs from 'node:fs';
import path from 'node:path';
import { rulesShared } from './global-rules.mjs';
import { parseSeen, validRulesSession, SEEN_LIMIT } from './rules-delivery.mjs';

// Public metadata only. Shared hook receipts take precedence; ledger lines remain a migration fallback.
export const rulesAcknowledgements = ({ version, ledgerRoot = path.dirname(rulesShared()), shared = rulesShared() } = {}) => {
  const file = path.join(shared, 'rules-seen.json');
  let automatic = [];
  try {
    if (fs.statSync(file).size > SEEN_LIMIT) throw Error('large seen file');
    automatic = Object.entries(parseSeen(fs.readFileSync(file, 'utf8')))
      .filter(([id, row]) => validRulesSession(id) && row?.orchestrator === true)
      .map(([session, row]) => ({ session, orchestrator: row.title || session, title: row.title ?? null,
        project: row.project ?? null, host: row.host ?? null, version: row.version ?? null, at: row.at ?? null,
        current: row.version === version, status: 'KNOWN', source: 'hook', file }));
  } catch {}
  const legacy = [];
  try { for (const entry of fs.readdirSync(ledgerRoot, { withFileTypes: true })) {
    if (entry.name === '_shared' || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    if (entry.isSymbolicLink()) {
      try { if (!fs.statSync(path.join(ledgerRoot, entry.name)).isDirectory()) continue; } catch {}
    }
    const ledger = path.join(ledgerRoot, entry.name, 'ledger.md');
    let text; try { text = fs.readFileSync(ledger, 'utf8'); } catch {
      legacy.push({ project: entry.name, orchestrator: entry.name, version: null, current: null, status: 'UNKNOWN', ledger });
      continue;
    }
    const plain = text.replaceAll('**', '').replaceAll('`', '');
    const orchestrator = plain.match(/^\s*(?:[-*+]\s+)?Orchestrator session:\s*(.+)$/mi)?.[1]?.trim().replace(/^"|"$/g, '') ?? entry.name;
    const ack = [...plain.matchAll(/\brules-ack\s*:?[ \t]*(\d{4}-\d{2}-\d{2}\.\d+)\b/g)].at(-1)?.[1] ?? null;
    legacy.push({ project: entry.name, orchestrator, version: ack, current: ack === version, status: 'KNOWN', ledger });
  } } catch { legacy.push({ project: '(ledger root)', orchestrator: '(unknown owner)', version: null,
    current: null, status: 'UNKNOWN', ledger: ledgerRoot }); }
  const used = new Set();
  const rows = legacy.map((row) => {
    const exact = automatic.filter((ack) => ack.session === row.orchestrator || ack.orchestrator === row.orchestrator);
    const matching = (exact.length ? exact : automatic.filter((ack) => ack.project === row.project))
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    if (!matching.length) return { ...row, session: null, host: null, at: null, source: 'ledger' };
    const ack = matching[0]; used.add(ack.session);
    return { ...row, ...ack, project: ack.project ?? row.project };
  });
  rows.push(...automatic.filter((row) => !used.has(row.session)));
  let roster = ''; try { roster = fs.readFileSync(path.join(shared, 'orchestrators.txt'), 'utf8'); } catch {}
  for (const name of roster.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))) {
    if (rows.some((row) => row.orchestrator === name || row.session === name)) continue;
    rows.push({ orchestrator: name, title: name, session: null, project: null, host: null, version: null, at: null,
      current: null, status: 'UNKNOWN', source: 'roster' });
  }
  return rows;
};
