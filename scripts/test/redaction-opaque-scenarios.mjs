import assert from 'node:assert/strict';
import { maskLogText } from '../lib/nightly-audit.mjs';

// BC-109: reasoning ciphertext must survive rollout redaction byte-for-byte.
const secretish = 'storePassword "fakeValue123456"';
const row = { type: 'response_item', payload: { type: 'reasoning', encrypted_content: `gAAA${secretish}==`, summary: [{ type: 'summary_text', text: secretish }] } };
const line = JSON.stringify(row);
const { text, masked } = maskLogText(line + '\n', { jsonl: true });
const out = JSON.parse(text.trim());
assert.equal(out.payload.encrypted_content, row.payload.encrypted_content, 'encrypted_content untouched');
assert.ok(masked >= 1 && !out.payload.summary[0].text.includes('fakeValue123456'), 'normal text still masked');
console.log('all pass');
