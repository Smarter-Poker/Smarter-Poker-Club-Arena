# Phase 4 final closure audit - Club Arena

Date: 2026-09-08 America/Chicago  
Branch: `agent/codex-horse-phase4-final/fix/horse-phase4-final-closure`  
Scope: certified NLH V31 ingestion, in-memory stores, decision execution receipts, candidate evaluation, release gates, and PostgreSQL behavior probes.

## A. Repository and production truth

- Work was performed in the dedicated Club Arena worktree, not the shared checkout.
- The starting branch commit was `8634e19129b8662a53293a1cb7ee8197bde4af55`.
- Live Supabase project `kuklfnapbkmacvwxktbh` already had the three corrective migrations applied. The final serialization migration was recorded by Supabase as `20260909025949`; this audit corrected the repository filename and harness references to that exact ledger version.
- No V31 input bundle, dataset, source artifact, runtime cell, release evaluation, worker heartbeat, compactor heartbeat, or decision-level agreement receipt existed at the pre-release readback. No strategy was activated.

## B. Defects reproduced

1. The legacy V30 loader cleared the last-good in-memory snapshot before validating every refreshed row. A malformed, duplicate, short, or shifting paginated read could therefore erase or partially replace working policy.
2. V30 compact cells accepted incomplete identities and coercible values that were not trustworthy policy probabilities.
3. V31 compact validation coerced string frequencies and did not enforce canonical hand-class order.
4. Candidate evidence counted the sampled V31 action before the final engine legalizer. An impossible raise could become a call while the release result still claimed that the candidate policy executed.
5. Same-day candidate-result reuse used a 12-character checksum prefix and did not bind all eight gates to one exact, clean, published evaluator commit.
6. Candidate and promotion checks trusted previously admitted release receipts without independently rechecking the immutable source result, exact V2 configuration, full checksum, current incumbent, and zero execution mismatches.
7. Two different candidates could validate against the same incumbent concurrently because their row locks did not serialize the release estate.
8. The V30 facing-bet fallback documented and returned a `bet_mid` bucket that the V30 compact store has never persisted. The branch was already inert in that range, but its type and documentation falsely described an available policy.

## C. Corrections

- V30 refresh now brackets pagination with exact row-count and latest-build boundaries, validates the complete snapshot into a separate map, rejects malformed or duplicate cells, and swaps the map atomically.
- V30 and V31 stores now require canonical hands, exact numeric finite probability and EV values, coherent dimensions, legal action domains, and complete probability mass.
- V31 execution receipts are emitted only after legalization. Calls permit the semantic short-stack `all_in` result; bets and raises require the same final family and a wager within one legal chip step of the sampled target.
- Candidate hit and node-role counters include only actions executed as intended. Mismatches are separately aggregated, persisted, reconciled in every benchmark component, and required to equal zero.
- Evaluation contract `gto_v31_candidate.v2` uses the full dataset checksum, exact scenario list, exact incumbent checksum, and one clean 40-character evaluator commit that must already be on `origin/main`.
- The database freezes every `horse_league_results` row once used as release evidence. Candidate and promotion functions recheck the source rows and checksums rather than trusting copied verdict labels.
- A transaction-scoped advisory lock with the stable key `smarter-poker:gto-v31-release-gate` serializes candidate and promotion transitions across different dataset rows. The helper remains private to service role callers.
- The V30 facing-defense middle band now fails closed explicitly instead of naming a nonexistent action bucket.

## D. Verification completed before main reconciliation

- Focused Vitest: 9 files, 134 tests passed.
- Server TypeScript: `npx tsc --noEmit` passed.
- PostgreSQL 17 adversarial harness passed:
  - `V31_CERTIFICATION_BEHAVIOR_OK`
  - `SOLVER_AGREEMENT_BEHAVIOR_OK`
  - `LIVENESS_BEHAVIOR_OK`
  - `OPERATOR_READ_AUTHORIZATION_OK`
  - `PHASE4_STATUS_OK`
- `git diff --check`, conflict-marker scans, action-clock I/O scans, and Phase 4 TODO/stub scans were clean.

## E. Release boundary

Protected-main reconciliation, complete repository suites, protected PR merge, static publication, engine cutover, and final live readback are required before this software correction may be called published. Those receipts will be appended after the protected release finishes.

Phase 4 itself cannot be called complete until an authorized human approves an immutable licensed input bundle, three independent HMAC principals are provisioned, licensed Pio hosts generate the corpus, all held-out and eight candidate gates pass, one dataset is promoted, and production liveness plus decision agreement are nonzero.
