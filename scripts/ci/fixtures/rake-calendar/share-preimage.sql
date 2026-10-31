CREATE OR REPLACE FUNCTION smarter_private.fn_player_rake_share_hand_cents(p_user uuid, p_since timestamp with time zone, p_asset text)
 RETURNS TABLE(share_club_id uuid, share_day date, share_cents bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH rules AS MATERIALIZED (
    SELECT r.rule_key, r.club_id, r.from_user, r.to_user, r.share_bps,
           greatest(r.effective_from, coalesce(p_since, '-infinity'::timestamptz)) AS from_at,
           r.effective_until
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

