# Independent PKO table qualification

Run `bash scripts/dev/probe-independent-pko-tables-pg17.sh` from the Club Arena checkout. The runner accepts no database URL, starts one private PostgreSQL 17 cluster with no TCP listener, and disposes it on exit.

The fixture uses current captured claim, collection, denomination and marker bodies. R34 is applied first. The supporting schema, lane and marker triggers are the September 11 captured mystery-phase fixture, with the additional typed columns read by the current claim. The test-only hand builder selects the participant's actual table.

The unchanged inherited `fn_settle_tournament_obligation` is explicitly a pool-bounded wallet stand-in. All rows are synthetic. This proves the actual claim/collection branches, head arithmetic, markers, pool invariants and concurrent idempotency within this bounded chip fixture. It does not qualify production wallet/escrow/provider composition, Diamond initial payouts, original entry funding, the outer knockout-generation wrapper, live cross-table execution, or historical compensation.

The two old production cutoffs are reproduced independently. The changed source passes 97 assertions: disjoint two-table claim/payment, 17 unavailable-independence shapes, actual retained claim refusals, changed head snapshot, rebuy lineage, five concurrent claim/collect sessions, exact remaining head backing and replay. Additional runner checks reject changed source for all three functions, changed predicate privileges and direct service-role access to the private predicate. Migration replay is verified.

The migration's predicate admits only proven disjoint tables and people. Shared-player dependencies and unknown heads remain open. The global watermark remains monotonic observation evidence; it cannot alone invalidate an independent table's bounty.
