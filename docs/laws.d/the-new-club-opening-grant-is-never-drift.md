# tests/the-new-club-opening-grant-is-never-drift.law.test.ts

The declared new-club opening grant (a posted 100,000-chip mint from
issuance_reserve or system_mint into the new club's treasury, under the key
`club-opening-grant:<club>`, with its linked ca_mint_ledger row) is never
counted by `fn_ca_mint_velocity_watch`, and the duplicate-grant exemption in
`fn_ca_quick_reconcile` (3f) and `fn_chip_integrity_report` accepts both
counterparties. The exclusion is pinned to that exact declared shape, never a
key prefix. Whatever counterparty the newest seeder declares must be one all
three detectors accept. Midway's drift lock (`fn_ca_is_midway_scope`) stays
exactly as it is.
