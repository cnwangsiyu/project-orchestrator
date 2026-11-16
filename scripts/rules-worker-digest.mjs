#!/usr/bin/env node
import { loadDigest } from './lib/global-rules.mjs';
const digest = loadDigest();
if (process.argv.includes('--acks')) {
  const { rulesAcknowledgements } = await import('./lib/rules-acknowledgements.mjs');
  const rows = rulesAcknowledgements({ version: digest.version, ledgerRoot: process.env.RULES_LEDGER_ROOT });
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows));
  else {
    console.log('session\thost\tproject/title\tversion seen\tseen at\tsource');
    for (const row of rows) console.log([row.session ?? row.orchestrator, row.host ?? 'UNKNOWN',
      [row.project, row.title ?? row.orchestrator].filter(Boolean).join(' / '), row.version ?? 'UNKNOWN',
      Number.isFinite(row.at) ? new Date(row.at).toISOString() : 'UNKNOWN', row.source].join('\t'));
  }
} else console.log(`Global worker rules ${digest.version}\n${digest.worker}`);
