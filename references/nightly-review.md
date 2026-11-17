# Nightly routing review

The existing 03:07 local schedule runs `scripts/nightly-review.sh`. The launcher computes the daily numbers in
code, compares them with explicit thresholds, and publishes the report before requesting model analysis.
A model runs only for model-requiring findings or the Monday weekly review (user approved 2026-11-16). The lane/devbox imbalance check and its inbox advice are script-only. A quiet night
ends with the script table and no messages. No scheduler, launchd or settings change is part of this workflow.

## Stages and ownership

1. **Collect:** gather `review-data.mjs --hours 24 --json --cached`, its 168-hour counterpart,
   `orch-usage.mjs --hours 24 --json`, the 24/96-hour resource reviews and the read-only resource snapshot.
   Freeze the full resource `log.tsv` and `resources.tsv` read-only, including history before the 24h window so crossing holds/waits can be paired. Save local `claude agents --json` and the roster for recipient resolution. Every collector output/error is
   attempt-local. `--cached` consumes the public quota cache and never refreshes authentication or quota.
   Failed collectors and missing coverage remain UNKNOWN. Do not contact hubs to manufacture health evidence.
2. **Compute:** `scripts/lib/nightly-metrics.mjs` consumes the frozen JSON and resource TSVs, writes `metrics.json` and a compact
   table of at most 40 lines, then writes `<date>.md` immediately. The full metric rows and evidence pointers
   remain in `<date>.metrics.json`, including rows omitted from the compact display.
3. **Analyze when needed:** route `analysis --stakes high` through the ordinary router and its existing hub.
   The brief contains only triggered finding objects and their evidence paths, with instructions to explain
   causes and propose concrete actions. Monday adds a `weekly-full-review` finding with the weekly evidence
   paths. The model writes `report.md` and `notify.json` inside its attempt. It proposes changes; it does not
   edit policy/source, commit, push, clean up, sign packages, message sessions, or ask user cards.
4. **Publish and deliver:** the launcher combines the script table/findings with the model analysis in
   `routing-review/<date>.md`. It queues each orchestrator's own items in the worker-event inbox. All user
   decisions are one nightly message to the mini secretary, who raises the cards. No ordinary Claude finisher
   runs. Only when the secretary's exact name is known but its session ID is unavailable, a minimal routed
   `claude-tools` relay sends that one decision message to the secretary and records a receipt.

`NIGHTLY_MODE=auto` follows these stages. `dry` uses a read-only worker only if findings/Monday require it,
then publishes its final text without delivery. `plan` prints a dry route and the conditional workflow without
collecting data or launching a model. `claude` requests a routed Claude analysis after the same threshold gate;
its personal-quota approval still comes from the router. `NIGHTLY_USER_OK` is a real scoped approval reference,
never a boolean override of a blocked route. The launcher never opens automatic quota-approval sessions.

## Thresholds and metric definitions

All nightly comparison thresholds live in [nightly-thresholds.json](../scripts/lib/nightly-thresholds.json).
JSON has no comments; the following table documents each key. These thresholds trigger analysis/proposals,
not automatic enforcement or permission to change another owner's work.

| Metric/config key | Trigger | Basis and limits |
|---|---|---|
| `reviewTargetPct` | Share above project target | Default/video-agent 10%, vesdk-mainline 20%; explicit collector profile target takes precedence. No-review projects are excluded. Exact reviews/dispatches ratio; primary, second and re-review seats count as planned dispatches. |
| `unroutedMax` | More than 3 in 24h | Uses attributed audit rows; attribution identifies the recipient and does not retroactively create a route. Unknown owners go to the routing owner. |
| `mismatchesMax` | More than 5 in 24h | Actual launch versus routed tuple; retain historical evidence. |
| `missingPersonalApprovalMax` | Any missing approval reference | A metadata finding, never proof that approval was absent outside the collected records. |
| `inboxP90MinutesMax` | p90 above 30 minutes | Per-session delivery acknowledgement, not task acceptance. An empty known inbox has zero delay; missing latency/identity is UNKNOWN. |
| `laneWaitP90MinutesMax`, `devboxIdlePctMin` | Mini lane p90 >15 min AND devbox heavy-pool occupancy <50% | Script-only `lane-devbox-imbalance` finding, delivered to the top five projects by mini lane-minutes. Suggest moving only portable (non-macOS) steps to `res wait-pool devbox-cn`; never move macOS-only work or reclaim holds. Despite its historical name, `devboxIdlePctMin` is the maximum occupied percentage for this check. |
| `staleRulesHoursMax` | Current digest unacknowledged for more than 24h | Age starts at the later of the digest's source timestamp and the old acknowledgement; missing timestamp is UNKNOWN. |
| `overGateHoursMax` | More than 0 hours | Sampled intervals with authoritative combined load/memory admission verdicts. No interpolation across gaps. |
| `expiryWarningHours` | SSO or quota entitlement expiry within 72h | TTADK/TRAE public cached expiry metadata only, including already-expired access. Routine daily reset is replenishment and is reported separately. Missing expiry stays UNKNOWN. |
| `autoOutcomeCoveragePctMin` | Below 80% | Named finished/failed task families in worker-event evidence form the denominator; matched deduplicated automatic outcomes form the numerator. Missing outcomes remain in the denominator. Reviews and may-still-run failures are excluded; missing terminal identity/source remains UNKNOWN. |
| `resourceCoveragePctMin` | Below 80% | Coverage of sampled intervals; metric-specific coverage, CPU idle/readiness, memory/pressure, queue, lane occupancy and quota-at-reset estimates are also recorded. |
| `overdueQuestionsMax` | Any expired unanswered question | Existing question and answer identities, with recorded timeout/default. |
| `catalogChangesMax` | Any added/removed catalog model | Collected catalog delta; a change prompts assessment and never authorizes adoption. |
| `orchestratorUsage` | Above the configured field limit | Own output 500KB, browser 20, screenshots 10, sleep polls 10, edits 5, tests/builds 3, tools 500, foreground blocked union 30min. Compactions trigger at 2 (maximum nontriggering value 1). These mirror the collector's daily limits; `blockedCallMinutes` is not elapsed blocked time. |
| `newUnknownClassesMax` | Any newly missing evidence class | Compare stable class names with the previous day's metrics. First run establishes the baseline and flags missing classes; recurring unchanged gaps do not start another daily worker. Every Monday still reviews the full evidence. |
| `weeklyDay` | Monday (`1`, local calendar) | Full review even if all daily thresholds are clear. |

