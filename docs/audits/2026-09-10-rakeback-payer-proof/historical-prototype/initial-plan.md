# Rakeback payer concurrency audit

Captured installed functions on 2026-09-10. No production mutations.

Existing behavior: fn_close_settlement_period locks the period and pays from its club treasury; fn_claim_rakeback delegates to it. Round3 selects aggregate pending amounts before any period lock and pays from the agent wallet. Its unique journal key is only inserted after balances move, and it records no rakeback_period_payouts receipt. Therefore a stale concurrent selection may pay again. The independent close updates its wallet evidence pointer before its own wallet_transactions row is inserted.

Proposed invariant-preserving correction: exact per-period locking and shared payout receipt across both payment routes; one immutable journal leg and one wallet evidence pointer per new Round3 period payout; move the close evidence link after the actual wallet row exists. Preserve route-specific payer and configured rates pending the explicit policy decision. Do not backpay historical no-receipt periods or rewrite paid records.

Verification: captured installed SQL in isolated PostgreSQL 17, deterministic observed lock overlap, exact balance deltas, both route orders, changed membership replay, independent club scopes, short funds, injected final journal failure, and role denial. Full production-schema trigger acceptance remains separately named until included.
