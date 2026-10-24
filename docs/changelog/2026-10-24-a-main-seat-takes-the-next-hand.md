# A Main seat takes the next hand, even when it opens under the rest (2026-10-24)

## What Dan asked

"MAIN GAME MUST BE FED RIGHT AWAY WHEN A SEAT OPENS UP. THERE SHOUDN'T BE A
DELAY, NEXT HAND, PLAYER GOES TO THE MAIN GAME." (2026-10-23)

## What was measured live

#7873 (merged as 59413e39, live since c485ce7a at the 04:00 Chicago break on
2026-10-24) moved an ordinary must-move to the first completed feeder
boundary. Natural moves before and after, from `cash_seat_moves`,
`cash_seat_move_receipts` and `hand_history`:

|                             | d936 (3 h before) | c485ce7a (09:05-09:11 UTC) |
| --------------------------- | ----------------- | -------------------------- |
| played an extra feeder hand | 47 / 54 (87%)     | 2 / 18 (11%)               |
| plan to receipt, mean / max | 59 s / 148 s      | 23 s / 62 s                |

The remaining cases were all one shape. The dealing loop reads pending moves
(announcePendingSeatMoves) and the roster (prepareNextHand) at the start of
the two-second rest, then waits out the rest and deals.

- 1440caa7: planned 09:08:06.078, feeder dealt 09:08:06.964 with the player
  in it. 4f1e32f4: planned 09:10:28.473, dealt 09:10:29.666.
- 0152cb45: arrived at Main 09:09:31.486, Main dealt 09:09:32.298 without
  them. 1440caa7: arrived 09:08:32.778, Main dealt 09:08:34.149 without them.
  Both were dealt the hand after.

## The fix

The planner (ClusterController), every feeder and every Main run in one engine
process, and the rest law forbids anything that waits between the rest and
dealHand. So `server/src/cluster/seatBoundarySignals.ts` keeps two in-process
counters: plans per game (bumped the moment a pass or a wake returns a
committed `moves_planned`) and arrivals per table (bumped by the source
executor the moment a transfer lands). The loop captures both before its reads
and compares them synchronously immediately before dealHand. If either moved,
it goes round once more: the feeder executes the move instead of dealing, and
Main adopts the arrival into the hand it is about to deal. An ordinary deal
compares two numbers and waits for nothing.

Plans are counted per game because the planner reports a count, not a table.
At a few plans per game per hour, an uninvolved feeder re-reads on well under
1% of its deals.

## What is still not covered

A Main seat that opens less than about 0.8 s before a feeder deals (the wake
debounce plus the planner call) is planned after that deal and lands at the end
of that hand, exactly as before. Closing that would mean waiting on the
planner inside the rest, which the rest law forbids.
