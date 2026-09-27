# A prepared bust batch is recorded, and three frozen freerolls get their busts back

Stream `mtt-freeze` of the 2026-09-27 swarm. Read from production between
22:20 and 22:55 UTC; every number below is a row or a log line, not a guess.

## What Dan saw

The 20:57 UTC release certificate passed SPIN, SNG and cash and failed only the
MTT test: no MTT table in production had three players dealing. Eight events
held by the live engine (lease `1-95542fcc`, heartbeat fresh) had stopped
dealing with every open table holding exactly one player.

## What the rows say

`618741a5` "$100 Freeroll 12:00 PM" (341 entrants, 56 add-ons): 38 open tables,
all `waiting`, all flipped at the same instant (20:15:56 UTC), each holding ONE
live seat and all of that table's chips (55,000 = 9 x 5,000 + one 10,000
add-on, and so on). The felt holds 2,265,000 chips = 341 x 5,000 + 56 x 10,000,
conserved to the chip. The roster said 252 `playing`; 214 of those held no
seat and 0 chips. Not one `table_seats` row was created after the initial
seating at 17:04 to 17:06: in two hours and forty minutes of play the balancer
never moved a player. `ac10f59a` (37 tables, 96 seatless zero-chip `playing`
rows) and `c775d008` (35 tables, 100) have the same shape.

Every one of those seatless `playing` rows is a bust the engine already
settled: the seat reads stack 0 with `left_at` at the bust, and the player's
`tournament_knockout_candidates` row is `pending`. Recording of busts kept up
until 18:41 (618741a5), 13:43 (ac10f59a) and 14:29 (c775d008) UTC and then
recorded nothing while the tables kept dealing until 20:12, 20:27 and 16:27.
So the eliminations the manager is now trickling in are legitimate: every
stranded player has 0 chips; no player with chips is being busted.

## The mechanism, line by line

1. **The scheduler is saturated.** Prometheus at 22:44 UTC:
   `poker_tournament_elimination_scheduler_registered` 317, `queue_depth` 275,
   `slots_inflight` 4 of 4, `oldest_wait_ms` 332,966, dispatch rate 43
   sweeps/min (about 5.6 s per sweep). The live engine holds 392 RUNNING
   leases: 31 MTT, 4 satellites, 186 SNG, 171 Spin; 77 SNGs and 89 Spins hold
   a zero-chip player at this moment, so they re-arm urgent wakes every five
   seconds. A large MTT is admitted about every six minutes.

2. **One bust per admission.** `TournamentManagerEliminations.runEliminationSweep`,
   bust stage: the reads that prepare the batch (zero-stack roster, playing
   count, six chunks of knockout candidates for 213 busts, rebuy offers, the
   rebuy-decision RPC, taken places and unplaced count) spend the 5 s
   `SWEEP_WORK_BUDGET_MS`; the 2026-09-10 grace extended the deadline once and
   the loop broke after the first commit (`committedThisPass > 0`). The engine
   log for 618741a5 in the current container shows
   `Tournament.bust_mutation_grace_granted` five times in eighty minutes with
   one `Eliminated:` line each; during the idle 21:55 maintenance break it
   recorded 28 in a burst. Between 18:42 and 20:56 UTC (three engine
   generations whose logs are gone with their containers) it recorded none.

3. **Unrecorded busts hold their chairs.** `loadBalancerTables` reports every
   roster chair with no live seat as `reservedSeats`, mirroring
   `fn_move_tournament_player`'s "tournament move destination roster is
   occupied" refusal. With 213 such rows every empty chair at every table is
   reserved, `TableBalancer.breakTable` places nobody, `checkTableBalance`
   plans nothing, every table drains to its last player, and a table of one
   cannot deal.

