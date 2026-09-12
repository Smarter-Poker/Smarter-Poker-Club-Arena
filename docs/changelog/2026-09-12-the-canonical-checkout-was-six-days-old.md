# The canonical checkout was six days old, and every doc it served was wrong with it

Developer environment and agent doctrine. 2026-09-12.

Three agents were handed wrong diagnoses last night and one nearly shipped two
regressions. None of them made a mistake. They read `~/Documents/club-arena`,
which is the folder every Cowork agent is pointed at, and it was **759 commits
and six days behind `origin/main`**.

## What was actually wrong

`git fetch` worked. `origin/main` in `.git` was current. The remote was
reachable the whole time. The jam was three small things:

1. A commit was made **directly on local `main`** at 18:18 on 2026-09-06
   (`ec745dbb18`, `fix(security): a trigger function is not a browser routine`)
   and never pushed. Local `main` was then 1 ahead as well as behind.
2. Every `git pull --ff-only` after that **could not fast-forward, so it
   refused**. The estate runs it as `pull -q --ff-only`. Nothing printed.
3. The index was left holding the tree of `7cf1c5f32a`, so 392 paths read as
   "staged". The clone looked busy rather than stuck.

Nothing was measuring the distance between the refs and the files.
`scripts/agent-workspace.sh` had already hit this on **2026-09-11 at 624
commits** and worked around it by re-execing `origin/main`'s copy of itself.
That was the right local fix, and because nobody measured the clone it drifted
another 135 commits in a day.

## What the stale tree was telling agents

Every one of these was correct on `origin/main` and wrong on disk, and **an
agent loads the copy on disk**:

- `.claude/skills/deploy-hetzner/SKILL.md` at **v1.0.0**, naming VPS
  `178.156.160.206` as the engine and instructing `ssh root@` it and
  `docker build`. That host is `club-arena-turn`, the **TURN server**
  (`docs/voice-turn-relay.md`). The engine is `5.161.252.33`
  (`engine.smarter.poker`, confirmed by DNS). `origin/main` has carried the
  corrected v2.0.0 since #4189's line of work.
- `CLAUDE.md` 10.82 documenting a fail-OPEN merged-branch guard with an
  `AGENT_MERGED_BRANCH_OK=1` bypass. On `origin/main` both the section and
  `scripts/guard-merged-branch.sh` had already been reconciled to fail-CLOSED
  with no bypass. The on-disk guard was the old 201-line version.
- `CLAUDE.md` referencing `.github/scripts/engine-watchdog.sh`, deleted in
  #4189 along with `.github/scripts/deploy-ship-rate.mjs`.

So two of the five reported defects were not defects in the repository at all.
They were the stale clone, read as if it were `main`. That is the finding.

## The repair

Preserved first, then moved. Nothing was discarded without being proved
redundant:

- `rescue/canonical-main-unpushed-2026-09-12` tags `ec745dbb18`. Both files it
  introduced were verified **byte-identical** to `origin/main` per file, so the
  work is upstream under a different sha.
- `rescue/canonical-snapshot-2026-09-12` tags a `git stash create` commit
  holding the exact index and working tree. The index tree `6260303db2` was
  proved identical to the tree of `7cf1c5f32a`, already an ancestor of
  `origin/main`: no unique content.
- All 38 untracked files were archived to
  `~/Documents/_agent-backups/canonical-checkout-2026-09-12/`. Nine of the 21
  that collided with tracked paths differed from `origin/main`: local drafts
  superseded by the merged versions, kept in the archive.

Only then `git reset --hard origin/main`. **0 behind, 0 ahead, clean tree.** The
on-disk skill is v2.0.0, `CLAUDE.md` 10.82 agrees with the guard, and the
`engine-watchdog.sh` reference is gone, all without editing a byte.

A second clone, `~/Documents/Smarter-Poker-Club-Arena`, was **1,179 commits
behind** and carried the same v1 skill. It holds 848 uncommitted tracked files
of live work, so it was **not** reset. What stopped it was a 0-byte
`.git/index.lock` from 2026-09-09 that had been failing every index write for
three days; with no process holding it (`lsof` empty) it was removed, and the
one dangerous file was updated in isolation.

## What now checks this

`scripts/check-checkout-freshness.sh`, a read-only peer of
`agent-trees-audit.sh` and `check-unpushed-work.sh`. It never pulls, resets,
prunes or deletes. It reports every clone of this repo on the machine, its
distance from `origin/main`, a local `main` that has diverged and therefore
cannot fast-forward, an index left holding an abandoned tree, and a stranded
lock older than an hour. Exit `1` is stale; exit `3` is **COULD NOT TELL**, and
is deliberately not `0` (10.86 rule 1).

