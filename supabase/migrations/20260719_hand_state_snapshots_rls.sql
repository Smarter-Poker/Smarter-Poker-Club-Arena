-- ============================================================
-- SECURITY FIX (2026-07-19): Lock down hand_state_snapshots
--
-- The crash-recovery table `hand_state_snapshots` (migration
-- 20260326_hand_state_snapshots.sql) persists the FULL serialized hand
-- state — including every seated player's hole cards (state_json ->
-- players[].cards) — after every action, and was created with NO row-level
-- security. Under Supabase's default grants, any authenticated (or anon)
-- client could read live opponents' hole cards mid-hand via PostgREST:
--
--   GET /rest/v1/hand_state_snapshots?is_complete=eq.false&select=state_json
--
-- Only the server (service role) ever needs to read or write this table; the
-- SECURITY DEFINER RPCs (save_/complete_/get_active_hand_snapshot) continue to
-- work because they run as the definer, and the service role bypasses RLS.
--
-- Enabling RLS with NO permissive policy denies all access to the `anon` and
-- `authenticated` roles while leaving the service role (and the definer RPCs)
-- fully functional. We also FORCE RLS so even the table owner is subject to it,
-- and explicitly REVOKE the default PostgREST grants for defense in depth.
-- ============================================================

ALTER TABLE public.hand_state_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hand_state_snapshots FORCE ROW LEVEL SECURITY;

-- Defense in depth: strip the default table grants from the API roles so the
-- table is invisible to PostgREST regardless of RLS policy evaluation.
REVOKE ALL ON public.hand_state_snapshots FROM anon;
REVOKE ALL ON public.hand_state_snapshots FROM authenticated;

-- No CREATE POLICY here on purpose: with RLS enabled and no permissive policy,
-- non-service-role access is denied by default. The service role bypasses RLS.

-- ------------------------------------------------------------
-- Bug fix (audit 2026-07-19): the upsert never refreshed hand_number on
-- conflict, so after a 10-minute hand-timeout void the incomplete row kept its
-- stale hand_number forever and later complete_hand_snapshot() calls (which
-- match on hand_number) could never clear it. Refresh hand_number, config,
-- dealer_seat and players on conflict so the active row always describes the
-- hand actually in progress.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION save_hand_state_snapshot(
  p_table_id UUID,
  p_hand_number INTEGER,
  p_state_json JSONB,
  p_config_json JSONB,
  p_dealer_seat INTEGER,
  p_players_json JSONB,
  p_stage TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO hand_state_snapshots (
    table_id, hand_number, state_json, config_json, dealer_seat, players_json, stage, updated_at
  ) VALUES (
    p_table_id, p_hand_number, p_state_json, p_config_json, p_dealer_seat, p_players_json, p_stage, NOW()
  )
  ON CONFLICT (table_id) WHERE is_complete = FALSE
  DO UPDATE SET
    hand_number = EXCLUDED.hand_number,
    state_json = EXCLUDED.state_json,
    config_json = EXCLUDED.config_json,
    dealer_seat = EXCLUDED.dealer_seat,
    players_json = EXCLUDED.players_json,
    stage = EXCLUDED.stage,
    updated_at = NOW();
END;
$$;
