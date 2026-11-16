// Pure aggregation shared by routing and reports. Manual fields override automatic records,
// regardless of timestamp; explicit corrections override both. Omitted fields inherit.
const bare = (project, name) => name.startsWith(`${project}-`) ? name.slice(project.length + 1) : name;
export const OUTCOME_OVERRIDES = ['result', 'rounds', 'cause', 'retries', 'scopeChanges', 'minutes', 'note', 'reviewed', 'actual', 'reviewResult', 'failureKind'];
const merge = (records) => records.reduce((p, o) => {
  if (!p) return { ...o, completedAt: o.completedAt ?? o.t };
  const rounds = [p.rounds, o.rounds].filter(x => x != null);
  return { ...p, ...o, completedAt: o.completedAt ?? (o.result ? o.t : p.completedAt),
    ...(records.some(r => Object.hasOwn(r, 'rounds')) ? { rounds: rounds.length ? Math.max(...rounds) : null } : {}),
    ...(records.some(r => Object.hasOwn(r, 'minutes')) ? { minutes: o.minutes ?? p.minutes } : {}),
    ...(records.some(r => Object.hasOwn(r, 'first')) ? { first: p.first ?? o.first } : {}),
    ...(records.some(r => Object.hasOwn(r, 'category')) ? { category: p.category ?? o.category } : {}),
    ...(records.some(r => Object.hasOwn(r, 'impact')) ? { impact: p.impact ?? o.impact } : {}),
    ...(records.some(r => Object.hasOwn(r, 'reviewed')) ? { reviewed: !!(p.reviewed || o.reviewed) } : {}) };
}, null);
export const dedupeOutcomes = (records) => {
  const groups = new Map();
  for (const o of [...records].sort((a, b) => a.t - b.t)) {
    const key = `${o.project}\u0000${o.project && o.name ? bare(o.project, o.name) : o.name}`;
    const group = groups.get(key) ?? { auto: [], manual: [], corrections: [] };
    group[o.correction ? 'corrections' : o.auto === true ? 'auto' : 'manual'].push(o);
    groups.set(key, group);
  }
  const outcomes = [];
  for (const { auto, manual, corrections } of groups.values()) {
    if (!auto.length && !manual.length) continue;
    const a = merge(auto), m = merge(manual);
    const o = { ...a, ...m, auto: !manual.length, dupes: auto.length + manual.length,
      autoRecords: auto.length, manualRecords: manual.length + corrections.length };
    // Metadata-only manual records do not change the task's acceptance time.
    if (a && m && !manual.some(r => r.result)) o.completedAt = a.completedAt;
    if (corrections.length) {
      o.correctionFrom = Object.fromEntries(OUTCOME_OVERRIDES.filter(f => Object.hasOwn(o, f)).map(f => [f, o[f]]));
      for (const c of corrections) for (const f of OUTCOME_OVERRIDES) if (Object.hasOwn(c, f)) o[f] = c[f];
      o.auto = false; o.corrected = true; o.correctedAt = corrections.at(-1).t; o.corrections = corrections.length;
    }
    outcomes.push(o);
  }
  return outcomes;
};
