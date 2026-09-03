# Every Vercel Error Was One Branch Nobody Read

**Date:** 2026-09-03
**Scope:** `.github/workflows/agent-open-pr.yml` (all seven estate repos),
`.github/scripts/estate-integrity.sh`, plus `vercel.json` in World Hub,
PepNationLab and Commander.

## What Dan Saw

Every deployment list on Vercel (hub-vanguard, pepnationlab,
smarter-poker-commander) showing ERROR after ERROR, new ones appearing
minutes after the "fix" landed, all of them named
`ci-marker/agent-open-pr-result`.

## What Was Actually Happening

`agent-open-pr.yml` opens a pull request for every pushed branch. At the end
of that job it force-pushed its own log as an orphan commit to the branch
`ci-marker/agent-open-pr-result`, "where a git-only agent can read it".

Two facts about that branch, both read from the data rather than assumed:

1. Nothing reads it. Not one script, workflow or document in any of the
   seven repos fetches that ref (`git grep ci-marker origin/main` in each).
2. Vercel's GitHub App creates a deployment for every branch push on a
   linked repo. An orphan commit holding one text file has no app to build,
   so each push was one failed deployment, 7 to 16 seconds in. Every ERROR
   on all three projects, checked deployment by deployment, was this ref.

Two earlier attempts aimed at the wrong layer. A skip-ci tag on the marker
commit is honoured by Vercel's own CI detection, not by GitHub App
deployments. A `vercel.json` `git.deploymentEnabled` guard stops the
build, but only after the deployment record already exists, and it lives
on the production branch while the orphan carries no `vercel.json` at all.
Neither could remove the error from the board; only not pushing the branch
can.

## The Fix

The branch push is gone. The log goes to the run's job summary
(`$GITHUB_STEP_SUMMARY`), which the Actions UI and `gh run view` show, and
the job drops from `contents: write` to `contents: read`. The step carries
the reason in a comment so it is not reintroduced by someone reading the
old rationale. A git-only agent that wants to know whether its branch has a
pull request has a better witness than the marker ever was:
`git ls-remote origin 'refs/pull/*/head'` lists the head sha of every pull
request.

The file is byte-identical in all seven repos, and `estate-integrity.sh`
now holds it there alongside `agent-autopilot.yml`.

The `vercel.json` guards stay as a second line, so a future branch that is
not an app still cannot spend a build.

## The Second Thing Found On The Way

The three `vercel.json` pull requests sat at "blocked" with zero checks.
Their commit messages quoted the literal skip-ci tag in square brackets
while describing the earlier attempt, and GitHub skips every `push` and
`pull_request` workflow run when the head commit message contains that
tag: no CI, no autopilot fast path, no auto-merge, a pull request that
would have waited for a sweep that comes about once in ten. The messages
were reworded and the branches re-pushed. Lesson for the playbook: never
quote the skip tag in a commit message, even to talk about it.

## Verification

- `git grep -n 'refs/heads/ci-marker' origin/main -- .github` returns
  nothing in any of the seven repos once these land.
- Vercel `list_deployments` after the next few pull requests: no ERROR
  entries with `githubCommitRef: ci-marker/agent-open-pr-result`.
- The stale `ci-marker/agent-open-pr-result` branches were deleted from
  all seven repos; the orphan watchdog exempts the namespace, so nothing
  reports them as work.
