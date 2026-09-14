# Recover awarded tickets after the ordinary funding quota

The prestart discovery caller previously skipped a target once its ordinary horse funding quota was satisfied. The recurring service also returned on a zero shortfall before consulting ticket holders. An already-paid satellite award could therefore lose its automatic entry opportunity when its holder regained capacity after the funding quota filled.

The existing discovery pass now reads issued direct satellite ticket targets once through complete keyset pagination. Within the actual prestart window, its existing per-event throttle offers hinted targets to the existing top-up service even with zero ordinary shortfall. The service permits a bounded ticket-only recovery allowance of 25 offers while preserving any larger ordinary quota. Wallet candidates never exceed the original shortfall remaining after ticket candidates. Each hinted registration calls the unchanged atomic horse entry door with wallet charging disabled.

The existing membership, duplicate-entry, four-game capacity, finalized-pool and maintenance rules remain in force. Malformed holder hints refuse the operation. A retiring service generation cannot start a successor request, and stop retains an unresolved registration through the existing lifecycle scope. No new timer, durable queue, SQL authority, cash conversion or ticket target change is introduced.

## Files and original lines

- GameServer.ts: prestart ramp at 5736 and existing REGISTERING pass; adds one read-only target hint helper called by that pass.
- TournamentRecurringService.ts: top-up shortfall at 5629 and registerHorses selection at 6278; the actual prestart caller opts into ticket recovery.
- MttTicketQuotaRecovery.test.ts and PrestartTicketDiscovery.test.ts: actual service and discovery callers.
- Existing bankroll, ticket rail, seat-first, discovery isolation and shared fleet-read guards retain their invariants while accepting the new option and ticket selection.

## Verification

Twelve original failures reproduced the defect: eight service cases and four discovery cases. The final affected services and tournament suites pass 5,752 tests across 369 files with zero skips. Server TypeScript and build pass. The complete engine suite passes 12,258 tests across 819 files. Its 146 database-dependent tests also pass separately in the required private PostgreSQL 17 environment, for all 12,404 discovered cases executed. The initial complete run exposed two old source-shape checks that expected a standalone maintenance condition; the final source keeps that condition explicit alongside the new generation gate. No maintenance guard was changed. This is local engine evidence, not a full production financial certificate.

At 11:37 UTC, read-only production evidence still contains 217 issued direct tickets worth 16,860 whose target entry is closed, plus five future-target tickets worth 100. This source change does not resolve those historical obligations or prove that they all share the quota defect. Separate R32 union-club predicate corrections were installed at11:48UTC, with both actual selector/hint counterexamples verified. Protected CI, serving and natural ticket entry evidence remain required.

## R33: delivery continues while late registration is actually open

The original prestart repair still had no caller when a holder regained capacity after its target started. The same discovery pass now also inspects issued direct-ticket targets that are running with an unfinalized pool. It reads all100-ID chunks before accepting candidates, retains the existing per-event throttle and shared fleet reads, and requires an actual boolean true from the installed late-registration authority before offering a ticket-only entry.

At most four eligibility/entry operations remain pending, matching the existing discovery funding bound. Every request is retained through completion; retirement and maintenance are checked after reads and before entry. Unknown, malformed, failed, finalized or closed responses cannot authorize entry. The atomic horse door rechecks membership, window, load, ticket proof and capacity, with wallet charging disabled. No new timer, SQL writer, forced closed-event entry or historical target remapping is introduced.

The actual running-only discovery case failed on the old caller, and all16original desired late-path cases failed before implementation. The final late-path tests additionally verify null row arrays and duplicate responses. An initial100-ID read used a hard cap of100 and correctly refused a full result; the final query reserves one sentinel row above the maximum possible IN-list result. Both complete101-target traversal and a failed second chunk are now exercised. Affected engine services, tournaments and maintenance suites pass5,785tests/371files; server build and TypeScript pass. The complete engine suite passes12,277tests/820files; its146database-dependent cases also pass in the owned PostgreSQL17environment. All12,423discovered cases were executed. These results do not establish production entry or historical entitlement resolution.

## Current-main integration

Composed with main f7b1488e8e, including R28 current-status resume, terminal blind-clock retirement and the newer waitlist/witness changes. The combined services, tournament and maintenance suites pass5,806tests/372files; the expanded native PostgreSQL departure suite passes157cases, the new witness suite passes12cases, and server TypeScript/build pass. Earlier full12,423-case evidence belongs to the pre-integration R33 tree; this paragraph records the exact additional composition checks. Protected CI and served ticket-entry acceptance remain required.

Current-main composition keeps R30 complete recovery enumeration and the latest manager lifecycle changes. The seat-first law now parses the actual top-up branch: exactly one ordinary registration call remains in the non-seat-first branch with event ID and measured shortfall as its first arguments; the seat-first branch invokes the seating RPC. Optional ticket-policy arguments and multiline formatting cannot falsify the check. No runtime, applied SQL or financial authority was changed by this assertion repair.
