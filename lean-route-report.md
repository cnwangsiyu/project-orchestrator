Implemented lean route output without changing the selector or routing decisions. Starting revision: `fba6bcbaf95a501cbcbe619c490a06b7c0204bda`; branch: `lean-route`. The digest remains `2026-11-16.1` and 60 physical lines (61 with the trailing split element, within the enforced budget).

The inventory below covers every note/why emission in the original CLI, presentation layer and plan view. Prior line numbers refer to the starting revision. Mixed notes are split into their fixed policy and concrete task data. All why explanations remain task-specific; default text shortens repeated ETA/lane framing, while JSON and verbose retain full diagnostics.

| Prior emission | Clause or data | Classification | Current source/delivery |
|---|---|---|---|
| `route.mjs:17` | Category-table impact and tuple guidance | FIXED | WORKER_NOTES.routeImpact / routeTuple |
| `presentation.mjs:25` | Dependency and toolchain installation | FIXED | global-rules.md:46 |
| `presentation.mjs:150` | Claude Chrome selection and task-created tabs | FIXED | WORKER_NOTES.claudeBrowser |
| `presentation.mjs:151` | Scope boundary and byte-for-byte restoration | FIXED | global-rules.md:44 |
| `presentation.mjs:153` | Versioned global worker digest, including signing, devices, credentials, queue/resource rules and no delegation | FIXED | global-rules.md:43; loadDigest |
| `presentation.mjs:154` | Credential prohibition, normal signed-in CLI use, ssh/git defaults, project service-key use, scoped test signing and private-query prohibition | FIXED | global-rules.md:47 / 48 |
| `presentation.mjs:157` | Destructive device backup and restoration | FIXED | WORKER_NOTES.backup; global-rules.md:44 |
| `presentation.mjs:158` | Lease/lock acquisition after first response and release before handoff | FIXED | WORKER_NOTES.lease |
| `presentation.mjs:162` | TTADK search proxy and private-query boundary | FIXED | WORKER_NOTES.search |
| `presentation.mjs:163` | Direct image reading without web search | FIXED | WORKER_NOTES.image |
| `presentation.mjs:164` | Scoped commits, no main/force push, no trailers | FIXED | WORKER_NOTES.commits |
| `presentation.mjs:165` | Reviewer-generated test files only; no source edits | FIXED | WORKER_NOTES.reviewTests |
| `presentation.mjs:168` | Blocked-finding rereviews and two-round cap | FIXED | WORKER_NOTES.rereview |
| `presentation.mjs:171` | Remote/CI builds must not hold local resource locks | FIXED | WORKER_NOTES.remoteBuild |
| `presentation.mjs:172` | Local build wrapper, paired acquisition, FIFO fairness, gates, lane 3, unknown/timeout and cleanup rules | FIXED | WORKER_NOTES.localBuild |
| `presentation.mjs:174` | Complete takeover/publish/build command checklist | FIXED | WORKER_NOTES.checklist |
| `presentation.mjs:175` | Test-environment procedural checklist and deploy/release health/rollback checklist | FIXED | WORKER_NOTES.testBuild / deployBuild |
| `presentation.mjs:176,205` | Registered-phone permissions, forbidden personal/unregistered devices, lease/backup rules (policy part of mixed notes) | FIXED | global-rules.md:49; WORKER_NOTES.deviceSafety |
| `presentation.mjs:177` | Chrome availability, named signed-in browser, no browser switching/login workaround | FIXED | WORKER_NOTES.browser |
| `presentation.mjs:178` | Named desktop apps, unlocked screen, missing tool/vision blocker | FIXED | WORKER_NOTES.desktop |
| `presentation.mjs:180` | Browser identities are local to each worker tool channel | FIXED | WORKER_NOTES.browserIdentity |
| `presentation.mjs:181` | Saved browser permission denial requires a fresh scoped thread | FIXED | WORKER_NOTES.browserDenial |
| `presentation.mjs:183` | Defensive finding format and no GPT policy-block retries | FIXED | WORKER_NOTES.security |
| `presentation.mjs:184` | Defensive-only brief, adversarial reroute on policy block and executable disagreement check | FIXED | WORKER_NOTES.defensive |
| `presentation.mjs:186` | TTADK infrastructure retry and account exclusion | FIXED | WORKER_NOTES.ttadk |
| `presentation.mjs:188` | TRAE hub queuing, confirmed cancellation, floor/owner/hop preservation | FIXED | WORKER_NOTES.trae |
| `presentation.mjs:191` | TRAE advisory origin restrictions, scoped actions and irreversible-action confirmation | FIXED | WORKER_NOTES.traeScope |
| `presentation.mjs:192` | TRAE extension access boundaries and exact-error blockers | FIXED | WORKER_NOTES.traeBrowser |
| `presentation.mjs:193` | TRAE public/local versus signed-in browser boundary | FIXED | WORKER_NOTES.traePublic |
| `presentation.mjs:201` | Hub probe, ownership and no-restart rule | FIXED | WORKER_NOTES.hub |
| `presentation.mjs:204` | Guarded device executor, continuous idle evidence and bounded lease | FIXED | WORKER_NOTES.device |
| `presentation.mjs:206` | Readable iOS backup, protected SplashBoard exclusion and preservation install | FIXED | WORKER_NOTES.iosBackup |
| `presentation.mjs:207` | Resource return, backup, credentials/purchases boundary and allowed-prompt handoff | FIXED | WORKER_NOTES.deviceSafety |
| `presentation.mjs:213` | Background work keeps quality/quota policy | FIXED | WORKER_NOTES.background |
| `presentation.mjs:215` | Independent reviewer names, outputs, artifacts and family-preserving replanning | FIXED | WORKER_NOTES.reviewers |
| `presentation.mjs:224` | Tracked background launch, no shell detaching, armed owner watch (fixed policy part) | FIXED | WORKER_NOTES.launch |
| `presentation.mjs:225` | Unsettled-decision ask/default, permitted notes and timeout reply | FIXED | WORKER_NOTES.talkback; global-rules.md:45 |
| `presentation.mjs:226` | Public talkback identity, denied-write relay and ask --await | FIXED | WORKER_NOTES.talkbackIdentity |
| `presentation.mjs:227` | Final-message output must be separate from requested deliverables | FIXED | WORKER_NOTES.output |
| `presentation.mjs:228` | Launch identity/audit and real scoped approval references | FIXED | WORKER_NOTES.audit |
| `plan.mjs:44` | Unsatisfied preaction/acceptance gate reason and phase | TASK-SPECIFIC | Retained in `notes` / `why`, approval/decision fields or exact launch arguments |
| `plan.mjs:48,49,50` | Selected tuple, completion estimate, uncertainty and queue patience | TASK-SPECIFIC | Retained in `notes` / `why`, approval/decision fields or exact launch arguments |
| `plan.mjs:51,52` | Deferred/blocked decision, trigger and owner | TASK-SPECIFIC | Retained in `notes` / `why`, approval/decision fields or exact launch arguments |
| `presentation.mjs:24,27` | Impact/review-class policy normalization and selected no-review profile | TASK-SPECIFIC | Retained in `notes` / `why`, approval/decision fields or exact launch arguments |
| `presentation.mjs:50` | Quota-expiry opportunity tied to account/bucket/reset | TASK-SPECIFIC | Retained in `notes` / `why`, approval/decision fields or exact launch arguments |
| `presentation.mjs:51,52,55` | Observed free TRAE load, unmeasured fallback, or reason to remain on TTADK | TASK-SPECIFIC | Retained in `notes` / `why`, approval/decision fields or exact launch arguments |
| `presentation.mjs:57,58` | Dry preview/cache age and authenticated fresh-status refresh | TASK-SPECIFIC | Retained in `notes` / `why`, approval/decision fields or exact launch arguments |
| `presentation.mjs:60,61,63` | Stale account identities, assumed retry floor and unknown prior actual account | TASK-SPECIFIC | Retained in `notes` / `why`, approval/decision fields or exact launch arguments |
| `presentation.mjs:64,66,67,68` | Warnings, scoped personal-quota/max-effort/capacity decisions and mismatch/approval messages | TASK-SPECIFIC | Retained in `notes` / `why`, approval/decision fields or exact launch arguments |
| `presentation.mjs:108` | Missing trusted project root; working/trusted directory choice | TASK-SPECIFIC | Retained in `notes` / `why`, approval/decision fields or exact launch arguments |
| `presentation.mjs:145,146` | Personal-device default lane and qualified selection/alternative ETA | TASK-SPECIFIC | Retained in `notes` / `why`, approval/decision fields or exact launch arguments |
| `presentation.mjs:147,148,149` | Chosen adversarial policy, selected low-priority lane and observed progress | TASK-SPECIFIC | Retained in `notes` / `why`, approval/decision fields or exact launch arguments |
| `presentation.mjs:152` | Project slow-test file, cost, touched-code triggers and skipped-test reporting | TASK-SPECIFIC | Retained in `notes` / `why`, approval/decision fields or exact launch arguments |
| `presentation.mjs:159,160,202` | DeepSeek capability/output limits relevant to this selected writes/finisher task | TASK-SPECIFIC | Retained in `notes` / `why`, approval/decision fields or exact launch arguments |
| `presentation.mjs:161` | Selected Gemini company-lane timing risk and reroute conditions | TASK-SPECIFIC | Retained in `notes` / `why`, approval/decision fields or exact launch arguments |
| `presentation.mjs:166,167` | Required review class/reason/scope/author/command or task-specific acceptance/outcome | TASK-SPECIFIC | Retained in `notes` / `why`, approval/decision fields or exact launch arguments |
| `presentation.mjs:171,172,175` | Selected local/remote execution and test/deploy environment/stakes (now separate from injected mechanics) | TASK-SPECIFIC | Retained in `notes` / `why`, approval/decision fields or exact launch arguments |
| `presentation.mjs:176,205` | Actual registered phone names (separate from fixed permission/device policy) | TASK-SPECIFIC | Retained in `notes` / `why`, approval/decision fields or exact launch arguments |
| `presentation.mjs:191` | Actual browser origins and task read/write scope (separate from advisory enforcement policy) | TASK-SPECIFIC | Retained in `notes` / `why`, approval/decision fields or exact launch arguments |
| `presentation.mjs:195,196,198,199,200` | Retry history, acceptance amendments, repeated-defect analysis and accepted-thread continuation conditions | TASK-SPECIFIC | Retained in `notes` / `why`, approval/decision fields or exact launch arguments |
| `presentation.mjs:201` | Unknown/unreachable account identities or missing executable lane prompting a hub check | TASK-SPECIFIC | Retained in `notes` / `why`, approval/decision fields or exact launch arguments |
| `presentation.mjs:211,212` | Selected bucket-free/background lane, ladder step and priority spend | TASK-SPECIFIC | Retained in `notes` / `why`, approval/decision fields or exact launch arguments |
| `presentation.mjs:216,217,218` | Missing background capacity, blocked reasons and fallback decision explanations | TASK-SPECIFIC | Retained in `notes` / `why`, approval/decision fields or exact launch arguments |
| `presentation.mjs:220,221` | Personal quota now versus wait; concrete reset time/company-progress alternative | TASK-SPECIFIC | Retained in `notes` / `why`, approval/decision fields or exact launch arguments |
| `presentation.mjs:224` | Concrete owner/watch identity (fixed tracking rule is injected) | TASK-SPECIFIC | Retained in `notes` / `why`, approval/decision fields or exact launch arguments |
| `presentation.mjs:229` | Selected project profile and present landing gate | TASK-SPECIFIC | Retained in `notes` / `why`, approval/decision fields or exact launch arguments |

