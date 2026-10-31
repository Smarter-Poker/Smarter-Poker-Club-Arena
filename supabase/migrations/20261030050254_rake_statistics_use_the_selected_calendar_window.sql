-- Reserved by scripts/new-migration.mjs. Additive calendar readers for Stats.
-- The old Rake door uses now()-N days; the overview uses N calendar days in
-- the viewer timezone. At Chicago midnight 2026-10-30 an observed player had
-- 3,012 extra hands / 860.74 extra rake in the rolling seven-day interval.
-- Keep existing readers/callers and every allocation/identity rule intact.
-- New readers use the SAME validated calendar helper as the overview. Fixed
-- redemption dates represent UTC midnight; standing shares keep per-rule/day
-- rounding and historical funding, bounded before aggregation at both ends.
-- No financial writes or hot-table DDL. Install before the client switches.
-- @live-proof: to_regprocedure('public.ca_player_rake_stats_calendar(uuid,integer,text,text)') IS NOT NULL
-- @live-proof: to_regprocedure('public.ca_player_rake_stats_calendar_by_club(uuid,integer,text,uuid,text)') IS NOT NULL
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $preimage$ BEGIN
 IF md5(pg_get_functiondef('public.ca_player_rake_stats(uuid,integer,text)'::regprocedure))<>'b7d83635fb02e428fb6976ac50ba5ccf'
 OR md5(pg_get_functiondef('public.ca_player_rake_stats_by_club(uuid,integer,text,uuid)'::regprocedure))<>'c3fed7ec682d38aa811b14d4843e3621'
 OR md5(pg_get_functiondef('smarter_private.fn_player_rake_share_hand_cents(uuid,timestamptz,text)'::regprocedure))<>'3f7f93733af85b82d15b078e214aab35'
 OR md5(pg_get_functiondef('public.ca_stats_calendar_bounds(integer,text,timestamptz)'::regprocedure))<>'8543595ca1c3bf47b560180891d91aff'
 THEN RAISE EXCEPTION 'Calendar rake dependency preimage changed'; END IF;
