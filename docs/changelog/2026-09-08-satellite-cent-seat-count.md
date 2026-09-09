# Satellite seat counts use integer cents

The legacy pure award planner divided decimal chip amounts before flooring the funded seat count. Binary rounding makes 0.30 / 0.10 slightly less than three, so a fully funded seat could become remainder cash. The helper now divides integer cents after two-decimal normalization.

The production truth is the atomic database finalizer, not that helper. `TournamentManager.processSatelliteAwards` calls `fn_settle_satellite_finish_atomic`; it does not import or call `planSatelliteAwards`. The RPC freezes its plan through `fn_materialize_satellite_entitlements_locked`, pays it, records the batch, and completes the tournament in one transaction. A source law now prevents the engine from restoring a second planner.

The pure helper remains a non-settling regression oracle. Its tests cover exact multiples, one cent below and above a ticket boundary, and short fields. Guaranteed seats still form a floor, and the number of finishers still caps awards.

A rollback-only PostgreSQL 17 matrix executes the authoritative materializer body for `.30/.10`, `.29/.10`, `.31/.10`, and a short-field cap. It proves contiguous positions and exact integer-cent conservation, then asserts after `ROLLBACK` that its function, tables, and temporary columns are absent. No historical awards or balances are changed.

Separate open findings: satellite target entries still need the shared bounty/prize split, escrow and refund coverage, and complete award-plan recovery verification. The installed seat RPC already rolls back unfunded transfers and missing payout receipts; the old unpublished atomic-seat candidate must not overwrite that newer definition. F30 source delivery remains gated. The full 216-requirement audit is incomplete.
