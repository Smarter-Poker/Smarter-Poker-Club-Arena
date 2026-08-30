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
- Client TypeScript check: passed.
- Changed-file ESLint: passed.
- Production build completed; the provenance guard then correctly refused the
  stale artifact after `origin/main` advanced. The branch must be rebased and
  rebuilt before publication.

No database migration, money mutation, generated image, or game-engine behavior
is part of this phase.

Real-time law: roster presence is triggered by the existing discrete
`club_members` Postgres realtime event; recovery reads reconcile state and do
not drive game animation or sound.
