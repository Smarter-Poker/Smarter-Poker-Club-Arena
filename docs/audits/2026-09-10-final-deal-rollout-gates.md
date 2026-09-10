# Final Deal Rollout Gates

Status: proposed rollout; accounting Phase 3 and final-deal acceptance remain open. This initial proposal changes documentation only. It does not install SQL, publish a compatible client or engine, activate consent enforcement, or satisfy a release gate.

## Ordered Rollout

1. **SQL expansion.** Install additive, versioned proposal and consent storage plus compatible preview, consensus and proposal-bound settlement interfaces. Preserve the existing financial authority. Each proposal binds tournament, participant identities, accepted seat/stack generations, exact decimal shares and revision. Verify installed bodies, dependencies and privileges before exposing the interfaces.
2. **Compatible engine and client.** The engine must retain manager context, recheck the same proposal and unanimous participant snapshot before settlement, and preserve identical retry identity. The client must display the server plan and exact shares, bind consent to that proposal/revision and authenticated participant, and reject stale or changed proposals. Verify the intended engine release and both frontend publication identities through the owning release lane.
3. **Verified activation.** Enable the prepared consent requirement only after the complete compatible rollout and native acceptance pass. Confirm direct calls, interrupted settlement and replay retain the same approved plan and exact stored receipt. Activation belongs to the serialized production cutover owner.

## Review Deadline

Use a server-owned, configurable review deadline with a 120-second default. Store the authoritative deadline with the proposal and evaluate expiry using server time. The client may display remaining time; it cannot extend a proposal or authorize late consent. A changed plan requires a new revision and fresh review. The native acceptance suite must exercise expiry and concurrent consent at the boundary.

## Required Evidence

- A complete current PostgreSQL dependency graph, including the M5 terminal settlement authority and proposal-bound wrappers. A mixed schema, missing `fn_complete_tournament_terminal(uuid,uuid,text)`, or mismatched receipt body/privileges cannot certify this rollout.
- Current manager lease and generation admission on every relevant service route, including lost-context, lease-expiry and concurrent-owner refusal. Reuse the owning Stage B evidence; do not activate disabled safeguards from this proposal alone.
- Native real-money authority tests for exact unanimous consent, stale participants or generations, changed shares, expiry, identical retries, concurrent requests, and failure after a downstream credit. Prove complete rollback or one exact committed receipt, with no duplicate payment or mutable finalized pool.
- Verified SQL expansion, compatible runtime/client identities and authorized activation, followed by the complete user flow. Focused unit or source-contract checks and an approved proposal PR do not close Phase 3.

The prepared feature changes must remain in draft until these dependencies and their ordered release path are reviewable. No production state changes are authorized by this document itself.
