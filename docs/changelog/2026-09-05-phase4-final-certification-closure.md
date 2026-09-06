# Phase 4 Final Production Certification Closure

The first full post-deploy run containing the Phase 4 Cashier and Club Arena
repairs (`34006656625`) proved the release-critical Cashier journey green and
then exposed three remaining defects in the broader production gate. This
change closes those gaps without weakening the gate.

## Daily Missions cold-load duplication

- The atomic dashboard RPC assigns an isolated player's first missions and
  broadcasts the resulting dashboard revision before the same RPC receipt
  reaches the browser.
- The page previously scheduled a second full dashboard RPC from that echo.
- Realtime refreshes now retain the announced revision through the debounce and
  compare it with the revision already rendered. A matching initial echo is
  discarded; a genuinely newer mutation still refreshes immediately.
- The production certification records every exact V2 dashboard attempt and
  its status/failure, while retaining the one-request and latency budgets.

## Table Studio cold hydration

- The two-device production journey now attaches its account-settings listener
  before opening Table Studio and waits for a successful authoritative read.
- Cached first paint remains fast, but a cold-reload assertion can no longer
  race auth hydration or judge a stale local snapshot as the final saved row.
- Failure reporting now preserves the underlying journey and cleanup messages
  when both fail.

## Club membership bootstrap

- The global membership preflight now waits only for the navigation commit.
- Its existing lobby/join/recovery selector remains the real bounded readiness
  contract, so a slow unrelated asset cannot consume 60 seconds before that
  application state is inspected.

## Verification

- Focused Daily Missions, production preflight, and customization contracts:
  green.
- TypeScript: green.
- Full Vitest suite: 1,048 files and 14,519 tests green.
- Production build: green. ESLint: zero errors (676 existing warnings).
- Production-backed local Daily Missions journey: one dashboard RPC; complete
  action, recovery, responsive, and cleanup journey green.
- Live Table Studio two-device/two-player journey: realtime, persistence,
  isolation, authoritative cold hydration, and hard-delete cleanup green.
- Reserved-fixture recovery sweep: zero stale accounts remaining.

The final release verdict remains the descendant post-deploy workflow after
merge and publication.
