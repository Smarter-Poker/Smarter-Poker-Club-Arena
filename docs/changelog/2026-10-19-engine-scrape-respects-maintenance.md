# Engine scrape failures respect the matching engine's maintenance break

The owner's screenshot showed EngineDown as Tables Have Stopped Dealing.
Operational events prove firings at 13:56:31, 13:59:16 and 16:56:46 UTC on
October 19, each subsequently resolved. Prometheus history confirms scheduled
maintenance. The legacy EngineDown queried only up==0, so a certified cutover
was treated as an outage. Its EngineScrapeDown twin already had a lookback but
matched every label implicitly, allowing extra producer labels to defeat it.

Both original rule owners now match their six-minute maintenance lookback on
job and instance. This preserves missing-metric fail-open alerting, post-break
outage alerting and isolation between engines. It does not restart the engine
or change its maintenance authority. The legacy description now identifies
the actual metrics scrape rather than the retired pm2 process.

Real Prometheus 2.55.1 evaluation fails on the preimage (both alerts fire during
the labelled break) and passes after the correction. Four retained cases cover
the scrape gap, absent maintenance series, prolonged outage and another
engine's break. The existing required SLO CI step executes the new fixture.
