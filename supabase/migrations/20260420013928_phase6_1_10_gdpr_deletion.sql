-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420013928 "phase6_1_10_gdpr_deletion"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e7c3b6c40c7fb2c2360ae9cbebd4770d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 6.1.10 — GDPR deletion path
-- Creates a deletion-request journal and a SECURITY DEFINER function that
-- (a) anonymizes the profile, (b) NULLs every auth.users FK reference on
-- financial/audit tables (so the subsequent auth.users delete can cascade
-- cleanly without violating NO-ACTION FKs while preserving double-entry
-- ledger integrity), and (c) returns a summary of what was cleared.
--
-- The actual auth.users deletion is performed by the calling API route using
-- the Supabase admin SDK (`auth.admin.deleteUser`), which then triggers the
-- remaining ON DELETE CASCADE chains for personal/user-owned rows.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.gdpr_deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  reason text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','anonymized','completed','failed','cancelled')),
  anonymized_at timestamptz,
  completed_at timestamptz,
  error_detail text,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gdpr_deletion_requests_user_idx
  ON public.gdpr_deletion_requests (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS gdpr_deletion_requests_status_idx
  ON public.gdpr_deletion_requests (status, created_at DESC);

ALTER TABLE public.gdpr_deletion_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gdpr_deletion_requests_self_or_admin ON public.gdpr_deletion_requests;
CREATE POLICY gdpr_deletion_requests_self_or_admin
  ON public.gdpr_deletion_requests FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.fn_is_platform_admin());
-- Writes are service-role only (via RPC below).

COMMENT ON TABLE public.gdpr_deletion_requests IS
  'Phase 6.1.10 — GDPR deletion request journal. Appended to once per user-initiated or admin-initiated deletion; status progresses pending→anonymized→completed.';

