// OpenAI's cyberPolicy can fail a GPT turn on attack-style material ("flagged for possible cybersecurity risk …
// apply for Daybreak access"; TTADK gpt-6.1-sol review-high --security, 2026-11-13). A retry of the same thread or a
// resend of the content to another GPT account can escalate to an account restriction, so the worker classifies it
// and records a kind:'policy-block' row for the nightly review on both accounts. TTADK has telemetry only (no pause);
// TRAE additionally records the block like its 983 vendor restriction (the gpt family out until the next 00:00 UTC).
import fs from 'node:fs';
import path from 'node:path';

export const POLICY_BLOCK_RE = /cyberPolicy|flagged for possible cybersecurity risk/i;

export const isPolicyBlock = (turn) => turn?.status === 'failed'
  && POLICY_BLOCK_RE.test(JSON.stringify(turn.error ?? ''));

// The provider split the worker applies after logging the row: TRAE's health record mirrors the 983 restriction,
// TTADK (and anything else) keeps the telemetry without pausing a model or account.
export const policyBlockAction = (profileKind) => ({ restrictFamily: profileKind === 'trae' });

// The route-log shape review-data.mjs counts per account/model. `why` is the error text, capped for the log.
export const policyBlockRecord = ({ account = null, vendor = 'codex', model = null, error = null, t = Date.now() }) => ({
  kind: 'policy-block', t, account, vendor, model, why: String(JSON.stringify(error ?? '')).slice(0, 500),
});

export const appendPolicyBlock = (log, rec) => {
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.appendFileSync(log, JSON.stringify(rec) + '\n');
};
