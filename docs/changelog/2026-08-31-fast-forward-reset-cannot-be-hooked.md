# 2026-08-31 — The Fast-Forward Sync Reset: A Real Gap, And Why No Hook Closes It

## What was investigated

A claim I made earlier in the session — that uncommitted work in the shared
clone was at imminent risk of destruction — turned out to be **wrong in its
premise and right about a narrower thing**. Both halves are recorded here
because the wrong half is the intuitive one and will be re-derived otherwise.

## Measured facts

1. **Untracked files survive `git reset --hard`.** Verified empirically in a
   scratch repo: they are removed only by `git clean -fd`, and nothing in the
   estate runs it (one comment in `agent-trees-snapshot.sh` acknowledges the
   hazard; no script performs it). `src/lib/heroSeatReconcile.ts` — which
   prompted the concern — was never at risk from the reset loop.

2. **Tracked modifications ARE destroyed by `git reset --hard`,** and
   `post-checkout` (the only hook that snapshots the working tree) **does not
   fire on a reset**. Probed with instrumented hooks: only
   `reference-transaction` fires.

3. **`reference-transaction` has a genuine blind spot.** Its two branches are
   `OLD == NEW` (bare reset — warns) and orphaned-commits (rewind — saves and
   blocks). A `git reset --hard origin/main` in a clone that is merely BEHIND
   matches neither: HEAD moves, so the first is skipped, and `git log NEW..OLD`
   is empty, so the second `continue`s. Tracked edits go silently.

   This is the steady state of the shared clone — measured the same day at 42
   commits behind, 0 local commits, 25 modified files — and that reset is
   precisely what the Antigravity sync runs on a timer.

## Why the obvious fix was written, tested, and reverted

The natural repair ("if the tree is dirty here, `git stash create` and warn")
was implemented and then destroyed by its own tests. Probed inside the hook
during a real fast-forward reset:

    before reset, worktree f.txt = "IMPORTANT LOCAL EDIT"
    PROBE worktree f.txt         = [v2]        <- origin's content ALREADY there
    PROBE git show HEAD:f.txt    = [v1]        <- HEAD has not moved yet
    PROBE git status --porcelain = [M  f.txt]  <- git's OWN staged change

Two fatal consequences:

- **False positive.** The `M` is git's in-flight reset, not user dirt, so the
  warning fires on every _clean_ sync reset. A warning on a timer is a warning
  nobody reads.
- **Useless snapshot.** `git stash create` captures the POST-reset bytes. The
  ref it writes _looks_ like a rescue and contains origin's content — worse
  than no snapshot, because it answers "was my work saved?" with a confident
  yes. Confirmed: the recovered content was `v2`, not the local edit.

The hook's original authors had reached the same conclusion and said so; this
is the evidence behind that sentence. **The gap cannot be closed at the hook
layer — there is no `pre-reset` hook and the tree is already overwritten.**

## What actually protects the work (verified healthy)

The launchd snapshotter `poker.agent-wip-snapshot` (installed by
`scripts/install-wip-snapshot-agent.sh`, `StartInterval` 600s) writes real
pre-reset content to `refs/wip/`. Verified 2026-08-31: loaded in `launchctl`,
last run took **77 snapshots across 25 repos**, and the newest `club-arena`
snapshot (29 minutes old) contained **all 25 modified files**. Worst-case
exposure is therefore ~10 minutes of edits, not a session.

## What shipped

`tests/unit/resetGuardCannotSaveTheWorktree.test.ts` (5 tests) — a trap-guard,
not a feature test. It fails if anyone adds `git stash create` to
`reference-transaction`, asserts the two branches that DO work are still
present, and pins that the snapshotter's installer and tree-walker still exist
— because if that installer disappears, the only real protection for tracked
modifications goes with it.

Proven in both directions: seeding the exact reverted mistake turns the guard
red; removing it turns it green.

## Not fixed, deliberately

The silent fast-forward reset stays silent. Every available fix is worse than
the gap, and the content is already protected by the snapshotter. If git ever
gains a `pre-reset` hook, this becomes trivial — that is the condition to
revisit under.
