# Player Command Reliability — Phase 1 Of 6

## Scope

Hardens the Club Arena Players roster against the production failure sequence
observed on 2026-08-30: transient Supabase fetch failures, a realtime channel
entering `CHANNEL_ERROR`/`CLOSED`, cached rows remaining visible without an
ongoing stale warning, and a route lookup outage being presented as a missing
club.

## Changes

- All summary and cursor-page reads now use bounded 8-second attempts with
  abort-aware exponential backoff and jitter. Authentication, authorization,
  validation, and genuine not-found responses never retry.
- Superseded first-page and load-more requests abort immediately. A failed
  request also aborts its still-running sibling read.
- Cached rows keep their verified timestamp and remain visibly marked stale,
  offline, connecting, or realtime-reconnecting until a live read succeeds.
- Browser offline/online events abort unsafe work and restart route resolution
  when connectivity returns.
- The roster realtime channel exposes its complete lifecycle. A recovered
  `SUBSCRIBED` status triggers one authoritative reconciliation read; failed
  channels use a capped recovery cadence instead of a refresh/toast storm.
- Strict club resolution now distinguishes `ClubNotFoundError` from
  `ClubResolutionError`, and the no-UUID error screen has a working retry path.
- Sparse session-storage rows from an earlier build are normalized through the
  same mapper as network rows before rendering.
- The background first-page failure toast was replaced by a persistent inline
  status with a reachable Retry Live Sync control.

## Verification

- Focused roster, privacy, resolver, class-ownership, and resilience suites:
  72 tests passed.
- Complete client regression suite: 9,824 tests passed across 683 files.
- Complete server regression suite: 2,892 tests passed across 254 files.
- The complete-suite run exposed a newly landed fixed-byte source-window pin;
  its satellite payout guard now uses the shared structural source-window
  helper. The targeted server guard passes all 6 tests.
- Client TypeScript check: passed.
- Changed-file ESLint: passed.
- Production build: passed with 439 media assets optimized, zero media failures,
  and build provenance stamped from a branch reporting zero commits behind
  `origin/main`.
- Bundle gate: passed at 314 kB gzipped initial load against the 320 kB limit;
  roster resilience and strict route-resolution code load only with roster work.
- Fire-and-forget activation telemetry now loads outside the render-critical
  entry graph, protected by boot-source tests for dynamic loading and error
  reporting.
- Signed-in membership warming still starts during boot but its service module
  loads non-blockingly, leaving additional headroom for production debug IDs.
- Membership warm-state clearing is isolated in a synchronous account-safe
  module, and global club-store actions load the query service only on demand.

No database migration, money mutation, generated image, or game-engine behavior
is part of this phase.

Real-time law: roster presence is triggered by the existing discrete
`club_members` Postgres realtime event; recovery reads reconcile state and do
not drive game animation or sound.

## Release Certification Addendum — 2026-08-31

The final production-readiness audit closed six additional edge cases before
Phase 1 certification:

- Transient manual, structural, and realtime recovery reads now preserve the
  last-known-good session cache until an authoritative replacement succeeds.
- An authoritative access-revoked response purges that cache and resets the
  summary, capabilities, cursor, pagination state, and filtered count.
- An online read failure remains visibly retryable instead of being labelled
  live, including the first-load case where no saved roster exists.
- The connection message live region contains only status text; the interactive
  retry control is a sibling, so assistive technology does not treat a button as
  changing status prose.
- A still-pending membership warm-up is deduplicated for its entire lifetime;
  the five-second reuse window begins only after a successful settlement.
- Regressions for every case above are pinned in the roster resilience and
  membership warm-start suites.

Final merged-tree verification: 23 focused tests, 9,888 complete client tests
across 689 files, 3,002 complete server tests across 265 files, client and
server TypeScript builds, changed-file lint, and the production bundle all
passed. The production build generated a 21.14 kB Player Command route chunk
(7.52 kB gzip) and completed media optimization with zero failures.