`.husky/pre-push` runs it `--quiet`, and **advisory only**. A stale clone
elsewhere on the machine is not a reason to refuse this push from a fresh
worktree, and `tests/unit/doctrineIsReadFromMain.test.ts` is explicit that a
freshness guard which can wedge every push is worse than the staleness. The
worktree census is skipped in `--quiet` because counting 389 trees costs about
75 seconds.

The worktrees did inherit it: of 371 measurable trees under
`~/Documents/.agent-trees/club-arena/`, **147 are more than 500 commits behind
`origin/main`** and only 18 are within 50. New trees are cut from `origin/main`
so this is ageing, not the same jam, and `prune-stale-worktrees.sh` owns it.

### The check got this wrong once, on its first real run

Its first pre-push run announced **25 clones of Club Arena**, listing
`Smarter-Poker-Arcade` and `identity-dna-engine` among them. Git exports
`GIT_DIR` to its hooks and `git -C <dir>` does **not** override it, so every
`git -C "$d" config --get remote.origin.url` answered with the pushing repo's
URL and every directory matched. Every distance it then measured was measured
against the wrong repository.

That is this file's own subject matter: a component answering confidently when
it had no business answering (10.86). The script now clears the inherited git
environment before its first `git -C`, and a law test pins that, because a
freshness check that measures the wrong repository is worse than none.

## The generalisable half

Every item above is one failure: **a doc or a local copy asserting something
about the environment that stopped being true, with nothing checking.**
`tests/the-docs-describe-this-environment.law.test.ts` checks the three
assertions that are mechanically checkable:

- a script a binding doc NAMES must exist (saying it was deleted is always
  allowed; naming it as runnable is not);
- an override a doc documents as runnable, `VAR=1 some-command`, must actually
  be read somewhere in the tree;
- a tool a doc calls ABSENT must not be one this repo's own guards require.

A fourth pins the fix below. Each was proved to bite by breaking it on purpose
and watching exactly one assertion fail.

## `gh` is installed. It is not on the PATH the hook gets.

`CLAUDE.md` 10.83 and `AGENT-PLAYBOOK` 1 both said `gh` was not installed here.
It is: `/opt/homebrew/bin/gh`, v2.86.0, logged in as `Smarter-Poker`. This was
the **right observation with the wrong cause**, which is why it survived: every
agent that hit it agreed with the doc and stopped looking.

`/opt/homebrew/bin` is not on a non-interactive PATH. `.husky/pre-push` already
repaired PATH for `node` after a missing node was reported to an agent as "page
copy is not Title Cased", but the repair named one tool, and it only ran when
node was ALSO missing. So an agent following 11.0 and putting nvm's node on
PATH satisfies the node check, never triggers the repair, and
`guard-merged-branch.sh` refuses the push:

```
$ env -i PATH="$HOME/.nvm/versions/node/v24.15.0/bin:/usr/bin:/bin" bash
$ command -v node   ->  .../v24.15.0/bin/node      (repair skipped)
$ command -v gh     ->  (nothing)                  (guard fails closed)
```

The repair now covers the whole set the guards require, and **appends** rather
than prepends so finding `gh` cannot silently swap the agent's node for
Homebrew's. The law test fails if a guard starts requiring a tool the list does
not carry.

**The guard stays fail-closed, and the bypass stays gone.** The failure it
prevents is a push that exits 0 and reaches nobody, so "allow it through when
we cannot check" recreates exactly that defect. `AGENT_MERGED_BRANCH_OK=1` has
not existed since the guard was rewritten; what was wrong was a doc still
promising it.

## Corrected, not carried forward

- `AGENTS-PUSH-GUIDE.md` no longer says every token on the Mac is dead; that
  claim was already gone from `origin/main` and only survived on disk. A
  working credential does exist in the location the guide already names, and
  its value appears nowhere in this change. The guide now carries the PATH fix,
  which is where an agent actually hits this.
- `AGENT-PLAYBOOK.md` says it is byte-identical in all seven repos. Measured
  against the API today it exists in **two** (Club Arena 41,351 bytes, World
  Hub 46,143, already different from each other) and 404s in the other five.
  Said plainly in the text rather than left standing.

## Not done here

`.claude/skills/deploy-hetzner/SKILL.md` is being rewritten by **#4394**. Its
content is left entirely to that pull request; only the stale on-disk copies
were brought up to `origin/main`.

Editing `AGENT-PLAYBOOK.md` adds drift that `estate-integrity.sh` will report
until the same two corrections reach the other repo that has the file. The file
was already drifted and already missing from five of seven, so the alarm is
accurate and was accurate before this change.
