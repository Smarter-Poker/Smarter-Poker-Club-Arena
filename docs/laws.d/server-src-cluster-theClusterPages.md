# server/src/cluster/theClusterPages.law.test.ts

The cluster controller pages: every pass lands in the always-on registry (never the ENGINE_METRICS-gated one), a frozen tick is a skip and not a pass, a released latch is counted, the `cluster` alert group in alert-rules.yml has its seven rules each carrying the break guard with `on()` and reading only metrics the engine emits, critical and warning route to a delivering receiver, and /health publishes the last pass under `cluster` (null off-leader)
