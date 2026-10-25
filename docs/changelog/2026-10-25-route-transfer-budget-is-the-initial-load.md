# The route transfer budget measures the initial load (2026-10-25)

## What failed

`npm run test:performance` (`scripts/ci/route-performance.mjs`, inside the
required Production Build job) failed PR #7972 at 01:23 UTC because
`/hub/club-arena/health` measured 1096kB on mobile and 3173kB on tablet in the
same run of the same build. A re-run with no code change passed.

## Why

The gate summed `transferSize` over every resource-timing entry recorded by
its snapshot (load event, FCP wait, then 500ms). After first render the app
deliberately starts speculative work: `ChunkPreloader.preloadCriticalChunks()`
waits for `requestIdleCallback`, imports ten page chunks 150ms apart, and then
warms the card deck (~500KB of WebP). How much of that lands before the
snapshot depends on how loaded the runner is, so the byte count, and the
verdict, was a race. The navigation document itself was never counted.

## The rule now

`scripts/ci/initial-load-bytes.mjs` decides which bytes count:

- the navigation document's own `transferSize`, plus
- every resource whose `startTime` is before the boundary, where the boundary
  is the earlier of `navigation.loadEventStart` and the moment the page's
  first `requestIdleCallback` callback ran (recorded by an init script that
  wraps rIC without changing its behaviour). Idle work is speculative by
  definition, and on a slow load an idle period can open before `load`.

The static critical set (document, entry module, modulepreloads, stylesheets)
is requested during HTML parsing, before any idle callback can exist, so it is
always counted and a genuinely bloated initial load still fails the unchanged
3MB budget. With no load timestamp there is no boundary the browser vouches
for, so every byte counts, as before (fail closed). The resource-timing buffer
is raised from Chromium's default 250 entries so entries are not silently
dropped.

The log line reports the initial-load figure, the boundary, and the bytes
after it and the total, informationally. No other metric changed.

## Pinned by

`tests/the-route-transfer-budget-is-the-initial-load.law.test.ts`
(`docs/laws.d/the-route-transfer-budget-is-the-initial-load.md`).

## The gate now runs on its own changes

`scripts/ci/classify-ci-changes.mjs` admitted Production Build only for
`src/**` (plus a few named inputs), so this very change to the gate had its
build skipped: the new gate would have run for the first time on someone else's
pull request. The gate script and the helpers it imports
(`route-performance`, `initial-load-bytes`, `paint-readiness`, `e2e-port`) now
admit the build, the same way `scripts/stamp-build-provenance.mjs` already did.

