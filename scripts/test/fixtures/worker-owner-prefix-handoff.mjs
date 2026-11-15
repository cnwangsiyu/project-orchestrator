#!/usr/bin/env node
// NR-04 handoff to the router worker. Expected to fail on this branch until worker-events.mjs is fixed.
import assert from 'node:assert/strict';
import { inbox } from '../../lib/worker-events.mjs';
const owner = '9850afbb-edd7-492b-b885-913ccbf40020';
const row = (id, owner, event) => ({ id, owner, event, runId: id, t: Date.now(), pid: process.pid });
const short = row('short-event', '9850afbb', 'finished');
const full = row('full-running', owner, 'running');
assert.equal(inbox([short, full], owner).pending.some(r => r.id === short.id), true,
  'a unique short UUID owner prefix must deliver pending events to the full owner');
const other = row('other', '9850afbb-1111-4222-8333-000000000000', 'running');
assert.equal(inbox([short, full, other], owner).pending.some(r => r.id === short.id), false,
  'ambiguous short prefixes must stay unresolved');
console.log('PASS unique prefix delivery and ambiguous-prefix refusal');
