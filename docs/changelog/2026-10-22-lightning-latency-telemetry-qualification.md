# R19 Latency Is Qualified From Production Telemetry

Release gate R19 (L40/L41) needs every one of the eight Lightning latency legs
to hold p95 under its configured ceiling across `alert_latency_windows`
consecutive closed windows with at least `alert_latency_min_samples` samples
each. Until now it was only exercised by one scripted browser player, which
yields 2-7 samples per leg per run and so could never reach the 20-sample
minimum.

The engine already persists real per-minute aggregates for every pilot Cluster
in `public.lightning_latency_window` (one `{n, p50, p95, p99}` per leg per
window). `scripts/ops/lightning-latency-qualification.mjs` reads those rows
read-only, through the maintained service-authorized reader
`fn_lightning_operator_cluster` (paged past its 60-row limit), together with
`fn_lightning_config`, for the Action and Madness private pilots, and emits a
deterministic JSON verdict per Cluster and per leg:

- PASS: the most recent run of `alert_latency_windows` consecutive closed
  windows where each window individually has `n >= alert_latency_min_samples`
  and p95 at or under the ceiling, with no later measured breach.
- FAIL: a window with enough samples above the ceiling after the latest
  qualifying run, reported with leg, window, n, p95 and ceiling.
- INSUFFICIENT: no traffic, too few samples, or no consecutive run.

Windows are never merged and percentiles are never averaged, because the table
stores per-window percentiles rather than histograms. Consecutive means
exactly adjacent windows; any telemetry gap breaks a run. Fold-type legs
(`fold_ack` and the three `*_to_next_hand` legs) count only windows in which
that fold happened, within one unbroken segment. Open windows and anything
outside the bounded lookback are excluded; malformed rows make the Cluster
UNKNOWN, never PASS.

It runs through the new dispatch-only `Lightning Latency Qualification`
workflow, and the existing pilot qualification report now carries each
target's `latencyQualification` with `R19_LATENCY_*` blockers. The gate
catalog and release documents name this verdict as the R19 evidence; the
browser latency witness remains an optional supplementary sample. No
migration, runtime or client change.
