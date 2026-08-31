# 2026-08-31 - Rescued from #1971: the boot-time rescue was paying out LIVE tournaments

## What was stranded

PR #1971 was opened 2026-08-30 and never merged. It conflicted with main and sat
there. Triage (`scripts/ci/triage-open-prs.mjs`) put it near the top of the pile
with `money migration tests server`, and unlike most of that pile its work is
genuinely absent from main:

```
server/src/tournament/recoveryFieldGuard.ts        ABSENT on main
server/src/tournament/recoveryFieldGuard.test.ts   ABSENT on main
server/src/bootClaimRetries.test.ts                ABSENT on main
server/src/services/fleetFloorSurvivesRestarts.test.ts  ABSENT on main
```

`server/src/tournament/tournamentRecovery.ts` on main is the boot-time rescue
that credits payout-structure prizes. Nothing guarded it against running on a
tournament that is still live.

## What came across, and what deliberately did not

The branch carried TWO commits. Only ONE is rescued here.

**Taken - `58bffbed85`**, the boot-rescue field guard, the DealRateVerifier
evidence, and the fleet alarm surviving a restart loop. Cherry-picked clean onto
current main, +461/-10.

**SKIPPED - `8e2e379777`**, the satellite duplicate-ticket fix. It conflicted,
and reading the conflict showed why: **main already has this fix in a strictly
better form.** The branch pays cash whenever `awarded === false`. Main
distinguishes `held_from_this_satellite`, so a recovery re-drive of the SAME
satellite stays silent instead of paying twice, and only a winner seated by a
DIFFERENT satellite is cashed - with the back-pay migration for the four winners
across `1a6f53a4`, `acb14548` and `e3d3bd1e` who received nothing.

Resolving that conflict in the branch's favour would have REINTRODUCED a double
payment on re-drive. This is exactly the shape `Silent Revert Guard` exists to
catch, reached by hand rather than by machine: a five-day-old branch is not
automatically the newer truth about a file, and "resolve the conflict" is not a
licence to take your own side.

## Follow-up recorded, not silently dropped

Main's better satellite fix has **no test pinning it**. The branch's
`satelliteDuplicateTicket.test.ts` is a source-text pin written against the
branch's wording; run against main it fails 4 of 6 (`expected '' to match
/already held a seat/`), because it is pinning prose main no longer uses. It was
NOT shipped red - house rule 8. The pin needs rewriting for the
`held_from_this_satellite` branch and that is its own change.

## Verification

```
npx tsc --noEmit        server   exit 0
npx vitest run          server   277 files, 3108 tests, 0 failures
```
