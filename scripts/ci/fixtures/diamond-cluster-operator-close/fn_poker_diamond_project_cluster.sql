CREATE OR REPLACE FUNCTION public.fn_poker_diamond_project_cluster(p_game_id uuid, p_table_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE g public.cash_games%ROWTYPE; cfg public.tables%ROWTYPE; n integer;
BEGIN
 SELECT cg.* INTO g FROM public.cash_games cg JOIN public.clubs c ON c.id=cg.club_id
 WHERE cg.id=p_game_id AND c.asset='diamonds' AND c.is_platform
   AND c.union_id IS NULL AND cg.union_id IS NULL AND cg.must_move
   AND NOT cg.lightning_enabled AND cg.cluster_mode IN ('must_move','paused') FOR UPDATE OF cg;
 IF NOT FOUND THEN RAISE EXCEPTION 'diamond_cluster_scope_required' USING ERRCODE='23514'; END IF;
 IF jsonb_typeof(g.ruleset_snapshot->'diamond_table') IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'diamond_cluster_projection_required' USING ERRCODE='23514';
 END IF;
 cfg:=jsonb_populate_record(NULL::public.tables,g.ruleset_snapshot->'diamond_table');
 IF cfg.min_buy_in IS NULL OR cfg.max_buy_in IS NULL
   OR cfg.min_buy_in<g.bb OR cfg.max_buy_in<cfg.min_buy_in
   OR cfg.min_buy_in<>trunc(cfg.min_buy_in) OR cfg.max_buy_in<>trunc(cfg.max_buy_in)
   OR cfg.max_buy_in>2147483647 OR g.sb<>trunc(g.sb) OR g.bb<>trunc(g.bb)
   OR g.sb<=0 OR g.bb<g.sb OR g.handedness NOT BETWEEN 2 AND 9
   OR cfg.rake_percent IS DISTINCT FROM 0 OR cfg.rake_cap_bb IS DISTINCT FROM 0
   OR cfg.bbj_percent IS DISTINCT FROM 0 OR cfg.run_it_twice IS NULL
   OR cfg.allow_run_it_twice IS NULL OR coalesce(cfg.insurance_enabled,false)
   OR coalesce(cfg.seven_deuce_enabled,false) OR coalesce(cfg.nit_game,false)
   OR coalesce(cfg.all_in_or_fold,false) OR coalesce(cfg.pineapple_holdem,false)
   OR coalesce(cfg.cap_enabled,false)
   OR NOT public.fn_poker_diamond_cash_variant(g.variant)
   OR coalesce(cfg.ante,0)<0 OR coalesce(cfg.ante,0)<>trunc(coalesce(cfg.ante,0))
   OR (coalesce(cfg.bomb_pot_enabled,false) AND (
      lower(coalesce(cfg.bomb_pot_variant,'')) NOT IN ('',g.variant)
      OR coalesce(cfg.bomb_pot_ante_fixed,g.bb*coalesce(cfg.bomb_pot_ante_multiplier,2))<=0
      OR coalesce(cfg.bomb_pot_ante_fixed,g.bb*coalesce(cfg.bomb_pot_ante_multiplier,2))<>
         trunc(coalesce(cfg.bomb_pot_ante_fixed,g.bb*coalesce(cfg.bomb_pot_ante_multiplier,2)))
   )) THEN
  RAISE EXCEPTION 'diamond_cluster_projection_invalid' USING ERRCODE='23514';
 END IF;
 UPDATE public.tables t SET
  small_blind=g.sb,big_blind=g.bb,game_variant=g.variant,
  min_buy_in=cfg.min_buy_in,max_buy_in=cfg.max_buy_in,
  max_players=greatest(g.handedness,coalesce((SELECT max(s.seat_number)
    FROM public.table_seats s WHERE s.table_id=t.id AND s.left_at IS NULL),0)),
  rake_percent=0,rake_cap_bb=0,bbj_percent=0,
  insurance_enabled=false,seven_deuce_enabled=false,nit_game=false,
  all_in_or_fold=false,pineapple_holdem=false,cap_enabled=false,
  run_it_twice=cfg.run_it_twice,allow_run_it_twice=cfg.allow_run_it_twice,
  run_it_twice_enabled=coalesce(cfg.run_it_twice_enabled,false),run_it_mode=cfg.run_it_mode,
  straddle_enabled=coalesce(cfg.straddle_enabled,false),
  auto_utg_straddle=coalesce(cfg.auto_utg_straddle,false),voluntary_straddle=coalesce(cfg.voluntary_straddle,false),
  ante=coalesce(cfg.ante,0),ante_enabled=coalesce(cfg.ante_enabled,false),
  big_blind_ante_enabled=coalesce(cfg.big_blind_ante_enabled,false),
  bomb_pot_enabled=coalesce(cfg.bomb_pot_enabled,false),bomb_pot_variant=cfg.bomb_pot_variant,
  bomb_pot_ante_fixed=cfg.bomb_pot_ante_fixed,bomb_pot_ante_multiplier=cfg.bomb_pot_ante_multiplier,
  bomb_pot_board_count=cfg.bomb_pot_board_count,bomb_pot_double_board=cfg.bomb_pot_double_board,
  bomb_pot_trigger_mode=cfg.bomb_pot_trigger_mode,bomb_pot_frequency=cfg.bomb_pot_frequency,
  bomb_pot_interval_seconds=cfg.bomb_pot_interval_seconds,
  action_time_seconds=coalesce(cfg.action_time_seconds,15),
  auto_extension=false,auto_restart=false,auto_create_table=false
 WHERE t.cluster_id=g.id AND t.lifecycle<>'closed' AND NOT coalesce(t.is_deleted,false)
   AND (p_table_id IS NULL OR t.id=p_table_id)
   AND (t.small_blind IS DISTINCT FROM g.sb OR t.big_blind IS DISTINCT FROM g.bb
     OR t.game_variant IS DISTINCT FROM g.variant
     OR t.max_players IS DISTINCT FROM greatest(g.handedness,coalesce((SELECT max(s.seat_number)
       FROM public.table_seats s WHERE s.table_id=t.id AND s.left_at IS NULL),0))
     OR EXISTS(SELECT 1 FROM jsonb_each(g.ruleset_snapshot->'diamond_table') setting
       WHERE to_jsonb(t)->setting.key IS DISTINCT FROM setting.value));
 GET DIAGNOSTICS n=ROW_COUNT;
 IF EXISTS(SELECT 1 FROM public.tables t WHERE t.cluster_id=g.id
   AND t.lifecycle<>'closed' AND NOT coalesce(t.is_deleted,false)
   AND NOT public.fn_poker_diamond_plain_cash_table(t)) THEN
  RAISE EXCEPTION 'diamond_cluster_table_not_admitted' USING ERRCODE='23514';
 END IF;
 RETURN n;
END;
$function$
