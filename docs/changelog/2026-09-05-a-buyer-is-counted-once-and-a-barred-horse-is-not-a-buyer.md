# 2026-09-05 - a buyer is counted once, and a barred horse is not a buyer

## What was measured (production, 2026-09-05 03:05 CDT, engine log + DB)

The ClusterController opens a feeder for a must-move cash game when Main 1 is
full and at least two buyers are waiting (OPORD 1.4 18.3). A horse is a buyer
(CLAUDE.md 10.5); the fleet supplies the count through
`HorseFleetManager.eligibleHorseCount(main1TableId)`, which until today was the
size of the candidate pool for that table. Two defects made that number a lie:

- **In the last hour before this fix, 12 feeders opened, 2 went live, 11 were
  abandoned at three minutes** (nobody ever sat) and re-opened two minutes
  later - one every 5.5 minutes, all night.
- **341 of 349 horse buy-in refusals in that hour were `VPIP_BARRED`**
  (`[HorseFleet.atomic_table_buyin_failed_for_horse]`). 35 horses held 57
  active bars in `public.cash_rejoin_constraints`.

### Bug A - a barred horse was counted as a buyer and then refused at the door

`20260905064000_booted_for_low_vpip_is_barred_for_two_hours.sql` writes a
`barred_until` on the player's rejoin-constraint row for that game (club,
variant, sb, bb), and `fn_cash_rejoin_floor` - called by `atomic_table_buyin` -
raises `VPIP_BARRED:<secs>` while it holds. The same rows carry the rathole
floor (`required_stack` while `expires_at > now()`). The fleet's candidate
filter knew about neither: barred horses passed every in-memory gate, were
counted in the pool, were selected, and were refused by the database. A human
sees the bar in the lobby and does not try; the fleet is the horse's browser
and must not try either, and must not count that horse as a buyer.

### Bug B - one free horse was counted as a buyer for every game at once

The same free horse is in the pool of every full Main 1 on the host, so two
spare horses made the controller open a feeder in every full game. The two
horses filled one feeder; the rest were abandoned. The controller needs how
many horses the fleet would actually seat at THIS table next cycle given the
whole floor - an allocation, not a pool size.

## Shipped

- **`server/src/services/HorseRejoinConstraints.ts`** (new, pure). Reads the
  constraint rows into `barred: Set<player|club|variant|sb|bb>` and
  `rejoinFloor: Map<same key, max required_stack>`; `rejoinTableKey()` formats
  the table side identically (`Number()` on both sides, so "0.50" from
  Postgres and 0.5 from the table row meet). `applyRejoinFloor()` is the
  modal's arithmetic (`GREATEST(min, floor)` then `LEAST(that, max)`).
