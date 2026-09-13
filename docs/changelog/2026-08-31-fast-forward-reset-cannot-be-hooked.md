# 2026-08-31 — The Fast-Forward Sync Reset: A Real Gap, And Why No Hook Closes It

> Historical incident record. The timer, snapshotter, post-checkout writer,
> recovery janitor, and their installation paths were retired on 2026-09-10.
> Current protection is structural: isolated agent worktrees, a shared-clone
> refusal guard, prompt commits and pushes, and a read-only ref-transaction
> hook that blocks genuinely unreachable commits.

## What was investigated

A claim I made earlier in the session — that uncommitted work in the shared
clone was at imminent risk of destruction — turned out to be **wrong in its
premise and right about a narrower thing**. Both halves are recorded here
because the wrong half is the intuitive one and will be re-derived otherwise.

## Measured facts

1. **Untracked files survive `git reset --hard`.** Verified empirically in a
   scratch repo: they are removed only by `git clean -fd`, and nothing in the
   current estate runs it. `src/lib/heroSeatReconcile.ts` — which
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

## What protects the work now

The temporary periodic snapshot layer described by this incident has been
removed. Agents work only in isolated worktrees; the shared-clone guard refuses
commits and pushes from the shared clone; the workspace tool refuses to move a
dirty tree; and completed slices are committed and pushed promptly. The
ref-transaction hook is preventive and read-only. It blocks a transaction that
would make local commits unreachable and creates no recovery state.

## What shipped

`tests/unit/resetGuardCannotSaveTheWorktree.test.ts` is now a retirement law.
It fails if periodic/post-checkout snapshot machinery returns, if the ref hook
mutates repository state, or if the isolated-worktree controls disappear.

Proven in both directions: seeding the exact reverted mistake turns the guard
red; removing it turns it green.

## Not fixed, deliberately

The hook still cannot recover tracked edits after a hard reset because Git has
no pre-reset hook. The root control is therefore to never perform destructive
resets in a shared or dirty worktree; no background writer pretends to repair
that mistake later.
