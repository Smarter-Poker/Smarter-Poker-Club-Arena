-- Historical club attribution changes rebuild their daily facts as one set.
-- The former per-key loop repeatedly read the same club/day and exhausted the
-- weekly incident's four-minute statement limit. Keep the same affected keys,
-- source amounts, original earning-time cutoff, UTC day identity and rollback
-- warning behavior. No financial source, wallet, payment or schedule changes.
-- @live-proof: position('affected daily reporting keys as one set' in pg_get_functiondef('public.trg_ca_club_rake_daily_user_change()'::regprocedure))>0
BEGIN;
SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='15s';
DO $preimage$ BEGIN
IF md5(pg_get_functiondef('public.trg_ca_club_rake_daily_user_change()'::regprocedure))<>'5d62cbb47cc2763e74bb7d981f22daa6'
 OR md5(pg_get_functiondef('public.fn_ca_launch_accounting_accepts(uuid,timestamptz)'::regprocedure))<>'0f902b31908c9b6634635c1fab7363c4'
 OR md5(pg_get_functiondef('public.fn_ca_club_rake_daily_user_rebuild_day(uuid,date,uuid)'::regprocedure))<>'7638cb684f41d5a737e7871d2db7ab06'
THEN RAISE EXCEPTION 'daily_reporting_owner_preimage_changed';END IF;END $preimage$;
CREATE OR REPLACE FUNCTION public.trg_ca_club_rake_daily_user_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
 -- Rebuild affected daily reporting keys as one set, retaining the original
 -- earning-time predicate and exact aggregate. Both transition tables are
 -- read inside this statement's snapshot, just as the original loop did.
 WITH keys AS MATERIALIZED (
 SELECT club_id,day,user_id FROM (
 SELECT o.club_id,(o.created_at AT TIME ZONE 'UTC')::date AS day,o.player_id AS user_id FROM old_rows o
 UNION SELECT n.club_id,(n.created_at AT TIME ZONE 'UTC')::date,n.player_id FROM new_rows n)k
 WHERE club_id IS NOT NULL AND user_id IS NOT NULL)
 DELETE FROM public.ca_club_rake_daily_user d USING keys k
 WHERE d.club_id=k.club_id AND d.day=k.day AND d.user_id=k.user_id;
 WITH keys AS MATERIALIZED (
 SELECT club_id,day,user_id FROM (
 SELECT o.club_id,(o.created_at AT TIME ZONE 'UTC')::date AS day,o.player_id AS user_id FROM old_rows o
 UNION SELECT n.club_id,(n.created_at AT TIME ZONE 'UTC')::date,n.player_id FROM new_rows n)k
 WHERE club_id IS NOT NULL AND user_id IS NOT NULL),
 cutoffs AS MATERIALIZED (SELECT club_id,public.fn_ca_launch_accounting_cutoff('club',club_id) AS cutoff FROM (SELECT DISTINCT club_id FROM keys)c)
 INSERT INTO public.ca_club_rake_daily_user(club_id,day,user_id,rake_cents,hands,updated_at)
 SELECT k.club_id,k.day,k.user_id,SUM(round(ra.rake_amount*100))::bigint,count(*)::bigint,now()
 FROM keys k JOIN public.rake_attributions ra ON ra.club_id=k.club_id AND ra.player_id=k.user_id
 AND ra.created_at>=k.day::timestamptz AND ra.created_at<(k.day+1)::timestamptz
 JOIN cutoffs c ON c.club_id=ra.club_id
 LEFT JOIN public.rake_records rr ON rr.id=ra.rake_record_id
 WHERE ra.player_id IS NOT NULL AND ra.rake_amount>0
 AND CASE WHEN c.cutoff IS NULL THEN true ELSE rr.created_at IS NOT NULL AND isfinite(rr.created_at) AND rr.created_at>=c.cutoff END
 GROUP BY k.club_id,k.day,k.user_id;
 RETURN NULL;
EXCEPTION WHEN OTHERS THEN
 RAISE WARNING 'ca_club_rake_daily_user change rollup failed: %',SQLERRM;
 RETURN NULL;
END;$function$;
COMMIT;
