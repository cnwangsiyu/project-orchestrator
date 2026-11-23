// Provider quota names can arrive before modelQuotas includes their catalog ID.
const aliases = { gpt_6_2: 'gpt-6.2-sol' };

export function normalizeTraeDaily(daily) {
  if (!daily || typeof daily !== 'object' || Array.isArray(daily)) return {};
  const normalized = {};
  for (const [id, bucket] of Object.entries(daily)) {
    const model = aliases[id] ?? id;
    // Explicit catalog mappings take precedence over a fallback alias.
    if (model === id || !Object.hasOwn(daily, model)) normalized[model] = bucket;
  }
  return normalized;
}
