# An elimination requires a finishing rank

The installed public atomic elimination RPC accepted a NULL position because its existing `p_position < 2` check did not reject SQL NULL. With otherwise accepted zero-stack evidence, the real function closed the seat and marked the player and candidate eliminated while leaving the finishing position NULL.

The forward migration adds `p_position IS NULL` to that existing refusal condition. It changes no positive-rank ordering rule, legacy core, payment path or historical row. The migration refuses an unexpected installed function body.

An isolated PostgreSQL 17 baseline passed five rank-persistence, replay, evidence and rollback groups, then reproduced the NULL-rank defect. Only the changed NULL boundary was rerun after the correction; it passed, including no-write refusal followed by a valid rank claim. Candidate application and replay both retained the expected function hash, and both private clusters stopped normally.

This proves a narrow persistence boundary with synthetic accepted-hand inputs and actual installed elimination/seat/sequence writers. Simultaneous-bust policy, shared-hand epochs, real hand production and final-table transitions remain separate acceptance requirements. No production migration was applied by this lane.

Evidence: `docs/audits/2026-09-10-phase3-elimination-rank-evidence.json`.
