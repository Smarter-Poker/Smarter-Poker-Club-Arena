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
