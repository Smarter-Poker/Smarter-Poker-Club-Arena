# 2026-09-10 - A refused chair does not fail the launch

Follow-up to `2026-09-09-a-legacy-horse-id-is-still-a-player.md`. Dan: "GO AHEAD
AND FULLY BUILD, FIX AND ENHANCE ALL OF THESE."

## The launch finishes the roster

`createTablesAndSeatPlayers` threw on the first seat the database refused. The
receipt stayed incomplete, the event stayed REGISTERING, and everybody else sat
on felt that never dealt - the shape of both the legacy-id stall (19 events, 881
seats) and the 13 registrants the four-table guard refused at the chair on the
morning of the 9th. The database is the seating authority and each seat is its
own transaction, so each answer is now handled on its own
(`classifySeatRefusal` in `tournamentLaunchReleaseRpc.ts`):

- `seat_taken` - that chair's inventory was stale: mark it, try the next chair;
- `table_not_assignable` - retire the table, try the next;
- `player_already_seated_elsewhere` / `player_not_registered` /
  `player_not_assignable` - seated already, or nothing on the roster: skip;
- any other refusal - the platform cannot seat him at start: released with his
  exact refund through the launch door, and the field starts without him;
- an unknown outcome - the write may have committed: left for the next pass.

Completion still proves the whole active roster is on the felt, so the launch
fails closed only when a refused registrant could not be released or an outcome
is unknown. Nothing in the engine writes a seat or a wallet row.

## The door (migration `20260909235232_a_registrant_the_launch_cannot_seat_is_released_with_an_exac`)

`fn_ca_release_unseatable_registrant_at_launch(tournament, player, launch_id,
reason)`: service-only; requires the event's incomplete launch receipt by
launch id; refuses a player who holds a live seat in the event; derives one
request id from (launch, player) so a lost response replays the same receipt;
settles through `fn_ca_unregister_tournament_player_exact`, the only writer that
may refund a registration.

That authority refuses once the clock passes `start_time`, which is exactly when
a launch runs, so it gained one more start authority, `launch_release`: when the
transaction-local `app.ca_launch_release_launch_id` names the event's incomplete
receipt, the seat-first proofs apply (no hand dealt, `started_at` unset, launch
not completed) and the unregistration receipt records `launch_release`. The edit
is made by substitution against the catalogue, asserted to match exactly once;
the receipt reader and the receipt table's check learned the value the same way.

Proved live in a rolled-back `DO` block on a 9.00 + 1.00 registrant: no receipt
-> `launch_receipt_mismatch`; a plain post-start unregister still
`tournament_started`; the release refunded 10.00 to the wallet, removed the
roster row, decremented `current_players`, wrote one refund row and a receipt
with `start_authority = launch_release`; the replay returned `replayed = true`
and paid nothing twice.

## One shape for an id, everywhere it names a player

`src/utils/uuidShape.ts` joins `server/src/lib/uuidShape.ts`. The client
services that validated ids with the RFC-4122 version nibble (AgentWalletIntent,
CashierResilience, ClubJoinService, DailyChallengeService,
TournamentUnregistrationIntent, UnionWalletRecovery) and the engine's lease and
hand-commit checks now use the shared shape. An agent can transfer chips to a
legacy-id horse again. The GTO V31 dataset-id checks are deliberately untouched:
they validate engine-minted ids, never a player.

## The terminal marker stamp

Already set-based: `fn_stamp_tournament_terminal_evidence_markers` writes one
UPDATE for every wallet row of the event. The per-row cost was the reporting
trigger, removed on the 9th. Nothing further to do.

Pinned by `server/src/tournament/aRefusedChairDoesNotFailTheLaunch.law.test.ts`
and the updated `TournamentLaunchBoundary.guard.test.ts`.
