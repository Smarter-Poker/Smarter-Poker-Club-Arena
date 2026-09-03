# Player Command Phase 2 — directory-first loading and verified totals

2026-08-31. Phase 2 of 6 for the Club Arena Players surface.

## What the audit found

Every search, filter and sort change started the full roster summary RPC again
and waited for that RPC before publishing a successful directory page. A slow
or failed totals read could therefore make the entire Player Command deck feel
stalled even when its requested rows were already available. The fee-rollup
touch also ran after every successful first-page read, despite the server-side
operation already having a cooldown.

The first desktop viewport at 1212x710 was occupied by the cinematic header and
fixed navigation, leaving the actual search and roster controls below the fold.
The summary definition list also placed each value before its label in the DOM.

## What changed

- The directory page and roster summary still start concurrently, but now
  publish independently. Ready player rows are no longer held behind a slow
  totals request.
- A page-local, viewer-and-club-scoped coordinator deduplicates in-flight
  summary reads and reuses a settled summary for 30 seconds across query-only
  changes. Failed reads are never cached, route/viewer resets invalidate the
  coordinator, and manual or structural refreshes can force a fresh read.
- Summary failure is isolated from directory failure. Cached totals remain
  visibly marked stale while reconnecting; without cached totals, the UI says
  totals are unavailable while leaving the directory usable.
- An authoritative null summary still revokes access: cached rows are purged,
  in-flight page work is aborted, and the visible roster is cleared.
- Fee-rollup touches are capped to the same 30-second cadence as the server
  cooldown instead of firing for every search/filter/sort request.
- Summary terms now precede their definitions semantically, with CSS preserving
  the intended value-first visual hierarchy.
- Short desktop viewports receive a compact 222px command deck so the search
  and roster controls enter the first viewport without discarding the distinct
  Player Command artwork.

No new artwork was introduced in this phase. The existing roster operations
scene remains unique to this surface rather than repeating another near-copy of
the Club Arena imagery.

## Pre-publication verification

- Focused Player Command policy and wiring: 60 tests passed.
- Full client: 705 files and 9,980 tests passed.
- Full game server: 267 files and 3,032 tests passed.
- Client and server TypeScript checks passed.
- Changed-file ESLint and `git diff --check` passed.
- Production Vite/media build passed: 2,536 modules transformed and 439 media
  assets optimized from 112.90MB to 31.19MB.

The phase is complete only after the guarded publisher merges this work and a
cache-busted live desktop/mobile inspection confirms the deployed commit.

## Live-gate correction

The authenticated production inspection exposed a cold-query edge case that
the mocked failure tests did not: totals could arrive while the first directory
page exhausted its bounded read deadline. A manual Refresh recovered all 593
rows, but requiring that click was not acceptable. The page now schedules up
to two bounded, jittered first-page recovery cycles while keeping the loading
surface honest; only an exhausted recovery becomes a hard error. Successful
reads reset the recovery budget as before.
