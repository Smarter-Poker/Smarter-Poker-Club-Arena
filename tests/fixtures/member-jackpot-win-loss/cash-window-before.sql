CREATE OR REPLACE FUNCTION public.ca_club_members_cash_window(p_club_id uuid, p_user_ids uuid[], p_from date, p_to date)
 RETURNS TABLE(user_id uuid, cash_net numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 WITH b AS MATERIALIZED (
  SELECT public.fn_ca_launch_accounting_cutoff('club',p_club_id) cutoff,
   (p_from IS NULL AND p_to IS NULL) overall,
   (p_from IS NULL AND p_to IS NULL) OR
    (p_from IS NOT NULL AND p_to IS NOT NULL AND p_to>p_from) valid,
   p_from::timestamp AT TIME ZONE 'UTC' us,
   p_from::timestamp AT TIME ZONE 'America/Chicago' cs,
   p_to::timestamp AT TIME ZONE 'America/Chicago' ce,
   (p_to+1)::timestamp AT TIME ZONE 'UTC' ue
 ), wanted AS MATERIALIZED (
  SELECT DISTINCT uid FROM unnest(coalesce(p_user_ids,ARRAY[]::uuid[])) uid WHERE uid IS NOT NULL
 ), daily AS MATERIALIZED (
  SELECT f.user_id uid,sum(f.net) net
  FROM wanted w JOIN public.member_record_daily_facts f ON f.user_id=w.uid CROSS JOIN b
  WHERE b.valid AND f.club_id=p_club_id AND NOT f.is_mtt
   AND f.accounting_cutoff IS NOT DISTINCT FROM b.cutoff
   AND (p_from IS NULL OR f.played_on>=p_from)
   AND (p_to IS NULL OR f.played_on<=p_to)
  GROUP BY f.user_id
 ), edges AS MATERIALIZED (
  SELECT f.user_id,f.table_id,f.hand_id,f.played_at,f.club_id,f.net
  FROM wanted w CROSS JOIN b
  CROSS JOIN LATERAL(VALUES(b.us,b.cs),(b.ce,b.ue)) edge(start_at,end_at)
  JOIN public.ca_hand_facts f ON f.user_id=w.uid
   AND f.played_at>=edge.start_at AND f.played_at<edge.end_at
  WHERE b.valid AND NOT b.overall AND f.tournament_id IS NULL
   AND CASE WHEN b.cutoff IS NULL THEN true ELSE
    f.played_at IS NOT NULL AND isfinite(f.played_at) AND f.played_at>=b.cutoff END
 ), occupancies AS MATERIALIZED (
  SELECT DISTINCT table_id,user_id FROM edges
 ), funding AS MATERIALIZED (
  SELECT DISTINCT ON(x.table_id,x.account_entity_id,x.seat_joined_at)
   x.table_id,x.account_entity_id,x.seat_joined_at,x.funding_club_id
  FROM public.cash_participant_funding_receipts x JOIN occupancies o
   ON o.table_id=x.table_id AND o.user_id=x.account_entity_id
  WHERE x.operation_kind='buyin'
  ORDER BY x.table_id,x.account_entity_id,x.seat_joined_at,x.recorded_at DESC,x.id DESC
 ), timeline AS MATERIALIZED (
  SELECT *,lead(seat_joined_at) OVER(
   PARTITION BY table_id,account_entity_id ORDER BY seat_joined_at) next_joined_at FROM funding
 ), resolved AS MATERIALIZED (
  SELECT f.*,x.funding_club_id FROM edges f
  LEFT JOIN timeline x ON x.table_id=f.table_id AND x.account_entity_id=f.user_id
   AND x.seat_joined_at<=f.played_at AND (x.next_joined_at IS NULL OR f.played_at<x.next_joined_at)
 ), unfunded AS MATERIALIZED (
  SELECT * FROM resolved WHERE funding_club_id IS NULL
 ), amounts AS (
  SELECT f.user_id uid,f.net FROM resolved f WHERE f.funding_club_id=p_club_id
  UNION ALL
  SELECT f.user_id uid,f.net FROM unfunded f
  LEFT JOIN public.rake_attributions ra ON ra.hand_id=f.hand_id AND ra.player_id=f.user_id
  WHERE coalesce(ra.club_id,f.club_id)=p_club_id
 ), removed AS MATERIALIZED (
  SELECT uid,sum(net) net FROM amounts GROUP BY uid
 )
 SELECT w.uid,coalesce(d.net,0)-coalesce(r.net,0)
 FROM wanted w LEFT JOIN daily d ON d.uid=w.uid LEFT JOIN removed r ON r.uid=w.uid;
$function$
;
