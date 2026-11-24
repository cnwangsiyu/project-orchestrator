// Personal launch cost is measured in percentage points of the weekly quota.
// Current history has no attributable per-run weekly costs, so use the policy margin.
export const PERSONAL_LAUNCH_HEADROOM = 5;
export const PERSONAL_DEADLINE_TIE_H = 6;

const byName = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const deadline = r => Number.isFinite(r.deadline) ? r.deadline : Infinity;
const used = r => Number.isFinite(r.used) ? r.used : Infinity;
// Anchor each tie group at its earliest deadline. A pairwise tolerance in a
// comparator would be non-transitive for deadlines at 0h, 5h and 10h.
function deadlineOrder(rows, tieHours) {
  const pending = [...rows].sort((a, b) => deadline(a) - deadline(b) || byName(a, b)), ordered = [], groups = [];
  while (pending.length) {
    const end = deadline(pending[0]) + tieHours;
    const group = [];
    while (pending.length && deadline(pending[0]) <= end) group.push(pending.shift());
    group.sort((a, b) => used(a) - used(b) || Number(!!b.live) - Number(!!a.live) || byName(a, b));
    ordered.push(...group); groups.push(group);
  }
  return { ordered, groups };
}

// Input contains only usable accounts. Headroom precedes deadline tie ordering.
export function personalLaunchChoice(rows, headroom = PERSONAL_LAUNCH_HEADROOM, tieHours = PERSONAL_DEADLINE_TIE_H) {
  const below = rows.filter(r => r.id !== 'main' && Number.isFinite(r.used) && 100 - r.used < headroom);
  const open = rows.filter(r => !below.includes(r));
  const hasHeadroom = open.length > 0;
  const { ordered, groups } = deadlineOrder(hasHeadroom ? open : rows, tieHours);
  const eligible = hasHeadroom ? ordered : ordered.sort((a, b) => (b.remaining ?? 100 - b.used) - (a.remaining ?? 100 - a.used));
  const pick = eligible[0] ?? null;
  const choice = { open: eligible, pick, below, hasHeadroom, groups, headroom, tieHours };
  return { ...choice, why: personalLaunchExplanation(choice) };
}

export function personalLaunchExplanation(choice, pick = choice.pick) {
  const { below, hasHeadroom, groups, headroom, tieHours } = choice, messages = [];
  if (pick && below.length) messages.push(`${below.map(r => `${r.id} ${r.used}% used: below launch headroom ${headroom}%`).join('; ')}${hasHeadroom ? '' : '; no usable account has launch headroom, using most remaining'} -> ${pick.id}`);
  const tied = groups.find(group => group.some(r => r.id === pick?.id));
  if (pick && hasHeadroom && tied?.length > 1 && Number.isFinite(tied[0].deadline))
    messages.push(`deadlines within ${tieHours}h: ${tied.map(r => `${r.id} ${r.used ?? '?'}% used`).join(', ')} -> ${pick.id} (lower usage, then live hub, then name)`);
  return messages.join('; ') || null;
}
