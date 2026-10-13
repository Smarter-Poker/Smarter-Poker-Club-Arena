CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth; CREATE SCHEMA smarter_private;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULL::uuid$$;
CREATE FUNCTION public.fn_is_club_admin_uid(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('fixture.cost',true) IS DISTINCT FROM 'false'$$;
CREATE FUNCTION public.fn_is_union_overseer(uuid,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;
CREATE FUNCTION public.fn_is_agent_ancestor(uuid,uuid,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;
CREATE FUNCTION public.fn_arena_name(text,text,text,text,text,text) RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT coalesce($1,$2,$3,$6)$$;
CREATE FUNCTION public.fn_like_escape(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT replace(replace(replace($1,'\','\\'),'%','\%'),'_','\_')$$;
CREATE TABLE public.union_clubs(club_id uuid,union_id uuid);
CREATE TABLE public.club_rake_rollup_complete(club_id uuid,day date);
CREATE TABLE public.club_rake_daily_user(club_id uuid,day date,user_id uuid,rake_amount numeric,hands bigint);
CREATE TABLE public.ca_club_rake_daily_user(club_id uuid,day date,user_id uuid,rake_cents bigint,hands bigint);
CREATE TABLE public.agent_commissions(id bigint GENERATED ALWAYS AS IDENTITY,club_id uuid,user_id uuid,created_at timestamptz,settled_at timestamptz,amount numeric);
CREATE INDEX idx_agent_commissions_club_created ON public.agent_commissions(club_id,created_at) INCLUDE(user_id,amount,settled_at);
CREATE INDEX idx_agent_commissions_risk_window ON public.agent_commissions(club_id,user_id,created_at) INCLUDE(amount);
CREATE INDEX agent_commissions_open_idx ON public.agent_commissions(club_id,user_id,created_at) INCLUDE(amount,id) WHERE settled_at IS NULL;
CREATE TABLE public.agent_commission_settlements(club_id uuid,user_id uuid,period_start timestamptz,period_end timestamptz);
CREATE FUNCTION public.fn_agent_commission_paid_by_period(uuid,uuid,timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT EXISTS(SELECT 1 FROM public.agent_commission_settlements s WHERE s.club_id=$1 AND s.user_id=$2 AND $3>=s.period_start AND $3<s.period_end)$$;
CREATE TABLE public.agents(id uuid,user_id uuid,parent_agent_id uuid,role text,commission_rate numeric,status text,club_id uuid);
CREATE TABLE public.club_members(club_id uuid,user_id uuid,agent_id uuid);
CREATE TABLE public.profiles(id uuid,alias text,username text,display_name text,first_name text,last_name text,full_name text,avatar_url text);
CREATE TABLE smarter_private.agent_commission_report_daily(club_id uuid,day date,user_id uuid,amount numeric NOT NULL,PRIMARY KEY(club_id,day,user_id));
CREATE TABLE smarter_private.agent_commission_report_days(club_id uuid,day date,complete boolean,computed_at timestamptz DEFAULT clock_timestamp(),PRIMARY KEY(club_id,day));
CREATE TABLE smarter_private.agent_commission_report_frontiers(club_id uuid PRIMARY KEY,first_complete_day date,computed_at timestamptz DEFAULT clock_timestamp());
INSERT INTO public.agents VALUES('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',NULL,'agent',0.5,'active','a41434bb-8d0c-400a-8f0d-e8b3d65afed4');
INSERT INTO public.profiles(id,username)VALUES('00000000-0000-0000-0000-000000000001','Agent One');
INSERT INTO public.agent_commissions(club_id,user_id,created_at,settled_at,amount)
SELECT 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid,('00000000-0000-0000-0000-'||lpad(u::text,12,'0'))::uuid,
 date_trunc('day',now())-interval '3 days'+n*interval '1 hour',CASE WHEN n%4=0 THEN now() END,
 CASE WHEN n%7=0 THEN NULL WHEN n%5=0 THEN -2.345 ELSE n*0.123 END
 FROM generate_series(1,5)u CROSS JOIN generate_series(0,50)n;
-- Unlisted all outstanding, settled NULL; numeric cancellation and all-null groups.
INSERT INTO public.agent_commissions(club_id,user_id,created_at,amount) VALUES
('a41434bb-8d0c-400a-8f0d-e8b3d65afed4','00000000-0000-0000-0000-000000000007',now()-interval '2 days',5),
('a41434bb-8d0c-400a-8f0d-e8b3d65afed4','00000000-0000-0000-0000-000000000008',now()-interval '2 days',NULL),
('a41434bb-8d0c-400a-8f0d-e8b3d65afed4',NULL,now()-interval '2 days',3.3);
INSERT INTO public.agent_commission_settlements SELECT 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4',('00000000-0000-0000-0000-'||lpad(u::text,12,'0'))::uuid,
 date_trunc('day',now())-interval '3 days'+n*interval '6 hours',date_trunc('day',now())-interval '3 days'+(n+2)*interval '6 hours'
 FROM generate_series(1,5)u CROSS JOIN generate_series(0,3)n;
INSERT INTO public.agent_commission_settlements VALUES('a41434bb-8d0c-400a-8f0d-e8b3d65afed4','00000000-0000-0000-0000-000000000002',now(),now()-interval '1 day'),('a41434bb-8d0c-400a-8f0d-e8b3d65afed4','00000000-0000-0000-0000-000000000003',NULL,now());
INSERT INTO public.agent_commissions(club_id,user_id,created_at,settled_at,amount)
SELECT 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4',('00000000-0000-0000-0000-'||lpad((u+20)::text,12,'0'))::uuid,now()-interval '2 days',CASE WHEN n=2 THEN now() END,CASE WHEN n=2 THEN 3.456 ELSE amount END
FROM (VALUES(1,'Infinity'::numeric),(2,'-Infinity'::numeric),(3,'NaN'::numeric))v(u,amount) CROSS JOIN generate_series(1,2)n;
INSERT INTO smarter_private.agent_commission_report_daily SELECT club_id,(created_at AT TIME ZONE 'UTC')::date,user_id,coalesce(sum(amount),0) FROM public.agent_commissions WHERE user_id IS NOT NULL GROUP BY 1,2,3;
INSERT INTO smarter_private.agent_commission_report_frontiers VALUES('a41434bb-8d0c-400a-8f0d-e8b3d65afed4',current_date-3,now());
-- Explicit invalidation must trump frontier and fall back to the raw journal.
INSERT INTO smarter_private.agent_commission_report_days VALUES('a41434bb-8d0c-400a-8f0d-e8b3d65afed4',current_date-2,false,now());

CREATE TABLE public.agent_commission_unsettled_rollup(club_id uuid,user_id uuid,owed numeric,rows_behind bigint,oldest_unsettled timestamptz,updated_at timestamptz,PRIMARY KEY(club_id,user_id));
CREATE TABLE public.ca_club_commission_daily(club_id uuid,stat_date date,amount numeric,rows_counted bigint,updated_at timestamptz,PRIMARY KEY(club_id,stat_date));
UPDATE smarter_private.agent_commission_report_daily SET amount=amount+100000 WHERE day=current_date-2;
CREATE FUNCTION smarter_private.invalidate_agent_commission_report_days()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog,public,smarter_private AS $function$
DECLARE c uuid;affected jsonb;
BEGIN
 IF TG_OP='TRUNCATE' THEN
   FOR c IN SELECT club_id FROM smarter_private.agent_commission_report_days UNION SELECT club_id FROM smarter_private.agent_commission_report_frontiers ORDER BY club_id LOOP
     PERFORM pg_advisory_xact_lock(hashtextextended('agent-commission:'||c::text,0));
   END LOOP;
   DELETE FROM smarter_private.agent_commission_report_days;
   DELETE FROM smarter_private.agent_commission_report_frontiers;
   RETURN NULL;
 ELSIF TG_OP='UPDATE' THEN
   SELECT jsonb_agg(DISTINCT jsonb_build_object('club',x.club_id,'day',(x.created_at AT TIME ZONE 'UTC')::date)) INTO affected
   FROM (
     SELECT o.club_id,o.created_at FROM old_rows o FULL JOIN new_rows n USING(id)
      WHERE o.id IS NULL OR n.id IS NULL OR o.amount IS DISTINCT FROM n.amount OR o.user_id IS DISTINCT FROM n.user_id
         OR o.club_id IS DISTINCT FROM n.club_id OR o.created_at IS DISTINCT FROM n.created_at
     UNION ALL
     SELECT n.club_id,n.created_at FROM old_rows o FULL JOIN new_rows n USING(id)
      WHERE o.id IS NULL OR n.id IS NULL OR o.amount IS DISTINCT FROM n.amount OR o.user_id IS DISTINCT FROM n.user_id
         OR o.club_id IS DISTINCT FROM n.club_id OR o.created_at IS DISTINCT FROM n.created_at
   )x WHERE x.club_id IS NOT NULL AND x.created_at IS NOT NULL;
 ELSE
   SELECT jsonb_agg(DISTINCT jsonb_build_object('club',o.club_id,'day',(o.created_at AT TIME ZONE 'UTC')::date))
    INTO affected FROM old_rows o WHERE o.club_id IS NOT NULL AND o.created_at IS NOT NULL;
 END IF;
 FOR c IN SELECT DISTINCT (x->>'club')::uuid FROM jsonb_array_elements(affected)x ORDER BY 1 LOOP
   PERFORM pg_advisory_xact_lock(hashtextextended('agent-commission:'||c::text,0));
 END LOOP;
 INSERT INTO smarter_private.agent_commission_report_days(club_id,day,complete)
 SELECT DISTINCT (x->>'club')::uuid,(x->>'day')::date,false FROM jsonb_array_elements(affected)x
 ON CONFLICT(club_id,day) DO UPDATE SET complete=false,computed_at=clock_timestamp();
 RETURN NULL;
END;$function$;
ALTER FUNCTION smarter_private.invalidate_agent_commission_report_days() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.invalidate_agent_commission_report_days() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER zz_commission_report_invalidate_update AFTER UPDATE ON public.agent_commissions
 REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
 EXECUTE FUNCTION smarter_private.invalidate_agent_commission_report_days();
CREATE TRIGGER zz_commission_report_invalidate_delete AFTER DELETE ON public.agent_commissions
 REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
 EXECUTE FUNCTION smarter_private.invalidate_agent_commission_report_days();
CREATE TRIGGER zz_commission_report_invalidate_truncate AFTER TRUNCATE ON public.agent_commissions
 FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.invalidate_agent_commission_report_days();
CREATE OR REPLACE FUNCTION public.trg_agent_commission_rollup_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_club uuid;
BEGIN
  /* ONE KEY PER CLUB, IN CLUB ORDER, BEFORE ITS ROLLUP ROWS (2026-10-01).
     Each commission row takes its agent's unsettled row and then the club's
     day row, so a writer with two tiers held the day row while it asked for
     its second agent's row - which a tournament finish, holding that agent's
     row, was waiting to pass on its way to the day row. The club's
     commission key comes first, in club order: the cash accrual batch takes
     every key it will need before its first item (fn_credit_agent_commissions_batch,
     fn_retry_cash_accounting_sources), a finish takes them here source by
     source in club order, and within one club only its holder writes these
     rows. The sums below are unchanged. */
  FOR v_club IN SELECT DISTINCT n.club_id FROM new_rows n WHERE n.club_id IS NOT NULL ORDER BY n.club_id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('agent-commission:'||v_club::text,0));
  END LOOP;

  INSERT INTO public.agent_commission_unsettled_rollup AS r
         (club_id, user_id, owed, rows_behind, oldest_unsettled, updated_at)
  SELECT n.club_id, n.user_id,
         sum(n.amount), count(*), min(n.created_at), now()
    FROM new_rows n
   WHERE n.settled_at IS NULL AND n.club_id IS NOT NULL AND n.user_id IS NOT NULL
     AND NOT public.fn_agent_commission_paid_by_period(n.club_id, n.user_id, n.created_at)
   GROUP BY n.club_id, n.user_id
  ON CONFLICT (club_id, user_id) DO UPDATE
     SET owed             = r.owed + EXCLUDED.owed,
         rows_behind      = r.rows_behind + EXCLUDED.rows_behind,
         oldest_unsettled = least(r.oldest_unsettled, EXCLUDED.oldest_unsettled),
         updated_at       = now();

  -- Phase 6: the per-day total the Financials page reads.
  INSERT INTO public.ca_club_commission_daily AS c
         (club_id, stat_date, amount, rows_counted, updated_at)
  SELECT n.club_id, (n.created_at AT TIME ZONE 'UTC')::date, sum(n.amount), count(*), now()
    FROM new_rows n
   WHERE n.club_id IS NOT NULL
   GROUP BY n.club_id, (n.created_at AT TIME ZONE 'UTC')::date
  ON CONFLICT (club_id, stat_date) DO UPDATE
     SET amount       = c.amount + EXCLUDED.amount,
         rows_counted = c.rows_counted + EXCLUDED.rows_counted,
         updated_at   = now();
  -- Original INSERT deltas are synchronous, even for not-yet-qualified days.
  -- Such rows remain unread until an explicit locked baseline marks completeness.
  INSERT INTO smarter_private.agent_commission_report_daily AS d(club_id,day,user_id,amount)
  SELECT n.club_id,(n.created_at AT TIME ZONE 'UTC')::date,n.user_id,COALESCE(SUM(n.amount),0)
    FROM new_rows n
   WHERE n.club_id IS NOT NULL AND n.user_id IS NOT NULL AND n.created_at IS NOT NULL
   GROUP BY n.club_id,(n.created_at AT TIME ZONE 'UTC')::date,n.user_id
  ON CONFLICT(club_id,day,user_id) DO UPDATE SET amount=d.amount+EXCLUDED.amount;
  RETURN NULL;
END;
$function$
;

REVOKE ALL ON FUNCTION public.trg_agent_commission_rollup_insert() FROM PUBLIC,anon,authenticated;GRANT EXECUTE ON FUNCTION public.trg_agent_commission_rollup_insert() TO service_role;
CREATE TRIGGER trg_agent_commission_rollup_ins AFTER INSERT ON public.agent_commissions REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.trg_agent_commission_rollup_insert();
