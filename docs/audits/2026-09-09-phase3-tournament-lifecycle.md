# Phase 3: Tournament Lifecycle Audit

Status: in progress. This is Phase 3 of the Club Arena 12-phase programme, covering 58 original controls. It is not a completion certificate. The original 216-control register remains unchanged.

## First Confirmed Correction: Break Ownership

The hand-for-hand barrier resumed all parked tables without checking whether a synchronized tournament break or add-on break still owned the shared pause. Its delayed re-pause also replaced a longer break budget with the default hand-for-hand budget. Simply blocking those calls would leave an already-complete barrier asleep after the break, because no new table completion event was due.

TournamentManagerBase now retains the pause during either break, preserves its longer budget, and rechecks the barrier when the last applicable break ends. The wake follows any deferred add-on opening. TournamentManagerEliminations also preserves a break when the bubble ends, when a satellite has no awards, or when hand-for-hand starts. If the bubble ends during an add-on break, that break releases the inherited gate at its own end. Existing independent maintenance and final-table-deal engine authorities still control their own resumes.

The nine new tests use the real ServerTableEngine pause/resume methods and the real TournamentManagerBase barrier. Six of the original eight cases failed before correction and all eight passed after it; a ninth case verifies release of an add-on pause inherited from a now-ended bubble. Cases include duplicate/late completion, retirement, a missing completion, both break kinds, the delayed re-pause, no-new-event resume, and overlapping break deadlines.

The final tournament, maintenance and engine-pause suite, including the Spin correction below, passed 1348 tests in 127 files. Server TypeScript and the server production build passed. One existing source assertion required the obsolete ownsPause condition; it was updated in the same change and points to the new behavioral coverage. This is a partial K06 finding with related K05/BX11 boundaries, not closure of all clocks, synchronized elimination ranking, operator pauses or failover.

## Second Confirmed Correction: Announce The Booked Spin Result

The installed draw function selects a multiplier without persisting a tournament outcome. The settlement function books that outcome durably and returns its original multiplier on an idempotent replay. The engine previously announced the local draw before settlement. A reproduced retry announced 2x while settlement confirmed an already-booked 10x result. A failed settlement also left an announced but unbooked result.

The early reveal now follows successful reserve settlement and adoption of the booked multiplier, while still preceding the row projection and table-building work. Existing animation holds and reconnect replay deadlines remain in place. An already-settled receipt without a usable booked multiplier causes the existing bounded retry and stand-down path instead of announcing the unconfirmed local draw.

Five new tests execute the production launch fragment with controlled external I/O: an unresolved settlement cannot announce; a different booked multiplier controls the announced prize and payout ladder; three failed attempts announce nothing; a malformed idempotent receipt stands down; and a matching result announces once while preserving the board's starting stack. The original four cases failed three and passed one before correction. The malformed receipt case then failed before its validation was added. All five now pass. The existing source-order assertion was updated to the demonstrated durable-result prerequisite; its table-build ordering and reveal payload checks remain.

This is a partial S06 correction with related S09/AX09 recovery boundaries. It does not certify the entire versioned odds contract, reserve funding, cancellation policy or full crash recovery.

## Isolated PostgreSQL Verification

The existing `scripts/dev/probe-tournament-manager-fencing-pg17.sh` completed with exit 0 against a temporary local PostgreSQL 17 cluster. Its Stage-A legacy/canonical authority and capacity receipts passed. The Stage-B migration was absent, so its cutover-only retirement probe did not execute. This is a bounded local database result, not full financial concurrency coverage or a production database mutation.

## Publication Boundary

Both Phase 3 corrections are prepared locally. Automatic approval review rejected cherry-picking and pushing Phase 3 source because the user's explicit publication authorization covered Phase 2 only. No Phase 3 source was pushed. Phase 3 publication requires explicit authorization; local implementation and verification remain reviewable.

## Live Database Review Begun

Read-only inspection captured definitions, signatures, hashes and role privileges for 21 registration, rebuy, launch, Spin and cancellation functions. The public one-argument registration entry point and unregister function are authenticated APIs; renamed implementation helpers are not executable by anon, authenticated or service_role. Service-only launch and Spin operations remain service-only. Exact metadata is retained in the companion JSON; privileges alone do not prove correct funding or concurrency.

Initial database reads timed out. A later successful query reported PostgreSQL start at 2026-09-09 05:59:39 UTC; catalog reads then succeeded. No database DDL, financial mutation, historical backpay or repair sweep was performed.

## Open Funding And Cancellation Boundaries

The installed Spin draw and settle calls are separate transactions. The draw locks the pool, reads pending tournament multipliers and returns a selection without writing a reservation. The engine's tournament multiplier projection follows settlement. Therefore that pool lock alone does not demonstrate affordability across overlapping draw-to-settle intervals. The installed settle body records an operator-shortfall note when the pool cannot cover the prize; that note is not proof of an operator-bank debit. The installed obligation implementation checks actual escrow and may leave part of an obligation unpaid. S07 requires a complete concurrent funding proof and a trace of any actual shortfall-funding authority; neither is claimed here.

The installed admin cancellation function considers all entrants and computes gross entry/rebuy/add-on refunds without subtracting prior finishing prizes in that computation. The engine recovery helper selects open entrants and skips any row with a positive prize. Its current behavioral test explicitly covers skipping a previously awarded player. These source paths do not establish one contractual cancellation entitlement after minimum-cash payments. AX07/AX10 remain open pending the approved policy, deferred cancellation constraints, source-to-caller reconciliation and replay/race execution. No cancellation amounts or live balances were changed based on this observation.

Additional read-only definitions: `fn_settle_tournament_obligation` MD5 `53c0ff5d2215dfcfbd271b7b13d43b8f`; its delegated `fn_settle_tournament_obligation_before_atomic_batch_gate` MD5 `0fbfd867868fe2485dc9c66f565be15e`. The draw definition remained MD5 `9530aa9c1b2c05604e3af611aa6b7ce8`. The frozen probability-table/rule-version requirement also remains unverified.

## Remaining Work

Every original Phase 3 control is present in the companion progress register. Financial concurrency, entry provenance, payout freezing, cancellation after prior awards, persistent Spin draws, reserves, bounties, satellites and table-move races still require full behavioral and installed-source reconciliation. Installed cancellation and draw functions have been retrieved for that review; their presence or historical comments are not a current pass. Phase 2 publication remains separately tracked until the final engine adopts its merged corrections.

Bots, Horses and RTA feature/policy work remain excluded. No World Hub repository was inspected or changed. No manual balance repair, blanket lock or forced engine restart was used.
