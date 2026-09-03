# The pruner could not see a squash merge, so the worktree count only grew

Date: 2026-09-02
Branch: `fix/the-pruner-cannot-see-a-squash-merge`

## Symptom

The Mac was at **92 percent full, 76 GB free**, carrying **355 Club Arena
worktrees** of which 341 held their own `node_modules` - roughly 110 GB of
duplicated dependencies. `git worktree list` had begun to hang outright.

`scripts/prune-stale-worktrees.sh` exists precisely to stop this, and
CLAUDE.md 10.8-4 says it removes any worktree that is clean, pushed and idle
for 72 hours. It ran and reclaimed almost nothing: 26 of 344.

## Cause

The "is this work safely on origin?" gate was:

```bash
if [ -z "$(git -C "$WT" branch -r --contains HEAD)" ]; then
  echo "KEEP  (unpushed!) $WT   <- push this branch or it exists only here"
```

`--contains` asks whether HEAD is an **ancestor** of a remote ref. That is only
ever true for a branch merged with a merge commit.

**This repository squash-merges.** A squash puts the branch's CONTENT on main
under a brand new SHA; the branch's own commits never become ancestors of
anything. So for every branch that shipped - weeks ago, correctly, through a
pull request - the check answered "not on origin", filed the worktree under
`unpushed!`, and kept it forever.

The bucket was therefore permanent and monotonically growing, which is exactly
the shape the disk showed.

## Measurement

Of **62** worktrees this check called `unpushed!`:

|                                                 | Count  |
| ----------------------------------------------- | ------ |
| Every commit already upstream under another SHA | **54** |
| Holding at least one genuinely new commit       | **8**  |

The eight are real and are still kept, loudly: `cowork-dan`, `cowork-finish`,
`cowork-herohub`, `cowork-perf`, `cowork-scroll`, `cowork-tmoney`,
`cowork-tourney`, `fix-cashier-regression`.

## The change

The ancestry check stays as the fast path. When it says no, the script now
asks `git cherry`, which compares **patch IDs** rather than SHAs and so
recognises a squashed commit by its content: `-` means an equivalent commit is
already upstream, `+` means it is not.

- zero `+` lines: the work is on main under another SHA. Prunable.
- any `+` lines: genuinely unpushed. Loud KEEP, with the count in the message.

Dry-run before and after, same machine, same moment:

|                        | Before | After  |
| ---------------------- | ------ | ------ |
| Would prune            | 26     | **86** |
| Recognised as squashed | -      | 82     |
| Still called unpushed  | 109    | **15** |

## Why this cannot eat somebody's work

The change can only ever move a worktree from KEEP to PRUNE, and only when git
itself reports every commit already has an equivalent upstream. Everything that
protected a worktree before still protects it:

- a dirty tree is kept (`git status --porcelain`);
- a tree with recent commits is kept (`IDLE_HOURS`, default 72);
- a tree with even one commit of its own is kept, and now says how many;
- `git worktree remove` is still called **without** `--force`, so git refuses a
  dirty tree even if every check above were wrong;
- nothing is deleted with `rm`.

It also **fails closed**. If `origin/main` cannot be resolved, `UPSTREAM_REF`
is cleared and every unmatched worktree takes the loud KEEP - the script never
prunes on the strength of a comparison it could not make.

`tests/pruner-sees-a-squash-merge.test.ts` pins all six of those properties,
because the dangerous direction of change here is not "prunes too little".

## Follow-on, not done here

The eight genuinely-unpushed branches above are unreviewed work sitting on one
laptop. They are listed rather than pushed: this repo auto-opens a pull request
and auto-merges on push, several of them touch money paths, and one
(`cowork-tmoney`) carries an `[allow-revert]` token in its commit message that
CLAUDE.md 10.8-2 no longer honours. They need reading, not a batch push.
