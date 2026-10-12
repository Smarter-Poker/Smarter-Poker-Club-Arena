-- 20261003141618_round_two_is_planned_two_hours_at_a_time.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ROUND TWO IS PLANNED TWO HOURS AT A TIME
--
-- Round 2 (fn_settle_accounting_commission_stage) reads the closed week's
-- sources, their recorded commission tiers and every commission row of every
-- source, builds the payee plan and pays it, in one transaction. Measured on
-- 2026-10-03 for one day of Midway's week of 2026-09-21 (48.6k sources,
-- job 424): read 3.6 s, commission rows 22.9 s, ~0.6 ms a source; the week
-- closing 2026-10-05 (~1.75M sources projected) needs ~17 minutes at low load
-- in that one transaction, past the 5-minute cap on every close transaction
-- (transactions over ~9 minutes expire tournament leases).
--
-- WHAT CHANGES, ONLY IN A CHUNKED CLOSE (job 272 sets
-- app.weekly_accounting_chunked):
--  1. fn_settle_accounting_commission_window runs the stage's own reads and
--     tests over one two-hour window of the week: every test is of one source
--     (its tiers, its parent chain, its commission rows) or of one commission
--     row of the window's instant, so the week passes exactly when every
--     window does; the one test across sources (a (club, user) with one agent
--     and one role) is kept as each window's min and max. It returns the
--     window's counts, its payee sums per (club, user), its edge sums per
--     (club, payer, payee), its clubs and every source's row md5 with its id.
--  2. fn_accounting_close_windows_pending, called by the scheduler after a
--     successful preparation, proves the missing round-2 windows of a book
--     whose round 2 has no receipt (fn_settle_accounting_commission_advance:
--     at least one per attempt, none started more than 120 s after the attempt
--     began) into accounting_close_partials, and ends that attempt as a
--     committed 'prepared' step; nothing is paid in it.
--  3. In the attempt that finds every window, the stage combines them
--     (fn_settle_accounting_commission_combine) into exactly the plan its own
--     reads build: the same _routed_nodes (sum of own amounts, rows, min agent
--     and role), the same _routed_edges (sums over the week, kept when > 0),
--     the same clubs and the same fingerprint (md5 of every row md5 in
--     (source_type, source_id) order), and refuses as it refuses: a changed
--     paid source, a legacy payment, an unclassified commission row, an
--     ambiguous hierarchy, an entitlement that disagrees. From there on the
--     stage is unchanged: the same hierarchy order, conservation tests, locks,
--     transfers, invoices, settlements, rollup and receipt. A window whose
--     contracts only the original v3 path can read refuses
--     (routed_commission_window_needs_full_path) instead of running v3 in one
--     long transaction; nothing is paid.
-- Outside a chunked close, or if any window is missing, the stage reads the
-- week itself exactly as before.
--
-- PROOF: Midway's closed week 2026-09-21..28 is combined from its windows and
-- compared with what the single-transaction close paid on 2026-10-01: the
-- receipt fingerprint and sources, the agent_commission_settlements rows and
-- the commission chip_ledger transfers; the result is recorded in
-- docs/changelog/2026-10-03-round-two-is-planned-two-hours-at-a-time.md.
--
-- @live-proof: to_regprocedure('public.fn_settle_accounting_commission_combine(text,uuid,timestamptz,timestamptz)') IS NOT NULL
-- @live-proof: position('fn_settle_accounting_commission_combine' in pg_get_functiondef('public.fn_settle_accounting_commission_stage(text,uuid,timestamptz,timestamptz)'::regprocedure)) > 0
-- @live-proof: position('fn_accounting_close_windows_pending' in pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure)) > 0
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '90s';

ALTER TABLE public.accounting_close_partials DROP CONSTRAINT accounting_close_partials_kind_check;
ALTER TABLE public.accounting_close_partials ADD CONSTRAINT accounting_close_partials_kind_check
  CHECK (kind IN ('earned_plan_window','round2_union_window','round2_club_window','round3_union_window','round3_club_window'));
COMMENT ON COLUMN public.accounting_close_partials.union_id IS
  'The book: the union for earned_plan_window and the *_union_window kinds, the standalone club for the *_club_window kinds.';

