-- Compare authentic launch-clamped source and optimized reader at no boundary,
-- midnight boundary, partial-day boundary, after-range boundary, and undone boundary.
DO $$DECLARE cutoff timestamptz;undone boolean;a jsonb;b jsonb;r record;cost text;BEGIN
 FOR cutoff IN SELECT unnest(ARRAY[NULL::timestamptz,(current_date-2)::timestamptz,(current_date-2)::timestamptz+interval '12 hours',now()+interval '1 day']) LOOP
 FOR undone IN SELECT unnest(ARRAY[false,true]) LOOP
 DELETE FROM public.ca_launch_accounting_boundaries;
 INSERT INTO public.ca_launch_accounting_boundaries VALUES('club','a41434bb-8d0c-400a-8f0d-e8b3d65afed4',cutoff,CASE WHEN undone THEN now() END);
 FOR cost IN SELECT unnest(ARRAY['true','false']) LOOP
 PERFORM set_config('fixture.cost',cost,false);
 FOR r IN SELECT s,d FROM (VALUES(current_date-30,current_date),(current_date-3,current_date-3),(current_date-2,current_date-2),(current_date-1,current_date),(current_date,current_date))x(s,d) LOOP
 a:=public.fixture_original_rake_by_agent('a41434bb-8d0c-400a-8f0d-e8b3d65afed4',r.s,r.d,200,0,NULL,'cost');
 b:=public.fn_ca_rake_by_agent('a41434bb-8d0c-400a-8f0d-e8b3d65afed4',r.s,r.d,200,0,NULL,'cost');
 IF a IS DISTINCT FROM b THEN RAISE EXCEPTION 'RAKE_LAUNCH_CLAMP_EQUIVALENCE_FAILURE cutoff %, undone %, range %, expected %, got %',cutoff,undone,row_to_json(r),a,b;END IF;
 IF NOT undone AND cutoff IS NOT NULL AND LEAST((r.d+1)::timestamptz,now())<=cutoff AND b<>jsonb_build_object('rows','[]'::jsonb,'total',0,'total_direct',0,'total_commission',NULL) THEN RAISE EXCEPTION 'RAKE_LAUNCH_CLAMP_EMPTY_FAILURE';END IF;
 END LOOP;END LOOP;END LOOP;END LOOP;
 DELETE FROM public.ca_launch_accounting_boundaries;
END$$;
SELECT 'RAKE_LAUNCH_CLAMP_EQUIVALENCE_PASS';

DO $$ DECLARE a jsonb;b jsonb; r record;cost text; BEGIN
FOR cost IN SELECT unnest(ARRAY['true','false']) LOOP
PERFORM set_config('fixture.cost',cost,false);
FOR r IN SELECT s,d,sort,q,lim,off FROM (VALUES(current_date-30,current_date),(current_date-3,current_date-2),(current_date-2,current_date-2),(current_date-1,current_date),(current_date,current_date),(current_date-731,current_date),(current_date+2,current_date+1))x(s,d) CROSS JOIN unnest(ARRAY['rake','name','cost','players'])sort CROSS JOIN unnest(ARRAY[NULL::text,'agent','unlisted','no match'])q CROSS JOIN unnest(ARRAY[1,200])lim CROSS JOIN unnest(ARRAY[0,1,200])off LOOP
 a:=public.fixture_original_rake_by_agent('a41434bb-8d0c-400a-8f0d-e8b3d65afed4',r.s,r.d,r.lim,r.off,r.q,r.sort);
 b:=public.fn_ca_rake_by_agent('a41434bb-8d0c-400a-8f0d-e8b3d65afed4',r.s,r.d,r.lim,r.off,r.q,r.sort);
 IF a IS DISTINCT FROM b THEN RAISE EXCEPTION 'RAKE_EQUIVALENCE_FAILURE %, cost %, expected %, got %',row_to_json(r),cost,a,b; END IF;
END LOOP;END LOOP;END $$;
SELECT 'RAKE_AGENT_JSON_EQUIVALENCE_PASS';

