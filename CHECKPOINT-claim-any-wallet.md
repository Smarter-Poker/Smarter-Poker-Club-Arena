# Claim Back From Any Member Wallet

Owner: Codex chat 01a17b48. Scope: management Claim Back on CashierTradePage must select player, agent or promo wallet; selected balance, Claim All, validation, durable intent and RPC source agree. Preserve owner/co-owner/admin authorization, ordinary-agent ten-minute reversals, cents, atomic ledger writes and retry identity. No unrelated wallet redesign or financial adjustments.

Checkout: /Volumes/SmarterWork/agent-work/claim-any-wallet-01a17b48
Branch: fix/claim-any-wallet-01a17b48
Base: ad4a8b4616, current origin/main at creation. No prior checkpoint exists for this new assignment.

Policy read 2026-10-27T02:55:29Z, v2.9. Manifest a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b. Owner b9478d0331314413d8e12c41210b63479cdcabc1f86ed3fdcb3251efa36e6349; operating a8bc3c04dce3354ebdd51a89c0b7d715af3344edcc794d33f6b3ad64506961d5; hardening d5fc451ce5caf6d6b5e64597a13883e1246581678fe53c962339d0a66136993e; reference adce89c3f838f2f373cd504a00329d53906404d1dd42a647f672af6c16f95555. Read canonical four policies, storage guide, repository AGENTS/CLAUDE/playbook/publishing/deploy paths and console skill. SSD mounted /dev/disk5s4 with ~20GiB free. All new work on external SSD.

Cause: management claim dialog displayed roster player chipBalance and hardcoded p_source='player_wallet' in reservation and RPC. Agent/promo wallet balances never read or offered.
Live read: configured Supabase kuklfnapbkmacvwxktbh functions fn_cashier_recipient_wallet_balances, fn_club_bank_claim_back, fn_club_bank_claim_core_20261004 confirm supported player/agent/promo selection, current authorization and exact-intent wrapper. Read-only; no money moved. GitHub configured identity Smarter-Poker available.

Delivery classification: client financial interface using existing installed RPCs. No engine dependency or migration. Required local checks, protected PR/merge, owning static publisher, both public provenance endpoints and affected browser behavior remain pending.

Validation 2026-10-27T03:00Z: private npm ci succeeded; app TypeScript passed. Real mounted-page suite 80/80 passed. Six new regressions fail against original HEAD and pass against fixed source (work/regression-red.log and green.log). Live browser reproduced exact Titanup case: Agent Wallet 1,500.00 in roster but Claim Back shows Player Wallet 0.00, no source selector. Current live dialog inspected only; no claim submitted. No nested AGENTS/CLAUDE files in affected src/tests paths.
