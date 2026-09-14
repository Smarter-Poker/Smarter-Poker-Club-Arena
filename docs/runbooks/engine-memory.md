# Engine Memory

Use this runbook when any of these alerts fires:

- `EngineHostNearOOM` (critical)
- `EngineBuildHeadroomLost` (warning)
- `EngineProcessMemoryHigh` (warning)

All three are in the `engine-memory` group of `infra/monitoring/alert-rules.yml`
and every threshold there is derived from a measurement written beside it.
The numbers below are from 2026-09-14; re-measure before changing a threshold.

## The Shape Of The Host

`engine-01` has 3819 MiB (`node_memory_MemTotal_bytes` = 4,005,085,184). The
engine is one Node process and the largest thing on the box. Beside it live
dockerd (~280 MiB), Prometheus (~100), Grafana (~70), fail2ban (~50),
Alertmanager, node_exporter and the kernel: about 1060 MiB together that
never goes away. The release train (`auto-deploy-hetzner.yml` via
`server/scripts/build-engine-image.sh`) builds the next engine image ON THIS
HOST and refuses to start below **1179648 KiB available** (`BUILD_MEMORY_BYTES /
1024 + BUILD_RESERVE_KIB`). So:

    available  ~=  3819 - 1060 - engine RSS
    a build fits only while engine RSS  <  ~1600 MiB

A freshly restarted engine weighs ~600 MiB, 1640 MiB after an hour, 2097 MiB
after ninety minutes. On the night of 2026-09-13 the build was refused 11 of
14 times, and on 2026-09-12 06:21:57 UTC the kernel OOM-killed the engine
(`dmesg`: `Out of memory: Killed process ... (node)`), which drops every table
mid-hand with no drain. The build's own memory is contained since 2026-09-12
(`docs/changelog/2026-09-12-engine-builds-have-a-separate-memory-budget.md`);
that change said in its own words it was "not an application memory-leak
fix". This runbook is about the application.

## First Checks

Read these together (the engine job is `engine_game_server`; the host job is
`node_engine01`, label `host="engine-01"`):

```promql
node_memory_MemAvailable_bytes{host="engine-01"}
poker_engine_process_rss_bytes
poker_engine_heap_used_bytes
poker_engine_heap_total_bytes
poker_engine_native_main_arena_bytes
poker_engine_external_bytes
poker_engine_array_buffers_bytes
poker_engine_rss_anon_bytes
poker_engine_threads
```

The same numbers are on `/health` as `memory` (megabytes) together with
`httpDispatcher` (whether the fetch pool is bounded, see below), so a single
`curl -s http://localhost:8080/health | jq '.memory, .httpDispatcher'` on the
box answers the first question without Grafana.

Then decide which of three things is growing:

1. **`poker_engine_native_main_arena_bytes` climbing while `heap_used` is
   flat.** Native memory on the main thread: TLS sessions, serializer
   buffers, anything malloc'd that is not a V8 page. This was the 2026-09-14
   finding (arena 378 -> 501 MB in an hour, +111 MB in the seven minutes of a
   tournament re-admission storm, heap flat at 400-800 MB). The cause was the
   process-wide fetch pool: no connection cap and a 4 s keep-alive, so the
   engine opened ~28 new TLS sessions a second in a quiet minute and
   thousands at once in a storm, and glibc's arena kept the high-water mark.
   `server/src/services/httpDispatcher.ts` bounds the pool;
   `/health.httpDispatcher` must read `bounded: true`. If it reads `false`,
   the `reason` says why and the process is running on the unbounded
   default - that is the fault. Confirm churn on the box (read-only):

   ```bash
   PID=$(docker inspect -f '{{.State.Pid}}' club-arena-engine)
   nsenter -t "$PID" -n ss -tan | awk '{print $1}' | sort | uniq -c
   ```

   Hundreds of `ESTAB` to :443 and thousands of `TIME-WAIT` means the bound
   is not in effect.

2. **`poker_engine_heap_used_bytes` climbing across GC cycles.** A JavaScript
   retention: a Map that is only ever added to, listeners never removed,
   closed tables still referenced. Correlate with `poker_engine_active_tables`
   and the tournament counts; a heap that tracks table count is a working
   set, a heap that grows while table count is flat is a leak. Do NOT take a
   heap snapshot or run `Runtime.queryObjects` on the live engine: a
   full-heap walk pauses the process long enough to miss lease renewals
   (measured 2026-09-14 10:07 UTC: one probe fenced ~750 tournament
   managers). Sample on a replica, or reason from the code.

3. **`poker_engine_threads` or `poker_engine_external_bytes` climbing.**
   Worker isolates being created and not terminated, or Buffers held. Each
   worker isolate is ~440 MB heapTotal on this engine; a thread count that
   steps up on every restart of a worker is the signature.

## What Clears It

- **A restart inside the next :55 break** returns the process to ~600 MiB.
  Never restart outside the break: CLAUDE.md section 13. `EngineHostNearOOM`
  is the one case where waiting may not be an option; if `MemAvailable` is
  under 100 MiB and falling, the kernel is about to do the restart for you
  without a drain. Announce a break through the maintenance-break path and
  restart inside it; never a bare `docker restart` on live tables.
- **Nothing else on the box should be freed to make room.** Prometheus's
  retention and Grafana are not the problem, and the page cache is already
  reclaimable (it is counted in `MemAvailable`).

## What Does Not Fix It

- Raising `BUILD_RESERVE_KIB` or lowering the build's memory limit. The build
  needs what it needs; the engine is the thing that grew.
- A cron that restarts the engine when memory is high. That is a repair job
  (CLAUDE.md 10.12); the hourly break already restarts it, and the cause is
  what has to be fixed.
- `--max-old-space-size`. The V8 heap was not the growth.

## History

- 2026-09-12 06:21:57 UTC: kernel OOM-kill of the engine, anon RSS 1.29 GB at
  the moment of death (something else held the rest).
- 2026-09-13/14 overnight: 11 of 14 engine deploys refused,
  `insufficient memory headroom for the bounded engine build`.
- 2026-09-14: the eight memory gauges, the `/health.memory` and
  `/health.httpDispatcher` blocks, the three alerts, and the bounded fetch
  pool were added together. `docs/changelog/2026-09-14-the-engine-weighs-itself.md`.
