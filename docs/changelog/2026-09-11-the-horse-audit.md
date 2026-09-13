# 2026-09-11 - the horse audit: why a handful of horses were playing, and the page that says so next time

Dan: "i need you to do a full audit, enhancement and upgrade of the horse triggers. there is
only a hand full of horses playing inside the clubs right now, and something is broken or needs
to be fixed... review everything line by line, fix ANY AND ALL BUGS, GAPS, STUBS, ERRORS,
REGRESSIONS OR WIRING ISSUES ANYWHERE AND EVERYWHERE." And, while it ran: "I SHOULD GET PUSH
NOTIFICATIONS OR TEXT IF ANYTHING INSIDE THE HORSES IS FAILING OR THEY CAN'T PLAY."

Six lanes, each reading one surface line by line against the LIVE production bodies rather than
the repo's copy of them: the fleet seeding cycle, the session rotator and the bankroll layer,
Operation Stable Hand and the cluster controller, the tournament horse paths, the database's own
doors, and the horse's input device on the felt. Every number below was read from production
between 2026-09-09 20:00 and 2026-09-11 16:00 UTC and is stamped with when.

## What was actually wrong, in the order it cost seats

### 1. A migration made every seat read ambiguous, and two of them said nothing (2026-09-09)

At 17:23:50 and 17:25:29 UTC two migrations gave `table_seats` a second and third foreign key to
`tables`. PostgREST refuses an embed between two tables with more than one relationship
(PGRST201, HTTP 300), and six engine reads used the unqualified form. Every tournament start
(`creditSeatStacks`), horse registration (`horseLoadMap`), the knockout live-seat veto, the
tournament seat claim, the seating inventory, and `HorseSessionRotator`'s single read of the room
failed on every call. Measured in 90 minutes of engine log: 13,458 refusals, 5,369
`horse_load_seats_failed`, 723 `Start_failed`.

`origin/main` fixed the six embeds on 2026-09-10 and migration `20260909205508` dropped the
composite keys, so main works today **by accident**: the next foreign key anybody adds to
`table_seats` takes it down again. Every one of those reads now names
`tables!table_seats_table_id_fkey`, and the rotator's `if (error || !chunk) return;` - which
declined the pass in complete silence for three and a half hours - reports first (CLAUDE.md
10.86: "I could not tell" is an outcome with a name).

### 2. The wreckage that left: 97 tournaments that never started, holding the cash floor hostage

A tournament stuck `REGISTERING` past its start time is inside the four-game limit's
sixty-minute window for ever (`fn_concurrent_game_load`). Measured 2026-09-09: **428 of 448**
seated Midway horses were at the database's four-game limit, and 68 of the 86 idle horses that
fit an open Midway table carried four or more bookings. That is the whole of "No available
horses" on 85 tables a cycle, and it is why a fleet of 1,000 had a handful on the felt.

Two populations, both fixed at the source rather than swept up (10.12):

- **40 events dealt on 2026-09-08 that never got their RUNNING commit** (`prize_pool_finalized`
  true, `started_at` null, hands and eliminations present, 2,164.60 chips unpaid). The ramp and
  the top-up chased them every backoff: 1,796 locked seat RPCs and 1,169 locked registration
  RPCs an hour, all refused by both doors, plus 298 false "CANNOT FILL" alarms. The ramp, the
  top-up and the fill now withhold from a finalized pool and say so once. The rows themselves
  are handed back to the engine's own resume path by
  `docs/audits/2026-09-11-horse-audit/proposed-migrations/resume_the_games_dealt_on_0908_that_never_left_registering.sql`.
