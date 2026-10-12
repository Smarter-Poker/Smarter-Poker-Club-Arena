# The Spin backlog alert counts who is waiting, and a human's board fills first

`SpinUnfilledBacklog` (`poker_spin_unfilled_waits > 5`) sat at 12 to 66 all
night on 2026-10-02/03 and fired again at 11:00 UTC after the 10:55 restart.

## What production showed (2026-10-03, read-only)

- 8,835 Spins created 22:00-12:00 UTC; 8,832 started, the other 3 were
  still open at 12:00, none CANCELLED (so `fn_spin_expire_unfilled` refunded
  nothing because nothing reached its 30-minute policy). Creation to start:
  median ~250 s every hour.
- At 12:0x UTC the board held 47 REGISTERING Spins: 33 at 2/3 inside their
  human window, 14 held empty at 0/3, 2 past their window, oldest 5 minutes.
- Prometheus over 14 h: the gauge climbs from ~0 at :02 to 30-66 by :45 every
  hour. ~700 Spins/hour x the 90-350 s human window (Dan's rule: the last seat
  is a human's before a horse may take it) is ~40 boards at 2/3 at any instant.
  The count was the product working, not a backlog.
- The third horse arrives a median 11 s after the window closes. Every board
  more than 120 s late in the last three hours had its window close at
  :52-:55, inside the hourly platform freeze (CLAUDE.md 13), and filled after
  the thaw.
- No human sat at a Spin in those 14 hours. The 2026-10-02 18:40 human Spin
  was dealt 26 s after the seat. A held-empty probe today (test account,
  1-chip Spin, 0/3 board): full 8.5 s after the seat, RUNNING at 17.5 s.
- Fill refusals were real but not the cause of the count: "seat-first fill
  added nobody" lines (404 in the 10:56-11:56 log) were mostly races another
  lane had already won (`rpc_table_full=1`) or the :53 freeze; 35 lock
  timeouts and 7 "pool is thin" openings in that hour.

## What changed

1. **The alert measures what a player feels.** New `fn_spin_fill_waits()`
   (migration `20261003120909`) splits the partly filled population, read in
   the same `SpinMetrics` snapshot: `poker_spin_human_unfilled_waits`,
   `poker_spin_human_oldest_wait_seconds`, `poker_spin_unfilled_past_window`,
   `poker_spin_unfilled_oldest_wait_seconds`. A failed read is a failed
   refresh (SpinMetricsStale), never "nobody is waiting".
   - `SpinHumanWaitingForOpponents` (critical): a live human seat on a partly
     filled Spin has waited over 60 s.
   - `SpinUnfilledBacklog` now counts boards more than 120 s past their human
     window (> 5 for 20 m). Both carry the break guard.
2. **A human's board fills first.** The free horses were first come, first
   served: a board opener, a horse-only window-closed fill, an SNG or an MTT
   ramp could take the last free horse a waiting human needed, while the
   human's board asked every 12 s. Now the fast lane declares the seats a
   waiting human needs (`noteHumanSeatDemand`), every other `pickFreeHorses`
   claim leaves that many free (`humanSeatsOwed`, lapses after 45 s), and the
   human's own ask may take an active cash-lane horse and is not held to the
   cash-room floor (the freeroll precedent). A human on a board whose window
   had already closed used to be served by the horse-only path (backoff, no
   priority); who is seated is now read before the cadence is chosen, cached
   per paid-seat count so a board is asked once per change in its seats.
3. **Boards do not pile up.** The board is one open instance per price point
   (`ensureBoardOpen`), so the count is bounded by the price points, not by the
   pool; a board that cannot fill is cancelled and refunded through
   `fn_spin_expire_unfilled` -> `atomic_cancel_tournament` after 30 minutes.
   Neither changed.

`is_horse` is used only to identify who is in a seat and to steer the fleet
(CLAUDE.md 10.5); nothing is withheld from a horse.

Tests: `server/src/services/aHumansBoardFillsFirst.test.ts`,
`spinsAreObservable.law.test.ts`, `tests/unit/spinLoadedRuleContract.test.ts`
and the updated human-fill pins.
