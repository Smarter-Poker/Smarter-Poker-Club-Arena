# 2026-09-09 - A legacy horse id is still a player

Dan: "why are the club lobby tables not displaying the same numbers as how
many players are actually playing?! each club shows 300-549 active players,
but only showing a handful of cash games open and players sitting."

## What ACTIVE counts

`fn_batch_club_realtime_active_counts` counts distinct club members holding a
live `table_seats` row (`left_at IS NULL`, not away) on any open table on the
club's floor (its own tables plus the union's): cash, MTT, Spin and SNG alike.
Measured 23:00 UTC: Club JAQK 546 active = 9 at cash tables / 542 at tournament
tables; SHARK CLUB 550 = 9 / 546; Deep Stack Society 361 = 149 / 296; Midway
Union 307 = 4 / 307. The cash lobby was right. ACTIVE was counting seats in
events that never dealt a hand.

## Root cause one: the engine refused the database's own receipt

17 Midway Union and 2 Deep Stack Society MTTs were `REGISTERING` up to 24 hours
past `start_time`, launch receipt claimed and never completed, 2,138 roster rows
all `playing`, 601 distinct horses, 0 humans, 881 live seats, 3,674.00 in
buy-ins held. The engine log for every one of them:

    Tournament atomic seat assignment failed for 00000000-0000-0000-0000-000000000051:
    Tournament seat assignment returned an invalid exact receipt

`tournamentSeatAssignmentRpc.verify()` (and the launch-id check in
`TournamentManagerBase`, and five settlement/recovery receipt readers) validated
ids with `/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/`

- RFC-4122 version and variant nibbles. 62 of the 1,000 horses carry ids minted
  before the fleet used `gen_random_uuid()`: `00000000-0000-0000-0000-0000000000NN`
  and `face0000-0000-0000-0000-0000000000NN`. Postgres's uuid type has never cared.
  `fn_assign_tournament_player_seat_atomic` committed the seat and returned
  `ok:true` (probed live, rolled back); the engine read the committed receipt as
  invalid, threw `TournamentSeatAssignmentOutcomeUnknownError`, aborted the
  launch, and the event stayed `REGISTERING`. Each retry seated ~8 more horses
  and aborted on the next legacy id: "310 already seated - seating the remaining
  71", then 318/63, then 326/55. The strict regex entered the launch path in
  adf1a2c35 (#3733, 2026-09-08 14:30) and the seat verifier in 6debd44ec (#3716,
  2026-09-09 20:10). Every failure on a real v4 id in the log was a transient
  lock timeout.

Fix: one shape, the database's shape - `server/src/lib/uuidShape.ts`
(`UUID_SHAPE`, `isUuidShape`, `uuidShape`) - used by the seat RPC verifiers,
the launch-id check, the completion/spin/satellite settlement receipts,
played-Spin launch recovery and tournament recovery. Pinned by
`server/src/tournament/aLegacyHorseIdIsStillAPlayer.law.test.ts`: the legacy
ids pass, garbage still fails, a committed seat for a legacy horse is an exact
receipt, and no file under `server/src/tournament/` may carry a version-nibble
regex again. The GTO V31 dataset-id checks and the lease-generation checks are
deliberately untouched: those validate engine-minted v4 ids, never a player.

## Root cause two: R3 did not know the refund authority had moved

Settling the damage meant `atomic_cancel_tournament`, the platform's own
idempotent cancellation path. Probed on a paid event it was refused:

    R3: a refund credit of 1.00 was written outside fn_settle_tournament_obligation
    (money_path=<none>, app=mgmt-api, role=postgres, ...)

`20260909165629_satellite_settlement_has_one_atomic_authority` (applied 16:56
UTC) moved every refund out of `fn_settle_tournament_obligation` (it now answers
`exact_refund_authority_required`) and into `fn_settle_tournament_refund_exact`,
which stamps `app.ca_exact_refund_token` around its one `wallet_transactions`
insert and never sets `app.money_path`. R3 (`fn_ca_money_path_log`, mode
`refuse` since 2026-09-03) still admitted only the two old path names. Since
16:56 no paid tournament on the platform could be cancelled and refunded; one
cancellation had been recorded in the 24 hours before.

Fix (`20260909232326_the_exact_refund_authority_is_a_money_path_r3_recognises`):
R3 admits a refund credit when `app.ca_exact_refund_token` names a
`tournament_refund_authorizations` row for the same tournament, player and
amount - the row the exact authority books before its insert and the escrow
trigger consumes after it. A GUC with no row is not an authority. No mode flip.

