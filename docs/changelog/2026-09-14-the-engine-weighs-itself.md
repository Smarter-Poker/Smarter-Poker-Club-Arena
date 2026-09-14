# The engine reports memory and caps main-isolate HTTP connections

2026-09-14. Engine only; no client change, no migration.

## What was wrong

Three facts, none of which the platform could see:

1. **The release train was being refused for memory.** `auto-deploy-hetzner.yml`
   builds the next engine image on the engine host itself and refuses below
   1179648 KiB available (`server/scripts/build-engine-image.sh`). On the
   night of 2026-09-13 it was refused 11 of 14 times:
   `insufficient memory headroom for the bounded engine build
(available=505480KiB, required=1179648KiB)`. Every engine fix merged that
   night sat staged and unshipped.
2. **The engine was the weight, and it grew every hour it ran.** Read on the
   box: ~600 MiB RSS at boot, 1640 MiB after sixty minutes, 2097 MiB after
   ninety (10:27 UTC, pid uptime 5501 s). The host has 3819 MiB; its other
   residents hold ~1060 MiB; so a build fits only while the engine is under
   ~1600 MiB, which is roughly one hour after any restart. In the last 24 h,
   631 of 1438 minutes were below the build requirement, 83 minutes were
   below 256 MiB available, the floor was 80 MiB (04:08 UTC), and on
   2026-09-12 06:21:57 UTC the kernel OOM-killed the engine outright
   (`dmesg`: `Out of memory: Killed process 1159833 (node)`) - no SIGTERM,
   no `drainHands`, every table gone mid-hand.
3. **Nothing published any of it.** `/metrics` was 1,134 lines and not one
   was the process's own memory; `/health` had the event-loop governors and
   the lease diagnostics and no RSS. The only series that moved was
   node_exporter's `node_memory_MemAvailable_bytes`, which cannot say whether
   the growth is the engine, a worker or the page cache. Every number above
   came from an SSH session.

## Observations And Working Hypothesis

The incident author reported main-isolate `heapUsed` in a 400-800 MB band
while whole-process RSS grew, and `[heap]` measurements increasing from
378 MB to 501 MB, including +111 MB around the 10:07 UTC tournament storm.
These are reported observations, not an allocation profile identifying TLS
or excluding other native allocations and worker-isolate heaps.

The default fetch pool was reported as uncapped with a four-second keep-alive.
A 10:33 UTC network-namespace snapshot counted 240 established HTTPS sockets
and 1,674 TIME-WAIT sockets; the storm had 3,800 TIME-WAIT sockets. These counts
indicate churn, but one snapshot does not measure TLS handshakes per second,
prove that nearly every request opened a connection, or establish an all-day
rate. TIME-WAIT is historical TCP state, not live userspace TLS allocation.

TLS allocation and glibc fragmentation are plausible contributors to RSS
growth. `[heap]` virtual extent, RSS and heap usage are different measurements;
correlation with a storm cannot establish the allocation cause. glibc can
release whole free pages with madvise as well as shrink the top of a heap,
so extent is neither a historical maximum nor a substitute for resident size.
A flatter post-release graph would support the hypothesis, not prove it.

The investigation's inspector `Runtime.queryObjects` probe paused live work
and fenced roughly 750 managers according to the incident report. Never repeat
that probe on the live engine. Use published measurements and representative
replica validation; this change does not claim a complete memory-leak repair.

## What changed

### The engine publishes its own memory (`server/src/observability/processMemory.ts`)

Eight always-on gauges on `/metrics`, refreshed from one five-second-cached
sample of `process.memoryUsage()`, `/proc/self/status` and the `[heap]` line
of `/proc/self/maps` (current virtual extent, not per-mapping RSS or native
allocation ownership). No inspector API, allocation profile or smaps read is
used. These reads are synchronous: the five-second cache bounds frequency,
not duration, and Node documents that memoryUsage() may iterate pages.
Sampler latency and event-loop impact need representative replica measurement.

| series                                 | what it is                                            |
| -------------------------------------- | ----------------------------------------------------- |
| `poker_engine_process_rss_bytes`       | the whole process, every isolate and arena            |
| `poker_engine_heap_used_bytes`         | V8 main isolate, in use                               |
| `poker_engine_heap_total_bytes`        | V8 main isolate, committed                            |
| `poker_engine_external_bytes`          | Buffers and bound C++ objects V8 accounts for         |
| `poker_engine_array_buffers_bytes`     | ArrayBuffer backing stores                            |
| `poker_engine_native_main_arena_bytes` | current `[heap]` virtual extent; not RSS or ownership |
| `poker_engine_rss_anon_bytes`          | anonymous RSS                                         |
| `poker_engine_threads`                 | OS threads (worker isolates, libuv, V8 helpers)       |

The `/proc` series are `-1` where `/proc` is unreadable, never absent. They
are published from the first scrape (the always-on registry, per the law
`anAlertCannotWaitForAFailureToExist`). `/health` carries the same numbers in
megabytes as `memory`.

### The fetch pool is bounded (`server/src/services/httpDispatcher.ts`)

