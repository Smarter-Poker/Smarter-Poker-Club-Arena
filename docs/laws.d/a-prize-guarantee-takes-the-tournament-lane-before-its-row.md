# tests/a-prize-guarantee-takes-the-tournament-lane-before-its-row.law.test.ts

`fn_apply_prize_guarantee` takes the tournament lane (`fn_ca_lock_settlement_lane_for_tournament`: G shared, then T(id) exclusive) as its first statement, before the overlay return and the pool finalization lock the tournaments row, so a direct RPC call can never hold that row while the deferred payer waits at COMMIT for a lane a rebuy, add-on or hand already holds; callers that already hold the lane re-enter it, and no later migration may put the row back in front of the lane.
