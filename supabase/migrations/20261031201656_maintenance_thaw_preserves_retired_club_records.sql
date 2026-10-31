-- Maintenance clock credit belongs to active/system records, never retired clubs.
-- The installed retirement guard correctly refuses historical gameplay mutation.
-- Keep that guard and v3 ownership/release authority unchanged; narrow all fifteen
-- target families consistently at snapshot, initial credit and tail credit.
-- If an already-snapshotted active target retires, the existing moved/marked
-- equality still refuses the transaction; no historical target is falsely credited.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
DO $guard$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_guard_retired_club_mutation()'::regprocedure) <> '19b9ffb6dc97e019ac47cb73c70fe93d' OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_thaw_platform(timestamptz,timestamptz,numeric,uuid,text)'::regprocedure) <> 'f7540547dbea11a05e4bdc5b33162986' THEN RAISE EXCEPTION 'RETIRED_CLUB_THAW_AUTHORITY_DRIFT'; END IF;
END $guard$;
DO $guard$
DECLARE p regprocedure := 'public.fn_credit_maintenance_thaw_targets(timestamp with time zone,numeric)'::regprocedure;
BEGIN
 IF NOT (SELECT md5(prosrc)='07ae34db3c2a65da3593ff2bcce93c78' AND prosecdef AND pg_get_userbyid(proowner)='postgres' AND proconfig=ARRAY['search_path=public, pg_temp'] AND proacl='{postgres=X/postgres}'::aclitem[] FROM pg_proc WHERE oid=p) THEN
  RAISE EXCEPTION 'RETIRED_CLUB_THAW_PREIMAGE_DRIFT: fn_credit_maintenance_thaw_targets';
 END IF;
 EXECUTE $definition$CREATE OR REPLACE FUNCTION public.fn_credit_maintenance_thaw_targets(p_freeze_started timestamp with time zone, p_target_seconds numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_budget CONSTANT interval := INTERVAL '4 seconds';
  c_steps CONSTANT text[] := ARRAY[
    'sit_out_at','hold_expires_at','addon_period_ends_at','reversible_until',
    'reveal_deadline_at','rebuy_prompt_until','bomb_pot_next_due_at',
    'cash_stay_last_tick_at','cash_rejoin_expires_at','level_started_at',
    'cluster_break_eligible_since','cluster_move_expires_at',
    'reconnect_presence','reconnect_snapshots','lightning_drain_deadline_at'
  ];
  v_started timestamptz := clock_timestamp();
  v_counts jsonb;
  v_step text;
  v_batch integer;
  v_moved integer;
  v_marked integer;
  v_done text[] := '{}';
  v_complete boolean;
BEGIN
  IF p_target_seconds IS NULL OR p_target_seconds <= 0 THEN
    RETURN jsonb_build_object(
      'ok', false, 'complete', false, 'reason', 'invalid_credit_target'
    );
  END IF;

  SELECT COALESCE(t.shifted, '{}'::jsonb) INTO v_counts
    FROM public.engine_maintenance_thaws t
   WHERE t.freeze_started_at = p_freeze_started
   FOR UPDATE;
  IF NOT FOUND OR COALESCE((v_counts->>'_targets_snapshotted')::boolean, false) = false THEN
    RETURN jsonb_build_object(
      'ok', false, 'complete', false, 'reason', 'thaw_targets_not_snapshotted'
    );
  END IF;

  PERFORM set_config('app.freeze_bypass', 'on', true);

  FOREACH v_step IN ARRAY c_steps LOOP
    EXIT WHEN clock_timestamp() - v_started > c_budget;
    v_batch := CASE WHEN v_step = 'level_started_at' THEN 40 ELSE 200 END;
    v_moved := 0;
    v_marked := 0;

    IF v_step = 'sit_out_at' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id, x.credited_seconds
          FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at = p_freeze_started AND x.step = v_step
           AND x.credited_seconds < p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.table_seats r
           SET sit_out_at = r.sit_out_at
             + make_interval(secs => p_target_seconds - d.credited_seconds)
          FROM due d WHERE NOT EXISTS (SELECT 1 FROM public.tables thaw_table JOIN public.clubs thaw_club ON thaw_club.id = thaw_table.club_id WHERE thaw_table.id = r.table_id AND thaw_club.lifecycle_status = 'retired')
       AND r.id = d.target_id AND r.sit_out_at IS NOT NULL
        RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x
           SET credited_seconds = p_target_seconds
          FROM due d
         WHERE x.freeze_started_at = p_freeze_started AND x.step = v_step
           AND x.target_id = d.target_id
        RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved), (SELECT count(*) FROM marked)
          INTO v_moved, v_marked;
    ELSIF v_step = 'hold_expires_at' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id, x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.table_waitlist r SET hold_expires_at=r.hold_expires_at
          + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE NOT EXISTS (SELECT 1 FROM public.tables thaw_table JOIN public.clubs thaw_club ON thaw_club.id = thaw_table.club_id WHERE thaw_table.id = r.table_id AND thaw_club.lifecycle_status = 'retired')
       AND r.id=d.target_id AND r.hold_expires_at IS NOT NULL RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'addon_period_ends_at' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.tournaments r SET addon_period_ends_at=r.addon_period_ends_at
          + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE NOT EXISTS (SELECT 1 FROM public.clubs thaw_club WHERE thaw_club.id = r.club_id AND thaw_club.lifecycle_status = 'retired')
       AND r.id=d.target_id AND r.addon_period_ends_at IS NOT NULL RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'reversible_until' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.chip_transactions r SET reversible_until=r.reversible_until
          + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE NOT EXISTS (SELECT 1 FROM public.clubs thaw_club WHERE thaw_club.id = r.club_id AND thaw_club.lifecycle_status = 'retired')
       AND r.id=d.target_id AND r.reversible_until IS NOT NULL RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'reveal_deadline_at' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.tournament_bounty_awards r SET reveal_deadline_at=r.reveal_deadline_at
          + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE NOT EXISTS (SELECT 1 FROM public.tournaments thaw_event JOIN public.clubs thaw_club ON thaw_club.id = thaw_event.club_id WHERE thaw_event.id = r.tournament_id AND thaw_club.lifecycle_status = 'retired')
       AND r.id=d.target_id AND r.reveal_deadline_at IS NOT NULL RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'rebuy_prompt_until' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.tournament_players r SET rebuy_prompt_until=r.rebuy_prompt_until
          + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE NOT EXISTS (SELECT 1 FROM public.tournaments thaw_event JOIN public.clubs thaw_club ON thaw_club.id = thaw_event.club_id WHERE thaw_event.id = r.tournament_id AND thaw_club.lifecycle_status = 'retired')
       AND r.id=d.target_id AND r.rebuy_prompt_until IS NOT NULL RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'bomb_pot_next_due_at' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.tables r SET bomb_pot_next_due_at=r.bomb_pot_next_due_at
          + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE NOT EXISTS (SELECT 1 FROM public.clubs thaw_club WHERE thaw_club.id = r.club_id AND thaw_club.lifecycle_status = 'retired')
       AND r.id=d.target_id AND r.bomb_pot_next_due_at IS NOT NULL RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'cash_stay_last_tick_at' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.cash_player_session r SET stay_last_tick_at=r.stay_last_tick_at
          + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE NOT EXISTS (SELECT 1 FROM public.clubs thaw_club WHERE thaw_club.id = r.club_id AND thaw_club.lifecycle_status = 'retired')
       AND r.id=d.target_id RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'cash_rejoin_expires_at' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.cash_rejoin_constraints r SET expires_at=r.expires_at
          + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE NOT EXISTS (SELECT 1 FROM public.clubs thaw_club WHERE thaw_club.id = r.club_id AND thaw_club.lifecycle_status = 'retired')
       AND r.id=d.target_id RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'level_started_at' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.tournaments r SET level_started_at=r.level_started_at
          + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE NOT EXISTS (SELECT 1 FROM public.clubs thaw_club WHERE thaw_club.id = r.club_id AND thaw_club.lifecycle_status = 'retired')
       AND r.id=d.target_id AND r.level_started_at IS NOT NULL RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'cluster_break_eligible_since' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.tables r SET break_eligible_since=r.break_eligible_since
          + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE NOT EXISTS (SELECT 1 FROM public.clubs thaw_club WHERE thaw_club.id = r.club_id AND thaw_club.lifecycle_status = 'retired')
       AND r.id=d.target_id AND r.break_eligible_since IS NOT NULL RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'cluster_move_expires_at' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.cash_seat_moves r SET expires_at=r.expires_at
          + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE NOT EXISTS (SELECT 1 FROM public.cash_games thaw_game JOIN public.clubs thaw_club ON thaw_club.id = thaw_game.club_id WHERE thaw_game.id = r.game_id AND thaw_club.lifecycle_status = 'retired') AND NOT EXISTS (SELECT 1 FROM public.tables thaw_table JOIN public.clubs thaw_club ON thaw_club.id = thaw_table.club_id WHERE thaw_table.id IN (r.from_table_id, r.to_table_id) AND thaw_club.lifecycle_status = 'retired')
       AND r.id=d.target_id RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'lightning_drain_deadline_at' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.lightning_cluster_drain r
           SET deadline_at=r.deadline_at
             + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE NOT EXISTS (SELECT 1 FROM public.cash_games thaw_game JOIN public.clubs thaw_club ON thaw_club.id = thaw_game.club_id WHERE thaw_game.id = r.cluster_id AND thaw_club.lifecycle_status = 'retired')
       AND r.id=d.target_id AND r.completed_at IS NULL
        RETURNING r.id,r.cluster_id,r.request_id,r.deadline_at
      ), emitted AS (
        INSERT INTO public.cash_cluster_events(game_id,kind,payload,request_id)
        SELECT cluster_id,'lightning_drain_deadline_thawed',
               jsonb_build_object('drain_id',id,'deadline_at',deadline_at,
                                  'freeze_started_at',p_freeze_started),request_id FROM moved
        RETURNING id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM emitted),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'reconnect_presence' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.engine_presence_parked r
           SET disconnect_states=public.fn_thaw_reconnect_states(
             r.disconnect_states, EXTRACT(EPOCH FROM p_freeze_started)*1000,
             EXTRACT(EPOCH FROM p_freeze_started+make_interval(secs=>p_target_seconds))*1000)
          FROM due d WHERE NOT EXISTS (SELECT 1 FROM public.tables thaw_table JOIN public.clubs thaw_club ON thaw_club.id = thaw_table.club_id WHERE thaw_table.id = r.table_id AND thaw_club.lifecycle_status = 'retired')
       AND r.table_id=d.target_id RETURNING r.table_id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'reconnect_snapshots' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.hand_state_snapshots r
           SET disconnect_states=public.fn_thaw_reconnect_states(
             r.disconnect_states, EXTRACT(EPOCH FROM p_freeze_started)*1000,
             EXTRACT(EPOCH FROM p_freeze_started+make_interval(secs=>p_target_seconds))*1000)
          FROM due d WHERE NOT EXISTS (SELECT 1 FROM public.tables thaw_table JOIN public.clubs thaw_club ON thaw_club.id = thaw_table.club_id WHERE thaw_table.id = r.table_id AND thaw_club.lifecycle_status = 'retired')
       AND r.id=d.target_id RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    END IF;

    IF v_moved <> v_marked THEN
      RAISE EXCEPTION 'MAINTENANCE_THAW_TARGET_CHANGED: % moved %, receipted %',
        v_step, v_moved, v_marked
        USING ERRCODE = '55000';
    END IF;
    IF v_marked > 0 THEN
      v_done := array_append(v_done, v_step || ':' || v_marked::text);
    END IF;
  END LOOP;

  SELECT NOT EXISTS (
    SELECT 1 FROM public.engine_maintenance_thaw_targets x
     WHERE x.freeze_started_at=p_freeze_started
       AND x.credited_seconds<p_target_seconds
  ) INTO v_complete;
  IF v_complete THEN
    v_counts := (v_counts - 'level_started_at_cursor' - 'level_started_at_so_far')
      || COALESCE(v_counts->'_target_counts', '{}'::jsonb)
      || jsonb_build_object('complete', true);
  ELSE
    v_counts := v_counts - 'complete';
  END IF;
  UPDATE public.engine_maintenance_thaws t
     SET shifted=v_counts, thawed_at=clock_timestamp()
   WHERE t.freeze_started_at=p_freeze_started;
  RETURN jsonb_build_object(
    'ok', true, 'complete', v_complete, 'steps_this_call', to_jsonb(v_done),
    'elapsed_ms', round(EXTRACT(EPOCH FROM clock_timestamp()-v_started)*1000),
    'shifted', v_counts
  );
