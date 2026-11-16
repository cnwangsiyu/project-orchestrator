# Skill checkout updates at SessionStart

`rules-digest-hook.mjs` calls `skill-autoupdate.mjs` before reading the rules
digest, for every valid SessionStart (including sessions outside the orchestrator).
Existing hook settings suffice. The hook launches a detached local coordinator
and waits at most 180 ms before reading the digest. The digest hook retains its
700 ms fail-open deadline and 2 s settings timeout. No Git or network operation
runs in the hook process. If local checks take longer, that session can read the
previous digest; the coordinator completes the fast-forward for later reads.
Its read-only checks share a 30 s budget (standalone CLI/status: 5 s). A fast-forward already started is allowed
to complete, never killed by a hook timeout with its worktree partly updated.

The first start launches a detached fetch, with its output in
`<shared>/autoupdate/<checkout-id>.fetch.log`. The next start can apply that
successful fetch, even within the ten-minute fetch throttle. Fetch failures
require another successful fetch before any update. Git uses its normal remote
and authentication configuration, with interactive credential prompts disabled.

Discovery starts at this script's checkout, uses Git to identify its submodule
parent, and derives a paired `.agents/skills/<skill>` or `.claude/skills/<skill>`
install from the script's ancestry. It does not search the home directory or
discover sibling installs when running in an unrelated feature worktree.
Additional checkouts can be listed in optional `<shared>/autoupdate.json`:

```json
{"checkouts": ["/path/to/another/skills", "../another-skill-checkout"]}
```

Paths may be absolute or relative to the shared directory; a plain JSON list is
also accepted. Symlinks/duplicates resolve to a single checkout. The shared
directory is `RULES_SHARED`, or the existing orchestrator shared-directory default.

Only `main` tracking a remote `main`, or a detached submodule using `origin/main`,
can advance. Fetch explicitly updates that tracking ref without submodule
recursion. Applying uses `git merge --ff-only --no-autostash` with hooks disabled;
it only advances to a descendant, never creates a merge commit, never overwrites
ignored local files, and never rebases, resets, stashes or switches checkouts.
Dirty, diverged, ahead, feature
branch, and locked checkouts are skipped with a one-line result. Tracked changes,
untracked files, and changed submodules all count as dirty. Parents are considered
first so a new gitlink can be followed by a detached submodule update. A parent
already dirty from an independently advanced submodule remains skipped.

The mini's live landing checkout is eligible when clean on `main`. The updater
owns `<shared>/autoupdate/<checkout-id>.lock` across fetch/apply, checks Git's
`index.lock`, and lets Git's own index/ref locks serialize racing owner landings.
Remote rewinds and owner landings ahead of the fetched tip cannot move it back.
Dead local updater locks can be reclaimed; foreign or unknown locks are skipped.
Background fetches have a 60 s timeout and release their lock on completion.
The lock deliberately skips concurrent starts instead of waiting.

`node scripts/skill-autoupdate.mjs --status` prints JSON lines containing each
checkout's current SHA, `origin/main` SHA, last fetch attempt time, fetch outcome,
and last result. It does not fetch or apply. The small rotating
`<shared>/autoupdate.log` includes update time, host and from/to SHAs; per-checkout
JSON stamps retain the latest result and fetch time. Running without `--status`
performs the same local update/fetch scheduling as the hook and prints results.

Verify with `node scripts/test/skill-autoupdate-scenarios.mjs`. Fixtures use only
temporary homes, bare file remotes and synthetic shared directories.
