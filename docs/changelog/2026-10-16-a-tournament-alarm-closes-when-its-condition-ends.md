# A tournament alarm closes when its condition ends (2026-10-16)

## What was wrong

Two engine alarms had no closer: `Tournament.table_admission_failing` ("this
table cannot start") and `GameServer.tournament_dark_after_rebuild` ("this
event is dark after a rebuild"). All 147 raised since 2026-10-13 were closed
by hand, across five migrations. Until someone did that, an alarm stayed red
long after the table dealt again, so the next reader could not tell a live
stall from a finished one.

## What changed

`fn_resolve_settled_financial_alerts` (cron 354 at :04/:24/:44, cron 227 at
:18) gains class 5. It closes one of these alarms only on evidence:

- the named tournament is COMPLETED or CANCELLED; or
- for a table alarm, that table (in that tournament) committed a hand after
  the alarm was raised, or is closed; or
- for a dark-event alarm, any of the tournament's tables committed a hand
  after the alarm was raised.

A malformed id, a table from another tournament, or a still-silent table stays
open. The UPDATE repeats the full predicate. Classes 1-4 are byte-for-byte
unchanged.

Migration `20261017002943_a_tournament_alarm_closes_when_its_condition_ends`
installs only over the exact preimage (md5 `edd4397b...`) and verifies the
exact postimage (`8adc7dfe...`), plus owner, SECURITY DEFINER, search_path and
ACL. It was verified on a native Postgres against eight fixture cases. Law:
`tests/a-tournament-alarm-closes-when-its-condition-ends.law.test.ts`.
