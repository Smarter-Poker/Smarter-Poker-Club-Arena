-- Actual transaction-triggered facts versus independently summed originals.
CREATE FUNCTION public.assert_commission_report(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'COMMISSION_REPORT_FAIL: %',label; END IF; RAISE NOTICE 'COMMISSION_REPORT_PASS: %',label; END$$;
CREATE FUNCTION public.assert_risk_commission(p_union uuid,p_since timestamptz,label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record;expected numeric;
BEGIN
 FOR r IN SELECT * FROM public.fn_union_agent_risk_report(p_union,p_since) LOOP
   SELECT ROUND(COALESCE(SUM(amount),0),2) INTO expected FROM public.agent_commissions
    WHERE user_id=r.agent_user_id AND club_id=p_union AND created_at>=p_since;
   PERFORM public.assert_commission_report(r.commission_accrued IS NOT DISTINCT FROM expected,label||' actual='||r.commission_accrued||' expected='||expected);
 END LOOP;
END$$;
SET app.engine='on';
INSERT INTO public.clubs(id,name,is_union) VALUES('91000000-0000-4000-8000-000000000001','Commission Proof',true),('91000000-0000-4000-8000-000000000002','Commission Foreign',true);
INSERT INTO public.club_members(club_id,user_id,agent_id) VALUES('91000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000001');
INSERT INTO public.agent_commissions(id,club_id,user_id,amount,created_at) VALUES
 ('94000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000001',10,(date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')-interval '2 days'),
 ('94000000-0000-4000-8000-000000000002','91000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000001',-2,(date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')-interval '1 day'),
 ('94000000-0000-4000-8000-000000000003','91000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000001',3,now()),
 ('94000000-0000-4000-8000-000000000004','91000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000001',5,now()+interval '3 days');
SELECT public.assert_risk_commission('91000000-0000-4000-8000-000000000001',now()-interval '3 days','missing complete days use original signed sums');
SELECT smarter_private.initialize_agent_commission_report_day('91000000-0000-4000-8000-000000000001',(now() AT TIME ZONE 'UTC')::date-2);
SELECT smarter_private.initialize_agent_commission_report_day('91000000-0000-4000-8000-000000000001',(now() AT TIME ZONE 'UTC')::date-1);
SELECT public.assert_risk_commission('91000000-0000-4000-8000-000000000001',now()-interval '3 days','complete UTC days plus current and future raw tail');
INSERT INTO public.agent_commissions(club_id,user_id,amount,created_at) VALUES
 ('91000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000001',-0.125,(date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')-interval '1 day'),
 ('91000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000001',NULL,(date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')-interval '1 day');
SELECT public.assert_risk_commission('91000000-0000-4000-8000-000000000001',now()-interval '3 days','backdated signed and NULL original inserts maintained atomically');
BEGIN;
INSERT INTO public.agent_commissions(club_id,user_id,amount,created_at) VALUES('91000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000001',99,now()-interval '1 day');
ROLLBACK;
SELECT public.assert_risk_commission('91000000-0000-4000-8000-000000000001',now()-interval '3 days','rolled back insert rolls back facts');
UPDATE public.agent_commissions SET settled_at=now() WHERE id='94000000-0000-4000-8000-000000000001';
SELECT public.assert_commission_report((SELECT count(*)=2 FROM smarter_private.agent_commission_report_days WHERE complete AND club_id='91000000-0000-4000-8000-000000000001'),'settled-only change preserves accrued reporting completeness');
-- A source amount change invalidates the exact day; the report then reads raw.
UPDATE public.agent_commissions SET amount=12 WHERE id='94000000-0000-4000-8000-000000000001';
SELECT public.assert_commission_report((SELECT count(*)=1 FROM smarter_private.agent_commission_report_days WHERE complete AND club_id='91000000-0000-4000-8000-000000000001'),'amount correction invalidates exact complete day');
SELECT public.assert_risk_commission('91000000-0000-4000-8000-000000000001',now()-interval '3 days','changed source uses authoritative raw fallback');
SELECT smarter_private.initialize_agent_commission_report_day('91000000-0000-4000-8000-000000000001',(now() AT TIME ZONE 'UTC')::date-2);
UPDATE public.agent_commissions SET user_id='93000000-0000-4000-8000-000000000002',club_id='91000000-0000-4000-8000-000000000002',created_at=now()-interval '1 day' WHERE id='94000000-0000-4000-8000-000000000001';
SELECT public.assert_risk_commission('91000000-0000-4000-8000-000000000001',now()-interval '3 days','moved source invalidates old and new identity day');
DELETE FROM public.agent_commissions WHERE id='94000000-0000-4000-8000-000000000002';
SELECT public.assert_risk_commission('91000000-0000-4000-8000-000000000001',now()-interval '3 days','deleted source invalidates complete day');
SET TIME ZONE 'Pacific/Kiritimati';
SELECT public.assert_risk_commission('91000000-0000-4000-8000-000000000001',now()-interval '2 days 12 hours','UTC partial head is exact across nonUTC session');
SET TIME ZONE 'America/Los_Angeles';
SELECT public.assert_risk_commission('91000000-0000-4000-8000-000000000001',now()-interval '12 days','older windows stay exact raw');
SELECT public.assert_risk_commission('91000000-0000-4000-8000-000000000001',now()+interval '1 day','future lower bound keeps future original rows');
SET TIME ZONE 'UTC';
SELECT public.assert_commission_report(NOT has_function_privilege('service_role','smarter_private.initialize_agent_commission_report_day(uuid,date)','EXECUTE') AND NOT has_table_privilege('authenticated','smarter_private.agent_commission_report_days','INSERT,UPDATE,DELETE,TRUNCATE'),'external callers cannot manufacture complete reporting facts');
-- Exact future baseline plus isolated projection of the installed UTC clock.
SELECT smarter_private.initialize_agent_commission_report_frontier('91000000-0000-4000-8000-000000000001');
SELECT public.assert_commission_report((SELECT SUM(amount)=8 FROM smarter_private.agent_commission_report_daily WHERE club_id='91000000-0000-4000-8000-000000000001' AND day>=(now() AT TIME ZONE 'UTC')::date),'frontier captures current3 plus preexisting future5');
INSERT INTO public.agent_commissions(club_id,user_id,amount,created_at) VALUES('91000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000001',-1,now()+interval '2 days');
DO $rollover$ DECLARE src text;old_clock text:=$clock$date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'$clock$;
BEGIN
 src:=pg_get_functiondef('public.fn_union_agent_risk_report(uuid,timestamptz)'::regprocedure);
 IF (length(src)-length(replace(src,old_clock,'')))/length(old_clock)<>1 THEN RAISE EXCEPTION 'ROLLOVER_CLOCK_ANCHOR_CHANGED';END IF;
 src:=replace(src,'public.fn_union_agent_risk_report(','public.fn_union_agent_risk_report_rollover(');
 src:=replace(src,old_clock,'('||old_clock||')+interval ''4 days''');
 EXECUTE src;
END;$rollover$;
SELECT public.assert_commission_report((SELECT r.commission_accrued=ROUND((SELECT COALESCE(SUM(a.amount),0) FROM agent_commissions a WHERE a.club_id='91000000-0000-4000-8000-000000000001' AND a.user_id=r.agent_user_id AND a.created_at>=now()-interval '2 days'),2) FROM public.fn_union_agent_risk_report_rollover('91000000-0000-4000-8000-000000000001',now()-interval '2 days') r),'future rows become exact closed facts without recurring initialization');
BEGIN;
UPDATE agent_commissions SET amount=11 WHERE id='94000000-0000-4000-8000-000000000004';
SELECT public.assert_commission_report((SELECT complete IS FALSE FROM smarter_private.agent_commission_report_days WHERE club_id='91000000-0000-4000-8000-000000000001' AND day=(now() AT TIME ZONE 'UTC')::date+3),'explicit future invalidation overrides frontier');
SELECT public.assert_commission_report((SELECT r.commission_accrued=ROUND((SELECT COALESCE(SUM(a.amount),0) FROM agent_commissions a WHERE a.club_id='91000000-0000-4000-8000-000000000001' AND a.user_id=r.agent_user_id AND a.created_at>=now()-interval '2 days'),2) FROM public.fn_union_agent_risk_report_rollover('91000000-0000-4000-8000-000000000001',now()-interval '2 days') r),'invalidated future day uses raw source after rollover');
ROLLBACK;
SELECT public.assert_commission_report(NOT EXISTS(SELECT 1 FROM smarter_private.agent_commission_report_days WHERE club_id='91000000-0000-4000-8000-000000000001' AND day=(now() AT TIME ZONE 'UTC')::date+3),'future correction rollback restores exact provenance');
DO $$ BEGIN BEGIN PERFORM smarter_private.initialize_agent_commission_report_frontier('91000000-0000-4000-8000-000000000001');RAISE EXCEPTION 'duplicate frontier accepted';EXCEPTION WHEN SQLSTATE '55000' THEN NULL;END;END$$;
SELECT public.assert_commission_report(NOT has_function_privilege('service_role','smarter_private.initialize_agent_commission_report_frontier(uuid)','EXECUTE'),'external caller cannot manufacture future provenance');
TRUNCATE public.agent_commissions;
SELECT public.assert_commission_report(NOT EXISTS(SELECT 1 FROM smarter_private.agent_commission_report_days),'source truncate invalidates every complete day');
SELECT public.assert_commission_report(NOT EXISTS(SELECT 1 FROM smarter_private.agent_commission_report_frontiers),'truncate invalidates future provenance');

-- 111 exact roster pairs and111,000 historical commissions. Only111 qualified
-- day facts are read after initialization; preserve independently captured
-- full output, not a warm-cache timing claim.
INSERT INTO public.clubs(id,name,is_union) VALUES('97000000-0000-4000-8000-000000000001','Reporting Work Bound',true);
INSERT INTO public.club_members(club_id,user_id,agent_id)
 SELECT '97000000-0000-4000-8000-000000000001',md5('commission-player-'||g)::uuid,md5('commission-agent-'||g)::uuid FROM generate_series(1,111)g;
INSERT INTO public.agent_commissions(club_id,user_id,amount,created_at)
 SELECT '97000000-0000-4000-8000-000000000001',md5('commission-agent-'||a)::uuid,CASE WHEN n%10=0 THEN -0.01 ELSE 0.02 END,
 ((now() AT TIME ZONE 'UTC')::date-1)::timestamp AT TIME ZONE 'UTC'
 FROM generate_series(1,111)a CROSS JOIN generate_series(1,1000)n;
CREATE TEMP TABLE commission_raw_baseline AS SELECT * FROM public.fn_union_agent_risk_report('97000000-0000-4000-8000-000000000001',now()-interval '3 days');
SELECT smarter_private.initialize_agent_commission_report_day('97000000-0000-4000-8000-000000000001',(now() AT TIME ZONE 'UTC')::date-1);
DO $$DECLARE delta bigint;started timestamptz:=clock_timestamp();BEGIN
 SELECT count(*) INTO delta FROM (
  (SELECT * FROM commission_raw_baseline EXCEPT SELECT * FROM public.fn_union_agent_risk_report('97000000-0000-4000-8000-000000000001',now()-interval '3 days'))
  UNION ALL
  (SELECT * FROM public.fn_union_agent_risk_report('97000000-0000-4000-8000-000000000001',now()-interval '3 days') EXCEPT SELECT * FROM commission_raw_baseline)
 )d;
 PERFORM public.assert_commission_report(delta=0,'111pairs full output equals independently captured original raw sums');
 PERFORM public.assert_commission_report((SELECT count(*)=111 FROM smarter_private.agent_commission_report_daily WHERE club_id='97000000-0000-4000-8000-000000000001'),'111000 source rows represented by111 exact complete day facts');
 RAISE NOTICE 'COMMISSION_COMPLETE_DAY_REPORT_MS %',extract(epoch FROM clock_timestamp()-started)*1000;
END$$;

-- The journal maintenance route may replace a source primary key with other fields.
INSERT INTO agent_commissions(id,club_id,user_id,amount,created_at) VALUES('98000000-0000-4000-8000-000000000001','97000000-0000-4000-8000-000000000001',md5('commission-agent-1')::uuid,3,((now() AT TIME ZONE 'UTC')::date-2)::timestamp AT TIME ZONE 'UTC');
SELECT smarter_private.initialize_agent_commission_report_day('97000000-0000-4000-8000-000000000001',(now() AT TIME ZONE 'UTC')::date-2);
BEGIN;
UPDATE agent_commissions SET id='98000000-0000-4000-8000-000000000002',amount=-7,user_id=md5('commission-agent-2')::uuid,created_at=((now() AT TIME ZONE 'UTC')::date-1)::timestamp AT TIME ZONE 'UTC' WHERE id='98000000-0000-4000-8000-000000000001';
SELECT public.assert_commission_report((SELECT count(*)=0 FROM smarter_private.agent_commission_report_days WHERE club_id='97000000-0000-4000-8000-000000000001' AND day IN((now() AT TIME ZONE 'UTC')::date-1,(now() AT TIME ZONE 'UTC')::date-2) AND complete),'source identity plus amount/user/day replacement invalidates both original and new day');
ROLLBACK;
SELECT public.assert_commission_report((SELECT count(*)=2 FROM smarter_private.agent_commission_report_days WHERE club_id='97000000-0000-4000-8000-000000000001' AND day IN((now() AT TIME ZONE 'UTC')::date-1,(now() AT TIME ZONE 'UTC')::date-2) AND complete),'source identity replacement rollback restores complete original facts');
UPDATE agent_commissions SET id='98000000-0000-4000-8000-000000000002',amount=-7,user_id=md5('commission-agent-2')::uuid,created_at=((now() AT TIME ZONE 'UTC')::date-1)::timestamp AT TIME ZONE 'UTC' WHERE id='98000000-0000-4000-8000-000000000001';
SELECT public.assert_commission_report((SELECT count(*)=0 FROM smarter_private.agent_commission_report_days WHERE club_id='97000000-0000-4000-8000-000000000001' AND day IN((now() AT TIME ZONE 'UTC')::date-1,(now() AT TIME ZONE 'UTC')::date-2) AND complete),'committed source identity replacement uses raw fallback');
SELECT public.assert_risk_commission('97000000-0000-4000-8000-000000000001',now()-interval '3 days','source identity replacement exact raw financial sum');
