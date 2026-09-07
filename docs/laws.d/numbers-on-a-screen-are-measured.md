# tests/numbers-on-a-screen-are-measured.law.test.ts

Four figures shown to players and operators were not measurements. The admin
dashboard's "Total Rake" was `0.05 * hands_played` - a constant times a hand
count, rounded to two decimals so it read as computed, while `rake_records`
(1.68M rows, 4.79M chips) was never queried; "Total Hands" and "Active
Players" were reduced in the browser from an unordered `.limit(5000)` against
a 5,919-row table, so they could differ between two refreshes a second apart.
Diamond activity on the player's own VIP page AND the admin VIP feed both read
`diamond_ledger`, a table with zero rows and no writer; the live ledger is
`diamond_transactions`, and `transaction_type` is NULL on ~774 of its rows so
`type` must be read beside it or every Welcome Bonus renders as a blank
adjustment. All five metrics now come from one admin-gated SECURITY DEFINER
aggregate, `fn_admin_platform_aggregates`, and horses count where players
count: the live-seat figure carries no `is_horse`/`horse_id` filter, and
friend suggestions no longer exclude horses under a comment reasoning that
they "are not people" - the same assumption that cost 39 tournaments their
rake attribution on 2026-08-27. The law pins the table names, the absence of
the fabricated formula and the truncated slice, that a failed aggregate throws
rather than rendering zeros, and that the horse filters stay gone.
