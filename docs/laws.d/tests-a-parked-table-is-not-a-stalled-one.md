# tests/a-parked-table-is-not-a-stalled-one.law.test.ts

Time a table was told not to deal is not time it failed to deal (§13 rule 4,
applied to the progress clock). `releasePauseGate()` must credit
`markProgress()` when a pause ends, and both resume paths must funnel through
it, or the five-minute maintenance break is charged to every table on the
fleet the instant it lifts - measured 2026-09-05, the twelve largest stall
spikes of the day all landed in HH:00:07-HH:00:37 and 49.5% of every stalled
table-second sat in minute :00. `isPausedByDesign()` must name all four
authorities that stop a table on purpose, including `dealHoldUntilMs` compared
against now (never `> 0`, which would excuse a table forever after its first
Spin reveal), since a seat-first tournament is held between its seats selling
and its advertised start for as long as 3078 measured seconds. And every stall
filter must exclude a paused table, or the hourly `watchdog_kill_rebuild` wave
of #2651 returns on the next break.