One undici `Agent` for the main engine isolate, built from Node's existing constructor
(the same class Node's fetch was written against; no npm `undici`, no second
copy with a different handler protocol), installed by the first import of
`server/src/index.ts`:

    connections      : ENGINE_HTTP_MAX_CONNECTIONS   default 128 per origin
    keepAliveTimeout : ENGINE_HTTP_KEEPALIVE_MS      default 30 000

The cap limits connections per origin in this isolate. Queued Supabase calls
remain subject to the existing per-attempt deadline, including body drain.
It does not bound queued request memory, other origins, workers or native RSS.
The longer keep-alive is intended to reduce churn; the incident reported an
idle upstream connection surviving at least 150 seconds without a keep-alive
hint. Confirm actual socket reuse and memory behavior under comparable workload.
The global symbol and constructor-name check depend on runtime implementation
details, so exact production Node-image qualification remains necessary.

The outcome is reported, never assumed: `/health.httpDispatcher` reads
`{ bounded, connectionsPerOrigin, keepAliveTimeoutMs, reason }`. A runtime
whose default dispatcher is not undici's `Agent`, or a slot that refuses the
assignment, leaves the process on the default AND says so. An env override
that is not a positive integer keeps the default and is named in `reason`.

### Three alerts (`infra/monitoring/alert-rules.yml`, group `engine-memory`)

Thresholds derived, measurement beside each:

- `EngineHostNearOOM` (critical): `MemAvailable{engine-01} < 256 MiB` for 2m.
  Above the 80 MiB floor reached, below the build need; the 2026-09-12 OOM
  kill is what it is for.
- `EngineBuildHeadroomLost` (warning): `MemAvailable{engine-01} < 1179648 KiB`
  for 30m. The build gate's exact number.
- `EngineProcessMemoryHigh` (warning): `poker_engine_process_rss_bytes >
1.6 GiB` for 15m. 3819 - ~1060 residents - 1152 build.

None carries the maintenance-break guard: the break does not change what the
process weighs, and the restart inside it lowers pressure. All three point at
`docs/runbooks/engine-memory.md`, which exists, and which says what to read
to tell native growth from heap growth from thread growth.

### Two dashboard panels (`grafana-dashboards/poker-engine.json`)

"Engine process memory" (rss, heap used/total, native main arena, external)
and "Build headroom" (available against the build line and the near-OOM line).
The existing "Engine memory (engine-01)" panel is host percent and stays.

## Tests

- `server/src/observability/processMemory.test.ts`: the sampler, the cache,
  the health block's rounding and nulls, and that every gauge has a series at
  import and a scrape publishes the live sample.
- `server/src/services/theEngineOpensABoundedNumberOfConnections.law.test.ts`
  (`docs/laws.d/server-src-services-theEngineOpensABoundedNumberOfConnections.md`):
  env parsing, install against a stand-in runtime (replaces, refuses a
  non-Agent, refuses a dispatch-less Agent, names refused overrides), the
  installer is the first import of `index.ts`, `/health` publishes the
  report, and - against a real loopback origin with no keep-alive hint - a
  200 ms keep-alive reopens on every 450 ms gap while the 30 s default holds
  one socket, and six overlapping requests open at most `cap` sockets.
  Passed under Node 20.20 (undici 6.24) and Node 24.15 (undici 7); CI runs
  Node 22 (the engine's undici 6.28).
- The monitoring laws (`what-a-monitor-reads-is-what-the-repo-says`,
  `an-alert-that-names-a-metric-has-something-that-emits-it`,
  `an-alert-that-is-live-is-in-the-repo`, `realtime-capacity-alerts`,
  `law-registry`) and `scripts/ci/check-monitoring-drift.mjs` pass with the
  new group, runbook and panels.

## After merge

1. The engine release train ships the code at the next :55 break that has
   headroom; `/health.httpDispatcher.bounded` must read `true` and
   `/health.memory` must be populated on the new SHA.
2. On engine-01: `bash infra/monitoring/deploy.sh`, then
   `curl -s localhost:9090/api/v1/rules | grep -c EngineHostNearOOM` must be
   non-zero (CLAUDE.md 10.84: a rule is live when Prometheus says so).
3. Then the number to watch is `poker_engine_native_main_arena_bytes` across
   a :00 thaw and a tournament re-admission storm alongside RSS, worker activity,
   request deadlines and connection churn. Compare similar workload periods.
   A flat virtual extent is not proof of the TLS hypothesis or a memory fix;
   continued RSS growth requires further investigation on a representative replica.

## The incident this investigation caused

Disclosed here because it is part of the record. At 10:07:09 UTC on
2026-09-14, while looking for the growth, I ran an inspector
`Runtime.queryObjects` probe against the live engine to count object
prototypes. It walks the full heap and it paused the process long enough that
~750 tournament managers lost their lease proofs ("lease generation is no
longer current"), their engines called `killForRestart`, and `activeTables`
fell from 1696 to 974 before the fleet re-adopted. No tournament was
cancelled, no money moved wrongly, and the recovery was the ordinary restart
path (seven `atomic_finish_refused` alerts, as on any restart), but real
players saw their tables restart. I stopped invasive probes at that point, and
the sampler avoids those invasive APIs. Its cached synchronous reads still
need latency qualification; read-only does not mean unable to pause live work.
