-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260421052738 "20260421061000_bug10_bug11_fix_broken_rpcs_gdpr_and_tournament_details"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 7b8ba6a8f67f38e7cb9f04828d8fabe4 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG-10 (HIGH — every GDPR user deletion fails in prod)
-- plpgsql_check flagged: fn_delete_user_gdpr references profiles.metadata
-- which does not exist (42703). Columns on profiles are bio / email / phone /
-- display_name / username / avatar_url / preferences (jsonb) plus the 5
-- new *_preferences jsonb columns added in BUG-9.
--
-- Runtime path: the missing column is hit inside the main BEGIN block of
-- the RPC; control jumps to EXCEPTION WHEN OTHERS, which marks the
-- gdpr_deletion_requests row as 'failed' and RE-RAISES. The API route
-- pages/api/account/delete-gdpr.js surfaces this as a 500. Every single
-- "Delete my account" request in prod fails.
--
-- Fix: drop the bogus `metadata = '{}'::jsonb` assignment; also reset the
-- `preferences` jsonb column and the 5 new preference columns since those
-- can contain personalization data that the GDPR spec says should be
-- anonymized along with the PII fields.
--
-- BUG-11 (HIGH — tournament detail reads return empty in prod)
-- get_tournament_details references TWO wrong column names on
-- tournament_registrations:
--   tr.finish_position  ← column is named `finish_rank`
--   tr.payout_amount    ← column is named `prize_amount`
-- plpgsql_check stopped at the first (finish_position); the second would
-- fire on the next call. Every union-games `get_tournament_details`
-- action in pages/api/club-arena/union-games.js fails with 42703.

CREATE OR REPLACE FUNCTION public.fn_delete_user_gdpr(
  p_user_id uuid,
  p_requested_by uuid,
  p_reason text DEFAULT NULL::text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_request_id uuid;
  v_req_role text;
  v_summary jsonb := '{}'::jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_n int;
BEGIN
  IF p_user_id IS NULL OR p_requested_by IS NULL THEN
    RAISE EXCEPTION 'user_id and requested_by required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT role INTO v_req_role FROM public.profiles WHERE id = p_requested_by;
  IF p_user_id <> p_requested_by AND v_req_role NOT IN ('admin','superadmin','god') THEN
    RAISE EXCEPTION 'only the user or a platform admin may request GDPR deletion' USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.gdpr_deletion_requests (user_id, requested_by, reason, status)
  VALUES (p_user_id, p_requested_by, p_reason, 'pending')
  RETURNING id INTO v_request_id;

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

  UPDATE public.arcade_duels SET player1_id = NULL WHERE player1_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('arcade_duels_player1', v_n);
  UPDATE public.arcade_duels SET player2_id = NULL WHERE player2_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('arcade_duels_player2', v_n);
  UPDATE public.arcade_duels SET winner_id  = NULL WHERE winner_id  = p_user_id;

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

  -- Anonymize the profiles row. BUG-10 fix: drop the bogus `metadata`
  -- column assignment (column does not exist) and also wipe the jsonb
  -- preference columns which can contain personalization data.
  UPDATE public.profiles
    SET
      display_name          = 'Deleted User',
      username              = 'deleted_' || substring(id::text, 1, 8),
      email                 = NULL,
      avatar_url            = NULL,
      bio                   = NULL,
      phone                 = NULL,
      preferences           = '{}'::jsonb,
      hub_preferences       = '{}'::jsonb,
      friend_preferences    = '{}'::jsonb,
      store_preferences     = '{}'::jsonb,
      messenger_preferences = '{}'::jsonb,
      reels_preferences     = '{}'::jsonb
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
$function$;

-- BUG-11: get_tournament_details two wrong column names

CREATE OR REPLACE FUNCTION public.get_tournament_details(
  p_tournament_id uuid,
  p_user_id uuid DEFAULT NULL::uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_tourn RECORD;
  v_reg RECORD;
  v_registrations JSONB;
BEGIN
  SELECT * INTO v_tourn FROM club_tournaments WHERE id = p_tournament_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Tournament not found'); END IF;

  IF p_user_id IS NOT NULL THEN
    SELECT * INTO v_reg
      FROM tournament_registrations
     WHERE tournament_id = p_tournament_id
       AND user_id = p_user_id
       AND status = 'registered';
  END IF;

  SELECT COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'user_id',         tr.user_id,
               'status',          tr.status,
               'registered_at',   tr.registered_at,
               -- BUG-11 fix: finish_position -> finish_rank
               'finish_position', tr.finish_rank,
               -- BUG-11 fix: payout_amount  -> prize_amount
               'payout_amount',   tr.prize_amount
             )
             ORDER BY tr.registered_at
           ),
           '[]'::jsonb
         )
    INTO v_registrations
    FROM tournament_registrations tr
   WHERE tr.tournament_id = p_tournament_id
     AND tr.status IN ('registered', 'playing', 'eliminated');

  RETURN jsonb_build_object(
    'success', true,
    'tournament', jsonb_build_object(
      'id',               v_tourn.id,
      'club_id',          v_tourn.club_id,
      'name',             v_tourn.name,
      'type',             v_tourn.type,
      'variant',          v_tourn.variant,
      'buy_in',           v_tourn.buy_in,
      'starting_chips',   v_tourn.starting_chips,
      'max_players',      v_tourn.max_players,
      'status',           v_tourn.status,
      'registered_count', v_tourn.registered_count,
      'current_level',    v_tourn.current_level,
      'results',          v_tourn.results
    ),
    'is_registered', v_reg.id IS NOT NULL,
    'registrations', v_registrations
  );
END;
$function$;
