# Rakeback Discovery And Request Ownership

This dormant UI successor follows the immutable `63c4bb4f0fc95409fba5d6875cac00a71904ddd2` response/timer checkpoint. It does not activate a backend repair or new capability.

The page now reads twelve recent periods and separately discovers one positive pending period whose inclusive end date is before today's UTC date. This second bounded query finds an eligible club beyond the displayed history. The next UTC midnight always triggers rediscovery, including when every displayed row is paid. The claim rechecks the clock and sends the existing club-scoped `fn_claim_rakeback` RPC.

Recent Earnings and Recent Pending Earnings describe only the displayed history. Latest Period Rate describes the latest displayed period, with Unavailable for missing/non-finite rates and a real zero retained. Next Ready Period is explicitly an estimate for one discovered period; a club claim may cover more periods and the server recomputes its payout.

Overlapping refresh requests coalesce into one follow-up read, including a post-claim refresh and a new account load. The queued read survives the earlier read's failure. An account epoch hides prior account data and fences old reads, claims, retry callbacks and status timers. Each admitted claim has its own active attempt ref. The existing Supabase-aware retryFetch performs at most two retries, including actual PostgreSQL 40P01 result objects, while its existing deterministic/auth refusal exclusions remain unchanged.

Only a valid positive server response emits RAKEBACK_CLAIMED. Zero responses say no additional payout was confirmed and refresh wallet reads. Malformed responses and exhausted transport uncertainty refresh authoritative reads without asserting whether money moved. An earlier committed request may lose its response before a zero retry. Known aborted database errors and auth refusals retain their existing error behavior. WALLET_REFRESHED remains the current invalidation event; inspected current subscribers refetch/invalidate and do not adopt its placeholder values as balances.

## Evidence

`component-proof.json` pins five current input hashes and the raw `component-test-output.txt`. All 44 focused cases passed against the actual page, readiness/parser/retry helpers and header, with only external boundaries and chart layout mocked. The query fixture applies user/status/amount/date/club filters, sorting and limits. Deferred reads and RPCs exercise overlap, failure, account changes and retry deadlines.

`baseline-63c4bb4` preserves the previous exact four input files and its original 25-case proof/output. The earlier readiness audit preserves the original eight-case checkpoint. These are separate historical observations, not 77 independent current cases. The intermediate 42-case local run was superseded by the final 44-case source and proof after peer review corrected transport and read-error wording.

## Adoption Hold

The UI alone cannot stop the old club-scoped server from paying an open period in the same club. Publication requires the coordinated standalone legacy repair: current owner/schema/ACL readback, its exact atomic 00 entrypoint, then runtime/trigger/ACL readback before this UI is published. This UI evidence contains no production money calls, SQL application, capability activation, complete accounting certification or current engine health assertion.
