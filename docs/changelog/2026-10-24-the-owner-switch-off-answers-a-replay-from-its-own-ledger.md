# The owner switch-off answers a replay from its own ledger

Date: 2026-10-24 (America/Chicago; 2026-10-25 UTC)
Migration: `supabase/migrations/20261025025922_the_owner_switch_off_answers_a_replay_from_its_own_ledger.sql`
Supersedes: `20261024213143_lightning_pilot_games_switch_off_so_the_horses_stand_up.sql` (PR #7939, never installed)

## What failed

`20261024213143` was meant to switch off the two old pilot Lightning games
(`56d5d6f0` NLH 0.01/0.02 and `681eb9e8` NLH 0.02/0.04) through the owner's
door so their seated horses stand up through the ordinary cash-out. The
installer refused it twice (apply-merged-migration runs 40147104607 and
40149074985), each after about 8.1 s:

```
ERROR 57014: canceling statement due to statement timeout
SQL statement "SELECT * FROM public.cash_cluster_events e
  WHERE e.game_id = p_game_id AND e.kind = 'game_switched_off_by_owner'
    AND e.request_id = p_request_id LIMIT 1"
PL/pgSQL function fn_cash_game_switch_off(uuid,uuid,text) line 31
```

Nothing committed either time.

## Root cause

`fn_cash_game_switch_off` (20261017144031) looked up a replayed request by
reading the cluster event log: `game_id` through `cash_cluster_events_by_game`
`(game_id, at DESC)`, then `kind` and `request_id` checked row by row. The log
is 4 GB and about 5.0 M rows. Read-only `EXPLAIN (ANALYZE, BUFFERS)` on game
`56d5d6f0`: the index returned 1,199,527 rows, 71,919 heap blocks were read,
and the lookup took 41,788 ms to find nothing.

The cause is the door, not the pilot migration. `authenticated` runs with an
8 s `statement_timeout`, so the owner's own switch-off from the app failed the
same way for any busy game, while holding that game's row `FOR UPDATE`.

An index on `(game_id, request_id)` was ruled out. Building it reads the whole
4 GB heap under a SHARE lock on a table the cluster tick writes about 1,800
rows a minute into, so it cannot fit any install budget and it would stall the
controller.

## Fix

- New table `cash_game_switch_off_requests`, keyed `(game_id, request_id)`,
  the same key the old lookup used. The door writes one row in the same
  transaction as its `game_switched_off_by_owner` event and answers a replay
  from it by primary key. The rules stay the same: the same request gets the
  same answer, and a reused id with a different actor or reason gets
  `idempotency_conflict`. The table has no foreign keys (CLAUDE.md section 2,
  rule 7), RLS is on, and only service_role is granted access.
- Backfill: a full read of the log found exactly three switch-offs (events
  621709, 1170409 and 1170410). They are copied by primary key and asserted. A
  catch-up reads only games disabled since 2026-10-25 02:00 UTC, and only
  their events since then (2.5 ms, 0 rows, when probed).
- The door is replaced with a full `CREATE OR REPLACE`, guarded by the
  pre-image md5 `805ef1821e0aa2e2f580a35cb290283a` and the post-image md5
  `3322d26f75e4f187a30cd15f398f1715`. Native PostgreSQL 16 reproduces
  production's pre-image md5 byte for byte.
- In the same transaction, both pilot games are then switched off through the
  fixed door as the club owner. The request ids and reason are the same as in
  20261024213143. The preconditions and post-asserts are unchanged. No seat
  row is deleted or edited (11.5 rule 3). The horses leave through the same
  per-seat cash-out a person would use (10.5).

## Verification

- Every other statement was probed read-only on production: precondition
  14 ms, session 1 ms, authority 9 ms, seat counts 6 ms, legacy events 9 ms,
  post-asserts 41 ms. The one slow statement is the one this file replaces.
- On native PostgreSQL 16 with a fixture, the migration applied end to end in
  36 ms and all three `@live-proof` lines came back true. The door checks
  behaved as intended: a replay was answered as a replay, a different reason
  got a conflict, the legacy replay was answered from the ledger, a new id on
  a disabled game got `already`, a fresh switch-off wrote both rows, and a
  non-owner got `not_authorized`. All 8 open seats were left untouched.
- `tests/unit/ownerSwitchOffAnswersAReplayFromItsLedger.test.ts` checks four
  things: the live door never reads `cash_cluster_events`, it writes its ledger
  row after its event, the ledger has no foreign key, and the old file is
  marked superseded.

## Still open

Table `f3d17d82` (game `56d5d6f0`) had dealt nothing since 22:38 UTC and the
engine was not hosting it. Its 5 horses stand up at the end of a hand, so they
leave only once the engine hosts that table. After install, watch whether its
seats empty and `fn_cash_cluster_tick` closes it.
