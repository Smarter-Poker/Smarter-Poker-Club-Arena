# The felt decides who busted

2026-09-10. Five RUNNING tournaments were failing
`fn_tournament_chip_conservation_check`. **76,500 chips existed that nobody
bought**, 34 tournaments had been RUNNING for over six hours and could not end,
and 140 hands had been refused outright. All three are the same defect, and
none of them is a rounding residue.

## One ghost, three symptoms

`tournament_players` carries a `chips` column that MIRRORS the seat. The seat is
where the engine settles every hand; the mirror is a projection. Measured today,
**1,540 of 1,541** live tournament seats agree with their mirror exactly - so
the mirror is not systematically broken. It diverges when a tournament stalls
and settlement stops running, and two readers trusted it anyway.

**A player busts.** The felt goes to 0. The roster row keeps `status = 'playing'`
and a stale non-zero `chips`.

1. **The eliminator skips them.** `fn_ca_eliminate_absent_tournament_players`
   filtered on `COALESCE(p.chips,0) <= 0` - the mirror. Of 68 seatless players,
   **39 carried `chips > 0` there, 151,500 chips in total, while the highest
   stack they ever held on ANY seat in that tournament was zero.** They never
   held a chip. The sweep skipped precisely the rows whose mirror was wrong,
   which is why it has run every fifteen minutes, reported success every time,
   and repaired none of them.

   It had a second bug in the same predicate: `NOT EXISTS (... stack > 0)`
   tested every seat row, live or vacated, and a vacated seat keeps its stack
   for history. Anyone who had ever held chips was protected from elimination
   permanently. `611cf850` is both bugs at once - mirror 0, no live seat, and a
   vacated seat still showing 36,000.

2. **The tournament cannot end.** A roster row saying `playing` keeps the field
   open. 34 tournaments were stuck this way, holding undistributed prize pools -
   5,210.40 chips across the nine this change clears.

3. **The engine deals to a chair that does not exist,** so the hand is refused:
   `accepted tournament hand omitted written stack for 611cf850...`, **140 times
   across 4 tables**.

## And then the move mints

`fn_ca_assign_tournament_player_seat_locked` took the new seat's stack from the
same mirror:

```sql
IF v_tp.status = 'registered' THEN v_stack := starting_chips + chips;
ELSE                               v_stack := COALESCE(v_tp.chips, 0);
```

So a table consolidation wrote the mirror onto the felt. **Night Owl Special
b84f312f, from the engine's own hand records:** 256,000 + 128,000 = 384,000 at
18:01, exactly the 48 x 8,000 bought in. A move at 22:34:25 wrote **448,000**
over a felt of 256,000. One player has held 64,000 chips nobody bought ever
since, and the two players whose mirror read 0 were refused a seat entirely
(`player_stack_invalid`) and vanished from the felt: **+192,000 minted,
-128,000 destroyed, net +64,000** - the reported drift, to the chip.

## The fix: the mirror is no longer load-bearing

Both readers now read the felt, so the mirror can be as wrong as it likes and
no chips move.

- **The move reads the seat the player is leaving**, falling back to the mirror
  only when they hold no live seat at all.
- **The eliminator reads the seat they last left.** A player between tables
  mid-consolidation still has a non-zero last seat, so it cannot evict them -
  verified against Night Owl, where one player was seatless for 59 minutes
  holding 256,000 and is correctly untouched.

## And a gate, so the class cannot come back

Reading the right column is not enough on its own - the next defect would be a
different wrong input. **A seat assignment may move chips between chairs; it may
never raise a tournament's live total above what was bought in.**

A normal move cannot trip it: the player's own live seat is subtracted before
the new stack is added back, so the total is unchanged **by construction**. It
fires only when seating someone would ADD chips beyond the cap. An existing
overage is tolerated (history) and refused only from growing (the future) - the
same shape as this estate's `NOT VALID` constraints, and it means the three
tournaments already over cap are not stranded by their own overage.

## Measured before shipping, in a transaction that was rolled back

```
roster playing 1270 -> 1212   (58 eliminated)
WRONGLY_EVICTED_HOLDING_CHIPS = 0
field_protected 0   refused_by_zero_chip_guard 0
```

Nobody holding chips on the felt is touched. The existing 76,500 is left where
it is: tournament chips are scoring units, the prize pool is fixed by buy-ins
and unaffected by chip counts, and 10.9 rule 3 forbids taking chips back from a
player for our own defect.

## What this is not

No repair job, no backfill, no sweep, and nothing scheduled (10.12). The two
functions that read the wrong column now read the right one, and a gate makes
the failure mode impossible rather than detectable.
