#!/usr/bin/env node
import { autoupdate } from './skill-autoupdate.mjs';
import { orchestrator } from './lib/hook-context.mjs';
import { validRulesSession, readSeen, withRulesDelivery, hookOutput, cleanupRulesDelivery } from './lib/rules-delivery.mjs';

process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));
// Async disk operations cannot block this fail-open deadline (template timeout: 2s).
const deadline = setTimeout(async () => {
  await Promise.race([cleanupRulesDelivery(), new Promise(resolve => setTimeout(resolve, 40))]);
  process.exit(0);
}, 700);
try {
  let raw = '';
  for await (const part of process.stdin) { raw += part; if (Buffer.byteLength(raw) > 65536) throw Error('input too large'); }
  const input = JSON.parse(raw);
  if (!input || input.hook_event_name !== 'SessionStart' || !['startup', 'resume', 'compact', 'fork', 'clear'].includes(input.source)
    || !validRulesSession(input.session_id)) process.exit(0);
  const seen = await readSeen();
  if (!await orchestrator(input, seen)) process.exit(0);
  await autoupdate();
  await withRulesDelivery(input, seen, { initial: true }, async (rules) => {
    await hookOutput({ hookSpecificOutput: { hookEventName: 'SessionStart',
      additionalContext: rules?.reason ?? 'No changes since the version you last saw.' } });
    if (rules) rules.delivered = true;
  });
} catch {} finally { clearTimeout(deadline); }
