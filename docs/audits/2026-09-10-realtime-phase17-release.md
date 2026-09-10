# Phase 17 Release: Daily Missions Subscription Handoff

PR4175 merged at 2026-09-10 14:51:20 UTC as
7732b971982bb888e6c0b455e73568bae1d7bbf1. Its source head was
489784826770b827c9fb804a3273f0e1db4afab9. CI run 34490857931 passed, including
TypeScript, production build, all client shards and the CSS browser checks.
Publisher run 34491803594 passed all client shards, built and published the
same release. No test or release gate was bypassed.

At 14:59:28 UTC, public and origin build-info both identified that exact merged
release, built at 14:54:59 UTC. The public HTML's entry was
index-DtqA7vEY-v6.js, SHA-256
7919ec7b056a6e9f3deaa7a591deb59283e42c8f8f16fd0e87a651f5409a8e50.

That entry referenced DailyChallengesPage-BKNfPKEa-v6.js. Its actual public and
origin bodies matched, SHA-256
495df07fdec47e92df4881080c616fcd9c41364d7a0b48594acbc79a4b0c7927.
The body contains both revision-call sites: the existing watchdog and the new
subscription acknowledgement check. The latter compares the current
subscription epoch and dashboard revision before scheduling refresh. The
account cleanup increments that epoch. This verifies the delivered repair,
beyond a build stamp alone. Build identities were checked again after reads.
The machine receipt is 2026-09-10-realtime-phase17-publication.json.

Seven mounted handoff cases and 29 focused tests passed locally. Normal
pre-push verification additionally passed 225 related tests and 126
source-contract checks; these groups overlap and are not summed as unique
tests. Details are in the Phase 17 changelog.

The release and its delivered code are verified. The full production suite
triggered after this publisher had not completed at the time of this receipt.
The preceding Phase 16 run's green Daily Missions certification tests the
earlier release and is not represented as Phase 17 UI evidence. Natural-event
and physical iPad/PWA acceptance remain open.

## Production Follow-Through

Post-deploy run 34501771061 passed the full Daily Missions certification,
including the sustained-outage retry fixture from PR4183. Its fixture account
was hard-deleted and absence verified. The broader run executed 290 tests: 283
passed, seven failed, four additional skips, and zero flaky tests. Four failures
were the coordinated engine-release prerequisite. The others were the recurring
player-pagination race and two WebSocket gateway errors on financial routes.
The pagination diagnostics enabled the source repair described in
2026-09-10-player-pagination-query-ownership.md. Broader programme acceptance,
including physical-device and unavailable detailed diagnostic evidence, remains
open; this successful Daily Missions result is not a claim that the full run
passed.
