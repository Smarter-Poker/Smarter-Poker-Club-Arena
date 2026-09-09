# 2026-09-09 — The elimination sweep could not reach the table

Dan: "GO AHEAD AND FULLY BUILD, FIX AND ENHANCE ALL OF THESE."

## What was happening

Measured on production at 00:45 UTC: **285 of 390 RUNNING tournaments had not
dealt a hand in over twenty minutes, and ZERO had completed in twelve minutes**,
on a platform that normally finishes hundreds an hour. 1,378 knockout candidates
sat `pending`, 907 of them older than two hours, while 1,252 `tournament_players`
rows read `status='playing'` with zero chips and no seat.

The engine's own detector had been saying it out loud 433 times in fifteen
minutes and nobody was reading it:

> `<name> has held seat N at 0 chips for 120s in tournament <id> and is still
'playing' - the elimination sweep is not reaching this table`

**Nobody was hurt.** Every stalled seat was a horse — zero humans in any RUNNING
tournament — `fn_unaccounted_seat_exits()` returned zero rows for all time, no
wallet went negative, no cash seat held a null or negative stack. What was lost
was a tournament's ability to **end**.

It began around 21:00-21:27 UTC, before the 22:53 database outage, which made it
worse rather than causing it. The engine restart at 00:19 re-adopted the whole
fleet (9 → 406 managers in fourteen minutes) and the stall survived it, which is
what proved this was code and not capacity.

## The four causes

### 1. The batch was taken forty lines after the RPC that caps its input

`fn_open_tournament_rebuy_decisions` refuses a candidate set larger than fifty —
`cardinality(p_user_ids)>50` raises `invalid rebuy-decision candidate set`. The
whole `busted` array was handed to it, and the `SWEEP_MUTATION_BATCH_SIZE` slice
that is supposed to bound this stage did not happen until after the decision
filter.

So a tournament that ever accumulated fifty-one simultaneous zero-chip `playing`
players raised inside the RPC, took the `decisionsErr` return, re-armed the
five-second retry, and arrived at the next sweep with the same oversized list.
Nothing in that loop eliminates anybody, so **the backlog could only grow**.
Three live tournaments held 609 stuck rows between them this way.

The batch is the bound on all the work in the stage, so it is now taken before
the first call that has an input cap. `bustedTotal` keeps the whole-field
spare-the-top-stack comparison honest.

### 2. One refused player held the queue for everyone behind him

The assignment loop aborts the pass on a refusal, and it must: a refusal can mean
the CAS missed because another generation took the place, and handing out a stale
place is how two players get paid for one finish.

But every candidate holds **zero** chips, so the chip sort is a tie and the order
was stable. The same refused player was first on every five-second sweep, for
ever, and the nineteen behind him were never attempted.

The abort stays. What changed is the order: `bustRefusalStreak` records who
refused, and they go to the back of the next pass. The entry is dropped the
moment that player is eliminated.

### 3. `multiple_pending_knockout_generations` refused permanently

The unique constraint on `tournament_knockout_candidates` is
`(tournament_id, eliminated_user_id, seat_joined_at)`, so two pending rows for
one player are two different **seat generations** — the player busted, bought
back in, took a new chair and busted again. The older generation is settled by
definition; that is what the existing `rebought` state means.

Refusing instead left the player `playing` at zero chips for ever: invisible to
the seating self-heal, which skips zero-chip entrants on purpose, and blocking
the field count from ever reaching one. 143 rows across 13 live tournaments.

Now the older generations are marked `rebought` and the newest one is the
operative knockout. Proven on live data before it shipped: the `max(seat_joined_at)`
predicate leaves **exactly one survivor for all 73 affected players, zero ties**.

### 4. A player with no seat at all read as a stale generation

