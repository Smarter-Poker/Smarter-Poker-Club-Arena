# Nothing regresses quietly: the second pass

**Date:** 2026-08-22
**Scope:** all 7 active repos
**Predecessor:** `.agent/audits/2026-08-22-anti-regression-hardening-completed.md`

The first pass made merging safe. This one asks the question merging never
answers — **did it actually reach production, and if not, does anyone find
out** — and closes the ways work stops moving without anybody being told.

Every item below was found by reading what a system _published_, not by
checking whether it exited 0. That distinction found seven separate defects,
three of them in tooling written earlier the same day.

---

## 1. Nothing was asking production what it is serving

Every gate in this estate answered "did it merge". None answered "did it ship",
and those are different questions with the same green tick. Three incidents in
Club Arena were merges that never published: a sync push rejected because a
GitHub App may not write workflow files; a `cancel-in-progress: true` that
killed every build before its sync step; a bundle built from a stale tree. In
all three the agent reported success and production served the previous build
for hours.

`.github/workflows/publish-watchdog.yml` now compares `build-info.json` against
`main` after every publish attempt — including cancelled and failed ones, which
is when production is most likely stranded — and every 15 minutes besides.

Two distinctions matter more than the comparison:

- **Lag vs rewind.** An older commit that is still an ancestor of `main` is lag
  and resolves itself. A served sha that is _not_ an ancestor never will:
  `main` was rewound, or the bundle came from a branch. Nothing looked for that
  before, and it is the shape of the 2026-08-21 rewind that dropped four
  commits already live in production. It needs `fetch-depth: 0` to answer at
  all, which is why the checkout says so.
- **Transient vs real.** A lag past budget with no successful publish for HEAD
  gets **one** automatic re-dispatch before any human is told. The usual causes
  — a cancelled run, a rejected push, a 5xx — are all fixed by running it
  again. A second lag on the same sha is not transient, and the issue says so
  instead of retrying forever. A rewind is never retried; retrying would
  republish the wrong thing.

Verified against five states before shipping: healthy, lag within budget, lag
over budget, non-ancestor, and production unreachable.

Also pinned in `shipped-invariants`: `cancel-in-progress: false`, and the
client suite running inside the publisher rather than in `ci.yml` (which never
completes on main, because pushes land faster than CI and cancel it). Both
verified by breaking them and watching the specs fail.

---

## 2. Work that stops moving now has a name

Autopilot merges what _can_ merge. What it did with the rest was print one line
into a run log nobody reads. Two categories, both invisible:

**Pull requests that cannot merge.** PepNationLab was carrying six — 998h,
998h, 998h, 998h, 999h and 1647h. Forty-one to sixty-eight days of finished
work that nothing anywhere mentioned. The report separates conflicts, red
required checks, and _no check ever reporting_ — that last is the quiet killer,
because the PR waits forever for a context that will never arrive and the UI
just says "pending". It is also the failure mode the ruleset work of the first
pass could have introduced in six repos at once.

**Branches pushed and never proposed.** These have no pull request to be stuck
on, so nothing else can see them. Club Arena: 16, behind 204 remote branches.
PepNationLab: 8. The filter that makes this signal rather than noise is asking
whether a pull request _ever existed_ for the ref — a squash merge leaves every
merged branch permanently "ahead", so filtering on that alone reports the whole
repo and the report is ignored within a day.

An `agent/*` branch under a day old gets a pull request opened automatically:
that namespace exists solely because `agent-workspace.sh` creates it to become
one. Anything older is reported and never auto-opened — a months-old branch
auto-merged is a regression wearing a rescue costume.

---

## 3. A reset can no longer destroy a commit, or an edit

Antigravity's `git reset --hard origin/main` loop is the mechanism behind every
"my work vanished" report. Two halves, and both are closed now.

