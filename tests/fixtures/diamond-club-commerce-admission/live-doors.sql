-- The seven admission doors, captured EXACTLY as installed.
--
-- Source: production project kuklfnapbkmacvwxktbh, read with
--   SELECT pg_get_functiondef('<signature>'::regprocedure)
-- through the Supabase MCP execute_sql tool on 2026-09-24 (UTC), read-only.
-- Nothing in this repository defines these live bodies verbatim (the review
-- door was never committed, and the tournament and schedule doors carry
-- production-only amendments), so the harness loads this capture.
--
-- live md5(pg_get_functiondef) on 2026-09-24, re-proved by the runner after
-- loading (a transcription error fails the run):
--   fn_review_join_request(uuid,uuid,boolean)                                  0ad8e6df115201015d969e0db78e3ff5
--   fn_cash_game_create(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean) fec049e3a50544b66d88dab7ff535ae2
--   fn_create_tournament(uuid,jsonb)                                           bc5e5dcea11302574163b21f10b63465
--   fn_upsert_tournament_schedule(jsonb)                                       358f8137847a8a4a5a3f68ff387d2dc2
-- (the two tournament doors re-captured at 13:10 UTC after production's
-- 20260924033701 and 20260924045822 amended them; both anchors held)
-- live ACL of each: {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.fn_review_join_request(p_club_id uuid, p_user_id uuid, p_approve boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_found boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT is_club_admin(p_club_id, v_uid) THEN
    RAISE EXCEPTION 'Not authorized to review join requests for this club';
  END IF;

  IF p_approve THEN
    UPDATE club_members
      SET status = 'active'
      WHERE club_id = p_club_id AND user_id = p_user_id AND status = 'pending';
    GET DIAGNOSTICS v_found = ROW_COUNT;
  ELSE
    DELETE FROM club_members
      WHERE club_id = p_club_id AND user_id = p_user_id AND status = 'pending';
    GET DIAGNOSTICS v_found = ROW_COUNT;
  END IF;

  IF NOT v_found THEN
    RETURN jsonb_build_object('success', false, 'error', 'No pending request found');
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_cash_game_create(p_club_id uuid, p_template text, p_variant text, p_sb numeric, p_bb numeric, p_handedness integer DEFAULT NULL::integer, p_overrides jsonb DEFAULT '{}'::jsonb, p_name text DEFAULT NULL::text, p_must_move boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_cash_game_create requires an authenticated caller'
      USING ERRCODE = '28000';
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'SESSION_REVOKED: this session is signed out - sign in again'
      USING ERRCODE = '28000';
  END IF;
  IF p_club_id IS NULL THEN
    RAISE EXCEPTION 'CLUB_REQUIRED';
  END IF;
  IF NOT public.fn_can_create_games(p_club_id, v_uid) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: this club is managed by its union';
  END IF;

  RETURN public.fn_cash_game_create_impl_20260905(
    p_club_id, p_template, p_variant, p_sb, p_bb, p_handedness,
    p_overrides, p_name, p_must_move
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_create_tournament(p_club_id uuid, p_config jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_res jsonb;
  v_pct smallint;
  v_id  uuid;
  v_saved_pct smallint;
  v_mystery jsonb;
  v_persisted jsonb;
  v_refusal text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success',false,'error','not_authenticated');
  END IF;
  IF NOT public.fn_can_create_games(p_club_id,v_uid) THEN
    RETURN jsonb_build_object('success',false,'error','not_authorised');
  END IF;

  -- The refusals the creation forms make, for every caller of this RPC
  -- (20260924033701). NULL means the engine can run this configuration.
  v_refusal := public.fn_tournament_config_refusal(p_config,'create');
  IF v_refusal IS NOT NULL THEN
    RETURN jsonb_build_object('success',false,'error',v_refusal);
  END IF;

  -- Only new authored MTTs are constrained here. Stored/funded ladders and
  -- the scheduled spawner do not pass this request boundary.
  IF COALESCE(p_config->>'type','') NOT IN ('sng','spin') AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE
      WHEN jsonb_typeof(p_config->'blindStructure')='array' THEN p_config->'blindStructure'
      ELSE '[]'::jsonb END) AS level_row
    WHERE level_row->'isBreak'='true'::jsonb
  ) THEN
    RETURN jsonb_build_object('success',false,'error','custom_level_breaks_not_supported');
  END IF;

  -- Preserve the existing 10% fallback for absent or invalid input. Only
  -- input decoding is recoverable: a failed contract write must roll back
  -- the delegated create in the same database transaction.
  BEGIN
    v_pct := CASE WHEN (p_config->>'payoutPercent')::int IN (10,15,20)
                  THEN (p_config->>'payoutPercent')::smallint ELSE 10 END;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    v_pct := 10;
  END;

  IF p_config->>'type'='mystery_bounty' THEN
    v_mystery:=public.fn_mystery_bounty_creation_document(p_config);
  END IF;

  v_res := public.fn_create_tournament_governed_legacy(p_club_id,p_config);
  IF v_res->'success' = 'false'::jsonb THEN
    RETURN v_res;
  END IF;
  IF v_res->'success' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'Tournament creation returned an unconfirmed receipt';
  END IF;

  -- The governed creator returns tournament_id. A missing, malformed or
  -- cross-club receipt cannot be accepted as a successful creation.
  v_id := NULLIF(v_res->>'tournament_id','')::uuid;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Tournament creation returned no tournament_id';
  END IF;
  UPDATE public.tournaments SET payout_percent = v_pct
   WHERE id = v_id AND club_id = p_club_id
   RETURNING payout_percent INTO v_saved_pct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament creation receipt does not identify its club event';
  END IF;

  IF v_saved_pct IS DISTINCT FROM v_pct THEN
    RAISE EXCEPTION 'Tournament payout depth was not persisted';
  END IF;

  IF v_mystery IS NOT NULL THEN
    UPDATE public.tournaments
       SET mystery_bounty_profile=v_mystery->>'mystery_bounty_profile',
           mystery_bounty_activation=v_mystery->>'mystery_bounty_activation',
           mystery_bounty_activation_value=(v_mystery->>'mystery_bounty_activation_value')::numeric,
           mystery_bounty_pool_percent=(v_mystery->>'mystery_bounty_pool_percent')::numeric,
           mystery_bounty_regular_pool_percent=(v_mystery->>'mystery_bounty_regular_pool_percent')::numeric,
           mystery_bounty_top_percent=(v_mystery->>'mystery_bounty_top_percent')::numeric
     WHERE id=v_id AND club_id=p_club_id AND is_mystery_bounty;
    IF NOT FOUND THEN RAISE EXCEPTION 'Mystery creation receipt does not identify its club event'; END IF;
    -- Read after all triggers, rather than trusting an UPDATE's pre-AFTER image.
    SELECT jsonb_build_object('mystery_bounty_profile',t.mystery_bounty_profile,
       'mystery_bounty_activation',t.mystery_bounty_activation,
       'mystery_bounty_activation_value',t.mystery_bounty_activation_value,
       'mystery_bounty_pool_percent',t.mystery_bounty_pool_percent,
       'mystery_bounty_regular_pool_percent',t.mystery_bounty_regular_pool_percent,
       'mystery_bounty_top_percent',t.mystery_bounty_top_percent)
      INTO v_persisted FROM public.tournaments t WHERE t.id=v_id AND t.club_id=p_club_id AND t.is_mystery_bounty;
    IF v_persisted IS DISTINCT FROM v_mystery THEN
      RAISE EXCEPTION 'Mystery bounty creation terms were not persisted';
    END IF;
    v_res:=v_res||jsonb_build_object('mystery_config',v_persisted);
  END IF;

  RETURN v_res;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_upsert_tournament_schedule(p_schedule jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid       uuid := auth.uid();
  v_id        uuid;
  v_union_id  uuid;
  v_club_id   uuid;
  v_name      text;
  v_days      integer[];
  v_times     text[];
  v_interval  integer;
  v_config    jsonb;
  v_active    boolean;
  v_zone      text;
  v_d         integer;
  v_tm        text;
  v_existing  record;
  v_config_changed boolean := true;
  v_refusal   text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'not_authenticated');
  END IF;
  IF p_schedule IS NULL OR jsonb_typeof(p_schedule) <> 'object' THEN
    RETURN jsonb_build_object('error', 'schedule_must_be_object');
  END IF;

  v_id       := NULLIF(p_schedule->>'id', '')::uuid;
  v_union_id := NULLIF(p_schedule->>'unionId', '')::uuid;
  v_club_id  := NULLIF(p_schedule->>'clubId', '')::uuid;
  v_name     := NULLIF(trim(p_schedule->>'name'), '');
  v_interval := NULLIF(p_schedule->>'intervalMinutes', '')::integer;
  v_config   := p_schedule->'config';
  v_active   := COALESCE((p_schedule->>'active')::boolean, true);
  -- IANA zone of the wall-clock days/times; absent or null = UTC.
  v_zone     := NULLIF(trim(p_schedule->>'timeZone'), '');

  SELECT COALESCE(array_agg(value::integer), '{}')
    INTO v_days FROM jsonb_array_elements_text(COALESCE(p_schedule->'daysOfWeek', '[]'::jsonb));
  SELECT COALESCE(array_agg(value), '{}')
    INTO v_times FROM jsonb_array_elements_text(COALESCE(p_schedule->'startTimesUtc', '[]'::jsonb));

  IF v_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.tournament_schedules WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('error', 'schedule_not_found');
    END IF;
    IF NOT public.fn_can_manage_tournament_schedule(v_existing.union_id, v_existing.club_id, v_uid) THEN
      RETURN jsonb_build_object('error', 'not_authorised');
    END IF;
    v_union_id := COALESCE(v_union_id, v_existing.union_id);
    v_club_id  := COALESCE(v_club_id,  v_existing.club_id);
    v_name     := COALESCE(v_name,     v_existing.name);
    v_config   := COALESCE(v_config,   v_existing.config);
    v_config_changed := v_config IS DISTINCT FROM v_existing.config;
    IF p_schedule->'daysOfWeek' IS NULL THEN v_days := v_existing.days_of_week; END IF;
    IF p_schedule->'startTimesUtc' IS NULL THEN v_times := v_existing.start_times_utc; END IF;
    IF p_schedule->'intervalMinutes' IS NULL THEN v_interval := v_existing.interval_minutes; END IF;
    IF NOT (p_schedule ? 'timeZone') THEN v_zone := v_existing.time_zone; END IF;
  END IF;

  IF v_club_id IS NULL THEN
    RETURN jsonb_build_object('error', 'club_id_required');
  END IF;
  IF v_name IS NULL THEN
    RETURN jsonb_build_object('error', 'name_required');
  END IF;
  IF v_config IS NULL OR jsonb_typeof(v_config) <> 'object' THEN
    RETURN jsonb_build_object('error', 'config_must_be_object');
  END IF;
  IF array_length(v_days, 1) IS NULL THEN
    RETURN jsonb_build_object('error', 'days_of_week_required');
  END IF;
  FOREACH v_d IN ARRAY v_days LOOP
    IF v_d < 0 OR v_d > 6 THEN
      RETURN jsonb_build_object('error', 'days_of_week_out_of_range', 'detail', v_d);
    END IF;
  END LOOP;
  FOREACH v_tm IN ARRAY v_times LOOP
    IF v_tm !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
      RETURN jsonb_build_object('error', 'start_time_format_invalid', 'detail', v_tm);
    END IF;
  END LOOP;
  IF array_length(v_times, 1) IS NULL AND v_interval IS NULL THEN
    RETURN jsonb_build_object('error', 'start_times_or_interval_required');
  END IF;
  IF v_interval IS NOT NULL AND (v_interval < 5 OR v_interval > 1440) THEN
    RETURN jsonb_build_object('error', 'interval_minutes_out_of_range');
  END IF;
  IF NOT public.fn_schedule_time_zone_is_known(v_zone) THEN
    RETURN jsonb_build_object('error', 'time_zone_unknown', 'detail', v_zone);
  END IF;

  IF v_id IS NULL AND NOT public.fn_can_manage_tournament_schedule(v_union_id, v_club_id, v_uid) THEN
    RETURN jsonb_build_object('error', 'not_authorised');
  END IF;
  -- Lock/read comparison preserves unchanged accepted schedules, including
  -- enable/disable and metadata edits, without authoring another ignored break.
  IF v_config_changed AND (
    lower(COALESCE(v_config->>'type','mtt')) NOT IN ('sng','spin')
    -- The scheduled writer promotes target-linked fixed labels to satellites.
    -- Only its recognized target keys participate; unrelated type aliases do not.
    OR public.fn_ca_is_new_mtt(jsonb_build_object(
      'satellite_target_id',v_config->'satellite_target_id',
      'satelliteTargetId',v_config->'satelliteTargetId',
      'satellite_target',v_config->'satellite_target',
      'satelliteTarget',v_config->'satelliteTarget'))
  ) AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE
      WHEN jsonb_typeof(v_config->'blindStructure')='array' THEN v_config->'blindStructure'
      ELSE '[]'::jsonb END) AS level_row
    WHERE level_row->'isBreak'='true'::jsonb
  ) THEN
    RETURN jsonb_build_object('error','custom_level_breaks_not_supported');
  END IF;

  -- The creation rules, checked when the configuration is written rather than
  -- first discovered by the spawner (20260924033701).
  IF v_config_changed THEN
    v_refusal := public.fn_tournament_config_refusal(v_config,'schedule');
    IF v_refusal IS NOT NULL THEN
      RETURN jsonb_build_object('error',v_refusal);
    END IF;
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO public.tournament_schedules
      (union_id, club_id, name, description, active, days_of_week,
       start_times_utc, interval_minutes, config, created_by, time_zone)
    VALUES
      (v_union_id, v_club_id, v_name, p_schedule->>'description', v_active, v_days,
       v_times, v_interval, v_config, v_uid, v_zone)
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.tournament_schedules
       SET union_id         = v_union_id,
           club_id          = v_club_id,
           name             = v_name,
           description      = COALESCE(p_schedule->>'description', description),
           active           = v_active,
           days_of_week     = v_days,
           start_times_utc  = v_times,
           interval_minutes = v_interval,
           config           = v_config,
           time_zone        = v_zone,
           updated_at       = now()
     WHERE id = v_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'schedule_id', v_id);
