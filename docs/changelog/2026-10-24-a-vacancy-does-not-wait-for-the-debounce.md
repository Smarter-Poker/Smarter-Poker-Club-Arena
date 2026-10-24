# A Main vacancy is planned at once, not after the 500 ms burst hold (2026-10-24)

#7900 closed the two races inside the two-second rest with a synchronous last
look before dealHand. It named one window it could not close: a Main seat
opening less than about 0.8 s before a feeder deals was planned after that
deal, because every wake waited `CLUSTER_WAKE_DEBOUNCE_MS` (500 ms) and then
the planner call (~0.3 s).

The hold exists to coalesce bursts: a feeder filling from the lobby, a break
moving four players, every table's hand completing. A seat opening is not a
burst. It is the one wake Dan's rule is about ("MAIN GAME MUST BE FED RIGHT
AWAY WHEN A SEAT OPENS UP ... NEXT HAND"). So `wakeClusterGame('seat_left')`
now wakes with `{ now: true }`:

- it skips the hold and replaces a held wake for the same game, so there is one planner call, not two;
- it still never overlaps an in-flight tick, and a vacancy arriving during one keeps its urgency for the tick that follows;
- every other reason is held exactly as before.

The remaining window is the planner call itself (about 0.3 s). Closing that
would mean waiting inside the rest, which
the-next-hand-deals-two-seconds-after-completion forbids.

Pins: `server/src/cluster/aCommittedPlanReachesItsFeederBeforeTheDeal.law.test.ts`
(four new cases fail without the change) and the wake-shape pins in
`TheTablesOpenAndCloseThemselves.law.test.ts`, moved in this commit.
