# Full horse verification uses the nonretired register

The bounded fleet verifier selected `ca_horse_active_roster`, the intentional
cash-admission roster. After the strongest-half cash selection that table has
500 horses, so an otherwise valid whole-fleet packet fails
`canonical_cohort_not_1000`. It cannot verify the other registered horses.

Select the authoritative `ca_horse_fleet_register` rows with `retired_at IS NULL`
instead, retaining the 1,001-row overflow bound, snapshot, time and query limits,
original accepted-hand coordinates, and exact 1,000 distinct-ID requirement.
The attestation names the actual registry and predicate and explicitly does
not infer cash eligibility. No profiles, admission, wallets or retired rows
are changed, and roster identity still does not prove accepted use or all phases.

The isolated PostgreSQL regression reproduces the failure with 1,000 registered
horses, 500 cash-admitted horses and 62 retired identities. It passes with the
corrected reader and retains the original capture, overflow and privacy controls.
