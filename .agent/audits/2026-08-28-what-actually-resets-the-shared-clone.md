# What actually resets the shared clone (it is not Antigravity)

**Date:** 2026-08-28
**Status:** Correction to `.memory/decisions/2026-05-06-antigravity-auto-reset.md`,
`scripts/guard-shared-clone.sh`, `.husky/post-checkout` and World Hub `CLAUDE.md` rule 13.

## What happened

On 2026-08-27 at 23:00:41 UTC, ~40 tracked files of in-progress work in
`~/Documents/club-arena` were destroyed. Every tracked file in the clone was
rewritten in the same second; untracked files survived untouched.

Three agents independently reported the symptom as "another agent is editing
this file mid-session" and mis-attributed their own tsc errors to it. A pristine
`git archive HEAD` extract compiled with **zero** errors, which is what proved
the errors were ours and the tree had been rewritten underneath us.

## What did it

Not Antigravity. Antigravity was not running. The reflog names the culprit:

```
HEAD@{5}: commit:   rescue: save uncommitted migrations applied to prod
HEAD@{4}: checkout: moving from agent-rescue/uncommitted-migrations to main
HEAD@{3}: reset:    moving to origin/main
```

That is the signature of a rescue-then-reset in the shared clone —
`scripts/git-unstick.sh` line 65 is `git reset --hard --quiet origin/main`.
Another agent ran it (or the same sequence by hand) while four agents were
mid-edit in the same tree. `git reset --hard` discards tracked modifications and
spares untracked files, which matches the damage exactly.

## Why the existing docs sent everyone the wrong way

Four separate places state, as settled fact, that "the Antigravity
`git reset --hard origin/main` loop" destroys uncommitted work:

- `.memory/decisions/2026-05-06-antigravity-auto-reset.md`
- `scripts/guard-shared-clone.sh` (twice, in the refusal message a human reads)
- `.husky/post-checkout` (in the warning a human reads)
- World Hub `CLAUDE.md` rule 13

That was true in May 2026. It is no longer the live cause, and stating it as the
cause costs real time: an agent that believes Antigravity is responsible goes
looking for a background process, quits the wrong application, and never checks
the reflog — which names the real cause in one line. Cost on 2026-08-27:
roughly four agent-hours of work redone.

**The correct statement is: any agent working in the shared clone can destroy
any other agent's uncommitted work, through an ordinary checkout, a
`git reset --hard`, `git-unstick.sh`, or `git-safe-push.sh`'s fallback path.**
Antigravity was one instance of a general hazard, not the hazard itself.

## What is actually protective

Confirmed working, and worth knowing:

- **`.husky/post-checkout` does not reset anything.** It only warns and
  snapshots — `git stash create` into `refs/wip/`, which `git reset --hard`
  cannot reach. It is what made the 2026-08-27 work recoverable
  (`refs/wip/shared-clone/20260828T040041Z`). Read its own comment: "It never
  blocks and never moves anybody."
- **The `refs/wip/` snapshot is the last line of defence and it held.** But it
  is recoverable only with care: that snapshot's base was an older commit, so
  the recovered `src/pages/TablePage.tsx` was 16,859 lines against HEAD's
  18,040. Restoring it wholesale would have silently reverted ~1,200 lines of
  other people's committed work. **Port deltas out of a `refs/wip` snapshot;
  never copy its files over the top.**
- **`scripts/agent-workspace.sh` is the actual fix** and always was. One
  worktree per agent: own directory, own HEAD, own index, own branch, shared
  object store. Agents become physically unable to disturb one another.

## The rule

Do not edit in `~/Documents/club-arena`. Claim a tree first:

```bash
eval "$(bash scripts/agent-workspace.sh <your-agent-name> fix/describe-your-change)"
```

Commit early and often once you are there. A commit survives every reset in
this document; an uncommitted edit survives none of them.

## Note on the unlink limitation

A sandboxed agent's mount of this repo **cannot unlink files** (verified again
2026-08-28: `touch` succeeds, `rm` returns "Operation not permitted"). So the
existing rule stands — never run git write commands against the mounted
worktree from a sandbox, because a `.git/index.lock` created there is stranded
and then blocks git on the Mac host too. `_to_delete/` currently holds several
such stranded locks and probe files from previous agents.