END;
$function$
$definition$;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=p) <> '3f5859bd21f9e7b35e59ed5337e2afab' THEN RAISE EXCEPTION 'RETIRED_CLUB_THAW_POSTIMAGE_DRIFT: fn_credit_maintenance_thaw_targets'; END IF;
END $guard$;

DO $guard$
DECLARE p regprocedure := 'public.fn_snapshot_maintenance_thaw_targets(timestamp with time zone,numeric)'::regprocedure;
BEGIN
 IF NOT (SELECT md5(prosrc)='492ccb7dd2eab1034a73d4e1f997041f' AND prosecdef AND pg_get_userbyid(proowner)='postgres' AND proconfig=ARRAY['search_path=public, pg_temp'] AND proacl='{postgres=X/postgres}'::aclitem[] FROM pg_proc WHERE oid=p) THEN
  RAISE EXCEPTION 'RETIRED_CLUB_THAW_PREIMAGE_DRIFT: fn_snapshot_maintenance_thaw_targets';
 END IF;
 EXECUTE $definition$CREATE OR REPLACE FUNCTION public.fn_snapshot_maintenance_thaw_targets(p_freeze_started timestamp with time zone, p_initial_seconds numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_counts jsonb := '{}'::jsonb;
  v_n integer;
BEGIN
  INSERT INTO public.engine_maintenance_thaw_targets(freeze_started_at, step, target_id)
  SELECT p_freeze_started, 'sit_out_at', s.id
    FROM public.table_seats s
   WHERE NOT EXISTS (SELECT 1 FROM public.tables thaw_table JOIN public.clubs thaw_club ON thaw_club.id = thaw_table.club_id WHERE thaw_table.id = s.table_id AND thaw_club.lifecycle_status = 'retired')
     AND s.left_at IS NULL AND s.sit_out_at IS NOT NULL
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('sit_out_at', v_n);

  INSERT INTO public.engine_maintenance_thaw_targets(freeze_started_at, step, target_id)
  SELECT p_freeze_started, 'hold_expires_at', w.id
    FROM public.table_waitlist w
   WHERE NOT EXISTS (SELECT 1 FROM public.tables thaw_table JOIN public.clubs thaw_club ON thaw_club.id = thaw_table.club_id WHERE thaw_table.id = w.table_id AND thaw_club.lifecycle_status = 'retired')
     AND w.hold_expires_at > p_freeze_started
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('hold_expires_at', v_n);

  INSERT INTO public.engine_maintenance_thaw_targets(freeze_started_at, step, target_id)
  SELECT p_freeze_started, 'addon_period_ends_at', t.id
    FROM public.tournaments t
   WHERE NOT EXISTS (SELECT 1 FROM public.clubs thaw_club WHERE thaw_club.id = t.club_id AND thaw_club.lifecycle_status = 'retired')
     AND t.addon_period_ends_at > p_freeze_started
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('addon_period_ends_at', v_n);

  INSERT INTO public.engine_maintenance_thaw_targets(freeze_started_at, step, target_id)
  SELECT p_freeze_started, 'reversible_until', c.id
    FROM public.chip_transactions c
   WHERE NOT EXISTS (SELECT 1 FROM public.clubs thaw_club WHERE thaw_club.id = c.club_id AND thaw_club.lifecycle_status = 'retired')
     AND c.reversible_until > p_freeze_started
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('reversible_until', v_n);

  INSERT INTO public.engine_maintenance_thaw_targets(freeze_started_at, step, target_id)
  SELECT p_freeze_started, 'reveal_deadline_at', a.id
    FROM public.tournament_bounty_awards a
   WHERE NOT EXISTS (SELECT 1 FROM public.tournaments thaw_event JOIN public.clubs thaw_club ON thaw_club.id = thaw_event.club_id WHERE thaw_event.id = a.tournament_id AND thaw_club.lifecycle_status = 'retired')
     AND a.reveal_deadline_at > p_freeze_started
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('reveal_deadline_at', v_n);

  INSERT INTO public.engine_maintenance_thaw_targets(freeze_started_at, step, target_id)
  SELECT p_freeze_started, 'rebuy_prompt_until', p.id
    FROM public.tournament_players p
   WHERE NOT EXISTS (SELECT 1 FROM public.tournaments thaw_event JOIN public.clubs thaw_club ON thaw_club.id = thaw_event.club_id WHERE thaw_event.id = p.tournament_id AND thaw_club.lifecycle_status = 'retired')
     AND p.rebuy_prompt_until > p_freeze_started
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('rebuy_prompt_until', v_n);

  INSERT INTO public.engine_maintenance_thaw_targets(freeze_started_at, step, target_id)
  SELECT p_freeze_started, 'bomb_pot_next_due_at', t.id
    FROM public.tables t
   WHERE NOT EXISTS (SELECT 1 FROM public.clubs thaw_club WHERE thaw_club.id = t.club_id AND thaw_club.lifecycle_status = 'retired')
     AND t.bomb_pot_next_due_at IS NOT NULL
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('bomb_pot_next_due_at', v_n);

  INSERT INTO public.engine_maintenance_thaw_targets(freeze_started_at, step, target_id)
  SELECT p_freeze_started, 'cash_stay_last_tick_at', s.id
    FROM public.cash_player_session s
   WHERE NOT EXISTS (SELECT 1 FROM public.clubs thaw_club WHERE thaw_club.id = s.club_id AND thaw_club.lifecycle_status = 'retired')
     AND s.closed_at IS NULL
     AND s.stay_running
     AND s.stay_last_tick_at <= p_freeze_started + make_interval(secs => p_initial_seconds)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('cash_stay_last_tick_at', v_n);

  INSERT INTO public.engine_maintenance_thaw_targets(freeze_started_at, step, target_id)
  SELECT p_freeze_started, 'cash_rejoin_expires_at', r.id
    FROM public.cash_rejoin_constraints r
   WHERE NOT EXISTS (SELECT 1 FROM public.clubs thaw_club WHERE thaw_club.id = r.club_id AND thaw_club.lifecycle_status = 'retired')
     AND r.expires_at > p_freeze_started
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('cash_rejoin_expires_at', v_n);

  INSERT INTO public.engine_maintenance_thaw_targets(freeze_started_at, step, target_id)
  SELECT p_freeze_started, 'cluster_break_eligible_since', t.id
    FROM public.tables t
   WHERE NOT EXISTS (SELECT 1 FROM public.clubs thaw_club WHERE thaw_club.id = t.club_id AND thaw_club.lifecycle_status = 'retired')
     AND t.break_eligible_since IS NOT NULL
     AND t.break_eligible_since <= p_freeze_started + make_interval(secs => p_initial_seconds)
     AND t.cluster_id IS NOT NULL
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('cluster_break_eligible_since', v_n);

  INSERT INTO public.engine_maintenance_thaw_targets(freeze_started_at, step, target_id)
  SELECT p_freeze_started, 'cluster_move_expires_at', m.id
    FROM public.cash_seat_moves m
   WHERE NOT EXISTS (SELECT 1 FROM public.cash_games thaw_game JOIN public.clubs thaw_club ON thaw_club.id = thaw_game.club_id WHERE thaw_game.id = m.game_id AND thaw_club.lifecycle_status = 'retired') AND NOT EXISTS (SELECT 1 FROM public.tables thaw_table JOIN public.clubs thaw_club ON thaw_club.id = thaw_table.club_id WHERE thaw_table.id IN (m.from_table_id, m.to_table_id) AND thaw_club.lifecycle_status = 'retired')
     AND m.state = 'pending' AND m.expires_at > p_freeze_started
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('cluster_move_expires_at', v_n);

  INSERT INTO public.engine_maintenance_thaw_targets(freeze_started_at, step, target_id)
  SELECT p_freeze_started, 'level_started_at', t.id
    FROM public.tournaments t
   WHERE NOT EXISTS (SELECT 1 FROM public.clubs thaw_club WHERE thaw_club.id = t.club_id AND thaw_club.lifecycle_status = 'retired')
     AND t.status = 'RUNNING'
     AND COALESCE(t.on_break, false) = false
     AND t.level_started_at IS NOT NULL
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('level_started_at', v_n);

  INSERT INTO public.engine_maintenance_thaw_targets(freeze_started_at, step, target_id)
  SELECT p_freeze_started, 'reconnect_presence', p.table_id
    FROM public.engine_presence_parked p
   WHERE NOT EXISTS (SELECT 1 FROM public.tables thaw_table JOIN public.clubs thaw_club ON thaw_club.id = thaw_table.club_id WHERE thaw_table.id = p.table_id AND thaw_club.lifecycle_status = 'retired')
     AND p.parked_at >= p_freeze_started - INTERVAL '20 minutes'
     AND p.parked_at <= p_freeze_started + make_interval(secs => p_initial_seconds)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('reconnect_presence', v_n);

  INSERT INTO public.engine_maintenance_thaw_targets(freeze_started_at, step, target_id)
  SELECT p_freeze_started, 'reconnect_snapshots', s.id
    FROM public.hand_state_snapshots s
   WHERE NOT EXISTS (SELECT 1 FROM public.tables thaw_table JOIN public.clubs thaw_club ON thaw_club.id = thaw_table.club_id WHERE thaw_table.id = s.table_id AND thaw_club.lifecycle_status = 'retired')
     AND s.is_complete = false
     AND s.updated_at >= p_freeze_started - INTERVAL '20 minutes'
     AND s.updated_at <= p_freeze_started + make_interval(secs => p_initial_seconds)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('reconnect_snapshots', v_n);

  INSERT INTO public.engine_maintenance_thaw_targets(freeze_started_at, step, target_id)
  SELECT p_freeze_started, 'lightning_drain_deadline_at', d.id
    FROM public.lightning_cluster_drain d
   WHERE NOT EXISTS (SELECT 1 FROM public.cash_games thaw_game JOIN public.clubs thaw_club ON thaw_club.id = thaw_game.club_id WHERE thaw_game.id = d.cluster_id AND thaw_club.lifecycle_status = 'retired')
     AND d.completed_at IS NULL AND d.deadline_at > p_freeze_started
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('lightning_drain_deadline_at', v_n);

  UPDATE public.engine_maintenance_thaws t
     SET shifted = t.shifted || jsonb_build_object(
       '_targets_snapshotted', true,
       '_target_counts', v_counts
     )
   WHERE t.freeze_started_at = p_freeze_started;
  RETURN v_counts;
END;
$function$
$definition$;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=p) <> 'd88e7a1fef47d20d060a7e100599e2fe' THEN RAISE EXCEPTION 'RETIRED_CLUB_THAW_POSTIMAGE_DRIFT: fn_snapshot_maintenance_thaw_targets'; END IF;
END $guard$;

