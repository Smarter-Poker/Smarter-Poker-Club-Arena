# Engine Deals Bind The Current Proposal

## Existing Behavior

`TournamentManagerEliminations.ts` counted tournament-wide vote rows twice, first before selecting the physical engine and then after parking it. Neither read bound consent to the prize/stack proposal the players accepted. `terminalSettlementRpc.ts` then invoked the unversioned terminal operation, leaving a further gap if consent changed after the parked check.

## Intended Correction

Consume the service consensus RPC at both admission points. Validate its exact UUID voter set, active roster count, proposal UUID, canonical revision hash and ready flag. Carry the original proposal identity through parking and refuse a changed or malformed consensus before terminal settlement. For final-table deals, bind all terminal retries and the serialized outcome resolver to that proposal. Require the same durable proposal identity in returned receipts and refusal envelopes. Retain the physical engine, maintenance, break and hand-boundary checks. Ordinary place settlement and all money formulas remain unchanged.

The paired database authority is owned by the payout audit lane. New service RPCs must be applied and verified before the engine integration is deployed. No production write or deployment is performed by this lane.

## Verification

Re-read the complete source and test diff. The final regression run passed 154 tests in nine files, including 24 consensus admission/boundary cases and 16 terminal RPC recovery cases. Coverage includes malformed, partial, duplicate and foreign voters; stale proposals and revisions after parking; unavailable transport before and after parking; no terminal write before a proven hand boundary; immutable proposal identity across retries; and mismatched direct, resolved and nested receipt identity. Existing payout-integrity, cleanup, deadlock retry and ordinary-place settlement regressions remain passing.

Full server TypeScript passed with exit code 0 on resume, using the existing shared compiler and dependencies through `/tmp/codex-chip-spin-swarm-tsconfig.json`; no dependency installation or copy was needed. Logs: `/tmp/codex-chip-deal-swarm-tests-final.log`, `/tmp/codex-chip-deal-swarm-tsc-shared-resume.log`, and its `.exit` file.

The payout lane confirmed the implemented RPC signatures and receipt identity fields. Native database composition, the production SQL prerequisite and publication remain pending with the Phase 3 coordinator. The engine change is prepared for ordered integration; this evidence does not close Phase 3 or claim the change is live.
