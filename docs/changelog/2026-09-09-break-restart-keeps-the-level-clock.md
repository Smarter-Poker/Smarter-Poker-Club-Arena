# Tournament Levels Keep Their Remaining Time Across A Break Restart

An engine restart during a tournament break could consume blind-level time while players were paused. Repeated recovery also risked changing the timestamp used for the next restart.

Recovery now keeps the original timestamp and the remaining playing time until the recorded break ends, including overlapping add-on breaks. The existing break cadence, duration and level definitions are unchanged.

Verification: eight focused behavioral cases, 41 affected clock and lifecycle tests, and the server TypeScript check passed. Source publication and live engine adoption are tracked in the Phase 3 audit report.
