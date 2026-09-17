# Original Union P&L boundary inventory

This fixture executes the prospective migration against the actual column contracts and existing `fn_union_week_start` definition copied from the retained full accounting catalog. It exercises native PostgreSQL triggers, transaction rollback, immutable guards, application privileges, historical reads and two real sessions. It supplies synthetic data only and does not move production chips.

The producer tests use actual current database timestamps. The historical-reader cases explicitly shift isolated fixture timestamps with the owner immutability triggers temporarily disabled, then restore those triggers before reading. This is test-data construction, not a production backfill operation or proof of an earlier live week. The negative concurrent control changes only the fixture reader to STABLE and demonstrates the stale-snapshot defect; the final reader is restored to VOLATILE.

`fn_union_pnl_inventory_as_of` returns `status=observed` for complete original inventory, `financial_basis_certified=false` in every case. The monetary consumer must validate original funding/entry/award/obligation receipts. Unallocated tournament prize pools are not player-owned chips or ICM equity. The history includes each active original participant, including zero-stack participants; there is no horse or rake filter.

The existing closed books remain Monday midnight in America/Los_Angeles through `fn_union_week_start`. This migration neither changes the Monday04:00 America/Chicago processing time nor creates a scheduler. A boundary before the original capture fence is always blocked. An excluded pre-fence terminal population that reopens cannot become complete merely because current rows now exist.

The finite standalone native script is invoked once by the existing full weekly accounting runner after its established clusters finish. Its local PostgreSQL directory and logs are retained under the supplied scratch directory for review. It is not a production execution or publishing path.
