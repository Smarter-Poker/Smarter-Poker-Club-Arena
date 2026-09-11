# E2: native settlement in true bust order

The isolated PostgreSQL 17 rehearsal for `bee519fa-ff07-438c-9542-d386fc821908`
completed through `fn_complete_tournament_terminal`. It paid 17 recipients
304.00, closed the event and escrow, and created one terminal receipt. An
immediate repeat changed none of ten observed financial/game-state tables.
This is local accounting proof; no production write, wake, migration or release
was performed.

Run from the repository:

```sh
python3 scripts/ci/rehearse-e2-tournament-zero-toggle.py
```

The optional `--pg-bin /path/to/postgresql17/bin` selects local binaries. The
runner accepts no database URL, password or production destination. It verifies
the archive and each input, creates its own socket-only cluster under `/tmp`,
and stops that cluster on success or failure. It reports the saved receipts.
PostgreSQL 17 with pgcrypto, uuid-ossp and pg_trgm is required. No network or
production credentials are used.

## Evidence and limits

- Base source: `29b6ae08b20ca34b575d27492370d4cf5ad1bd67`. The schema donor was
  the preserved, zero-event PG17 database
  `stageb_exact_tail_20260911_090347_root`, port 53449. Only the 169 dependency
  relations were exported locally. Current scoped Supabase function definitions,
  event rows and financial controls were read on 2026-09-11; no live schema dump
  was taken. `fixture-manifest.json` seals the exact inputs.
- The runner verifies 521 current function-body hashes and 263 trigger
  definitions/states before the scenario. Current source includes the real
  elimination, ranking, obligation, credit, escrow, terminal and guard functions.
  None is replaced by a permissive stub.
- The original 155 eliminated players and 149 committed-hand witnesses were
  imported. Eleven explicitly hypothetical subsequent hands close the remaining
  twelve-player field. This models a financial finish, not future gameplay.
  The existing players' status, chips, elimination time and recording sequence
  stay unchanged. No eliminated/playing resequencing toggle is used.
- Each of the eleven modeled paid-range busts passes through the real atomic
  elimination door with a positive cached prize. These produce zero place
  obligations and zero payouts. Current live eliminated players with positive
  cached prizes also have no place obligations or payments in all seven events.
- An independent calculation checks all 167 final positions and all recipients
  and cents. Normal settlement corrects 148 historical cached positions; the
  paid historical tail is places 13 through 17. Final places 15/16/17 pay
  `631a3049-dbb7-4668-8d52-c36efdb395d5` / 7.87,
  `a0dbce6c-9df7-468c-b1ba-bfae2e31e774` / 7.48, and
  `4f0bbf2a-7a7e-43f1-bc19-c0f937419388` / 7.11.
- Payouts, paid obligations, club member credits, new chip ledger legs and new
  wallet receipts each sum to 304.00. Original chip ledger entries and payout
  evidence remain unchanged. The native terminal trigger adds closure timestamps
  to 54 existing wallet receipts; every other receipt field stays unchanged.
- Fixture restoration uses transaction-local replica mode solely to restore
  captured data and explicit hypothetical accepted-hand inputs. It returns to
  ordinary trigger execution before calling any behavior under test. All seven
  named tournament guards remain in their currently installed disabled state.
  This does not certify later all-guard activation or migration 20260911110000.
- The seven-event readback identifies `e3ef32fd` as a distinct PKO case. This
  cash-place representative does not certify that event's bounty obligations,
  awards or terminal balance. Its additional rehearsal remains required before
  its wake. The `7aa16fa7` true-bust ruling is another separate prerequisite.

## Source pins

| Function | Current body MD5 |
| --- | --- |
| fn_settle_tournament_places(uuid,uuid) | 6181734ff98555ecc04648186f6ebf24 |
| fn_normalize_tournament_final_standings(uuid) | 45b06c3f8be02940d130c427d5a32519 |
| fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric) | 9447da284f1a3beb6d51dd87151c080f |
| fn_prepare_tournament_place_obligations(uuid,text) | ca0abbc6d297f3009143676261d8cf19 |
| fn_complete_tournament_terminal(uuid,uuid,text) | 96a61ea5e16560735bcb70b355aa79ab |
| fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text) | 90f7506df2f1a94fe22952714fcd9f85 |

Archive SHA256:
`6be71661c49edd736ad78bf62582389ecce5cf06b46eb44237ff8a69833693c1`.
Input manifest SHA256:
`a368137409742577f8b5de8dfe7b3a18baa8765788709a4654d2a11821d33e4a`.

The stale wake-script predicate must be replaced only with a reviewed condition
that requires a still-unpaid event, no place obligations/batches, valid committed
bust witnesses and the current true-order settlement implementation. This proof
supports omitting historical blanket toggles; it does not authorize removing an
integrity check from an already-paid or differently governed event.
