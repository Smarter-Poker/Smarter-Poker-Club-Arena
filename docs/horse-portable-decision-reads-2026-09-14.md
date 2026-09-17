# Portable Horse decision reads, September 14

The actual fast-decision worker now captures its original opponent read view as a private versioned frame. The second-look consumer decodes that same frame, rather than reading current worker memory. This supplies a portable component for the future decision journal; it is not the complete durable journal or production restart replay.

`HorseDecisionReadFrame` preserves the table's pooled and scoped statistics, player-pair evidence, current-hand barrel and raise plans, and next-street outlook sets. Entry and set order, fractional recency statistics and zero values survive encoding. A compile-time field check requires any new opponent statistic to be considered explicitly. The frame binds the ordered actor set and hand key, validates all rows and field counts, and uses a SHA-256 digest and exact UTF-8 byte count. It rejects missing, duplicated, unrelated or malformed rows. Pending observations, deduplication and dirty-write state are forbidden; this codec cannot silently present a partial write checkpoint as a read view.

Each frame is limited to 256KiB and at most ten actors. The existing worker cap of 128 retained decisions and 60-second expiry remains. Frames never enter public state, worker replies or finite telemetry. A failed capture leaves the already-computed fast decision valid; an unavailable or corrupt frame declines the second look recoverably before changing canonical RNG. The existing finite missing-read receipt includes these failures.

## Verification

- 151 focused tests passed across the codec, read isolation and actual worker runtime. The final server suite passed 12,970 tests with 157 declared skips (847 files passed, one skipped); the server build passed.
- A real validated worker produced frames for 36 synthetic decisions: nine variants across four streets. One fresh Node process restored those frames and reproduced every selected action, amount, think time, RNG result and retained plan effect. Both processes had empty solver stores, a governor fixed at one, and newer phase candidates disabled. These restrictions are essential: the proof does not cover hydrated solver packs, historical deadline work, all tournament policies or full production restart replay.
- A separate isolated Darwin arm64 Node22.23.2 component measurement used 4,000 pooled rows, 16,000 scoped rows, 20,000 pairs and 8,000 entries per plan store. For ten actors over 3,000 measurements, copy-plus-encode p99 was 0.335ms and decode p99 0.459ms. Each populated frame was 11,856 bytes; 128 retained JSON bodies totaled 1,517,568 bytes. This is not complete worker, fleet or Phase8 latency qualification.

Task evidence: `horse-read-frame-focused-final.log`, `horse-read-frame-build-complete.log`, `horse-read-frame-full.log`, `horse-read-frame-fresh-process-final.json` with exact source hashes, and `horse-read-frame-budget-isolated.json`. The synthetic read packet is private and local; no production decision snapshots were exported.

## Remaining Phase15 requirements

Implement the complete bounded private decision/execution journal and its real durable producer/consumer; bind canonical hand identity, source release and runtime pack contents; capture internal distributions and actual work/clock dependencies; then prove full fresh-process decision/effect replay and executor reconciliation. Preserve the distinction between original opponent reads and the complete hidden runtime. Full Phase14 causal learning, deployment provenance, natural execution and all-fifteen-phase acceptance remain open.
