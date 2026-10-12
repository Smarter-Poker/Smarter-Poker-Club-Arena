# A mystery bounty of 10 or fewer entries pays 50/30/20 (database)

Dan, 2026-10-05, verbatim:

> "MYSTERY BOUNTY OF 10 OR FEWER DON'T GET CHESTS, ITS TREATING LIKE A SINGLE TABLE TOURNAMENTS WITH 50 30 20 PAYOUT PERCENTAGES"

## Where the ladder is decided

Read on production 2026-10-05. The ladder an MTT is paid by is written by the
database, not the engine:

- `fn_finalize_tournament_entry_pool_locked` (the atomic entry close) writes
  `tournaments.payout_structure = fn_ca_payout_structure(field, percent)` and
  snapshots it into `tournament_entry_close_receipts`. The engine pays from
  the stored ladder (`server/src/tournament/payoutStructure.ts`), the client
  shows it (`RewardsTab` via `resolvePayoutStructure`), and the reprice of
  anyone who busted in late registration reads the same snapshot.
- `fn_ca_fund_overlay_on_lock` writes the provisional ladder at start with
  the same generator.

`fn_ca_payout_structure` pays the top 10% of the field, so 10 or fewer players
was one place (winner-take-all), 11-20 was 64/36.

## What changed

Migration `20261006002326_a_mystery_bounty_of_ten_or_fewer_entries_pays_fifty_thirty_t.sql`:

- In both functions, a mystery bounty with 1..10 total entries (entry rows
  plus every rebuy/re-entry, the engine's `totalEntriesFromRows` count) and at
  least 3 players is paid exactly 50/30/20. Everything else calls
  `fn_ca_payout_structure(field, percent)`, unchanged. Fewer than 3 players
  keeps the existing one-place rule. Place 3 takes the cent residual, so the
  pool is paid exactly. The rule is inline, so the migration declares no new
  object.
- Both callers changed by pinned exact substitution (preimage md5, each anchor
  exactly once, postimage md5 computed read-only on production, grants and
  owner unmoved). Events with committed payout terms keep their stored ladder;
  nothing is re-priced and no money moves.

Executed end to end on a disposable PostgreSQL 16 with stand-in callers: 6
mystery entries -> 50/30/20 at entry close and at start; 7 players + 4
re-entries (11) -> unchanged; non-mystery -> unchanged.

The no-chest half is the engine branch `claude/small-field-mystery-20261005`.
Apply outside the :50-:03 window.

`-- @live-proof:` in the migration header checks both postimage md5s.
