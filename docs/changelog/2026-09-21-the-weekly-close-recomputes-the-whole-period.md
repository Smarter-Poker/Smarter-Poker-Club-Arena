# The weekly close recomputes the whole period, not the settler's page

2026-09-21. Scope: `tests/fixtures/union-weekly-basis/`. No schema change, no
migration, no engine change.

## What was reported

That round 3 of the weekly cascade, `fn_settle_accounting_rakeback_stage`,
would refuse the first real settlement on 2026-09-28 with
`routed_rakeback_player_period_missing`, because the producer could only ever
certify the players on the page the rakeback settler had just drained.

Measured in production on 2026-09-21, for Deep Stack Society
(`2a1132b9-5ba2-42e6-9f01-30a7fcffebe3`) and the week
`2026-09-21T07:00Z .. 2026-09-28T07:00Z`, with the guard's own predicate:
**154 source pairs, 77 certificates, 77 uncovered, 943.27 of uncovered
`rake_credit`.** The gap is real.

## What the producer actually does

`RakebackSettlerService` is page-scoped and does strand payees between ticks:
it passes `p_user_ids` from the drained `rake_records` page and then advances
`daemon_state.rakeback_settler.high_water_mark` past the whole page with a
strict `>`. Mid-week the certificate set is a subset of the week's payees, and
round 3 refuses that book - correctly, because an uncertified payee with
earnings is unaccounted money.

The weekly close does not settle from that subset. `fn_prepare_accounting_week`
re-runs `fn_rakeback_recompute_periods(club, from_date, to_date, **NULL**)` for
every club of the week, before any payer stage; and with a NULL user list
`fn_calculate_cash_rakeback_periods` draws its player set from
`accounting_payable_earning_sources` for the whole period
(`AND (p_user_ids IS NULL OR s.player_id=ANY(p_user_ids))`), not from any page.
The club branch of `fn_process_weekly_accounting_scope` refuses the whole week
unless that preparation succeeded, so round 3 never sees a page-scoped book.

So the producer is already period-complete at close time, in both scopes:
`fn_accounting_week_clubs` returns the club itself for a club scope, and for a
union scope returns every club with sources that week. Its one exclusion,
`x.id <> p_union_id`, lines up exactly with the guard's `is_union_house`
exemption, which `fn_accounting_earning_contract` sets true precisely when the
earning club is that coordinator's house club.

Nothing in the repository pinned any of that. A later change that made the
weekly close reuse the settler's page - an obvious-looking optimisation, since
the settler already computed one - would have reintroduced the stall silently.

## What this change adds

`tests/fixtures/union-weekly-basis/period-coverage-regression.sql`, run last on
the maintained native accounting cluster. It seeds a real raked week whose
payees straddle the drain page, including one whose 0.09 of rake credit rounds
to 0.00 of rakeback, and then:

- drains a page holding one of the two ordinary payees, and shows round 3
  refusing with `routed_rakeback_player_period_missing`;
- pins the period-complete call in `fn_prepare_accounting_week` and the NULL
  branch in `fn_calculate_cash_rakeback_periods`;
- shows a club scope preparing its own week and leaving no source pair of that
  week uncovered - the path Deep Stack Society settles through;
- replaces that NULL with the drained page as a negative control, and shows the
  close refusing its week with `weekly_calculation_receipt_not_confirmed`
  rather than paying an incomplete book;
- runs the real due coordinator at a simulated 2026-09-28T09:00Z, and asserts
  all four rounds succeed, both routed stages keep `shortfalls 0`, round 3
  routes both certified periods, every ordinary source pair holds a
  certificate, the zero-entitlement payee is certified and closed at zero, the
  retained union-house source still gets no player period, and a replay leaves
  the chip ledger, invoices, deliveries and periods byte-identical.

Mutating `fn_prepare_accounting_week` to a page-scoped recompute turns the
fixture red.

## What was not changed, and why

No money function was touched. The guard is correct and stays as it is; the
producer is already complete for the period it is given at close time; and
rewriting either of them a week before the first real settlement would have
been a change with no defect behind it. The uncovered pairs measured above are
settler lag, and the close closes them.
