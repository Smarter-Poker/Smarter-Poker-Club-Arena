# Phase 4 certified solver database probe

`run-pg17.sh` boots an isolated PostgreSQL cluster, creates the minimum live-shape
fixture, applies every Phase 4 migration listed by the harness in production
order, and executes
transaction-rolled-back adversarial behavior probes for:

- database-owned source ingestion, compaction, holdout, evaluation, and promotion;
- post-legalization candidate execution, immutable evidence, and serialized release gates;
- open/response/all-in node semantics and full provenance;
- per-decision solver-agreement reconciliation;
- monotonic M1/M2 and compactor liveness receipts;
- the admin certification-status contract.

It never connects to production and never creates or moves chips.
