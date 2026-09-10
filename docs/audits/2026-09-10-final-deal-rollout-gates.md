# Final Deal Rollout Gates

Status: draft PR #4106 now contains the paired SQL expansion, separate activation script, engine, client, and native proof sources. Accounting Phase 3 and full final-deal acceptance remain open. No SQL installation or exact-consent activation has occurred from this work.

## Ordered Rollout

1. **SQL expansion.** Install additive, versioned proposal and consent storage plus compatible preview, consensus and proposal-bound settlement interfaces. Preserve the existing financial authority. Each proposal binds tournament, participant identities, accepted seat/stack generations, exact decimal shares and revision. Verify installed bodies, dependencies and privileges before exposing the interfaces.
2. **Compatible engine and client.** The engine must retain manager context, recheck the same proposal and unanimous participant snapshot before settlement, and preserve identical retry identity. The client must display the server plan and exact shares, bind consent to that proposal/revision and authenticated participant, and reject stale or changed proposals. Verify the intended engine release and both frontend publication identities through the owning release lane.
3. **Verified activation.** Enable the prepared consent requirement only after the complete compatible rollout and native acceptance pass. Confirm direct calls, interrupted settlement and replay retain the same approved plan and exact stored receipt. Activation belongs to the serialized production cutover owner.

## Review Deadline

Use a server-owned, configurable review deadline with a 120-second default. Store the authoritative deadline with the proposal and evaluate expiry using server time. The client may display remaining time; it cannot extend a proposal or authorize late consent. A changed plan requires a new revision and fresh review. The native acceptance suite must exercise expiry and concurrent consent at the boundary.

## Required Evidence

- A complete current PostgreSQL dependency graph, including the M5 terminal settlement authority and proposal-bound wrappers. The coordinator's production read at 2026-09-10 05:03:52 UTC confirms `fn_complete_tournament_terminal(uuid,uuid,text)` exists live; existing synthetic rehearsals lack it. That local M5 coverage gap and mismatched receipt bodies/privileges prevent native certification.
- Current manager lease and generation admission on every relevant service route, including lost-context, lease-expiry and concurrent-owner refusal. Reuse the owning Stage B evidence; do not activate disabled safeguards from this proposal alone.
- Native real-money authority tests for exact unanimous consent, stale participants or generations, changed shares, expiry, identical retries, concurrent requests, and failure after a downstream credit. Prove complete rollback or one exact committed receipt, with no duplicate payment or mutable finalized pool.
- Verified SQL expansion, compatible runtime/client identities and authorized activation, followed by the complete user flow. Focused unit or source-contract checks and an approved proposal PR do not close Phase 3.

The prepared feature changes must remain in draft until these dependencies and their ordered release path are reviewable. No production state changes are authorized by this document itself.

## Integrated Verification And Publication

The integrated source passes 143 client tests in five files, 175 engine tests in nine files, and both full TypeScript checks. The native deal probe passes the same 68 assertions for each paid, unpaid and partial tail state, plus three two-session lock assertions. Actual cash, journal and escrow writes roll back after a late credit fault, and exact replay makes no second payment. Native Spin proofs cover immutable funded launch recovery, same-event concurrency and two distinct launches competing for an insufficient shared reserve. Independent source review found no remaining source blocker. These checks do not certify whole terminal completion against unmatched live authorities.

PR #4096 merged as `02b267443d6d304f885fd6494a4a30309bc515b9`; CI run 34439368293 and publisher run 34440474031 succeeded. Both frontend build-info endpoints returned HTTP 200 with that exact commit and build time 2026-09-10T05:19:55Z. Automatic engine deployment run 34440541284 failed its current-main release-control check. No manual engine dispatch or release mutation was performed, so engine adoption remains unverified.

At 2026-09-10 05:42:09 UTC the current seat-move and receipt resolver functions are present, all seven guards remain disabled, and the bounty-rebuy generation helper remains absent. The live terminal completion, outcome resolver and rake body hashes still differ from the tracked candidates after a bounded dynamic-transform audit. See `2026-09-10-versioned-final-deal-native-acceptance.json` for exact parity evidence. The release task retains engine seal and Stage-B ownership. Existing automatic-review blocks on seating diagnostics and satellite receipt restoration remain in force. The cloud browser connection failed before page opening, leaving live UI acceptance open. Phase 4 has not started.
