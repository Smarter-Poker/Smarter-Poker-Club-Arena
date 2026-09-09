# Atomic Diamond Wallet Transfers

Phase 4 implementation, September 9, 2026. Publication and authenticated acceptance remain open.

The shared Arena wallet now verifies an accepted friend's player ID, shows their Arena handle and asks for confirmation. A pending request is retained across modal close and refresh; retries ask for the same immutable database receipt. The platform transfer API delegates to the same authenticated RPC. No two-call debit/credit pair, compensation, scheduler or hard-coded account exemption is used.

The database locks both profiles deterministically, checks friendship and the current shared sending limits, and commits both journal legs, wallet updates, any recipient debt retirement and its receipt together. Custody and purchased refund collateral remain untouched. Purchased collateral already reserved in custody is not subtracted from available balance twice. Stream gifting remains unchanged. Receipts expose neither participant's balance or debt.

Production applied atomic_wallet_diamond_transfers as 20260909200327. Read-only verification found zero transfer rows, RLS enabled, authenticated execution permitted, anonymous execution refused and RPC body MD5 17fbc7ff2a9176d3cca3f94d91721292. No real-player transfer was made.

Verification: 26 isolated PostgreSQL assertions passed, including concurrent delivery, competing transfers, transfer versus the existing spend writer, debt retirement, injected journal rollback, immutable receipts and custody isolation. Eight focused wallet tests passed. Prior Phase 3 test results are reused, not counted again.

Remaining: normal repository gates, both repositories' publication, authenticated live acceptance, and the remaining transfer-versus-reserve race. Phase 3 engine adoption remains independently open; at 20:00 UTC it was healthy on 5dd902e9, with zero blocked settlements.

Work scope follows Dan's September 9 instruction: concrete Phase 4 requirements only, reuse verified evidence, no duplicate optional suites or speculative hardening.