`knockout_generation_is_not_current` compared the candidate's `seat_joined_at`
against `max(table_seats.joined_at)` for that player. A busted player's chair is
released immediately (Dan, 2026-08-30) and reused in place by the next occupant,
so that max is `NULL` — and `x IS DISTINCT FROM NULL` is TRUE. **Every player
whose chair was already gone was refused for ever.**

The guard is right when a current seat exists. It has nothing to compare against
when one does not, so it now only fires when there is a generation to compare.
Verified against live data: this unblocks the 13 candidates whose seat is gone
and still refuses all 89 that are genuinely on a stale generation.

## What shipped

- `server/src/tournament/TournamentManagerEliminations.ts` — causes 1 and 2.
- `server/src/tournament/TournamentManagerBase.ts` — the launch proof, below.
- `supabase/migrations/20260909005925_a_busted_player_without_a_seat_can_still_be_eliminated.sql`
  — causes 3 and 4. One transaction, one schema reload. Grants restated and
  unchanged: `postgres` + `service_role`, no browser role.
- `server/src/tournament/TheSweepReachesTheTable.test.ts` — 15 pins.
- `TournamentLaunchBoundary.guard.test.ts` — two pins moved onto the new
  mechanism in the same commit, per CLAUDE.md rule 8.

## Also fixed: a bust is not an uncredited stack

`proveTournamentLaunchSetup` demanded `chips > 0` from every roster row, and
that cannot tell the hazard it was written for — "the stacks were never
credited, do not launch a field with no money on it" — from its exact opposite.

Eight Spins sat wedged in `REGISTERING` because of it, one of them for **ten
hours**, retrying every thirty seconds: 478 refusals in half an hour, all the
same message. Every one was a 3-max Spin whose roster summed to **exactly
3 x starting_chips with one seat holding zero**, because the table had already
dealt — one of them 73 hands — before the launch was proven.

Conservation is the test that separates them. An uncredited field is short of
`roster x starting_chips`; a field that has been played still adds up to it.
Early-bird bonuses and rebuys only ever add, so the expected total is a floor.
A field where nothing was credited sums to zero and is still refused, which was
the whole point of the original check. The same rule now applies to the felt.

## Verification

- `npx tsc --noEmit` in `server/`: clean.
- `npx vitest run src/tournament/`: **114 files, 1,192 tests, 0 failures.**
- The migration was applied to production at 00:59 UTC and its effect measured
  ten minutes later: 15 candidates resolved through the new `rebought` path, 97
  eliminations in ten minutes, zero-chip `playing` rows down from 1,252 to 817.
- Both predicates were proven against live rows with read-only queries **before**
  any DDL — no probe carried DDL, and nothing was executed against a money path
  to test it (CLAUDE.md 11.5, and section 2 rule 7).

## Still open, and being worked separately

**Tournaments still are not finishing** — `completed_10m` was still 0 after the
elimination side started draining. That is a different defect with its own
evidence:

- `fn_claim_tournament_finish` returns `completed_without_certificate` whenever a
  receipt exists, the tournament reads COMPLETED, and `certified_at` is NULL.
  The **only** writer of `certified_at` is the trigger
  `zzzzzz_tournaments_financial_certificate`, which
  `20260908042600_completed_means_financially_certified.sql` creates and then
  **disables** at line 838, deferring the enable to a "Stage B" migration that
  does not exist. Live: 130,870 COMPLETED tournaments, 1,511 receipts,
  **zero certified**. `service_role` has no write grant on
  `tournament_finish_receipts`, so the engine cannot repair it.
- The RUNNING single-survivor cohort is a _different_ failure: those have no
  receipt row at all, so they never reached that branch.
- `TournamentManager.finishing_ladder_exhausted` is placing finishers at 37 and
  313 instead of 9 and 2 — standings need renumbering.

Also found and not yet owned: 47 tournaments dealt 1,564 hands while still
`REGISTERING` (that stopped at 14:53 today), and a union-law breach,
`tournament_buyin_rake_not_club_scoped`, raised at 00:20.
