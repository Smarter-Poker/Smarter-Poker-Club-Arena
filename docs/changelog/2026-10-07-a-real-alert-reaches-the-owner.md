# A real alert reaches the owner (2026-10-07)

Launch audit: "nobody would be told if a table broke." Migration
`20261007000420_a_real_alert_reaches_the_owner`.

## What was wrong

Every Club Arena operational alert is recorded in `operational_alert_events`:
Alertmanager posts through World Hub's `/api/internal/alertmanager-page`, engine
alerts and financial incidents arrive through the source intake, and the
owner's own critical notifications are diverted there instead of to his phone
(`20260916111614`). That inbox has one reader, the Production Alerts fleet.

Measured 2026-10-06, last 48 hours:

- 1,574 rows, every one unread. No row has been read since 2026-10-01 20:02 UTC.
- 988 were the same financial alert recorded again under a mirror source
  (`financial-alerts-backfill`, `financial-alerts-updates`,
  `drift-incidents-updates`, `drift-incidents-backfill`).
- 429 were recovery notices and 370 were below critical.
- What was left was about 32 distinct critical conditions, among them a
  -494,917.55 ledger imbalance, kill storms of up to 407 table rebuilds in 15
  minutes, tables stalled for 40 minutes and tournaments that stopped dealing.

The only page that reaches a phone, "Production Alerts Has Stopped Reading"
(`20261003102610`), fires once per silence. The silence began on 10-01, so it
fired on 10-03 and never again. Alertmanager's secondary email to
`admin@smarter.poker` covers only Prometheus rules, not engine or money alerts.

## What changed

An `AFTER INSERT` trigger on the inbox pages the senior platform recipients
(`ca_incident_recipients`, today the owner) when a new firing row is one of
three kinds:

| Kind     | What it means                          | Alerts                                                                                                                       |
| -------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| dealing  | a table or tournament stopped dealing  | SLOTableHasStalled, SLOHandsAreNotBeingDealt, Engine\*Stopped/Dead/Down, MttPlayStopped, TournamentNeverStarted and siblings |
| restarts | tables destroyed and rebuilt in a loop | ClubArenaEngineKillStorm (critical), EngineRestartedOutsideTheBreak, TablesAreReloadingThemselves                            |
| money    | a money or ledger integrity failure    | critical financial incidents that passed `fn_ca_incident_notify`, guarantee shortfalls, unpaid prizes                        |

The page is an ordinary `system` notification, so the existing mirror puts it
on `push_outbox` and the existing dispatcher sends it to the phone. It is not
an owner-operational type, so it is never diverted back into the unread inbox
(the migration refuses to install if it would be). No credential, service or
job was added.

Noise is held back: warnings, recoveries, mirror copies, one-minute flickers
(`PokerTablesFrozen`) and the hourly post-break `SLOEngineAvailability` stay
in the inbox. Within a kind, a repeat waits until the kind has been quiet for
3 hours; a kind still firing 12 hours after its last page pages once more.
Each page says how many were held since the last one. Replayed against the
last 7 days, 283 real firings would have produced 36 pages (dealing 12,
restarts 15, money 9).

A repeat delivery of the same alert is an `ON CONFLICT` update, not an insert,
so it never pages. The trigger runs in its own exception block and cannot fail
the capture of an alert.

## Not changed

- The inbox and its mirror sources are unchanged; the open de-duplication work
  on them is separate.
- `SLOEngineAvailability` still fires for ten minutes after every hourly break
  because its break guard (6 minutes) is shorter than its 30-minute averaging
  window. It no longer reaches a person; fixing the rule is a monitoring change.

## Proof

`tests/a-real-alert-reaches-the-owner.law.test.ts` pins the three kinds, the
noise exclusions, the ordinary push path, the hold rule and the exception
guard. The migration's own post-check asserts the kind function's answers and
the trigger's presence.
