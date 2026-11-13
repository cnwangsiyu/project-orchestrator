# Review rubric (for the reviewer's brief)

Use this rubric for every independent review `route.mjs` asks for. A review is required for:

- `--impact release`: a mistake that can't be undone within hours, such as app or SDK code that ships in a release, a
  published library, a data migration or bulk data change, a contract that released clients depend on, or
  auth/privacy/billing.
- `--impact service --stakes high`.

Demos, prototypes, experiments and test scripts (`throwaway`) don't get a review (user, 2026-11-04).
Ordinary service changes (`service`) get one only when fallback-authored (model-routing.md, "Quality guard").

Paste the next section into the reviewer's brief, or point the reviewer at this file and tell it to follow it.

## Instructions for the reviewer

You are the gate before code that is costly to undo goes out. Find what would really hurt, not everything that could be
nicer.

- **Frozen, diff-scoped review.** The brief pins the checkout's commit hash and diff base/hash. Review that diff on a
  frozen checkout with no concurrent writer; read surrounding code only to establish a concrete failure path from the
  change. If the checkout moves, stop and have the orchestrator pin the new revision before continuing.
- **Blocking findings (P0/P1).** Only these block a merge:
  - wrong behaviour on a realistic path;
  - a crash, hang or leak;
  - data loss or corruption;
  - a security or privacy problem;
  - a performance regression users would notice;
  - a broken build, release, ABI or backward compatibility (old clients, persisted data, public API).

  For each one give the file:line, the concrete failure (which input or state leads to which bad outcome), and the
  smallest fix.
- **Notes (P2).** At most 3. These are real but non-blocking: something to fix soon, not before merging. Leave out
  anything weaker.
- **Don't report:**
  - style, naming or formatting;
  - "consider" or "could be cleaner" refactors;
  - speculative issues with no concrete failure path;
  - missing tests, unless a missing test hides a P0/P1 you can name;
  - the author's approach where it works.
- **Verify before claiming.** Read the code you cite. Run the build or tests when you can. Don't report anything you
  couldn't tie to a real path.
- **Failure probes** (user-approved 2026-11-11 retro; W291-R0 got Gemini LAND before GPT reproduced three P1s):
  for startup changes, probe the packaged entry with hanging init plus hanging/throwing/late cleanup; for storage changes,
  kill after remote-durable writes but before local apply, then restart normally and verify revoked data stays inaccessible.
  Report exact commands, exit/listener/read results and anything untested; existing green suites alone don't prove these.
- **Verdict.** Give exactly one, on the first line:
  - `MERGE` when there are no findings;
  - `MERGE-WITH-NOTES` when there are P2 notes only;
  - `BLOCK` when there is at least one P0/P1.

## Rounds (for the orchestrator)

- After a `BLOCK`, the fix round addresses only the blocking findings.
- The re-review checks those findings, their fixes, and the neighbouring paths the fixes touched (a fix that brings a
  new same-kind defect is a P1 there; rework retro 2026-11-10). It is not a new full review and must not raise new P2
  notes elsewhere.
- The review brief states what the reviewer judges against: the threat model, the production path (what ships and how
  it loads), which code is inert or default-off and which is live, and the P0/P1 bar for this change.
- **Fallback reviewer gate** (user-approved 2026-11-11 retro; W291-R0's Gemini LAND missed storage/startup P1s): release
  or high-stakes work reviewed by a fallback model also needs an independent reviewer of another family, with at least
  one GPT/Claude review. Reconcile both reports and failure probes before acceptance; if unavailable, report BLOCKED.
- **Default-off / flag-guarded code gets at most 2 review rounds.** Then the orchestrator decides: merge with notes if
  no P0/P1 remains, or re-scope. A flag does not waive a concrete P0/P1 or the required ON/OFF acceptance proof; P2 alone
  never blocks or earns another round.
- For other code, after 2 review rounds, stop. You decide whether one more fix is clearly worth it, or take it to the
  user. Never loop.
  If round 2 still finds the same kind of defect, re-scope the work (SKILL.md, "Fix rounds") before another fix.
- `MERGE` and `MERGE-WITH-NOTES` count as a `pass` in `outcome.mjs`. Only a `BLOCK` that led to a fix round counts
  as `rework`.