Every fixed clause reaches both worker families through the same composed worker instructions. `scripts/lib/global-rules.mjs:18` combines the canonical digest worker section with `scripts/lib/fixed-worker-notes.mjs`'s condition-qualified constants; `workerInstructions` adds the version header at line 21. Dependency and credential text comes only from the digest; the compatibility dependency export reads that source. Fixed operational text has one definition in the constants module and is reused for diagnostics and injection.

Codex hub start injects the composed rules as developerInstructions at `scripts/codex-worker.mjs:1246`, the launch-time resume at line 1259 preserves them plus talkback, and subsequent turn/resume at line 1272 reloads them. Automatic rerouting uses the same launcher at `scripts/lib/worker-reroute.mjs:157` (and reviewer launcher at line 167). One-shot exec uses a single `-c` argument populated by `scripts/rules-worker-digest.mjs --config`; shell parsing tests verify the entire rule text reaches that argument.

Claude's SessionStart digest hook deliberately skips non-orchestrator workers. The printed Claude launch command at `scripts/lib/pipeline/presentation.mjs:111` therefore loads `rules-worker-digest.mjs` at execution time through `--append-system-prompt`. A stub Claude captures the actual argv for both claude-tools and browser routes; a fixture rule added after planning appears in that prompt, proving injection does not depend on the hook or on copied brief text.