Review yield, mandatory/second/re-review counts, outcome first-pass/code rework/non-code rework/failure counts,
resource coverage/idle/queue/memory, TTADK unused reset tokens, TRAE unused model units and rules/inbox coverage
are computed or summarized from collector aggregates. UNKNOWN is never converted to a clean result or zero waste.
Quota reset estimates require near-reset observations; units, tokens, personal weekly percentages and dollars stay
separate. Review budget findings never authorize removing explicitly justified A–D protection. Review round caps,
model/account eligibility, signing requirements and all other policy constraints remain in the current
[global rules](global-rules.md), [model routing](model-routing.md) and [review rubric](review-rubric.md).

Resource log metrics replay take/return pairs, reclaim/rollback ends and open holds to collection time,
clipping occupancy to the last 24h. Occupancy is held time / 24h per resource; devbox pool occupancy is
the capacity-weighted mean over registered `remote` `devbox-cn-<number>` rows, excluding light.
Completed `waiter-start`/`waiter-acquire` waits ending in the window use their full duration and nearest-rank
p90 for `heavy-lane-any` and `devbox-cn-any`; rejoin does not restart a wait and timeouts do not enter p90.
Full computed history is in `metrics.json.resourceHistory`, with evidence pointers to the frozen TSVs.
Missing/malformed history or no heavy pool remains UNKNOWN, not idle capacity. No model computes this
check; an imbalance alone skips routing and still uses the ordinary owned inbox delivery path.
If its recipient is unavailable, retain BLOCKED delivery evidence without a fallback model relay.

## Existing signing scope

The user's 2026-11-13 authorization permits signing only OUR OWN TEST packages registered by manifest and hash
in `~/.claude/orchestrator/_shared/user-signing/registry.json`, using identities on the dated user-approved
allowlist `identities.json`. Existing identities are H6 for iPhone 8; the iOS cosign team `DH59R4RNRY` development
certificate and provisioning profile `3JVMQQBHUR` for iPhone 11, valid to `2027-09`; and the repo's Android debug
keystore. Only orchestrators write registry entries. Signing workers treat `registry.json` and `identities.json`
as read-only. Workers needing new entries or an unlisted identity report BLOCKED.
New identities require a new user approval card and an allowlist entry. Never sign production/release packages or touch other keychains.
Designated passwords use stdin/file descriptors, never argv, environment or logs; never export/copy/print keys.
Record PASS/FAIL, fingerprints, hashes and a receipt, and re-lock the designated keychain unless another registered
signing run is active. The resident signing worker remains retired. A nightly review uses only public manifest,
allowlist and receipt metadata and reports missing provenance; it never opens signing inputs or changes the registry.

## Model artifacts

The brief requests a concise causal analysis and this `notify.json` shape:

```json
{
  "actions": [
    {"orchestrator": "Exact 主对话 name", "findingIds": ["review-share/video-agent"], "text": "Concrete action for this owner"}
  ],
  "decisions": [
    {
      "id": "2026-11-16-1",
      "question": "中文、自包含的问题？",
      "options": [
        {"label": "保持现状", "description": "继续当前策略"},
        {"label": "调整", "description": "按建议另行实施"}
      ],
      "recommended": 0,
      "default": "不回答则保持现状"
    }
  ]
}
```

