# The engine weighs itself, and stops opening a TLS session per request

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

## Where the growth was

Not the V8 heap. Across the readings the main isolate's `heapUsed` sat between
400 and 800 MB and returned to the same band after every GC while RSS climbed.
The delta was glibc's **main arena** - the `[heap]` (brk) mapping in
`/proc/self/smaps`, which is native memory allocated on the main thread and
which V8 never uses: 378 MB at boot+60m, 501 MB at boot+90m, **+111 MB inside
the seven minutes of the 10:07 UTC tournament re-admission storm**, flat in
quiet minutes. The 64 MB-aligned secondary arenas (worker threads) held a
further ~155 MB and did not move.

What allocates natively, on the main thread, in bursts that track tournament
storms? The engine's HTTPS traffic. Every Supabase call goes through Node's
global `fetch`, and Node's fetch goes through one process-wide undici `Agent`
that nothing had ever configured. Its defaults: **no per-origin connection cap
and a four-second keep-alive**. So an idle socket was closed after four
seconds and the next request opened a new one with a full TLS handshake, and
a storm opened as many at once as there were callers. Measured inside the
engine's network namespace at 10:33 UTC, an ordinary minute: **240 HTTPS
connections established and 1,674 in TIME-WAIT** - about twenty-eight new TLS
sessions a second, all day. During the 10:07 storm: 3,800 in TIME-WAIT.

OpenSSL allocates every session's state in native memory through malloc on
the thread that opened it, i.e. the main arena. glibc can only return the top
of that arena to the kernel, so a burst that opens thousands of sessions at
once ratchets the arena to its high-water mark and the mark stays after the
sockets are gone. That is the shape in the readings: steps during storms,
never a decline.

**How proven is this.** The pool defaults, the connection counts, the arena
growth and its timing against the storm are all measured on the live engine
and written above. The link from "thousands of TLS sessions in the main
arena" to "the arena's high-water mark ratchets" is the documented behaviour
of glibc malloc and OpenSSL, not a measurement of this process - a heap
profile that would prove it directly costs a full-heap pause, and one such
probe on 2026-09-14 (`Runtime.queryObjects`, 10:07:09 UTC) fenced ~750
tournament managers for the length of the pause. So: strongly indicated, and
the metrics below are what turn "indicated" into "watched". If the arena keeps
climbing on the bounded pool, the runbook says what to read next.

## What changed

### The engine publishes its own memory (`server/src/observability/processMemory.ts`)

Eight always-on gauges on `/metrics`, refreshed from one five-second-cached
sample of `process.memoryUsage()`, `/proc/self/status` and the `[heap]` line
of `/proc/self/maps` (the mapping's extent, which for the brk arena is its
high-water mark; `smaps` would give per-mapping RSS but walks the page tables
of a 25 GB address space on the main thread, so it is not read). Reads only;
no allocation profile, no heap walk.

| series                                 | what it is                                       |
| -------------------------------------- | ------------------------------------------------ |
| `poker_engine_process_rss_bytes`       | the whole process, every isolate and arena       |
| `poker_engine_heap_used_bytes`         | V8 main isolate, in use                          |
| `poker_engine_heap_total_bytes`        | V8 main isolate, committed                       |
| `poker_engine_external_bytes`          | Buffers and bound C++ objects V8 accounts for    |
| `poker_engine_array_buffers_bytes`     | ArrayBuffer backing stores                       |
| `poker_engine_native_main_arena_bytes` | glibc main arena (`[heap]`): native, main thread |
| `poker_engine_rss_anon_bytes`          | anonymous RSS                                    |
| `poker_engine_threads`                 | OS threads (worker isolates, libuv, V8 helpers)  |

The `/proc` series are `-1` where `/proc` is unreadable, never absent. They
are published from the first scrape (the always-on registry, per the law
`anAlertCannotWaitForAFailureToExist`). `/health` carries the same numbers in
megabytes as `memory`.

### The fetch pool is bounded (`server/src/services/httpDispatcher.ts`)

One undici `Agent` for the process, built from Node's own bundled constructor
(the same class Node's fetch was written against; no npm `undici`, no second
copy with a different handler protocol), installed by the first import of
`server/src/index.ts`:

    connections      : ENGINE_HTTP_MAX_CONNECTIONS   default 128 per origin
    keepAliveTimeout : ENGINE_HTTP_KEEPALIVE_MS      default 30 000

The cap bounds how many TLS sessions can exist at once, which bounds the
arena's high-water mark; requests beyond it queue in order inside undici and
still honour the per-attempt deadline in `services/supabase/client.ts`. The
keep-alive ends the churn. Cloudflare, in front of Supabase, sends no
`Keep-Alive: timeout=` hint (so undici's own option governs) and was measured
holding an idle connection open for at least 150 s, so the longer idle is safe
on their side; the engine was the side closing.

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
   a :00 thaw and a tournament re-admission storm. Flat means the mechanism
   above was the cause. Climbing means it was not the only one, and the
   runbook's next steps apply.

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
the sampler above is the replacement: reads only, never a heap walk, and the
runbook says so in bold.
