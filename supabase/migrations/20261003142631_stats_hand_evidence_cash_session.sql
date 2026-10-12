-- Final Stats evidence contract composed after cash opportunity facts and exact
-- cash sessions both exist. One public RPC supports metric and session scope;
-- its predecessor remains private so non-session filters keep one implementation.
BEGIN;

ALTER FUNCTION public.ca_player_stats_hand_evidence(
  uuid,uuid,text,text,text,numeric,timestamptz,timestamptz,text,boolean,boolean,
  boolean,boolean,text,boolean,text,timestamptz,uuid,integer
) RENAME TO ca_player_stats_hand_evidence_base;

REVOKE ALL ON FUNCTION public.ca_player_stats_hand_evidence_base(
  uuid,uuid,text,text,text,numeric,timestamptz,timestamptz,text,boolean,boolean,
  boolean,boolean,text,boolean,text,timestamptz,uuid,integer
) FROM PUBLIC,anon,authenticated;

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
  p_cash_session_id uuid DEFAULT NULL,
  p_cursor_played_at timestamptz DEFAULT NULL,
  p_cursor_hand_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 25
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='public'
AS $function$
DECLARE
  v_session public.cash_player_session%ROWTYPE;
  v_session_asset text;
  v_overlap integer;
  v_limit integer := least(greatest(coalesce(p_limit,25),1),100);
  v_cash_metric text := lower(nullif(btrim(p_cash_metric),''));
BEGIN
  PERFORM public.ca_assert_self(p_user);
  IF p_cash_session_id IS NULL THEN
    RETURN public.ca_player_stats_hand_evidence_base(
      p_user,p_club_id,p_asset,p_variant,p_position,p_big_blind,p_from,p_to,
      p_outcome,p_showdown,p_all_in,p_big_pots,p_noted,p_hand_class,p_tournament,
      v_cash_metric,p_cursor_played_at,p_cursor_hand_id,p_limit);
  END IF;
  IF (p_cursor_played_at IS NULL) <> (p_cursor_hand_id IS NULL) THEN
    RAISE EXCEPTION 'session evidence cursor requires played_at and hand_id together'
      USING ERRCODE='22023';
  END IF;
  IF v_cash_metric IS NOT NULL AND v_cash_metric NOT IN (
    'three_bet','four_bet','steal','squeeze','blind_defense','cbet_flop',
    'barrel_turn','barrel_river','check_raise','donk','probe'
  ) THEN
    RAISE EXCEPTION 'unknown cash evidence metric: %',p_cash_metric USING ERRCODE='22023';
  END IF;
  SELECT s.* INTO v_session
    FROM public.cash_player_session s
    JOIN public.clubs c ON c.id=s.club_id
    JOIN public.club_members m ON m.club_id=c.id AND m.user_id=p_user
   WHERE s.id=p_cash_session_id AND s.player_id=p_user
     AND m.status IN ('active','approved')
     AND coalesce(c.lifecycle_status,'active')<>'retired'
     AND (p_club_id IS NULL OR s.club_id=p_club_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cash session evidence refused' USING ERRCODE='42501';
  END IF;
  SELECT coalesce(c.asset,'chips') INTO v_session_asset
    FROM public.clubs c WHERE c.id=v_session.club_id;
  SELECT count(*)::integer INTO v_overlap
    FROM public.cash_player_session o
   WHERE o.player_id=p_user AND o.id<>v_session.id
     AND o.club_id=v_session.club_id
     AND ((v_session.cluster_id IS NOT NULL AND o.cluster_id=v_session.cluster_id)
          OR (v_session.cluster_id IS NULL AND o.cluster_id IS NULL
              AND o.table_id=v_session.table_id))
     AND tstzrange(o.opened_at,coalesce(o.closed_at,'infinity'),'[)') &&
         tstzrange(v_session.opened_at,coalesce(v_session.closed_at,'infinity'),'[)');
  IF v_overlap>0 THEN
    RETURN jsonb_build_object('contract_version',3,'hands','[]'::jsonb,'has_more',false,
      'next_cursor',NULL,'evidence_status','overlap_unavailable',
      'scope',jsonb_build_object('target_user_id',p_user,'cash_session_id',v_session.id,
        'club_id',v_session.club_id,'asset',v_session_asset,'visibility','owner'),'generated_at',now());
  END IF;

  RETURN (WITH filtered AS MATERIALIZED (
    SELECT f.hand_id,f.played_at,f.club_id,f.table_id,f.net,f.net_bb,f.game_variant,
      v_cash_metric cash_metric,
      CASE v_cash_metric
        WHEN 'three_bet' THEN f.three_bet WHEN 'four_bet' THEN f.four_bet
        WHEN 'steal' THEN f.stole WHEN 'squeeze' THEN f.squeezed
        WHEN 'blind_defense' THEN f.defended_blind WHEN 'cbet_flop' THEN f.cbet_flop
        WHEN 'barrel_turn' THEN f.barreled_turn WHEN 'barrel_river' THEN f.barreled_river
        WHEN 'check_raise' THEN f.check_raised WHEN 'donk' THEN f.donk_bet
        WHEN 'probe' THEN f.probe_bet ELSE NULL END cash_metric_action
      FROM public.ca_hand_facts f LEFT JOIN public.tables t ON t.id=f.table_id
     WHERE f.user_id=p_user AND f.club_id=v_session.club_id AND f.tournament_id IS NULL
       AND f.played_at>=v_session.opened_at
       AND f.played_at<coalesce(v_session.closed_at,'infinity')
       AND ((v_session.cluster_id IS NOT NULL AND t.cluster_id=v_session.cluster_id)
            OR (v_session.cluster_id IS NULL AND f.table_id=v_session.table_id))
       AND (v_cash_metric IS NULL OR CASE v_cash_metric
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
          WHEN 'probe' THEN f.probe_opportunity ELSE false END IS TRUE)
       AND (p_cursor_played_at IS NULL OR
         (f.played_at,f.hand_id)<(p_cursor_played_at,p_cursor_hand_id))
     ORDER BY f.played_at DESC,f.hand_id DESC LIMIT v_limit+1
  ), page AS (SELECT * FROM filtered ORDER BY played_at DESC,hand_id DESC LIMIT v_limit),
  last_row AS (SELECT played_at,hand_id FROM page ORDER BY played_at,hand_id LIMIT 1)
  SELECT jsonb_build_object('contract_version',3,
    'hands',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY played_at DESC,hand_id DESC) FROM page p),'[]'::jsonb),
    'has_more',(SELECT count(*)>v_limit FROM filtered),
    'next_cursor',CASE WHEN (SELECT count(*)>v_limit FROM filtered) THEN
      (SELECT jsonb_build_object('played_at',played_at,'hand_id',hand_id) FROM last_row) ELSE NULL END,
    'evidence_status','exact_session','scope',jsonb_build_object('target_user_id',p_user,
      'cash_session_id',v_session.id,'club_id',v_session.club_id,'asset',v_session_asset,
      'cash_metric',v_cash_metric,'visibility','owner'),'generated_at',now()));
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_player_stats_hand_evidence(
  uuid,uuid,text,text,text,numeric,timestamptz,timestamptz,text,boolean,boolean,
  boolean,boolean,text,boolean,text,uuid,timestamptz,uuid,integer
) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_hand_evidence(
  uuid,uuid,text,text,text,numeric,timestamptz,timestamptz,text,boolean,boolean,
  boolean,boolean,text,boolean,text,uuid,timestamptz,uuid,integer
) TO authenticated,service_role;

COMMIT;
