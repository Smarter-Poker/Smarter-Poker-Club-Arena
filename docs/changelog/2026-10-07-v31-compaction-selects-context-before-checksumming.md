# V31 Compaction Selects Context Before Checksumming

Scope: the finite Phase 6 producer-to-certified-dataset compaction timeout. No player funds, engine runtime, client, source artifacts, quality thresholds or dataset identity change.

The installed `fn_gto_v31_build_cell(uuid,jsonb)` checksummed every dataset artifact in its source join twice before selecting the requested node context. The first real 196-artifact build exceeded the service statement deadline and rolled back with zero compact cells. The canonical implementation was `20260908201749_the_solver_holdout_must_change_board_ranks.sql`.

The reserved follow-up migration materializes matching nodes using all thirteen unchanged context predicates, verifies each distinct matching artifact once, and retains a local verified snapshot for topology/holdout checks, weighted live-combo aggregation and source receipts. All original authorization, building-state lock, declared coverage, rank-disjoint holdout, action-topology, payload validation and checksum gates remain intact. CREATE OR REPLACE retains the function owner; browser grants remain revoked. A two-second lock timeout and exact prior function-definition hash refuse unexpected source drift.

Regression protection: the maintained PG17 runner installs the new migration before its authentic behavior fixtures. The source law pins context-first materialization, the single checksum callsite and all three verified-snapshot consumers. The behavior fixture forges both matching M2 checksum copies with a well-formed non-sentinel hash; canonical recomputation must reject that source and refuse compaction before the original checksum is restored. The isolated 196-row selection test confirms only two matching artifacts are hashed and a counterfeit is excluded.

Rollback: restore only `fn_gto_v31_build_cell(uuid,jsonb)` from the immutable canonical original migration named above, preserving the installed owner and grants, through a separately qualified migration. Do not replay that entire historical migration, modify dataset/source rows or restart Supabase. Rollback returns the earlier performance defect and does not remove any already committed valid cells.

Delivery status is recorded by the owning Phase 6 controller separately. Source preparation and isolated qualification do not claim protected merge, installation or production compaction success.
