# A Proving Week Advances On Its Own Tick (2026-10-15)

## What Happened

Once the original week (union fade0000, 2026-10-05 to 2026-10-12) left stage `calculating` at 17:30 UTC it sat in stage `prepared`: round 2's 84 commission windows have to be proved before the attempt that pays the round, and round 3 has another 84 behind them. From 17:33 to 18:13 UTC the week proved 7 of 84 round 2 windows, exactly one per job 272 tick.

## Cause (Measured On Production, 18:18 UTC)

- One window (`fn_settle_accounting_commission_window`, 42,432 sources) takes 11.7 s. Resolving the book's scope takes 5.3 s. The windows were never the slow part.
- `fn_settle_accounting_commission_advance` stops starting windows 120 s after the attempt began.
- Before a union attempt reaches its windows, the tick has already spent 60 to 90 s on the scheduler eligibility scan and the standalone club's visit and about 50 s on the attempt's preparation.
- So every tick proved its first window and stopped. At one window per five-minute tick, with three ticks an hour falling in the :45 to :00 quiet period, round 2 alone needed over eight hours, while the P&L flow windows the preparation reads expire 12 hours after they were proved. The week would expire faster than it advanced.

## Fix

Migration `20261015182133_a_proving_week_advances_on_its_own_tick.sql` (installs after `20261015173123`):

- **New function `fn_accounting_window_advance_due()`.** While a weekly close is in stage `prepared` (its preparation succeeded and only window proofs stand between it and payment), a chunked tick proves that book's windows through the platform's own `fn_accounting_close_windows_pending`, oldest close first.
  - No step is started with less than 75 s of the statement left.
  - The windows inside a step stop being started 70 s before the statement ends, so every window it starts commits.
  - It writes only the window proofs (`accounting_close_partials`), exactly as an attempt writes them. The rounds re-verify them before they pay.
- **Patch to `fn_process_weekly_accounting_scope`.** The top-level chunked tick calls the window advance right after the calculating-week advance and before any scope scan. When it advanced, the tick visits no scope. When nothing is left to prove, the next tick visits the book, which pays.
  - Preimage md5 (pg_get_functiondef): `a4973812…` (the postimage of `20261015173123`). Postimage: `00993874…`.
  - `fn_accounting_close_windows_pending` itself is unchanged (guard md5 `536acae0…`).

Law: `tests/a-proving-week-advances-on-its-own-tick.law.test.ts`.
