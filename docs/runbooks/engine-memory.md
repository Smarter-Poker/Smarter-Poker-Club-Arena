# Engine Memory

Use this runbook for `EngineHostNearOOM`, `EngineBuildHeadroomLost` and
`EngineProcessMemoryHigh` in the `engine-memory` group. They observe pressure;
none initiates, advances, retries or certifies a release or a restart.

## Current provider route and thresholds

The restored flow uses protected GitHub checks and the original Hetzner engine
publisher. `server/scripts/build-engine-image.sh` builds the engine image on
`engine-01`. Its existing gate requires **1179648 KiB available** at the actual
build attempt: `BUILD_MEMORY_BYTES=939524096` (896 MiB) plus
`BUILD_RESERVE_KIB=262144` (256 MiB), totaling **1207959552 bytes / 1152 MiB**.
Keep that gate and all publication, maintenance, lease and financial safeguards.
Retired local/custom pipelines remain unavailable under the shared owner policy.

- `EngineHostNearOOM`: host MemAvailable below 256 MiB for two minutes, critical.
- `EngineBuildHeadroomLost`: host MemAvailable below 1152 MiB for thirty minutes,
  warning. It reports sustained pressure relative to the current on-host build
  gate; conditions can change before the next authorized attempt.
- `EngineProcessMemoryHigh`: engine RSS above 1717986918 bytes (approximately
  1.6 GiB) for fifteen minutes, warning. This retained historical threshold is
  not a process cap, a precise current build-fit calculation or proof of a leak.

The September 13/14 incident recorded a roughly 3819 MiB host, approximately
1060 MiB of other residents, rising engine RSS and repeated refused builds.
Those measurements explain the historical thresholds; they are not a current
inventory, a future process budget or demonstrated allocation ownership.
Re-measure through approved observation before proposing threshold changes.

## Read the observations together

Bind the installed release and process identity before interpreting `/health`
or `/metrics`. The host job is `node_engine01` with `host="engine-01"`; the
existing engine scrape job is `engine_game_server`.

```promql
node_memory_MemAvailable_bytes{host="engine-01"}
poker_engine_process_rss_bytes
poker_engine_heap_used_bytes
poker_engine_heap_total_bytes
poker_engine_external_bytes
poker_engine_array_buffers_bytes
poker_engine_native_main_arena_bytes
poker_engine_rss_anon_bytes
poker_engine_threads
```

The engine's `/health.memory` block reports rounded decimal MB and thread count;
Prometheus reports bytes and thread count. Unavailable `/proc` observations are
`-1` in the sampler/metrics and `null` in health. An absent block or series means
unknown, not zero use or successful installation. Source and a merged commit
alone do not prove the running process emits these metrics.

Whole-process RSS includes every isolate and arena. V8 heap and external-memory
fields describe the main isolate. The legacy `nativeMainArenaBytes` name measures
only the current Linux `[heap]` virtual mapping extent: it is not per-mapping
RSS, allocated bytes, a historical maximum or proof of main-thread/TLS ownership.
Inspect RSS, anonymous RSS and worker activity separately. Threads also include
libuv and V8 helpers; external memory includes C++ objects and buffers. A growing
series can guide investigation but does not independently establish a leak.

## The bounded fetch pool

`server/src/services/httpDispatcher.ts` (first import of `server/src/index.ts`)
installs one undici Agent for the main isolate: `connections=128` per origin
and a 30-second keep-alive, overridable through `ENGINE_HTTP_MAX_CONNECTIONS`
and `ENGINE_HTTP_KEEPALIVE_MS`. `/health.httpDispatcher` reports the last
installation: `bounded`, `connectionsPerOrigin`, `keepAliveTimeoutMs` and a
`reason` when the bound did not go in (the process then runs on the runtime
default and says so). The report is an installation result, not a live socket
count or a memory proof.

Confirm churn on the box, read-only, from the engine's network namespace:

```bash
PID=$(docker inspect -f '{{.State.Pid}}' club-arena-engine)
nsenter -t "$PID" -n ss -tan | awk '{print $1}' | sort | uniq -c
```

Hundreds of `ESTAB` to :443 and thousands of `TIME-WAIT` in a quiet minute
(the 2026-09-14 reading was 240 and 1,674) means the bound is not in effect.
Compare RSS, anonymous RSS and `[heap]` extent across comparable periods before
and after the bound before attributing a memory change to it.

## Recovery and measurement limits

A memory drop or alert recovery proves only that a threshold cleared. Maintenance
time alone is not restart authority. Follow the existing owner-approved incident
and protected release lifecycle, with exact drain, lease, journal and rollback
evidence. Never use a bare restart to make an alert green. Critical pressure
requires fresh measurements and the established incident response authority.

Compare other resident processes before attributing pressure to the engine.
Do not kill another service merely to create room. `MemAvailable` already accounts
for reclaimable cache. Missing sampler data cannot identify an allocation owner.
Changing the builder memory limit/reserve does not repair runtime retention;
`--max-old-space-size` does not cap native or whole-process RSS. Do not add a cron,
watcher or restart/release repair loop to clear these alerts.

The existing sampler reads `process.memoryUsage()`, `/proc/self/status` and
`/proc/self/maps`, cached for five seconds. This limits frequency, not latency.
It uses no inspector, heap snapshot, `Runtime.queryObjects` or `smaps`. Do not
run live heap traversals: historical probes paused lease renewals. Sampler latency
and event-loop impact require representative isolated qualification before any
cost-bound claim; use already-published observations for production verification.

## Source and verification provenance

The memory implementation originated in `77df88a1eec912b4bfa8be321c6e86bf2f55bf22`,
with corrected measurement semantics in `b2b0988f8232f78a49dee44e63cf21c438078da2`,
merged as `3a6cb22d38f17690a54c01ff3965a14936e2831d` (PR 4631). This selection
retains its memory sampler, direct tests, scrape/health wiring and alert identities.
The independent HTTP queue/dispatcher implementation is outside this selection.
The missing-data and recovery distinctions from `5ad105ebcc5e2101dad39cbdf497cb4e42ff93bd`
are retained with wording corrected for the restored on-host build route.

Required evidence remains separate: hosted sampler/server tests and monitoring
contracts; protected merge and original engine/monitoring publishers; exact live
release/process identity; emitted series and health block; loaded rule expressions,
labels and durations; Grafana panels. A loaded rule alone does not prove delivery
of an actual notification. Do not manufacture a production memory incident to
qualify this observability change.
