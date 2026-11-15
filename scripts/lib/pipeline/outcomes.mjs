// Pure outcome aggregation for the routing snapshot. Mirrors the existing ledger contract.
const bare = (project,name) => name.startsWith(`${project}-`) ? name.slice(project.length+1) : name;
export const OUTCOME_OVERRIDES = ['result', 'rounds', 'cause', 'retries', 'scopeChanges', 'minutes', 'note', 'reviewed', 'actual', 'reviewResult'];
export const dedupeOutcomes = (records) => {
  const by = new Map(), corrections = new Map();
  for (const o of [...records].sort((a, b) => a.t - b.t)) {
    const k = `${o.project}\u0000${o.project && o.name ? bare(o.project, o.name) : o.name}`;
    if (o.correction) {
      if (!corrections.has(k)) corrections.set(k, []);
      corrections.get(k).push(o);
      continue;
    }
    const p = by.get(k);
    if (!p) { by.set(k, { ...o, dupes: 1 }); continue; }
    const rounds = [p.rounds, o.rounds].filter((x) => x != null);
    by.set(k, { ...p, ...o, rounds: rounds.length ? Math.max(...rounds) : null, minutes: o.minutes ?? p.minutes,
      first: p.first ?? o.first, category: p.category ?? o.category, impact: p.impact ?? o.impact, reviewed: !!(p.reviewed || o.reviewed), dupes: p.dupes + 1 });
  }
  for (const [k, cs] of corrections) {
    const o = by.get(k);
    if (!o) continue; // A correction cannot create a task; the CLI rejects these too.
    o.correctionFrom = Object.fromEntries(OUTCOME_OVERRIDES.filter((f) => Object.hasOwn(o, f)).map((f) => [f, o[f]]));
    for (const c of cs) for (const f of OUTCOME_OVERRIDES) if (Object.hasOwn(c, f)) o[f] = c[f];
    o.corrected = true; o.correctedAt = cs.at(-1).t; o.corrections = cs.length;
    o.t = Math.max(o.t, o.correctedAt);
  }
  return [...by.values()];
};