CREATE FUNCTION public.fn_settle_accounting_commission_window(p_union_id uuid, p_standalone_club_id uuid, p_club_ids uuid[], p_window_start timestamptz, p_window_end timestamptz)
 RETURNS TABLE(value jsonb, cash_ids uuid[], cash_md5 bytea, fee_ids uuid[], fee_md5 bytea)
 LANGUAGE plpgsql
 VOLATILE
 SET search_path TO 'public'
AS $f$
-- ONE WINDOW OF ROUND 2 (chunked close, 20261003): the reads and tests of
-- fn_settle_accounting_commission_stage (its v4 set path), over the sources
-- earned in p_window_start..p_window_end and the commission rows created then,
-- for the book fn_resolve_accounting_routing_scope resolved for the week
-- (its union or standalone club and its club_ids), resolved once by the caller.
DECLARE v_union uuid:=p_union_id; v_standalone uuid:=p_standalone_club_id; n bigint; read_failed boolean:=false; odd bigint:=0; tiers_failed boolean:=false;
 c_unc bigint:=0; c_tier bigint:=0; c_dup bigint:=0; e1 bigint:=0; e2 bigint:=0; e3 bigint:=0;
 v_nodes jsonb:='[]'; v_edges jsonb:='[]'; v_clubs jsonb:='[]'; d record;