DO $$DECLARE v bigint;expected numeric;actual numeric; BEGIN
 -- Older than the pre-existing seven-day helper, bounded to one closed day.
 v:=smarter_private.qualify_rake_agent_report_day('a41434bb-8d0c-400a-8f0d-e8b3d65afed4',current_date-100);
 IF v<>0 THEN RAISE EXCEPTION 'empty baseline not empty';END IF;
 BEGIN PERFORM smarter_private.qualify_rake_agent_report_day('a41434bb-8d0c-400a-8f0d-e8b3d65afed4',current_date-100);RAISE EXCEPTION 'baseline replay accepted';EXCEPTION WHEN SQLSTATE '55000' THEN NULL;END;
 BEGIN PERFORM smarter_private.qualify_rake_agent_report_day('a41434bb-8d0c-400a-8f0d-e8b3d65afed4',current_date);RAISE EXCEPTION 'today accepted';EXCEPTION WHEN SQLSTATE '22023' THEN NULL;END;
 BEGIN PERFORM smarter_private.qualify_rake_agent_report_day('a41434bb-8d0c-400a-8f0d-e8b3d65afed4',current_date-732);RAISE EXCEPTION 'out of bounds accepted';EXCEPTION WHEN SQLSTATE '22023' THEN NULL;END;
 -- The original INSERT updates even an explicitly qualified historical day.
 INSERT INTO public.agent_commissions(club_id,user_id,created_at,amount) VALUES('a41434bb-8d0c-400a-8f0d-e8b3d65afed4','00000000-0000-0000-0000-000000000007',(current_date-100)::timestamptz,1.2345);
 SELECT amount INTO actual FROM smarter_private.agent_commission_report_daily WHERE club_id='a41434bb-8d0c-400a-8f0d-e8b3d65afed4' AND day=current_date-100;
 IF actual IS DISTINCT FROM 1.2345 THEN RAISE EXCEPTION 'backdated original insert not synchronous';END IF;
 -- A false marker overrides frontier, remains readable from raw source and
 -- may be explicitly qualified once from the locked fresh snapshot.
 v:=smarter_private.qualify_rake_agent_report_day('a41434bb-8d0c-400a-8f0d-e8b3d65afed4',current_date-2);
 SELECT sum(amount) INTO expected FROM public.agent_commissions WHERE user_id IS NOT NULL AND created_at>=((current_date-2)::timestamp AT TIME ZONE 'UTC') AND created_at<((current_date-1)::timestamp AT TIME ZONE 'UTC');
 SELECT sum(amount) INTO actual FROM smarter_private.agent_commission_report_daily WHERE day=current_date-2;
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'qualification mismatch expected % actual %',expected,actual;END IF;
END$$;
BEGIN ISOLATION LEVEL REPEATABLE READ;
DO $$ BEGIN BEGIN PERFORM smarter_private.qualify_rake_agent_report_day('a41434bb-8d0c-400a-8f0d-e8b3d65afed4',current_date-99);RAISE EXCEPTION 'old snapshot accepted'; EXCEPTION WHEN SQLSTATE '25001' THEN NULL;END;END$$;
ROLLBACK;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a WHERE p.oid='smarter_private.qualify_rake_agent_report_day(uuid,date)'::regprocedure AND a.grantee<>'postgres'::regrole) THEN RAISE EXCEPTION 'baseline ACL exposure';END IF;END$$;
SELECT 'RAKE_AGENT_BASELINE_GUARDS_PASS';

BEGIN;
SELECT smarter_private.qualify_rake_agent_report_day('a41434bb-8d0c-400a-8f0d-e8b3d65afed4',current_date-102);
ROLLBACK;
DO $$BEGIN IF EXISTS(SELECT 1 FROM smarter_private.agent_commission_report_days WHERE club_id='a41434bb-8d0c-400a-8f0d-e8b3d65afed4' AND day=current_date-102) THEN RAISE EXCEPTION 'baseline rollback persisted';END IF;END$$;
-- The unchanged source invalidation trigger makes altered qualified days unread.
UPDATE public.agent_commissions SET amount=amount+1 WHERE user_id='00000000-0000-0000-0000-000000000007' AND created_at>=((current_date-100)::timestamp AT TIME ZONE 'UTC') AND created_at<((current_date-99)::timestamp AT TIME ZONE 'UTC');
DO $$BEGIN IF (SELECT complete FROM smarter_private.agent_commission_report_days WHERE club_id='a41434bb-8d0c-400a-8f0d-e8b3d65afed4' AND day=current_date-100) IS DISTINCT FROM false THEN RAISE EXCEPTION 'original invalidation not connected';END IF;END$$;
