# The break holds on its durable announcement (2026-09-10)

## What Dan saw

"Engine Break Needs A Look" twice in seven hours:

- 00:00 UTC: it dealt 750 hands inside the break, the thaw did not run, nothing shipped.
- 07:00 UTC: it dealt 2476 hands inside the break, the thaw did not run, nothing shipped.

## What actually happened

Neither break started. At :53 the engine saves the last-hand row through
`fn_save_engine_maintenance_break`, which takes the maintenance boundary
(`pg_advisory_xact_lock(530090, 1)`) exclusively. Every entry door holds that
key shared for the life of its transaction, and some of those transactions
were slow: they queue on the platform-wide tournament settlement lane, and at
23:52:36 a migration was applied through the management API at the same
moment. The writer had a 5 s lock budget:

    23:53:00.4  fn_save_engine_maintenance_break waiting for ExclusiveLock [5,530090]
    23:53:05.4  canceling statement due to lock timeout
    06:53:00.6  fn_save_engine_maintenance_break waiting for ExclusiveLock [5,530090]
    06:53:05.6  canceling statement due to lock timeout

One timeout cancelled the whole hour. There was no last-hand row, no :55
countdown and no readyForRestart certificate. The fleet dealt straight through
the window, no thaw ran because no freeze had happened, and the deploy waiting
on the certificate shipped nothing. The scorecard found no break-log row, fell
back to the fixed window, and listed the consequences.

The -100.00 `ledger_imbalance` alert from the same morning is unrelated. It was
detected at 06:40, before the break, and resolved at 06:58 as a ledger-reader
defect (`the_journal_window_is_a_snapshot_not_a_clock`). No chips moved.

## What was already fixed, and is now verified

- The break writer outwaits the doors it serializes against: 32 s lock / 35 s
  statement budget (`20260910073818`), and the announcement retries a lock or
  statement timeout for 90 s (#4142). Both have been live since the 08:55 deploy
  (`8aaa7182`), not 07:55: `86aab0e645` predates #4142. The breaks from 09:00
  through 13:00 all passed.

## What this change fixes

1. **The countdown no longer cancels a break players are watching.** By :55 the
   last-hand row IS the database half of the freeze: `fn_entry_purchases_frozen`
   honours it from the announcement and `fn_platform_frozen` from :55, and
   neither has an end time for it. Cancelling on a failed countdown save
   resumed every table at :55 under a countdown every screen was showing. If
   the cleanup failed too, the database went on refusing entries behind a felt
   that was dealing. Now the countdown is shown on time, the break runs to :00
   whatever the save does, and the save only decides whether the hour carries a
   restart. The save is retried like the announcement's until there is no room
   left for a restart (:57).
2. **An adopted last-hand break holds the same way.** A replacement engine that
   cannot upgrade the row it claimed keeps the fleet parked to the same end
   instead of cancelling.
3. **Transport blips are retried too.** A dropped socket, a client-side
   timeout, or a 502/503/504 in front of PostgREST are now retried within the
   same budget. That is safe for this write only: it is a compare-and-set on
   the process's ownership token. A deliberate refusal (ownership lost,
   boundary expired) still ends the attempt at once.
4. **The end of a break clears the row the database actually holds.** It clears
   the last durable state as well as the final one, so a countdown that never
   became durable cannot leave a last-hand row freezing entries.
5. **Every cancelled or restart-less break records its cause** in
   `engine_maintenance_break_faults`. The scorecard reads it and the alert says
   "The Break Never Started: The :53 Announcement Could Not Be Saved (...)"
   instead of a list of symptoms (migration `20260910132747`, PR #4164).
6. **The maintenance unit tests are pinned to a quiet :20.** Since #3813 an
   engine that boots inside [:53, :00) with nothing to adopt holds the fleet
   from the clock. The unit suite used the real wall clock, so any run that
   started between :53 and :00 UTC entered a clock-derived break. Measured at
   12:56, four tests failed and one hung for 90 s.

Also landed today: #3813 (an engine restarting inside the window holds the
break instead of dealing through it, and a break whose engine died is still
thawed). It had been red for two days only because its law was not registered.
While landing it, its window was re-derived with UTC setters. It shipped in the
13:55 break as `6aee0b67`.
