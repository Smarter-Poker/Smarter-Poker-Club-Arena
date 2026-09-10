# Final Deal Review Binds Consent To The Displayed Proposal

The tournament overview previously submitted a tournament-only vote and showed an unversioned voter count. A player could not inspect and approve the exact recipient allocation the engine would later execute.

The overview now mounts a deal review only for a remaining player at a final table. It reads the server proposal and displays each exact payment, finalized pool, and remaining deal pool. Decimal amounts stay strings and use BigInt for formatting and consistency checks. A malformed actor, tournament, proposal, revision, participant, voter, nonpositive amount/stack, or inconsistent total prevents agreement.

A vote includes the displayed proposal ID and validates the returned actor, proposal, and revision. The current authenticated account must still match. Same-frame repeated clicks produce one request. A stale or ambiguous response refreshes authoritative consent without submitting a replacement vote. A changed proposal always requires another click. Polling follows the exact proposal every 15 seconds while the panel is mounted and is independent of voter-count events. Account/event changes and unmounts invalidate old reads and vote completions.

## Verification

- 74 focused tests passed in three files: 28 service contract tests, nine rendered review scenarios, and 37 existing detail contracts.
- 229 related regression tests passed across six existing files that reference the changed overview or vote flow.
- Two rendered account/event-change scenarios failed before the context fence and passed after it, covering both a late successful and a late failed old vote.
- Full client source strict TypeScript passed using the existing root worktree dependencies through a temporary path configuration. No dependencies were copied or installed.
- The review tests completed without React act warnings after asynchronous test coordination was corrected.
- React review covered request identity, cleanup, single-flight actions, exact strings, semantic table headers, error/status feedback, and a 44-pixel minimum button target.

## Release Dependency

This source is prepared for the matching versioned proposal expansion and proposal-bound engine. The new getter and vote authority refuse `proposal_authority_not_active` until coordinated activation. Required order is SQL expansion, compatible engine/client adoption, then activation by the cutover owner. This lane did not apply SQL, alter production balances, publish a bundle, activate guards, or verify production browser behavior. The old tournament-only voting authority is not used as a fallback.

CA-03-06 and CA-03-12 remain open until native consent-to-payment acceptance, coordinated deployment, and browser acceptance are complete. This change does not close the full accounting Phase 3 programme.
