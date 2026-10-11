# Cashier Phase 2: Withdrawn Access And Interrupted Transfers

An interrupted transfer keeps its original operation identity across edits, reloads and signout. Trade batches preserve their original wallet destinations and ticket notes; explicit recovery checks committed receipts before checking today's roster, skipping already committed recipients. Unknown outcomes remain visible and never claim that nothing moved.

Advanced Send/Distribute, native wallet Send/Claim/Reverse and Diamond transfer persist identities before submitting. Browser Web Locks serialize allocation across tabs; unavailable or unreadable safety storage refuses a new request. Journals omit raw reason text and personal names. Successful original receipts retire only their matching keys; delayed replies cannot clear a newer request or paint another account or club.

Membership role/status changes invalidate open form authority. Balance-only updates preserve valid transfers. Explicit agent management events and returning to the view refresh authority, while existing database transactions remain the final permission check. Subscription authority readback preserves the roster's first-page loading behavior.

The new read-only `fn_cashier_recovery_receipts` returns at most 25 requested committed operation/ticket receipts owned by the authenticated issuer in the specified club, even after access withdrawal. It grants no new movement permission and cannot reveal another operator's ledger. Installed once as history version 20261011150550; source and definition hashes match isolated PostgreSQL qualification. Existing migrations and settlements were not replayed.

Validation includes mounted authority withdrawal, partial recovery with a removed committed recipient, frozen destination and original remaining ID, stale view replies, corrupt journals, cross-tab exclusion, lost Diamond replies and compare-before-retirement. Native PostgreSQL qualification covers 98 cases, including actual bank-door refusal for a removed co-owner and original receipt visibility after suspension/removal, other-actor isolation, bounded reads and private-door ACLs. The maintained Accounting1 workflow now enforces the native test.

This phase covers transfer recovery. Mint creation, conservation reporting, batch product enhancements, performance and device-wide accessibility remain in their separately authorized phases. No production financial fault tests or engine activation are required. Protected checks, merge, publication and affected live proof remain separate delivery states.

The first-paint module declaration explicitly includes the dependency-free journal prefix constants needed by synchronous sign-out cleanup. No wallet recovery implementation or dependency tree enters first paint; bundle limits remain unchanged.
