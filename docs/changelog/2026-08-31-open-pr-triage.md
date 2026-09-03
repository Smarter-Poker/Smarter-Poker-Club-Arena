# 2026-08-31 - The stuck-PR pile was never triaged, so nobody saw the money in it

## What was measured

main took **254 squash merges in 24 hours** - one every 5.7 minutes. At that
velocity a branch that does not land within the hour conflicts. 97 pull requests
were open; asking GitHub for each one's mergeability three times, with a pause
(the lazy-computation trap `agent-autopilot.yml` documents), gave:

```
97 open   ->   95 dirty   ·   1 blocked   ·   1 in flight
age        3-7 days: 81      <1 day: 13      1-3 days: 2
behind     median 1,215      max 1,501       min 11
ahead      median 1          max 11
```

84% of the pile is the 2026-08-26 swarm, each branch one commit of work now
~1,200 commits behind main.

## Why nothing resolved it

Two machines look at that pile and neither can act on it:

- `agent-autopilot.yml` correctly refuses to touch a DIRTY branch - updating a
  conflicted branch cannot succeed and only churns CI - and prints "an agent
  must resolve this". Nobody does.
- `close-superseded-prs.sh` closes a pull request only when EVERY added line
  already exists in main (`MISSING -eq 0`). On a swarm repo one stray comment
  defeats that. Its last ten runs each reported
  `closed=0 kept=100 of 100 candidates`, with 92 of the 100 verdicts reading
  "KEEP - N of N added lines are not in main".

That script's own header names the gap: _"ninety-six rows of 'resolve it hunk by
hunk' is not a task list, it is wallpaper."_ It fixed that for the superseded
case. Everything else stayed wallpaper.

## Why mass-closing would have been the wrong fix

Sampled before proposing any change to the reaper:

| PR    | What is actually in it                                                                                      |
| ----- | ----------------------------------------------------------------------------------------------------------- |
| #1105 | A claim-back **double-charge** fix: 366-line migration + 78-line test. Green. Five days old. Never shipped. |
| #962  | A bash/awk codemod script committed into the repo beside its own output.                                    |
| #971  | A 189-line deletion of `TournamentPage.tsx`, five days stale.                                               |

A sweep that treats those three alike is worse than no sweep. The reaper's
conservatism is right; the missing step was ranking.

## What this adds

`scripts/ci/triage-open-prs.mjs`. It closes nothing and changes nothing. It
reads what each open pull request CONTAINS - migration, tests, `server/`,
money-path code, net-destructive, committed build junk, docs-only - scores it,
and prints a ranked task list with the valuable work on top.

First full run: **67 RESCUE, 19 REVIEW, 7 DOCS, 2 STALE-DESTRUCTIVE,
2 INSPECT-JUNK.** Sixty-seven pull requests carrying migrations, tests and
money-path code have never reached production.

It also sidesteps the missing token scope. `checks:read` is absent from the
estate token, so `/commits/:sha/check-runs` returns 403 and nobody could see why
a pull request was stuck. `/actions/runs?head_sha=` answers the same question
and IS readable, so this needs no token change.

## Usage

```
GITHUB_TOKEN=... node scripts/ci/triage-open-prs.mjs [--json out.json] [--limit N]
```