END; $function$;

REVOKE ALL ON FUNCTION public.fn_review_join_request(uuid,uuid,boolean), public.fn_cash_game_create(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean),
  public.fn_create_tournament(uuid,jsonb), public.fn_upsert_tournament_schedule(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_review_join_request(uuid,uuid,boolean), public.fn_cash_game_create(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean),
  public.fn_create_tournament(uuid,jsonb), public.fn_upsert_tournament_schedule(jsonb) TO authenticated, service_role;

-- ===== The three member doors (added 2026-09-24) ============================
-- Captured the same way, same day. A club's roster grows through these as
-- well as through fn_review_join_request: 3 of the 5 live clubs admit
-- automatically, an invite link promotes a pending join, and an agent can
-- add a player directly.
--   fn_join_club(uuid)                                                         005b11687350a0a98547a3593e556767
--   fn_redeem_club_invite_code(uuid,uuid,text)                                 917d92ab9e196221dab00790b24772d7
--   fn_agent_attach_player(uuid,uuid,uuid)                                     f6af5f81cce337123d4aa56df4f04cfa
-- live ACL of each: {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

CREATE OR REPLACE FUNCTION public.fn_join_club(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
 SET lock_timeout TO '5s'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_result jsonb;
  v_row public.club_members%ROWTYPE;
  v_owner uuid;
  v_requires_approval boolean;
  v_lifecycle text;
  v_active_count integer;
  v_previous_source text := coalesce(current_setting('app.club_membership_source', true), '');
  v_previous_lifecycle text := coalesce(current_setting('app.club_membership_lifecycle_write', true), '');
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  PERFORM set_config('app.club_membership_source', 'join_club', true);
  BEGIN
    v_result := public.fn_join_club_membership_impl(p_club_id);

    IF coalesce(v_result ->> 'membership_lifecycle_status', 'active') = 'departed' THEN
      PERFORM public.fn_club_membership_lock(v_uid);
      PERFORM pg_advisory_xact_lock(
        hashtextextended('cashier-hierarchy:' || p_club_id::text, 0)
      );
      SELECT c.owner_id, coalesce(c.requires_approval, false),
             coalesce(to_jsonb(c) ->> 'lifecycle_status', 'active')
        INTO v_owner, v_requires_approval, v_lifecycle
        FROM public.clubs c
       WHERE c.id = p_club_id
       FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Club not found'; END IF;
      IF v_lifecycle = 'retired' THEN
        RAISE EXCEPTION 'This Club Is Retired And Cannot Accept Members' USING ERRCODE = '55000';
      END IF;

      v_active_count := public.fn_club_membership_count(v_uid, p_club_id);
      IF v_uid <> v_owner AND v_active_count >= public.fn_club_membership_cap() THEN
        RAISE EXCEPTION 'You can only be a member of up to % clubs. Leave a club to join a new one.',
          public.fn_club_membership_cap();
      END IF;

      PERFORM set_config('app.club_membership_lifecycle_write', 'rejoin', true);
      UPDATE public.club_members cm
         SET membership_lifecycle_status = 'active',
             status = CASE
               WHEN v_uid = v_owner OR NOT v_requires_approval THEN 'active'
               ELSE 'pending'
             END,
             is_active = true,
             departed_at = NULL,
             departed_by = NULL,
             departure_reason = NULL,
             updated_at = clock_timestamp()
       WHERE cm.club_id = p_club_id
         AND cm.user_id = v_uid
         AND cm.membership_lifecycle_status = 'departed'
       RETURNING * INTO v_row;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'membership lifecycle changed during rejoin' USING ERRCODE = '40001';
      END IF;
      v_result := to_jsonb(v_row);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.club_membership_source', v_previous_source, true);
    PERFORM set_config('app.club_membership_lifecycle_write', v_previous_lifecycle, true);
    RAISE;
  END;

  PERFORM set_config('app.club_membership_source', v_previous_source, true);
  PERFORM set_config('app.club_membership_lifecycle_write', v_previous_lifecycle, true);
  RETURN v_result;
END
$function$;

CREATE OR REPLACE FUNCTION public.fn_redeem_club_invite_code(p_club_id uuid, p_user_id uuid, p_referral_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_caller            uuid := auth.uid();
  v_code              text := btrim(coalesce(p_referral_code, ''));
  v_inviter           record;
  v_inviter_member    record;
  v_member            record;
  v_effective_agent   uuid;
  v_is_agent          boolean;
  v_agent_name        text;
  v_new_status        text;
BEGIN
  -- ── Authorization ────────────────────────────────────────────────────────
  IF v_caller IS NOT NULL AND v_caller <> p_user_id THEN
    RETURN jsonb_build_object('success', false, 'code', 'not_your_membership',
                              'error', 'You can only redeem an invite for yourself.');
  END IF;

  IF v_code = '' THEN
    RETURN jsonb_build_object('success', false, 'code', 'empty_code',
                              'error', 'No referral code supplied.');
  END IF;

  -- ── 1. Resolve the inviter ───────────────────────────────────────────────
  SELECT p.id, p.username, p.player_number
    INTO v_inviter
    FROM profiles p
   WHERE p.player_number = v_code
      OR (v_code ~ '^[0-9]+$' AND p.player_number ~ '^[0-9]+$'
          AND p.player_number::bigint = v_code::bigint)
      OR (v_code ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND p.id = v_code::uuid)
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'unknown_inviter',
                              'error', 'Invalid referral code.');
  END IF;

  IF v_inviter.id = p_user_id THEN
    RETURN jsonb_build_object('success', false, 'code', 'self_referral',
                              'error', 'You cannot invite yourself.');
  END IF;

  -- ── 2. The inviter must be a settled member of this club ─────────────────
  SELECT * INTO v_inviter_member
    FROM club_members
   WHERE club_id = p_club_id AND user_id = v_inviter.id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'inviter_not_in_club',
                              'error', 'Inviter is not a member of this club.');
  END IF;

  IF v_inviter_member.status NOT IN ('active', 'approved') THEN
    RETURN jsonb_build_object('success', false, 'code', 'inviter_not_settled',
                              'error', 'Inviter is not an active member of this club.');
  END IF;

  -- ── 3. Effective upline ──────────────────────────────────────────────────
  SELECT true INTO v_is_agent
    FROM agents
   WHERE club_id = p_club_id AND user_id = v_inviter.id AND status = 'active';

  IF coalesce(v_is_agent, false) THEN
    v_effective_agent := v_inviter.id;
  ELSE
    v_effective_agent := v_inviter_member.agent_id;
  END IF;

  -- ── 4. The joining user must already have a membership row ───────────────
  SELECT * INTO v_member
    FROM club_members
   WHERE club_id = p_club_id AND user_id = p_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'not_a_member',
                              'error', 'User is not a member of this club.');
  END IF;

  IF v_member.status NOT IN ('active', 'approved', 'pending') THEN
    RETURN jsonb_build_object('success', false, 'code', 'membership_blocked',
                              'error', 'This membership cannot be activated.');
  END IF;

  -- ── 5. Attach and admit ──────────────────────────────────────────────────
  v_new_status := CASE WHEN v_member.status = 'pending' THEN 'active' ELSE v_member.status END;

  UPDATE club_members
     SET agent_id   = coalesce(agent_id, v_effective_agent),
         invited_by = coalesce(invited_by, v_inviter.id),
         status     = v_new_status,
         updated_at = now()
   WHERE club_id = p_club_id AND user_id = p_user_id
  RETURNING * INTO v_member;

  -- ── 6. Re-derive the upline's player counts ──────────────────────────────
  IF v_member.agent_id IS NOT NULL THEN
    UPDATE agents
       SET total_players = (SELECT count(*) FROM club_members
                             WHERE agent_id = v_member.agent_id AND club_id = p_club_id),
           active_player_count = (SELECT count(*) FROM club_members
                                   WHERE agent_id = v_member.agent_id AND club_id = p_club_id
                                     AND status IN ('active', 'approved')),
           updated_at = now()
     WHERE club_id = p_club_id AND user_id = v_member.agent_id;
  END IF;

  SELECT username INTO v_agent_name FROM profiles WHERE id = v_member.agent_id;

  RETURN jsonb_build_object(
    'success',     true,
    'status',      v_member.status,
    'agent_id',    v_member.agent_id,
    'agent_name',  v_agent_name,
    'inviter_id',  v_inviter.id,
    'inviter_name', v_inviter.username
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_agent_attach_player(p_club_id uuid, p_agent_user_id uuid, p_player_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_caller     uuid := auth.uid();
  v_is_staff   boolean := false;
  v_agent      record;
  v_member     record;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'not_authenticated',
                              'error', 'Please sign in again.');
  END IF;

  IF p_agent_user_id = p_player_id THEN
    RETURN jsonb_build_object('success', false, 'code', 'self_attach',
                              'error', 'An agent cannot be their own downline.');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM clubs c WHERE c.id = p_club_id AND c.owner_id = v_caller
    UNION ALL
    SELECT 1 FROM club_members cm
     WHERE cm.club_id = p_club_id AND cm.user_id = v_caller
       AND cm.role IN ('owner', 'co_owner', 'admin')
       AND cm.status IN ('active', 'approved')
  ) INTO v_is_staff;

  IF NOT v_is_staff AND v_caller <> p_agent_user_id THEN
    RETURN jsonb_build_object('success', false, 'code', 'not_authorized',
                              'error', 'You can only add players to your own downline.');
  END IF;

  SELECT * INTO v_agent FROM agents
   WHERE club_id = p_club_id AND user_id = p_agent_user_id AND status = 'active';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'not_an_active_agent',
                              'error', 'That agent is not active in this club.');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_player_id) THEN
    RETURN jsonb_build_object('success', false, 'code', 'unknown_player',
                              'error', 'That player does not exist.');
  END IF;

  SELECT * INTO v_member FROM club_members
   WHERE club_id = p_club_id AND user_id = p_player_id;

  IF NOT FOUND THEN
    INSERT INTO club_members (club_id, user_id, role, status, tier, rank_level,
                              orange_ball_status, agent_id, invited_by)
    VALUES (p_club_id, p_player_id, 'player', 'active', 'bronze', 0, 'cold',
            p_agent_user_id, p_agent_user_id)
    RETURNING * INTO v_member;
  ELSE
    IF v_member.status NOT IN ('active', 'approved', 'pending') THEN
      RETURN jsonb_build_object('success', false, 'code', 'membership_blocked',
                                'error', 'That membership cannot be changed.');
    END IF;

    IF v_member.agent_id IS NOT NULL
       AND v_member.agent_id <> p_agent_user_id
       AND NOT v_is_staff THEN
      RETURN jsonb_build_object('success', false, 'code', 'already_in_a_downline',
                                'error', 'That player is already in another downline.');
    END IF;

    UPDATE club_members
       SET agent_id   = p_agent_user_id,
           invited_by = COALESCE(invited_by, p_agent_user_id),
           status     = CASE WHEN status = 'pending' THEN 'active' ELSE status END,
           updated_at = now()
     WHERE club_id = p_club_id AND user_id = p_player_id
    RETURNING * INTO v_member;
  END IF;

  UPDATE agents
     SET total_players = (SELECT count(*) FROM club_members
                           WHERE agent_id = p_agent_user_id AND club_id = p_club_id),
         active_player_count = (SELECT count(*) FROM club_members
                                 WHERE agent_id = p_agent_user_id AND club_id = p_club_id
                                   AND status IN ('active', 'approved')),
         updated_at = now()
   WHERE club_id = p_club_id AND user_id = p_agent_user_id;

  RETURN jsonb_build_object(
    'success', true,
    'status', v_member.status,
    'agent_id', v_member.agent_id,
    'chip_balance', v_member.chip_balance
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_join_club(uuid), public.fn_redeem_club_invite_code(uuid,uuid,text),
  public.fn_agent_attach_player(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_join_club(uuid), public.fn_redeem_club_invite_code(uuid,uuid,text),
  public.fn_agent_attach_player(uuid,uuid,uuid) TO authenticated, service_role;
