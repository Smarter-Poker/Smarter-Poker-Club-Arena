# The Live-Table Cases Can Read The Boards The Engine Offers Them

## What Was Wrong

Post-Deploy E2E run 38656420977, 2026-10-15 00:14-00:16 UTC. The SPIN and SNG
live-table certificates reported no subject while production was dealing
thousands of SPIN and SNG hands:

```
UNKNOWN: The SPIN live-table certificate had no subject: production was running
no SPIN table this case could observe: 32 in fixture scope, 30 with 3+ dealable
seats and a hand in progress, none stalled, inside 90000ms
UNKNOWN: The SNG live-table certificate had no subject: ... 32 in fixture scope,
32 with 2+ dealable seats and a hand in progress, none stalled
NON-VERDICT: required live-table coverage is incomplete: an already-running SPIN
table stays realtime and recovers one owner; an already-running SNG table stays
realtime and recovers one owner.
```

The same two cases in run 38641820985 at 22:08 UTC reported `0 in fixture scope,
0 with 3+ dealable seats`. That earlier non-verdict was real absence. This one
was not: 30 SPIN and 32 SNG eligible boards were offered and every one was
rejected.

## Cause, Read From The Recorded Evidence

The uploaded report's own refusal attachments carry the answer. For both
formats, `boardsAlreadyEndedThisCase` is empty, `observationDeadline` is null,
`lastScopedHealth` is `ok` with 32 scoped tables, and every entry in
`lastBoardQualification` is all-null:

| Field              | Value for all 30 SPIN / 32 SNG candidates |
| ------------------ | ----------------------------------------- |
| `tournamentId`     | null                                      |
| `tournamentStatus` | null                                      |
| `currentPlayers`   | null                                      |
| `tableStatus`      | null                                      |
| `endedAt`          | null                                      |
| `classification`   | `unknown`                                 |

`tableStatus` is copied straight off the `tables` row, so an all-null row means
the row itself was never returned. The case counts its candidates with one
authority and qualifies them with another: the engine's `/health`, which has no
RLS, offers both scopes the case asks for
(`liveness_club_ids = [CLUB_ID, UNION_ID]`), while `boardFacts` qualifies each
candidate with a durable read of `public.tables`.

`public.tables` carries a RESTRICTIVE policy, `poker_arena_table_access`, which
admits a scoped table only when `fn_poker_can_read_games` passes for a club in
`fn_club_scope_ids` of that table's union. The reserved post-deploy account
joins exactly one club, the assigned Diamond club `002c2d27`, which is in no
union. Every SPIN and SNG board is hosted by the fixture union
`fade0000-0000-0000-0000-000000000001`, so `fn_poker_can_read_games` was false
for all of them and PostgREST returned an empty array with HTTP 200. Nothing
threw; the rows were filtered. `classifyBoardEnding` then returned `unknown`
and `selectableWhileRunning` dropped every candidate.

SPIN and SNG are hosted only by that union, so with one membership outside it
these two certificates could never have a subject, whatever production was
doing. SPIN was selectable until #6217 gave every tournament format the board
reader; SNG has been unreadable for as long as the account's one membership has
been outside the union.

## The Change

The live-table lane sets `E2E_UNION_CLUB_ID` to SHARK CLUB
`a41434bb-8d0c-400a-8f0d-e8b3d65afed4`, a public, no-approval chips club inside
the fixture union, and global setup joins it through the same public Join Club
door it already uses for the assigned Diamond club. One active membership there
makes `fn_poker_can_read_games` true for the union's whole scope, so the
durable read can qualify what the engine offers.

The gap is closed on the read-scope side, not the qualification side. A board
still has to prove it is running before a case will watch it, which is the fact
that separates a game that ended naturally from a table that was lost:

- `selectableWhileRunning` still requires `classifyBoardEnding() === 'running'`.
- `classifyMissingTournamentSubject` still separates stalled from absent, so a
  real freeze stays red instead of becoming a non-verdict.
- The spectator no-mutation assertion still applies; the new membership is a
  read-only spectator membership through the public player door.
- `live-table-certificate-coverage.mjs` still requires all four cases.

Only the lane that sets `E2E_UNION_CLUB_ID` takes the extra join, so no other
suite's account shape changes. `postDeployE2eHonestyLaw` now pins both the
workflow value and the setup call, so the read scope cannot drift back out of
step with the engine scope it is paired with.
