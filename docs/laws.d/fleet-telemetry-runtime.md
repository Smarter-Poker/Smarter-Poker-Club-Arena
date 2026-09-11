# server/src/engine/FleetTelemetryRuntime.law.test.ts

Health and Prometheus read the same process-wide telemetry bank. Completed hand
counts never use database hand ordinals or sums over the surviving engine set;
recording and disposal preserve work completed between scrapes. Accepted human,
horse, fallback and automatic actions share one monotonic measurement boundary
around synchronous rule execution. Rejections, cancellations and HTTP replays
contribute no action; instrumentation failures never alter the action result.
Lifetime counters are distinct from bounded, aged samples. Empty or unmeasured
latency is unavailable, and sample count and monotonic age describe its evidence.
