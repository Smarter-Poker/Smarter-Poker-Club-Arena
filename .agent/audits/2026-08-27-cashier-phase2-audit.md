# 2026-08-27 — Cashier phase 2: cash-out lifecycle, union sends, reconciliation

Continuation of `2026-08-26-cashier-send-out-claim-back-audit.md`, on Dan's
instruction to "move onto the next phase of improvements audits and
optimizations inside the send out and claim back functionality".

Scope: the post-ten-minute claim path (cash-out request lifecycle), the
legacy/parallel promo money paths, union-level sends to members, and
reconciliation coverage for every cashier pool. Method unchanged: every defect
confirmed by probes inside ROLLED-BACK transactions against production
(request.jwt.claims impersonation), fixes applied via Supabase MCP
`apply_migration`, then re-probed rolled-back. Zero chips moved at any point.

Migrations applied (repo copies in `supabase/migrations/`):

- `20260827_cashier_phase2_cashout_union_and_reconciliation.sql`
- `20260827_ensure_agent_row_respects_agents_role_check.sql`

## Confirmed defects and their fixes

| #   | Severity          | Defect (evidence)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Fix                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Critical          | fn_cashout_approve minted the approver's agents row without the NOT NULL commission columns — first approval by a never-funded agent crashed (probe: 23502).                                                                                                                                                                                                                                                                                                                                        | fn_ensure_agent_row. Probe C2: approve succeeds, float credited 50.00.                                                                                                                                                                                                                                                                                                                              |
| 2   | Critical (latent) | agents_role_check permits only agent-tier roles, so EVERY ensure-row path (phase 1's included) crashed with 23514 when the wallet holder was an owner / co-owner / admin — staff hold floats per the 2026-08-23 wallet law.                                                                                                                                                                                                                                                                         | fn_ensure_agent_row clamps the stored role to 'super_agent' for staff; membership stays the role source of truth. Probes C2 + B1 (club bank send to an admin with no row): both succeed.                                                                                                                                                                                                            |
| 3   | Critical (latent) | fn_union_send_to_member 'promo' credited add_to_promo_wallet — the FROZEN public.wallets pool nothing reads (dead since 2026-08-21): promo value stranded on arrival. 'chips' credited via home-club resolution that can land OUTSIDE the union. Both branches also wrote chip_transactions.club_id = the union id, which violates fk_chip_transactions_club_id_clubs on any new row. Zero rows of either tx type exist in production — the branches had never successfully run; purely preventive. | Credits resolve to a membership INSIDE the union (home club if in-union, else fattest union membership, else the union-direct row). Agent-tier recipients are coerced into their agent/promo float (2026-08-25 law); players get chip_balance (promo is just as good as cash). Union ledger + resolved club ledger both written. anon EXECUTE revoked. Probes U1-U3 all pass; dead-pool delta 0.00. |
| 4   | High (latent)     | fn_union_distribute_promo ('agent') credited club_members.promo_balance — a column nothing on the platform reads (all zero in production). Distributed promo was unreachable by the receiving agent.                                                                                                                                                                                                                                                                                                | Credits agents.promo_wallet_balance via fn_ensure_agent_row; the sync trigger mirrors the legacy agents.promo_balance for the old WH promo routes.                                                                                                                                                                                                                                                  |
| 5   | High              | fn_expire_stale_cashouts could burn the escrow: player left the club → refund UPDATE matched nothing → escrow still marked released, request expired, NULL balance_after.                                                                                                                                                                                                                                                                                                                           | Recreates the membership row exactly as fn_cashout_release does. Probe C3: player deleted, expiry runs, membership recreated with the 60-chip refund, request expired.                                                                                                                                                                                                                              |
| 6   | Medium            | fn_cashout_request accepted sub-cent amounts (rounded debit vs raw escrow drift) and had no upper bound.                                                                                                                                                                                                                                                                                                                                                                                            | Hundredths guard + 1e9 cap. Probe C1: 10.005 refused.                                                                                                                                                                                                                                                                                                                                               |
| 7   | Low               | op_id replay lookups in fn_cashout_request / approve / release were not pinned to the caller — a foreign op_id returned a confident "replayed" receipt.                                                                                                                                                                                                                                                                                                                                             | All replay lookups (pre-checks and unique_violation handlers) are caller-pinned; a foreign op_id re-raises.                                                                                                                                                                                                                                                                                         |
| 8   | Enhancement       | reconcile_ledger_nightly was blind to every cashier failure shape.                                                                                                                                                                                                                                                                                                                                                                                                                                  | New cashier-integrity section files into ledger_reconcile_log as critical: stuck cash-out escrow (unreleased on a closed request, or released on a pending one), negative agent/promo/member/treasury balances, and agent-wallet sends with claimed_back > amount. Probe: full function runs; cashier section reports ZERO anomalies in production today.                                           |

## Verified clean (no change needed)

- fn_cashout_request/approve/release core design: escrow + status + ledger +
  notification in one transaction, row locks serialize double-approves,
  release recreates a vanished membership, decline/cancel share one leg with
  the ledger naming which it was.
- fn_cashout_queue scoping (assigned agent, staff, recursive downline; capped).
- fn_admin_remove_player_chips (op_id idempotent, staff-only, hundredths
  guard, member notified).
- fn_expire_stale_cashouts is NOT executable by `authenticated` — the
  p_ttl_hours=0 griefing vector is closed by grants.
- fn_union_promo_send (the live union-wallet route): union-scope check, op_id
  required, rounds, service_role only.
- Legacy promo RPCs (distribute*promo_chips, transfer_promo*\*,
  mint_club_promo, redeem_promo_to_chips, add_to_promo_wallet) are
  service_role-only: no browser can reach them. distribute_promo_chips has no
  remaining callers (the WH distribute-promo route uses
  transfer_promo_agent_to_player) — left in place, noted as dead.
- agents.promo_balance ↔ promo_wallet_balance are kept mirrored by
  trg_sync_agent_wallets, so the classic AgentPromoPanel (reads
  promo_wallet_balance) and the WH promo routes (move promo_balance) agree.

## Follow-ups deliberately not done here

- The pre-existing chip_ledger-vs-wallets drift the legacy reconciliation
  sections report (587 critical rows, worst 48.6M) predates this audit and is
  a platform-wide accounting question, not a cashier defect — it needs its own
  phase with Dan's direction on which pools are authoritative.
- public.wallets PROMO rows (107 rows, 10,700 chips) are pre-freeze signup
  bonuses stranded in the dead pool; deciding whether to migrate or write them
  off is a financial decision for Dan, not an agent.
