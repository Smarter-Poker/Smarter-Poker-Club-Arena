# Phase 3: Tournament Lifecycle Audit

Status: in progress. This is Phase 3 of the Club Arena 12-phase programme, covering 58 original controls. It is not a completion certificate. The original 216-control register remains unchanged.

## First Confirmed Correction: Break Ownership

The hand-for-hand barrier resumed all parked tables without checking whether a synchronized tournament break or add-on break still owned the shared pause. Its delayed re-pause also replaced a longer break budget with the default hand-for-hand budget. Simply blocking those calls would leave an already-complete barrier asleep after the break, because no new table completion event was due.

TournamentManagerBase now retains the pause during either break, preserves its longer budget, and rechecks the barrier when the last applicable break ends. The wake follows any deferred add-on opening. TournamentManagerEliminations also preserves a break when the bubble ends, when a satellite has no awards, or when hand-for-hand starts. If the bubble ends during an add-on break, that break releases the inherited gate at its own end. Existing independent maintenance and final-table-deal engine authorities still control their own resumes.

The nine new tests use the real ServerTableEngine pause/resume methods and the real TournamentManagerBase barrier. Six of the original eight cases failed before correction and all eight passed after it; a ninth case verifies release of an add-on pause inherited from a now-ended bubble. Cases include duplicate/late completion, retirement, a missing completion, both break kinds, the delayed re-pause, no-new-event resume, and overlapping break deadlines.

The tournament, maintenance and engine-pause suite passed 1343 tests in 126 files. Server TypeScript passed. One existing source assertion required the obsolete ownsPause condition; it was updated in the same change and points to the new behavioral coverage. This is a partial K06 finding with related K05/BX11 boundaries, not closure of all clocks, synchronized elimination ranking, operator pauses or failover.

## Live Database Review Begun

Read-only inspection captured definitions, signatures, hashes and role privileges for 21 registration, rebuy, launch, Spin and cancellation functions. The public one-argument registration entry point and unregister function are authenticated APIs; renamed implementation helpers are not executable by anon, authenticated or service_role. Service-only launch and Spin operations remain service-only. Exact metadata is retained in the companion JSON; privileges alone do not prove correct funding or concurrency.

Initial database reads timed out. A later successful query reported PostgreSQL start at 2026-09-09 05:59:39 UTC; catalog reads then succeeded. No database DDL, financial mutation, historical backpay or repair sweep was performed.

## Remaining Work

Every original Phase 3 control is present in the companion progress register. Financial concurrency, entry provenance, payout freezing, cancellation after prior awards, persistent Spin draws, reserves, bounties, satellites and table-move races still require full behavioral and installed-source reconciliation. Installed cancellation and draw functions have been retrieved for that review; their presence or historical comments are not a current pass. Phase 2 publication remains separately tracked until the final engine adopts its merged corrections.

Bots, Horses and RTA feature/policy work remain excluded. No World Hub repository was inspected or changed. No manual balance repair, blanket lock or forced engine restart was used.
