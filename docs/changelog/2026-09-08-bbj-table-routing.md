# BBJ Table Routing and Commit Receipt, 2026-09-08

The engine previously selected and cached a BBJ pool by club alone. That ignored private-table scope and split pool creation from contribution posting. A schema-cache fallback retried without club attribution, and any response without an HTTP/RPC error counted as success even when no contribution receipt was returned.

Migration 20260908051016 adds the service-only bbj_record_table_contribution entrypoint. It verifies table/club ownership, locks payment identity, preserves the destination of a prior receipt, and otherwise invokes the existing private/union/standalone pool resolver. Pool creation and bbj_record_contribution run in the same transaction. It is registered in ca_money_rpc_registry and protects deployment against changed dependency definitions.

logBBJCollection now invokes that endpoint with one stable payload across retries. It has no client pool cache, pool reads, pool creation, local split calculation, or attribution-dropping fallback. Success requires a receipt matching table, club, hand UUID, hand number, amount and blind. A lost response remains an unknown outcome until the same payment's receipt can be confirmed; the error message does not falsely claim the database banked nothing.

Validation: seven real PostgreSQL routing cases cover private club-in-union isolation, public union routing, standalone routing, replay after membership change, pool-creation rollback for two posting failures, and club mismatch. Together with the existing accounting probes, 205 database cases pass. Fourteen new engine receipt tests and 23 existing payout tests pass.

The database migration is applied. The engine change requires adoption through the canonical Hetzner CI/deployment path. This is atomic BBJ contribution posting, not yet a combined stack/rake/BBJ/insurance hand transaction. Existing payout and repair paths remain separate audit items; no watcher or reconciler was added.
