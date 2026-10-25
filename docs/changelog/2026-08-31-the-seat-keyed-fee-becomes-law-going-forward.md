# 2026-08-31 — the seat-keyed tournament fee becomes law, going forward only

`20260831180000_a_tournament_guard_binds_every_writer_not_just_the_rpc.sql`
enforced the two tournament rules with zero live casualties and wrote the third
down with its count: "buy_in_fee off the seats rule: 9,357 rows ... Recorded
for Dan with the count."

Dan's ruling: **guard forward, do not rewrite history, no chips move.**

## What shipped

`supabase/migrations/20260901110000_the_seat_keyed_fee_becomes_law_going_forward.sql`

- `trg_tournament_fee_seat_rule`, BEFORE INSERT OR UPDATE OF
  `buy_in_amount, buy_in_fee` on `public.tournaments`. It refuses any row whose
  `buy_in_fee` is not `floor(total * seat_rate * 100) / 100`, where `seat_rate`
  is 0 for a Spin (either column), 0.05 for 1-2 seats, 0.10 otherwise — the
  ladder `rakeRateFor` uses in `src/utils/buyIn.ts`. The message names the
  seats, the rate, the total and the fee it expected.
- The rate and the fee are their own IMMUTABLE helpers
  (`fn_tournament_seat_rake_rate`, `fn_tournament_expected_fee`) so the guard
  and the alarm cannot disagree, and the cutover instant is a third
  (`fn_tournament_fee_rule_cutover`) so there is exactly one copy of the date.
- `fn_tournament_fee_violations` / `fn_tournament_fee_law_check`: a read-only
  drift alarm in the shape of `the_rake_law_gets_an_alarm`, filing each finding
  into `ledger_reconcile_log` as `tournament_fee_law`, `critical`, once per
  tournament. Scheduled `tournament-fee-law-hourly` at `:25`.
- `ledger_reconcile_log_entity_type_check` re-stated with the new value.

## Why the date gate

`fn_enforce_whole_dollar_buyin` is still on this table and an UPDATE re-checks
the whole row. That is the 2026-08-21 incident: a NOT VALID CHECK still fires
on every UPDATE, 9,814 legacy rows went read-only, level clocks stopped
persisting and two decided SNGs could not be flipped to COMPLETING. An ungated
fee rule would repeat it the moment any recovery path touched a legacy price.

So the gate is `created_at >= 2026-09-01T00:00:00Z` — after the newest
violating row (2026-08-25) and after this file lands.

## The history, measured and left alone

Non-spin rows (fee-bearing Spins are `tournaments_spin_no_extra_rake`'s
business and count 7,120 separately):

| rows  | what                                                  |
| ----- | ----------------------------------------------------- |
| 9,357 | `buy_in_fee` is not the derived value                 |
| 3,415 | overcharged, every one COMPLETED                      |
| 5,942 | undercharged (3,232 COMPLETED, 2,710 CANCELLED)       |
| 174   | live and upcoming rows, **zero** of them in violation |

No backfill. No refund. Nothing pays out wrong going forward.

## Do not run VALIDATE CONSTRAINT

`tournaments_heads_up_rake_within_5_pct` and `tournaments_rake_within_10_pct`
are NOT VALID on purpose; 3,299 legacy rows fail the heads-up ceiling and the
scan would abort after taking an AccessExclusiveLock on `tournaments`. Both are
ceilings anyway — a fee of 0.00 on a 100-chip MTT passes every guard the table
had before today, and 5,942 of the violations are exactly that shape.

## Not applied

The migration was written and verified but NOT applied to production by this
session, and the SQL was never executed there — the predicate above was
measured with SELECT-only queries. Whoever applies it should probe it inside a
transaction that is ROLLED BACK (CLAUDE.md 11.5), and split the DDL if the
trigger attach deadlocks against Realtime (see the file header).

## Noticed in passing, not fixed here

`fn_rake_law_check` (20260831140000) inserts `severity = 'warning'` for its
`board_not_recorded` kind. `ledger_reconcile_log_severity_check` allows only
`ok`, `warn`, `critical`, so that branch raises `23514` instead of filing a
finding. No `rake_law` row exists in the log yet, so it has not fired. It is
one word in an applied migration and belongs in its own change.

## Test

`tests/a-tournament-fee-is-keyed-on-seats.law.test.ts` — 14 pins: the trigger's
firing scope, the date gate, the SQL rate ladder against `rakeRateFor`, the
cent floor against `splitBuyIn`, the alarm's entity type and per-tournament
idempotency, the cron minute, the revoked grants, and the absence of any
`VALIDATE CONSTRAINT`, `UPDATE public.tournaments` or `DELETE FROM
public.tournaments`.
