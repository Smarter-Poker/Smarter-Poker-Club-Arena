-- 20261003140344_stats_cash_opportunity_facts
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-03 14:03:44 UTC.
--
-- CASH-01/02/04 previously tried to infer opportunity denominators from
-- aggregate action counts. That cannot distinguish "did not take it" from
-- "was never offered it", and historical hand_history is intentionally
-- pruned. Preserve the engine's settlement-time truth on ca_hand_facts.
-- New columns are nullable: NULL means the accepted-hand envelope predates
-- this contract or lacked authoritative order/stack context. Readers must not
-- turn NULL into a measured zero.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE public.ca_hand_facts
  ADD COLUMN IF NOT EXISTS effective_stack_bb_at_deal numeric,
  ADD COLUMN IF NOT EXISTS hero_in_position boolean,
  ADD COLUMN IF NOT EXISTS aggressive_actions_preflop smallint,
  ADD COLUMN IF NOT EXISTS passive_actions_preflop smallint,
  ADD COLUMN IF NOT EXISTS aggressive_actions_flop smallint,
  ADD COLUMN IF NOT EXISTS passive_actions_flop smallint,
  ADD COLUMN IF NOT EXISTS aggressive_actions_turn smallint,
  ADD COLUMN IF NOT EXISTS passive_actions_turn smallint,
  ADD COLUMN IF NOT EXISTS aggressive_actions_river smallint,
  ADD COLUMN IF NOT EXISTS passive_actions_river smallint,
  ADD COLUMN IF NOT EXISTS three_bet_opportunity boolean,
  ADD COLUMN IF NOT EXISTS four_bet_opportunity boolean,
  ADD COLUMN IF NOT EXISTS steal_opportunity boolean,
  ADD COLUMN IF NOT EXISTS stole boolean,
  ADD COLUMN IF NOT EXISTS squeeze_opportunity boolean,
  ADD COLUMN IF NOT EXISTS squeezed boolean,
  ADD COLUMN IF NOT EXISTS blind_defense_opportunity boolean,
  ADD COLUMN IF NOT EXISTS defended_blind boolean,
  ADD COLUMN IF NOT EXISTS cbet_flop_opportunity boolean,
  ADD COLUMN IF NOT EXISTS barrel_turn_opportunity boolean,
  ADD COLUMN IF NOT EXISTS barreled_turn boolean,
  ADD COLUMN IF NOT EXISTS barrel_river_opportunity boolean,
  ADD COLUMN IF NOT EXISTS barreled_river boolean,
  ADD COLUMN IF NOT EXISTS check_raise_opportunity boolean,
  ADD COLUMN IF NOT EXISTS check_raised boolean,
  ADD COLUMN IF NOT EXISTS donk_opportunity boolean,
  ADD COLUMN IF NOT EXISTS donk_bet boolean,
  ADD COLUMN IF NOT EXISTS probe_opportunity boolean,
  ADD COLUMN IF NOT EXISTS probe_bet boolean;

COMMENT ON COLUMN public.ca_hand_facts.effective_stack_bb_at_deal IS
  'min(hero deal stack, deepest dealt opponent deal stack) / big blind; NULL when the immutable deal-stack context is unavailable.';
COMMENT ON COLUMN public.ca_hand_facts.three_bet_opportunity IS
  'Engine-derived opportunity denominator. NULL is unavailable, false is an observed hand without an opportunity.';

