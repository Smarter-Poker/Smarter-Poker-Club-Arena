# 2026-09-02 - Horses keep their seats across a restart

**Dan, verbatim:** "ALL HORSES WERE REMOVED FROM THE TABLE DURING THE 5 MINUTE
BREAK AND SNAP REPLACED WITH NEW HORSES AFTER THE BREAK, THAT CAN'T HAPPEN,
THEY ARE SUPPOSED TO BE FROZEN NOT REMOVED AND RESEEDED."

## What happened

`GameServer.cleanupStaleData()` ran on every boot and cashed out + vacated
every HORSE seat at every cash table, then reset every horse to `available`
so the fleet re-seeded fresh horses into the holes. Measured on the 20:55
break, the first restart on the fixed build:

    20:58:03 [GameServer] Cashed out and vacated 383 seat(s) before cleanup
             (78575.13 chips returned to club wallets)

383 seats across 223 cash tables, every one a horse, zero humans
(`ca_seat_stack_exits`, exit_kind=left, via PostgREST). Then the fleet seeded
new horses. That is the removal-and-replacement Dan watched.

## Why it existed

Written 2026-08-18 after the same sweep removed Dan from a live table twice:
the fix exempted HUMANS and left horses reaped. Nine days before the
horses-are-players law (CLAUDE.md 10.5, 2026-08-27). Never revisited.

## The fix

The cashout block is deleted. Nothing needs it: a seat row IS the persisted
state, the engine rebuilds every table from `table_seats` on boot (the stated
reason a human's seat was safe), the fleet seeds only empty seats and refuses
"Player already seated", and a horse mid-hand at restart is resumed by crash
recovery like any other seat. Orphaned seats still fall to
HorseLifecycleManager's guarded 4-hour sweep.

Left alone on purpose: the `horse_status` reset (a health flag the fleet
ignores for seating) and the cash-table `status -> waiting` normalisation
(pinned by CashTableClosureIsRespected.test.ts).

## Proof

- `seatExitMoneyPaths.test.ts` rewritten: 4 pins FAIL on origin/main's
  GameServer.ts, all 13 PASS on the fix.
- `tsc --noEmit` clean; full server suite 3,646/3,646.
- First live verification: the next break's `ca_break_scorecards` row and
  `ca_seat_stack_exits` must show no horse exits at boot.