BEGIN
 CREATE TEMP TABLE IF NOT EXISTS _rw_sources(source_type text,source_id uuid,club_id uuid,earned_at timestamptz,tiers jsonb,tiers_type text,contract_club text,row_md5 text,PRIMARY KEY(source_type,source_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._rw_sources;
 BEGIN
  INSERT INTO pg_temp._rw_sources SELECT source_type,source_id,club_id,earned_at,contract->'tiers',jsonb_typeof(contract->'tiers'),contract->>'club_id',
   md5((CASE WHEN source_type='cash_rake_accrual' THEN jsonb_build_array(source_id,club_id,earned_at,contract) ELSE jsonb_build_array(source_type,source_id,club_id,earned_at,contract) END)::text)
   FROM public.accounting_payable_earning_sources
   WHERE (coordinator_union_id=v_union OR (v_standalone IS NOT NULL AND coordinator_union_id IS NULL AND club_id=v_standalone)) AND earned_at>=p_window_start AND earned_at<p_window_end;
 EXCEPTION WHEN OTHERS THEN read_failed:=true;
 END;
 IF read_failed THEN
  RETURN QUERY SELECT jsonb_build_object('read_failed',true),NULL::uuid[],NULL::bytea,NULL::uuid[],NULL::bytea;
  RETURN;
 END IF;
 SELECT count(*) INTO n FROM pg_temp._rw_sources;
 -- The stage's unclassified-commission test, for the commission rows created
 -- in this window (a row matches only a source earned at the same instant).
 SELECT count(*) INTO c_unc FROM (WITH club_week AS MATERIALIZED (
   SELECT rs.source_type,rs.source_id,rs.club_id,rs.earned_at FROM public.accounting_payable_earning_sources rs
    WHERE rs.club_id=ANY(p_club_ids) AND rs.earned_at>=p_window_start AND rs.earned_at<p_window_end)
  SELECT 1 FROM public.agent_commissions ac
   LEFT JOIN club_week rs ON rs.source_type=ac.source_type AND rs.source_id=ac.source_id AND rs.club_id=ac.club_id AND rs.earned_at=ac.created_at
  WHERE ac.created_at>=p_window_start AND ac.created_at<p_window_end
  AND (ac.club_id=ANY(p_club_ids))
  AND (ac.source_type IS NULL OR ac.source_type NOT IN('cash_rake_accrual','tournament_fee_accrual') OR ac.settled_at IS NOT NULL OR rs.source_id IS NULL)) x;
 SELECT count(*) INTO odd FROM pg_temp._rw_sources s WHERE s.tiers_type IS DISTINCT FROM 'array' OR s.contract_club IS DISTINCT FROM s.club_id::text;
 IF odd=0 THEN
  CREATE TEMP TABLE IF NOT EXISTS _rw_tiers(source_type text,source_id uuid,club_id uuid,depth int,agent_id uuid,user_id uuid,role text,
   parent_agent_id uuid,own_amount numeric,rate numeric,PRIMARY KEY(source_type,source_id,depth)) ON COMMIT DROP;
  TRUNCATE pg_temp._rw_tiers;
  BEGIN
   INSERT INTO pg_temp._rw_tiers SELECT s.source_type,s.source_id,s.club_id,ord::int,(j->>'agent_id')::uuid,(j->>'user_id')::uuid,j->>'role',
    NULLIF(j->'agreement'->'terms'->>'parent_agent_id','')::uuid,(j->>'amount')::numeric,(j->>'rate')::numeric
    FROM pg_temp._rw_sources s CROSS JOIN LATERAL jsonb_array_elements(s.tiers) WITH ORDINALITY x(j,ord);
  EXCEPTION WHEN OTHERS THEN tiers_failed:=true;
  END;
  IF NOT tiers_failed THEN
   ANALYZE pg_temp._rw_tiers;
   SELECT count(*) INTO c_tier FROM pg_temp._rw_tiers t WHERE t.agent_id IS NULL OR t.user_id IS NULL OR t.role IS NULL OR t.role NOT IN('super_agent','agent','sub_agent')
    OR t.own_amount IS NULL OR t.own_amount<0 OR t.own_amount<>round(t.own_amount,2) OR t.own_amount::text IN('NaN','Infinity','-Infinity')
    OR t.rate IS NULL OR t.rate<0 OR t.rate>1 OR t.rate::text IN('NaN','Infinity','-Infinity')
    OR t.parent_agent_id IS DISTINCT FROM(SELECT u.agent_id FROM pg_temp._rw_tiers u WHERE u.source_type=t.source_type AND u.source_id=t.source_id AND u.depth=t.depth+1);
   SELECT count(*) INTO c_dup FROM (SELECT 1 FROM pg_temp._rw_tiers GROUP BY source_type,source_id,user_id HAVING count(*)<>1) x;
   CREATE TEMP TABLE IF NOT EXISTS _rw_ac(source_type text,source_id uuid,club_id uuid,user_id uuid,amount numeric,commission_rate numeric,settled_at timestamptz) ON COMMIT DROP;
   TRUNCATE pg_temp._rw_ac;
   INSERT INTO pg_temp._rw_ac SELECT a.* FROM (SELECT s.source_type,s.source_id FROM pg_temp._rw_sources s ORDER BY s.source_id,s.source_type) s
    CROSS JOIN LATERAL (SELECT ac.source_type,ac.source_id,ac.club_id,ac.user_id,ac.amount,ac.commission_rate,ac.settled_at FROM public.agent_commissions ac
     WHERE ac.source_id=s.source_id AND ac.source_type=s.source_type OFFSET 0) a;
   ANALYZE pg_temp._rw_ac;
   SELECT count(*) INTO e1 FROM pg_temp._rw_tiers t WHERE t.own_amount>0 AND NOT EXISTS(SELECT 1 FROM pg_temp._rw_ac ac
     WHERE ac.source_type=t.source_type AND ac.source_id=t.source_id AND ac.club_id=t.club_id AND ac.user_id=t.user_id
      AND ac.amount=t.own_amount AND ac.commission_rate=t.rate AND ac.settled_at IS NULL);
   SELECT count(*) INTO e2 FROM pg_temp._rw_tiers t LEFT JOIN (SELECT ac.source_type,ac.source_id,ac.user_id,count(*) AS n FROM pg_temp._rw_ac ac GROUP BY 1,2,3) c
     ON c.source_type=t.source_type AND c.source_id=t.source_id AND c.user_id=t.user_id
    WHERE COALESCE(c.n,0)<>CASE WHEN t.own_amount>0 THEN 1 ELSE 0 END;
   SELECT count(*) INTO e3 FROM pg_temp._rw_ac ac
    WHERE NOT EXISTS(SELECT 1 FROM pg_temp._rw_tiers t WHERE t.source_type=ac.source_type AND t.source_id=ac.source_id AND t.user_id=ac.user_id AND t.own_amount=ac.amount);
   SELECT COALESCE(jsonb_agg(jsonb_build_object('club_id',club_id,'user_id',user_id,'own',own,'rows',nrows,'agent_min',agent_min,'agent_max',agent_max,'role_min',role_min,'role_max',role_max)),'[]')
    INTO v_nodes FROM (SELECT club_id,user_id,sum(own_amount) AS own,count(*) FILTER(WHERE own_amount>0) AS nrows,
     min(agent_id::text) AS agent_min,max(agent_id::text) AS agent_max,min(role) AS role_min,max(role) AS role_max
     FROM pg_temp._rw_tiers GROUP BY club_id,user_id) x;
   SELECT COALESCE(jsonb_agg(jsonb_build_object('club_id',club_id,'payer_user',payer_user,'payee_user',payee_user,'amount',amount,'role_min',role_min)),'[]')
    INTO v_edges FROM (SELECT t.club_id,parent.user_id AS payer_user,t.user_id AS payee_user,sum(t.upto) AS amount,min(t.role) AS role_min
     FROM (SELECT t.*,sum(t.own_amount) OVER(PARTITION BY t.source_type,t.source_id ORDER BY t.depth ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS upto
      FROM pg_temp._rw_tiers t) t
     LEFT JOIN pg_temp._rw_tiers parent ON parent.source_type=t.source_type AND parent.source_id=t.source_id AND parent.depth=t.depth+1
     GROUP BY t.club_id,parent.user_id,t.user_id) x;
  END IF;
 END IF;
 SELECT COALESCE(jsonb_agg(DISTINCT club_id),'[]') INTO v_clubs FROM pg_temp._rw_sources;
 RETURN QUERY SELECT jsonb_build_object('read_failed',false,'sources',n,'odd',odd,'tiers_failed',tiers_failed,'unclassified',c_unc,
   'tier_bad',c_tier,'dup',c_dup,'e1',e1,'e2',e2,'e3',e3,'nodes',v_nodes,'edges',v_edges,'clubs',v_clubs),
  (SELECT array_agg(s.source_id ORDER BY s.source_id) FROM pg_temp._rw_sources s WHERE s.source_type='cash_rake_accrual'),
  (SELECT string_agg(decode(s.row_md5,'hex'),''::bytea ORDER BY s.source_id) FROM pg_temp._rw_sources s WHERE s.source_type='cash_rake_accrual'),
  (SELECT array_agg(s.source_id ORDER BY s.source_id) FROM pg_temp._rw_sources s WHERE s.source_type='tournament_fee_accrual'),
  (SELECT string_agg(decode(s.row_md5,'hex'),''::bytea ORDER BY s.source_id) FROM pg_temp._rw_sources s WHERE s.source_type='tournament_fee_accrual');
END $f$;
REVOKE ALL ON FUNCTION public.fn_settle_accounting_commission_window(uuid,uuid,uuid[],timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.fn_settle_accounting_commission_window(uuid,uuid,uuid[],timestamptz,timestamptz) IS
  'Chunked weekly close (20261003): round 2''s reads and tests over one window of a closed week - counts, payee and edge sums, clubs and per-source row md5s - combined by fn_settle_accounting_commission_combine.';

CREATE FUNCTION public.fn_settle_accounting_commission_advance(p_scope_kind text, p_scope_id uuid, p_period_start timestamptz, p_period_end timestamptz)
 RETURNS boolean
 LANGUAGE plpgsql
 VOLATILE
 SET search_path TO 'public'
AS $f$
DECLARE w record; r record; sc record; began timestamptz; proved boolean:=false; v_kind text:='round2_'||p_scope_kind||'_window';
BEGIN
 IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
  OR NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'') IS NULL
  OR p_scope_kind NOT IN('union','club') OR p_scope_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
  OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end) OR p_period_start>=p_period_end OR p_period_end>clock_timestamp() THEN
  RETURN NULL;
 END IF;
 began:=NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'')::timestamptz
  -COALESCE(NULLIF(current_setting('app.weekly_accounting_scope_budget',true),''),'8 minutes')::interval;
 DELETE FROM public.accounting_close_partials WHERE computed_at<clock_timestamp()-interval '8 days';
 -- The book's scope (and its week lock, which every accrual of the week
 -- shares), resolved once for every window.
 SELECT * INTO sc FROM public.fn_resolve_accounting_routing_scope(p_scope_kind,p_scope_id,p_period_start,p_period_end);
 FOR w IN SELECT * FROM public.fn_accounting_close_windows(p_period_start,p_period_end) ORDER BY 1 LOOP
  CONTINUE WHEN EXISTS(SELECT 1 FROM public.accounting_close_partials p WHERE p.kind=v_kind AND p.union_id=p_scope_id
   AND p.period_start=p_period_start AND p.period_end=p_period_end AND p.window_start=w.window_start AND p.window_end=w.window_end
   AND p.computed_at>=p_period_end AND p.computed_at>clock_timestamp()-interval '12 hours');
  IF proved AND clock_timestamp()>began+interval '120 seconds' THEN RETURN false; END IF;
  SELECT * INTO r FROM public.fn_settle_accounting_commission_window(sc.union_id,sc.standalone_club_id,sc.club_ids,w.window_start,w.window_end);
  INSERT INTO public.accounting_close_partials(kind,union_id,period_start,period_end,window_start,window_end,value,cash_ids,cash_md5,fee_ids,fee_md5,computed_at)
  VALUES(v_kind,p_scope_id,p_period_start,p_period_end,w.window_start,w.window_end,r.value,r.cash_ids,r.cash_md5,r.fee_ids,r.fee_md5,clock_timestamp())
  ON CONFLICT(kind,union_id,period_start,period_end,window_start) DO UPDATE SET window_end=EXCLUDED.window_end,value=EXCLUDED.value,
   cash_ids=EXCLUDED.cash_ids,cash_md5=EXCLUDED.cash_md5,fee_ids=EXCLUDED.fee_ids,fee_md5=EXCLUDED.fee_md5,computed_at=EXCLUDED.computed_at;
  proved:=true;
 END LOOP;
 RETURN true;
