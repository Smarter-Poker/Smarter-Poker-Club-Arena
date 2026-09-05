# 2026-09-05: the action-latency thresholds come from the measurement

Phase 1 shipped its alert thresholds before any data existed. The first hour
of real production data says they were wrong in both directions, and one of
them could have paged on a sample of one.

## What the fleet actually does

Engine `6688dea8`, first hour, 24.3 actions/sec across all four formats:

| p50    | p90     | p95     | p99     |
| ------ | ------- | ------- | ------- |
| 808 ms | 1541 ms | 1843 ms | 3755 ms |

Per format, p95: cash 1765 ms, hu_sng 1983 ms, mtt 1872 ms, spin 1912 ms -
so no format is an outlier, which is itself worth knowing.

## Two defects this exposed

**The thresholds were below normal.** Warning fired at 500 ms - below the
MEDIAN - and critical at 1500 ms, below the normal p95. Both would have been
permanently firing and muted within a day. That is precisely the failure this
programme keeps finding in other people's monitors, and I shipped it. Now
3000 ms (above the normal p95, below the normal p99) and 6000 ms
(unambiguous).

**A single action could raise an alarm.** The guard was `> 0`, so one human
action in a ten-minute window produced a p95 from a sample of one. On a
platform where humans are rare - 15 hours with a human seat in 14 days - that
is a false-alarm generator. The guard is now `> 0.05/s`, about 30 actions in
the window.

Both pinned by `theTableFeelIsMeasured` LAW 6, which asserts the warning sits
above the measured p95 and critical above the measured p99, so a future
threshold change has to re-measure rather than re-guess.

## The baseline is a finding, not an alert

**808 ms median from a player acting to every seat seeing it**, while the
event loop is healthy: p99 54 ms, equity governor at scale 1 and not
throttling. So this is not CPU starvation - it is structural pacing in the
broadcast path. That is worth characterising and is Phase 2 work; it is
deliberately NOT an alert, because a number nobody has explained yet should
not page anyone.
