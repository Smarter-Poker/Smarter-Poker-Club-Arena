# Two ways a guard can fail without anyone finding out

**2026-09-03**, from the final sweep of the publish migration. Neither of these
is a bug in what the guards check. Both are bugs in their ability to _tell you_.

## 1. An expired secret beats a working one

`push-velocity-watchdog.yml` had

    GITHUB_TOKEN: ${{ secrets.GH_ADMIN_PAT || secrets.VERCEL_UNIQUENESS_PAT || secrets.GITHUB_TOKEN }}

and had been failing **every hour since 2026-05-10** with
`GET commit: 401 Bad credentials`.

`||` in an Actions expression takes the first **non-empty** value, and **an
expired PAT is not empty.** So the dead secret won every single run and the
built-in token - which was right there, third in the chain, and cannot expire -
was never reached. The chain looked like resilience and was the opposite: it
converted "this credential died" into "this workflow is just red", inside the
one workflow whose entire job is noticing when things go quiet.

That watchdog now uses `secrets.GITHUB_TOKEN` outright. It only reads its own
repo's commits and files an issue, both already granted by its `permissions:`
block.

The remaining chains are split by whether they can die this way:

- **Safe by construction** - lead with `steps.app-token.outputs.token`. An App
  token is minted per run, so it cannot expire, and if the App is broken the
  mint step fails loudly before the expression is ever evaluated.
- **Guarded** - `secrets-expiry.yml` and `sentry-autofix.yml` led with a raw
  expiring secret. They now run `.github/scripts/check-token.sh` first, which
  probes the repository with whatever token actually resolved (working for both
  PAT and App tokens) and files an issue naming the fix.

## 2. A sweep that cannot see all the work

The autopilot read open pull requests with `--limit 100` while **148 were
open**. The other 48 were invisible: never armed with auto-merge, never
reported, simply sat there. And `report-stuck-prs.sh` asked `--state all
--limit 500` in a repo with thousands of pull requests, so a branch whose PR
was merely _old_ read as one that had **never been proposed** - and the remedy
for that misreading is to open a second one.

Limits raised, but a cap that is merely larger is still a cap. The important
change is the last question before anything is created:

    gh api "repos/${REPO}/pulls?state=all&head=${OWNER}:${B}&per_page=1"

That asks about one branch by name and cannot truncate. Verified against the
live API on three cases: a branch with an open PR (1), a branch that does not
exist (0), and the oldest closed PR in the repo (1 - found despite age, which
is exactly the case the list misses). If the answer is unavailable the branch
is **reported for a human and no PR is opened**, because guessing here creates
duplicates.

## The rule

`tests/a-watchdog-cannot-die-quietly.law.test.ts`, six pins, each
mutation-verified: removing the token guard, restoring `--limit 100`, dropping
the exact head check, and letting an unverifiable answer fall through each turn
the matching test red.

A guard is not "working" because it is green. It is working when it can still
raise its hand on the day the thing it watches goes wrong.
