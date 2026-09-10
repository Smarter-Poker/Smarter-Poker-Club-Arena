# Phase 3 Funded Entry And Unregistration

Prepared on September 10, 2026 in agent/codex-entry-refunds-sep10/fix/funded-unregistration. Source began at parent 09c01fba4 and merged origin/main 56962e048 through 02ea27e8 before this correction. That preserves the #4096 current origin-wallet debit/resolver changes. This report does not close Phase 3 or claim the client correction is deployed.

## Finding And Correction

A browser tab retaining a pending refund request after a lost response could encounter a later registration for the same player/event. The database correctly refused the old operation as belonging to a prior registration lifecycle. TournamentService converted that definitive refusal into an unknown-outcome error, and TournamentUnregistrationIntent retained the old request after every refresh. The tab could never advance to a new refund request.

The service now recognizes only code P0404 plus the exact installed prior-lifecycle message. The intent helper resolves that old identity and preserves a newer shared identity. It rejects the current call with an explanation and does not automatically submit a fresh request or emit a refund/balance event. A later user action can request the new refund. Other P0404 messages, wrong error codes, unknown transports and storage failures preserve the original identity.

Wiring: TournamentService.unregisterPlayer and leaveTournamentSeatAndRefund both call executeTournamentUnregisterRpc. That function raises ObsoleteTournamentUnregistrationIntentError only for the exact database refusal; the shared intent helper owns its storage transition. No new endpoint, wallet writer or background repair was added.

## Behavioral Evidence

The new native entry/refund rehearsal passes 14 scenario groups using psql and again through the pinned Node pg client used by CI. Every case starts with the actual public fn_register_for_tournament_request and uses the actual public fn_unregister_from_tournament, composing real debit, journal, immutable charge entitlement, escrow, fee, roster, refund payer and receipt functions.

- One funded entry returns its full original 200 to the charged wallet and leaves zero prize/bounty/fee escrow and no registration. Exact retry writes nothing.
- Adding a second, older membership does not redirect the refund.
- Changing the displayed price from 200 to 500 cannot change the original refund.
- A failure at the final refund receipt insertion rolls back all 15 captured financial/roster relations.
- Observed concurrent same-request and distinct-request refunds commit one credit.
- A refund waiting behind a committed start-state update is refused without returning the buy-in.
- At the scheduled cutoff, no new voluntary refund occurs. If the cutoff arrives during the refund, every write rolls back.
- A previously committed pre-start outcome can still be read after start.
- A free entry creates a durable zero-credit unregistration receipt.
- An old refund identity cannot act on a newly funded registration. A separate new identity returns that later entry exactly once.
- Configured gross prices 1, 5, 10, 25 and 40 preserve the configured 10 percent fee and exact remaining cents.
- Bounty, PKO and mystery entries fund 130 prize, 50 bounty and 20 fee from a 200 charge and return the same components through the common refund.

The existing isolated accounting CI invokes the default runner, which now includes these groups. --unregistrations-only permits focused verification without repeating the previous registration and purchase suites.

Client evidence: the corrected service and intent tests pass 127 tests across three files. The baseline explicitly failed the obsolete-request case with the generic unconfirmed message. The corrected case covers event and seat endpoints, preserves another tab's newer pending request, retains unknown identities, and retains the old identity if storage retirement fails. Another 43 source/seat/refund compatibility guards passed. TypeScript and the configured production build passed. The build reported behind-main=0 and local DIRTY provenance and performed its configured Sentry source-map upload; it is not publication evidence.

Logs: /tmp/codex-entry-refunds-baseline.log, /tmp/codex-entry-refunds-unit-final.log, /tmp/codex-entry-refunds-tsc.log, /tmp/codex-entry-refunds-build.log, /tmp/codex-entry-refunds-native-pgclient.log. Native psql result: /tmp/ca-registration-funding-pg17-vukodapx/results.json. Native Node result: /tmp/ca-registration-funding-pg17-la_odvcs/results.json.

## Dated Primary Benchmarks

Retrieved September 10, 2026: [PokerStars Tournament Rules](https://www.pokerstars.com/poker/tournaments/rules/), sections 1.3, 1.8, 1.9 and 1.10, disclose rebuy/registration details, require available funds for rebuy, separate late registration wall time and define event-specific unregistration. [PokerStars Re-entry](https://www.pokerstars.com/help/articles/tourn-reentry-registration/) permits re-entry after elimination and within late registration. These are operator benchmarks, not a universal regulatory standard.

Club Arena's approved pre-start-only and originating-wallet common-refund rules control this audit. PokerStars' satellite ticket/T-Money policy is a documented product difference and is not imposed here. The tested prices are synthetic configurations, not a change to future prices or fees.

## Control Disposition

| Control | Evidence Added Or Retained                                                                                         | Remaining Boundary                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| T01     | Actual paid entry feeds actual refund; #4096 debit/resolver source retained                                        | Full HTTP/RLS, all membership/union cases, late-entry seating and launch race                              |
| T02     | Five configured prices, free entry, bounty/PKO/mystery component round-trips                                       | Every promotion/configuration and all UI disclosure paths                                                  |
| T04     | Existing generation, elimination, count, cutoff and competing-purchase evidence retained without unnecessary rerun | Real accepted-hand settlement racing grant and complete engine consumption                                 |
| T05     | Existing atomic rebuy/re-entry/add-on funding evidence retained                                                    | Full trigger graph, union funding, expansion and complete engine grant consumption                         |
| T06     | Fourteen new native groups plus obsolete-client-intent root correction                                             | Actual launch/accepted-hand concurrency, satellite-transfer boundary, full HTTP/RLS and client publication |

## Explicit Limits

Current refund core, receipt and scoped settlement-lock bodies were read from the live catalog and recorded in scripts/dev/fixtures/unregistration-funding/source-manifest.json. Every native case verifies those hashes plus the public wrappers and exact payer. Other support bodies compose the existing documented fixtures and #4096 source transformations; this is not certification of the entire live dependency graph.

Auth/session and maintenance are synthetic. Empty hand/launch tables model an unstarted event. The competing start case updates start status and timestamp, not the full actual launch writer. Actual seat-first/SNG/Spin launch, satellite transfer and cancellation remain separate lanes. No production financial transaction, historical payment, manual wallet adjustment, migration, push or deployment was performed by this lane.
