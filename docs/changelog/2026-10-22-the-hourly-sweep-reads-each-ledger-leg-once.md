# The Hourly Sweep Reads Each Ledger Leg Once (2026-10-22)

Migration `20261022162545_the_hourly_sweep_reads_each_ledger_leg_once.sql`.

## What Was Wrong

pg_cron job 233 `ca-conservation-sweep-hourly` (:52) still ran 72 to 121 s an
hour after `20261022062934`. Each check was timed on production, read-only
(one `DO` block per probe, ended by `RAISE`, so nothing was kept):

| Read                                            | Time        | Why                                                                  |
| ----------------------------------------------- | ----------- | -------------------------------------------------------------------- |
| `fn_ledger_liveness` (inside the chip report)   | 4.7 s       | counted all 1.48M hands of 24 hours to learn whether there was one   |
| `fn_chip_drift_since_baseline`                  | 4.4 s       | re-summed every player wallet leg since 2026-08-26 (3.65M)           |
| `fn_unaccounted_seat_exits`                     | 10.0 s cold | 32k exits a week, one credit probe each through the heap             |
| `fn_bbj_conservation_check`                     | 9.7 s       | re-summed every BBJ leg since the epoch (7.1M) and read 1,943 later pools' legs from the heap |
| `fn_ca_payout_rows_without_money(3)`            | 16.5 s cold | 79,000 payouts each probed into the 1.2M-row claim table             |
| `fn_tournament_prize_disbursement_audit(24)`    | 2 to 8 s    | 26,000 escrow probes for an overlay only a Spin can carry            |

Every one of them answered correctly; they read far more than the answer needed,
and most of it was history that cannot change.

## What Changed

The same checks, reading less. No check was removed, no job added or
rescheduled, nothing repairs anything (CLAUDE.md 10.11, 10.12). Horses are
counted exactly as before (10.5): no filter in the migration reads `is_horse`.

1. **The sums of legs that cannot change are kept.** `chip_ledger` is
   append-only (`trg_ca_append_only`) and a leg's `created_at` is its
   transaction's start (`fn_ca_chip_ledger_enrich`), so once every transaction
   that began before an instant has ended, no leg older than it can appear.
   `fn_ca_ledger_audit_checkpoint_advance()` (first thing in
   `fn_ca_conservation_sweep`, in its own exception block) keeps, up to a
   horizon six hours back and a minute before the oldest open transaction:
   each member's net player wallet movement since the chip baseline
   (`ca_ledger_audit_member_net`), the BBJ epoch totals
   (`ca_ledger_audit_marks`), and each later pool's seeds, burns and absorbed
   opening legs (`ca_ledger_audit_bbj_pool`). The drift reader and the jackpot
   check add only the legs after the checkpoint. A checkpoint taken from a
   different baseline or epoch is ignored (the whole range is read) and rebuilt
   by the next advance.
2. **The chip report asks whether a hand was dealt** (EXISTS) and counts the
   hands only on the branch whose sentence prints the count. Same severities,
   same sentences.
3. **Payout claims are set aside by a hash** of the claims written in the
   window and the day before it; only what is left is probed against the whole
   claim table. Same rows, same order.
4. **The prize audit reads by key**: a Spin's funded overlay through
   `idx_tournament_escrow_overlay_in` (predicate = the CASE's own) and each
   tournament's prize credits by its own key.
5. **Three indexes**, built concurrently before the transaction:
   `idx_wallet_tx_credit_user_created_amount` (the seat-exit credit probe
   reads the index alone), `idx_tournament_escrow_overlay_in`, and
   `idx_ca_bbj_pool_snapshots_baseline` (1,944 opening balances among 480,000
   hourly snapshots, which the jackpot check read by sequential scans).

## Proof

`scripts/ci/test-the-hourly-sweep-reads-each-leg-once.py` loads the exact
production definitions captured 2026-10-22 (each md5 equal to production)
twice: into `public`, where the migration replaces them, and into an untouched
reference schema. After every step (installed with no checkpoint, every
liveness branch, the first advance, legs exactly at the checkpoint and after
it, a later pool joining, a second advance, the epoch and the baseline moving,
the rebuild, the sweep itself) every replaced check must return exactly what
its reference returns. It also proves the installer-only refusal, the moved
preimage refusal, the refused second install, and unchanged owners and grants.
It runs in `.github/workflows/the-hourly-sweep-reads-each-leg-once.yml` on
every pull request that touches it.
`tests/the-hourly-sweep-reads-each-leg-once.law.test.ts` pins the shapes.

## Not Changed: Job 272

`union-weekly-rakeback-close` (*/5) runs 156 to 240 s at :40 every hour. Its
:40-:44 tick enters `fn_union_settlement_cascade_due`, which runs the weekly
accounting windows (`fn_midway_weekly_horse_promo_due`,
`fn_accounting_close_windows_advance_due`) and then
`fn_process_weekly_accounting`; the scheduler only reaches the scopes (Lightning,
Midway, Deep Stack Society) about 150 s in, and its two failures today were a
statement timeout at `fn_process_weekly_accounting_scope` line 126 and a
`GET STACKED DIAGNOSTICS` error at line 264 of the same function. That is the
weekly accounting engine, owned by #7660/#7674, and is reported there rather
than changed here.
