# A Seeding Cycle That Overruns Deletes The Next Refill

Before: `HorseFleetManager.seedAllTables` ran on a 30-second interval, and a tick arriving while the previous cycle was still going was dropped outright:

```ts
if (this.seeding) {
  this.overrunTicks++;
  return;
}
```

So an overrunning cycle does not merely finish late. It deletes the refills that should have happened while it ran, and the floor stays unseeded for the whole overrun. The code already knew this — it counts the dropped ticks and says so in the log — and nothing bounded the cycle that caused them.

Measured on production across three hours on 2026-09-11, **every cycle overran, without exception**:

```
31  34  36  36  49  49  50  60  63  63  63  63  63  65  67  75  76  76  84  84  109  109   (seconds)
```

Each one logging `N 30s tick(s) were dropped while it ran - the floor was not refilled for that long`. Not one cycle in three hours finished inside its own budget, so the floor went unrefilled continuously rather than occasionally.

## Where the time goes

Timestamping a single 109-second cycle from the container log:

```
22:39:44.610  [HorseFleet.atomic_table_buyin_failed_for_horse]
22:39:52.199  [HorseFleet.atomic_table_buyin_failed_for_horse]
22:39:57.972  [HorseFleet.atomic_table_buyin_failed_for_horse]
22:40:05.761  [HorseFleet.atomic_table_buyin_failed_for_horse]
22:40:17.488  [HorseFleet.atomic_table_buyin_failed_for_horse]
22:40:17.493  [HorseFleet] Seated 2 horses across tables
22:40:20.987  [HorseFleet] Seeding cycle took 109s and 3 30s tick(s) were dropped
```

Five buy-ins that timed out, **5.8 to 11.7 seconds apart, one after another** — 33 seconds of a 109-second cycle spent waiting on calls that were never going to land, to seat two horses.

The loop is sequential by construction, and correctly so: each seat updates the exposure and per-host body counts that the next decision reads, which the code defends in its own comments (_"The seat we just bought is exposure NOW, not next cycle"_). Parallelising it would break that accounting. So a single call in the tail stalls every table behind it, and the answer is to bound the waiting, not to reorder the work.

The same buy-in is **132 ms** uncontended, timed in a self-aborting probe against production. Its recorded mean over 9,767 calls in 44 hours is 1,336 ms with a 27.3-second maximum: the middle is fast, the tail is very long, and the sequential loop pays the tail in full.

## Correction: two bounds, and the arithmetic between them

**The cycle stops starting seats at 18 seconds.** Checked in the same place and the same shape as the seat-count budget already beside it, withholding the table with a named reason (`cycle_time_budget`) that is counted into the same `withheld_tables` the fleet already publishes. A table not seeded this cycle is seeded on the next one thirty seconds later — the same answer the seat budget already gives, and far better than a cycle that runs so long the next two never start.

**A seat purchase is abandoned at 5 seconds.** The fleet's `atomic_table_buyin` calls move to `seedingSupabase`, a client with its own deadline, exactly as the maintenance writers already use `maintenanceSupabase` for the opposite reason. The 15-second default is right for a hand in progress, where giving up on a write is worse than waiting; seeding is the reverse, and 5 seconds is 38x what the call actually costs. A slower call is abandoned, the chair is freed, and the loop moves on — the path the code already takes for a refused buy-in.

Nothing is at risk that was not already. The 15-second deadline abandoned the same way, less often, and a seat that commits after the client gives up is read back as taken on the next cycle.

The arithmetic is the point, and the test pins it: **18 s budget + 5 s abandoned call + 3.5 s Stable Hand state write = 26.5 s < 30 s tick.** The next tick always fires.

## The hazard the budget itself introduced

A budget measured from the start of the cycle includes the load phase — tag book, doors, policy, 5.3 s measured. If that phase ever ran past 18 seconds, an unguarded check would withhold **every** table, under a reason that reads like ordinary throttling, and the floor would stop being seeded entirely with nothing anywhere saying so. That is a worse failure than the overrun it replaces, and it is exactly the shape of thing this repository keeps finding: a guard that fails silently into looking healthy.

So one table is always tried, whatever the clock says, and a load phase that has eaten the whole budget prints a line naming the number rather than passing in silence. The test pins both halves.

## What this does not fix

The occupancy cap, not horse supply, is what leaves tables empty. At the time of measurement 27 of 173 cash tables had nobody at them, some for 249 hours, and 153 of the 1,000 horses held no seat at all — while both hosts sat pinned at their Stable Hand cap (238/238 and 167/167). That is a curve doing what it was told to do, and changing it is a decision about how full the floor should look, not a defect.

The long tail on `atomic_table_buyin` is bounded here, not removed. What was ruled out on the way: it is not the knockout-candidate index (3.2 ms, index scan), not `cash_seat_moves` (0.12 ms), not contention with settlement (`fn_ca_commit_hand_settlement` never takes the `table_seat:` advisory lock), and not a frozen platform (the fleet stands down correctly during maintenance breaks — a first probe was refused by that guard at 22:55, which is the guard working). Ten seconds of sampling `pg_stat_activity` during ordinary play found nothing waiting over 400 ms. Whatever produces the tail is intermittent, and the cycle no longer pays for it.
