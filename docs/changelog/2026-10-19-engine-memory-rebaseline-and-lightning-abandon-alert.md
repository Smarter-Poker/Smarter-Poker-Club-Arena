# 2026-10-19: engine memory warning re-baselined; Lightning abandoned hands page

## EngineProcessMemoryHigh fired on nothing

engine-01 was resized at about 17:00 UTC on 2026-10-17 from 30.6 GiB to
61.3 GiB with 16 cores. The equity worker pool sizes itself from cores
(`availableParallelism() - 2`), so it grew from 6 to 14 workers and the
engine's resident memory grew with it. Measured from Prometheus over 52 hourly
windows (2026-10-17 18:00Z to 2026-10-19 22:00Z): hourly RSS maximum
4.85-6.82 GiB, typically 5.2-6.2 GiB, flat within each uptime, about 52 GiB of
the host still available. The 4 GiB line (set 2026-10-02 for a 1.7-2.9 GiB band
on the 16 GiB host) sat under every ordinary hour, so the warning was firing
continuously. The line is now 8 GiB, 1.2 GiB above the 52-hour peak, and the
runbook says to re-measure whenever the host or the worker count changes.

## Lightning settlement refusals paged nobody

On 2026-10-18 19:29-22:20 UTC 1,611 Lightning hands were abandoned with
`settlement_refused:physical_settlement_refused`, about 65% of that Cluster's
hands. The engine already counted them in `poker_lightning_hands_total{outcome}`
but no rule read the counter. `LightningHandsAbandoned` (critical) fires when
more than 10% of hand ends in 10 minutes are abandoned, with at least 20 hand
ends, for 5 minutes. Over the seven days measured the ordinary share was 0 in
every 10-minute window but two (worst 1.5%); the incident ran 12-68%.

Both rules have promtool cases in
`tests/monitoring/lightning-abandoned-and-engine-memory.test.yml`, run by
`scripts/ci/test-fleet-throughput.sh` in CI; the memory case fails against the
old 4 GiB line.
