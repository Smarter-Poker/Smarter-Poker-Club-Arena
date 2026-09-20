# A cash accrual cutover cannot split an open union week

**2026-09-18.** Migration `20260918091617`.

## What was broken

`accounting_cash_accrual_cutover.starts_at` was armed at 2026-09-17
18:24:04.643251+00, one and eight tenths of a second after the tournament fee
cutover and by the same operation. The union accounting week runs Monday to
Monday in America/Los_Angeles, so the open week had begun at 2026-09-14
07:00:00+00. The cutover landed 83.4 hours into it.

`fn_accounting_union_earned_plan` refuses any period beginning before the
cutover with `union_earning_source_historical_week_uncertified`. The hourly
`union-integrity-sweep` asks it for the open week, so from 18:35:01 that evening
both of the sweep's money controls failed, every hour, for fourteen hours:

| control                       | error                                              |
| ----------------------------- | -------------------------------------------------- |
| `fn_union_rake_basis_refresh` | `union_earning_source_historical_week_uncertified` |
| `fn_union_enforce_stop_loss`  | `invalid_closed_pnl_evidence_period`               |

Fifteen consecutive failures. For all of that time **the union stop-loss was not
being enforced.**

## Why it matters more than the warning suggests

Both alerts are severity `warning` and neither is on anyone's pager, so a money
control stopped running and the only trace was two lines an hour in
`financial_alerts`. The condition repairs itself at 2026-09-21 07:00:00+00 when
the next week begins after the cutover. That is luck, not design: nothing would
have stopped it lasting a full week, and nothing stopped the next cutover doing
it again.

## The same disease as 20260918064540

That migration stopped the tournament _fee_ cutover being armed at an instant
that would strand a live game. This is the identical failure one table over: a
cutover armed over a period that is already open breaks the period straddling
it. The fee cutover froze 649 tournaments; the cash cutover silenced a
stop-loss. Both rows were armed seconds apart by the same operation, and neither
table checked the instant before accepting it.

Both tables have the same shape, `(singleton, starts_at)`, the same immutable
and no-truncate pair, and the same single unguarded surface: INSERT.

## What changed

`fn_ca_cash_cutover_week_split_by(timestamptz)` answers, for a proposed instant,
whether it splits a union week, which week, and how many of that week's hours it
would orphan. STABLE rather than IMMUTABLE: the arithmetic is pure, but it
resolves America/Los_Angeles, and a timezone database update can move a
boundary. A guard the planner may constant-fold across such a change is a guard
that can answer from a cache older than the rule it enforces.

`ca_cash_cutover_is_week_aligned` is a BEFORE INSERT ROW trigger refusing any
instant that splits a week. The refusal names the week, the orphaned hours and
the instant to use instead, so it says what to do rather than only saying no.

## What it does not do

It does not repair the open week. That row is immutable and correctly so, and
`fn_accounting_union_earned_plan` has no definition anywhere in
`supabase/migrations`, so teaching it to clamp a straddling period to the
cutover would make a transcription the source of record for money code that has
none in the tree. The week clears on 2026-09-21 by itself.

## Verified

Applied through the Supabase MCP and recorded. The migration proved itself
before committing: the guard is installed and enabled, the observer still
reports the installed instant splitting its week by 83.4 hours, an insert of a
mid-week instant is refused and the message read back and matched against
`would split the union week` so the proof cannot pass on a primary key
violation, and a real week boundary is reported as splitting nothing so the
guard is not simply refusing everything.