**Commits.** `reference-transaction` is the only hook that fires _before_ a ref
update lands — git has no `pre-reset` hook (the file of that name in some
clones has never once run) and `post-checkout` fires after the damage. It
existed, untracked, in one clone of World Hub: ten days of protection covering
one machine and dying on every fresh checkout. It is tracked now, in all seven
repos, with two changes that had to happen first:

- **It saves before it refuses.** The commits about to be orphaned are written
  to `refs/wip/orphan-guard/<stamp>` first, so even an override or a
  `--no-verify` leaves the work recoverable. Blocking and saving are different
  jobs and only one was being done.
- **It has an escape hatch.** `agent-workspace.sh` runs
  `checkout -B <branch> origin/main`, which moves a ref backwards on purpose.
  Without `AGENT_REF_GUARD_OK=1` the guard would wedge the one command every
  agent is told to start with.

Verified in a scratch repo, all five paths: blocked with exit 128 and the
commit survives; the snapshot ref exists; a deliberate override succeeds; the
work is _still_ recoverable after that override; an ordinary forward commit is
untouched.

**Uncommitted edits.** `scripts/agent-trees-snapshot.sh` captures every working
tree as a real git ref every ten minutes, via a launchd agent. It is safe to
run mid-edit because `git stash create` builds the commit objects and prints
the sha without touching the index, the working tree or the stash stack —
there is no pop half and nothing to conflict with. Untracked files are
deliberately not covered: `reset --hard` does not delete them either, and a
guard that reads broader than it is, is worse than none.

---

## 4. World Hub was the least protected branch in the estate

It is the repo that serves production — the Club Arena bundle lands there and
Vercel deploys from it — and it had **no required checks and no pull-request
rule**. Anything could be pushed straight to `main` and go live.

The stated reason was real: the Club Arena sync pushes directly to that branch,
so any rule would stop publishing. That was true while the sync pushed with
`WORLD_HUB_SYNC_TOKEN`, a PAT with an expiry date of its own.

The sync now mints a **GitHub App installation token scoped to World Hub
alone**. That removes a second expiry cliff _and_ gives the push a distinct
identity — which is the only reason the branch can be protected at all. The
ruleset names that App as its single bypass actor.

Verified in both directions, minutes apart:

- the sync pushed to `main` through the protected branch and published;
- a direct push from an ordinary identity was refused — _"6 of 6 required
  status checks are expected... push declined due to repository rule
  violations"_.

**Still open, and it is why the list is six checks and not eight:**
`Pre-Deploy Safety Checks` is red on `main` for three database invariants — a
definer view with write grants, anon-callable definer functions that write
without checking `auth.uid()`, and tables with RLS disabled that clients can
write to. Live authorization holes, not code. Issue #630.

---

## 5. Hooks that protected exactly one machine

World Hub's `package.json` ran `git config --unset core.hooksPath`, so git used
`.git/hooks/` — **untracked**. Seven hooks written from real production
incidents existed on one Mac and died on every fresh clone. The tracked
`.husky` copies had drifted in _both_ directions and ran nowhere: `.git/hooks`
had the Club Arena build guard, `.husky` had the `transpilePackages` guard, and
each was missing the other's.

Now the union, split into `scripts/hooks/` so each half runs independently, with
`prepare` pointing git at it. Nothing was dropped. One real bug fixed on the
way: `.husky/pre-push` exited 0 early on _"No JS/TS files changed"_, and a push
carrying only `public/hub/club-arena/**` contains no JS/TS files by that filter
— so the Club Arena bundle checks were skipped by exactly the pushes they exist
to inspect, including the stale-bundle class that reverted throwables in
production on 2026-08-21.

**Note:** the flip takes effect on the next `npm install` in the World Hub
clone. That clone is currently 28 commits behind on branch
`ci/agent-autopilot`, so `core.hooksPath` was deliberately left unset rather
than pointed at a stale `.husky`. Its one unpushed commit and its dirty tree
were snapshotted to `refs/wip/world-hub-clone/*` first; the commit's content is
already on `main` under a different sha.

---

## 6. Two ReferenceErrors that were live in production

