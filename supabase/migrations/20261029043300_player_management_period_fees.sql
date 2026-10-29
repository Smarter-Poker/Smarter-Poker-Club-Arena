-- Player Management uses the selected Chicago calendar period for fees as well
-- as profit/loss. Existing lifetime readers and financial writers are unchanged.
-- Canonical custody stays with ca_club_member_fee_totals: daily cash attribution,
-- standing share rounded per rule/UTC day, effective-date redemptions and MTT
-- charge receipts. Only timestamped partial UTC-day edges are removed.
-- @live-proof: to_regprocedure('public.ca_club_members_period_summary(uuid,uuid[],text)') IS NOT NULL
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';

DO $guard$
BEGIN
 IF md5(pg_get_functiondef('public.ca_club_member_fee_totals(uuid,date,date,uuid)'::regprocedure)) IS DISTINCT FROM 'e233f2f7c3952d9c744cecb87ba82f59'
 OR md5(pg_get_functiondef('public.ca_club_members_win_loss(uuid,uuid[],text)'::regprocedure)) IS DISTINCT FROM '7b540732a69268ec3ad64c7ab58c85c3'
 OR md5(pg_get_functiondef('public.ca_club_roster_access(uuid,uuid)'::regprocedure)) IS DISTINCT FROM 'ddf66699cb1acfa08847428f64b51166'
 THEN RAISE EXCEPTION 'Player period fee dependency changed; qualify current source'; END IF;
END $guard$;

