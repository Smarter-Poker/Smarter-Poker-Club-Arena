-- Table Management Scale And Scheduling
-- Phase 6 adds bounded keyset reads, durable scheduled close commands, compact
-- event retention, and scheduler health without opening a second mutation door.

BEGIN;

CREATE TABLE IF NOT EXISTS public.managed_game_schedules (
  schedule_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL,
  game_kind text NOT NULL CHECK (game_kind IN ('table', 'tournament')),
  game_id uuid NOT NULL,
  command_action text NOT NULL DEFAULT 'close' CHECK (command_action = 'close'),
  expected_version integer NOT NULL CHECK (expected_version > 0),
  execute_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'executing', 'succeeded', 'rejected', 'cancelled')),
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (execute_at > created_at),
  CHECK (
    (status IN ('scheduled', 'executing') AND completed_at IS NULL)
    OR (status IN ('succeeded', 'rejected', 'cancelled') AND completed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_game_schedules_one_pending_close
  ON public.managed_game_schedules(game_kind, game_id)
  WHERE status IN ('scheduled', 'executing');
CREATE INDEX IF NOT EXISTS idx_managed_game_schedules_due
  ON public.managed_game_schedules(execute_at, schedule_id)
  WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_managed_game_schedules_game
  ON public.managed_game_schedules(game_kind, game_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tables_management_club_page
  ON public.tables(club_id, created_at, id)
  WHERE tournament_id IS NULL AND NOT COALESCE(is_deleted,false) AND union_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_tables_management_union_page
  ON public.tables(union_id, created_at, id)
  WHERE tournament_id IS NULL AND NOT COALESCE(is_deleted,false) AND union_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tournaments_management_club_page
  ON public.tournaments(club_id, start_time, id) WHERE union_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_tournaments_management_union_page
  ON public.tournaments(union_id, start_time, id) WHERE union_id IS NOT NULL;

ALTER TABLE public.managed_game_schedules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.managed_game_schedules FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_schedule_managed_game_close(
  p_kind text, p_game_id uuid, p_expected_version integer, p_execute_at timestamptz
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_club uuid;
  v_schedule public.managed_game_schedules%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;
  IF p_kind NOT IN ('table','tournament') OR p_expected_version < 1
     OR p_execute_at <= now() + interval '1 minute'
     OR p_execute_at > now() + interval '365 days' THEN
    RETURN jsonb_build_object('ok',false,'reason','invalid_schedule');
  END IF;
  IF p_kind='table' THEN
    SELECT club_id INTO v_club FROM public.tables WHERE id=p_game_id;
  ELSE
    SELECT club_id INTO v_club FROM public.tournaments WHERE id=p_game_id;
  END IF;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','game_not_found'); END IF;
  IF NOT public.fn_can_create_games(v_club,v_uid) THEN
    RETURN jsonb_build_object('ok',false,'reason','not_authorized');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.managed_game_contract_versions
    WHERE game_kind=p_kind AND game_id=p_game_id AND version=p_expected_version
  ) THEN RETURN jsonb_build_object('ok',false,'reason','stale_contract_version'); END IF;

  SELECT * INTO v_schedule FROM public.managed_game_schedules
   WHERE game_kind=p_kind AND game_id=p_game_id AND status IN ('scheduled','executing')
   FOR UPDATE;
  IF FOUND AND v_schedule.status='executing' THEN
    RETURN jsonb_build_object('ok',false,'reason','schedule_not_pending');
  ELSIF FOUND THEN
    UPDATE public.managed_game_schedules SET actor_id=v_uid,command_id=gen_random_uuid(),
      expected_version=p_expected_version,execute_at=p_execute_at,result='{}'::jsonb,
      created_at=now()
    WHERE schedule_id=v_schedule.schedule_id RETURNING * INTO v_schedule;
  ELSE
    INSERT INTO public.managed_game_schedules(
      actor_id,game_kind,game_id,expected_version,execute_at
    ) VALUES (v_uid,p_kind,p_game_id,p_expected_version,p_execute_at)
    RETURNING * INTO v_schedule;
  END IF;
  PERFORM public.fn_emit_game_management_event(
    'game_changed',v_club,NULL,NULL,p_kind,p_game_id,NULL,
    jsonb_build_object('operation','close_scheduled','schedule_id',v_schedule.schedule_id)
  );
  RETURN jsonb_build_object('ok',true,'schedule',to_jsonb(v_schedule));
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_cancel_managed_game_schedule(p_schedule_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_schedule public.managed_game_schedules%ROWTYPE;
  v_club uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;
  SELECT * INTO v_schedule FROM public.managed_game_schedules
   WHERE schedule_id=p_schedule_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','schedule_not_found'); END IF;
  IF v_schedule.game_kind='table' THEN
    SELECT club_id INTO v_club FROM public.tables WHERE id=v_schedule.game_id;
  ELSE
    SELECT club_id INTO v_club FROM public.tournaments WHERE id=v_schedule.game_id;
  END IF;
  IF NOT public.fn_can_create_games(v_club,v_uid) THEN
    RETURN jsonb_build_object('ok',false,'reason','not_authorized');
  END IF;
  IF v_schedule.status<>'scheduled' THEN
    RETURN jsonb_build_object('ok',false,'reason','schedule_not_pending');
  END IF;
  UPDATE public.managed_game_schedules SET status='cancelled',completed_at=now(),
    result=jsonb_build_object('ok',true,'cancelled_by',v_uid)
  WHERE schedule_id=p_schedule_id RETURNING * INTO v_schedule;
  PERFORM public.fn_emit_game_management_event(
    'game_changed',v_club,NULL,NULL,v_schedule.game_kind,v_schedule.game_id,NULL,
    jsonb_build_object('operation','close_schedule_cancelled','schedule_id',p_schedule_id)
  );
  RETURN jsonb_build_object('ok',true,'schedule',to_jsonb(v_schedule));
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_run_due_managed_game_schedules(p_batch_size integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_schedule public.managed_game_schedules%ROWTYPE;
  v_result jsonb;
  v_processed integer := 0;
BEGIN
  IF auth.uid() IS NOT NULL AND COALESCE(auth.role(),'')<>'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE='42501';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext('run-due-managed-game-schedules')) THEN
    RETURN jsonb_build_object('ok',true,'processed',0,'overlap_skipped',true);
  END IF;
  FOR v_schedule IN
    SELECT * FROM public.managed_game_schedules
    WHERE status='scheduled' AND execute_at<=now()
    ORDER BY execute_at,schedule_id FOR UPDATE SKIP LOCKED
    LIMIT LEAST(100,GREATEST(1,COALESCE(p_batch_size,50)))
  LOOP
    UPDATE public.managed_game_schedules SET status='executing'
      WHERE schedule_id=v_schedule.schedule_id;
    PERFORM set_config('request.jwt.claim.sub',v_schedule.actor_id::text,true);
    PERFORM set_config('request.jwt.claim.role','authenticated',true);
    v_result := public.fn_execute_managed_game_command(
      v_schedule.command_id,v_schedule.game_kind,v_schedule.game_id,
      v_schedule.command_action,v_schedule.expected_version,'{}'::jsonb
    );
    UPDATE public.managed_game_schedules
      SET status=CASE WHEN COALESCE((v_result->>'ok')::boolean,false)
                      THEN 'succeeded' ELSE 'rejected' END,
          result=v_result,completed_at=now()
      WHERE schedule_id=v_schedule.schedule_id;
    v_processed := v_processed+1;
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub','',true);
  PERFORM set_config('request.jwt.claim.role','',true);
  RETURN jsonb_build_object('ok',true,'processed',v_processed,'overlap_skipped',false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_list_managed_games(
  p_scope text, p_scope_id uuid, p_cursor timestamptz DEFAULT NULL,
  p_cursor_kind text DEFAULT NULL, p_cursor_id uuid DEFAULT NULL, p_limit integer DEFAULT 100
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_limit integer:=LEAST(100,GREATEST(1,COALESCE(p_limit,100))); v_items jsonb; v_counts jsonb; v_next jsonb;
BEGIN
  IF p_scope NOT IN ('club','union') OR NOT COALESCE(CASE p_scope
    WHEN 'club' THEN public.fn_can_create_games(p_scope_id,auth.uid())
    ELSE public.fn_is_union_operator(p_scope_id,auth.uid()) END,false) THEN
    RETURN jsonb_build_object('ok',false,'reason','not_authorized');
  END IF;
  WITH all_games AS (
    SELECT t.id,'table'::text kind,t.club_id,t.name,t.status,COALESCE(t.game_variant,'NLH') variant,
      COALESCE(t.current_players,0) players,COALESCE(t.max_players,0) max_players,
      NULL::timestamptz start_time,t.created_at sort_at,COALESCE(t.small_blind,0) small_blind,
      COALESCE(t.big_blind,0) big_blind,COALESCE(t.min_buy_in,0) min_buy_in,
      COALESCE(t.max_buy_in,0) max_buy_in,0::numeric buy_in
    FROM public.tables t WHERE t.tournament_id IS NULL AND NOT COALESCE(t.is_deleted,false)
      AND ((p_scope='club' AND t.club_id=p_scope_id AND t.union_id IS NULL)
        OR (p_scope='union' AND t.union_id=p_scope_id))
    UNION ALL
    SELECT t.id,'tournament',t.club_id,t.name,t.status,COALESCE(t.game_type,t.variant,'MTT'),
      COALESCE(t.current_players,0),COALESCE(t.max_players,0),t.start_time,
      COALESCE(t.start_time,t.created_at),0::numeric,0::numeric,0::numeric,0::numeric,
      COALESCE(t.buy_in_amount,0)
    FROM public.tournaments t WHERE
      (p_scope='club' AND t.club_id=p_scope_id AND t.union_id IS NULL)
      OR (p_scope='union' AND t.union_id=p_scope_id)
  ), page AS (
    SELECT g.* FROM all_games g
    WHERE p_cursor IS NULL OR (g.sort_at,g.kind,g.id)>(p_cursor,p_cursor_kind,p_cursor_id)
    ORDER BY g.sort_at,g.kind,g.id LIMIT v_limit
  ), enriched AS (
    SELECT p.*,(SELECT to_jsonb(s) FROM (
      SELECT ms.schedule_id,ms.execute_at,ms.status FROM public.managed_game_schedules ms
      WHERE ms.game_kind=p.kind AND ms.game_id=p.id AND ms.status='scheduled'
      ORDER BY ms.created_at DESC LIMIT 1) s) pending_schedule
    FROM page p ORDER BY p.sort_at,p.kind,p.id
  ) SELECT COALESCE(jsonb_agg(to_jsonb(enriched) ORDER BY sort_at,kind,id),'[]'::jsonb)
    INTO v_items FROM enriched;

  WITH scoped AS (
    SELECT status,'table'::text kind FROM public.tables t
    WHERE t.tournament_id IS NULL AND NOT COALESCE(t.is_deleted,false)
      AND ((p_scope='club' AND t.club_id=p_scope_id AND t.union_id IS NULL)
        OR (p_scope='union' AND t.union_id=p_scope_id))
    UNION ALL SELECT status,'tournament' FROM public.tournaments t WHERE
      (p_scope='club' AND t.club_id=p_scope_id AND t.union_id IS NULL)
      OR (p_scope='union' AND t.union_id=p_scope_id)
  ) SELECT jsonb_build_object('total',count(*),
    'live',count(*) FILTER (WHERE lower(status) IN ('running','active','waiting','registering','late_reg')),
    'scheduled',count(*) FILTER (WHERE kind='tournament' AND lower(status) NOT IN
      ('running','active','waiting','registering','late_reg','closed','completed','cancelled','canceled','deleted')))
  INTO v_counts FROM scoped;

  WITH all_games AS (
    SELECT t.id,'table'::text kind,t.created_at sort_at FROM public.tables t
    WHERE t.tournament_id IS NULL AND NOT COALESCE(t.is_deleted,false)
      AND ((p_scope='club' AND t.club_id=p_scope_id AND t.union_id IS NULL)
        OR (p_scope='union' AND t.union_id=p_scope_id))
    UNION ALL SELECT t.id,'tournament',COALESCE(t.start_time,t.created_at)
    FROM public.tournaments t WHERE (p_scope='club' AND t.club_id=p_scope_id AND t.union_id IS NULL)
      OR (p_scope='union' AND t.union_id=p_scope_id)
  ), remaining AS (
    SELECT * FROM all_games WHERE p_cursor IS NULL OR (sort_at,kind,id)>(p_cursor,p_cursor_kind,p_cursor_id)
    ORDER BY sort_at,kind,id OFFSET v_limit LIMIT 1
  ), last_item AS (
    SELECT * FROM all_games WHERE p_cursor IS NULL OR (sort_at,kind,id)>(p_cursor,p_cursor_kind,p_cursor_id)
    ORDER BY sort_at,kind,id OFFSET GREATEST(v_limit-1,0) LIMIT 1
  ) SELECT CASE WHEN EXISTS(SELECT 1 FROM remaining) THEN
    (SELECT jsonb_build_object('sort_at',sort_at,'kind',kind,'id',id) FROM last_item)
    ELSE NULL END INTO v_next;
  RETURN jsonb_build_object('ok',true,'items',v_items,'counts',v_counts,'next_cursor',v_next);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_guard_game_management_event()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
  IF TG_OP='DELETE' AND auth.uid() IS NULL
    AND COALESCE(current_setting('app.game_management_retention',true),'')='on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Game management events are append-only' USING ERRCODE='55000';
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_prune_game_management_events(
  p_before timestamptz DEFAULT now()-interval '30 days',p_batch_size integer DEFAULT 5000
)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_deleted integer;
BEGIN
  IF auth.uid() IS NOT NULL AND COALESCE(auth.role(),'')<>'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE='42501';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext('prune-game-management-events')) THEN RETURN 0; END IF;
  PERFORM set_config('app.game_management_retention','on',true);
  WITH candidates AS (
    SELECT sequence FROM public.game_management_events
    WHERE created_at<LEAST(p_before,now()-interval '7 days')
    ORDER BY sequence FOR UPDATE SKIP LOCKED
    LIMIT LEAST(10000,GREATEST(1,COALESCE(p_batch_size,5000)))
  ) DELETE FROM public.game_management_events e USING candidates c WHERE e.sequence=c.sequence;
  GET DIAGNOSTICS v_deleted=ROW_COUNT;
  PERFORM set_config('app.game_management_retention','',true);
  RETURN v_deleted;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_get_game_management_scale_health(p_scope text,p_scope_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF NOT COALESCE(CASE p_scope WHEN 'club' THEN public.fn_can_create_games(p_scope_id,auth.uid())
    WHEN 'union' THEN public.fn_is_union_operator(p_scope_id,auth.uid()) ELSE false END,false) THEN
    RETURN jsonb_build_object('ok',false,'reason','not_authorized');
  END IF;
  RETURN jsonb_build_object('ok',true,
    'scheduled_pending',(SELECT count(*) FROM public.managed_game_schedules s
      WHERE s.status IN ('scheduled','executing') AND (
        (s.game_kind='table' AND EXISTS(SELECT 1 FROM public.tables t WHERE t.id=s.game_id AND
          ((p_scope='club' AND t.club_id=p_scope_id AND t.union_id IS NULL) OR (p_scope='union' AND t.union_id=p_scope_id))))
        OR (s.game_kind='tournament' AND EXISTS(SELECT 1 FROM public.tournaments t WHERE t.id=s.game_id AND
          ((p_scope='club' AND t.club_id=p_scope_id AND t.union_id IS NULL) OR (p_scope='union' AND t.union_id=p_scope_id))))
      )),
    'scheduled_rejected_24h',(SELECT count(*) FROM public.managed_game_schedules s
      WHERE s.status='rejected' AND s.completed_at>=now()-interval '24 hours' AND (
        (s.game_kind='table' AND EXISTS(SELECT 1 FROM public.tables t WHERE t.id=s.game_id AND
          ((p_scope='club' AND t.club_id=p_scope_id AND t.union_id IS NULL) OR (p_scope='union' AND t.union_id=p_scope_id))))
        OR (s.game_kind='tournament' AND EXISTS(SELECT 1 FROM public.tournaments t WHERE t.id=s.game_id AND
          ((p_scope='club' AND t.club_id=p_scope_id AND t.union_id IS NULL) OR (p_scope='union' AND t.union_id=p_scope_id))))
      )),
    'event_rows',(SELECT count(*) FROM public.game_management_events WHERE scope_kind=p_scope AND scope_id=p_scope_id),
    'oldest_event_at',(SELECT min(created_at) FROM public.game_management_events WHERE scope_kind=p_scope AND scope_id=p_scope_id),
    'retention_days',30,'page_limit',100);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_schedule_managed_game_close(text,uuid,integer,timestamptz) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_cancel_managed_game_schedule(uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_list_managed_games(text,uuid,timestamptz,text,uuid,integer) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_get_game_management_scale_health(text,uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_run_due_managed_game_schedules(integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_prune_game_management_events(timestamptz,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_schedule_managed_game_close(text,uuid,integer,timestamptz) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_cancel_managed_game_schedule(uuid) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_list_managed_games(text,uuid,timestamptz,text,uuid,integer) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_get_game_management_scale_health(text,uuid) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_run_due_managed_game_schedules(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_prune_game_management_events(timestamptz,integer) TO service_role;

DO $do$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname='managed-game-schedules-minute';
  PERFORM cron.schedule('managed-game-schedules-minute','* * * * *','SELECT public.fn_run_due_managed_game_schedules(50)');
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname='game-management-events-retention';
  PERFORM cron.schedule('game-management-events-retention','17 4 * * *',
    'SELECT public.fn_prune_game_management_events(now() - interval ''30 days'', 5000)');
END;
$do$;

COMMENT ON TABLE public.managed_game_schedules IS
  'Durable future close commands. Execution reuses the exactly-once command gateway and current lifecycle guards.';
COMMIT;