END $f$;
REVOKE ALL ON FUNCTION public.fn_settle_accounting_commission_advance(text,uuid,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.fn_settle_accounting_commission_advance(text,uuid,timestamptz,timestamptz) IS
  'Chunked weekly close (20261003): proves the missing two-hour round-2 windows of a closed week, at least one per attempt and none started 120 s after the attempt began; true when all are proved, false when the attempt should stop, NULL outside a chunked close attempt.';

CREATE FUNCTION public.fn_settle_accounting_commission_combine(p_scope_kind text, p_scope_id uuid, p_period_start timestamptz, p_period_end timestamptz)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SET search_path TO 'public'
AS $f$
-- Builds round 2's _routed_nodes, _routed_edges and _routed_clubs from the
-- proved windows exactly as the stage builds them from its own reads, and
-- returns the fingerprint, the source count and the tests' outcome; NULL
-- outside a chunked close attempt or while any window is missing.
DECLARE v_kind text:='round2_'||p_scope_kind||'_window'; n_have bigint; n_expected bigint; fp text; agg record;
BEGIN
 IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
  OR NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'') IS NULL
  OR p_scope_kind NOT IN('union','club') OR p_scope_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
  OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end) OR p_period_start>=p_period_end OR p_period_end>clock_timestamp() THEN
  RETURN NULL;
 END IF;
 CREATE TEMP TABLE IF NOT EXISTS _close_r2_windows(window_start timestamptz PRIMARY KEY,value jsonb,cash_ids uuid[],cash_md5 bytea,fee_ids uuid[],fee_md5 bytea) ON COMMIT DROP;
 TRUNCATE pg_temp._close_r2_windows;
 INSERT INTO pg_temp._close_r2_windows SELECT p.window_start,p.value,p.cash_ids,p.cash_md5,p.fee_ids,p.fee_md5
  FROM public.fn_accounting_close_windows(p_period_start,p_period_end) w JOIN public.accounting_close_partials p
   ON p.kind=v_kind AND p.union_id=p_scope_id AND p.period_start=p_period_start AND p.period_end=p_period_end
   AND p.window_start=w.window_start AND p.window_end=w.window_end
   AND p.computed_at>=p_period_end AND p.computed_at>clock_timestamp()-interval '12 hours';
 GET DIAGNOSTICS n_have=ROW_COUNT;
 SELECT count(*) INTO n_expected FROM public.fn_accounting_close_windows(p_period_start,p_period_end);
 IF n_have<>n_expected OR n_expected=0 THEN RETURN NULL; END IF;
 SELECT bool_or((value->>'read_failed')::boolean) AS read_failed,
  COALESCE(sum((value->>'sources')::bigint),0) AS sources,
  COALESCE(sum((value->>'unclassified')::bigint),0) AS unclassified,
  bool_or((value->>'odd')::bigint>0 OR (value->>'tiers_failed')::boolean) AS full_path,
  COALESCE(sum((value->>'tier_bad')::bigint+(value->>'dup')::bigint),0) AS tier_bad,
  COALESCE(sum((value->>'e1')::bigint+(value->>'e2')::bigint+(value->>'e3')::bigint),0) AS entitlement_bad
  INTO agg FROM pg_temp._close_r2_windows;
 IF agg.read_failed THEN RETURN jsonb_build_object('read_failed',true); END IF;
 -- The stage's fingerprint: md5 of every source's row md5 in
 -- (source_type, source_id) order; cash_rake_accrual sorts first.
 SELECT md5(COALESCE((SELECT string_agg(encode(substring(w.cash_md5 FROM (u.ord::int-1)*16+1 FOR 16),'hex'),'' ORDER BY u.id)
     FROM pg_temp._close_r2_windows w CROSS JOIN LATERAL unnest(w.cash_ids) WITH ORDINALITY u(id,ord)),'')
  ||COALESCE((SELECT string_agg(encode(substring(w.fee_md5 FROM (u.ord::int-1)*16+1 FOR 16),'hex'),'' ORDER BY u.id)
     FROM pg_temp._close_r2_windows w CROSS JOIN LATERAL unnest(w.fee_ids) WITH ORDINALITY u(id,ord)),'')) INTO fp;
 CREATE TEMP TABLE IF NOT EXISTS _routed_nodes(club_id uuid,user_id uuid,agent_id uuid,role text,own_amount numeric,rows_count int,
  opening_balance numeric,sort_order int,PRIMARY KEY(club_id,user_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_nodes;
 CREATE TEMP TABLE IF NOT EXISTS _routed_edges(club_id uuid,payer_user uuid,payee_user uuid,amount numeric,role text,sort_order int) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_edges;
 CREATE TEMP TABLE IF NOT EXISTS _routed_clubs(club_id uuid PRIMARY KEY) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_clubs;
 INSERT INTO pg_temp._routed_clubs SELECT DISTINCT (c#>>'{}')::uuid FROM pg_temp._close_r2_windows w CROSS JOIN LATERAL jsonb_array_elements(w.value->'clubs') c;
 IF agg.full_path OR agg.unclassified>0 THEN
  RETURN jsonb_build_object('read_failed',false,'fingerprint',fp,'sources',agg.sources,'unclassified',agg.unclassified,'full_path',agg.full_path,
   'hierarchy_bad',false,'entitlement_bad',false);
 END IF;
 INSERT INTO pg_temp._routed_nodes(club_id,user_id,agent_id,role,own_amount,rows_count)
  SELECT (e->>'club_id')::uuid,(e->>'user_id')::uuid,min(e->>'agent_min')::uuid,min(e->>'role_min'),sum((e->>'own')::numeric),sum((e->>'rows')::bigint)
   FROM pg_temp._close_r2_windows w CROSS JOIN LATERAL jsonb_array_elements(w.value->'nodes') e
   GROUP BY (e->>'club_id')::uuid,(e->>'user_id')::uuid;
 INSERT INTO pg_temp._routed_edges(club_id,payer_user,payee_user,amount,role)
  SELECT (e->>'club_id')::uuid,(e->>'payer_user')::uuid,(e->>'payee_user')::uuid,sum((e->>'amount')::numeric),min(e->>'role_min')
   FROM pg_temp._close_r2_windows w CROSS JOIN LATERAL jsonb_array_elements(w.value->'edges') e
   GROUP BY (e->>'club_id')::uuid,(e->>'payer_user')::uuid,(e->>'payee_user')::uuid
   HAVING sum((e->>'amount')::numeric)>0;
 RETURN jsonb_build_object('read_failed',false,'fingerprint',fp,'sources',agg.sources,'unclassified',agg.unclassified,'full_path',false,
  'hierarchy_bad',agg.tier_bad>0 OR EXISTS(SELECT 1 FROM pg_temp._close_r2_windows w CROSS JOIN LATERAL jsonb_array_elements(w.value->'nodes') e
    GROUP BY (e->>'club_id'),(e->>'user_id') HAVING min(e->>'agent_min') IS DISTINCT FROM max(e->>'agent_max') OR min(e->>'role_min') IS DISTINCT FROM max(e->>'role_max')),
  'entitlement_bad',agg.entitlement_bad>0);
END $f$;
REVOKE ALL ON FUNCTION public.fn_settle_accounting_commission_combine(text,uuid,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.fn_settle_accounting_commission_combine(text,uuid,timestamptz,timestamptz) IS
  'Chunked weekly close (20261003): round 2''s payee plan (_routed_nodes, _routed_edges, _routed_clubs), fingerprint, source count and test outcome combined from the proved windows of a closed week; NULL outside a chunked close attempt or while any window is missing.';

CREATE FUNCTION public.fn_accounting_close_windows_pending(p_union_id uuid, p_club_id uuid, p_period_start timestamptz, p_period_end timestamptz)
 RETURNS boolean
 LANGUAGE plpgsql
 VOLATILE
 SET search_path TO 'public'
AS $f$
-- True when this chunked close attempt had window work to do for the book's
-- next unpaid round (it then proved what its time allowed and the attempt ends
-- as a committed step); false when every window was already proved, the round
-- already has its receipt, or outside a chunked close attempt.
DECLARE v_kind text:=CASE WHEN p_union_id IS NOT NULL THEN 'union' ELSE 'club' END; v_scope uuid:=COALESCE(p_union_id,p_club_id);
 n_have bigint; n_expected bigint;
BEGIN
 IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
  OR NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'') IS NULL
  OR v_scope IS NULL OR (p_union_id IS NOT NULL AND p_club_id IS NOT NULL) THEN
  RETURN false;
 END IF;
 IF EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r WHERE r.scope_kind=v_kind AND r.scope_id=v_scope
   AND r.period_start=p_period_start AND r.period_end=p_period_end AND r.round_no=2) THEN
  RETURN false;
 END IF;
 SELECT count(*) INTO n_expected FROM public.fn_accounting_close_windows(p_period_start,p_period_end);
 SELECT count(*) INTO n_have FROM public.fn_accounting_close_windows(p_period_start,p_period_end) w JOIN public.accounting_close_partials p
  ON p.kind='round2_'||v_kind||'_window' AND p.union_id=v_scope AND p.period_start=p_period_start AND p.period_end=p_period_end
  AND p.window_start=w.window_start AND p.window_end=w.window_end
  AND p.computed_at>=p_period_end AND p.computed_at>clock_timestamp()-interval '12 hours';
 IF n_have=n_expected THEN RETURN false; END IF;
 PERFORM public.fn_settle_accounting_commission_advance(v_kind,v_scope,p_period_start,p_period_end);
 RETURN true;
END $f$;
REVOKE ALL ON FUNCTION public.fn_accounting_close_windows_pending(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.fn_accounting_close_windows_pending(uuid,uuid,timestamptz,timestamptz) IS
  'Chunked weekly close (20261003): proves the missing round-2 windows of a book whose round 2 has no receipt and returns true (the attempt ends as a committed step); false when there was nothing to prove or outside a chunked close attempt.';

DO $mig$
DECLARE s regprocedure; d text; a text; r text;
BEGIN
 -- commission stage
 s:='public.fn_settle_accounting_commission_stage(text,uuid,timestamptz,timestamptz)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'9623803d7e99eb27c4efb9d18695aab3' THEN RAISE EXCEPTION 'commission stage preimage %',md5(d); END IF;
 a:=$a$v4_ok boolean:=true;
BEGIN$a$;
 r:=$r$v4_ok boolean:=true;v_comb jsonb;
BEGIN$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'commission stage anchor 1 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$ BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _routed_sources_v4$a$;
 r:=$r$ -- CHUNKED CLOSE WINDOWS (20261003): inside a chunked close the plan below
 -- is combined from the week's proved two-hour windows
 -- (fn_settle_accounting_commission_window, fn_settle_accounting_commission_combine),
 -- exactly as these reads build it; outside one, or with any window missing,
 -- the week is read here as before.
 v_comb:=CASE WHEN COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on'
  THEN public.fn_settle_accounting_commission_combine(p_scope_kind,p_scope_id,p_period_start,p_period_end) END;
 IF v_comb IS NOT NULL THEN
  IF (v_comb->>'read_failed')::boolean THEN
   RAISE EXCEPTION 'routed_commission_window_needs_full_path' USING ERRCODE='55000'; END IF;
  fingerprint:=v_comb->>'fingerprint'; source_count:=(v_comb->>'sources')::int;
  SELECT * INTO previous FROM public.accounting_routed_settlement_runs
   WHERE scope_kind=p_scope_kind AND scope_id=p_scope_id AND period_start=p_period_start AND period_end=p_period_end AND round_no=2;
  IF FOUND THEN
   IF previous.source_fingerprint<>fingerprint THEN RAISE EXCEPTION 'routed_commission_source_changed_after_payment' USING ERRCODE='55000'; END IF;
   RETURN previous.result||jsonb_build_object('duplicate',true);
  END IF;
  IF EXISTS(SELECT 1 FROM public.agent_commission_settlements cs WHERE cs.period_start<p_period_end AND cs.period_end>p_period_start
    AND (cs.union_id=p_union_id OR cs.club_id=ANY(scope.club_ids)))
   OR EXISTS(SELECT 1 FROM public.union_settlement_rounds r WHERE r.union_id=p_union_id AND r.round_no=2
     AND r.period_start<p_period_end AND r.period_end>p_period_start AND (r.amount>0 OR r.payees>0 OR r.shortfalls>0))
  THEN RAISE EXCEPTION 'legacy_commission_payment_requires_reconciliation' USING ERRCODE='55000'; END IF;
  IF (v_comb->>'unclassified')::bigint>0 THEN RAISE EXCEPTION 'unclassified_commission_source_requires_reconciliation' USING ERRCODE='55000'; END IF;
  -- A contract only the original v3 path can read is not paid from windows,
  -- and v3 is never run here in one long transaction: nothing is paid.
  IF (v_comb->>'full_path')::boolean THEN RAISE EXCEPTION 'routed_commission_window_needs_full_path' USING ERRCODE='55000'; END IF;
  IF (v_comb->>'hierarchy_bad')::boolean THEN RAISE EXCEPTION 'routed_commission_hierarchy_ambiguous' USING ERRCODE='23514'; END IF;
  IF (v_comb->>'entitlement_bad')::boolean THEN RAISE EXCEPTION 'routed_commission_entitlement_disagrees_with_source' USING ERRCODE='23514'; END IF;
 ELSE
 BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _routed_sources_v4$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'commission stage anchor 2 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$ HAVING sum(t.upto)>0;
$a$;
 r:=$r$ HAVING sum(t.upto)>0;
 CREATE TEMP TABLE IF NOT EXISTS _routed_clubs(club_id uuid PRIMARY KEY) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_clubs;
 INSERT INTO pg_temp._routed_clubs SELECT DISTINCT club_id FROM pg_temp._routed_sources_v4;
 END IF;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'commission stage anchor 3 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$PERFORM c.id FROM public.clubs c WHERE c.id IN(SELECT club_id FROM pg_temp._routed_sources_v4) ORDER BY c.id FOR NO KEY UPDATE;$a$;
 r:=$r$PERFORM c.id FROM public.clubs c WHERE c.id IN(SELECT club_id FROM pg_temp._routed_clubs) ORDER BY c.id FOR NO KEY UPDATE;$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'commission stage anchor 4 count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'commission stage postimage differs from the substituted text'; END IF;
 -- scheduler
 s:='public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'d8b20829e2b832a22cd573f28447d23f' THEN RAISE EXCEPTION 'scheduler preimage %',md5(d); END IF;
 a:=$a$          AND public.fn_accounting_close_prepared_long(v_union.id,NULL,v_from,v_end) THEN
$a$;
 r:=$r$          -- CHUNKED CLOSE WINDOWS (20261003): round 2's windows are proved in
          -- attempts of their own (after any long preparation, never with it)
          -- before the attempt that pays it.
          AND (CASE WHEN public.fn_accounting_close_prepared_long(v_union.id,NULL,v_from,v_end) THEN true
            ELSE public.fn_accounting_close_windows_pending(v_union.id,NULL,v_from,v_end) END) THEN
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'scheduler anchor 1 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$          IF v_chunked AND public.fn_accounting_close_prepared_long(NULL,v_club.id,v_from,v_end) THEN
$a$;
 r:=$r$          IF v_chunked AND (CASE WHEN public.fn_accounting_close_prepared_long(NULL,v_club.id,v_from,v_end) THEN true
            ELSE public.fn_accounting_close_windows_pending(NULL,v_club.id,v_from,v_end) END) THEN
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'scheduler anchor 2 count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'scheduler postimage differs from the substituted text'; END IF;
END
$mig$;

COMMIT;