- **`server/src/services/HorseBuyerAllocation.ts`** (new, pure).
  `allocateBuyers(tables, capacityByHorse)` walks the cluster tables in the
  fleet's own seeding order and hands each horse out once per table it can
  still open, never twice within one game. A FULL table asks for
  `FULL_TABLE_BUYER_PROBE = 2` (the open rule's threshold) and no more, so it
  cannot eat the capacity a table with real open seats needs.
- **`server/src/services/HorseFleetManager.ts`**:
  - the seeding cycle loads `cash_rejoin_constraints` ONCE per cycle
    (`fetchAllRows`, keyset on `id`, active rows only, label
    `HorseFleet.rejoinConstraints`), beside the bankroll loader and with the
    same fail-open doctrine (an unread map is no opinion; the database still
    refuses at the door);
  - the candidate filter drops a horse barred from this game (`barredDropped`)
    - every table, cluster or not - and, inside the bankroll gate, a horse
      whose KNOWN roll cannot cover its rejoin floor clamped to the table max
      (`floorUnaffordableDropped`). Both are reported on the cycle log line
      beside the tag counters;
  - `computeHorseBuyIn()` takes the floor and applies it last, clamped to the
    table max - the number the buy-in modal shows a returning human. Both
    callers (the seeding loop and `claimOfferedSeats`) pass it; a barred horse
    does not answer a seat call either;
  - for every cluster table the POOL is kept (with the horses it actually
    seated moved to the front) and each horse's remaining capacity
    (`tagMaxTables(tag, 4) - tables already sat`) is recorded once per cycle;
    after the loop `allocateBuyers` writes the cluster tables' counts into
    `nextEligible`, which is swapped in whole as before. Non-cluster tables
    still report pool size. `eligibleHorseCount()` and the ClusterController
    are unchanged.
- **Tests** (server, vitest): `HorseBuyerAllocation.test.ts` (one horse in two
  pools is allocated once; the live six-full-games/two-horses case opens ONE
  feeder; a full table never takes more than two; capacity 0 never taken;
  order respected; same-cluster double allocation refused),
  `HorseRejoinConstraints.test.ts` (key parity, bar excludes exactly that
  horse in exactly that game and not its neighbour or the next stake, lifted
  bar, expired row, max floor, floor raises and clamps),
  `aBarredHorseIsNotABuyer.test.ts` (the seeding path is wired to both). The
  pin in `TheTablesOpenAndCloseThemselves.law.test.ts` that read
  `nextEligible.set(table.id, pool.length)` was MOVED to the allocation in the
  same commit, as the animation law requires for a replaced mechanism.

## Deliberately not changed

- **A floor above the table max clamps; it does not skip the horse.** The
  brief said to skip; the database does not. `fn_cash_effective_buyin` and
  `atomic_table_buyin` both compute `LEAST(GREATEST(min, floor), max)`, so a
  human with a 450 floor on a 200-max table is asked for 200 and seated. Law
  10.5 says identical treatment, so the horse is asked for 200 too. The horse
  IS skipped when its known roll cannot cover that effective floor, because
  that is the case the database would refuse.
- `seatsWanted` for a cluster table with room is `max_players - currentCount`,
  not the 1-2 trickle the fleet seats this cycle. That is deliberately
  conservative: a sparse Main that will take those horses over the next few
  cycles should not have them counted as feeder demand elsewhere.
- Bars and floors are still enforced by the database. This change stops the
  fleet from trying and from counting; it does not replace the guard.

## How to verify (read, never assume)

1. **Feeder abandonment rate**, before and after the engine that carries this
   lands (compare `ca_sha`/engine version against the deploy time):

   ```sql
   SELECT date_trunc('hour', at) AS hr,
          count(*) FILTER (WHERE kind = 'feeder_opened')    AS opened,
          count(*) FILTER (WHERE kind = 'feeder_live')      AS live,
          count(*) FILTER (WHERE kind = 'feeder_abandoned') AS abandoned
     FROM public.cash_cluster_events
    WHERE at > now() - interval '6 hours'
    GROUP BY 1 ORDER BY 1;
   ```

   Before: 12 opened / 2 live / 11 abandoned in the hour. After: `live` should
   approach `opened` and `abandoned` should be near zero; a feeder that opens
   is one two horses will actually fill.

2. **VPIP_BARRED refusals in the engine log** (`pm2 logs` on the Hetzner box,
   or Sentry `HorseFleet.atomic_table_buyin_failed_for_horse`): count lines
   containing `VPIP_BARRED` per hour. Before: 341/hour. After: zero from the
   fleet, because it no longer tries. The new cycle line
   `[HorseFleet] door: N horse/table pair(s) barred from that game for low
VPIP; M holding a rejoin floor their roll cannot cover` shows the drops
   that replaced them.

3. `BUYIN_BELOW_FLOOR` retries in `seatHorse` should also fall to near zero:
   the first call now carries the floor.

## Addendum, same branch - the fleet does not seat a disabled game (18.4)

### What was measured (production, read 2026-09-05 03:45 CDT)

`cash_games.enabled = false` is the operator's switch. OPORD 1.4 18.4:
"enabled = false: no seeding, no opening; empties close". The controller does
the closing (`fn_cash_cluster_tick` closes a disabled game's EMPTY tables); the
fleet had to do the not-seeding, and it did not know the switch existed. Its
seeding loop skipped a cluster table only when `table.lifecycle` was
`'breaking'` or `'closed'` and never asked whether the game was enabled.

- Game **"NLH 0.05/0.10 Classic"** (`37ac7634-69dd-434c-b947-bfcf8941ecf4`,
  club `fade0000-...`) was disabled by an operator on **2026-09-04 16:47 CDT**.
- Between **01:10 and 03:41** the next morning the fleet seated **five horses**
  onto its feeder (`dbbc148e-384a-4c38-abb6-833b2d2847ff`), which dealt
  **76 hands in the last hour**.
- **30 games** were disabled at the time.

The two halves of 18.4 were fighting: a table the fleet keeps refilling is
never empty, so "empties close" never got its turn.

### Shipped

- **`server/src/services/HorseDisabledGames.ts`** (new, pure).
  `buildDisabledGameIds(rows)` and `isTableOfDisabledGame(table, set)`: a
  table with no `cluster_id` is never "of a disabled game"; an empty set
  disables nothing.
- **`HorseFleetManager.seedAllTables`**: once per cycle, beside the
  rejoin-constraints loader, reads `cash_games.id where enabled = false`
  through `fetchAllRows` (keyset on `id`, label `HorseFleet.disabledGames`).
  **Fails OPEN**: a failed or short read sets `beat.disabledGamesReadFailed`
  and the cycle treats no game as disabled. Failing closed was considered and
  rejected - it would empty every cluster game on the floor on one bad read,
  a worse outage than one more cycle of seating on a switched-off game.
- **Seeding loop**: a cluster table whose game is disabled is skipped exactly
  like a breaking one - `continue` before any seat arithmetic and before the
  pool is kept for `nextEligible`, so the game reports **0 eligible**, which
  is what lets the tick mark it dormant and close its empties. Counted as
  `disabledGameTables`.
- **`claimOfferedSeats`**: a seat offer on a table of a disabled game is not
  answered by a horse (same set, same predicate).
- **The cycle line and the beat**: every `Seeding cycle took Ns` line now ends
  `; N table(s) of disabled games skipped`, or `; disabled games: READ FAILED,
none skipped (fail open)` when the switch could not be read. The pulse
  (`fn_ca_fleet_state_upsert` detail) carries `disabled_game_tables` and
  `disabled_games_read_failed`.
- **`server/src/services/aDisabledGameIsNotSeeded.test.ts`**: the rule proven
  behaviourally (the disabled feeder is skipped whatever its lifecycle, the
  enabled game beside it is untouched, a legacy table is never affected, an
  empty set disables nothing, thirty disabled games skip thirty tables and
  leave the thirty-first alone), and the seeding path proven wired to it by
  source contract (loader once per cycle, fail-open shape, skip position
  before seat arithmetic / `clusterPools.push` / `nextEligible.set`, seat-call
  gate, one predicate with two callers).

### How to verify (read, never assume)

1. Once the engine carrying this is live, no NEW horse seat should land on a
   table of a disabled game:

   ```sql
   SELECT ts.table_id, t.name, g.name AS game, count(*) AS horse_seats, max(ts.created_at)
     FROM public.table_seats ts
     JOIN public.tables t ON t.id = ts.table_id
     JOIN public.cash_games g ON g.id = t.cluster_id
     JOIN public.profiles p ON p.id = ts.user_id AND p.is_horse
    WHERE g.enabled = false AND ts.left_at IS NULL
    GROUP BY 1, 2, 3 ORDER BY 5 DESC;
   ```

   `max(created_at)` must predate the deploy for every row; as those seats
   stand up, `fn_cash_cluster_tick` closes the emptied tables
   (`cash_cluster_events.kind = 'table_closed_disabled'`).

2. The engine log: `[HorseFleet] Seeding cycle took Ns; N table(s) of disabled
games skipped` with N > 0 while any disabled game still has a live table.
   `READ FAILED` on that line is the one case a disabled game may have been
   seeded for a cycle, and it pairs with a Sentry
   `HorseFleet.disabled_games_load_failed`.

## Addendum, same branch - a buyer is a horse the fleet will actually seat

### What was measured (production, read 2026-09-05 14:55 CDT)

With the two fixes above live, feeders were still dying. Last 45 minutes:
8 feeders opened, 2 went live, 6 abandoned. Two games -
`b59525f3` (NLH 1/2 Classic, club `2a1132b9`) and `67e5ad65` (PLO5 0.10/0.25
Classic, club `fade0000`) - opened a feeder every 5 minutes with
`"buyers": 2` in `cash_cluster_events`, and NO horse ever sat on any of them:
`table_seats` rows ever created on those feeders, 0. The engine log carried
NO line about either feeder. Not `No available horses for ... Feeder`, not a
buy-in failure, not a mutex refusal, not a host-cap line. Nothing.

### The design fault - two predicates

The seeding loop answered "may this horse sit here" in two places with two
different rules.

The CANDIDATE filter (club, door, tag, bankroll, host cap, table ceiling)
built `pool`, and `pool` fed three things: `clusterPools` (the allocation),
`eligibleHorseCount` (the number the ClusterController reads to OPEN a
feeder), and `weighted` (the horses selected for chairs).

The SEAT STAGE then asked four MORE questions of each selected horse, and on
every one of them it `continue`d silently:

| refusal                                   | what it was                                  | visibility                             |
| ----------------------------------------- | -------------------------------------------- | -------------------------------------- |
| `if (seatClub === null) continue;`        | no wallet resolved for this horse and table  | none                                   |
| `if (buyIn <= 0) continue;`               | `computeHorseBuyIn` sized the buy-in to zero | a bankroll counter, no line            |
| `!canOpenAnotherTable(...)` -> `continue` | aggregate exposure ceiling                   | a bankroll counter, no line            |
| `evaluateSit(...) !== 'ok'` -> `continue` | the Stable Hand mutex                        | `mutexRefused`, logged only when non-0 |

So the fleet could tell the controller "2 buyers" for two horses it would
then refuse at the chair, every cycle; the controller opened the feeder on
that count, nobody sat, the feeder was abandoned at three minutes, and the
loop repeated every five.

### Shipped

- **`server/src/services/HorseSitVerdict.ts`** (new): `sitVerdictFor(horseId,
table, ctx)` is the ONE predicate. Wallet (`resolveSeatClub`), buy-in
  (`computeHorseBuyIn` with the rejoin floor), aggregate ceiling
  (`canOpenAnotherTable`), Stable Hand mutex (`evaluateSit`), in the seat
  stage's own order, behaviour identical to the seat stage before it. It
  returns `{ ok: true, seatClub, buyIn, sitKey?, telemetry }` or
  `{ ok: false, reason, telemetry }`, with `reason` one of `no_seat_club`,
  `zero_buy_in`, `aggregate_exposure`, or the mutex's own `SitRejection`.
  It is PURE: no bankroll counter, no state mutation; the telemetry the
  decision would emit travels back on the verdict.
- **`HorseFleetManager.seedAllTables`**: one `SitVerdictContext` per cycle,
  built from the cycle's live maps. For a CLUSTER table the candidate filter
  is followed by the SITTABLE filter - `candidateHorses` narrowed by the
  verdict - and `pool` (allocation, `eligibleHorseCount`, selection) is
  built from `sittable`. A horse the verdict refuses is neither counted as a
  buyer nor selected. The cheap gates still run first. The seat stage asks
  the same verdict for the chair, emits its telemetry there (once, where the
  decision is acted on), and counts every refusal.
- **`computeHorseBuyIn`** takes a telemetry sink (`note`, default
  `bankrollEvent`); the verdict passes a collector so judging a horse for the
  COUNT emits nothing.
- **The diagnostic line.** For every cluster table with lifecycle `opening`
  the cycle reaches, exactly one line, from a `finally`:

  ```
  [HorseFleet] opening feeder "<name>": candidates <n>, sittable <n>, wanted <n>, empty seats <n>, selected <n>, seated <n>, skipped {reason=count ...}
  ```

  (`, withheld <reason>` appended when the table never reached the filter.)
  The same counts go to the beat detail as `opening_feeders[]`
  (`fn_ca_fleet_state_upsert`).

- **The cycle summary.** When any seat-stage skip happened:
  `[HorseFleet] seat stage skipped: no_seat_club=N zero_buy_in=N aggregate_exposure=N`,
  and when a cluster count left pairs out:
  `[HorseFleet] not sittable: ... <reason=count ...>`. The mutex's own
  `Stable Hand mutex refused:` line is unchanged.
- **Tests.** `HorseSitVerdict.test.ts`: every refusal reason, the ok path
  (club and buy-in), fail-open on an unknown roll and an untagged horse,
  side-effect freedom; and source contracts that the cluster candidate filter
  calls the verdict, that the pool used for allocation and selection is the
  sittable pool, that the seat stage has exactly one `continue` and it is
  counted, and that the feeder line exists once in the pinned format. Pins in
  `StableHandSeatingWiring`, `HorseAggregateExposure`,
  `HorseBankrollTelemetry`, `HorseStakeBands` and `aBarredHorseIsNotABuyer`
  moved to the mechanism's new home in the same commit.

### How to verify (read, never assume)

1. `cash_cluster_events`: for the two games above, `feeder_opened` should be
   followed by `feeder_live` rather than `feeder_abandoned`, and the
   `buyers` figure on a `feeder_opened` row should be a number the next
   cycle actually seats:

   ```sql
   SELECT cluster_id, kind, detail->>'buyers' AS buyers, created_at
     FROM public.cash_cluster_events
    WHERE kind IN ('feeder_opened', 'feeder_live', 'feeder_abandoned')
      AND created_at > now() - interval '1 hour'
    ORDER BY created_at DESC;
   ```

   Abandonments per hour should fall to the rate at which horses genuinely
   stop being sittable between count and chair (near zero).

2. The engine log, one line per opening feeder per cycle:
   `[HorseFleet] opening feeder "..."`. `sittable` is the number the
   controller was told. If `seated` is below `selected`, the `skipped {...}`
   braces say why, by reason, and the cycle's `seat stage skipped:` line
   totals the same reasons across the floor. A feeder that opens and gets
   nobody can no longer do so in silence.

---

## Part 2 (same day, 15:22 CDT): no lone horse

### The measurement

Of 140 live cash-cluster tables, **47 held exactly one horse** (46 of them the
only table of their game), seated for **253 minutes on average**, and **39 of
the 47 had dealt no hand in thirty minutes**. 26 more held two. The lobby
therefore showed dozens of games with "1" player where nothing was happening,
which is Dan's exact complaint.

### The cause

Two mechanisms, neither a rule anybody wrote down:

- `occupancyTargetFor` (the V14 vibe) can return a `seatTarget` of 1 for a
  sparse table, and the 1-2 per cycle trickle can leave a table at 1. Once the
  target is met the fleet adds nobody, so the table sits at one for hours.
- `HorseSessionRotator` skips any table below its population floor
  (`tableSeats.length < 4 -> continue`). The floor exists so a healthy game is
  not thinned, but a table at one is not a game, so the one horse that most
  needed to leave was the one horse the rotator would never stand.

A lone player cannot deal a hand. A human alone at a table nobody has joined
for ten minutes racks up. Under 10.5 the fleet is the horse's input device and
may decide exactly what a human would decide; the OPORD asks the same of humans
at the door (a one-buyer opening hold waits for a partner; no ghost table).

### The two rules (`server/src/services/HorseLoneTable.ts`, pure and tested)

1. **A cluster table is seeded to a dealable minimum or not at all.** In
   `HorseFleetManager`, any table with a `cluster_id` (any role, any lifecycle)
   at 0 or 1 has its `seatTarget` floored to `DEALABLE_MINIMUM` (2) and its
   `seatsNeeded` lifted to `min(seatsAllowed, 2 - currentCount)` after the
   trickle - the rule the opening feeder already had, generalised
   (`seatsToDealable`). At the seat stage the sit verdict is now asked for
   every selected horse BEFORE the first buy-in (it is side-effect free and per
   horse, so the answers are unchanged), and an EMPTY cluster table with fewer
   than two cleared horses seats nobody this cycle (`refusesLoneSeat`), counted
   as `lone_seat_refused` in the opening-feeder diag and logged once per cycle:
   `[HorseFleet] lone_seat_refused=N: ...`. A table already at one (or with a
   pending arrival, which `currentCount` includes) takes the one horse that
   makes it two. Tables at two or more keep their trickle; non-cluster tables
   are untouched.

2. **A lone horse leaves a dead table.** In `HorseSessionRotator`, a new pass
   (`standLoneHorses`) runs after the retirement drain and BEFORE the
   discretionary loop, so the population floor cannot veto it. A horse that has
   been the ONLY player at a cluster table for `LONE_TABLE_MINUTES` (10) with no
   `hand_history` row for that table inside the window is stood up through the
   same door a human uses, `engine.leaveTable()` (hand-boundary safe). The game
   then goes dormant per OPORD 18.4 and its Main 1 stays open with 0. Exempt:
   a table with a human seated (the horse is their opponent), a table with a
   `cash_seat_moves` row pending INTO it (a partner is coming), an `opening`
   feeder younger than `OPENING_FEEDER_GRACE_MINUTES` (3). Both database reads
   fail CLOSED (an unreadable answer stands nobody). The count is exposed as
   `rotator.loneStands` and logged per cycle when non-zero:
   `[SessionRotator] loneStands=N - ...`, with one line per horse:
   `[SessionRotator] horse=... leaving table=... - alone for M min with no
hand dealt in 10 (lone stand)`.

The two rules together cannot ping-pong: after a lone stand the table is at 0,
and rule 1 seats two there or nobody.

### Tests

`server/src/services/HorseLoneTable.test.ts`: the seeding rule (an empty
cluster table with one candidate seats nobody and reports the refusal; with two
it seats two; a table at three still trickles; non-cluster untouched; the cap
is never exceeded), the stand rule (lone 10 min no hand -> stood; lone 5 min ->
stays; hand dealt inside the window -> stays; lone with human -> stays; lone
with inbound pending move -> stays; opening feeder under 3 min -> stays, over
-> the rule applies), and source contracts for the wiring in both services
(verdict before buy-in, refusal before the seat loop, the pass ahead of the
floor, the human door, the two fail-closed reads, the log lines).

### How to verify (read, never assume)

1. Tables holding exactly one seat, trending to zero within ~15 minutes of the
   deploy (ten minutes of grace plus a rotator cycle):

   ```sql
   SELECT count(*) AS lone_tables
     FROM public.tables t
    WHERE t.cluster_id IS NOT NULL
      AND t.is_deleted = false
      AND t.lifecycle IN ('live', 'opening')
      AND (SELECT count(*) FROM public.table_seats s
            WHERE s.table_id = t.id AND s.left_at IS NULL) = 1;
   ```

   Before this change: 47. A residual handful is expected at any instant (a
   horse whose partner just left, an opening feeder in its grace, a table with
   a move pending into it); a number that holds above ten for an hour means one
   of the two rules is not running.

2. The engine log. `[SessionRotator] loneStands=N` in the first cycles after
   the deploy (the backlog clearing), then rarely. `[HorseFleet]
lone_seat_refused=N` whenever the fleet had only one sittable horse for an
   empty cluster table; a cycle with neither line and a `lone_tables` count of
   zero is the healthy state.

3. No horse was stood from a table with a human at it: every `lone stand` line
   names a table that held one seat at that moment, and
   `cash_cluster_events` for the game shows `dormant` (18.4) rather than a
   break with a person on it.
