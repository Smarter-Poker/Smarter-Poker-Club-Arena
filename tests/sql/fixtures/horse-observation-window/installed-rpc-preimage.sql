-- Read-only installed RPC definitions, captured 2026-09-30 from configured Supabase project.
CREATE OR REPLACE FUNCTION public.upsert_horse_mind_stats(rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  n integer := 0;
  r jsonb;
BEGIN
  IF rows IS NULL OR jsonb_typeof(rows) <> 'array' THEN
    RETURN 0;
  END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(rows) LOOP
    CONTINUE WHEN r->>'user_id' IS NULL OR length(r->>'user_id') = 0 OR length(r->>'user_id') > 128;
    INSERT INTO public.horse_mind_stats AS t
      (user_id, hands, vpip, pfr, three_bet, aggr, passive, folds, faced_aggr,
       cbet_opps, cbet_folds, f3b_opps, f3b_folds, bigbet_sd, bigbet_sd_strong,
       post_aggr, post_passive, river_bet_opps, river_bet_folds, checks,
       snap_bet_sd, snap_bet_sd_strong, tank_bet_sd, tank_bet_sd_strong,
       r_hands, r_folds, r_faced_aggr, r_aggr, r_passive, r_checks, updated_at)
    VALUES
      (r->>'user_id',
       COALESCE((r->>'hands')::integer, 0),
       COALESCE((r->>'vpip')::integer, 0),
       COALESCE((r->>'pfr')::integer, 0),
       COALESCE((r->>'three_bet')::integer, 0),
       COALESCE((r->>'aggr')::integer, 0),
       COALESCE((r->>'passive')::integer, 0),
       COALESCE((r->>'folds')::integer, 0),
       COALESCE((r->>'faced_aggr')::integer, 0),
       COALESCE((r->>'cbet_opps')::integer, 0),
       COALESCE((r->>'cbet_folds')::integer, 0),
       COALESCE((r->>'f3b_opps')::integer, 0),
       COALESCE((r->>'f3b_folds')::integer, 0),
       COALESCE((r->>'bigbet_sd')::integer, 0),
       COALESCE((r->>'bigbet_sd_strong')::integer, 0),
       COALESCE((r->>'post_aggr')::integer, 0),
       COALESCE((r->>'post_passive')::integer, 0),
       COALESCE((r->>'river_bet_opps')::integer, 0),
       COALESCE((r->>'river_bet_folds')::integer, 0),
       COALESCE((r->>'checks')::integer, 0),
       COALESCE((r->>'snap_bet_sd')::integer, 0),
       COALESCE((r->>'snap_bet_sd_strong')::integer, 0),
       COALESCE((r->>'tank_bet_sd')::integer, 0),
       COALESCE((r->>'tank_bet_sd_strong')::integer, 0),
       COALESCE((r->>'r_hands')::real, 0),
       COALESCE((r->>'r_folds')::real, 0),
       COALESCE((r->>'r_faced_aggr')::real, 0),
       COALESCE((r->>'r_aggr')::real, 0),
       COALESCE((r->>'r_passive')::real, 0),
       COALESCE((r->>'r_checks')::real, 0),
       now())
    ON CONFLICT (user_id) DO UPDATE SET
      hands            = GREATEST(t.hands, EXCLUDED.hands),
      vpip             = GREATEST(t.vpip, EXCLUDED.vpip),
      pfr              = GREATEST(t.pfr, EXCLUDED.pfr),
      three_bet        = GREATEST(t.three_bet, EXCLUDED.three_bet),
      aggr             = GREATEST(t.aggr, EXCLUDED.aggr),
      passive          = GREATEST(t.passive, EXCLUDED.passive),
      folds            = GREATEST(t.folds, EXCLUDED.folds),
      faced_aggr       = GREATEST(t.faced_aggr, EXCLUDED.faced_aggr),
      cbet_opps        = GREATEST(t.cbet_opps, EXCLUDED.cbet_opps),
      cbet_folds       = GREATEST(t.cbet_folds, EXCLUDED.cbet_folds),
      f3b_opps         = GREATEST(t.f3b_opps, EXCLUDED.f3b_opps),
      f3b_folds        = GREATEST(t.f3b_folds, EXCLUDED.f3b_folds),
      bigbet_sd        = GREATEST(t.bigbet_sd, EXCLUDED.bigbet_sd),
      bigbet_sd_strong = GREATEST(t.bigbet_sd_strong, EXCLUDED.bigbet_sd_strong),
      post_aggr        = GREATEST(t.post_aggr, EXCLUDED.post_aggr),
      post_passive     = GREATEST(t.post_passive, EXCLUDED.post_passive),
      river_bet_opps   = GREATEST(t.river_bet_opps, EXCLUDED.river_bet_opps),
      river_bet_folds  = GREATEST(t.river_bet_folds, EXCLUDED.river_bet_folds),
      checks           = GREATEST(t.checks, EXCLUDED.checks),
      snap_bet_sd        = GREATEST(t.snap_bet_sd, EXCLUDED.snap_bet_sd),
      snap_bet_sd_strong = GREATEST(t.snap_bet_sd_strong, EXCLUDED.snap_bet_sd_strong),
      tank_bet_sd        = GREATEST(t.tank_bet_sd, EXCLUDED.tank_bet_sd),
      tank_bet_sd_strong = GREATEST(t.tank_bet_sd_strong, EXCLUDED.tank_bet_sd_strong),
      r_hands      = EXCLUDED.r_hands,
      r_folds      = EXCLUDED.r_folds,
      r_faced_aggr = EXCLUDED.r_faced_aggr,
      r_aggr       = EXCLUDED.r_aggr,
      r_passive    = EXCLUDED.r_passive,
      r_checks     = EXCLUDED.r_checks,
      updated_at   = now();
    n := n + 1;
  END LOOP;
  RETURN n;
END
$function$
;

CREATE OR REPLACE FUNCTION public.upsert_horse_mind_stats_scoped(rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare n integer := 0; r jsonb;
begin
  if rows is null or jsonb_typeof(rows) <> 'array' then return 0; end if;
  for r in select * from jsonb_array_elements(rows) loop
    continue when r->>'user_id' is null or length(r->>'user_id') = 0 or length(r->>'user_id') > 128;
    continue when r->>'scope' is null or (r->>'scope') !~ '^(holdem|omaha|sixplus):(hu|short|full)$';
    insert into public.horse_mind_stats_scoped as t
      (user_id, scope, hands, vpip, pfr, three_bet, aggr, passive, folds, faced_aggr,
       cbet_opps, cbet_folds, f3b_opps, f3b_folds, bigbet_sd, bigbet_sd_strong,
       river_bet_opps, river_bet_folds, checks, post_aggr, post_passive,
       snap_bet_sd, snap_bet_sd_strong, tank_bet_sd, tank_bet_sd_strong, updated_at)
    values
      (r->>'user_id', r->>'scope',
       coalesce((r->>'hands')::integer, 0),
       coalesce((r->>'vpip')::integer, 0),
       coalesce((r->>'pfr')::integer, 0),
       coalesce((r->>'three_bet')::integer, 0),
       coalesce((r->>'aggr')::integer, 0),
       coalesce((r->>'passive')::integer, 0),
       coalesce((r->>'folds')::integer, 0),
       coalesce((r->>'faced_aggr')::integer, 0),
       coalesce((r->>'cbet_opps')::integer, 0),
       coalesce((r->>'cbet_folds')::integer, 0),
       coalesce((r->>'f3b_opps')::integer, 0),
       coalesce((r->>'f3b_folds')::integer, 0),
       coalesce((r->>'bigbet_sd')::integer, 0),
       coalesce((r->>'bigbet_sd_strong')::integer, 0),
       coalesce((r->>'river_bet_opps')::integer, 0),
       coalesce((r->>'river_bet_folds')::integer, 0),
       coalesce((r->>'checks')::integer, 0),
       coalesce((r->>'post_aggr')::integer, 0),
       coalesce((r->>'post_passive')::integer, 0),
       coalesce((r->>'snap_bet_sd')::integer, 0),
       coalesce((r->>'snap_bet_sd_strong')::integer, 0),
       coalesce((r->>'tank_bet_sd')::integer, 0),
       coalesce((r->>'tank_bet_sd_strong')::integer, 0),
       now())
    on conflict (user_id, scope) do update set
      hands = greatest(t.hands, excluded.hands),
      vpip = greatest(t.vpip, excluded.vpip),
      pfr = greatest(t.pfr, excluded.pfr),
      three_bet = greatest(t.three_bet, excluded.three_bet),
      aggr = greatest(t.aggr, excluded.aggr),
      passive = greatest(t.passive, excluded.passive),
      folds = greatest(t.folds, excluded.folds),
      faced_aggr = greatest(t.faced_aggr, excluded.faced_aggr),
      cbet_opps = greatest(t.cbet_opps, excluded.cbet_opps),
      cbet_folds = greatest(t.cbet_folds, excluded.cbet_folds),
      f3b_opps = greatest(t.f3b_opps, excluded.f3b_opps),
      f3b_folds = greatest(t.f3b_folds, excluded.f3b_folds),
      bigbet_sd = greatest(t.bigbet_sd, excluded.bigbet_sd),
      bigbet_sd_strong = greatest(t.bigbet_sd_strong, excluded.bigbet_sd_strong),
      river_bet_opps = greatest(t.river_bet_opps, excluded.river_bet_opps),
      river_bet_folds = greatest(t.river_bet_folds, excluded.river_bet_folds),
      checks = greatest(t.checks, excluded.checks),
      post_aggr = greatest(t.post_aggr, excluded.post_aggr),
      post_passive = greatest(t.post_passive, excluded.post_passive),
      snap_bet_sd = greatest(t.snap_bet_sd, excluded.snap_bet_sd),
      snap_bet_sd_strong = greatest(t.snap_bet_sd_strong, excluded.snap_bet_sd_strong),
      tank_bet_sd = greatest(t.tank_bet_sd, excluded.tank_bet_sd),
      tank_bet_sd_strong = greatest(t.tank_bet_sd_strong, excluded.tank_bet_sd_strong),
      updated_at = now();
    n := n + 1;
  end loop;
  return n;
end $function$
;