Default text contains the decision, executable launch/second-reviewer commands, short reasons, task-specific notes and the required injection reminder. `--verbose` additionally shows fixedNotes and full diagnostic framing. `--json` exposes separate `notes` and `fixedNotes`, with `workerRulesVersion`, full `why`/ETA and short text variants. Nightly briefs copy only task notes; hub and Claude launches inject fixed rules. Documentation and safety assertions follow this split.

Byte measurements use `--dry` on the same captured public account/lane fixture. Acq's configured origins are explicitly marked accessible in the fixture so browser measures a launch, rather than a capability blocker. The original archived source is measured with its printed skill-root path normalized to this worktree, avoiding path-length bias. No status service, hub or real worker is contacted.

| Route | Before bytes | After bytes | Reduction |
|---|---:|---:|---:|
| `implement --project video-agent --writes --impact service` | 15,158 | 3,066 | 79.8% |
| `browser --project acq` | 13,367 | 2,483 | 81.4% |
| `claude-tools --project acq` | 17,537 | 1,385 | 92.1% |
| `analysis` | 11,976 | 1,879 | 84.3% |
| `build-run --review-class A --review-reason external release` | 15,737 | 2,957 | 81.2% |

All ten specifically required suites passed on the final scenario run: route, router-tail, live-routing, global-rules, rules-enforcement, signing-allowlist, worker-guards, trae-browser, reroute, monitor-tail. The full run executed all 38 scripts/test/*-scenarios.mjs suites: 34 passed and four remained non-green. Failed suites were retried once. The new lean-route capture suite also passed separately after the final JSON device-policy split.

Three failures reproduce on the unchanged starting revision with isolated state: balance-replay at line 61 expects TRAE but receives TTADK; eta at line 48 expects the old `company ETA:` wording; light-deploy at line 81 expects Sol for a depleted-bucket retry but receives Terra. Routing selection and these assertions were not changed to force a pass.

The resource suite exceeded its existing lane3.mjs ten-minute budget on the first attempt. On retry lane3 passed (253 assertions), and seven resource groups passed with 1,418 assertions total; build.mjs then exceeded its existing twenty-minute budget. No resource/controller/wrapper code or test deadlines were changed. These timeouts leave full resource-suite validation incomplete; they are distinct from the three reproduced baseline assertion failures.

Tests used isolated RULES_SHARED/ROUTE_LOG_FILE state, synthetic account observations, transport stubs and a stub Claude CLI. They contacted no real hubs and launched no real workers. Git diff checks passed; the digest version remains unchanged.


| Scenario suite | Result | Final attempt | Seconds |
|---|---|---:|---:|
| balance-replay-scenarios.mjs | FAIL | 2 | 0 |
| browser-preflight-scenarios.mjs | PASS | 1 | 2 |
| company-read-scenarios.mjs | PASS | 1 | 12 |
| company-telemetry-scenarios.mjs | PASS | 1 | 6 |
| eta-scenarios.mjs | FAIL | 2 | 0 |
| fix2-routing-scenarios.mjs | PASS | 1 | 5 |
| global-rules-scenarios.mjs | PASS | 1 | 13 |
| hub-launchd-scenarios.mjs | PASS | 1 | 7 |
| lean-route-scenarios.mjs | PASS | 1 | 3 |
| light-deploy-scenarios.mjs | FAIL | 2 | 1 |
| live-routing-scenarios.mjs | PASS | 1 | 16 |
| monitor-tail-scenarios.mjs | PASS | 1 | 1 |
| nightly-review-scenarios.mjs | PASS | 1 | 213 |
| orch-usage-scenarios.mjs | PASS | 1 | 75 |
| outcome-scenarios.mjs | PASS | 1 | 3 |
| policy-block-scenarios.mjs | PASS | 1 | 0 |
| quota-monitor-scenarios.mjs | PASS | 1 | 2 |
| reroute-scenarios.mjs | PASS | 1 | 25 |
| res-scenarios.mjs | FAIL | 2 | 3838 |
| resource-lock-scenarios.mjs | PASS | 1 | 1 |
| resource-nightly-scenarios.mjs | PASS | 1 | 2 |
| resource-scenarios.mjs | PASS | 1 | 0 |
| review-data-scenarios.mjs | PASS | 1 | 7 |
| review-policy-scenarios.mjs | PASS | 1 | 2 |
| route-scenarios.mjs | PASS | 1 | 128 |
| router-tail-scenarios.mjs | PASS | 1 | 13 |
| rules-enforcement-scenarios.mjs | PASS | 1 | 249 |
| shared-state-scenarios.mjs | PASS | 1 | 3 |
| signing-allowlist-scenarios.mjs | PASS | 1 | 0 |
| tier-routing-scenarios.mjs | PASS | 1 | 138 |
| trae-browser-scenarios.mjs | PASS | 1 | 2 |
| ttadk-quota-scenarios.mjs | PASS | 1 | 0 |
| utilisation-scenarios.mjs | PASS | 1 | 20 |
| worker-guards-scenarios.mjs | PASS | 1 | 12 |
| worker-inbox-fix-scenarios.mjs | PASS | 1 | 15 |
| worker-inbox-scenarios.mjs | PASS | 1 | 8 |
| worker-talkback-relay-scenarios.mjs | PASS | 1 | 6 |
| worker-talkback-scenarios.mjs | PASS | 1 | 14 |