END $preimage$;
CREATE FUNCTION smarter_private.fn_player_rake_share_calendar_cents(p_user uuid, p_since timestamptz, p_until timestamptz, p_asset text)
 RETURNS TABLE(share_club_id uuid, share_day date, share_cents bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH rules AS MATERIALIZED (
    SELECT r.rule_key, r.club_id, r.from_user, r.to_user, r.share_bps,
           greatest(r.effective_from, coalesce(p_since, '-infinity'::timestamptz)) AS from_at,
           least(r.effective_until,p_until) AS effective_until
      FROM smarter_private.player_rake_share_rules r
      JOIN public.clubs c ON c.id = r.club_id
     WHERE p_user IN (r.from_user, r.to_user)
       AND coalesce(c.asset, 'chips') = p_asset
  ), receipts AS MATERIALIZED (
    SELECT DISTINCT ON (fr.table_id, fr.account_entity_id, fr.seat_joined_at)
           fr.table_id, fr.account_entity_id, fr.seat_joined_at, fr.funding_club_id
      FROM public.cash_participant_funding_receipts fr
     WHERE fr.account_entity_id IN (SELECT rules.from_user FROM rules)
       AND fr.operation_kind = 'buyin'
     ORDER BY fr.table_id, fr.account_entity_id, fr.seat_joined_at, fr.recorded_at DESC, fr.id DESC
  ), funding AS MATERIALIZED (
    SELECT x.*, lead(x.seat_joined_at) OVER (
             PARTITION BY x.table_id, x.account_entity_id ORDER BY x.seat_joined_at) AS until_at
      FROM receipts x
  ), shared AS (
    SELECT r.rule_key, r.club_id, r.from_user, r.share_bps,
           (f.played_at AT TIME ZONE 'UTC')::date AS day,
           sum(coalesce(f.rake_paid, 0)) AS rake
      FROM rules r
      JOIN public.ca_hand_facts f
        ON f.user_id = r.from_user AND f.tournament_id IS NULL
       AND f.played_at >= r.from_at
       AND (r.effective_until IS NULL OR f.played_at < r.effective_until)
      LEFT JOIN funding x
        ON x.account_entity_id = f.user_id AND x.table_id = f.table_id
       AND f.played_at >= x.seat_joined_at AND (x.until_at IS NULL OR f.played_at < x.until_at)
      LEFT JOIN public.rake_attributions ra
        ON x.funding_club_id IS NULL AND ra.hand_id = f.hand_id AND ra.player_id = f.user_id
     WHERE coalesce(x.funding_club_id, ra.club_id, f.club_id) = r.club_id
     GROUP BY r.rule_key, r.club_id, r.from_user, r.share_bps, 5
  )
  SELECT s.club_id, s.day,
         (CASE WHEN s.from_user = p_user THEN -1 ELSE 1 END)
           * round(s.rake * s.share_bps / 100)::bigint
    FROM shared s;
$function$
;
CREATE FUNCTION public.ca_player_rake_stats_calendar(p_user uuid, p_days integer, p_asset text, p_tz text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_calendar_from timestamptz; v_calendar_to timestamptz;
  v_fee_redemption numeric := 0;
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
  SELECT b.range_days,b.range_tz,coalesce(b.from_at,'-infinity'::timestamptz),b.to_at
    INTO p_days,p_tz,v_calendar_from,v_calendar_to
    FROM public.ca_stats_calendar_bounds(p_days,p_tz) b;
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

  v_since := v_calendar_from;

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
    AND (v_calendar_to IS NULL OR f.played_at < v_calendar_to)
    AND f.tournament_id IS NULL
    AND coalesce(f.club_id IN (SELECT c.id FROM public.clubs c WHERE c.asset = 'diamonds'), false) = (p_asset = 'diamonds');


  SELECT coalesce(sum(r.amount_cents),0)::numeric / 100
    INTO v_fee_redemption
    FROM smarter_private.player_fee_redemptions r
   WHERE r.user_id=v_uid AND p_asset='chips'
     AND (r.effective_on::timestamp AT TIME ZONE 'UTC') >= v_calendar_from
     AND (v_calendar_to IS NULL OR (r.effective_on::timestamp AT TIME ZONE 'UTC') < v_calendar_to)
     ;
  -- A standing rake share (smarter_private.player_rake_share_rules), from the
  -- same hands: negative where this player gives, positive where it receives.
  SELECT coalesce(sum(s.share_cents),0)::numeric / 100
    INTO v_rake_share
    FROM smarter_private.fn_player_rake_share_calendar_cents(v_uid,v_calendar_from,v_calendar_to,p_asset) s;
  v_fee_redemption := v_fee_redemption - v_rake_share;
  v_rake := v_rake - v_fee_redemption;
  RETURN jsonb_build_object('range_tz',p_tz,'range_from',CASE WHEN p_days IS NULL THEN NULL ELSE v_calendar_from END,'range_to',v_calendar_to,'fee_redemption',v_fee_redemption,
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
CREATE FUNCTION public.ca_player_rake_stats_calendar_by_club(p_user uuid, p_days integer, p_asset text, p_club_id uuid, p_tz text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_calendar_from timestamptz; v_calendar_to timestamptz;
  v_fee_redemption numeric := 0; v_rake_share numeric := 0; v_uid uuid:=coalesce(p_user,auth.uid()); v_hands bigint;
  v_raked bigint; v_rake numeric; v_bb numeric; v_first timestamptz; v_last timestamptz;
BEGIN
  SELECT b.range_days,b.range_tz,coalesce(b.from_at,'-infinity'::timestamptz),b.to_at
    INTO p_days,p_tz,v_calendar_from,v_calendar_to
    FROM public.ca_stats_calendar_bounds(p_days,p_tz) b;
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
    AND played_at>=v_calendar_from
    AND (v_calendar_to IS NULL OR played_at<v_calendar_to);

  SELECT coalesce(sum(r.amount_cents),0)::numeric / 100
    INTO v_fee_redemption
    FROM smarter_private.player_fee_redemptions r
   WHERE r.user_id=v_uid AND p_asset='chips'
     AND (r.effective_on::timestamp AT TIME ZONE 'UTC') >= v_calendar_from
     AND (v_calendar_to IS NULL OR (r.effective_on::timestamp AT TIME ZONE 'UTC') < v_calendar_to)
     AND r.club_id=p_club_id;
  -- A standing rake share (smarter_private.player_rake_share_rules), from the
  -- same funded hands: negative where this player gives, positive where it receives.
  SELECT coalesce(sum(s.share_cents),0)::numeric / 100
    INTO v_rake_share
    FROM smarter_private.fn_player_rake_share_calendar_cents(v_uid,v_calendar_from,v_calendar_to,p_asset) s
   WHERE s.share_club_id=p_club_id;
  v_fee_redemption := v_fee_redemption - v_rake_share;
  v_rake := v_rake - v_fee_redemption;
  RETURN jsonb_build_object('range_tz',p_tz,'range_from',CASE WHEN p_days IS NULL THEN NULL ELSE v_calendar_from END,'range_to',v_calendar_to,'fee_redemption',v_fee_redemption,'rake_share',v_rake_share,
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

REVOKE ALL ON FUNCTION smarter_private.fn_player_rake_share_calendar_cents(uuid,timestamptz,timestamptz,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION smarter_private.fn_player_rake_share_calendar_cents(uuid,timestamptz,timestamptz,text) TO service_role;
REVOKE ALL ON FUNCTION public.ca_player_rake_stats_calendar(uuid,integer,text,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.ca_player_rake_stats_calendar_by_club(uuid,integer,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ca_player_rake_stats_calendar(uuid,integer,text,text) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ca_player_rake_stats_calendar_by_club(uuid,integer,text,uuid,text) TO authenticated,service_role;
COMMIT;

