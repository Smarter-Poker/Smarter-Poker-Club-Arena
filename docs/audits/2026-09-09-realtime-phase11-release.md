# Phase 11 Release Verification

Tournament lobby snapshot recovery is published and verified in controlled Chrome. Physical iPad/PWA acceptance remains open.

The routed and embedded TournamentDetails page now owns reads by tournament and account, refreshes on channel subscription, retains one follow-up invalidation, and preserves confirmed data on refusal. Live patches are replayed only across the corresponding query. An earlier response cannot replace a retired scope. Existing refresh cadence and mutation authorities remain unchanged; no cron was added.

## Regressions And Release Gates

The mounted page reproduced 11 original failures. The main repair passed 193 focused tests, TypeScript and the production build. A final ordering case then reproduced an earlier live patch replacing a newer entry snapshot (600 instead of 700). The corrective suite passed all 15 mounted-page cases after aligning patch buffers with each query boundary.

PR #4043 merged as `c79e2687f8446d47488dd8c17990cc6abf263f5d`; CI `34414137878` passed. PR #4046 merged as `65f1f4eed01300459545332eb7d4a90bddffba2a`; CI `34414946450` passed on attempt 2. Attempt 1 lost a PostgreSQL shared-memory segment in the isolated transaction probe (58P01). The normal failed-job retry passed without any code change or gate bypass. Normal commit, push, CI, autopilot and publisher gates were used.

## Published And Rendered Evidence

At 23:19:43 UTC on September 9, both public and origin build-info served the exact corrective merge `65f1f4eed01300459545332eb7d4a90bddffba2a`, which contains both repairs. Publisher `34415964089` completed its client suites, build and origin publication successfully.

The actual public entry references `TournamentDetails-C6DZ_YE0-v6.js`. Its SHA-256 is `8154cf9d567a62b8ffdd97af67cc8df0a79f4f2c87d229fd1b0cb816624a16d0`; all six expected repair markers are present. The exact source blobs and publication steps are recorded in the accompanying JSON.

At 23:21:30 UTC, the supported controlled Chrome session had loaded the matching `index-Coy3KdTT-v6.js`. Details, Ranking and Tables rendered 24 entries, 288,000 total chips and three table cards, with zero displayed error alerts. The read-only database result at 23:20:49 UTC agreed: 24 entry rows, 288,000 chips, three visible tables and level index 2, displayed as Level 3.

## Acceptance Limit

This is published-page acceptance plus deterministic mounted tests for reconnect, refusal, retirement and ordering failures. No physical iPad/PWA session was available for disconnect or background-resume acceptance. No live player balance, seat, registration or push delivery was changed as a probe. The whole realtime programme is not declared 100% complete.

Exact evidence: [release JSON](2026-09-09-realtime-phase11-release.json).

- https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/4043
- https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/4046
- https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/34415964089