-- The durable projector uses an explicit allow-list. Extend it only after the
-- columns exist; source-hash conflict comparison already covers every column.
DO $patch_fact_projector$
DECLARE
  v_oid oid := 'public.ca_project_hand_stats_facts(uuid)'::regprocedure;
  v_def text := pg_get_functiondef(v_oid);
  v_old_cols text := 'won_at_showdown,aggressive_actions,passive_actions,was_all_in,all_in_street,';
  v_new_cols text := 'won_at_showdown,aggressive_actions,passive_actions,' ||
    'effective_stack_bb_at_deal,hero_in_position,' ||
    'aggressive_actions_preflop,passive_actions_preflop,aggressive_actions_flop,passive_actions_flop,' ||
    'aggressive_actions_turn,passive_actions_turn,aggressive_actions_river,passive_actions_river,' ||
    'three_bet_opportunity,four_bet_opportunity,steal_opportunity,stole,' ||
    'squeeze_opportunity,squeezed,blind_defense_opportunity,defended_blind,' ||
    'cbet_flop_opportunity,barrel_turn_opportunity,barreled_turn,' ||
    'barrel_river_opportunity,barreled_river,check_raise_opportunity,check_raised,' ||
    'donk_opportunity,donk_bet,probe_opportunity,probe_bet,was_all_in,all_in_street,';
  v_old_vals text := 'f.won_at_showdown,f.aggressive_actions,f.passive_actions,f.was_all_in,';
  v_new_vals text := 'f.won_at_showdown,f.aggressive_actions,f.passive_actions,' ||
    'f.effective_stack_bb_at_deal,f.hero_in_position,' ||
    'f.aggressive_actions_preflop,f.passive_actions_preflop,f.aggressive_actions_flop,f.passive_actions_flop,' ||
    'f.aggressive_actions_turn,f.passive_actions_turn,f.aggressive_actions_river,f.passive_actions_river,' ||
    'f.three_bet_opportunity,f.four_bet_opportunity,f.steal_opportunity,f.stole,' ||
    'f.squeeze_opportunity,f.squeezed,f.blind_defense_opportunity,f.defended_blind,' ||
    'f.cbet_flop_opportunity,f.barrel_turn_opportunity,f.barreled_turn,' ||
    'f.barrel_river_opportunity,f.barreled_river,f.check_raise_opportunity,f.check_raised,' ||
    'f.donk_opportunity,f.donk_bet,f.probe_opportunity,f.probe_bet,f.was_all_in,';
BEGIN
  IF position(v_old_cols IN v_def)=0 OR position(v_old_vals IN v_def)=0 THEN
    RAISE EXCEPTION 'cash opportunity migration refused: fact projector shape drifted';
  END IF;
  v_def := replace(replace(v_def,v_old_cols,v_new_cols),v_old_vals,v_new_vals);
  v_def := replace(v_def,
    $$v_stats->>'version' IS DISTINCT FROM '1'$$,
    $$coalesce(v_stats->>'version','') NOT IN ('1','2')$$);
  v_def := replace(v_def,
    'source_hash=EXCLUDED.source_hash',
    'source_hash=EXCLUDED.source_hash,' ||
    'effective_stack_bb_at_deal=EXCLUDED.effective_stack_bb_at_deal,' ||
    'hero_in_position=EXCLUDED.hero_in_position,' ||
    'aggressive_actions_preflop=EXCLUDED.aggressive_actions_preflop,' ||
    'passive_actions_preflop=EXCLUDED.passive_actions_preflop,' ||
    'aggressive_actions_flop=EXCLUDED.aggressive_actions_flop,' ||
    'passive_actions_flop=EXCLUDED.passive_actions_flop,' ||
    'aggressive_actions_turn=EXCLUDED.aggressive_actions_turn,' ||
    'passive_actions_turn=EXCLUDED.passive_actions_turn,' ||
    'aggressive_actions_river=EXCLUDED.aggressive_actions_river,' ||
    'passive_actions_river=EXCLUDED.passive_actions_river,' ||
    'three_bet_opportunity=EXCLUDED.three_bet_opportunity,' ||
    'four_bet_opportunity=EXCLUDED.four_bet_opportunity,' ||
    'steal_opportunity=EXCLUDED.steal_opportunity,stole=EXCLUDED.stole,' ||
    'squeeze_opportunity=EXCLUDED.squeeze_opportunity,squeezed=EXCLUDED.squeezed,' ||
    'blind_defense_opportunity=EXCLUDED.blind_defense_opportunity,' ||
    'defended_blind=EXCLUDED.defended_blind,cbet_flop_opportunity=EXCLUDED.cbet_flop_opportunity,' ||
    'barrel_turn_opportunity=EXCLUDED.barrel_turn_opportunity,barreled_turn=EXCLUDED.barreled_turn,' ||
    'barrel_river_opportunity=EXCLUDED.barrel_river_opportunity,barreled_river=EXCLUDED.barreled_river,' ||
    'check_raise_opportunity=EXCLUDED.check_raise_opportunity,check_raised=EXCLUDED.check_raised,' ||
    'donk_opportunity=EXCLUDED.donk_opportunity,donk_bet=EXCLUDED.donk_bet,' ||
    'probe_opportunity=EXCLUDED.probe_opportunity,probe_bet=EXCLUDED.probe_bet');
  EXECUTE v_def;
