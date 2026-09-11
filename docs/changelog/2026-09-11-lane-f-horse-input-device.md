# 2026-09-11 - The horse's input device releases its clocks, and the fleet pages a phone

One lane of the horse audit; the audit's own record, every other lane and the
whole defect list is `2026-09-11-the-horse-audit.md` beside this file. Two
things here.

## 1. A horse's action never released the clocks a human's does

`_handlePlayerActionInner` cancels the seat's `turn:<uid>` deadline, calls
`timeBankEngine.playerActed` when a bank was spent or armed this turn, and
`disconnectEngine.recordPlayerActed`. The horse path in `scheduleHorseAction`
called `performAction` directly and did none of it.

Measured on the live fleet, 60 minutes to 13:27 UTC, zero humans seated: 67
lines of `Time bank expiry: FSM in 'timer_running' but seat N is still current -
resolving anyway`. That line has one route: a `timebank:<uid>` deadline armed by
the auto-activation on a PREVIOUS turn of the same seat, never released, firing
20 s later while the seat is on the clock again. Each fire forced a check/fold
over the horse's real decision (`forceResolveSeat` cancels the pending think
timer first), counted a strike, and left `bank.isActive` true so the horse's
next deliberate bank burn hit `already_active` and was auto-folded at 17 s with
its answer discarded. Strikes never reset, so three orphans at one table forced
a sit-out: `engine_presence_parked` at the 14:55 park carried 12 horses SAT_OUT
`forced` and 257 horse entries with strikes. Nothing sits a horse back in.

`ServerTableEngineTurns.settleHorseSeatActed` now runs after a horse action
lands: same four calls, same order as the human path. `bankUsable` mirrors every
refusal `tryActivate` can return (`isActive`, `streetActivations`). Test:
`aHorseActionReleasesItsClocks.test.ts`. The comment in `DisconnectEngine.ts`
that claimed the call already existed is corrected.

## 2. Dan, verbatim: "I SHOULD GET PUSH NOTIFICATIONS OR TEXT IF ANYTHING INSIDE THE HORSES IS FAILING OR THEY CAN'T PLAY."

What exists: `raiseEngineAlert` -> World Hub `/api/alerts/engine` ->
`engine_alerts` + email for criticals (measured: every critical in seven days
was `notified_via = ['email']`); Alertmanager on engine-01 routes `page="sms"`
to the `pager-sms` receiver (World Hub, texts a phone through Twilio). NOTE,
corrected after this was written: there is no alertname allowlist in either
repo, and no `tests/the-pager-list-is-exactly-six.test.ts` exists in either -
the route and the World Hub endpoint both match the `page="sms"` LABEL, so a
new rule carrying it is paged without any allowlist edit. The stale comment
that claimed the pin is corrected in `infra/monitoring/alertmanager.yml`. And
`fn_raise_notification` -> `notifications` -> `push_outbox` -> the per-minute
push dispatch -> the phone, which delivers `financial_incident` pushes to the
active `ca_incident_recipients` row today.

Wired: `raiseEngineAlert({ page: true })` mirrors a critical to those recipients
through `fn_raise_notification` (once per fingerprint, never throws);
`ClubArenaFleetFloorLost` and `ClubArenaFleetSilent` ask for it. Four always-on
series count the input device failing a seated horse:
`poker_horse_turn_timeouts_total{kind}`, `poker_horse_decision_fallbacks_total`,
`poker_horse_seat_unactable_total`, `poker_horse_forced_sit_outs_total{format}`.
`ServerTableEngineBase.horsesSeated()` exists for the fleet gauge.

The rule group `horse-fleet` is MERGED into `infra/monitoring/alert-rules.yml`
(the file Prometheus already loads, so the three lists of CLAUDE.md 10.84 stay
in agreement): eleven rules, `promtool check rules` green at 68, and the four
whose series exist today evaluated against live Prometheus before merging -
all quiet on a floor reading 232 dealable tables and 1,518 horse cash actions a
minute. Five more rules are written and deliberately not shipped until the
series they read exists; they are listed in the group's header and in the audit
changelog. `ClubArenaHorseFleetLoopStopped` (DealRateVerifier, paged) covers
the one condition no rule could: the seeding loop stopping while the process
lives.
