# Hand-gap verification and remaining outliers

## Production verification, 2026-09-08 UTC

The normal 12:55 engine restart adopted e142d385, which contains #3731
(fe0af90b55), the unchanged-time-bank request optimization. All 226 tables
completed the eight resume waves. No forced restart was used.

Before adoption, a 106-second sample ending 12:50:29 on e692442a measured
sync_stacks means of 1898 ms cash, 1969 ms heads-up SNG, 1797 ms Spin,
and 2094 ms MTT. The rolling hand-gap median was 4067 ms and p90 6485 ms.

After adoption, a 169-second interval from approximately 13:04:47 to 13:07:36
on e142d385 measured sync_stacks means of 781 ms cash (319 calls), 749 ms
heads-up SNG (182), 701 ms Spin (557), and 811 ms MTT (409). Hand-history
means in the same interval were 724-784 ms. All those counter labels were
horse audience; these are fleet observations, not controlled human trials.
Other changes and load varied across the restart, so this is not an isolated
causal benchmark of #3731.

The later rolling 2000-sample health window had p50 2004 ms, p90 3716 ms,
maximum 20262 ms and 480 non-rebuy gaps exceeding 2500 ms. Rebuy pauses
are already excluded from these percentiles and maximum. The long outliers
therefore remain unresolved; the median is not evidence of complete repair.

## Diagnostic change

NextHandGapRecorder already retains table ID, timestamp and per-phase times
for at most 2000 hands within ten minutes, but its health snapshot discarded
the correlation and reported only phase medians. It now includes phase p90
and the five slowest over-budget non-rebuy samples with their own phase
breakdowns. This uses the existing bounded memory and health endpoint, adds
no database round trip or per-hand log, and includes no player identity,
cards, tokens or financial contents. Phase percentiles must not be summed:
they can describe different hands. Returned phase objects are copied.

Tests cover empty state, correct correlated phases, response bound, ordering,
threshold, rebuy exclusion, age expiry and snapshot mutation isolation.
This diagnostic change does not shorten a hand or bypass settlement. Its
production adoption must be checked after the next normal engine release.

Remaining investigation includes settlement tail latency, tournament chip
read/RPC sequencing, seat cleanup and move announcement waits, and physical
network-loss/recovery across all game formats. The maintenance thaw and
resume-wave delay also needs a durable reconnect-deadline audit.
