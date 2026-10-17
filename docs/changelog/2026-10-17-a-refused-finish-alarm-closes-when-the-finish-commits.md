# A refused finish alarm closes when the finish commits (2026-10-17)

When the engine's atomic finish is refused, it raises
`Tournament.atomic_finish_refused` or `Tournament.atomic_satellite_finish_refused`
and retries the finish. Once a retry committed, nothing closed the alarm. The
only closer (`fn_ca_tournament_finished_but_not_completed`) admits timeout and
deadlock refusals of ordinary tournaments, so rule refusals and every satellite
refusal waited for a person: 18,778 rows of the two sources to date.

On 2026-10-17 that left Satellite 10 (a4445447) open. Its refusal at 01:32 was
fixed by `20261017033733`, and it completed at 03:41 with its winner paid.

`20261017105512_a_refused_finish_alarm_closes_when_the_finish_commits` adds
class 6 to `fn_resolve_settled_financial_alerts`. A proven refusal closes once
all of these hold:

- the tournament is COMPLETED;
- its escrow is terminally closed at zero at or after the moment of the alarm;
- it has its receipt (the satellite settlement receipt for a satellite, the
  terminal receipt otherwise).

Unproven outcomes, other states, and escrow still holding chips stay open.

Measured: the preview takes 31 ms and would close exactly Satellite 10's
alarm. Verified on native Postgres against eight fixture cases. Law:
`tests/a-refused-finish-alarm-closes-when-the-finish-commits.law.test.ts`.

## The union sweep's two warnings

`20261017121603_the_union_sweep_warnings_close_on_their_evidence`:

- **Rake basis out_of_time warning.** `fn_union_integrity_sweep_all` keeps one
  open `out_of_time` warning per union for the open-week rake basis snapshot,
  and nothing closed it when a refresh landed again. It now resolves that
  union's warning beside a refresh that landed. The windowed refresh is
  catching up: 55 windows of the 2026-10-12 week are saved, through 10-16
  21:00, and job 123 has not timed out since 10-17 00:35. So the 10-16 02:35
  warning closes when the snapshot does.
- **Integrity sweep alert `cc0387d7`.** It held 739 `direct_chip_transfer`
  signals, all of them the owner's 2026-10-15 horse wallet reset: 1,903
  `club_bank_send` rows from four club banks. Its cause was fixed by
  `20261016013849`. The alert is closed on that asserted evidence.

## A merged migration that would have broken the open close now refuses instead

`20261017034258_weekly_touched_proof_reuses_tournament_and_registration_iden`
is merged but not installed. It rewrites `fn_union_pnl_evidence_report` and
moves the report's md5 pin in `original_inventory_proof_sources_match`, but
not the identical pin in `fn_accounting_union_earned_plan_advance`
(`edecfc...`, read live). Installed as written, it would turn off the two-hour
flow-window path, so the report would re-prove every flow of the week in one
statement. Its new generation would also void every certificate of the
still-open 2026-10-05 union close.

The file now refuses with `weekly_touched_earned_plan_advance_pin_not_moved`
while that pin is still in place. The admission digest in
`scripts/ci/accounting-migration-admission.mjs` moves with it. The native
fixture has no `fn_accounting_union_earned_plan_advance`, so its positive and
refusal cases are unchanged.
