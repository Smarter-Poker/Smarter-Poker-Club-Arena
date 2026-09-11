# A tournament chip grant cannot mint (2026-09-11)

`ca_drift_incidents` `8b8fe26c-f2f9-458f-a275-a19508b55b58`, warning, open
since 2026-09-09 19:52, 43 occurrences, past target. Two RUNNING tournaments
held more chips on the felt than they had ever issued.

| tournament | name                      |  expected |    actual |       drift |
| ---------- | ------------------------- | --------: | --------: | ----------: |
| `7aa16fa7` | $100 Freeroll - 12:00 PM  | 2,505,000 | 2,515,000 | **+10,000** |
| `a5aa6984` | Early Bird Freeroll (NLH) |   317,500 |   320,000 |  **+2,500** |

Both overages are exact multiples of the event's own starting stack, 2 x 5,000
and 1 x 2,500. That is the signature of a chip GRANT. Play cannot produce it:
play moves chips between seats and leaves the total alone.

## What was ruled out, with the evidence

**The chip race is innocent.** `CHIP_RACE_ENABLED = false` at
`server/src/tournament/TournamentManagerBase.ts:4629`, disabled 2026-07-19
after two audits found it corrupting chip integrity. The block is unreachable,
so `ChipRaceEngine`'s own minimum-denomination floor never ran.

**Duplicate seats, orphan seats and miscounted rebuys are innocent.** No user
holds more than one live seat in either event, no live seat belongs to a user
without a `tournament_players` row, and `chip_ledger` carries exactly 116 and
27 `rebuy` legs against roster counters of 116 and 27. There are no `addon`
legs and no `tournament_buyin` legs; both events are freerolls.

## Where the chips were created

Read from `ca_tournament_conservation_samples`, the ten-minute series the
conservation sweep keeps for seven days, rather than inferred:

```
a5aa6984  2026-09-09 18:00  -22,500  ->  18:10   +2,500   (+25,000)
7aa16fa7  2026-09-09 22:40 -105,000  ->  22:50  +10,000  (+115,000)
```

Each jump is a whole number of starting stacks. Each lands in a window in
which the field was being re-created wholesale after it had been torn down:
`7aa16fa7` had 29 seats inserted across 7 tables in ONE transaction at
`2026-09-09 22:39:42.210959`, identical to the microsecond, which only happens
when `joined_at` takes its `now()` default inside a single transaction. Both
events also received a batch at `2026-09-09 22:34:25.081124` - the same instant
already named in `fn_ca_assign_tournament_player_seat_locked`'s 2026-09-10
note about Night Owl Special `b84f312f`, where "a move at 22:34:25 wrote
448,000 over a felt of 256,000".

