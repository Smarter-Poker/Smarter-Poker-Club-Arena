# Rakeback Claim Response Candidate

The installed `fn_claim_rakeback` returns `success`, `total_payout` and `periods_claimed`. It returns `success: false` with an authentication error when no caller identity exists, and counts only successful positive lower-owner payouts. The preserved `installed-claim-owner.sql` is source evidence from the payer's installed catalogue, not an application script.

The previous UI ignored `success` and `error`, defaulted absent totals to zero, and could report a successful claim for non-finite or contradictory values. It also displayed an authentication refusal as no rakeback to claim. The successor requires an explicit successful response and validates finite, nonnegative, safe-range totals and integral counts. A positive amount needs a positive count; zero/zero reports no payout and permits the server's deferred-period behavior. Valid partial aggregates display only the confirmed payout. Refusals retain the server message. Unconfirmed replies refresh authoritative period/wallet reads without emitting RAKEBACK_CLAIMED or asserting that money did or did not move.

A new claim also cancels the prior success-message timer, so it cannot reset the claim state while the next RPC is pending or erase the next refusal.

## Wallet Refresh Wiring

This is a source review of the current literal subscribers and shared event arrays. GlobalHeader, DynamicWallet, PlayerWalletModal, TransactionHistory, AgentManagementPage, CashierPage, ClubFinancialsPage, PlayerWalletPage, SettlementPage, SuperAgentDashboard and TransactionHistoryPage respond to WALLET_REFRESHED by fetching data. CashierClubSwitcher, ClubQuickLinkTile and the cashier's quick-link subscriber invalidate the club balance cache. They do not assign the event's available/total values as balances. The wildcard MasterBus listener is the developer event log. The existing zero-valued BalancePayload is therefore retained as a current-consumer invalidation signal; no bus contract is changed. This review does not establish behavior of future consumers.

## Proof And Limits

The final component suite passed 25 cases: the eight readiness scenarios, now with explicit actual-contract success flags, and seventeen refusal, zero, partial malformed-response and deferred second-claim timer cases. The page, readiness/parser helpers, rewards header and retry owner execute; Supabase/auth/events/chart boundaries are mocked. Actual installed authentication spelling and numeric partial response fields are used. Raw output and exact input hashes are adjacent. No native payment was exercised by this component proof.

The original eight-case proof is preserved separately under `baseline-9da95b3`, with its exact three source/test inputs and raw output. Its input hashes resolve within that directory and all match the immutable UI commit `9da95b3b3a0b4f93e93f059f88cc9bb00dabb42f`. The earlier `2026-09-11-rakeback-readiness` evidence remains historical proof of that commit; it is not a hash assertion about this changed page or test.

This response correction is prepared in the dormant integration worktree. The full UI package still requires the reviewed standalone legacy maturity, pointer and duplicate-payment repair with preserved aggregate-player shortfall behavior before UI publication. This report is not backend activation, production publication, bank finality, funding availability or a new claim RPC/capability contract.

## Subsequent Read Review

This response/timer checkpoint does not yet fix coalesced refreshes, auth-user ownership of deferred reads, or discovery of claimable periods beyond the existing 12-row history slice. Those concrete read-path followups remain pending before final integration/publication.