DO $guard$
DECLARE p regprocedure := 'public.fn_thaw_platform_checkpointed(timestamp with time zone,numeric,text)'::regprocedure;
BEGIN
 IF NOT (SELECT md5(prosrc)='05801f790fe39cb04a02dc55ee35f1f3' AND prosecdef AND pg_get_userbyid(proowner)='postgres' AND proconfig=ARRAY['search_path=public, pg_temp'] AND proacl='{postgres=X/postgres}'::aclitem[] FROM pg_proc WHERE oid=p) THEN
  RAISE EXCEPTION 'RETIRED_CLUB_THAW_PREIMAGE_DRIFT: fn_thaw_platform_checkpointed';
 END IF;
 EXECUTE $definition$CREATE OR REPLACE FUNCTION public.fn_thaw_platform_checkpointed(p_freeze_started timestamp with time zone, p_frozen_seconds numeric, p_thawed_by text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- Stop starting new steps once this much of our own wall clock is spent.
  -- PostgREST's service_role statement_timeout is 8s; the remainder is head
  -- room for the step in flight and for the FOR UPDATE wait.
  c_budget      CONSTANT INTERVAL := interval '4 seconds';
  -- tournaments.level_started_at rows per call (~20ms each through triggers).
  c_level_batch CONSTANT INTEGER  := 40;

  v_started  TIMESTAMPTZ := clock_timestamp();
  v_row      public.engine_maintenance_thaws%ROWTYPE;
  v_shift    INTERVAL;
  v_counts   JSONB;
  v_n        INTEGER;
  v_done     TEXT[] := '{}';
  v_cursor   UUID;
  v_last     UUID;
  v_batch_n  INTEGER;
  v_total    INTEGER;
BEGIN
  -- Sanity: a thaw claiming more than fifteen frozen minutes is a bug or a
  -- clock skew, and shifting every deadline on the platform by a wrong number
  -- is strictly worse than shifting by nothing.
  IF p_frozen_seconds IS NULL OR p_frozen_seconds <= 0 OR p_frozen_seconds > 900 THEN
    RETURN jsonb_build_object('ok', false, 'complete', false, 'reason', 'implausible_frozen_seconds');
  END IF;

  -- Claim this freeze (or find it already claimed). The ledger row is the
  -- checkpoint file for every call that follows.
  INSERT INTO public.engine_maintenance_thaws (freeze_started_at, frozen_seconds, shifted, thawed_by)
  VALUES (p_freeze_started, p_frozen_seconds, '{}'::jsonb, p_thawed_by)
  ON CONFLICT (freeze_started_at) DO NOTHING;

  SELECT * INTO v_row
    FROM public.engine_maintenance_thaws
   WHERE freeze_started_at = p_freeze_started
     FOR UPDATE;

  v_counts := COALESCE(v_row.shifted, '{}'::jsonb);
  IF COALESCE((v_counts->>'complete')::boolean, false) THEN
    RETURN jsonb_build_object('ok', true, 'complete', true, 'reason', 'already_thawed', 'shifted', v_counts);
  END IF;

  -- One shift for the whole platform: the number the claim recorded.
  v_shift := make_interval(secs => v_row.frozen_seconds);

  -- The thaw's own writes must pass the freeze guard even if it is called a
  -- moment before break_ends_at, and trg_stamp_sit_out_at lets the sit-out
  -- shift through only under this GUC. LOCAL: dies with this transaction.
  PERFORM set_config('app.freeze_bypass', 'on', TRUE);

  -- ── Step: sit-out clocks on live seats ─────────────────────────────────
  -- The whole reason a player can sit out at :53 and still own their seat
  -- at :00. Cheap (index on status; a handful of rows).
  IF NOT (v_counts ? 'sit_out_at') THEN
    UPDATE public.table_seats
       SET sit_out_at = sit_out_at + v_shift
     WHERE NOT EXISTS (SELECT 1 FROM public.tables thaw_table JOIN public.clubs thaw_club ON thaw_club.id = thaw_table.club_id WHERE thaw_table.id = table_seats.table_id AND thaw_club.lifecycle_status = 'retired')
       AND left_at IS NULL AND sit_out_at IS NOT NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('sit_out_at', v_n);
    v_done := array_append(v_done, 'sit_out_at');
  END IF;

  -- ── Step: waitlist seat holds ──────────────────────────────────────────
  -- Holds alive when the freeze began (including any that "expired" during
  -- it - the shift resurrects exactly the time they were owed and no more).
  IF NOT (v_counts ? 'hold_expires_at') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.table_waitlist
       SET hold_expires_at = hold_expires_at + v_shift
     WHERE NOT EXISTS (SELECT 1 FROM public.tables thaw_table JOIN public.clubs thaw_club ON thaw_club.id = thaw_table.club_id WHERE thaw_table.id = table_waitlist.table_id AND thaw_club.lifecycle_status = 'retired')
       AND hold_expires_at > p_freeze_started;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('hold_expires_at', v_n);
    v_done := array_append(v_done, 'hold_expires_at');
  END IF;

  -- ── Step: tournament add-on windows ────────────────────────────────────
  IF NOT (v_counts ? 'addon_period_ends_at') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.tournaments
       SET addon_period_ends_at = addon_period_ends_at + v_shift
     WHERE NOT EXISTS (SELECT 1 FROM public.clubs thaw_club WHERE thaw_club.id = tournaments.club_id AND thaw_club.lifecycle_status = 'retired')
       AND addon_period_ends_at > p_freeze_started;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('addon_period_ends_at', v_n);
    v_done := array_append(v_done, 'addon_period_ends_at');
  END IF;

  -- ── Step: the cashier claim-back window (10 minutes; a freeze would eat half)
  IF NOT (v_counts ? 'reversible_until') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.chip_transactions
       SET reversible_until = reversible_until + v_shift
     WHERE NOT EXISTS (SELECT 1 FROM public.clubs thaw_club WHERE thaw_club.id = chip_transactions.club_id AND thaw_club.lifecycle_status = 'retired')
       AND reversible_until > p_freeze_started;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('reversible_until', v_n);
    v_done := array_append(v_done, 'reversible_until');
  END IF;

  -- ── Step: mystery bounty reveal windows ────────────────────────────────
  IF NOT (v_counts ? 'reveal_deadline_at') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.tournament_bounty_awards
       SET reveal_deadline_at = reveal_deadline_at + v_shift
     WHERE NOT EXISTS (SELECT 1 FROM public.tournaments thaw_event JOIN public.clubs thaw_club ON thaw_club.id = thaw_event.club_id WHERE thaw_event.id = tournament_bounty_awards.tournament_id AND thaw_club.lifecycle_status = 'retired')
       AND reveal_deadline_at > p_freeze_started;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('reveal_deadline_at', v_n);
    v_done := array_append(v_done, 'reveal_deadline_at');
  END IF;

  -- ── Step: bust-rebuy prompts ───────────────────────────────────────────
  IF NOT (v_counts ? 'rebuy_prompt_until') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.tournament_players
       SET rebuy_prompt_until = rebuy_prompt_until + v_shift
     WHERE NOT EXISTS (SELECT 1 FROM public.tournaments thaw_event JOIN public.clubs thaw_club ON thaw_club.id = thaw_event.club_id WHERE thaw_event.id = tournament_players.tournament_id AND thaw_club.lifecycle_status = 'retired')
       AND rebuy_prompt_until > p_freeze_started;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('rebuy_prompt_until', v_n);
    v_done := array_append(v_done, 'rebuy_prompt_until');
  END IF;

  -- ── Step: timed bomb pots ──────────────────────────────────────────────
  -- Due exactly as far after the thaw as they were before the freeze.
  IF NOT (v_counts ? 'bomb_pot_next_due_at') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.tables
       SET bomb_pot_next_due_at = bomb_pot_next_due_at + v_shift
     WHERE NOT EXISTS (SELECT 1 FROM public.clubs thaw_club WHERE thaw_club.id = tables.club_id AND thaw_club.lifecycle_status = 'retired')
       AND bomb_pot_next_due_at IS NOT NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('bomb_pot_next_due_at', v_n);
    v_done := array_append(v_done, 'bomb_pot_next_due_at');
  END IF;

  -- ── Step: CHIP CONTINUITY stay clocks (2026-09-04) ─────────────────────
  -- A running stay clock is `remaining as of last_tick`; shifting last_tick
  -- forward by the frozen minutes is exactly "the freeze did not count".
  -- Only ticks stamped before the thaw: a row the engine has already
  -- re-settled after the break carries no frozen time to give back.
  IF NOT (v_counts ? 'cash_stay_last_tick_at') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.cash_player_session
       SET stay_last_tick_at = stay_last_tick_at + v_shift
     WHERE NOT EXISTS (SELECT 1 FROM public.clubs thaw_club WHERE thaw_club.id = cash_player_session.club_id AND thaw_club.lifecycle_status = 'retired')
       AND closed_at IS NULL AND stay_running AND stay_last_tick_at <= p_freeze_started + v_shift;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('cash_stay_last_tick_at', v_n);
    v_done := array_append(v_done, 'cash_stay_last_tick_at');
  END IF;

  -- ── Step: CHIP CONTINUITY rejoin floors (2026-09-04) ───────────────────
  IF NOT (v_counts ? 'cash_rejoin_expires_at') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.cash_rejoin_constraints
       SET expires_at = expires_at + v_shift
     WHERE NOT EXISTS (SELECT 1 FROM public.clubs thaw_club WHERE thaw_club.id = cash_rejoin_constraints.club_id AND thaw_club.lifecycle_status = 'retired')
       AND expires_at > p_freeze_started;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('cash_rejoin_expires_at', v_n);
    v_done := array_append(v_done, 'cash_rejoin_expires_at');
  END IF;

  -- ── Step: CLUSTER CONTROLLER deadlines (Slice 2, 2026-09-05) ────────────
  -- break_eligible_since is the break hysteresis clock: five frozen minutes
  -- must not count as five quiet minutes. A pending seat move expires 60 s
  -- after it was planned; a frozen engine could not execute it in time.
  IF NOT (v_counts ? 'cluster_break_eligible_since') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.tables
       SET break_eligible_since = break_eligible_since + v_shift
     WHERE NOT EXISTS (SELECT 1 FROM public.clubs thaw_club WHERE thaw_club.id = tables.club_id AND thaw_club.lifecycle_status = 'retired')
       AND break_eligible_since IS NOT NULL AND break_eligible_since <= p_freeze_started + v_shift
       AND cluster_id IS NOT NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('cluster_break_eligible_since', v_n);
    v_done := array_append(v_done, 'cluster_break_eligible_since');
  END IF;
  IF NOT (v_counts ? 'cluster_move_expires_at') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.cash_seat_moves
       SET expires_at = expires_at + v_shift
     WHERE NOT EXISTS (SELECT 1 FROM public.cash_games thaw_game JOIN public.clubs thaw_club ON thaw_club.id = thaw_game.club_id WHERE thaw_game.id = cash_seat_moves.game_id AND thaw_club.lifecycle_status = 'retired') AND NOT EXISTS (SELECT 1 FROM public.tables thaw_table JOIN public.clubs thaw_club ON thaw_club.id = thaw_table.club_id WHERE thaw_table.id IN (cash_seat_moves.from_table_id, cash_seat_moves.to_table_id) AND thaw_club.lifecycle_status = 'retired')
       AND state = 'pending' AND expires_at > p_freeze_started;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('cluster_move_expires_at', v_n);
    v_done := array_append(v_done, 'cluster_move_expires_at');
  END IF;

  -- ── Step (chunked): blind level clocks ─────────────────────────────────
  -- ONLY for running events NOT on the synchronized break. An MTT on the :55
  -- break has its level clock suspended by pauseForBreak and restored by
  -- resumeFromBreak; shifting it here would give that event the five minutes
  -- twice. Short formats (Spins, Heads-Up) never take the synchronized break,
  -- so their wall-time level clock ran straight through the park - this is
  -- what gives it back (the 2026-08-27 incident class where Spins lost whole
  -- levels to a stop they never asked for).
  --
  -- This is the expensive one (~20ms/row through the table's UPDATE
  -- triggers), so it walks the primary key c_level_batch rows at a time and
  -- checkpoints the cursor after every batch. The shift is additive, so the
  -- cursor is what makes re-entry safe: a row below the cursor is done.
  -- The batch ordering by id is stable because no row's id changes and the
  -- set of RUNNING events cannot grow while the engine is parked.
  WHILE NOT (v_counts ? 'level_started_at') AND clock_timestamp() - v_started <= c_budget LOOP
    v_cursor := NULLIF(v_counts->>'level_started_at_cursor', '')::uuid;
    v_total  := COALESCE((v_counts->>'level_started_at_so_far')::integer, 0);

    WITH batch AS (
      SELECT id
        FROM public.tournaments
       WHERE NOT EXISTS (SELECT 1 FROM public.clubs thaw_club WHERE thaw_club.id = tournaments.club_id AND thaw_club.lifecycle_status = 'retired')
         AND status = 'RUNNING'
         AND COALESCE(on_break, FALSE) = FALSE
         AND level_started_at IS NOT NULL
         AND (v_cursor IS NULL OR id > v_cursor)
       ORDER BY id
       LIMIT c_level_batch
    ),
    shifted AS (
      UPDATE public.tournaments t
         SET level_started_at = t.level_started_at + v_shift
        FROM batch b
       WHERE NOT EXISTS (SELECT 1 FROM public.clubs thaw_club WHERE thaw_club.id = t.club_id AND thaw_club.lifecycle_status = 'retired')
       AND t.id = b.id
      RETURNING t.id
    )
    -- (no max(uuid) in Postgres; uuid order is bytewise, identical to its hex text order)
    SELECT count(*), max(id::text)::uuid INTO v_batch_n, v_last FROM shifted;

    v_total := v_total + COALESCE(v_batch_n, 0);

    IF COALESCE(v_batch_n, 0) < c_level_batch THEN
      -- The last batch. Record the final count and drop the cursor keys.
      v_counts := (v_counts - 'level_started_at_cursor' - 'level_started_at_so_far')
                  || jsonb_build_object('level_started_at', v_total);
      v_done := array_append(v_done, 'level_started_at');
    ELSE
      v_counts := v_counts || jsonb_build_object(
        'level_started_at_cursor', v_last::text,
        'level_started_at_so_far', v_total
      );
    END IF;
  END LOOP;


  -- A reconnect allowance must survive both a normal parked restart and a
  -- crash snapshot restored on the other side of the thaw. The per-entry
  -- marker also prevents double credit when memory already shifted it.
  IF NOT (v_counts ? 'reconnect_presence') AND clock_timestamp() - v_started < c_budget THEN
    UPDATE public.engine_presence_parked
       SET disconnect_states = public.fn_thaw_reconnect_states(disconnect_states,
         extract(epoch FROM p_freeze_started) * 1000,
         extract(epoch FROM p_freeze_started + v_shift) * 1000)
     WHERE NOT EXISTS (SELECT 1 FROM public.tables thaw_table JOIN public.clubs thaw_club ON thaw_club.id = thaw_table.club_id WHERE thaw_table.id = engine_presence_parked.table_id AND thaw_club.lifecycle_status = 'retired')
       AND parked_at >= p_freeze_started - interval '20 minutes'
       AND parked_at <= p_freeze_started + v_shift;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('reconnect_presence', v_n);
    v_done := array_append(v_done, 'reconnect_presence');
  END IF;
  IF NOT (v_counts ? 'reconnect_snapshots') AND clock_timestamp() - v_started < c_budget THEN
    UPDATE public.hand_state_snapshots
       SET disconnect_states = public.fn_thaw_reconnect_states(disconnect_states,
         extract(epoch FROM p_freeze_started) * 1000,
         extract(epoch FROM p_freeze_started + v_shift) * 1000)
     WHERE NOT EXISTS (SELECT 1 FROM public.tables thaw_table JOIN public.clubs thaw_club ON thaw_club.id = thaw_table.club_id WHERE thaw_table.id = hand_state_snapshots.table_id AND thaw_club.lifecycle_status = 'retired')
       AND is_complete = false
       AND updated_at >= p_freeze_started - interval '20 minutes'
       AND updated_at <= p_freeze_started + v_shift;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('reconnect_snapshots', v_n);
    v_done := array_append(v_done, 'reconnect_snapshots');
  END IF;

  -- Lightning drains retain the time their undealt reservations were owed.
  -- Use the same ledger lock/checkpoint as every existing thaw step.
  IF NOT (v_counts ? 'lightning_drain_deadline_at') AND clock_timestamp() - v_started <= c_budget THEN
    WITH shifted AS (
      UPDATE public.lightning_cluster_drain d
         SET deadline_at = d.deadline_at + v_shift
       WHERE NOT EXISTS (SELECT 1 FROM public.cash_games thaw_game JOIN public.clubs thaw_club ON thaw_club.id = thaw_game.club_id WHERE thaw_game.id = d.cluster_id AND thaw_club.lifecycle_status = 'retired')
       AND d.completed_at IS NULL AND d.deadline_at > p_freeze_started
      RETURNING d.cluster_id, d.id, d.request_id, d.deadline_at
    ), emitted AS (
      INSERT INTO public.cash_cluster_events (game_id, kind, payload, request_id)
      SELECT cluster_id, 'lightning_drain_deadline_thawed',
             jsonb_build_object('drain_id', id, 'deadline_at', deadline_at,
                               'freeze_started_at', p_freeze_started), request_id
        FROM shifted
      RETURNING id
    ) SELECT count(*)::integer INTO v_n FROM emitted;
    v_counts := v_counts || jsonb_build_object('lightning_drain_deadline_at', v_n);
    v_done := array_append(v_done, 'lightning_drain_deadline_at');
  END IF;

  -- NOT shifted, deliberately:
  --   * tournaments.break_ends_at - the synchronized break owns it and the
  --     engine's resumeFromBreak restores it;
  --   * late_reg (started_at + late_reg_mins) - registration is frozen during
  --     the break, and the hourly tournament break has consumed those same
  --     five minutes of late-reg wall time since it was built. Shifting
  --     started_at would falsify history; parity with the existing break is
  --     the honest behaviour;
  --   * ban/mute/promotion expiries - a punishment or a promotion elapsing
  --     during a break is time genuinely passing, not play being taken away.

  -- Complete when every step has its key.
  IF v_counts ?& ARRAY['sit_out_at','hold_expires_at','addon_period_ends_at','reversible_until',
                       'reveal_deadline_at','rebuy_prompt_until','bomb_pot_next_due_at',
                       'cash_stay_last_tick_at','cash_rejoin_expires_at','level_started_at',
                       'cluster_break_eligible_since','cluster_move_expires_at',
                       'reconnect_presence','reconnect_snapshots','lightning_drain_deadline_at'] THEN
    v_counts := v_counts || jsonb_build_object('complete', true);
  END IF;

  -- Checkpoint. This commit is what a later call resumes from.
  UPDATE public.engine_maintenance_thaws
     SET shifted   = v_counts,
         thawed_at = now()
   WHERE freeze_started_at = p_freeze_started;

  RETURN jsonb_build_object(
    'ok', true,
    'complete', COALESCE((v_counts->>'complete')::boolean, false),
    'steps_this_call', to_jsonb(v_done),
    'elapsed_ms', round(extract(epoch from clock_timestamp() - v_started) * 1000),
    'shifted', v_counts
  );
END;
$function$
$definition$;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=p) <> 'cc06d1cd3c4431387ad898c986b272d0' THEN RAISE EXCEPTION 'RETIRED_CLUB_THAW_POSTIMAGE_DRIFT: fn_thaw_platform_checkpointed'; END IF;
END $guard$;

COMMIT;
