# The owner switch-off answers its request id by key (2026-10-25)

`fn_cash_game_switch_off` looked for a replayed request by reading
`cash_cluster_events` for `(game_id, kind, request_id)`. The log holds about
5 million rows (4 GB) and indexes only `(game_id, at)`, so the read scanned
every event the game ever logged while holding the game's row lock. On the
Lightning pilot game 56d5d6f0 (1.3 million events) it ran past 67 s, and Apply
Merged Migration run 40147104607 (`20261024213143`, the pilot switch-off) was
refused with a statement timeout after 8.1 s; nothing committed.

Migration `20261025022742` gives the door its own request ledger,
`cash_game_switch_off_requests` (primary key `request_id`, service-only), written
in the same transaction as the switch and its unchanged audit event, and answers
a replay by that key. Same answers as before (replayed, idempotency_conflict,
already). Pinned by `tests/unit/ownerSwitchOffAnswersItsRequestByKey.test.ts`.
After it is installed, `20261024213143` is dispatched again.
