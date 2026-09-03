# Branch retention: archive, never destroy

**2026-09-03.** Dan: _"AND THESE ARE ON YOU TO CLEAN UP, NOT ME: Branch
triage - the 400 unmerged branches ... A retention rule is proposed in the
doc, not enabled - that one's yours."_

## What was wrong

This repo held ~570 branches. 176 had already merged through a pull request
and were simply never deleted - those were deleted outright, since their work
is on `main` by definition. The remaining 400 were triaged by hand into
`.agent/audits/2026-09-03-unmerged-branch-triage.md`.

The cost was never disk. It is that `orphan-work-watchdog.sh` - the thing that
exists to find an agent's stranded work - had 570 refs to walk, and a
genuinely stranded branch was invisible inside a list mostly made of Sentry
autofix attempts from May.

## What now happens

`.github/scripts/archive-stale-branches.sh`, run from the hourly
`Publish Watchdog` (the same job that already walks branches), retires a
branch by **copying it to `refs/archive/<name>@<date>` and deleting it in the
same atomic push**. Restoring one is:

    git push origin refs/archive/my-branch@2026-09-03:refs/heads/my-branch

Windows are 30 days for `rescue/*`, `sentry-autofix/*`, `autofix/*` and
`snapshot/*` - branches a machine made - and 60 days otherwise. 40 per run.

**It ships ARMED, for machine-generated branch classes only.** `ARMED_PREFIXES`
is `sentry-autofix/ autofix/ rescue/ snapshot/`. Anything else that qualifies
on age is printed under "reported only" and never touched, so the rule's
judgement about human branches stays visible for as long as we want before it
is trusted with them.

Armed on evidence, not on a calendar. The original plan was a week of dry
runs, and a week would have told us nothing a second run does not: the input
is the branch list, and it barely moves. What actually needed proving was
that the SELECTION is right, and the dry run proves it - 14 candidates, every
one a `sentry-autofix/*` branch 134-135 days old, with all 147 open-PR
branches exempt. A machine's abandoned autofix attempt from May cannot be
anybody's only copy of anything. Widening `ARMED_PREFIXES` to human branch
names is a separate decision, taken when the reported-only column has shown
what it would have taken.

First dry run, against the live repo:

    open pull requests: 147 (their branches are exempt)
    branches        : 406
    eligible now    : 14, archiving 14 this run

All fourteen were `sentry-autofix/javascript-react-*` branches 134-135 days
old. That is the shape a first pass should have.

## Why it is built the way it is

**It is the one piece of automation here whose bugs are unrecoverable by
default.** Everything else on this estate files an issue, opens a pull
request, or fails a check. This one can delete an agent's only copy of their
work. So the guarantee is structural rather than careful:

- **Archive and delete are one atomic push.** `git push --atomic` means a
  failed archive ref aborts the whole push instead of deleting anyway.
- **It fails CLOSED.** If the open-PR list cannot be read it exits having
  archived nothing. A branch with an open pull request is live work however
  old its last commit is - a PR can wait on a human for weeks.
- **It is capped at 40.** A bad window is caught after 40 branches, not 400.
- **`main`, `release/*` and `wip/*` are never touched at any age.**
- **A truncated pull-request list is refused.** An EMPTY list is obvious and
  already bails; a list clipped at the client's limit looks perfectly healthy
  and silently reclassifies every PR past the cut as "no open PR". That is
  precisely how a retention rule deletes live work. We cannot distinguish a
  list that happens to be exactly `PR_LIMIT` long from one that was clipped,
  so both are refused. This matters because CI takes the `gh pr list --limit`
  path while a workstation takes the paginated REST path - only one of the two
  was exercised by hand, and the guard covers the other.
- **`REPO` and the git `origin` remote must name the same repository.** The
  open-PR exemption is read for `$REPO` while the candidates and their tips
  come from `origin`. If those ever disagree - one stray `REPO=` in a workflow
  is enough - every branch looks like it has no open pull request and the rule
  deletes live work _while reporting that it checked_. It refuses instead of
  guessing.
- **Only armed classes are ever deleted.** The rule may judge any stale
  branch; it may only delete a machine-generated one.

`tests/branch-retention-never-destroys.law.test.ts` pins all four. Each pin
was mutation-verified: removing `--atomic`, turning the fail-closed exit into
a warning, dropping the open-PR exemption, removing the cap, and unprotecting
`main` each turn exactly one test red, and restoring the line turns it green.

**Two network operations, not one per branch.** The first draft asked the API
for each branch's tip in turn; over 400 branches that is 400 round trips and
it timed out - the identical failure `orphan-work-watchdog.sh` had before it
was rewritten. One `git fetch` brings every ref and its commit date down, and
`git for-each-ref` does the dating locally.

**The push uses the App token explicitly**, not the credential
`actions/checkout` persists. That one is `GITHUB_TOKEN`, which can read the
repo but cannot write `refs/archive/*` or delete a branch - so relying on it
would have worked in every dry run and failed the first time it was armed.
