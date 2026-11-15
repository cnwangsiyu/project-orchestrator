// Shared pure value utilities. Fingerprints identify sanitized plans, not credentials
// or cryptographic authorization; the guarded launcher owns durable attestation.
export const VERSION = 'pipeline-v1';
export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
export const array = (x) => Array.isArray(x) ? x : [];
export const finite = (x) => typeof x === 'number' && Number.isFinite(x);
export const nonnegative = (x) => finite(x) && x >= 0;
export const idOK = (x) => typeof x === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]*$/.test(x) && !x.includes('..');
export const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export const unique = (xs) => [...new Set(xs)].sort(compare);
export const modelId = (id) => {
  const s = typeof id === 'string' ? id.toLowerCase() : '';
  return ({ sol: 'gpt-6.1-sol', astra: 'gpt-6-astra', '6.1-sol': 'gpt-6.1-sol', '6-astra': 'gpt-6-astra',
    'claude-opus': 'opus', 'claude-sonnet': 'sonnet', 'claude-haiku': 'haiku', 'claude-fable': 'fable' })[s] ?? s;
};
export const familyOf = (id) => /^(opus|sonnet|haiku|fable)$/.test(modelId(id)) ? 'claude' : modelId(id).split('-')[0];
export const company = (a) => ['ttadk', 'trae'].includes(a?.kind);
export const known = (o) => o?.status === 'KNOWN' ? o.value : null;
export function clone(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return finite(value) ? value : null;
  if (typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  const out = Array.isArray(value) ? value.map((x) => clone(x, seen))
    : Object.fromEntries(Object.keys(value).sort(compare).map((k) => [k, clone(value[k], seen)]));
  seen.delete(value);
  return out;
}
export function freeze(x) {
  if (x && typeof x === 'object' && !Object.isFrozen(x)) { Object.values(x).forEach(freeze); Object.freeze(x); }
  return x;
}
export const stable = (x) => JSON.stringify(clone(x));
export const fingerprint = (x) => {
  const s = stable(x); let a = 2166136261, b = 3339675911;
  for (let i = 0; i < s.length; i++) { a = Math.imul(a ^ s.charCodeAt(i), 16777619); b = Math.imul(b ^ s.charCodeAt(i), 2246822519); }
  return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
};
export const reason = (ruleId, code, text, subjects = []) => ({ ruleId, code, text, subjects });
export const result = (ruleId, code = null, text = '', subjects = [], extra = {}) => ({
  ruleId, ok: code === null, pass: code === null, reason: code === null ? null : reason(ruleId, code, text, subjects),
  gate: null, reconsiderAt: null, ...extra,
});
export const tupleKey = (c) => [c.accountId, c.modelId, c.laneId, c.harness, c.effort].map(encodeURIComponent).join('|');
export const isReview = (t) => ['review', 'review-high', 'second-opinion'].includes(t.category);
export const adversarial = (t) => t.contentLabels.some((x) => ['adversarial', 'attack-material', 'policy-blocked'].includes(x));
