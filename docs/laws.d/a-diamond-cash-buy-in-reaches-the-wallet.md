# tests/a-diamond-cash-buy-in-reaches-the-wallet.law.test.ts

A player buys into a Diamond cash table from the browser: `atomic_table_buyin`
runs under the player's own JWT, hands a Diamond table to
`fn_poker_diamond_buyin`, and that door's reserve (`fn_poker_diamond_reserve`)
journals the deposit and then takes the Diamonds out of the wallet. Two guards
stood in the way, and neither showed while `cash_games_enabled` was false.

The profile guard (`fn_guard_profile_privileged_columns`) admits a write to
`profiles.diamonds` only from service context or from a call stack naming a
listed money door, and the buy-in route was not listed - the list still named
`fn_arena_deposit`, the door the custody reserve replaced - so every client
buy-in answered 42501 at the wallet write. The detector
`fn_ca_diamond_unreachable_money()` could not see it, because the grant to
authenticated and the wallet write are two functions apart. The guard now names
`fn_poker_diamond_buyin`, pinned together with `atomic_table_buyin` (live session,
own account only) and the reserve (journal before balance), so it admits only the
route that was reviewed.

The arena guard (`fn_poker_guard_arena_structure`) lets a player's door move a
Diamond table's play-state counters by comparing the row without them.
`public.tables` has four stored generated columns, and a BEFORE trigger sees them
as NULL, so the buy-in's seat count read as a structural change. The generated
columns now leave both sides of the comparison, read from the catalogue by
`TG_RELID`.

The law pins both asserted substitutions (live md5, marker found once, reverse
proved), the reviewed route, the declared guard redefinitions, the final
assertions and the live proofs. Found by `tests/sql/run-diamond-concurrency.py`
(Phase 11 line 2), migration `20260930121500`.
