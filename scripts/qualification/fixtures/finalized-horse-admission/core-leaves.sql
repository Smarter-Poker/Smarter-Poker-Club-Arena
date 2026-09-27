BEGIN; SET LOCAL search_path=public,extensions,pg_temp; SET LOCAL check_function_bodies=off; SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='2s';
DO $$ BEGIN IF session_user<>'fixture_bootstrap' OR current_database() !~ '^qual_spin_expiry_[0-9a-f]{32}$' OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>'' THEN RAISE EXCEPTION 'HORSE_DEPENDENCY_ISOLATION_REQUIRED'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_is_unlimited(p_tournament_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_abi text;
BEGIN
 v_abi:=public.fn_ca_lock_mtt_admission_contract();
 IF v_abi='legacy-capacity-v1' THEN RETURN false; END IF;
 RETURN public.fn_ca_tournament_recorded_format(p_tournament_id) IN ('mtt-v1','mtt-v2');
END $function$;
ALTER FUNCTION public.fn_ca_tournament_is_unlimited(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_is_unlimited(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_is_unlimited(uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_is_unlimited(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_is_unlimited(uuid) TO service_role;
DO $$ BEGIN IF md5(pg_get_functiondef('public.fn_ca_tournament_is_unlimited(uuid)'::regprocedure)) IS DISTINCT FROM 'fd66c28075f1d7c63b9d763632592471' THEN RAISE EXCEPTION 'HORSE_DEPENDENCY_SOURCE_CHANGED'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_capability_available(p_capability_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(
    (SELECT c.readiness IN ('deployed','production_verified')
       FROM public.platform_capabilities c
      WHERE c.capability_id = p_capability_id),
    false);
$function$;
ALTER FUNCTION public.fn_capability_available(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_capability_available(text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_capability_available(text) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_capability_available(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_capability_available(text) TO service_role;
DO $$ BEGIN IF md5(pg_get_functiondef('public.fn_capability_available(text)'::regprocedure)) IS DISTINCT FROM '43d415cfb6fbb9c289e98b12b5de925c' THEN RAISE EXCEPTION 'HORSE_DEPENDENCY_SOURCE_CHANGED'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_kill_pot_configuration_refusal(p_kill_mode text, p_variant text, p_game_type text, p_tournament_id uuid, p_bomb_pot_enabled boolean, p_big_blind numeric, p_club_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_diamond boolean := p_club_id IS NOT DISTINCT FROM '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid;
  v_minor numeric;
BEGIN
  IF p_kill_mode IS NULL OR p_kill_mode NOT IN ('off','half','full') THEN
    RETURN 'Kill Mode Must Be Off, Half Or Full';
  END IF;
  IF p_kill_mode = 'off' THEN
    RETURN NULL;
  END IF;
  IF p_tournament_id IS NOT NULL OR lower(coalesce(p_game_type, '')) = 'tournament' THEN
    RETURN 'Kill Pots Are Only Available At Cash Tables';
  END IF;
  IF lower(coalesce(p_variant, '')) NOT IN ('flh','flo8') THEN
    RETURN 'Kill Pots Need Fixed Limit Hold''em Or Fixed Limit Omaha Hi-Lo';
  END IF;
  IF coalesce(p_bomb_pot_enabled, false) THEN
    RETURN 'Kill Pots Cannot Be Combined With Bomb Pots';
  END IF;
  -- kill-v1 exactness: the base big blind in minor units (cents, or whole
  -- Diamonds) times the multiplier must be an integer. Full is 2/1, half 3/2.
  v_minor := p_big_blind * CASE WHEN v_diamond THEN 1 ELSE 100 END;
  IF v_minor IS NULL OR v_minor <= 0 OR v_minor <> trunc(v_minor) THEN
    RETURN CASE WHEN v_diamond THEN 'Kill Pots Need A Big Blind Of Whole Diamonds'
                ELSE 'Kill Pots Need A Big Blind Of Whole Cents' END;
  END IF;
  IF p_kill_mode = 'half' AND mod(v_minor, 2) <> 0 THEN
    RETURN CASE WHEN v_diamond THEN 'Half Kill Needs An Even Number Of Diamonds As The Big Blind'
                ELSE 'Half Kill Needs A Big Blind That Is An Even Number Of Cents' END;
  END IF;
  RETURN NULL;
END
$function$;
ALTER FUNCTION public.fn_kill_pot_configuration_refusal(text,text,text,uuid,boolean,numeric,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_kill_pot_configuration_refusal(text,text,text,uuid,boolean,numeric,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_kill_pot_configuration_refusal(text,text,text,uuid,boolean,numeric,uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_kill_pot_configuration_refusal(text,text,text,uuid,boolean,numeric,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_kill_pot_configuration_refusal(text,text,text,uuid,boolean,numeric,uuid) TO service_role;
DO $$ BEGIN IF md5(pg_get_functiondef('public.fn_kill_pot_configuration_refusal(text,text,text,uuid,boolean,numeric,uuid)'::regprocedure)) IS DISTINCT FROM 'c5f1d7f6361676b0ed0780e8ca9394a2' THEN RAISE EXCEPTION 'HORSE_DEPENDENCY_SOURCE_CHANGED'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_lightning_anchor_is_live_eligible(p_seat_id uuid, p_cluster_id uuid, p_player_id uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.table_seats ts
      JOIN public.tables tb ON tb.id = ts.table_id
     WHERE ts.id = p_seat_id
       AND tb.cluster_id = p_cluster_id AND coalesce(tb.is_deleted, false) = false
       AND coalesce(tb.lifecycle, '') <> 'closed'
       AND ts.left_at IS NULL
       AND ts.user_id IS NOT NULL
       AND (p_player_id IS NULL OR ts.user_id = p_player_id)
       AND coalesce(ts.is_sitting_out, false) = false
       AND coalesce(ts.leave_pending, false) = false
       AND coalesce(ts.stack, 0) > 0);
$function$;
ALTER FUNCTION public.fn_lightning_anchor_is_live_eligible(uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_lightning_anchor_is_live_eligible(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_lightning_anchor_is_live_eligible(uuid,uuid,uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_lightning_anchor_is_live_eligible(uuid,uuid,uuid) TO service_role;
DO $$ BEGIN IF md5(pg_get_functiondef('public.fn_lightning_anchor_is_live_eligible(uuid,uuid,uuid)'::regprocedure)) IS DISTINCT FROM 'a121611dd69437875e82a06832715981' THEN RAISE EXCEPTION 'HORSE_DEPENDENCY_SOURCE_CHANGED'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_lightning_player_in_hand(p_player_id uuid, p_cluster_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.lightning_reservation r
      JOIN public.lightning_instance i ON i.id = r.lightning_instance_id
     WHERE r.cluster_id = p_cluster_id
       AND r.player_id = p_player_id
       AND r.state = 'committed'
       AND i.state IN ('forming', 'reserved', 'dealing', 'settling'));
$function$;
ALTER FUNCTION public.fn_lightning_player_in_hand(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_lightning_player_in_hand(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_lightning_player_in_hand(uuid,uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_lightning_player_in_hand(uuid,uuid) TO service_role;
DO $$ BEGIN IF md5(pg_get_functiondef('public.fn_lightning_player_in_hand(uuid,uuid)'::regprocedure)) IS DISTINCT FROM '36e38991a83968c97a8d69f5e7ee0549' THEN RAISE EXCEPTION 'HORSE_DEPENDENCY_SOURCE_CHANGED'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_lightning_pool_enter(p_seat_id uuid, p_now timestamp with time zone DEFAULT clock_timestamp())
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  s     record;
  g     record;
  v_ps  uuid;
  v_cps uuid;
  v_now timestamptz := LEAST(coalesce(p_now, clock_timestamp()), clock_timestamp());
BEGIN
  SELECT ts.id, ts.user_id, ts.table_id, ts.stack, tb.cluster_id
    INTO s
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE ts.id = p_seat_id;
  IF NOT FOUND OR s.cluster_id IS NULL OR s.user_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT cg.id, cg.cluster_mode, cg.lightning_enabled, cg.cluster_epoch
    INTO g FROM public.cash_games cg WHERE cg.id = s.cluster_id;
  IF NOT FOUND OR g.cluster_mode IS DISTINCT FROM 'lightning'
     OR coalesce(g.lightning_enabled, false) = false THEN
    RETURN NULL;
  END IF;

  IF NOT public.fn_lightning_anchor_is_live_eligible(s.id, g.id, s.user_id) THEN
    RETURN NULL;
  END IF;

  SELECT ps.id INTO v_ps
    FROM public.lightning_pool_session ps
   WHERE ps.cluster_id = g.id AND ps.player_id = s.user_id AND ps.exited_at IS NULL;
  IF v_ps IS NOT NULL THEN
    PERFORM public.fn_lightning_pool_slot_open(v_ps, v_now);
    RETURN v_ps;
  END IF;

  SELECT cps.id INTO v_cps
    FROM public.cash_player_session cps
   WHERE cps.player_id = s.user_id AND cps.closed_at IS NULL
     AND (cps.cluster_id = g.id
          OR cps.scope_id IN (SELECT t.id FROM public.tables t WHERE t.cluster_id = g.id)
          OR cps.table_id IN (SELECT t.id FROM public.tables t WHERE t.cluster_id = g.id))
   ORDER BY coalesce(cps.cluster_id = g.id, false) DESC, cps.opened_at DESC, cps.id
   LIMIT 1;
  IF v_cps IS NULL THEN
    RETURN NULL;
  END IF;

  BEGIN
    INSERT INTO public.lightning_pool_session
      (cluster_id, cluster_epoch, player_id, cash_player_session_id, state, entered_at,
       starting_stack, anchor_seat_id)
    VALUES (g.id, g.cluster_epoch, s.user_id, v_cps, 'active', v_now, s.stack, s.id)
    RETURNING id INTO v_ps;
  EXCEPTION WHEN unique_violation THEN
    SELECT ps.id INTO v_ps
      FROM public.lightning_pool_session ps
     WHERE ps.cluster_id = g.id AND ps.player_id = s.user_id AND ps.exited_at IS NULL;
    RETURN v_ps;
  END;

  INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload, cluster_epoch)
  VALUES (g.id, s.table_id, 'pool_player_joined', jsonb_build_object(
    'cluster_id', g.id, 'cluster_epoch', g.cluster_epoch, 'player_id', s.user_id,
    'pool_session_id', v_ps, 'anchor_seat_id', s.id, 'starting_stack', s.stack,
    'cash_player_session_id', v_cps, 'via', 'fn_lightning_pool_enter', 'at', v_now), g.cluster_epoch);

  PERFORM public.fn_lightning_pool_slot_open(v_ps, v_now);
  RETURN v_ps;
END
$function$;
ALTER FUNCTION public.fn_lightning_pool_enter(uuid,timestamp with time zone) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_lightning_pool_enter(uuid,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_lightning_pool_enter(uuid,timestamp with time zone) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_lightning_pool_enter(uuid,timestamp with time zone) TO service_role;
DO $$ BEGIN IF md5(pg_get_functiondef('public.fn_lightning_pool_enter(uuid,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '5a4547a38c09b1823a8f0d6e1d4ef13d' THEN RAISE EXCEPTION 'HORSE_DEPENDENCY_SOURCE_CHANGED'; END IF; END $$;
COMMIT;