- **53 empty seat-first boards**: the held-empty hold outlived fillable boards 10:1 (149 of 158
  boards empty against Dan's 33/50%), and Deep Stack boards never opened with a horse at all
  (82 of 83 empty). Both fixed.

### 3. A tournament chip was counted as a cash bankroll

`horseExposure` summed `seat.stack` across every open seat on the platform, tournament tables
included, and fed it to the aggregate-exposure ceiling, which is a share of the horse's CLUB
WALLET. Tournament stacks are tournament chips: median 5,000, max 840,000, 15.6M of them against
a 1.4M-chip cash floor. Measured: **164 of 501 horses holding a tournament seat failed the
ceiling for even a 100-chip cash buy-in**, and the cycle line said `aggregate_exposure=265` every
pass. Exposure is now the cash floor's seats only; the four-game limit still counts every seat,
because the database does.

### 4. The engine gated on one wallet and the database debited another

`fn_seat_club_for_user_membership_unchecked` honours a held seat at ANY table of the union,
tournament tables included, and that held seat beats the preferred club. The engine built its
held-seat map from cash tables only. Measured with the engine's own hash reproduced in SQL:
**145 Midway horses** would have been gated, sized, tagged and mutex-judged on one wallet and
debited from the other. The scope map now reads tournament tables too, with the database's four
history statuses mirrored verbatim.

### 5. The Stable Hand's game key was the table's NAME

"X", "X Feeder" and "X Main 2" are three tables of one must-move game, and the mutex keyed its
per-game daily sit cap and its two-hour window on the name. Measured: 1,438 executed must-moves
in 90 minutes read as "seat given up" - the cycle line said `0 sit(s), 5-9 seat(s) given up`
every thirty seconds - and the sit cap applied per chair. One `gameKeyForTable` now serves the
verdict, the counter write and the seat diff: `host:cluster_id:variant:sb:bb`.

### 6. The tag book was drawn from the platform ladder, not the host's

Midway deals nothing below 0.05/0.10 and nothing above 2/5; Deep Stack deals 0.02, 0.05 and 50.
The tagger drew a horse's stakes from the platform's eleven rungs, and the seeder's
stranded-tag fallthrough asked whether the stake had a game ANYWHERE. Measured: 69 Midway cash
tags name a stake Midway deals in no variant, and **51 of 530 Midway cash-capable bodies could
not sit at any table on their own host, ever**. The tagger now reads each host's live ladder
(simulated against the 1,164 live memberships: stranded bodies 59 -> 0), and the seeder's
fallthrough is per host.

### 7. The horse's input device was losing its own clocks

`_handlePlayerActionInner` cancels the seat's deadline, releases the time bank, resets the
disconnect strikes and stamps the telemetry. The horse path calls `performAction` directly and
did **none of it**. Measured in 60 minutes: 67 "Time bank expiry: FSM in 'timer_running' but
seat N is still current" - each one an orphaned bank deadline from a previous turn firing while
the seat was on the clock again, forcing a check/fold over the horse's real decision, counting a
strike that never reset, and leaving `isActive` true so the horse's next deliberate bank burn was
refused and auto-folded at 17 s with its answer discarded. Three orphans at one table force a
sit-out, and **nothing sits a horse back in**: 12 horses were parked SAT_OUT 'forced' at the
14:55 park, and one had been sitting out since 02:54 UTC. `settleHorseSeatActed` now does the
same four things a human's action does, and the auto-activation mirrors every refusal
`tryActivate` can return instead of only 'depleted'.

### 8. Fifteen hours with no rotator, and what it left

With the rotator silent (finding 1), nothing ended a session, topped up a short stack, stood a
lone horse, released a seat for a waiting human or restored a sit-out. Measured when it came
back: 337 horse cash seats, 279 past the 75-minute mean session, median 250 minutes, max 30
hours; 22 short stacks never topped up. The rotator's own defects were fixed in the same pass -
the session-P&L ledger read was an unfiltered 1,000-row slice of rake (386,992 qualifying rows
in the window, so the book-win and stop-loss rules had never once seen a true figure), the
invested sum spanned every previous sitting at the table (49 false stop-losses against 2 real),
a 5-minute "short break" met the 5-minute sit-out eviction, and one waiting person stood up two
or three horses because `notified` rows were counted as unserved queue.

### 9. Every Midway horse that busts is stood up, and none has reloaded in nine days

`fn_horse_fund_from_treasury` debits `tables.club_id`'s treasury. Every open Midway cash table
carries the UNION's club row, whose `chip_treasury` is **0.50** against JAQK's 937k and SHARK's
886k. `chip_ledger` horse_funding: Deep Stack 449 rows a day, every day; Midway Union 81 rows on
09-02 and nothing since. Midway horse cash exits: 484 a day, 310 of them at a zero stack. Every
other money door on the platform resolves the club the SEAT represents. The migration is
`docs/audits/2026-09-11-horse-audit/proposed-migrations/a_horse_rebuy_is_funded_by_the_club_its_seat_represents.sql`.

## The page Dan asked for

/metrics carried 2,978 `poker_` series and not one said how many horses were playing. The
fleet's own record is a database table, and no alert rule reads tables. On 2026-09-10 the floor
fell from 33,343 hands an hour on 717 tables to 546 on 10 over five hours; the only rule that
fired was the generic deal rate, twice, into email.

**Two deliveries, two failure domains.**

1. **The engine pages Dan's phone itself** for the three verdicts it owns:
   `ClubArenaFleetFloorLost`, `ClubArenaFleetSilent` and the new
   `ClubArenaHorseFleetLoopStopped`. `raiseEngineAlert({ page: true })` mirrors a critical to
   `fn_raise_notification` -> `notifications` -> `push_outbox` -> the per-minute push dispatch,
   for every active row in `ca_incident_recipients`. Verified on production 2026-09-11: one
   active platform recipient, 54 push subscriptions, 164 pushes delivered in seven days. No
   Prometheus, no Alertmanager, no infra deploy in that path.
   `ClubArenaHorseFleetLoopStopped` is the one the fleet could never raise for itself: the
   seeding loop stopping while the process lives. Threshold from 24 hours of beats - gap p50
   30 s, p95 51 s, the hourly break 447-632 s (guarded), one genuine 2,461 s stall at 01:33 UTC
   in which nothing fired - so 900 s, twice in a row, behind the freeze guard.
2. **Eleven Prometheus rules** in the `horse-fleet` group of `infra/monitoring/alert-rules.yml`
   (the file Prometheus already loads; no new file, so the three lists of 10.84 stay in
   agreement). `promtool check rules` passes: 68 rules. Every threshold carries the measurement
   it was set against, every fleet-level rule carries the break guard as `unless on()`, and all
   four rules whose series exist today were evaluated against live Prometheus before merging:
   quiet, on a floor reading 232 dealable tables and 1,518 horse cash actions a minute.

Four new counters and three new gauges make those rules possible:
`poker_horse_turn_timeouts_total{kind}`, `poker_horse_decision_fallbacks_total`,
`poker_horse_seat_unactable_total`, `poker_horse_forced_sit_outs_total{format}`,
`poker_horses_seated`, `poker_tables_with_horses`,
`poker_horse_fleet_heartbeat_age_seconds`.

Five more rules are written and deliberately NOT shipped, because the series they read does not
exist yet and an alarm that cannot fire is worse than no alarm: `HorseHostBelowTarget`,
`HorseRebuysDeclinedByTreasury`, `HorseRotatorSeatReadFailing`, `HorseTournamentFillFailing`,
`HorseFleetStateUpsertFailing`. Each lands in the same pull request as its metric.

**What still needs a human.** SMS through Twilio needs `TWILIO_ACCOUNT_SID`,
`TWILIO_AUTH_TOKEN` and `TWILIO_PHONE_NUMBER` set in the hub-vanguard Vercel environment (an
agent never sets a credential, CLAUDE.md 10.84). The push path needs nothing. And
`ca_incident_recipients` has one active row; if a second phone should be paged, that is a row
Dan chooses.

## Not fixed, and why

- **The 40% occupancy curve against "75% of all seats" (Dan 2026-09-02).** Both are written
  down; the 75% is Dan verbatim, the curve's daytime shape is an agent's table with no quote
  behind it, and the curve's NIGHT half is Dan verbatim and later. The arithmetic: with four
  tables per body the two agree from about 11:00 to midnight Chicago and conflict only through
  the morning ramp, which is where the floor sits now (both hosts pinned at cap, 40-42% of seats
  filled, 2.2-2.4 seats per body). CLAUDE.md 10.8 says a conflict between two written rules is
  Dan's to settle, so no constant was changed. The options, cheapest first, are in
  `docs/audits/2026-09-11-horse-audit/laneC.md` finding 1.
- **Deep Stack runs one game per rung** (classic only, 42 games) while Midway runs three
  templates, so 156 of 292 Deep Stack cash bodies have at most two games they can sit in and
  "four tables at once" is unreachable there by any seating code. That is `cash_games` rows, an
  operator's decision, not code.
- **The two-hour same-key window** is written every cycle and read by nothing. Wiring it is a
  new refusal gate on a floor whose complaint is too few horses; it needs the OPORD's owner.

## Where the record is

Every lane's full working record, with every measurement stamped with the minute it was read, is
under `docs/audits/2026-09-11-horse-audit/` (laneA.md through laneE.md, and the proposed rule
group lane F wrote before it was merged). The input device's own changelog is
`2026-09-11-lane-f-horse-input-device.md` beside this file.

`proposed-migrations/` holds five SQL files that are NOT applied and are NOT in
`supabase/migrations/` on purpose: three from the tournament lane (resume the 40 games dealt on
09-08, let the horse door late-register and name a finalized pool, stop a reused seat-first seat
coming back sat out) and two from the database lane (fund a horse's rebuy from the club its SEAT
represents, and project a stake band onto the games its own host deals). Each carries its
reasoning, its evidence and its rollback in its header. They are separate from this pull request
because a function change on production is its own decision with its own window (CLAUDE.md 2,
rule 8: the database refuses DDL between :50 and :03).