`undefined-identifier-guard` had been red on World Hub `main`. Nothing required
it, so nothing stopped the pushes and nobody looked. Both findings were real:

- **`mountedRef`**, 4x, `pages/hub/commander/tournament/[id]/clock.js`. Read
  four times, never declared. The placement made it fatal rather than noisy:
  the first read sits inside the `try` and was swallowed as "Failed to fetch
  tournament", but the read in the `finally` throws again, outside any handler,
  and takes the page down behind the error boundary. Every load of the live
  tournament clock, for every operator.
- **`getLore`**, `src/components/avatars/AvatarGallery.jsx`. A half-finished
  edit: the comment "Fake lore generator" is still there, the function is gone,
  and the call site stayed. Inspecting any avatar threw and the modal opened
  blank.

Also named two jobs that were both called `check` — the context a ruleset can
require is the _job_ name, so a rule naming it would have been ambiguous and
satisfiable by whichever reported first.

---

## 7. The new guards had the bug they were written to catch

This is the part worth reading twice.

**They failed silently.** The first live run of `report-stuck-prs.sh` found six
pull requests stranded for 41 to 68 days, could not raise the issue, and
printed **53 seconds of nothing** on a step that reported success. One line:

```
gh issue create ... >/dev/null 2>&1 && echo "opened an issue"
```

A failed write produces no error, no message and no non-zero exit — the exact
anti-pattern this whole system exists to catch, reproduced inside the tool
written to catch it. Every write now goes through `gh_write()`, which captures
the output and emits `::error::` naming both what it could not do and what the
finding was. The counts print unconditionally, so the run log alone answers
what was seen.

Issue writes now use `GITHUB_TOKEN` via `GH_TOKEN_ISSUES`, not the App token:
the App is required for _merges_ (a `GITHUB_TOKEN` merge does not trigger
downstream workflows and would land a commit that never publishes), while
`issues: write` on `GITHUB_TOKEN` is declared in the workflow and therefore
guaranteed, where an App's installation scopes can be narrowed without anyone
noticing. Narrow token, narrow job.

**They published fiction.** The orphan table reported branches 3,908 and 4,693
commits ahead of `main`. Real counts of an unreal thing: `git rev-list` inside
an `actions/checkout` with `fetch-depth: 1` has no merge base to find, so
nearly every commit counts as "not on main". A table with an impossible number
in it is a table people stop reading. Replaced with the server-side
`compare/{base}...{head}` API, which also lets branches carrying nothing new be
filtered out entirely.

**They duplicated.** PepNationLab #79 and #80, World Hub #633/#634/#635 — same
title, same content, filed minutes apart by sweeps that each checked for an
existing issue and each saw none. The check read GitHub's _search index_, which
is eventually consistent. All three guards now ask the plain list endpoint,
which is current. A de-duplicating guard that duplicates is worse than none:
the noise is what teaches people to scroll past it.

---

## What is still open

|                        |                                                                                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| World Hub #630         | three database invariants failing on `main`. Until they are green, `Pre-Deploy Safety Checks` cannot be a required check on the repo that serves production.                       |
| World Hub #625         | `core.hooksPath` flip is landed but not active in Dan's clone; that clone is 28 behind on a feature branch with one unpushed commit (content already on main, snapshotted anyway). |
| Diamond-Arena #12      | 63 TypeScript errors hiding behind `continue-on-error`, so `TypeScript Check` cannot be required there.                                                                            |
| PepNationLab           | six conflicted pull requests, 41–68 days old, now named in an issue that updates itself. Each needs resolving hunk by hunk.                                                        |
| commander-shared       | three CommonJS files frozen in an allowlist. Converting them changes what World Hub and Commander receive at runtime and needs those consumers tested.                             |
| 24 unproposed branches | 16 in Club Arena, 8 in PepNationLab. Each is a judgement call: open a pull request, or delete the branch.                                                                          |

Every one of these is now _named somewhere that updates itself and closes when
the condition clears_, which is the difference between a backlog and a list
nobody reads.
