-- Reserved by scripts/reserve-migration-version.sh, 2026-10-23 23:00:01 UTC.
-- Owner: only Classic and Lightning Games at every stake. Lightning uses
-- 40% minimum VPIP and a BB ante. Six ready players deal immediately; five
-- wait three seconds from the fifth arrival. Fewer than five never deal.
-- Preserve existing wallets, seats, settled hands, schedules and all admission
-- and settlement checks. Legacy template identifiers remain historical aliases;
-- new Lightning games use the existing canonical madness identifier.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';

-- Transform only the observed installed images. Unknown source aborts the
-- transaction rather than overwriting a concurrent financial or player repair.
DO $source$
DECLARE r record; s text; n text;
BEGIN
 FOR r IN SELECT * FROM (VALUES
 ('public.fn_lightning_config(uuid)','6fd2d2b632d31779b73f42100a109bf6'),
 ('public.fn_lightning_match_plan(uuid,timestamptz,uuid[],text,integer,jsonb)','2e77ad138bb0c5a0941c1935e8594fe9'),
 ('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamptz,text,uuid,jsonb)','a09460981373d478685ae6619f61d5bd'),
 ('public.fn_lightning_instance_begin_dealing(uuid,interval,timestamptz)','7a8467f3866ce2738e37437c24db84dd'),
 ('public.fn_cash_template_defaults(text,text)','6bbccae845f2ff19733d980149ed8813'),
 ('public.fn_cash_game_create(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean)','3b7534611e37c83ac13bed7df2d626e3')
 ) x(sig,want) LOOP
  IF md5(pg_get_functiondef(r.sig::regprocedure)) IS DISTINCT FROM r.want THEN
   RAISE EXCEPTION 'Lightning source changed; requalify before installation: %',r.sig;
  END IF;
 END LOOP;

 s:=pg_get_functiondef('public.fn_lightning_config(uuid)'::regprocedure);
 n:=replace(replace(replace(s,
  '''instance_min'', v_min','''instance_min'', 5'),
  '''instance_target'', v_target','''instance_target'', 6'),
  '''instance_max'', v_max','''instance_max'', 6');
 IF n=s OR n LIKE '%''instance_min'', v_min%' OR n LIKE '%''instance_target'', v_target%' OR n LIKE '%''instance_max'', v_max%' THEN RAISE EXCEPTION 'Lightning config anchors changed'; END IF;
 EXECUTE n;

 s:=pg_get_functiondef('public.fn_lightning_match_plan(uuid,timestamptz,uuid[],text,integer,jsonb)'::regprocedure);
 -- Size potential remainders first; validate the actual selected fifth below.
 n:=replace(s,'(SELECT min((v_info -> q.pid::text ->> ''idle_since'')::timestamptz) FROM unnest(v_seatable) q(pid))', 'v_now - interval ''3 seconds''');
 n:=replace(n,'(SELECT min((v_info -> q.pid::text ->> ''idle_since'')::timestamptz) FROM unnest(v_next) q(pid))', 'v_now - interval ''3 seconds''');
 IF n=s OR n LIKE '%(SELECT min((v_info -> q.pid::text ->> ''idle_since'')::timestamptz)%' THEN RAISE EXCEPTION 'Lightning ready-time anchors changed'; END IF;
 n:=replace(n,'    v_size := cardinality(v_members);',$selected$
    v_size := cardinality(v_members);
    IF v_size = 5 AND (SELECT max((v_info -> m::text ->> 'idle_since')::timestamptz)
                       FROM unnest(v_members) m) > v_now - interval '3 seconds' THEN
      CONTINUE;
    END IF;$selected$);
 IF n NOT LIKE '%FROM unnest(v_members) m) > v_now - interval ''3 seconds''%' THEN RAISE EXCEPTION 'Lightning selected-group wait anchor changed'; END IF;
 EXECUTE n;

 s:=pg_get_functiondef('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamptz,text,uuid,jsonb)'::regprocedure);
 n:=replace(s,
  'v_target := coalesce(p_target_size, GREATEST(2, LEAST(6, coalesce(g.handedness, 6)))::smallint);',
  'v_target := GREATEST(5, LEAST(6, coalesce(p_target_size, 6)))::smallint;');
 n:=replace(n,
  'v_max    := coalesce(p_max_size, GREATEST(v_target, LEAST(9, coalesce(g.handedness, 6))::smallint));',
  'v_max := 6;');
 IF n=s OR n LIKE '%v_target := coalesce(p_target_size,%' OR n LIKE '%v_max    := coalesce(p_max_size,%' THEN RAISE EXCEPTION 'Lightning formation anchors changed'; END IF;
 n:=replace(n,'  IF v_n < v_target THEN',$wait$
  -- Direct formation callers obey the same wait as the matcher. The latest
  -- eligible arrival starts the three seconds; an old first arrival cannot
  -- prematurely release a newly ready fifth player.
  IF v_n = 5 AND v_target = 5 AND coalesce((
    SELECT max(sl.idle_since) FROM public.lightning_pool_slot sl
     WHERE sl.cluster_id=g.id AND sl.id IN (SELECT (x->>'pool_slot_id')::uuid FROM jsonb_array_elements(v_pool) x) AND sl.closed_at IS NULL
  ), coalesce(p_now,clock_timestamp())) > coalesce(p_now,clock_timestamp()) - interval '3 seconds' THEN
    RETURN jsonb_build_object('ok',false,'formed',false,'reason','WAITING_FOR_SIXTH_PLAYER');
  END IF;
  IF v_n < v_target THEN$wait$);
 IF n NOT LIKE '%WAITING_FOR_SIXTH_PLAYER%' THEN RAISE EXCEPTION 'Lightning wait anchor changed'; END IF;
 EXECUTE n;

 s:=pg_get_functiondef('public.fn_lightning_instance_begin_dealing(uuid,interval,timestamptz)'::regprocedure);
 n:=replace(s,'  IF v_players IS DISTINCT FROM h.player_count',$gate$
  IF h.player_count NOT BETWEEN 5 AND 6 OR v_players NOT BETWEEN 5 AND 6
     OR v_committed NOT BETWEEN 5 AND 6 THEN
    RETURN jsonb_build_object('ok',false,'dealing',false,'reason','FIVE_READY_PLAYERS_REQUIRED',
      'players',v_players,'committed_reservations',v_committed);
  END IF;
  IF v_players IS DISTINCT FROM h.player_count$gate$);
 IF n=s THEN RAISE EXCEPTION 'Lightning dealing gate anchor changed'; END IF;
 EXECUTE n;

 -- Preserve authentication, commerce admission and the original creator.
 s:=pg_get_functiondef('public.fn_cash_game_create(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean)'::regprocedure);
 n:=replace(s,'p_club_id, p_template, p_variant, p_sb, p_bb, p_handedness,',
  'p_club_id, CASE WHEN lower(p_template) IN (''action'',''madness'',''lightning'') THEN ''madness'' ELSE p_template END, p_variant, p_sb, p_bb, p_handedness,');
 n:=replace(n,'p_overrides, p_name, p_must_move',
  'p_overrides, CASE WHEN lower(p_template) IN (''action'',''madness'',''lightning'') THEN upper(p_variant)||'' ''||p_sb::text||''/''||p_bb::text||'' Lightning Games'' ELSE p_name END, p_must_move');
 IF n=s OR n NOT LIKE '%Lightning Games%' THEN RAISE EXCEPTION 'Lightning creator anchors changed'; END IF;
 EXECUTE n;
END $source$;

CREATE OR REPLACE FUNCTION public.fn_lightning_formation_sizes(
 p_legal integer,p_min integer,p_target integer,p_max integer,
 p_oldest_idle timestamptz,p_now timestamptz
) RETURNS integer[] LANGUAGE plpgsql IMMUTABLE
SET search_path TO public,pg_temp AS $sizes$
DECLARE n integer:=GREATEST(coalesce(p_legal,0),0); result integer[];
BEGIN
 result:=ARRAY(SELECT 6 FROM generate_series(1,n/6));
 -- Direct sizing callers supply the fifth-ready time. The matcher asks for
 -- potential groups and enforces the deadline on their actual selected members.
 IF n%6=5 AND p_oldest_idle IS NOT NULL AND p_now-p_oldest_idle>=interval '3 seconds' THEN
  result:=array_append(result,5);
 END IF;
 RETURN result;
END $sizes$;

CREATE OR REPLACE FUNCTION public.fn_cash_template_defaults(p_template text,p_variant text)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path TO public,pg_temp AS $defaults$
DECLARE t text:=lower(coalesce(p_template,'classic')); v text:=lower(coalesce(p_variant,'nlh')); family text; seats int;
BEGIN
 IF t IN ('action','madness','lightning') THEN t:='madness'; END IF;
 IF t NOT IN ('classic','madness') THEN RAISE EXCEPTION 'TEMPLATE_UNKNOWN: %',p_template; END IF;
 family:=CASE WHEN v IN ('plo4','plo5','plo6','plo8','flo8') THEN 'plo' WHEN v='short_deck' THEN 'shortdeck' WHEN v='pineapple' THEN 'pineapple' ELSE 'holdem' END;
 seats:=CASE WHEN t='classic' AND family='holdem' THEN 9 ELSE 6 END;
 RETURN jsonb_build_object('template',t,'variant',v,'family',family,'seats',seats,
  'seats_locked',t='madness' OR family='plo',
  'seat_choices',CASE WHEN t='madness' OR family='plo' THEN '[6]'::jsonb WHEN family='holdem' THEN '[9,6]'::jsonb ELSE '[2,3,4,5,6,7,8]'::jsonb END,
  'min_buyin_bb',CASE WHEN t='classic' THEN 40 ELSE 100 END,'max_buyin_bb',200,
  'regular_ante',CASE WHEN t='classic' THEN 'none' ELSE 'bb' END,
  'vpip_floor',CASE WHEN t='classic' THEN 0 ELSE 40 END,'vpip_window',10,
  'bombs',jsonb_build_object('enabled',t<>'classic','trigger',CASE WHEN t='classic' THEN NULL ELSE 'timed_10m' END,'ante_bb',CASE WHEN t='classic' THEN NULL ELSE 3 END,'boards',CASE WHEN t='classic' THEN NULL ELSE 2 END),
  'straddle',false,'stay_clock_min',10,'rejoin_window_min',120,'run_it_n_times','opt_in','rake','existing');
END $defaults$;

-- Rules are configuration, loaded at the normal hand boundary. Keep each
-- existing game's buy-in and bomb settings, and preserve historical records.
UPDATE public.cash_games cg
 SET ruleset_snapshot=jsonb_set(jsonb_set(coalesce(cg.ruleset_snapshot,'{}'::jsonb),'{regular_ante}','"bb"'::jsonb),'{vpip_floor}','40'::jsonb),
     name=upper(cg.variant)||' '||cg.sb::text||'/'||cg.bb::text||' Lightning Games',updated_at=now()
 WHERE cg.template_name IN ('action','madness') AND cg.closed_at IS NULL;
DO $rules$ DECLARE r record; BEGIN
 FOR r IN SELECT id FROM public.cash_games WHERE template_name IN ('action','madness') AND closed_at IS NULL LOOP
  PERFORM public.fn_cash_apply_ruleset(r.id);
 END LOOP;
END $rules$;
COMMIT;
