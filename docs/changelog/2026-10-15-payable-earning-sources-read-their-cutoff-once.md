# Payable Earning Sources Read Their Cutoff Once (2026-10-15)

## What happened

The original week of union fade0000 (2026-10-05 to 2026-10-12) could not close. Every weekly close tick (cron 272) runs with a 240 s statement timeout, and every attempt was cancelled and rolled back before it certified anything.

## Cause

`accounting_payable_earning_sources` decided whether each rake source sits inside its club's launch accounting cutoff by calling `fn_ca_launch_accounting_accepts` once per row, twice per tournament row. That helper is SECURITY DEFINER, so the planner can never inline it. Measured on 2026-10-15:

- one union day of sources: 25.1 s;
- the whole week: about 175 s;
- the scheduler's standalone scope selection: 40.4 s on every tick.

The club P&L step alone was longer than the tick.

## Fix

Migration `20261015094219_payable_earning_sources_read_their_cutoff_once.sql` adds `fn_ca_launch_accounting_club_cutoffs()`, which reads the active club cutoffs once per query (service role only). The view joins it and applies the helper's own predicate verbatim. `ca_launch_accounting_one_active` guarantees at most one active cutoff per club, so the join cannot duplicate a row; the migration asserts that index exactly, and asserts both helper bodies are unchanged.

Proved in production with self-aborting trials:

- the 2026-10-11 union day: 339,603 rows, identical sum and md5;
- the whole week in 16.5 s, with the same 2,425,384.33 the certified earned plan carries;
- with a JAQK cutoff inserted inside the trial: 4,573 rows became the same 2,176 rows on both sides, identical md5.

The view's columns, security_invoker, owner and grants are unchanged and asserted. No row, certificate or money is written. Pinned by `tests/payable-earning-sources-read-their-cutoff-once.law.test.ts`.
