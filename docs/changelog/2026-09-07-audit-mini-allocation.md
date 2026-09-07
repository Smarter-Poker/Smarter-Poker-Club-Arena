# Mini Jackpot Allocation Is Exact Before Credit

The September 7 audit reproduced the current SQL paying 249.99 against a 250.00 debit with three table-share recipients. Six recipients round upward to 250.02. The positive remainder was sent in a second loser credit that recipient idempotency discarded; a negative remainder was ignored.

The existing fn_bbj_mini_payout now adjusts the signed residual into the loser share before any credit, matching the main jackpot policy. It records the actual table total, normalizes duplicate/null recipients, validates winner/loser identities, locks the pool before checking replay, and returns the recorded per-player share even after tier disablement. No rates or future award amounts changed.

The actual PostgreSQL function body passed 54 allocation scenarios in pg_temp, plus replay after tier disablement, reserve boundaries, and invalid identities. Every probe ends with AUDIT_TEST_PASS as an exception and rolls back. The recipient helper is an idempotent stub: these are SQL integration tests of the Mini function, not certification of wallet triggers, concurrent sessions, or client behavior. The original function failed the three-recipient fixture at 249.99.

Applied production migration 20260907194634, assigned by Supabase MCP. The repository's version generator first reserved a local filename; it was renamed to the actual database-assigned version so source history and the deployed migration agree. A catalog hash precondition prevented overwriting a concurrently changed function. A missing statement terminator caused the first apply to fail without a committed change; corrected apply succeeded. The post-apply probe loaded the deployed function body and passed the same 54 cases at 19:47 UTC.

At 19:41 UTC production had 29 Main awards totalling 100,990.90, recipient claims totalling the same amount, zero Mini awards, and zero parked shares. No historic Mini reimbursement was indicated. These aggregate claims are not a complete wallet reconciliation.

Transport: direct git clone is unavailable in this cloud environment. Versioned files are submitted via the repository-authorized GitHub MCP route. No project-wide TypeScript/build/CI result is claimed locally; repository checks remain required. No engine or UI runtime was changed. No monitor, sweep, back-pay job, or player balance adjustment was added.
