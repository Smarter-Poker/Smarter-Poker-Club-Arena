# Settled bounty retries remain valid after later hands

A successful PKO payout became unreplayable after another hand advanced the tournament watermark. The collection authority applied pending-payment ordering before inspecting its exact settled receipt. Read-only production evidence at 12:33:32 UTC found 1,129 complete PKO receipts below that watermark.

The existing settled-marker branch now executes first. New payments retain both ordering checks. Exact generation selection, marker completeness, denomination math, settlement locks, wallet/head writes and monotonic watermark updates are unchanged. The existing engine and database callers use the same function.

Migration `20260914122903_settled_bounty_replay_precedes_pending_order.sql` checks the reviewed function body, owner, ACL, search path, volatility and security mode before editing the original function, then verifies the exact postimage. It makes no row updates. It was applied once as history `20260914123347`; 12:34:09 UTC readback confirmed body `6dcaf498835e691b15384aa5aabcfdfe`, unchanged metadata, and the settled branch preceding pending ordering.

Validation: 103 private PostgreSQL 17 assertions passed, including 20 old-source rejected-replay witnesses, five concurrent repaired replays, chip/Diamond and single/split receipts, missing markers, generation ambiguity, unchanged financial fixture rows, metadata/source drift refusal and migration replay. The 664 affected engine accounting tests across 38 files and server TypeScript/build passed. The fixture README identifies synthetic receipts, older captured supporting schema and a financial-payer exception trap. This is replay qualification, not an original-funding or full provider certificate.

Protected source CI, natural production replay evidence, cross-table PKO ordering and historical missing bounty claims remain open. No production payer was invoked as a test.
