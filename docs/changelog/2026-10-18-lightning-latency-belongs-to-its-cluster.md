# Keep Lightning latency attached to its cluster

A player can play Action and Madness at the same time. The process-wide LightningMetrics idle map used only player ID, so an idle transition in one cluster overwrote the other cluster's fold timestamp and kind. A matched/dealt hand in one cluster could then consume the other cluster's record, misattribute its latency, or lose both samples. The two private pilots share participants, making this directly relevant to the observed missing and above-ceiling latency legs.

Key the bounded idle map by cluster and player, require callers to name their cluster (or explicit null for unattributed fleet measurements), and discard a stopped cluster's records without disturbing other clusters. Existing production callers already provide cluster IDs. Update the older aggregate fixture to supply the same context; its assertions remain unchanged. No money, matchmaking, timings, sample requirements or ceilings change.

All three new regressions fail on the original recorder. They independently check interleaved Action/Madness folds, a deal without a matching room record, and cluster shutdown cleanup. Post-deployment samples must be collected afresh; existing data is not rewritten and this source correction alone cannot qualify latency or public launch.
