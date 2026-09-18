# tests/a-fee-whose-producer-died-can-still-be-attributed.law.test.ts

An after-the-fact tournament fee capture may relax provenance and nothing else.
`fn_capture_accounting_tournament_fee` cannot capture a fee once the transaction
that charged it has ended, so when a cutover was armed mid-flight on 2026-09-17
the estate had no authority at all for 649 live tournaments holding 2,673 such
fees, and 553 of them sat decided by the cards with their winners unpaid.
`20260918080939` adds `fn_ca_capture_tournament_fee_from_recorded_evidence`,
which applies every evidence rule the producer applies, against the same rows,
with the same largest-remainder cent arithmetic and contract scope checks. The
risk this law exists for is the next person needing one more record to go
through and relaxing an evidence check rather than a provenance one, at which
point the platform is inventing commission splits. So it pins that exactly two
rules are absent and both are about WHEN rather than WHAT: no
`created_at IS DISTINCT FROM transaction_timestamp()` and no
`charged_at < cutoff`. It pins the three conditions standing in their place (the
record must predate the cutover, hold no batch, and its event must still be
live), all twenty-one evidence refusals, the producer's advisory lock, the cent
arithmetic and conservation check, the plan's own acceptance test applied before
returning, that the body writes attribution and never touches a wallet, ledger,
treasury or obligation, that a browser role can reach neither the function nor
the audit table, that `ca_stranded_fee_reconciliations` refuses UPDATE, DELETE
and TRUNCATE, and that its `charged_at < cutover_at` CHECK stops an audit row
claiming a post-cutover charge. `20260918082420` renamed it from
`fn_ca_reconcile_stranded_tournament_fee`, which was wrong as English and
repair-shaped under CLAUDE.md 10.12; the law pins that the rename used
`ALTER ... RENAME` with `prosrc`'s md5 asserted identical on both sides, so
"only the name moved" is a fact rather than a claim, and that the rollback drops
the ability without deleting the settled money or the audit trail.
