-- Reserved using scripts/reserve-migration-version.sh.
-- Requires the additive blind_level_state column from 20260913195404.
-- Keep trigger installation separate from the parent's ALTER TABLE lock:
-- gameplay table writers can still read the parent while this DDL waits.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.fn_publish_tournament_blind_level(
  p_tournament_id uuid, p_lease_generation uuid,
  p_previous_level integer, p_next_level integer,
  p_small_blind numeric, p_big_blind numeric, p_ante numeric
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_state jsonb;
  v_rows integer;
  v_started_at timestamptz;
BEGIN
  IF p_tournament_id IS NULL OR p_lease_generation IS NULL
     OR p_previous_level IS NULL OR p_previous_level<0
     OR p_next_level IS NULL OR p_next_level<=p_previous_level
     OR p_small_blind IS NULL OR p_small_blind<0 OR p_small_blind>10000000
     OR p_big_blind IS NULL OR p_big_blind<=0 OR p_big_blind>10000000
     OR p_small_blind>p_big_blind
     OR p_ante IS NULL OR p_ante<0 OR p_ante>10000000 THEN
    RAISE EXCEPTION 'Invalid tournament blind transition' USING ERRCODE='22023';
  END IF;

  IF current_setting('app.smarter_data_actor',true) IS DISTINCT FROM 'tournament-manager'
     OR nullif(current_setting('app.smarter_tournament_id',true),'') IS DISTINCT FROM p_tournament_id::text
     OR nullif(current_setting('app.smarter_tournament_lease_generation',true),'') IS DISTINCT FROM p_lease_generation::text THEN
    RAISE EXCEPTION 'TOURNAMENT_MANAGER_FENCED: blind transition authority does not match request'
      USING ERRCODE='42501';
  END IF;

  -- Same maintenance admission barrier and scoped settlement ordering as the
  -- existing tournament authorities. Heartbeats remain free to renew; a
  -- generation takeover waits for this short transaction to finish.
  PERFORM pg_advisory_xact_lock_shared(530090,1);
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id,NULL);
  PERFORM 1 FROM public.engine_tournament_leases l
   WHERE l.tournament_id=p_tournament_id AND l.protocol_version=2
     AND l.lease_generation=p_lease_generation
     AND l.heartbeat_at>=clock_timestamp()-interval '30 seconds'
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TOURNAMENT_MANAGER_FENCED: blind transition lease is stale'
      USING ERRCODE='42501';
  END IF;

  SELECT * INTO v_t FROM public.tournaments
   WHERE id=p_tournament_id FOR UPDATE;
  IF NOT FOUND OR v_t.status IS DISTINCT FROM 'RUNNING' THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_running');
  END IF;
  IF COALESCE(v_t.on_break,false) OR public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok',false,'reason','paused');
  END IF;
  v_state:=jsonb_build_object('index',p_next_level,
    'small_blind',p_small_blind,'big_blind',p_big_blind,'ante',p_ante);

  IF v_t.current_level=p_next_level AND v_t.blind_level_state=v_state THEN
    -- A lost response may be retried after a break has shifted the clock.
    -- Return the current durable anchor; never restore the old request time.
    RETURN jsonb_build_object('ok',true,'replayed',true,
      'tournament_id',p_tournament_id,'current_level',v_t.current_level,
      'level_started_at',v_t.level_started_at,'blind_level_state',v_state);
  END IF;
  IF v_t.current_level IS DISTINCT FROM p_previous_level THEN
    RAISE EXCEPTION 'Tournament blind transition does not follow its committed level'
      USING ERRCODE='40001';
  END IF;

  -- Parent-first table birth locking makes this a complete, stable field.
  PERFORM 1 FROM public.tables t
   WHERE t.tournament_id=p_tournament_id AND NOT COALESCE(t.is_deleted,false)
     AND lower(COALESCE(t.status::text,'')) NOT IN('closed','deleted','completed','cancelled','finished')
   ORDER BY t.id FOR UPDATE;
  UPDATE public.tables SET small_blind=p_small_blind,big_blind=p_big_blind,
    ante=p_ante,stakes=trim_scale(p_small_blind)::text||'/'||trim_scale(p_big_blind)::text
   WHERE tournament_id=p_tournament_id AND NOT COALESCE(is_deleted,false)
     AND lower(COALESCE(status::text,'')) NOT IN('closed','deleted','completed','cancelled','finished');
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  v_started_at:=clock_timestamp();
  UPDATE public.tournaments SET current_level=p_next_level,
    level_started_at=v_started_at,blind_level_state=v_state
   WHERE id=p_tournament_id;

  -- A trigger may suppress or alter a write without raising an SQL error.
  -- A successful receipt must describe the state that actually survived it.
  SELECT * INTO v_t FROM public.tournaments WHERE id=p_tournament_id;
  IF v_t.current_level IS DISTINCT FROM p_next_level
     OR v_t.level_started_at IS DISTINCT FROM v_started_at
     OR v_t.blind_level_state IS DISTINCT FROM v_state
     OR EXISTS (
       SELECT 1 FROM public.tables t WHERE t.tournament_id=p_tournament_id
        AND NOT COALESCE(t.is_deleted,false)
        AND lower(COALESCE(t.status::text,'')) NOT IN('closed','deleted','completed','cancelled','finished')
        AND (t.small_blind IS DISTINCT FROM p_small_blind
          OR t.big_blind IS DISTINCT FROM p_big_blind OR t.ante IS DISTINCT FROM p_ante
          OR t.stakes IS DISTINCT FROM trim_scale(p_small_blind)::text||'/'||trim_scale(p_big_blind)::text)
     ) THEN
    RAISE EXCEPTION 'Tournament blind publication was not fully acknowledged' USING ERRCODE='40001';
  END IF;

  RETURN jsonb_build_object('ok',true,'replayed',false,
    'tournament_id',p_tournament_id,'current_level',p_next_level,
    'level_started_at',v_started_at,'blind_level_state',v_state,'tables_updated',v_rows);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_publish_tournament_blind_level(uuid,uuid,integer,integer,numeric,numeric,numeric)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_publish_tournament_blind_level(uuid,uuid,integer,integer,numeric,numeric,numeric)
  TO service_role;

CREATE OR REPLACE FUNCTION public.fn_tournament_table_inherits_committed_blinds()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE v_level integer; v_state jsonb;
BEGIN
  IF NEW.tournament_id IS NULL THEN RETURN NEW; END IF;
  SELECT current_level,blind_level_state INTO v_level,v_state
    FROM public.tournaments WHERE id=NEW.tournament_id FOR SHARE;
  IF v_state IS NULL THEN RETURN NEW; END IF;
  IF (v_state->>'index')::integer IS DISTINCT FROM v_level THEN
    RAISE EXCEPTION 'Tournament table cannot inherit an unconfirmed blind level';
  END IF;
  NEW.small_blind:=(v_state->>'small_blind')::numeric;
  NEW.big_blind:=(v_state->>'big_blind')::numeric;
  NEW.ante:=(v_state->>'ante')::numeric;
  NEW.stakes:=trim_scale(NEW.small_blind)::text||'/'||trim_scale(NEW.big_blind)::text;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_tournament_table_inherits_committed_blinds() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_table_inherits_committed_blinds() TO service_role;
DROP TRIGGER IF EXISTS tournament_table_inherits_committed_blinds ON public.tables;
CREATE TRIGGER tournament_table_inherits_committed_blinds BEFORE INSERT ON public.tables
FOR EACH ROW EXECUTE FUNCTION public.fn_tournament_table_inherits_committed_blinds();
COMMIT;
