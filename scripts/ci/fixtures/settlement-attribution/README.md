# Settlement attribution query qualification

The baseline is the exact production definition read on September 27, 2026,
MD5 `6592ae7ce48565652dd101a85ecd8172`. It contains no user data.
The native fixture installs that definition, applies the maintained migration,
checks its catalog identity and proves that the C1 SELECT is its only change.
It executes both extracted SELECTs on actual PostgreSQL rows with independent
expected outcomes, empty input, nulls, rounding boundaries, historical rows,
and more findings than the result limit. It also qualifies rollback and drift
refusal. Other detector sections are retained byte for byte, not reimplemented.
This fixture does not exercise their unrelated incident-writing paths.

Production evidence: C1's original LIMIT selected all historical attributions
before looking up and filtering their records. The unchanged aggregate behind
a materialization boundary completed in 19.359s with parallelism disabled,
versus the scheduled detector's repeated 120s cancellations in C1. This is one
query observation, not a billing-savings estimate or the full job's live proof.