-- Array scope is established before daily projections or raw timestamp edges.
-- This is the canonical custody calculation with explicit input/date pushdown;
-- calling its scalar predecessor per player would repeat its unbounded share CTE.
CREATE FUNCTION public.ca_club_member_period_fee_totals(
 p_club_id uuid,p_user_ids uuid[],p_from date,p_until timestamptz
) RETURNS TABLE(user_id uuid,total_fees numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public,pg_temp
AS $fn$
 WITH bounds AS (
  SELECT greatest(coalesce(p_from,public.fn_ca_fee_counting_start()),public.fn_ca_fee_counting_start()) d,p_until e
 ), b AS (
  SELECT d,e,CASE WHEN p_from IS NULL THEN d::timestamp AT TIME ZONE 'UTC'
   ELSE greatest(d::timestamp AT TIME ZONE 'UTC',p_from::timestamp AT TIME ZONE 'America/Chicago') END s,
   d::timestamp AT TIME ZONE 'UTC' us,
   ((e AT TIME ZONE 'UTC')::date+1)::timestamp AT TIME ZONE 'UTC' ue FROM bounds
 ), wanted AS MATERIALIZED (
  SELECT DISTINCT u uid FROM unnest(coalesce(p_user_ids,ARRAY[]::uuid[])) u WHERE u IS NOT NULL
 ), cash_daily AS (
  SELECT d.user_id uid,sum(d.rake_cents)/100.0 amount
  FROM wanted w JOIN public.ca_club_rake_daily_user d ON d.user_id=w.uid CROSS JOIN b
  WHERE d.club_id=p_club_id AND d.day>=b.d AND d.day<=(b.e AT TIME ZONE 'UTC')::date GROUP BY d.user_id
 ), mtt_daily AS (
  SELECT d.user_id uid,sum(d.fees) amount
  FROM wanted w JOIN public.ca_club_member_tournament_fee_daily d ON d.user_id=w.uid CROSS JOIN b
  WHERE d.club_id=p_club_id AND d.day>=b.d AND d.day<=(b.e AT TIME ZONE 'UTC')::date GROUP BY d.user_id
 ), share AS (
  -- Canonical rounds each rule/UTC day. Full-rounded + (retained-rounded minus
  -- full-rounded) equals retained-rounded; never round an excluded fraction.
  -- Include incoming rules whose donor is outside the requested member set.
  SELECT r.from_user,r.to_user,
   round(sum(round(ra.rake_amount*100))*r.share_bps/10000.0)/100 amount
  FROM smarter_private.player_rake_share_rules r
  JOIN public.rake_attributions ra ON ra.club_id=r.club_id AND ra.player_id=r.from_user
   AND ra.created_at>=r.effective_from AND (r.effective_until IS NULL OR ra.created_at<r.effective_until)
  CROSS JOIN b
  WHERE r.club_id=p_club_id AND (r.from_user IN(SELECT uid FROM wanted) OR r.to_user IN(SELECT uid FROM wanted))
   AND ra.rake_amount>0 AND ra.created_at>=b.s AND ra.created_at<b.e
   AND public.fn_ca_launch_accounting_accepts(ra.club_id,
    (SELECT rr.created_at FROM public.rake_records rr WHERE rr.id=ra.rake_record_id))
  GROUP BY r.rule_key,r.from_user,r.to_user,r.share_bps,(ra.created_at AT TIME ZONE 'UTC')::date
 ), cash_edges AS (
  SELECT ra.player_id uid,-sum(round(ra.rake_amount*100))/100 amount
  FROM wanted w CROSS JOIN b
  CROSS JOIN LATERAL(VALUES(b.us,b.s),(b.e,b.ue)) edge(start_at,end_at)
  JOIN public.rake_attributions ra ON ra.player_id=w.uid
   AND ra.created_at>=edge.start_at AND ra.created_at<edge.end_at
  WHERE ra.club_id=p_club_id AND ra.rake_amount>0
   AND public.fn_ca_launch_accounting_accepts(ra.club_id,
    (SELECT rr.created_at FROM public.rake_records rr WHERE rr.id=ra.rake_record_id))
  GROUP BY ra.player_id
 ), mtt_edges AS (
  SELECT t.player_id uid,-sum(t.rake_credit) amount
  FROM wanted w CROSS JOIN b
  CROSS JOIN LATERAL(VALUES(b.us,b.s),(b.e,b.ue)) edge(start_at,end_at)
  JOIN public.accounting_tournament_fee_sources t ON t.player_id=w.uid
   AND t.charged_at>=edge.start_at AND t.charged_at<edge.end_at
  WHERE t.club_id=p_club_id GROUP BY t.player_id
 ), amounts AS (
  SELECT uid,amount FROM cash_daily UNION ALL SELECT uid,amount FROM mtt_daily
  UNION ALL SELECT from_user,-amount FROM share
  UNION ALL SELECT to_user,amount FROM share
  UNION ALL SELECT uid,amount FROM cash_edges UNION ALL SELECT uid,amount FROM mtt_edges
  UNION ALL SELECT r.user_id,-r.amount_cents/100.0
   FROM wanted w JOIN smarter_private.player_fee_redemptions r ON r.user_id=w.uid CROSS JOIN b
   WHERE r.club_id=p_club_id AND r.effective_on>=b.d AND r.effective_on<=(b.e AT TIME ZONE 'America/Chicago')::date
 ) SELECT w.uid,round(coalesce(sum(a.amount),0),2)
 FROM wanted w LEFT JOIN amounts a ON a.uid=w.uid GROUP BY w.uid;
$fn$;
REVOKE ALL ON FUNCTION public.ca_club_member_period_fee_totals(uuid,uuid[],date,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.ca_club_members_period_summary(
 p_club_id uuid,p_user_ids uuid[],p_period text DEFAULT 'overall'
) RETURNS TABLE(user_id uuid,cash numeric,mtt numeric,net numeric,fees numeric,downline_fees numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO public,pg_temp
AS $fn$
DECLARE
 v_period text:=lower(btrim(coalesce(p_period,'overall')));
 v_today date:=(now() AT TIME ZONE 'America/Chicago')::date;
 v_from date;
BEGIN
 IF v_period NOT IN ('today','week','month','overall') THEN
  RAISE EXCEPTION 'Invalid win loss period' USING ERRCODE='22023';
 END IF;
 IF coalesce(cardinality(p_user_ids),0)>100 THEN
  RAISE EXCEPTION 'At most 100 members per call' USING ERRCODE='22023';
 END IF;
 v_from:=CASE v_period WHEN 'today' THEN v_today WHEN 'week' THEN date_trunc('week',v_today::timestamp)::date
  WHEN 'month' THEN date_trunc('month',v_today::timestamp)::date ELSE NULL END;
 RETURN QUERY
 WITH RECURSIVE allowed AS MATERIALIZED (
  -- The existing reader deduplicates requested IDs and applies the exact
  -- staff/downline/service access contract before financial data is returned.
  SELECT w.* FROM public.ca_club_members_win_loss(p_club_id,p_user_ids,v_period) w
 ), edges AS MATERIALIZED (
  SELECT DISTINCT cm.agent_id parent,cm.user_id child FROM public.club_members cm
  WHERE cm.club_id=p_club_id AND cm.agent_id IS NOT NULL AND cm.agent_id<>cm.user_id
   AND coalesce(cm.status,'approved') IN ('active','approved')
 ), tree AS (
  SELECT a.user_id root,e.child descendant,ARRAY[a.user_id,e.child] path,1 depth
   FROM allowed a JOIN edges e ON e.parent=a.user_id
  UNION ALL SELECT t.root,e.child,t.path||e.child,t.depth+1
   FROM tree t JOIN edges e ON e.parent=t.descendant
   WHERE t.depth<20 AND NOT e.child=ANY(t.path)
 ), descendants AS MATERIALIZED (
  SELECT DISTINCT t.root,t.descendant FROM tree t
  WHERE public.ca_club_roster_access(p_club_id,t.descendant) IN ('staff','downline','service')
 ), fee_members AS MATERIALIZED (
  SELECT a.user_id uid FROM allowed a UNION SELECT d.descendant FROM descendants d
 ), fee_rows AS MATERIALIZED (
  SELECT f.* FROM public.ca_club_member_period_fee_totals(p_club_id,
   ARRAY(SELECT uid FROM fee_members),v_from,now()) f
 ), downline AS (
  SELECT d.root,sum(f.total_fees) total FROM descendants d JOIN fee_rows f ON f.user_id=d.descendant GROUP BY d.root
 ) SELECT a.user_id,a.cash,a.mtt,a.net,coalesce(f.total_fees,0),coalesce(d.total,0)
 FROM allowed a LEFT JOIN fee_rows f ON f.user_id=a.user_id LEFT JOIN downline d ON d.root=a.user_id;
END;
$fn$;
REVOKE ALL ON FUNCTION public.ca_club_members_period_summary(uuid,uuid[],text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ca_club_members_period_summary(uuid,uuid[],text) TO authenticated,service_role;
COMMIT;