Actions must reference findings owned by the named recipient. The launcher rejects unrelated IDs.
For a Monday `weekly-full-review` action, supply `project` matching the recipient and `evidence` containing a
weekly evidence path (optionally followed by `#field`).
Decisions have 2–4 options, a valid recommendation index and one explicit default: `不回答则保持现状`, or
`不回答则 <明确日期时间和时区> 起按推荐项执行`. A deadline does not authorize actions requiring a separate explicit
approval. The secretary handles cards, responses and later follow-up; the nightly launcher never waits for answers.

## Delivery and identity

`scripts/lib/nightly-delivery.mjs` uses the **unmodified existing API** from `scripts/lib/worker-events.mjs`:
`appendEvent`, `readEvents` and valid owner checks. It does not modify inbox code or hooks. Each record is a
`message`, `kind=info`, `wake=false`, addressed to the recipient's actual session ID. Existing Stop/SessionStart
hooks deliver on the recipient's next natural turn. The record contains a report/outbox pointer. For a message
longer than the hook's 2000-character rendering cap, the complete recipient-only bundle remains in a separate outbox text file, and the hook
message explicitly instructs the recipient to read it, including every option/default.

Recipients use the existing union of ledger/rules acknowledgement names, local named sessions and
`_shared/orchestrators.txt` (one exact name per line, `#` comments). Session IDs come from hook acknowledgements or
local public session metadata; a job ID or a name is not substituted for a session ID. Resolve the mini secretary
by its exact roster/session name (prefer the unique mini entry); ambiguous/missing identity is BLOCKED. Offline or
remote orchestrators without a usable inbox identity are recorded unresolved for the owner; never guess a target.

There is one compact findings message per affected orchestrator, containing only its items. Unattributed/global
items go to the routing/global-rules owner. There is one decision bundle per night to the secretary. Retained event
run IDs deduplicate replays after a receipt-write interruption. A receipt records **queued in inbox, recipient
confirmation unknown**. It does not acknowledge the recipient's event or claim acceptance. A delivery-only retry
reuses the analysis and event IDs, and does not start another review worker.

## Reports, recovery and deadline

`<date>.run/attempt-N/` retains collector files/errors, `metrics.json`, `script-report.md`, `route.json`, worker
identity/log/final result, model `report.md`/`notify.json`, `published-report.md`, `outbox.json`, status history and
`delivery.json`. Day-level `<date>.md`, `<date>.metrics.json` and `<date>.notify.json` are compatibility artifacts.
Failures preserve the script report. Prior attempts and pre-migration evidence are archived, never overwritten.
`report-summary.mjs` reads the short Summary section without loading analysis into the orchestrator's context.

Atomic status records the stage, state, attempt, thread/turn/account/model/effort and last completed step. Accepted
hub turns are reattached; an unknown turn is BLOCKED rather than duplicated. There is no worker wall-clock limit.
Only owned observer/follower clients can be closed on failed probes. Completed-result retrieval gets three bounded
recovery attempts (`NIGHTLY_RESULT_RETRIES`), then report/failed with worker/done. RPC and liveness limits use
`NIGHTLY_PROBE_MS` and `NIGHTLY_LIVENESS_RETRIES`; they never kill a working turn or real Claude session.
Infrastructure retries retain the normal three-attempt ceiling and account/model exclusions. Policy blocks stop
without a GPT retry. Successful same-day runs are idempotent; `NIGHTLY_RERUN=1` requests a fresh archived attempt
and does not authorize personal quota or duplicate a running/unknown worker.

The existing 05:00 checker (`--deadline-check`, override `NIGHTLY_DEADLINE=HH:MM`) records an unfinished run's state
and queues it to the routing owner's inbox. It never terminates a worker, starts a notification finisher or raises
cards. Completed/script-only/dry runs send no deadline message. Failure status also uses that inbox. Missing
recipient identity leaves a durable blocked receipt. No launchd installation/change is performed by this work.

## Verification

`node scripts/nightly-review.mjs scan-log --file /absolute/worker.log` reports secret-like field locations only; `.log`, `.out`, `.txt` and `.jsonl` are supported.
Run `node scripts/nightly-review.mjs redact-log --file /absolute/worker.jsonl` after the worker's turn ended when a risk note says secrets were printed; it atomically masks values and prints counts only, refusing logs modified in the last 120 s unless `--force`.

All validation uses isolated fixture HOME/shared directories, mocked CLIs and public test metadata. Never write
the real shared directory or contact real hubs while developing this stage. Focused suites are
`nightly-metrics-scenarios.mjs`, `nightly-review-scenarios.mjs` and `review-data-scenarios.mjs`; then run every
`scripts/test/*-scenarios.mjs` once. The resource suites can time out under machine load; the reroute suite permits
one load-related rerun. No local heavy-build lock belongs on remote/CI entry scripts.