END
$patch_fact_projector$;

CREATE INDEX IF NOT EXISTS idx_ca_hand_facts_user_cash_opportunities
  ON public.ca_hand_facts(user_id, played_at DESC, club_id)
  WHERE tournament_id IS NULL AND three_bet_opportunity IS NOT NULL;

CREATE OR REPLACE FUNCTION public.ca_player_cash_opportunity_stats(
  p_user uuid,
  p_days integer DEFAULT 30,
  p_tz text DEFAULT 'UTC',
  p_asset text DEFAULT 'chips',
  p_club uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp
AS $function$
DECLARE
  v_days integer := CASE WHEN p_days IS NULL THEN NULL ELSE least(greatest(p_days,1),3650) END;
  v_from timestamptz;
  v_to timestamptz;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL OR p_user IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'stats access refused' USING ERRCODE='42501';
  END IF;
  IF p_asset NOT IN ('chips','diamonds') THEN RAISE EXCEPTION 'invalid asset'; END IF;
  IF p_club IS NOT NULL THEN
    PERFORM public.ca_assert_player_stats_club(p_user,p_club,p_asset);
  END IF;
  SELECT b.from_at,b.to_at INTO v_from,v_to
    FROM public.ca_stats_calendar_bounds(v_days,p_tz,now()) b;
  SELECT jsonb_build_object(
    'contract_version',2,'coverage',jsonb_build_object(
      'source','ca_hand_facts','from',v_from,'club_id',p_club,
      'exact_hands',count(*) FILTER (WHERE three_bet_opportunity IS NOT NULL),
      'unavailable_hands',count(*) FILTER (WHERE three_bet_opportunity IS NULL)),
    'opportunities',jsonb_build_object(
      'three_bet',jsonb_build_object('opportunities',count(*) FILTER(WHERE three_bet_opportunity),'actions',count(*) FILTER(WHERE three_bet_opportunity AND three_bet)),
      'four_bet',jsonb_build_object('opportunities',count(*) FILTER(WHERE four_bet_opportunity),'actions',count(*) FILTER(WHERE four_bet_opportunity AND four_bet)),
      'steal',jsonb_build_object('opportunities',count(*) FILTER(WHERE steal_opportunity),'actions',count(*) FILTER(WHERE steal_opportunity AND stole)),
      'squeeze',jsonb_build_object('opportunities',count(*) FILTER(WHERE squeeze_opportunity),'actions',count(*) FILTER(WHERE squeeze_opportunity AND squeezed)),
      'blind_defense',jsonb_build_object('opportunities',count(*) FILTER(WHERE blind_defense_opportunity),'actions',count(*) FILTER(WHERE blind_defense_opportunity AND defended_blind)),
      'cbet_flop',jsonb_build_object('opportunities',count(*) FILTER(WHERE cbet_flop_opportunity),'actions',count(*) FILTER(WHERE cbet_flop_opportunity AND cbet_flop)),
      'barrel_turn',jsonb_build_object('opportunities',count(*) FILTER(WHERE barrel_turn_opportunity),'actions',count(*) FILTER(WHERE barrel_turn_opportunity AND barreled_turn)),
      'barrel_river',jsonb_build_object('opportunities',count(*) FILTER(WHERE barrel_river_opportunity),'actions',count(*) FILTER(WHERE barrel_river_opportunity AND barreled_river)),
      'check_raise',jsonb_build_object('opportunities',count(*) FILTER(WHERE check_raise_opportunity),'actions',count(*) FILTER(WHERE check_raise_opportunity AND check_raised)),
      'donk',jsonb_build_object('opportunities',count(*) FILTER(WHERE donk_opportunity),'actions',count(*) FILTER(WHERE donk_opportunity AND donk_bet)),
      'probe',jsonb_build_object('opportunities',count(*) FILTER(WHERE probe_opportunity),'actions',count(*) FILTER(WHERE probe_opportunity AND probe_bet))),
    'actions_by_street',jsonb_build_object(
      'preflop',jsonb_build_object('aggressive',coalesce(sum(aggressive_actions_preflop),0),'passive',coalesce(sum(passive_actions_preflop),0)),
      'flop',jsonb_build_object('aggressive',coalesce(sum(aggressive_actions_flop),0),'passive',coalesce(sum(passive_actions_flop),0)),
      'turn',jsonb_build_object('aggressive',coalesce(sum(aggressive_actions_turn),0),'passive',coalesce(sum(passive_actions_turn),0)),
      'river',jsonb_build_object('aggressive',coalesce(sum(aggressive_actions_river),0),'passive',coalesce(sum(passive_actions_river),0))),
    'context',jsonb_build_object(
      'in_position_hands',count(*) FILTER(WHERE hero_in_position),
      'position_measured_hands',count(hero_in_position),
      'average_effective_stack_bb',avg(effective_stack_bb_at_deal)))
  INTO v_result
  FROM public.ca_hand_facts f
  LEFT JOIN public.clubs c ON c.id=f.club_id
  WHERE f.user_id=p_user
    AND (v_from IS NULL OR f.played_at>=v_from)
    AND (v_to IS NULL OR f.played_at<v_to)
    AND f.tournament_id IS NULL
    AND (p_club IS NULL OR f.club_id=p_club)
    AND coalesce(c.lifecycle_status,'active')<>'retired'
    AND coalesce(c.asset,'chips')=p_asset;
  RETURN v_result;
END
$function$;

REVOKE ALL ON FUNCTION public.ca_player_cash_opportunity_stats(uuid,integer,text,text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ca_player_cash_opportunity_stats(uuid,integer,text,text,uuid) TO authenticated,service_role;

-- Cash-rate evidence must be selected from the exact opportunity population
-- before keyset pagination. Replacing the Phase 3 signature here is deliberate:
-- these nullable opportunity columns do not exist until this migration.
DROP FUNCTION IF EXISTS public.ca_player_stats_hand_evidence(
  uuid,uuid,text,text,text,numeric,timestamptz,timestamptz,text,boolean,boolean,
  boolean,boolean,text,boolean,timestamptz,uuid,integer
);

CREATE OR REPLACE FUNCTION public.ca_player_stats_hand_evidence(
  p_user uuid,
  p_club_id uuid DEFAULT NULL,
  p_asset text DEFAULT 'chips',
  p_variant text DEFAULT NULL,
  p_position text DEFAULT NULL,
  p_big_blind numeric DEFAULT NULL,
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_outcome text DEFAULT NULL,
  p_showdown boolean DEFAULT NULL,
  p_all_in boolean DEFAULT NULL,
  p_big_pots boolean DEFAULT NULL,
  p_noted boolean DEFAULT NULL,
  p_hand_class text DEFAULT NULL,
  p_tournament boolean DEFAULT NULL,
  p_cash_metric text DEFAULT NULL,
  p_cursor_played_at timestamptz DEFAULT NULL,
  p_cursor_hand_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 25
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit,25),1),100);
  v_variant text := lower(nullif(btrim(p_variant),''));
  v_position text := upper(nullif(btrim(p_position),''));
  v_outcome text := lower(nullif(btrim(p_outcome),''));
  v_cash_metric text := lower(nullif(btrim(p_cash_metric),''));
