#!/usr/bin/env node
// Policy text only: never open the live signing registry, allowlist, receipts or any signing material.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadDigest } from '../lib/global-rules.mjs';
const root = new URL('../../', import.meta.url);
for (const file of ['SKILL.md', 'references/global-rules.md', 'references/codex-workers.md',
  'references/rules-enforcement.md', 'references/nightly-review.md', 'scripts/route.mjs']) {
  const text = fs.readFileSync(fileURLToPath(new URL(file, root)), 'utf8');
  for (const id of ['identities.json', 'registry.json', 'DH59R4RNRY', '3JVMQQBHUR', '2027-09', 'H6']) assert.ok(text.includes(id), `${file}: ${id}`);
  assert.ok(/[Oo]nly orchestrators write registry|[Rr]egistry entries are written only by orchestrators/.test(text), `${file}: registry owner`);
  assert.ok(/[Ss]igning workers.*(?:read-only|must not change)/s.test(text), `${file}: worker read-only`);
  assert.ok(/[Nn]ew identit(?:y|ies).*new user approval card/s.test(text), `${file}: new identity approval`);
  assert.ok(/[Ww]orker.*new entr.*BLOCKED/s.test(text), `${file}: new entry blocked`);
}
const digest = loadDigest();
assert.equal(digest.version, '2026-11-15.1', 'signing scope survives the resource fairness integration bump');
for (const section of [digest.worker, digest.text.split('## Orchestrator Rules')[1].split('## Worker Rules')[0]]) {
  for (const text of ['identities.json', 'registry.json', 'DH59R4RNRY', '3JVMQQBHUR', 'read-only', 'BLOCKED']) assert.ok(section.includes(text));
}
assert.match(digest.text, /Signing allowlist \(2026-11-14\)/);
console.log('PASS signing allowlist: approved identity/device/profile scope, dated approval, owner-only registry, worker read-only, audit and combined integration version');
