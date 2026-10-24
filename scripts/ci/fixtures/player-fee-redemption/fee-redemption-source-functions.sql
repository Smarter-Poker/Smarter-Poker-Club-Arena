-- Production reader definitions captured 2026-10-23, before the redemption fix.
CREATE OR REPLACE FUNCTION public.ca_club_member_fee_totals(p_club_id uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(user_id uuid, cash_fees numeric, tournament_fees numeric, total_fees numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH bounds AS (
    SELECT greatest(coalesce(p_from, public.fn_ca_fee_counting_start()),
                    public.fn_ca_fee_counting_start()) AS from_day
  ), cash AS (
    SELECT d.user_id AS uid, sum(d.rake_cents)::numeric / 100 AS fees
      FROM public.ca_club_rake_daily_user d, bounds b
     WHERE d.club_id = p_club_id
       AND (p_user_id IS NULL OR d.user_id = p_user_id)
       AND d.day >= b.from_day
       AND (p_to IS NULL OR d.day <= p_to)
     GROUP BY d.user_id
  ), mtt AS (
    SELECT t.user_id AS uid, sum(t.fees) AS fees
      FROM public.ca_club_member_tournament_fee_daily t, bounds b
     WHERE t.club_id = p_club_id
       AND (p_user_id IS NULL OR t.user_id = p_user_id)
       AND t.day >= b.from_day
       AND (p_to IS NULL OR t.day <= p_to)
     GROUP BY t.user_id
  )
  SELECT coalesce(c.uid, m.uid),
         round(coalesce(c.fees, 0), 2),
         round(coalesce(m.fees, 0), 2),
         round(coalesce(c.fees, 0) + coalesce(m.fees, 0), 2)
    FROM cash c
    FULL JOIN mtt m ON m.uid = c.uid;
$function$;

CREATE OR REPLACE FUNCTION public.ca_player_rake_stats(p_user uuid DEFAULT NULL::uuid, p_days integer DEFAULT NULL::integer, p_asset text DEFAULT 'chips'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid;
  v_since timestamptz;
  v_hands bigint := 0;
  v_raked_hands bigint := 0;
  v_rake numeric := 0;
  v_bb numeric := 0;
  v_first timestamptz;
  v_last timestamptz;
BEGIN
  IF p_asset IS NULL OR p_asset NOT IN ('chips', 'diamonds') THEN
    RAISE EXCEPTION 'unknown stats asset: %', p_asset USING ERRCODE = '22023';
  END IF;
  IF public.fn_caller_is_engine() THEN
    v_uid := coalesce(p_user, auth.uid());
  ELSE
    v_uid := auth.uid();
  END IF;
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object(
      'hands', 0, 'raked_hands', 0, 'rake_paid', 0,
      'rake_per_100', 0, 'rake_in_bb', 0, 'days', p_days
    );
  END IF;

  v_since := CASE WHEN p_days IS NULL THEN '-infinity'::timestamptz
                  ELSE now() - make_interval(days => greatest(p_days, 1)) END;

  SELECT count(*),
         count(*) FILTER (WHERE coalesce(f.rake_paid, 0) > 0),
         coalesce(sum(f.rake_paid), 0),
         coalesce(sum(CASE WHEN f.big_blind > 0 THEN f.rake_paid / f.big_blind ELSE 0 END), 0),
         min(f.played_at),
         max(f.played_at)
  INTO v_hands, v_raked_hands, v_rake, v_bb, v_first, v_last
  FROM public.ca_hand_facts f
  WHERE f.user_id = v_uid
    AND f.played_at >= v_since
    AND f.tournament_id IS NULL
    AND coalesce(f.club_id IN (SELECT c.id FROM public.clubs c WHERE c.asset = 'diamonds'), false) = (p_asset = 'diamonds');

  RETURN jsonb_build_object(
    'hands', v_hands,
    'raked_hands', v_raked_hands,
    'rake_paid', round(v_rake, 2),
    'rake_per_100', CASE WHEN v_hands > 0 THEN round(v_rake * 100.0 / v_hands, 2) ELSE 0 END,
    'rake_in_bb', round(v_bb, 2),
    'bb_per_100', CASE WHEN v_hands > 0 THEN round(v_bb * 100.0 / v_hands, 2) ELSE 0 END,
    'avg_rake_per_raked_hand',
      CASE WHEN v_raked_hands > 0 THEN round(v_rake / v_raked_hands, 4) ELSE 0 END,
    'first_hand_at', v_first,
    'last_hand_at', v_last,
    'days', p_days
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.ca_player_rake_stats_by_club(p_user uuid DEFAULT NULL::uuid, p_days integer DEFAULT NULL::integer, p_asset text DEFAULT 'chips'::text, p_club_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid:=coalesce(p_user,auth.uid()); v_hands bigint; v_raked bigint;
  v_rake numeric; v_bb numeric; v_first timestamptz; v_last timestamptz;
BEGIN
  -- funded_stats_scope: historical funding, original caller gates.
  PERFORM public.ca_assert_player_stats_club(v_uid,p_club_id,p_asset);
  SELECT count(*),count(*) FILTER(WHERE coalesce(rake_paid,0)>0),coalesce(sum(rake_paid),0),
    coalesce(sum(CASE WHEN big_blind>0 THEN rake_paid/big_blind ELSE 0 END),0),
    min(played_at),max(played_at) INTO v_hands,v_raked,v_rake,v_bb,v_first,v_last
  FROM (
 WITH receipts AS MATERIALIZED (
  SELECT DISTINCT ON(table_id,account_entity_id,seat_joined_at)
   table_id,account_entity_id,seat_joined_at,funding_club_id
  FROM public.cash_participant_funding_receipts
  WHERE account_entity_id=v_uid AND operation_kind='buyin'
  ORDER BY table_id,account_entity_id,seat_joined_at,recorded_at DESC,id DESC
 ), funding AS MATERIALIZED (
  SELECT *,lead(seat_joined_at) OVER(PARTITION BY table_id,account_entity_id ORDER BY seat_joined_at) until_at
  FROM receipts
 )
 SELECT fact.*,coalesce(x.funding_club_id,tp.club_id,ra.club_id,fact.club_id) funded_club
 FROM public.ca_hand_facts fact
 LEFT JOIN funding x ON fact.tournament_id IS NULL AND x.table_id=fact.table_id
  AND fact.played_at>=x.seat_joined_at AND (x.until_at IS NULL OR fact.played_at<x.until_at)
 LEFT JOIN public.tournament_players tp ON tp.tournament_id=fact.tournament_id AND tp.user_id=fact.user_id
 LEFT JOIN public.rake_attributions ra ON x.funding_club_id IS NULL AND tp.club_id IS NULL
  AND ra.hand_id=fact.hand_id AND ra.player_id=fact.user_id
 WHERE fact.user_id=v_uid
 ) funded_stats_scope WHERE user_id=v_uid AND funded_club=p_club_id AND tournament_id IS NULL
    AND (p_days IS NULL OR played_at>=now()-make_interval(days=>least(greatest(p_days,1),3650)));
  RETURN jsonb_build_object('contract_version',2,
    'scope',jsonb_build_object('target_user_id',v_uid,'club_id',p_club_id,'asset',p_asset,
      'range_days',CASE WHEN p_days IS NULL THEN NULL ELSE least(greatest(p_days,1),3650) END,'visibility','owner'),
    'hands',v_hands,'raked_hands',v_raked,'rake_paid',round(v_rake,2),
    'rake_per_100',CASE WHEN v_hands>0 THEN round(v_rake*100/v_hands,2) ELSE 0 END,
    'rake_in_bb',round(v_bb,2),'bb_per_100',CASE WHEN v_hands>0 THEN round(v_bb*100/v_hands,2) ELSE 0 END,
    'avg_rake_per_raked_hand',CASE WHEN v_raked>0 THEN round(v_rake/v_raked,4) ELSE 0 END,
    'first_hand_at',v_first,'last_hand_at',v_last,'days',
      CASE WHEN p_days IS NULL THEN NULL ELSE least(greatest(p_days,1),3650) END);
END;$function$;
