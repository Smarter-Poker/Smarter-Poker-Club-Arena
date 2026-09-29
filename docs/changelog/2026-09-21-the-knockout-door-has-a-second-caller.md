# The knockout door has exactly one caller, and it did not call

2026-09-21. Backlog item #63: "an absent player freezes 884.00 of escrow across
5 events." Re-measured from rows today, the figure is still exactly **884.00**.
This is what it actually is.

## What was measured

`fn_ca_absent_tournament_players(10)` returns five events, each holding an
unranked player and the escrow that player prevents being paid:

| event      | name                                   | prize held | absent |
| ---------- | -------------------------------------- | ---------- | ------ |
| `5a387a75` | $100 Freeroll - 12:00 PM               | 100.00     | 65.6h  |
| `615783bf` | Afternoon Free Buy (NLH)               | 289.00     | 65.6h  |
| `839f4ca3` | Midnight Free Buy (NLH)                | 312.00     | 57.5h  |
| `8ec7e81d` | $100 Freeroll - 6:00 PM                | 120.00     | 64.7h  |
| `bfcfaf17` | DSS Thursday $5.50 NLH Turbo - 9 PM CT | 63.00      | 82.5h  |

The detector under-counts: it requires `lost_chair_at IS NOT NULL`, so it shows
one player for `8ec7e81d` where there are three. **Seven** roster rows are
stuck, not five.

Those seven are the only `pending` rows in `tournament_knockout_candidates` on
the whole platform - against 149,382 `eliminated` and 989 `rebought`. Every one
is a genuine bust with complete evidence: `stack_before > 0`, `stack_after = 0`,
a matching `hand_atomic_commits` receipt, a matching `hand_history` row, no live
seat, and a last seat holding nothing.

**Each event's last hand is the exact hand that created its stuck candidate.**
`bfcfaf17` dealt its last hand at 05:17:48.74 and the candidate was written at
05:17:48.82. `839f4ca3`: 06:15:03.16 and 06:15:03.21. The bust did not follow
the freeze; it _is_ the freeze.

## Four doors, and which one was actually shut

1. **`fn_ca_eliminate_absent_tournament_players`** refuses any player whose
   latest candidate is not `rebought`
   (`supabase/migrations/20260910072322_the_knockout_door_owns_every_bust_a_hand_took.sql`,
   lines 104 and 111). Its stated reason is that such a bust "belongs to
   `fn_eliminate_tournament_player_atomic`". But `pending` means the door has
   _not_ taken it. **This is a dead end, not the fix**: the sweep's cron row is
   `active=false` (retired deliberately in `20260910073355`), and the shape it
   writes - `status='eliminated'` with a NULL `position` - is now refused
   outright in a live event by the constraint trigger
   `tournament_elimination_has_a_place` (`20260910072351`). It cannot be
   revived, and reviving it is not the answer.

2. **`smarter_private.f06_source_guard`** raises `F06_SOURCE_EXCLUDED` on every
   roster or seat write to a table bound to an in-flight F06 table break. Two of
   the seven sit on such tables.

3. **`tournament_elimination_has_a_place`** is `DEFERRABLE INITIALLY DEFERRED`.
   A probe that ends in `RAISE EXCEPTION` never reaches commit, so this
   constraint never fires and the probe reports a success it has not earned.
   The probes here therefore run `SET CONSTRAINTS ALL IMMEDIATE` before the
   raise. (CLAUDE.md 10.86 rule 1: a check that answers when it cannot tell.)

4. **`fn_eliminate_tournament_player_atomic` - the knockout door - refuses
   nothing.** Probed in a rolled-back transaction with constraints forced
   immediate, it accepted all five reachable claims and returned the correct
   finishing place for each.

**The door is not the bug. Nothing is calling it.**

## The root cause

The knockout door has exactly one caller: the live engine that owns the
tournament. The only other caller that ever existed was retired on 2026-09-10
and cannot be revived, because the write shape it uses is now illegal.

So **since 2026-09-10 a bust the engine fails to record has had no recovery
path at all.** The engine does sweep itself once at adoption
(`requestEliminationSweep('engine.resume')`, added the same day for a related
stall), but that did not recover these: `839f4ca3` and `8ec7e81d` are _leased
and heartbeating right now_ - 0.1 minutes stale, instance `1-3846b8bb` - and
have not dealt in 57 and 64 hours. The other three hold no lease at all.

## What was settled

Migration `20260921160015_the_knockout_door_has_a_second_caller` drives the five
reachable busts through the platform's own idempotent door, in the bust
chronology the live engine recorded as it happened - the witness that was there
(CLAUDE.md 10.9) - each taking the place its own field count gives it:

```
Afternoon Free Buy (NLH) / 62ec986d  busted 09-18 22:12:05 -> place 12  prize 0.00
Midnight Free Buy (NLH)  / cd337e9e  busted 09-19 06:15:03 -> place 41  prize 0.00
$100 Freeroll - 6:00 PM  / 6fdfcb70  busted 09-18 23:04:55 -> place 67  prize 0.00
$100 Freeroll - 6:00 PM  / 8e5a0e02  busted 09-18 23:05:00 -> place 66  prize 0.00
$100 Freeroll - 6:00 PM  / fca1720a  busted 09-18 23:07:43 -> place 65  prize 0.00
```

All seven are horses. That changes nothing: they are recorded out exactly as a
human would be, at the same places, through the same door (law 10.5).

**No money moved.** Every one is an out-of-the-money mid-event bust, so the door
paid 0.00 and prize escrow is unchanged at 721.00. The migration asserts that
before and after and aborts if either moves. What changes is that three events
are no longer held open by an unranked player and can finish and pay themselves
by the normal path.

Four of the five events are **genuinely undecided** - 13, 64, 11 and 40 players
still hold real chips on the felt. Paying their escrow out now would be
inventing a result, and it was not done. One, `bfcfaf17`, is
**finished-but-unsettled**: a single player holds all 168,000 chips and the only
other roster row was the stuck bust.

## What is NOT settled, and why

`bfcfaf17/ed9ff9e2` and `5a387a75/6fa1c8e2`, holding **163.00**, sit on tables
bound to an F06 table break still in `park_requested`. `f06_source_guard`
refuses every write there - measured, the probe was refused - so no correctness
at the knockout door reaches them. Ending a half-completed table break is a
different authority and getting it wrong moves seated stacks, so they are left
untouched and visible rather than forced.

That is its own defect and a much larger one: **161 F06 operations are stuck
non-terminal platform-wide** - 153 `park_requested`, 8 `begun` - every one
created 2026-09-18/19, across ~150 distinct tables. `403` leased RUNNING events
with chipped seats have not dealt in over 24 hours, holding 35,328.55. The five
events in this item are a visible corner of that.

## Still to fix at root

The engine half. The adoption sweep exists and did not recover two events it
holds the lease on. Why it defers there is not established from rows yet, and a
change shipped without establishing it would be a guess. Named here rather than
patched over.
