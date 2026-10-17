CREATE OR REPLACE FUNCTION public.fn_poker_diamond_plain_cash_table(p_t tables)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT NOT (
   NOT public.fn_poker_diamond_cash_variant(p_t.game_variant)
   OR p_t.tournament_id IS NOT NULL
   OR (p_t.cluster_id IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM public.cash_games g JOIN public.clubs c ON c.id=g.club_id
     WHERE g.id=p_t.cluster_id AND g.club_id=p_t.club_id
       AND c.asset='diamonds' AND c.is_platform AND c.union_id IS NULL
       AND g.union_id IS NULL AND p_t.union_id IS NULL AND g.must_move
       AND NOT g.lightning_enabled AND g.cluster_mode IN ('must_move','paused')
       AND g.variant=p_t.game_variant AND g.sb=p_t.small_blind AND g.bb=p_t.big_blind
       AND p_t.role IN ('main','feeder') AND p_t.lifecycle IN ('opening','live','breaking')
       AND (p_t.role='feeder' OR p_t.main_index>0)
   ))
   OR (p_t.cluster_id IS NULL AND p_t.lifecycle IS NOT NULL)
   OR coalesce(p_t.is_template,false)
   OR p_t.status NOT IN ('waiting','running','playing','active')
   OR p_t.rake_percent IS DISTINCT FROM 0 OR p_t.rake_cap_bb IS DISTINCT FROM 0
   OR p_t.bbj_percent IS DISTINCT FROM 0 OR coalesce(p_t.insurance_enabled,false)
   OR p_t.run_it_twice IS NULL OR p_t.allow_run_it_twice IS NULL
   OR coalesce(p_t.seven_deuce_enabled,false) OR coalesce(p_t.nit_game,false)
   OR coalesce(p_t.all_in_or_fold,false) OR coalesce(p_t.pineapple_holdem,false)
   OR coalesce(p_t.cap_enabled,false)
 );
$function$
