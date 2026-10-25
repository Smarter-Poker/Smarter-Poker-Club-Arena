# tests/an-owner-switch-off-finds-its-request-by-index.law.test.ts

The owner Switch Off door looks up a prior answer to the same request in a 5M-row event log. With only the (game_id, at) index it read every event of a busy game and timed out (the Lightning pilot switch-off was refused twice). The law pins the partial (game_id, request_id) index for kind 'game_switched_off_by_owner', built concurrently before the transaction, and a transaction that only proves it valid and exact.