So the class is a tournament seat funded from the `tournament_players.chips`
MIRROR instead of from the felt. **That half was already fixed**, by another
agent on 2026-09-10, inside `fn_ca_assign_tournament_player_seat_locked` ("THE
FELT IS THE BANK ON A MOVE"), together with a per-assignment conservation gate
and the `a0_tournament_live_seat_root_guard` trigger that now refuses any
tournament live-seat acquisition not holding the event's exclusive lane.
Nothing in this change touches that work.

## What was still open

Chips enter a tournament in exactly two ways. Surveyed against the live
catalogue on 2026-09-11:

- **a live seat APPEARS holding chips.** `a0_tournament_live_seat_root_guard`
  forces every such write through a canonical RPC.
  `fn_ca_assign_tournament_player_seat_locked` carries the 2026-09-10 gate;
  `fn_move_tournament_player` conserves by construction - it zeroes the source,
  carries `v_source.stack` to the destination, and asserts the roster mirror
  agrees within 0.5.
- **an existing seat's stack is RAISED.** That trigger fires on INSERT and on
  `UPDATE OF table_id, user_id, seat_number, left_at`. **It never fires on
  `stack`.** The one statement that deliberately raises a tournament seat stack
  is `fn_ca_process_tournament_chip_purchase_money_v1`, the money core behind
  `process_tournament_rebuy` for rebuy, re-entry and add-on. **It had no
  conservation check of any kind.** Hand settlement also writes stacks, but it
  redistributes within a table and cannot raise the event total.

The door where chips are BOUGHT was the one door with nothing checking how many
chips existed afterwards.

## The fix

Migration `20260911145935_a_tournament_chip_grant_cannot_mint.sql`, applied to
production as `20260911150515`.

**The invariant, written once.** `sum(live table_seats.stack) <= chips the
roster has bought` is true at every instant, mid-hand included: chips in a pot
have left the stacks, so the felt can be at or below the supply and never above
it. `fn_ca_assert_tournament_chip_grant(tournament, user, seat, new_stack,
source)` subtracts the seat's current stack, adds the intended one, and refuses
when the result both GROWS the felt and exceeds
`fn_ca_tournament_chip_supply`. An inherited overage is tolerated and only
growth is refused - the same shape as the 2026-09-10 gate and this estate's
NOT VALID constraints - so the two events above keep playing and simply cannot
get further over.

Guarding one door at a time is how this happened, so the rule is a function
every future door can call rather than a paragraph copied into each one.

**The money core calls it**, before it writes the stack, with the roster
update already booked so the cap being measured against already contains the
chips being bought. A raise unwinds the wallet debit with it; that is this
function's existing idiom, which already says "Aborting So No Charge Is Made"
in three places.

**A second defect, same statement.** The re-entry branch REPLACES the seat
stack (`stack = v_add`) while the roster gains `rebuys + 1`, so the checker's
expected side gains `rebuy_chips` at the same moment. Taken while the entry
still holds chips it destroys them and inflates expected together. The rebuy
branch has guarded this since it was written ("Stack too high for a rebuy");
re-entry never did. It does now.

**The checker and the guard share one definition of supply.**
`fn_tournament_chip_conservation_check` computed the entitlement inline with
`COALESCE(rebuy_chips,0)`, while the grant computes it with
`COALESCE(NULLIF(rebuy_chips,0), starting_chips, 0)`. A tournament offering
rebuys with `rebuy_chips = 0` would have been GRANTED a starting stack per
rebuy and CHECKED against zero: guaranteed drift with no defect behind it.
Measured before writing: **0 of 154,372 tournaments** are in that state, so
this changes no live number, and the migration asserts exactly that before it
commits. `p_tolerance_per_player` is untouched at 1 and is pinned by the law,
because raising it is the cheap way to make an alarm stop and is not a fix.

## Disposition of the 12,500 already on the felt

**Left alone, deliberately.** Both events are RUNNING with real players holding
those chips: `7aa16fa7` has four live seats holding 1,101,480 / 900,000 /
265,000 / 248,520, and `a5aa6984` has one holding 320,000. Rewriting a live
seat stack to make a checker balance is money in flight, and CLAUDE.md 10.9
rule 3 is explicit that overpay our own defect caused is absorbed and left
alone rather than clawed back.

The correct disposition, when each event finishes: the prize pool is funded by
entries and is unaffected by chip counts, so no player is paid more because of
this. Chips on the felt decide FINISHING ORDER, not money - and the 12,500 has
been in circulation between those players for two days, so it is already part
of the order they played out. Settle both events on the recorded order through
`fn_tournament_payout_reconcile`, and record the residual against
`tournament_conservation_baseline`, which exists precisely to carry an
acknowledged pre-fix mint as one auditable row per event rather than a date
comparison that silently forgives whatever falls the right side of it. That is
a settlement decision for whoever closes these events and is not taken here,
because neither event is finished.

**The incident stays OPEN.** Its `root_cause` is now recorded on the row. A
guard that resolves the alarm it was written for, while the chips are still on
the felt, is the failure this whole class is about.

## What could not be proved

The exact statement that wrote the 10,000 and the 2,500 is not recoverable.
`table_seats.stack` is mutated in place and no history of it is retained, the
`ca_seat_stack_rebases` log carries only 7 rows for these two events (all on
2026-09-08, all correctly adopting a rebuy in flight), and neither ten-minute
window contains hand rows that bracket the whole field. What is proved is the
window, the exact-multiple-of-a-starting-stack signature, the re-seating event
inside each window, and that the seat-assignment half of that class was fixed
on 2026-09-10. The chip-purchase door was ungated on 2026-09-11 and is not any
more.
