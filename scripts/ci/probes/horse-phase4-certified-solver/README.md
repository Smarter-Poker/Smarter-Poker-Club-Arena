# Phase 4 certified solver database probe

`run-pg17.sh` boots an isolated PostgreSQL 17 cluster (using a local installation
or an isolated `postgres:17` container), creates the minimum live-shape
fixture, applies every Phase 4 migration listed by the harness in production
order, and executes
transaction-rolled-back adversarial behavior probes for:

- database-owned source ingestion, compaction, holdout, evaluation, and promotion;
- post-legalization candidate execution, immutable evidence, and serialized release gates;
- open/response/all-in node semantics and full provenance;
- two-hole, rank-specific suit abstraction across flop, turn, and river;
- refusal to change that abstraction beneath any registered certified dataset;
- rejection of impossible suit-count keys for each exact board street;
- canonical JSON types for source actions and exact compact action/EV matrices;
- exact integer semantics plus canonical dataset coverage and quality gates;
- exact JSON scalar types for signed M1/M2, compactor, and source-artifact receipts;
- chart and certified-V31 per-decision solver-agreement reconciliation;
- exact target-day and balanced-context certified-V31 agreement evidence;
- V31 state/card/action/source-seal binding to the promoted immutable runtime cell;
- monotonic M1/M2 and compactor liveness receipts;
- the admin certification-status contract.

It never connects to production and never creates or moves chips.
