# The freshness guard worked perfectly and nobody read it (2026-09-21)

`~/Documents/club-arena` was found **258 commits and four days behind
`origin/main`**, with 1218 modified tracked paths, 2286 untracked paths, 112
stashes and 4151 local branches. Its `CLAUDE.md` was 1947 lines against
`origin/main`'s 1526.

This is the second recurrence of CLAUDE.md 10.87. The clone was repaired on
2026-09-12 and again on 2026-09-14 (both backups are still on the machine under
`~/Documents/_agent-backups/`). Repairing it a third time without fixing the
cause would be the band-aid 10.12 forbids.

## What agents were reading

Not a wrong IP this time. The stale tree served the **September 16** owner
instruction, which says a single task "retains sole integration and publication
authority", that other agents "remain read-only helpers", and that pending work
ships in a numbered queue. `origin/main` has carried the **September 17**
instruction since #4809, and it revokes precisely that: "Each agent authorized
to push and publish owns its assigned delivery through verified production. All
workstreams may proceed in parallel. Do not wait for the restoration task,
another numbered delivery or another manual release handoff."

Every Cowork session started in that tree was told to stand down by an
instruction the owner had already withdrawn.

## The jam was a different one

10.87 documents a commit made directly on local `main`, which leaves it 1 ahead
and makes every `pull --ff-only` refuse. That is NOT what happened here.
`git rev-list --left-right --count origin/main...HEAD` was `258 0`, and HEAD was
a clean ancestor of `origin/main`.

The blocker was the working tree. With 1218 tracked files dirty,
`git merge --ff-only origin/main` refuses with "Your local changes to the
following files would be overwritten by merge", and the estate runs it as
`pull -q --ff-only` into a log nobody reads. Same silence, different cause, so
the fix cannot be "look for a commit on main".

## Why nine days of a working guard changed nothing

`scripts/check-checkout-freshness.sh` was correct the whole time. Run by hand on
2026-09-21 it immediately reported the 256-commit gap, a second clone 374
commits behind, and a `.git/index.lock` stranded for 49 hours.

It had no reader:

- `.husky/pre-push` line 57 was its **only** caller in the repository. No
  workflow references it.
- `scripts/guard-shared-clone.sh` forbids pushing from `~/Documents/club-arena`,
  so in the one tree that rots, the hook never runs.
- In a worktree the hook does run and the script does report on every clone,
  but at line 57 of a 922-line hook, behind `|| true`, into a log agents launch
  as `nohup git push > /tmp/push.log` and grep for success.
- `check-main-is-green` cannot be the reader either: a GitHub workflow cannot
  see a clone on Dan's Mac.

That is 10.83 exactly, and 10.86 rule 3: a guard must have a reader and you
must name them.

## The fix is a reader, not teeth

`scripts/agent-workspace.sh` now runs the freshness check, next to the
`check-unpushed-work.sh` call that has been there since 2026-08-23 for the
identical reason, under the identical comment: an agent claiming a workspace is
the most frequent moment anybody looks at this machine. It is `--quiet`, it is
`|| true`, and it prints as `#` commentary. It cannot refuse anything.

Giving the guard teeth was considered and rejected: 10.87 rule 1 is explicit
that a freshness guard which can wedge every push in the estate is worse than
the staleness it reports. `tests/the-freshness-guard-has-a-reader.law.test.ts`
pins the reader, pins `|| true` in BOTH callers, pins that the script stays
read-only, and pins that exit 3 stays distinct from 0.

## What was preserved

Nothing was lost, and everything was classified before anything moved.

| category         | count | verdict                                                                                                                                                             |
| ---------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| modified tracked | 1043  | already byte-identical to `origin/main`                                                                                                                             |
| modified tracked | 172   | exact blob present at that path in `origin/main` history                                                                                                            |
| modified tracked | 3     | `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` - the superseded September 16 edition; blobs present in ref history                                                           |
| untracked        | 2201  | byte-identical to `origin/main`                                                                                                                                     |
| untracked        | 64    | exact blob present in `origin/main` history                                                                                                                         |
| untracked        | 21    | not on `origin/main`: 11 pre-reservation migration drafts (all 11 installed in production under later reserved versions), 10 agent outputs, handoffs and probe junk |
| local branches   | 4151  | 0 truly local-only; every tip reachable from an origin ref                                                                                                          |
| stashes          | 112   | untouched by the restore; full patches archived                                                                                                                     |

Archive: `~/Documents/_agent-backups/canonical-2026-09-21/` (2286 untracked
files, 94 MB, plus stash patches and the full inventory). Rescue commit
`78658a22` on tag/branch `rescue/canonical-2026-09-21` holds the exact
pre-restore tree.

## Two other clones, and one commit that was nearly lost

- `~/Documents/Smarter-Poker-Club-Arena` (a second Club Arena clone the
  playbook does not allow) was 374 commits behind with a 0-byte
  `.git/index.lock` stranded since 2026-09-19 and a
  `.git/objects/maintenance.lock` from 2026-09-14. `lsof` showed no holder for
  either. Restored; both locks moved to the backup rather than deleted.
- `~/Documents/Smarter-Poker-World-Hub` was the genuine 10.87 case: **1 ahead**,
  holding `a45bc57c` "perf(news): make search actually search, and index the
  popular sort" from 2026-09-20, five files, none of them anywhere on
  `origin/main`. **Both of its migrations are installed in production**
  (`20260920150544`, `20260920150710`), so live schema changes existed whose
  only source was a commit that every `pull --ff-only` had been silently
  refusing. Pushed to
  `origin/rescue/world-hub-news-search-2026-09-21` before anything moved.

  That commit is authored `Claude Opus 5 <noreply@anthropic.com>`. World Hub
  CHECK 15 requires `Smarter-Poker <...>` or `github-actions[bot]`, and Vercel
  sends an unattributable commit to BLOCKED with no build logs, so it must be
  re-authored before it can land.

## Also found, not fixed here

The World Hub `reference-transaction` hook refused that reset with "They are
NOT on origin" **after** the commit had been pushed and
`git branch -r --contains` listed it. Line 112 computes `git log NEW..OLD` and
never checks reachability from any other origin ref, so it cannot tell a
genuinely orphaned commit from a preserved one. It is a 10.86 defect in a guard
whose refusal message is stated as fact. Reported, not changed, because it is
in another repository.