BEGIN
  IF auth.uid() IS NULL OR p_user IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'stats access refused' USING ERRCODE='42501';
  END IF;
  IF p_asset IS NULL OR p_asset NOT IN ('chips','diamonds') THEN
    RAISE EXCEPTION 'unknown stats asset: %',p_asset USING ERRCODE='22023';
  END IF;
  IF p_club_id IS NOT NULL THEN
    PERFORM public.ca_assert_player_stats_club(p_user,p_club_id,p_asset);
  END IF;
  IF v_outcome IS NOT NULL AND v_outcome NOT IN ('won','lost') THEN
    RAISE EXCEPTION 'unknown evidence outcome: %',p_outcome USING ERRCODE='22023';
  END IF;
  IF v_cash_metric IS NOT NULL AND v_cash_metric NOT IN (
    'three_bet','four_bet','steal','squeeze','blind_defense','cbet_flop',
    'barrel_turn','barrel_river','check_raise','donk','probe'
  ) THEN
    RAISE EXCEPTION 'unknown cash evidence metric: %',p_cash_metric USING ERRCODE='22023';
  END IF;
  IF (p_cursor_played_at IS NULL) <> (p_cursor_hand_id IS NULL) THEN
    RAISE EXCEPTION 'evidence cursor requires played_at and hand_id together' USING ERRCODE='22023';
  END IF;
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from >= p_to THEN
    RAISE EXCEPTION 'evidence range must be increasing' USING ERRCODE='22023';
  END IF;

  RETURN (WITH filtered AS MATERIALIZED (
    SELECT f.hand_id,f.played_at,f.club_id,f.table_id,f.tournament_id,
      f.game_variant,f.big_blind,f.position,f.players_dealt,f.hand_class,
      f.invested,f.returned,f.net,f.net_bb,f.rake_paid,f.vpip,f.pfr,
      f.three_bet,f.faced_three_bet,f.folded_to_three_bet,
      f.had_cbet_flop_opp,f.cbet_flop,f.saw_flop,f.went_to_showdown,
      f.won_at_showdown,f.aggressive_actions,f.passive_actions,f.was_all_in,
      f.ev_net_bb,f.hole_cards own_hole_cards,h.pot_size,
      v_cash_metric cash_metric,
      CASE v_cash_metric
        WHEN 'three_bet' THEN f.three_bet WHEN 'four_bet' THEN f.four_bet
        WHEN 'steal' THEN f.stole WHEN 'squeeze' THEN f.squeezed
        WHEN 'blind_defense' THEN f.defended_blind WHEN 'cbet_flop' THEN f.cbet_flop
        WHEN 'barrel_turn' THEN f.barreled_turn WHEN 'barrel_river' THEN f.barreled_river
        WHEN 'check_raise' THEN f.check_raised WHEN 'donk' THEN f.donk_bet
        WHEN 'probe' THEN f.probe_bet ELSE NULL END cash_metric_action
    FROM public.ca_hand_facts f
    JOIN public.clubs c ON c.id=f.club_id
    LEFT JOIN public.hand_history h ON h.id=f.hand_id
    WHERE f.user_id=p_user
      AND coalesce(c.asset,'chips')=p_asset
      AND (p_club_id IS NULL OR f.club_id=p_club_id)
      AND (v_variant IS NULL OR lower(f.game_variant)=CASE
        WHEN v_variant IN ('holdem','texasholdem') THEN 'nlh'
        WHEN v_variant IN ('omaha','plo') THEN 'plo4' ELSE v_variant END)
      AND (v_position IS NULL OR upper(f.position)=v_position)
      AND (p_big_blind IS NULL OR f.big_blind=p_big_blind)
      AND (p_from IS NULL OR f.played_at>=p_from)
      AND (p_to IS NULL OR f.played_at<p_to)
      AND (v_outcome IS NULL OR (v_outcome='won' AND f.net>0) OR (v_outcome='lost' AND f.net<0))
      AND (p_showdown IS NULL OR f.went_to_showdown=p_showdown)
      AND (p_all_in IS NULL OR f.was_all_in=p_all_in)
      AND (p_big_pots IS NULL OR NOT p_big_pots OR
        (h.pot_size IS NOT NULL AND f.big_blind>0 AND h.pot_size>=f.big_blind*100))
      AND (p_noted IS NULL OR NOT p_noted OR EXISTS (
        SELECT 1 FROM public.ca_hand_notes n WHERE n.user_id=p_user AND n.hand_id=f.hand_id))
      AND (p_hand_class IS NULL OR f.hand_class=p_hand_class)
      AND (p_tournament IS NULL OR (f.tournament_id IS NOT NULL)=p_tournament)
      AND (v_cash_metric IS NULL OR (
        f.tournament_id IS NULL AND CASE v_cash_metric
          WHEN 'three_bet' THEN f.three_bet_opportunity
          WHEN 'four_bet' THEN f.four_bet_opportunity
          WHEN 'steal' THEN f.steal_opportunity
          WHEN 'squeeze' THEN f.squeeze_opportunity
          WHEN 'blind_defense' THEN f.blind_defense_opportunity
          WHEN 'cbet_flop' THEN f.cbet_flop_opportunity
          WHEN 'barrel_turn' THEN f.barrel_turn_opportunity
          WHEN 'barrel_river' THEN f.barrel_river_opportunity
          WHEN 'check_raise' THEN f.check_raise_opportunity
          WHEN 'donk' THEN f.donk_opportunity
          WHEN 'probe' THEN f.probe_opportunity ELSE false END IS TRUE))
      AND (p_cursor_played_at IS NULL OR (f.played_at,f.hand_id)<(p_cursor_played_at,p_cursor_hand_id))
    ORDER BY f.played_at DESC,f.hand_id DESC
    LIMIT v_limit+1
  ), numbered AS (
    SELECT filtered.*,row_number() OVER (ORDER BY played_at DESC,hand_id DESC) rn FROM filtered
  ), page AS (
    SELECT * FROM numbered WHERE rn<=v_limit
  ), last_row AS (
    SELECT played_at,hand_id FROM page ORDER BY played_at,hand_id LIMIT 1
  ) SELECT jsonb_build_object(
    'contract_version',3,
    'hands',coalesce((SELECT jsonb_agg(to_jsonb(p)-'rn' ORDER BY played_at DESC,hand_id DESC) FROM page p),'[]'::jsonb),
    'has_more',(SELECT count(*)>v_limit FROM filtered),
    'next_cursor',CASE WHEN (SELECT count(*)>v_limit FROM filtered) THEN
      (SELECT jsonb_build_object('played_at',played_at,'hand_id',hand_id) FROM last_row) ELSE NULL END,
    'scope',jsonb_build_object('target_user_id',p_user,'club_id',p_club_id,'asset',p_asset,
      'from_inclusive',p_from,'to_exclusive',p_to,'cash_metric',v_cash_metric),
    'generated_at',now()));
END;$function$;

REVOKE ALL ON FUNCTION public.ca_player_stats_hand_evidence(
  uuid,uuid,text,text,text,numeric,timestamptz,timestamptz,text,boolean,boolean,
  boolean,boolean,text,boolean,text,timestamptz,uuid,integer
) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_hand_evidence(
  uuid,uuid,text,text,text,numeric,timestamptz,timestamptz,text,boolean,boolean,
  boolean,boolean,text,boolean,text,timestamptz,uuid,integer
) TO authenticated,service_role;

COMMIT;
