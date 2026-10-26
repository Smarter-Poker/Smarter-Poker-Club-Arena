# tests/entry-close-takes-the-tournament-lane-before-its-row.law.test.ts

The two entry-close doors, `fn_close_tournament_entry_window` and `fn_close_tournament_addon_period`, take the tournament lane (`fn_ca_lock_settlement_lane_for_tournament`: G shared, then T(id) exclusive) before they lock the tournaments row, so the pay-at-finalization payer's lane request at COMMIT is re-entrant and can never deadlock with a rebuy, add-on or hand that holds T(id) and waits for that row; no later migration may put the row back in front of the lane.