4. **The parks it did request are stuck on the same busts.** While a chair
   was briefly free the balancer parked five tables of 618741a5
   (`f06_operations` `park_requested`, revision 0, no custody, 19:52 to 20:43
   UTC). Their readmission goes through `startParkedMovementEngine` ->
   `fn_f06_admit_parked_movement` -> `smarter_private.f06_movement_prior`,
   which requires every player the source's last hand left at 0 chips to be
   `status='eliminated'` and refuses `F06_MOVEMENT_ELIMINATION_UNPROVEN`
   (probed 22:38 UTC in a rolled-back DO block). The engine threw the bare
   label `f06_movement_admission_unproven` and retried every fifteen seconds
   (1,089 refusals per 20 minutes fleet-wide), so the reason was never in a
   log.

## What changed

- `server/src/tournament/TournamentManagerBase.ts`: the one-finish grace
  (`SWEEP_MUTATION_GRACE_MS`, `grantEliminationMutationGrace`) is replaced by
  a batch window. `eliminationMutationAllowed()` honours
  `eliminationMutationBatchOpen`; `openEliminationMutationBatch` /
  `closeEliminationMutationBatch` / `eliminationMutationBatchIsOpen` are the
  only way to set it. The work budget and `SWEEP_MUTATION_BATCH_SIZE` (20)
  are unchanged.
- `server/src/tournament/TournamentManagerEliminations.ts`: the bust
  assignment pass opens the window, records its whole prepared batch in a
  `try`, closes the window in `finally`, and only then asks the clock whether
  to yield. A pass that ran past the budget reports
  `Tournament.bust_batch_recorded_past_budget` once. Manager stop, the abort
  signal and a refusal from the door end the pass exactly as before.
- `server/src/tournament/TournamentManager.ts`: `startParkedMovementEngine`
  throws `f06_movement_admission_unproven [<code>]: <message>` so the door's
  refusal is in the log (CLAUDE.md 10.86 rule 1).
- `supabase/migrations/20260927225423_the_pending_busts_of_three_frozen_freerolls_are_recorded_thr.sql`
  settles the damage already done: for 618741a5, ac10f59a and c775d008 it
  records every pending bust through the platform's own door,
  `fn_eliminate_tournament_player_atomic`, exactly as the sweep would (latest
  knockout generation, hand order, the sweep's ladder seed walking down over
  taken places, prize 0), and refuses to price any place inside the paid
  structure. No chip, wallet or ledger row is written. Proven first in three
  rolled-back probes (psql, one DO block each ending in RAISE EXCEPTION,
  22:51 to 22:54 UTC): 212 / 96 / 99 busts accepted at places 248..37,
  133..38 and 137..39, zero refusals, live chips 2,265,000 / 1,735,000 /
  977,000 unchanged, `chip_ledger` rows unchanged, 11.8 / 4.8 / 5.0 s. The
  migration asserts the same at apply time and aborts whole on any
  difference. Once it is applied, the chairs are free and the balancer can
  consolidate with the engine that is running now.

## Tests

- `server/src/tournament/TheBatchTheSweepPreparedIsTheBatchItRecords.test.ts`:
  a transport whose five preparatory reads outrun the budget; the pass records
  all three prepared busts in ladder order and says so once; the window is
  closed afterwards and the clock refuses again; stop, abort and a door
  refusal still end the pass at once.
- `tests/the-batch-the-sweep-prepared-is-the-batch-it-records.law.test.ts`
  (replaces `a-sweep-that-cannot-afford-its-first-mutation`, whose "yield after
  one commit" rule this supersedes), registered in `docs/laws.d/`.

## Not fixed here, stated plainly

- The scheduler saturation itself (317 managers on four slots, 5.6 s per
  sweep) is the reason a large MTT is admitted every six minutes; it is not
  changed by this PR. Consolidation of a 38-lone-table field still proceeds
  at about one table break per admission, so the three big events will take
  hours to consolidate even after their chairs are freed.
- The 45 events whose leases are held by the dead instance `1-2fe24354`
  belong to PR #5477 and were not touched.
- Merged migration `20260927163617` (PR #5452) was NOT applied when read:
  production `fn_f06_continue_no_start_last_table` still carries the pre-image
  md5 `88273d46745a000fc1b7b006427b8d89`. That is the
  `F06_CONTINUATION_EXACT_PREMANIFEST_PARK` log class. `20260927164653` is
  not applied either.