-- ── fn_delete_user_gdpr ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_delete_user_gdpr(
  p_user_id uuid,
  p_requested_by uuid,
  p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_request_id uuid;
  v_req_role text;
  v_summary jsonb := '{}'::jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_n int;
BEGIN
  -- Auth: requester must be the user themselves or a platform admin.
  IF p_user_id IS NULL OR p_requested_by IS NULL THEN
    RAISE EXCEPTION 'user_id and requested_by required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT role INTO v_req_role FROM public.profiles WHERE id = p_requested_by;
  IF p_user_id <> p_requested_by AND v_req_role NOT IN ('admin','superadmin','god') THEN
    RAISE EXCEPTION 'only the user or a platform admin may request GDPR deletion' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Record the request
  INSERT INTO public.gdpr_deletion_requests (user_id, requested_by, reason, status)
  VALUES (p_user_id, p_requested_by, p_reason, 'pending')
  RETURNING id INTO v_request_id;

  -- ── Step 1: NULL out FK references on audit / financial / no-action tables
  --          so the subsequent auth.users delete isn't blocked. We keep the
  --          rows for ledger integrity; the user id is the only identifying
  --          link and once null'd, the remaining row is non-PII.
  -- NOTE: all UPDATEs use COALESCE(GET DIAGNOSTICS ROW_COUNT, 0) captured below.

  UPDATE public.chip_ledger                    SET performed_by = NULL WHERE performed_by = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('chip_ledger', v_n);

  UPDATE public.bus_event_log                  SET user_id = NULL WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('bus_event_log', v_n);

  UPDATE public.admin_audit_log                SET admin_user_id = NULL WHERE admin_user_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('admin_audit_log', v_n);

  UPDATE public.club_arena_audit_logs          SET user_id = NULL WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('club_arena_audit_logs', v_n);

  UPDATE public.club_arena_messages            SET user_id = NULL WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('club_arena_messages', v_n);

  UPDATE public.club_chat                      SET user_id = NULL WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('club_chat', v_n);

  UPDATE public.table_chat                     SET user_id = NULL WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('table_chat', v_n);

  UPDATE public.tournament_entries             SET player_id = NULL WHERE player_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('tournament_entries', v_n);

  UPDATE public.tournament_registrations       SET user_id = NULL WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('tournament_registrations', v_n);

  UPDATE public.arcade_duels                   SET player1_id = NULL WHERE player1_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('arcade_duels_player1', v_n);
  UPDATE public.arcade_duels                   SET player2_id = NULL WHERE player2_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('arcade_duels_player2', v_n);
  UPDATE public.arcade_duels                   SET winner_id  = NULL WHERE winner_id  = p_user_id;

  UPDATE public.social_post_comments           SET user_id = NULL WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('social_post_comments', v_n);

  UPDATE public.unions                         SET owner_id = NULL WHERE owner_id = p_user_id;
  UPDATE public.union_announcements            SET created_by = NULL WHERE created_by = p_user_id;
  UPDATE public.union_wallet_transactions      SET created_by = NULL WHERE created_by = p_user_id;
  UPDATE public.geeves_analytics               SET user_id = NULL WHERE user_id = p_user_id;
  UPDATE public.live_help_analytics            SET user_id = NULL WHERE user_id = p_user_id;
  UPDATE public.content_schedule               SET author_id = NULL WHERE author_id = p_user_id;
  UPDATE public.commander_buyin_transactions   SET player_id = NULL WHERE player_id = p_user_id;
  UPDATE public.commander_home_seats           SET user_id = NULL WHERE user_id = p_user_id;
  UPDATE public.commander_sessions             SET user_id = NULL WHERE user_id = p_user_id;
  UPDATE public.opponent_profiles              SET opponent_id = NULL WHERE opponent_id = p_user_id;
  UPDATE public.player_notes                   SET target_user_id = NULL WHERE target_user_id = p_user_id;
  UPDATE public.poy_leaderboard                SET player_id = NULL WHERE player_id = p_user_id;
  UPDATE public.arcade_jackpot                 SET last_winner_id = NULL WHERE last_winner_id = p_user_id;

  -- ── Step 2: anonymize the profiles row (auth.users delete cascades to delete
  --           this row via FK, but we want a non-PII residual for analytics
  --           if any other table still references profiles by id.
  UPDATE public.profiles
    SET
      display_name = 'Deleted User',
      username     = 'deleted_' || substring(id::text, 1, 8),
      email        = NULL,
      avatar_url   = NULL,
      bio          = NULL,
      phone        = NULL,
      metadata     = '{}'::jsonb
  WHERE id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('profiles_anonymized', v_n);

  v_summary := jsonb_build_object(
    'request_id', v_request_id,
    'user_id', p_user_id,
    'requested_by', p_requested_by,
    'anonymized_columns', v_counts
  );

  UPDATE public.gdpr_deletion_requests
    SET status = 'anonymized',
        anonymized_at = now(),
        summary = v_summary
  WHERE id = v_request_id;

  -- Audit trail
  PERFORM public.fn_log_admin_action(
    p_admin_user_id := p_requested_by,
    p_action := 'user.gdpr_delete_anonymized',
    p_target_type := 'user',
    p_target_id := p_user_id::text,
    p_details := v_summary,
    p_before_state := NULL,
    p_after_state := NULL,
    p_ip_address := NULL,
    p_user_agent := NULL,
    p_request_id := v_request_id::text
  );

  RETURN v_summary;
EXCEPTION WHEN OTHERS THEN
  UPDATE public.gdpr_deletion_requests
    SET status = 'failed', error_detail = SQLERRM
  WHERE id = v_request_id;
  RAISE;
END;
$$;
REVOKE ALL ON FUNCTION public.fn_delete_user_gdpr(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_delete_user_gdpr(uuid,uuid,text) TO service_role;

COMMENT ON FUNCTION public.fn_delete_user_gdpr(uuid,uuid,text) IS
  'Phase 6.1.10 — GDPR right-to-erasure. Anonymizes audit/financial/public-schema rows that reference the target auth.users id. Caller must then invoke auth.admin.deleteUser(user_id) to cascade-delete remaining personal rows and remove the auth identity.';

-- ── fn_mark_gdpr_completed — called by API after successful auth.admin.deleteUser
CREATE OR REPLACE FUNCTION public.fn_mark_gdpr_completed(
  p_request_id uuid
) RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.gdpr_deletion_requests
    SET status = 'completed', completed_at = now()
  WHERE id = p_request_id AND status = 'anonymized'
  RETURNING true;
$$;
REVOKE ALL ON FUNCTION public.fn_mark_gdpr_completed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_mark_gdpr_completed(uuid) TO service_role;
