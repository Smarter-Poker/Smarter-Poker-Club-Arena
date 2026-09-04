# Silence is the only observable, so silence is what gets measured

**2026-09-04.** The controller now decides and acts on the cash floor every
thirty seconds. `GET /stable-hand` could say what the floor was at the instant
you asked and nothing at all about two questions that matter more once a curve
is being enforced: **is it being held**, and **is the controller running at
all**.

## The heartbeat

`stable_hand_beats` takes one row per host per executor cycle: population, live
bodies, seats, table count, the shape buckets, humans waiting, what the curve
wanted, and both what the controller PLANNED and what it managed to DO.

**Planned and executed are recorded separately on purpose.** A beat with plans
and no executions for an hour is a different fault from a beat with neither: an
engine missing for a table, a cooldown holding everything, a per-cycle ceiling
set too low. Collapsing them into one number would hide the whole class.

Two rows every thirty seconds is about 5,760 a day, pruned to seven days by the
writer itself. There is no scheduled prune job, for the same reason there is no
midnight counter reset: a job that has to run for a thing to be correct is a
thing that is wrong whenever the job does not run.

## The silence watch, and what it does NOT cover

`beatVerdict` is read by the **seeding cycle** - a different interval on a
different service from the executor that writes it. So an executor throwing
every cycle, or one left switched off while everyone forgets, is caught: the
engine looks healthy and the floor is unmanaged, which is exactly the failure
that leaves no trace anywhere else.

It does **not** catch a dead engine, and is not meant to. `engine-watchdog.sh`
and the deploy watchdogs own that from outside the box. Written down plainly
because a watchdog whose limits are not recorded gets trusted for things it
never covered.

Two more properties, both deliberate:

- **Never having beaten and going quiet are different verdicts.** The first is
  an install that did not take - a flag off, a deploy that did not carry the
  code. The second is something breaking. They deserve different sentences and
  are found at different times.
- **It is silent while the controller is deliberately off.** Paging about a
  switch somebody chose to throw is how alerts get muted for the ones nobody
  chose.

It complains **on change**, not every ten minutes. A warning re-filed forever
is a warning somebody mutes, and the alert row stays open until it is resolved.

## The bank runway

The Free Buy board commits 1,500 chips a day per host in guarantees, and
`fn_ca_fund_overlay_on_lock` draws the shortfall from `union_wallets` for a
union event and `clubs.chip_treasury` for a standalone one. Nothing said how
much runway was left, so the first anyone would have known is an event refusing
to start.

Measured in **days of the board's own exposure, not in chips**: a chip
threshold has to be re-chosen every time the board changes and a runway does
not. Warning under 14 days, critical under 3. Midway Union at 66,571 is about
44 days and reads `ok`.

## The history

`GET /stable-hand` now returns the last 240 beats alongside the snapshot, so
the answer to "is the curve being held" is a series rather than a guess, and
`heartbeat` says when the controller last wrote one and whether that is stale.

## The snapshot stopped re-reading what does not move

`buildFloorSnapshot` ran about thirteen round trips, every thirty seconds in
the executor and again on every dashboard request - roughly 1,500 an hour. Six
of them were `eligibleBodies`, which pages two clubs' memberships and then asks
which of those ids are horses, to answer a number that changes when somebody
joins a club. It is cached for five minutes now.

**The tables, seats and waiting lists are not cached and must not be:** they
are what the plan is computed from, and a stale one is a plan for a floor that
no longer exists.

A refresh that fails keeps the last good population rather than dropping to
null. Before the cache, one unreadable membership page took the whole host out
of the snapshot for that cycle; now it costs nothing until the value is
genuinely old, and past an hour it is refused outright - a number that stale is
a guess, and a host measured by a guess should not be managed.

## Verified

Exercised end to end against production: built two beat rows from the live
snapshot, wrote them, read them back, confirmed the verdicts, and deleted the
probe rows so the first real beat comes from the engine. The reading it
produced at 11:57 Chicago is worth recording - Midway Union 162 live against a
target of 151 and a cap of 163, so the DAYTIME floor is already on its curve
and only the night was ever over it.

Server typecheck clean, 5,206 tests across 360 files. Client typecheck clean.
One migration, one transaction, declared in the schema-manifest fragment.
