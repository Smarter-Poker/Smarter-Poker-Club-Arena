-- ═══════════════════════════════════════════════════════════════════════════════
-- Walkthrough Round 6 + 7 — perf indexes + security lockdown
-- Applied via Supabase MCP:
--   x10_add_missing_fk_indexes_2026_04_29
--   x10b_lock_down_overgranted_rpcs_2026_04_29
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── Round 6 — Missing FK indexes on hot Club Arena tables ─────────────────
-- All other FK columns on the 20 hot tables are already covered. Only 2 gaps.
CREATE INDEX IF NOT EXISTS idx_chip_escrow_holds_wallet_id
  ON public.chip_escrow_holds (wallet_id);

CREATE INDEX IF NOT EXISTS idx_club_wallet_transactions_actor_id
  ON public.club_wallet_transactions (actor_id)
  WHERE actor_id IS NOT NULL;

-- ─── Round 7 — Lock down over-granted RPCs ─────────────────────────────────
-- Several SECURITY DEFINER RPCs were granted EXECUTE to PUBLIC / anon /
-- authenticated. For mutating + state-revealing functions on the settlement
-- chain, that means anyone could call them. Tighten to service_role only.

-- Mutation that anyone could call to inflate BBJ pools:
REVOKE EXECUTE ON FUNCTION public.add_bbj_contribution(uuid, uuid, bigint, numeric, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.add_bbj_contribution(uuid, uuid, bigint, numeric, numeric, text)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.balance_tournament_tables(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.balance_tournament_tables(uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.fn_bbj_check_eligible(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_bbj_check_eligible(uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.fn_get_available_seats(uuid)
  FROM PUBLIC, anon;
-- authenticated keeps EXECUTE — lobby UI needs it.

REVOKE EXECUTE ON FUNCTION public.fn_atomic_increment_field(text, uuid, text, integer)
  FROM PUBLIC, anon;
-- authenticated kept (server-side calls run as service_role anyway, but
-- agent-credit.js shape is server-only by design).