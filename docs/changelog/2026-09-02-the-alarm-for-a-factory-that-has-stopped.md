# Phase 2: the alarm for a factory that has stopped, and one dead table

2026-09-02. Follow-on from the four-hour outage in which every tournament
INSERT failed and not one alarm made a sound.

## 1. Every gauge measures the games that exist

That is the whole lesson of yesterday. `unbooked_spins` read 0 because no Spin
was running to be unbooked. `booking_gaps` read 0 for the same reason. Fairness
was healthy over draws that had already happened. The reserve pool was not thin.
Every one of those readings was CORRECT, and together they described a platform
that had stopped producing games as a quiet night.

`fn_spin_metrics` now returns two more numbers, and the engine emits them:

| gauge                                 | meaning                            |
| ------------------------------------- | ---------------------------------- |
| `poker_spin_seconds_since_last_start` | how long since a Spin last began   |
| `poker_spin_open_boards`              | Spin boards sitting in REGISTERING |

**It takes both halves to make an honest claim.** A room with no boards open and
nothing starting is a quiet night and must never page anybody. A room with
boards OPEN and nothing starting for half an hour is the failure that happened.
`SpinFleetProducingNothing` fires on exactly that conjunction:

```
poker_spin_seconds_since_last_start > 1800 and poker_spin_open_boards > 0
```

Normal cadence is around a hundred Spins an hour, so thirty minutes of silence
against open boards is far outside ordinary variance. Its description points the
next reader at the shape of the cause rather than the symptom: check whether the
platform can create a tournament AT ALL, and reproduce it by cloning a live row
inside a transaction you roll back.

Deployed to engine-01 and verified loaded: 10 spin rules, `SpinFleetProducingNothing`
among them. Written IN PLACE this time - a single-file bind mount pins the inode,
so a `mv` over the path leaves the container reading the file the rename
unlinked. That mistake cost a Prometheus restart yesterday; the reload picked
this one up with no restart at all.

## 2. `spin_tournaments` retired

Zero rows for its entire life. A duplicate of the Spin concept that predates
`tournaments.variant = 'spin'` and lost.

Not merely unused - a hazard. It carried `multiplier`, `prize_pool`, `buy_in`
and `status` columns whose names match the live ones exactly, plus an RLS policy
of `USING (true)` making it world-readable. The next agent to grep for "spin"
and "multiplier" would find a plausible, readable, permanently empty table, and
a report built on it reads a real zero. Duplicate tables with the right column
names are how a zero gets believed.

Checked against the live catalog before dropping: 0 rows, 0 inbound foreign
keys, 0 triggers, 0 dependent views, 0 functions naming it, 0 references across
`src`, `server/src`, `scripts` and `tests`. The migration re-checks the row count
at apply time and refuses if the table has acquired one, and carries a full
`CREATE TABLE` rollback - there is no data to restore because there has never
been any.

The schema manifest was regenerated and the diff verified to be exactly one
table removed and nothing else: no functions lost, both of this branch's new
functions present.

## What I looked at and did NOT change

The lobby's honesty about the top prize is already handled, and handled well.
`v_spin_tier_availability` answers "can this club pay a 100x right now" with the
same arithmetic the draw gates on, `LobbyTable` renders it as a badge, and an
import-time assertion throws if the ladder's top tier ever moves away from the
hard-coded `can_draw_100x` column name. Unknown renders as nothing - an absent
boast rather than a wrong one. There was nothing for me to add.

The remaining thread there is narrower and currently theoretical: the buy-in
sheet's odds table shows every tier's frequency, and when a pool is thin enough
that `eligibleSpinTiers` locks tiers out, the true conditional odds
renormalise. No club is anywhere near that today (`reserve_thin_clubs` 0,
`can_draw_100x` true for both), so it is recorded here as a known gap rather
than fixed speculatively.
