# 2026-10-17 - The cashier conservation read no longer grows with history

Issue #7309. Migration `20261017184739_cashier_conservation_reads_sealed_wallet_days`.

## What broke

Post-deploy run 39051205956 failed `production-cashier.spec.ts:92`. **Reconcile Now** got HTTP 500 from `rpc/fn_cashier_conservation_report`. Postgres logged `canceling statement due to statement timeout` at 17:03:18.361 UTC, the second the request failed, and `authenticated` runs with an 8 s statement timeout.

## Root cause, measured on production

The report re-added every `chip_ledger` player-wallet leg since the club's chip baseline on every call. For Club JAQK that is one cutoff (2026-08-27 01:08 UTC) and 1,069,678 legs. That CTE alone took 4,543 ms cold under `EXPLAIN ANALYZE`, and horse play adds about 180k JAQK legs a day.

Eight earlier migrations (20261011 to 20261016) each made that same full read cheaper. None stopped it growing, so the timeout was always coming back.

## The fix

A finished UTC day is summed once and never re-read raw.

- `chip_ledger` is append-only (`trg_ca_append_only`).
- Every UTC day is attested at 04:25 by `ca_ledger_day_manifests` with a SHA-256 over its rows. That hash is restated whenever authorised maintenance touches the day.
- `created_at` is always the inserting transaction's `now()`. No SQL function supplies one, and no engine or client code writes the ledger.

New objects:

- **`ca_chip_wallet_day_seals`**: one row per sealed day, with the manifest hash and row count it was sealed against.
- **`ca_chip_wallet_day_totals`**: per club, day and member, the net of that day's player-wallet legs. It covers both sides and every status, exactly the legs the report reads.
- **`fn_ca_chip_wallet_day_seal`**: runs hourly at :30 as cron job `ca-chip-wallet-day-seal`.
  - **Seals a day only when:** the day is finished; its manifest exists and attests exactly the rows the journal holds (or the day has no rows and no manifest); no client transaction that began before the day ended is still open; and there are no prepared transactions.
  - **Withdraws a seal** whose manifest changed.
  - **Re-counts** every sealed day about once a day and withdraws any that no longer matches.
  - **Writes** only its two tables, never a balance, ledger row or payout.

How the report reads each baseline cutoff:

1. The cutoff's own UTC day, raw.
2. The consecutive run of valid sealed days after it, from the totals, collapsed to one row per member.
3. Everything from the first unsealed day onward, raw.

A seal counts only while it carries its day's current manifest hash, so anything in doubt is read raw. The three parts are disjoint and cover `[cutoff, now)` exactly. Every field, guard, grant and the STABLE / SECURITY DEFINER / search_path posture are unchanged.

## Proof

**Production, read-only, Club JAQK:** sealed totals were built in temporary tables over the 50 attested days.

- Old and new per-member nets were compared for 583 members, with zero mismatches.
- Old read: 1,117 ms warm. New read: 44 ms.

**Disposable PostgreSQL (`scripts/ci/test-cashier-conservation-sealed-days-postgres.py`, CI accounting shard 2):** 67 cases, each comparing the whole report JSON against the exact installed predecessor.

- Nothing sealed.
- Every finished day sealed.
- A restated manifest (read raw at once, then resealed).
- A late row inside a sealed day (re-count withdraws it and it stays raw until attested).
- An unattested day (sealing stops there).
- Orphan, future, today, null and late cutoffs; no baselines.
- Role refusals, read-only posture.
- Under 400,000 legs, the old read scanned 802,149 ledger rows. The new one scanned 1,109: exactly the 1,108 owed raw (cutoff days plus today, per cutoff) plus one treasury row, with no spill at `work_mem=4MB`.
- The harness also certifies that `cashier-release-contract.sql` names the definition this migration installs.

**Hardening:** `tests/the-conservation-read-does-not-grow-with-history.law.test.ts` pins the following, so a later "optimisation" cannot quietly restore the unbounded read:

- Bounded ranges on both sides.
- The manifest-hash validity rule.
- The one-row-per-member collapse.
- The sealer's guards and its write set.
- The schedule's stated reason.
- The CI wiring.
