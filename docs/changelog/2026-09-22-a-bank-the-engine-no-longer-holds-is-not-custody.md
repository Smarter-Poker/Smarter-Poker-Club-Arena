# A Bank The Engine No Longer Holds Is Not Custody

Date: 2026-09-22. `server/scripts/legacy-engine-checkpoint-guard.mjs`, one
observability key in `server/scripts/legacy-engine-checkpoint.mjs`, and tests.
The 8825 profile only: every other profile refuses exactly as before. No
migration, no engine change, no workflow change, no reserve or budget moves,
and the drain witnesses are untouched. Nothing was deployed by this commit.

## What was wrong

The legacy checkpoint's `captureEngine` modelled an 8825 engine as holding a
seat, a bank and its metadata that are created and removed together. The 8825
source does not keep them together (`git show 8825af51:...`):

- `stop()` clears every bank (`timeBankEngine.disposeAll()`,
  `ServerTableEngineBase.ts:3579`, which is `playerBanks.clear()`) and keeps
  `seatedPlayers` and `timeBankMeta`;
- a voluntary cashout (`:3679`), a seat move (`:4061`), a busted release
  (`:7508`), a sit-out eviction (`:7691`) and `tearDownDepartedSeats`
  (`ServerTableEngineSettlement.ts:3738`) remove the bank and keep the
  metadata; the only `timeBankMeta.delete` is the cash branch of
  `adoptSeatRoster` (`:4283`), for a player still in the previous roster;
- a tournament bust removes no bank at all (`ServerTableEngineDealing.ts:448`
  is cash-only) and the tournament branch of `adoptSeatRoster` returns before
  any cleanup (`:4260`), so the bank outlives the seat.

And `TournamentManagerBase` teardown stops every engine and then throws
"retained an unresolved seat-move UUID" (`:5821`) before its
`unregisterTournamentTableEngine` loop, so the stopped engines of a manager
stuck in that loop stay in the fleet map. On 2026-09-22 the live container
logged that error about 173 times in ten minutes for each of eight
tournaments; two of them (5a387a75, 615783bf) are in the checkpoint's retained
custody, and the capture walks the stopped engines of the other six.

So every checkpoint that gets past the drain witnesses refuses
`bank_metadata_without_bank` (or `bank_occupancy_mismatch`, or
`stopped_engine_retains_custody`) on shapes the live fleet cannot avoid, and
none of them can clear while 8825 runs. Run 35620115786 is the only attempt
that has got that far; it refused `bank_metadata_without_bank` at 15:43:34Z on
2026-09-21.

## What changed

Two shapes are classified instead of refused, and each is proved from rows
before anything is written:

- **Residue**: a bank, or its metadata, for a player the engine no longer
  seats. 8825's own `captureParkedTimeBanks` walks the roster only, so nothing
  here is written by the checkpoint or restored by its successor. It could
  still be custody two ways, and both are proved from rows:
  - a roster that is merely stale: no residue pair may have an open
    `table_seats` row (`left_at IS NULL`) at the residue table;
  - a cash seat move still in transit. When a move lands, the source deposits
    the carried presence and bank in the process-wide SeatMovePresence map
    (`ServerTableEngineBase.ts:4059-4061`), and the destination claims it only
    in its seat sweep, after `adoptSeatRoster`; a park, or a failed arrival
    read retried every 5 s, can come between, and a deposit is claimable for
    ten minutes (`SeatMovePresence.ts:94`, `:168`). So every open seat a
    residue player holds anywhere is read; a seat whose capture already holds
    a bank for that exact occupancy is done (the claim or a first deal made
    it, and 8825 never applies a carried bank over a live one); every other
    one is asked, through the engine's own `fn_cash_seat_move_arrivals` (the
    service role cannot read `cash_seat_move_receipts`), whether a cash seat
    move out of a residue table landed in it, and one that executed within the
    last hour refuses.
    An unseated bank whose timer is running is refused outright.
- **Disposed**: metadata for a seated player on a STOPPED engine that holds no
  bank at all. The live value was already cleared by `stop()` and no refusal
  can bring it back; the metadata is only its accounting mirror, and the
  accounting registry was already required drained. The felt must be quiet
  (no incomplete `hand_state_snapshots` row written in the last 120 s, the
  release gate's predicate) at every such table.

`proveBanksHeldNothing` runs after the capture and before the first presence
or bank write, with its reads concurrent (at most eight at a time) between one
pair of full re-verifications, so it costs one round of reads inside the
publisher's 20 s work budget. It refuses (`bank_residue_unproven`,
`stopped_disposed_banks_unproven`), naming the check and the table, on any row
it cannot rule out, any error, any body that is not a list and any page that
fills (100 players and 900 seat rows per read, 64 occupancies per arrivals
call, 200 moves and 100 tables per read). Both sets are part of each engine's
signature, so a set that moves between observations refuses as
`engine_state_changed`. The result carries `bankDisposition`: residue tables
and players, disposed tables and seats, and the 8-character prefixes of the
stopped tournaments, with no player id.

Still refused exactly as before: a stopped engine that holds any bank; a live
engine whose seated player has metadata and no bank (8825 can leave that too,
by a cashout and a re-seat at the same table before the next deal re-seeds the
bank, and it is not proved from rows here); every shape on every profile other
than 8825. The residue still counts toward the 64-entry `bank_collection_shape`
bound; since 8825 started, no table has seen more than nine departed players.

An adversarial review of the first cut found the in-transit gap (it had
accepted a mover's residue whenever the database held the seat elsewhere),
the sequential reads, and the unnamed refusals; a second review found that the
service role cannot read `cash_seat_move_receipts` (verified:
`has_table_privilege('service_role', ..., 'SELECT')` is false), so the move
check now goes through the engine's arrivals function and `cash_seat_moves`,
both readable by the engine. A swap partner, or a source engine replaced after
running its move, leaves no residue and was not caught before this change
either; that remains a known gap.

## Verification

`tests/legacyEngineCheckpointGuard.test.ts`, 27 new cases in "a bank the
engine no longer holds is proved from rows, never assumed", on the production
8825 profile with its two retained originals: no read when nothing is
residue; a cashed-out player proved departed before any write and never
written; refusal, named and with no write and no custody RPC, when the
database still seats that player there, on an unreadable answer, a non-list
body, a filled page and an unreadable row; a residue player seated elsewhere
with no move out of here accepted after the arrivals function is asked; a
mover accepted once the destination capture holds a bank for that occupancy,
refused while the destination seats it without the bank or is not in the
process at all, accepted when the move executed over an hour ago, and refused
on an unreadable or malformed arrivals answer, an unreadable move answer, a
missing move row and a move with no execution time;
a busted player's bank proved departed and never written; an unseated running
timer refused; a quarantined stopped engine proved quiet and never written;
refusal on a hand in the air and on an unreadable snapshot; a stopped engine
that holds a bank and a live seated player with metadata and no bank still
refused; residue that moves between observations refused; another profile
exactly as strict as before. The test double's `isMaintenanceStateDurable`
now follows 8825's `maintenanceDurabilityReason` (a parked bank or a seated
player's bank), which the busted case needs and every existing case matches.

Local: the guard, admission, break-window law, source-window law and transport
suites (the transport suite under Node 20, which it requires), 225 pass;
`cd server && npx tsc --noEmit` clean; `EngineLifecycleDiagnostics` and
`anAbandonedGenerationIsNotAPendingOne.law`, 69 pass.