## Root cause three: a marker stamp rebuilt a whole day of reporting, per row

The same probe then timed out inside `atomic_cancel_tournament`'s own 120 s:
`ca_reporting_wallet_change` fired `AFTER UPDATE FOR EACH ROW` on
`wallet_transactions` for ANY update and rebuilt every Club Data rollup for the
row's day (`ca_refresh_reporting_rollups`, 5.5 s for today, measured). The
journal is append-only, so the only UPDATE it ever sees is the terminal marker
stamp (`fn_stamp_tournament_terminal_evidence_markers` sets `terminal_closed_at`
on every wallet row of an event) - 24 entrants = 24 rebuilds of one day under
the terminal-settlement advisory lock every tournament seat and settlement
waits on. The same stamp runs on every completion.

Fix (`20260909232821_a_marker_stamp_does_not_rebuild_a_days_reporting`): the
trigger fires on DELETE and on `UPDATE OF` the seven fact columns a rollup
reads, and the function returns early when none of those values changed. The
paid cancellation probe went from a timeout past 120 s to 3.2 s.

## The settlement (CLAUDE.md 10.9)

All five clear-path conditions held: read from rows, the platform's own
idempotent path, nothing taken back, proved in a rolled-back `DO` block first
(17 events, 3,674.00, 900 seats, 244 tables, 0 live seats left), and the
paragraph is this one. Seventeen events - every MTT `REGISTERING` more than an
hour past start with a claimed, incomplete launch receipt - were cancelled
through `atomic_cancel_tournament` as the engine role, one transaction each
(never one long transaction: it holds the terminal-settlement lock), 23:31-23:35
UTC. 17 `tournament_cancellation_receipts` rows: 3,674.00 refunded across 413
registrations to the horses who paid it (the 10 freerolls refunded 0), 900 seats
released, 244 tables closed, 0 live seats left on any of them. Nobody human was
registered in any of them. Club cards immediately after: JAQK 546 -> 291,
SHARK 550 -> 294, Midway 307 -> 156; the remainder are seats in events that are
actually running.

Cancelled: 3e0215ad $100 Freeroll 6:00 PM (Sep 8), d4a4fa45 Turbo Tuesday
Opener, 70d6a974 Midnight Bounty, a0b49084 Prime Time Free Buy, 3eac8ef4 Sunday
Deep Stack Satellite $5, 555623bb Tuesday Bounty Hunt, 5efc2ddf Turbo Tuesday
PKO, 84081fcf Early Bird Freeroll, 18284b90 Midnight Free Buy, bf839f90 $100
Freeroll 12:00 AM, 645c6c4e Morning Grinder, e4d3ace8 Midweek Five-Card
Graveyard, a575a441 $100 Freeroll 6:00 AM, c7f5adac Lunch Rush, 0dc15580 Morning
Free Buy, 46a4c6a8 Wednesday Reload (Midway Union); 0fac7473 Morning Free Buy
(Deep Stack Society).

Also seen and left alone: 31 tables in those events carried
`tables.current_players = 0` against 6-9 live seats. Their seats were written
between 00:23 and 06:39 UTC by the pre-#3716 seating path, which never
maintained the column; the atomic seat RPC now does. Cancellation closed them.

## Seen, not mine, and live (for Dan)

The Stage-B cutover on `agent/codex-live-realtime/stage-b-v2` (PR #3908, 312
files, open) has its DATABASE side applied to production and its ENGINE side
not on main:

- `20260909222044_paid_spin_launch_reads_owner_only_entitlements_through_one_door`
  revoked the engine's read of `tournament_refund_entitlements`; the running
  engine reads it directly - 9,930 `permission denied` in thirty minutes, every
  paid Spin standing down. `20260909233807_the_engine_on_main_can_read_the_
entitlements_it_reads` restores the read until #3908 lands. Behind it the
  next door is already shut: `projected_spin_draw_has_no_funding_proof` from
  `spin_draw_books_one_funded_rule_receipt`. Paid Spins stay down until that
  branch's engine ships.
- Seven running MTTs have leases whose `heartbeat_at` went stale (22:16-23:02
  UTC); `heartbeat_tournament_leases_v4` refuses to renew a stale generation by
  design, and the engine on main re-tries the renewal instead of re-claiming -
  600 "Lost the tournament lease ... to another engine instance" per event per
  fifty minutes, "failed to stop 1 table engine(s)" each time, tables still
  dealing. Root cause three above is the likeliest reason the heartbeats were
  missed in the first place.
