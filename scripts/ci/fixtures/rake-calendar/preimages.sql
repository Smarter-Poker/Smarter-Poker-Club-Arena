CREATE OR REPLACE FUNCTION public.ca_player_rake_stats(p_user uuid DEFAULT NULL::uuid, p_days integer DEFAULT NULL::integer, p_asset text DEFAULT 'chips'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_fee_redemption numeric := 0;
  v_rake_share numeric := 0;
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


  SELECT coalesce(sum(r.amount_cents),0)::numeric / 100
    INTO v_fee_redemption
    FROM smarter_private.player_fee_redemptions r
   WHERE r.user_id=v_uid AND p_asset='chips'
     AND (p_days IS NULL OR r.effective_on >=
       (now()-make_interval(days=>greatest(p_days,1)))::date)
     ;
  -- A standing rake share (smarter_private.player_rake_share_rules), from the
  -- same hands: negative where this player gives, positive where it receives.
  SELECT coalesce(sum(s.share_cents),0)::numeric / 100
    INTO v_rake_share
    FROM smarter_private.fn_player_rake_share_hand_cents(v_uid, v_since, p_asset) s;
  v_fee_redemption := v_fee_redemption - v_rake_share;
  v_rake := v_rake - v_fee_redemption;
  RETURN jsonb_build_object('fee_redemption',v_fee_redemption,
    'rake_share',v_rake_share,
    'gross_rake_paid',round(v_rake + v_fee_redemption,2),
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
$function$
;

CREATE OR REPLACE FUNCTION public.ca_player_rake_stats_by_club(p_user uuid DEFAULT NULL::uuid, p_days integer DEFAULT NULL::integer, p_asset text DEFAULT 'chips'::text, p_club_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_fee_redemption numeric := 0; v_rake_share numeric := 0; v_uid uuid:=coalesce(p_user,auth.uid()); v_hands bigint;
  v_raked bigint; v_rake numeric; v_bb numeric; v_first timestamptz; v_last timestamptz;
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

  SELECT coalesce(sum(r.amount_cents),0)::numeric / 100
    INTO v_fee_redemption
    FROM smarter_private.player_fee_redemptions r
   WHERE r.user_id=v_uid AND p_asset='chips'
     AND (p_days IS NULL OR r.effective_on >=
       (now()-make_interval(days=>least(greatest(p_days,1),3650)))::date)
     AND r.club_id=p_club_id;
  -- A standing rake share (smarter_private.player_rake_share_rules), from the
  -- same funded hands: negative where this player gives, positive where it receives.
  SELECT coalesce(sum(s.share_cents),0)::numeric / 100
    INTO v_rake_share
    FROM smarter_private.fn_player_rake_share_hand_cents(v_uid,
           CASE WHEN p_days IS NULL THEN '-infinity'::timestamptz
                ELSE now()-make_interval(days=>least(greatest(p_days,1),3650)) END,
           p_asset) s
   WHERE s.share_club_id=p_club_id;
  v_fee_redemption := v_fee_redemption - v_rake_share;
  v_rake := v_rake - v_fee_redemption;
  RETURN jsonb_build_object('fee_redemption',v_fee_redemption,'rake_share',v_rake_share,
    'gross_rake_paid',round(v_rake + v_fee_redemption,2),'contract_version',2,
    'scope',jsonb_build_object('target_user_id',v_uid,'club_id',p_club_id,'asset',p_asset,
      'range_days',CASE WHEN p_days IS NULL THEN NULL ELSE least(greatest(p_days,1),3650) END,'visibility','owner'),
    'hands',v_hands,'raked_hands',v_raked,'rake_paid',round(v_rake,2),
    'rake_per_100',CASE WHEN v_hands>0 THEN round(v_rake*100/v_hands,2) ELSE 0 END,
    'rake_in_bb',round(v_bb,2),'bb_per_100',CASE WHEN v_hands>0 THEN round(v_bb*100/v_hands,2) ELSE 0 END,
    'avg_rake_per_raked_hand',CASE WHEN v_raked>0 THEN round(v_rake/v_raked,4) ELSE 0 END,
    'first_hand_at',v_first,'last_hand_at',v_last,'days',
      CASE WHEN p_days IS NULL THEN NULL ELSE least(greatest(p_days,1),3650) END);
END;$function$
;

CREATE OR REPLACE FUNCTION public.ca_stats_calendar_bounds(p_days integer DEFAULT NULL::integer, p_tz text DEFAULT 'UTC'::text, p_now timestamp with time zone DEFAULT now())
 RETURNS TABLE(range_days integer, range_tz text, from_at timestamp with time zone, to_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_days integer := CASE WHEN p_days IS NULL THEN NULL ELSE least(greatest(p_days,1),3650) END;
  v_tz text := CASE WHEN EXISTS (SELECT 1 FROM pg_timezone_names WHERE name=p_tz) THEN p_tz ELSE 'UTC' END;
BEGIN
  RETURN QUERY SELECT v_days, v_tz,
    CASE WHEN v_days IS NULL THEN NULL ELSE
      (((p_now AT TIME ZONE v_tz)::date-(v_days-1))::timestamp AT TIME ZONE v_tz) END,
    CASE WHEN v_days IS NULL THEN NULL ELSE
      ((((p_now AT TIME ZONE v_tz)::date+1)::timestamp) AT TIME ZONE v_tz) END;
END;
$function$
;

