# Throughput uses tables that can currently deal

At 18:50 UTC on September 13, `poker_active_tables` reported 574 tables while
the live liveness verdict had approximately 15 dealable tables. The served
`EngineTelemetry.getSnapshot()` counts tables with retained timing samples;
those samples do not expire with the table's eligibility to deal. The throughput
alert divided about 40 hands per minute by 574 and diagnosed a slow fleet.
The separate shortage of dealable tables was real, but that ratio did not
measure the rate of the tables still able to play. Event-loop p50 was 20.4 ms
and the equity governor scale was 1, so saturation was not established.

The alert now divides its five-minute hand count by the existing
`poker_dealable_tables` gauge averaged over the same interval. Its current
fleet-size gate uses that live gauge too. It retains the threshold of one hand
per table per minute, forty-minute pending duration and six-minute maintenance
guard. `HorseFleetCollapsed` still reports fewer than twenty dealable tables;
zero or small capacity cannot be called healthy because throughput is quiet.
No engine metric, dealer, counter, or gameplay behavior changes.

The new annotation describes the measured condition without asserting a cause.
A seven-day read of the candidate ratio outside maintenance, with more than
twenty currently dealable tables, contained 1,521 samples and a median of 2.149.
307 samples were below one. These samples were not independently classified as
healthy, and they do not prove historical incident causes.

## Verification

Ten cases execute the actual rule files with Prometheus 2.55.1's `promtool`:
historical idle tables, sustained low throughput and its pending boundary,
complete loss of hands, the independent small-fleet alert, zero or missing
capacity, labeled maintenance and its lookback, recovery, and counter reset.
The candidate passes; the predecessor fails the false-alert cases.

The probe runs offline in the existing pinned Prometheus image, with no network,
read-only mounted fixtures, a 256 MiB limit and one CPU. It creates and removes
only its own temporary directory and disposable container. It sends no alerts
and does not mutate the running monitoring stack. Required CI runs the same
test. A normal monitoring deployment and loaded-rule readback are still required
before the correction is considered published.

Prometheus documents the sample average and reset-aware counter functions in
[its query function reference](https://prometheus.io/docs/prometheus/latest/querying/functions/).
