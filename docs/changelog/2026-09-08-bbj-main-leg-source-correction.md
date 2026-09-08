# BBJ Main Leg: Source Evidence And Correction

The linked incident is ca15a882-0066-425f-94a7-2a6cf636840e. Contribution f390afc0-7cb4-432f-9ef7-9bc8a00245dc belongs to hand 7882379 (13b01044-f5bf-44bc-aa43-b851af031db2), table 8dea0f9f-6e1f-47c4-8ff5-b53a7dd941ce, club 2a1132b9-5ba2-42e6-9f01-30a7fcffebe3, pool a7a65cfc-64e8-4134-afe5-68d3c1a86348.

## What Happened

The total BBJ contribution was 0.50. Its persisted split was 0.25 main, 0.12 backup, and 0.13 promo. The source allocation was correct. Journal rows ab13105c-6ef3-4381-8cae-e061f70c93c2 and e6b81927-1f96-411e-bfe8-7e568b310809 record backup and promo. Their descriptions identify their banks. There was no main leg.

Failure 871 records the main-balance journal lock timeout (55P03), exactly 0.25, at the source contribution's timestamp, 2026-09-08 02:18:10.791319 UTC. The failure's user_id is the pool identifier for this autoledger event. Snapshot 249 covers that event, has exactly one write failure, and reports main bank movement 264.06 against journal movement 263.81, a 0.25 difference. Backup and promo are explained.

A separate workstream resolved the incident at 14:31:40 UTC as journal lag. The hand-level evidence contradicts that diagnosis. The correction preserves the complete previous incident row inside metadata rather than silently erasing the earlier explanation.

## What Changes

The one-time migration appends only the missing 0.25 main journal leg, with a unique source-derived key and the original club, table, hand, pool, and settlement. No player, table, main, backup, or promo balance is updated, and no rate changes. No player is paid or charged.

The journal's created_at retains the witnessed event time, so existing temporal accounting places the leg with its source contribution. Metadata explicitly records the actual append time, original event time, source contribution, failure, incident, original actor, and correction database role. The insertion receives the normal current journal sequence and hash through existing triggers. No original journal row is changed and no trigger is bypassed.

The migration refuses changed allocations, identity, snapshot evidence, surviving entries, another contribution leg, or a conflicting replay receipt. The incident update and appended leg are one transaction. A repeated migration verifies its receipt and writes nothing.

The root writer was already corrected in 20260908024909: journal errors rethrow and abort the enclosing chip movement. Fresh production verification found fn_ca_autoledger() hash 2ff8923b4c2d8fd3d343cf37acce0f2c with that behavior intact.

## Verification

Twenty-four isolated PostgreSQL cases passed: success and replay, eleven evidence/refusal cases, ten injected failures across ledger and incident writes, and absence of this historical incident in a new database. The complete isolated suite passed, including the existing atomicity scenarios and sixteen concurrent-workstream satellite split scenarios.

The first production application was refused by the scheduled platform freeze (55006). A subsequent read confirmed zero correction rows and the unchanged old incident reference. No freeze guard was bypassed.

Applied and read-verified as migration 20260908160032 after normal thaw. Appended leg 845feaac-9bd0-4d3e-852d-690cc5d1b1d8 has the main-bank label, a normal journal sequence and row hash, and an explicit recorded_at of 16:00:32.815419 UTC. The hand now has three BBJ entries totaling 0.50. The incident references that exact leg, is marked balanced/resolved, and retains its prior resolution. The uncommitted reservation was renamed to the database-assigned version before commit.

This closes one proven historical omission. It does not certify every incident, pool, game, or economy.
