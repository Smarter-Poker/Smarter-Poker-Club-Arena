# A satellite that has busted nobody is not asked again under the whole finish lane (2026-10-03)

**Measured.** After the elimination scheduler stopped rationing sweeps (#5958),
every sweep of a cohort satellite asked `fn_get_satellite_qualifier_state` at
its finish stage. That read takes the satellite finish lane, which holds
`ca:tournament-finish-lane:v1` EXCLUSIVELY, so every ordinary Spin, Sit & Go
and MTT finish drains before it and queues behind it. 13:03-13:33 UTC: four
running cohort satellites with three eliminations in ten minutes asked ~6.7
times a minute (mean 3.3 s wait for the lane), and 96 finishes waited a mean
3.6 s behind them, against 12 and 17 in the half hour before.

**Fix.** Only a zero-stack hand can move a field toward its qualifier
boundary, and every such hand holds the boundary first (advancing its
generation). An authoritative `continuing` answer read while no boundary was
held, with the live field more than one player above the full-ticket count, is
reused for that generation for at most five minutes. Near the bubble, any held
boundary, `entry_open`, `unresolved`, an unreadable answer, or a settlement all
read under the lane exactly as before. No database change; no money path
changed.

**Regression.** `server/src/tournament/aSatelliteThatBustedNobodyIsNotAskedUnderTheWholeLane.law.test.ts`.
