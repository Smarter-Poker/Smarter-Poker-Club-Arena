# Actual Cash Owner Composition Proof

Run `bash docs/audits/2026-09-10-union-accounting-proposal/source-authority/owner-composition/run-local.sh`.
The runner restores captured schemas into PostgreSQL 17 on a private Unix
socket without a network listener, seeds synthetic starting rows before
installing the actual trigger graph, and runs the installed accepted owner.

The verified result is 15 checks. Three observed PostgreSQL lock waits cover an
old owner paused before its envelope, activation waiting on that receipt
relation, and an already executing old owner waiting before receipt insertion.
The last-fact failure checks whole-owner stack, history, outbox, settlement,
ledger and source rollback. Exact request replay preserves original captured
terms after the real membership row is changed.

Catalog inputs contain 118 tables, 195 functions and 132 trigger definitions.
The generator preserves captured columns, defaults, generated expressions,
primary/unique/check constraints, foreign keys and indexes. All captured
function owners are postgres. The exercised owner and source API grants are
verified; this is not a browser policy or full platform audit.

`local-proof.json` records actual lock blockers and results.
`catalog-summary.json` records the dependency inventory.
Generated schema SQL is reproducible from the catalog and is not an additional
production migration. The runner removes its stopped temporary database data
and keeps the proof log directory.

The current complete cash accepted owner is exercised. Rake banking, the Union
funding bridge, full payer/Round2 outer cascade and other game variants are
explicitly outside this proof until composed.
