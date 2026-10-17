# 2026-10-17 Horse Fleet Status and Recovery Harness

- Added `scripts/ops/horse-fleet-status.mjs` and npm script `horse:status` providing a real-time matrix dashboard for all 17 Horse Brain qualification leagues.
- Added shard failure recovery (`--retry-failed`) in `scripts/ops/horse-qualification-pipeline.mjs` to target and re-run failed jobs via GitHub CLI without restarting whole runs.
- Added live watcher and polling support (`--watch`) in `scripts/ops/horse-qualification-pipeline.mjs` for hands-off automatic assembly upon workflow completion.
- Added comprehensive unit tests in `tests/unit/horseFleetStatus.test.ts` and extended `tests/unit/horseQualificationPipeline.test.ts` to 35 passing tests.
