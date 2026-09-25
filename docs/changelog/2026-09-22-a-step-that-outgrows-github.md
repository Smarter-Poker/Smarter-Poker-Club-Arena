# A Step That Outgrows GitHub Takes The Whole Workflow With It

2026-09-22. `tests/a-workflow-step-fits-what-github-will-run.law.test.ts`.

The repair is #5094. This is the guard whose absence let the defect reach
`main`, and it is the part that stops it recurring (CLAUDE.md 10.11: find it,
fix the cause, settle the damage, pin it).

## What the pin is for

From GitHub's workflow syntax reference, on `jobs.<job_id>.steps[*].run`:

> "Runs command-line programs that do not exceed 21,000 characters using the
> operating system's shell."

#5090 gave every guard in the publisher a voice, which was right, and took
`publish-to-origin / Publish through the host-owned immutable transaction`
from **17,304 characters to 24,626**. Past the limit GitHub does not fail the
step and does not name it. It refuses to LOAD the workflow, and every
consequence is oblique:

| what was observed                                                                  | what it meant                                           |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------- |
| the run named `.github/workflows/publish-club-arena.yml`, not `Publish Club Arena` | the name is read from a file it could not parse         |
| zero jobs, `created_at == updated_at`, conclusion `failure`                        | nothing to open: no annotation, no log, no failing step |
| runs created for pushes to `agent/...` branches                                    | the triggers live in the file it could not read         |
| `repository_dispatch` produced **no run at all**                                   | the one documented repair path has nothing to dispatch  |
| the Actions API's stored workflow name became the path                             | confirmed independently                                 |

Club Arena's only publisher was dead from 19:24 to 21:04 UTC. Four merges
landed on `main` in that window and none reached production; live stayed on
`d6c8ed39ea` for ninety minutes. The check that would have said so is the
workflow that stopped loading, which is CLAUDE.md 10.86 in its purest form.

## What it measures

Every `run` step in `.github/workflows/`, against the documented ceiling.

- **Over 21,000 it fails**, naming the workflow, job, step and character count.
- **Past 90% it reports too**, before the ceiling. This defect arrived as one
  pull request adding a few hundred characters at a time, and the cost of
  finding out at the ceiling is an unloadable workflow rather than a failed
  check.
- **It fails rather than passes when it cannot tell** (10.86 rule 2): a scan
  that measures no steps is broken, not clean, and a workflow it cannot parse
  throws instead of being skipped.

Its reader is `Client Unit Tests (vitest)`, one of the required contexts in
the `main protection` ruleset (10.86 rule 3), so a step over the limit cannot
merge.

Measured across the repository as this was written: the publisher's largest
step is 7,431 characters and the next largest anywhere is 6,160 in
`post-deploy-e2e.yml`. Nothing is close, and nothing else has to move.

## Mutation tested

| put back                                  | what the law said                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| the inlined 24,626-character transaction  | `publish-club-arena.yml publish-to-origin / Publish through the host-owned immutable transaction: 24626 characters` |
| 160 padding lines, still inside the limit | `publish-club-arena.yml publish-to-origin / ...: 20176 of 21000`                                                    |

Both restored afterwards; the law is green on `main` as it stands.
