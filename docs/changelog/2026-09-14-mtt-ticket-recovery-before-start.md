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

At 11:37 UTC, read-only production evidence still contains 217 issued direct tickets worth 16,860 whose target entry is closed, plus five future-target tickets worth 100. This source change does not resolve those historical obligations or prove that they all share the quota defect. Separate union-club redemption predicates also conflict with current issuance rules and are under investigation. Protected CI, serving and natural ticket entry evidence remain required.
