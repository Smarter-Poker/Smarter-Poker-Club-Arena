# The Provisional Payout Ladder Follows The Field

Dan, 2026-10-21, with a screenshot of the live 2K GTD Midweek Bounty
(98f66ce1) in late registration showing 16 paid places and "8.7% Of The Field
Paid": "ADJUST THIS LIVE TOURNAMENT TO PAY OUT 12.5% OF THE FIELD. FIX THIS AND
ADJUST THE PAYOUTS IN THIS LIVE TOURNAMENT NOW PLEASE."

## Cause

The event's paid depth was already 12.5% (`payout_depth_percent`), and
`fn_finalize_tournament_entry_pool_locked` rebuilds the ladder from the final
field at that depth when late registration closes. But `payout_structure` was
written once at launch for the field that existed then (about 128 entries, 16
places) and never followed late registration. Every surface (Rewards, lobby,
overview, ranking) read that stale ladder. Eight live events were affected.

## Fix (migration 20261022020721, live 02:07 UTC)

- `fn_ca_provisional_payout_structure(id)` derives
  `fn_ca_payout_structure(current field, paid depth)` for an unfinalized MTT.
- Statement triggers on `tournament_players` (insert and delete) refresh it in
  the same transaction as every entry and removal. A refresh can never fail an
  entry.
- `fn_guard_managed_game_lifecycle` admits exactly that derived ladder for an
  unfinalized pool, and nothing else.
- The 12.5% depth guard `ca_mtt_payout_depth_guard` was undeclared on a money
  table and paging; it was reviewed and declared.

## Result

Midweek Bounty: 25 places for 198 entries. Its twin: 25 for 197. Prime Time
Free Buy: 51 for 405 and 50 for 395. Wednesday PLO Stack: 19 for 150 and 19 for
145. Wednesday Feature: 12 for 94 and 12 for 95. Events whose late registration
closed earlier tonight (Nightly 10K, Prime Time Main Event, Dinner Break PLO)
finalized their ladders at 10% and are already paying places against them, so
they were left as committed.
