# "Checks pending" was a lie, and the API told it

2026-09-06.

An agent reported **"checks pending"** on a branch whose CI had been red for
three pushes. The report was not careless. It is what the API said.

## The ladder

Every step is reasonable. The destination is a false all-clear.

1. The agent opens `AGENT-PLAYBOOK.md`, which has a section called
   **"Reading CI status"**. It correctly explains that the estate PAT has no
   `checks:read` and correctly names the Actions API as the answer. Then it
   offers four commands to run — `gh pr checks`, `gh pr view`, `gh run list`,
   `gh api`.
2. **`gh` is not installed on this Mac.** (CLAUDE.md 1.2.5 has said so since
   2026-09-06; the playbook claimed otherwise for longer.) Four
   `command not found`.
3. The agent falls back to curl and the obvious endpoint:
   `GET /commits/:sha/check-runs` → **403 Resource not accessible by personal
   access token**. A caller that reads `body.check_runs` off that gets
   `undefined`, and `undefined || []` reads as _nothing failed_.
4. The agent falls back once more to `GET /commits/:sha/status` → **HTTP 200,
   well-formed, `{"state":"pending","total_count":0}`.**
5. The agent reports: checks pending.

## Why step 4 is the dangerous one

`/commits/:sha/status` is the **legacy commit-status API**. Every check in this
estate is a GitHub Actions _check-run_, and check-runs are not commit statuses.
So the endpoint has nothing to report, and the word it uses for nothing is
`pending`.

It returns `pending` for a green commit, a red commit, and a commit nobody has
ever built. It never returns anything else here. Measured against PR #3163,
whose `CI - Build & Type Safety` had been `completed failure` for **fifteen
hours**:

| route                      | answer                                         |
| -------------------------- | ---------------------------------------------- |
| `/commits/:sha/status`     | `state: "pending"`, `total_count: 0`, HTTP 200 |
| `/commits/:sha/check-runs` | HTTP 403                                       |
| `/actions/runs?head_sha=`  | `completed failure - CI - Build & Type Safety` |

A 403 is survivable because it is loud. A 200 that says `pending` is not.

## What the estate could not see

`scripts/ci/pr-status.mjs --all`, run the moment it existed, against 34 open
pull requests:

**22 had a failing required check. 8 conflicted with main. 2 were green.**

Nobody could see that. Six separate handoff documents already record the 403,
each recommending a different workaround, none of them runnable on the machine
agents actually run on.

## The fix

**`scripts/ci/pr-status.mjs`** — one command, no `gh`, no `checks:read`.

```bash
export GITHUB_TOKEN=$(grep -m1 '^GITHUB_TOKEN=' ~/Documents/club-arena/.env | cut -d= -f2-)
node scripts/ci/pr-status.mjs            # the PR for your current branch
node scripts/ci/pr-status.mjs 3163       # by number
node scripts/ci/pr-status.mjs --all      # every open PR, worst first
```

It names the failing **job** and **step**, prints the curl that fetches that
job's log, and says whether the check actually blocks the merge — the ruleset
names _jobs_ (`TypeScript Check`), not _workflows_ (`CI - Build & Type
Safety`), and reading that backwards is why agents mis-judge which reds matter.
Required checks are read from the live ruleset rather than hardcoded.

Exit codes are the contract: `0` green, `1` red, `2` running, `3` **unknown**,
`4` conflicting.

**`3` is the point of the whole exercise.** UNKNOWN is a distinct outcome with
its own exit code, and the law forbids it from sharing one with RUNNING or
GREEN. A probe that cannot read CI must say it cannot read CI. Every non-200 is
surfaced, never coerced into an empty result.

Two smaller corrections in the same commit:

- **The `--all` view fetched mergeability from the list endpoint**, which does
  not compute it — so every conflicted branch read as clean, and the same PR
  reported `DIRTY` alone and `RED` in the table. It now fetches the detail and
  treats GitHub's _uncomputed_ answer as uncomputed rather than as fine.
- **`AGENT-PLAYBOOK.md`** now leads with the working command and carries a
  table of the two routes that lie. Its closing "ask the API" block gave three
  bare `gh` commands two paragraphs after saying `gh` does not exist on the
  Mac; each now has its curl equivalent.

## The other red this uncovered

`Live Production E2E` had failed on **every** run of `main` since 2026-09-04 —
16 specs, all `ERR_CONNECTION_REFUSED at http://localhost:4178`. The job sets
`BASE_URL`; `tests/e2e/river-squeeze-interactive.spec.ts` read only
`ARENA_BASE_URL` and fell through to a localhost port nothing listens on there.

The job whose only purpose is to answer "is main green" had been answering "no"
about itself. `/sim` is a real route and serves 200 in production, so the spec
now honours `BASE_URL`: **all 6 pass against production in 14 seconds**, and
sixteen self-inflicted failures become real coverage.

Worth noting how it stayed hidden: the workflow's own issue-filing step failed
too — `error fetching labels: GraphQL: Resource not accessible by integration`.
CLAUDE.md 10.83 exactly.

## The law

`tests/a-check-status-probe-cannot-say-pending-when-it-cannot-tell.law.test.ts`
pins each rung of the ladder: the tool exists, it reads `/actions/runs`, it
never _fetches_ either bad route (naming them in prose is fine — the header has
to explain why they are poison), UNKNOWN never shares an exit code with RUNNING
or GREEN, non-200s are not coerced to empty, and the playbook still names the
tool and both traps.

Verified in both directions: green clean, red against a planted offender, green
again once removed.
