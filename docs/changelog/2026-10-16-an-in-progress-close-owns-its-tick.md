# An In-Progress Close Owns Its Tick And Reads Its Clubs Once

Migration `20261016000241_an_in_progress_close_owns_its_tick_and_reads_its_clubs_once.sql`, held for install after `20261015182133` (PR #6995) and, when it lands, `20261015234926` (PR #7040).

## What Was Broken

The Midway Union weekly close for 2026-10-05 to 2026-10-12 (union `fade0000`, job 272, 240 s statement) proved all 84 round 2 windows by 23:12:54 UTC on 2026-10-15 and all 84 round 3 windows plus the round 3 plan by 23:28:36. Every union visit after that was cancelled with `weekly_scope_statement_budget_exhausted` (57014). No round has been paid.

## What Was Measured On Production (Read Only)

- The certified P&L boundaries are reused. Inside an attempt context (`app.weekly_accounting_chunked` and `app.accounting_close_memo` on) the two `pnl_boundary` certificates, `pnl_flows`, `pnl_touched` and `pnl_clubs` are read from `accounting_close_certificates` under generation `original-inventory-245-v1:96ac03a8...`, and `fn_union_pnl_boundary` is never called. The 102.7 s boundary and the 170 s close quality measured earlier were direct calls outside an attempt, where `fn_accounting_close_certificate` answers NULL by design. The whole evidence report took 11.6 s warm and 107 s cold inside an attempt, with every certificate hit.
- `fn_union_pnl_evidence_report` is deliberately not edited: its definition is hashed into the certificates' generation, so any edit voids every certificate the week has.
- `fn_accounting_week_clubs(union, week)` took 21 s warm and 84.6 s cold for this week (2,042,292 cash sources, 522,518 tournament fee sources) to return 2 clubs. One paying attempt calls it from preparation, the scheduler's accrual check, the cascade (3 calls) and the conservation assertion (3 calls).
- The union's visit always ran last. The 23:30 tick finished the standalone club `2a1132b9` (complete since 2026-10-12) 196 s into the 240 s statement, the 23:35 tick 125 s in. A scope whose last visit did not finish is ordered after every finished scope, so once the union was cancelled for want of time it stayed behind the club and was cancelled every tick.

## The Fix

1. `fn_accounting_week_clubs` reads a union's earning clubs set based: cash sources grouped per club, recognized tournament sources grouped per club, each club's launch cutoff asked once as before. A club is accepted exactly when the old per-row test accepted one of its rows. Measured on production: 11.6 s, the same 2 clubs.
2. Inside one union close attempt, and only while the transaction holds the week's exclusive close lock (which every source writer must share), that answer is kept for the rest of the attempt. It is read again outside an attempt, without the lock, and in the next attempt.
3. `fn_process_weekly_accounting_scope`: a book with a committed step and more to do goes first in its tick and the tick ends with it, as a calculating week and a proving week already own theirs. If that first-place visit is itself cancelled or raises, its visit record carries `in_progress_visit: true` and the book gives its place back for exactly one tick.

No money, receipt, certificate, window or round is written by the migration, and no accounting check is skipped.

## Install Order

`20261015182133` (PR #6995) first, then `20261015234926` (PR #7040) if it is being installed, then this file. Its guard requires `20261015182133` in history and accepts only #6995's postimage (`00993874...`) or #7040's postimage of it (`e4c2252d...`). Like #6995 it takes the scheduler lock with `pg_try_advisory_xact_lock`, so it must be installed while no job 272 tick is running (minute :45 to :49 UTC, before the :50 break window).

## Regression

`scripts/ci/test-in-progress-close-owns-its-tick.py` on native PostgreSQL, run by `.github/workflows/in-progress-close-owns-its-tick.yml`. It rebuilds the exact production definitions, shows the starvation on the preimage, reproduces production's derived postimage md5s, proves the new read returns the same clubs as the old one over a randomized fixture, proves the kept answer is used only under the attempt's own lock, and proves the in-progress book's ordering and its give-back rule.
