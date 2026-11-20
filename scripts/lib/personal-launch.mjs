// Personal launch cost is measured in percentage points of the weekly quota.
// Current history has no attributable per-run weekly costs, so use the policy margin.
export const PERSONAL_LAUNCH_HEADROOM = 5;

// Input is already in deadline order and contains only usable accounts.
export function personalLaunchChoice(rows, headroom = PERSONAL_LAUNCH_HEADROOM) {
  const below = rows.filter(r => Number.isFinite(r.used) && 100 - r.used < headroom);
  const open = rows.filter(r => !below.includes(r));
  const hasHeadroom = open.length > 0;
  const eligible = hasHeadroom ? open : [...rows].sort((a, b) => (b.remaining ?? 100 - b.used) - (a.remaining ?? 100 - a.used));
  const pick = eligible[0] ?? null;
  const why = pick && below.length ? `${below.map(r => `${r.id} ${r.used}% used: below launch headroom ${headroom}%`).join('; ')}${hasHeadroom ? '' : '; no usable account has launch headroom, using most remaining'} -> ${pick.id}` : null;
  return { open: eligible, pick, below, hasHeadroom, why };
}
