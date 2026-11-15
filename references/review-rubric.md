# Review rubric (for the reviewer's brief)

Use this rubric for every independent review the router requests. Mandatory review is ONLY explicit --review-class A|B|C|D plus --review-reason: A a version that reaches external users and cannot be rolled back within hours; B login/auth/permission/signing logic; C irreversible data operations or billing/quota accounting; D a named adversarial review. High stakes, installation and fallback authorship alone do not qualify.

Pass `--review-class` and `--review-reason`; an explicit class works on internal-demo without profile-override. Release means class A external irreversible release, not PPE/test/internal-demo/trace packages. Ordinary service, installed-tool and fallback-written changes use executable tests, or one optional ordinary review when tests cannot cover the behavior. Fallback reviews exclude the author family when applicable; capability/acceptance limits remain.

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
- **Independent reviewers:** only classified adversarial/review-high/release reviews require a second independent family. Adversarial uses two non-GPT families; do not add a contradictory GPT requirement. Pin the artifact and reconcile blocking findings before acceptance.
- **Default-off / flag-guarded code gets at most 2 review rounds.** Then the orchestrator decides: merge with notes if
  no P0/P1 remains, or re-scope. A flag does not waive a concrete P0/P1 or the required ON/OFF acceptance proof; P2 alone
  never blocks or earns another round.
- Two review rounds is a hard task/branch scope cap. `--review-scope` pins the identity; another reason or renamed review must not bypass it. After round two, report remaining findings and re-scope genuinely new work.
- Optional share targets are video-agent 10%, vesdk-mainline/webview 20%; overall share is observational. Excess warns, never suppresses mandatory reviews. Batch related small changes; docs/rule-text-only fixes use owner diff verification. Installation, high effort, fallback authorship and budget spending cannot create a mandatory review.
- Record `--review-result blocking|none` in outcome.mjs; interim notes `review: blocking found` / `review: none` work. Unknown yield stays UNKNOWN.
- `MERGE` and `MERGE-WITH-NOTES` count as a `pass` in `outcome.mjs`. Only a `BLOCK` that led to a fix round counts
  as `rework`.

Release impact means class A only: a version reaches external users and cannot be rolled back within hours. Reading/writing local or user data is not release; real irreversible data operations are class C. Personal/family apps, internal demos and PPE/test packages, or features that only read existing data are not release.
