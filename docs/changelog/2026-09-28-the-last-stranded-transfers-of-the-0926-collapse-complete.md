# The last stranded transfers of the 09-26 collapse complete (2026-09-28)

Stream `stuck-0926`. Read from production 2026-09-28 03:55 to 04:25 UTC, engine
41b91390 (instance 1-1cf7188d, up since 00:56 UTC).

## What was still frozen

RUNNING events whose last `hand_history` row is older than 2026-09-26 10:00 UTC
(the eight events started at 03:52 UTC were inside the 03:55 break and are not
counted):

| event | shape | lease | what refuses, read from rows and logs |
| --- | --- | --- | --- |
| 21f9013b Sunday Deep Stack Satellite | MTT, 5 playing | live, successor 0b4f0551 | transfer 68929fc8 admitted 09-26 09:35, never completed. Completion refuses `F06_MIXED_PRESENCE_ARRIVAL_UNPROVEN` (rolled-back probe): 2430ef3a busted in hand 14775893, 0 chips, no chair, knockout candidate pending. |
| a3a95a1b DSS Friday $5.50 NLH Turbo | MTT, 21 players | none | transfer a3967f17 never admitted. Admission refuses `F06_MIXED_ORIGINAL_DISPOSITION_REQUIRED` (two reserved originals). The stranded void refuses `F06_STRANDED_ORIGINALS_CHANGED`: its third original, hand 14775996, was ACCEPTED at 09:33:26 after the transfer was prepared. |
| 160eb0c9, 5ce1a271 5 Chip Deep Stack Spins | SPIN | none | transfers closed at 03:37:39 by `fn_f06_close_abandoned_manager_transfer` (applied 20260928033651, no file on main). The live engine still holds its discovered copy of each transfer and re-admits it every ~5 minutes: `f06_mixed_successor_custody_unproven` at mixedF06Custody.js:122, last seen 03:45+. |
| 41eb379e 5 Chip Spin PLO4 | SPIN | live | last-table park left by the abandoned-generation door; fix 20260927163617 was merged (#5452) but never applied. |
| 4e2de62d Friday Fight Night Opener | MTT, 4 tables | live | transfer completed 00:56:59. Every table fails to start: `retained_hand_submission_readback_failed: HAND_SUBMISSION_HANDOFF_STATE_CHANGED` (retention-pruned hands; the disposal-0928 class). |
| bfcfaf17 DSS Thursday $5.50 NLH Turbo | MTT, decided 09-18 | live | `fn_complete_tournament_terminal` refuses `F06_SOURCE_EXCLUDED` (probed): a pre-manifest `park_requested` op on the winner's last table. PR #5474. |

## Root causes fixed here

1. **A player who busted and holds nothing stranded a whole transfer.**
   `smarter_private.f06_mixed_adopt_presence` demanded a live chair or a
   winning move receipt for every roster player. A roster player who busted in
   the last committed hand has neither and never will. 20260928000415 made the
   one-player refusal for a player missing from the roster; this makes the same
   refusal for a roster player who holds nothing (registration at 0 chips, no
   chair of theirs live or holding a chip). Recorded on the completion receipt
   as `refused: f06_mixed_presence_holds_nothing`, with the bank and presence
   that were not carried.

2. **The stranded void demanded that no original had settled by itself.**
   `fn_f06_void_stranded_mixed_original` required the reserved set to EQUAL the
   transfer's originals. An original accepted by the origin after the transfer
   was prepared is the one legal change before admission, and the successor's
   snapshot already reads it as terminal. The void now takes a reserved SUBSET
   of the originals and requires every other original to be accepted by the
   origin generation with its exact committed hand (the snapshot's witness).
   Only the reserved hands are voided.

3. **The engine kept a discovered transfer after the database closed it.**
   `GameServer.performTournamentManagerAdmission` cached the transfer read from
   `fn_f06_find_mixed_manager_custody` and never asked again. After a refused
   admission (lease confirmed released) the discovered copy is now dropped, so
   the next attempt re-reads it. A transfer this process drained itself is
   never dropped.

Migration `20260928041447_the_last_stranded_transfers_of_the_0926_collapse_complete.sql`
installs 1 and 2 (pre-image and post-image guarded) and voids a3a95a1b's two
reserved hands once through the door (credit 0; chips, registrations and
ledger rows asserted unchanged).

## Proof (rolled back, CLAUDE.md 11.5)

One psql transaction on production, 04:23 UTC, ending in `RAISE EXCEPTION`:
both new bodies as `pg_temp` helpers, the live completion body re-pointed at
the new presence helper and run as 21f9013b's live successor, then the new
void for a3a95a1b, the snapshot, and the presence adoption it will reach.

```
21f9013b=OK receipts=6 refused=2430ef3a:f06_mixed_presence_holds_nothing
a3a95a1b void={"ok": true, "credit": 0, "outcome": "aborted_unsettled",
  "receipt_id": "5a267211-0057-2d97-f835-372325f474da", "hands_voided": 2, ...}
  snapshot_pending=[] adopt=OK n=22 refused=619d99fd:f06_mixed_presence_holds_nothing
```

A second run (04:40 UTC) carried a3a95a1b through the whole chain inside the
same rolled-back transaction: the void, then a protocol-2 lease row at the
transfer's successor generation, the LIVE `fn_f06_admit_mixed_manager_custody`,
and the completion with the new presence body:

```
snapshot_pending=[] canonical_equal=true differing_keys=-
admit=true terminal_proof=3 complete=true refused=619d99fd:f06_mixed_presence_holds_nothing
```

The live bodies refuse the same inputs: completion `F06_MIXED_PRESENCE_ARRIVAL_UNPROVEN`,
void `F06_STRANDED_ORIGINALS_CHANGED` (both probed, rolled back).

## What happens after apply

- a3a95a1b: the live engine's next admission retry finds no pending original,
  is admitted, and completes with the new presence body. No restart needed.
- 21f9013b: the live engine holds it as a recovery owner whose completion
  already failed; that continuation is re-run only by a durable manager wake or
  a new process. It completes on the next engine start.
- 160eb0c9, 5ce1a271: resume on the next engine start (the old process still
  holds the stale copy); with fix 3 a future closure is picked up in one retry.

## Not in this change

- 4e2de62d belongs to the hand-submission retention class owned by the
  disposal-0928 stream.
- bfcfaf17 is PR #5474's (see the PR comment for the review).
- 20260928033651 (`fn_f06_close_abandoned_manager_transfer`) is applied in
  production with no file on main or on any branch found.

Law: `tests/the-last-stranded-transfers-of-the-0926-collapse-complete.law.test.ts`;
engine: `server/src/tournament/MixedTournamentCustody.test.ts`.
