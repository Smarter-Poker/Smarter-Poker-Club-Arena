# Diamond Phase 4 Transfer Inventory

Status: implementation in progress. No Phase 4 release is claimed.

## Verified Current State

- Fresh World Hub origin/main retains pages/api/store/diamond-transfer.js, whose handler returns HTTP 410 and p2p_transfers_disabled. Its preceding legacy helper code is not an active transfer implementation.
- Read-only production pg_get_functiondef confirms send_wallet_diamond_transfer also refuses with p2p_transfers_disabled. Restoring only the wallet button cannot complete this phase.
- DIAMOND-RULINGS 4 was amended on September 8 to permit one atomic authenticated platform wallet transfer, available funds only, preserving recipient validation and applicable provenance and limits. The retired two-call debit/credit pair and hard-coded account exemptions must not return.
- Phase 3 reserves funds out of profiles.diamonds into poker_diamond_custody. Transfers must lock the same authoritative available balance and cannot consume custody or its purchased-lot reservations.
- The production giftable-balance helper subtracts unconsumed purchased lots. Stream gift policy remains unchanged. Any transfer provenance implementation must be reviewed against the current purchased-lot and debt contract, not inferred from dead JavaScript source-tier constants.

## Required Implementation And Acceptance

Use isolated Club Arena and World Hub codex-diamond-phase-4 worktrees. Inventory current wallet callers, recipient eligibility, journal/register triggers, debt retirement and spend locks before edits. Provide one transaction with stable request-bound replay, deterministic profile lock order, authoritative limits and both-party durable receipts. Preserve the current shared wallet and active table layers. Verify authorization, changed-request replay refusal, rollback, response loss, both-party refresh, custody isolation and transfer/store/reserve races with isolated fixtures before production acceptance.

Phase 3 final repairs remain independently tracked in PR 3982 (seat parent relationship) and PR 3985 (custody failure management visibility). Its running engine must actually adopt the required source before its release gate is closed; a staged image or successful workflow without cutover is insufficient.
