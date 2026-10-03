-- 20261003162308_round_three_is_read_once_and_paid_in_batches.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ROUND THREE IS READ ONCE AND PAID IN BATCHES
--
-- Every close transaction is capped at 5 minutes (transactions over ~9
-- minutes during play expire tournament leases). Round 3
-- (fn_settle_accounting_rakeback_stage: certified payer -> players) reads, in
-- its paying transaction, the (club, player) pairs of outside clubs, the
-- book's week of sources and every allocation of every certificate - 11-52 s,
-- 12 s and 22 s for Midway's week of 2026-09-21 (548k sources); Deep Stack's
-- week (599k sources) took 80 s to read once - and this week is ~3.2x. It
-- then pays every period in one loop of ledger writes (598 Midway periods
-- last week, each with its payout, wallet rows, chip_ledger row and invoice)
-- while it holds every payee's and payer's wallet row.
--
-- WHAT CHANGES, ONLY IN A CHUNKED CLOSE (job 272 sets
-- app.weekly_accounting_chunked; an attempt deadline is set):
--  1. fn_settle_accounting_rakeback_window reads one two-hour window of the
--     book's sources (the stage's predicate, written per book kind so each
--     reads by its own index) and keeps, per (club, player): the source count,
--     the non-house count and two 60-bit sums of an md5 of each source's
--     (source type, id, rake credit, rake record, agent). The windows are
--     proved in attempts of their own (fn_settle_accounting_rakeback_advance,
--     from fn_accounting_close_windows_pending after round 2), at least one
--     and none started 120 s after the attempt began.
--  2. fn_settle_accounting_rakeback_plan then reads, in an attempt of its
--     own, the periods the stage admits (outside clubs' pairs from the
--     windows), each one's latest certificate and every allocation of it: the
--     stage's counts and sums, its element-only tests (source type, rate,
--     payer kind and payer) and the same two sums of an md5 of each
--     allocation's (source type, id, rake credit, rake record, the
--     certificate's payer). Certificates are immutable
--     (accounting_rakeback_calculation_immutable).
--  3. fn_settle_accounting_rakeback_plan_get combines them: a period's
--     allocations match its (club, player)'s sources of the week - same
--     sources, same rake credit, rake record and agent - exactly when the
--     sums agree (with distinct allocations and equal counts, which the stage
--     tests itself); a disagreement is the stage's any-bad flag. The paying
--     attempt's stage still locks the periods (FOR UPDATE, original order),
--     reads their latest certificates and runs every certificate test live,
--     and uses the kept read only when every locked (period, certificate,
--     club, player) is in it; otherwise it reads the week itself exactly as
--     before. Items, fingerprint, duplicate test and refusals are unchanged.
--  4. The payout loop pays in batches: an attempt pays, in the original order,
--     until 90 s after its loop began (at least one period), commits, and
--     returns batch_committed; the next attempt continues. A period an earlier
--     batch paid is recognised only by its own evidence - status paid, exactly
--     one payout of the owed amount and (owed > 0) the chip_ledger row whose
--     idempotency key round3-period:v3:<period> is unique
--     (ux_chip_ledger_idempotency_key) with this scope, certificate, payout
--     and amount - and is not paid again; anything else still refuses with
--     legacy_rakeback_payment_requires_reconciliation. Each batch locks and
--     funding-tests the wallets of every period still unpaid (exactly the
--     original tests on the first batch) and checks every locked wallet's
--     final balance against what this batch paid. The batch that pays the last
--     period writes the receipt with the round's full amount, payees and
--     periods - the receipt the single loop writes.
--  5. fn_union_settlement_cascade and the scheduler's standalone branch end an
--     attempt whose round 3 returned batch_committed as a committed step.
-- Outside a chunked close nothing here changes: no kept read is used, nothing
-- is recognised as paid earlier, and the loop pays every period in one
-- transaction as before.
--
-- PROOF: Midway's and Deep Stack's closed weeks of 2026-09-21 are read in
-- windows and planned, and run through the stage in a chunked attempt (rolled
-- back): with the kept read in use, the stage builds the items and
-- fingerprint of the receipt the 2026-10-01 / 2026-09-29 closes wrote and
-- returns it as a duplicate; the earlier-batch evidence test recognises every
-- period those closes paid. Recorded in docs/changelog/2026-10-03-round-three-
-- is-read-once-and-paid-in-batches.md.
--
-- @live-proof: to_regprocedure('public.fn_settle_accounting_rakeback_plan(text,uuid,timestamptz,timestamptz)') IS NOT NULL
-- @live-proof: position('_routed_player_done' in pg_get_functiondef('public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure)) > 0
-- @live-proof: position('round3_batch' in pg_get_functiondef('public.fn_union_settlement_cascade(uuid,timestamptz,timestamptz)'::regprocedure)) > 0
-- @live-proof: position('round3_batch' in pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure)) > 0
-- @live-proof: position('fn_settle_accounting_rakeback_advance' in pg_get_functiondef('public.fn_accounting_close_windows_pending(uuid,uuid,timestamptz,timestamptz)'::regprocedure)) > 0
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '90s';

ALTER TABLE public.accounting_close_partials DROP CONSTRAINT accounting_close_partials_kind_check;
ALTER TABLE public.accounting_close_partials ADD CONSTRAINT accounting_close_partials_kind_check
  CHECK (kind IN ('earned_plan_window','round2_union_window','round2_club_window','round3_union_window','round3_club_window','round3_union_plan','round3_club_plan'));

CREATE FUNCTION public.fn_settle_accounting_rakeback_window(p_union_id uuid, p_standalone_club_id uuid, p_window_start timestamptz, p_window_end timestamptz)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SET search_path TO 'public'
AS $f$
-- ONE WINDOW OF ROUND 3'S SOURCES (chunked close, 20261003): per (club, player)
-- of the book's sources earned in the window, the count, the non-house count
-- and two 60-bit sums of md5(source type|id|rake credit|rake record|agent).
DECLARE v jsonb; standalone_club uuid:=p_standalone_club_id;
BEGIN
 BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _rw3_src(club_id uuid,player_id uuid,nonhouse boolean,h text) ON COMMIT DROP;
  TRUNCATE pg_temp._rw3_src;
  IF p_union_id IS NOT NULL AND standalone_club IS NULL THEN
   INSERT INTO pg_temp._rw3_src SELECT rs.club_id,rs.player_id,COALESCE((rs.contract->>'is_union_house')::boolean,false) IS FALSE,
    md5(concat_ws('|',COALESCE(rs.source_type,'~'),COALESCE(rs.source_id::text,'~'),COALESCE(trim_scale(rs.rake_credit)::text,'~'),
     COALESCE(rs.rake_record_id::text,'~'),COALESCE(NULLIF(rs.contract->'membership'->'terms'->>'agent_id','')::uuid::text,'~')))
    FROM public.accounting_payable_earning_sources rs WHERE rs.earned_at>=p_window_start AND rs.earned_at<p_window_end
     AND rs.coordinator_union_id=p_union_id;
  ELSIF p_union_id IS NULL AND standalone_club IS NOT NULL THEN
   INSERT INTO pg_temp._rw3_src SELECT rs.club_id,rs.player_id,COALESCE((rs.contract->>'is_union_house')::boolean,false) IS FALSE,
    md5(concat_ws('|',COALESCE(rs.source_type,'~'),COALESCE(rs.source_id::text,'~'),COALESCE(trim_scale(rs.rake_credit)::text,'~'),
     COALESCE(rs.rake_record_id::text,'~'),COALESCE(NULLIF(rs.contract->'membership'->'terms'->>'agent_id','')::uuid::text,'~')))
    FROM public.accounting_payable_earning_sources rs WHERE rs.earned_at>=p_window_start AND rs.earned_at<p_window_end
     AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club;
  ELSE
   INSERT INTO pg_temp._rw3_src SELECT rs.club_id,rs.player_id,COALESCE((rs.contract->>'is_union_house')::boolean,false) IS FALSE,
    md5(concat_ws('|',COALESCE(rs.source_type,'~'),COALESCE(rs.source_id::text,'~'),COALESCE(trim_scale(rs.rake_credit)::text,'~'),
     COALESCE(rs.rake_record_id::text,'~'),COALESCE(NULLIF(rs.contract->'membership'->'terms'->>'agent_id','')::uuid::text,'~')))
    FROM public.accounting_payable_earning_sources rs WHERE rs.earned_at>=p_window_start AND rs.earned_at<p_window_end
     AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club));
  END IF;
  SELECT jsonb_build_object('read_failed',false,'sources',COALESCE(sum(x.n),0),
    'pairs',COALESCE(jsonb_agg(jsonb_build_array(x.club_id,x.player_id,x.n,x.nn,x.d1,x.d2)),'[]'::jsonb)) INTO v
   FROM (SELECT s.club_id,s.player_id,count(*) AS n,count(*) FILTER(WHERE s.nonhouse) AS nn,
     sum(('x'||substr(s.h,1,15))::bit(60)::bigint) AS d1,sum(('x'||substr(s.h,16,15))::bit(60)::bigint) AS d2
     FROM pg_temp._rw3_src s GROUP BY s.club_id,s.player_id) x;
 EXCEPTION WHEN OTHERS THEN
  -- Anything this read cannot do, the stage does itself (and refuses as it refuses).
  v:=jsonb_build_object('read_failed',true,'error',SQLERRM,'sqlstate',SQLSTATE);
 END;
 RETURN v;
END $f$;
REVOKE ALL ON FUNCTION public.fn_settle_accounting_rakeback_window(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.fn_settle_accounting_rakeback_window(uuid,uuid,timestamptz,timestamptz) IS
  'Chunked weekly close (20261003): one window of a book''s round-3 sources - per (club, player) the count, the non-house count and two 60-bit sums of md5(source type|id|rake credit|rake record|agent).';

CREATE FUNCTION public.fn_settle_accounting_rakeback_pairs(p_scope_kind text, p_scope_id uuid, p_period_start timestamptz, p_period_end timestamptz)
 RETURNS TABLE(club_id uuid, player_id uuid, n bigint, nn bigint, d1 numeric, d2 numeric)
 LANGUAGE sql
 VOLATILE
 SET search_path TO 'public'
AS $f$
 -- Every window of the week, read after it closed and within 12 hours, none
 -- failed - or no rows at all.
 WITH w AS (SELECT p.value FROM public.fn_accounting_close_windows(p_period_start,p_period_end) x
   JOIN public.accounting_close_partials p ON p.kind='round3_'||p_scope_kind||'_window' AND p.union_id=p_scope_id
    AND p.period_start=p_period_start AND p.period_end=p_period_end AND p.window_start=x.window_start AND p.window_end=x.window_end
    AND p.computed_at>=p_period_end AND p.computed_at>clock_timestamp()-interval '12 hours'),
 ok AS (SELECT (SELECT count(*) FROM w WHERE w.value->>'read_failed'='false')=(SELECT count(*) FROM public.fn_accounting_close_windows(p_period_start,p_period_end))
   AND (SELECT count(*) FROM public.fn_accounting_close_windows(p_period_start,p_period_end))>0 AS ok)
 SELECT (e->>0)::uuid,(e->>1)::uuid,sum((e->>2)::bigint)::bigint,sum((e->>3)::bigint)::bigint,sum((e->>4)::numeric),sum((e->>5)::numeric)
  FROM w CROSS JOIN LATERAL jsonb_array_elements(w.value->'pairs') e WHERE (SELECT ok FROM ok)
  GROUP BY (e->>0)::uuid,(e->>1)::uuid
$f$;
REVOKE ALL ON FUNCTION public.fn_settle_accounting_rakeback_pairs(text,uuid,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.fn_settle_accounting_rakeback_pairs(text,uuid,timestamptz,timestamptz) IS
  'Chunked weekly close (20261003): a book''s round-3 sources of the week per (club, player), summed from its proved windows; no rows unless every window is proved.';

CREATE FUNCTION public.fn_settle_accounting_rakeback_plan(p_scope_kind text, p_scope_id uuid, p_period_start timestamptz, p_period_end timestamptz)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SET search_path TO 'public'
AS $f$
-- ROUND 3'S CERTIFICATES, READ ONCE (chunked close, 20261003): the periods the
-- stage admits, their latest certificates and every allocation's counts,
-- sums, element-only tests and md5 sums, kept for the paying attempt.
DECLARE scope record; p_union_id uuid; standalone_club uuid; from_date date; to_date date; v jsonb;
 legacy_paid_cash_replay boolean:=false;
BEGIN
 IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
  OR NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'') IS NULL
  OR p_scope_kind NOT IN('union','club') OR p_scope_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
  OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end) OR p_period_start>=p_period_end OR p_period_end>clock_timestamp() THEN
  RETURN NULL;
 END IF;
 SELECT * INTO scope FROM public.fn_resolve_accounting_routing_scope(p_scope_kind,p_scope_id,p_period_start,p_period_end);
 p_union_id:=scope.union_id;standalone_club:=scope.standalone_club_id;
 from_date:=(p_period_start AT TIME ZONE 'America/Los_Angeles')::date;
 to_date:=(p_period_end AT TIME ZONE 'America/Los_Angeles')::date-1;
 BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _rp3_pairs(club_id uuid,player_id uuid,PRIMARY KEY(club_id,player_id)) ON COMMIT DROP;
  TRUNCATE pg_temp._rp3_pairs;
  INSERT INTO pg_temp._rp3_pairs SELECT x.club_id,x.player_id FROM public.fn_settle_accounting_rakeback_pairs(p_scope_kind,p_scope_id,p_period_start,p_period_end) x;
  IF NOT FOUND THEN RAISE EXCEPTION 'round3_windows_missing'; END IF;
  CREATE TEMP TABLE IF NOT EXISTS _rp3_periods(id uuid PRIMARY KEY,club_id uuid,user_id uuid) ON COMMIT DROP;
  TRUNCATE pg_temp._rp3_periods;
  -- The stage's admitted periods; the outside clubs' pairs are the windows'
  -- pairs (same predicate, same week).
  INSERT INTO pg_temp._rp3_periods SELECT x.id,x.club_id,x.user_id
   FROM (WITH pclubs AS MATERIALIZED (SELECT DISTINCT p2.club_id FROM public.rakeback_periods p2
      WHERE p2.period_start<=to_date AND p2.period_end>=from_date AND p2.club_id IS NOT NULL AND (p2.club_id=ANY(scope.club_ids)) IS NOT TRUE),
    pairs AS MATERIALIZED (SELECT w.club_id,w.player_id FROM pg_temp._rp3_pairs w WHERE w.club_id IN(SELECT pc.club_id FROM pclubs pc))
   SELECT rp.* FROM public.rakeback_periods rp WHERE rp.period_start<=to_date AND rp.period_end>=from_date
  AND (rp.club_id=ANY(scope.club_ids)
    OR CASE WHEN rp.club_id IN(SELECT pc.club_id FROM pclubs pc)
     THEN EXISTS(SELECT 1 FROM pairs q WHERE q.club_id=rp.club_id AND q.player_id=rp.user_id)
     ELSE EXISTS(SELECT 1 FROM public.accounting_payable_earning_sources rs WHERE rs.club_id=rp.club_id AND rs.player_id=rp.user_id
      AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club)) AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end) END)) x;
  CREATE TEMP TABLE IF NOT EXISTS _rp3_certs(period_id uuid PRIMARY KEY,id bigint,payer_kind text,payer_user_id uuid) ON COMMIT DROP;
  TRUNCATE pg_temp._rp3_certs;
  INSERT INTO pg_temp._rp3_certs SELECT DISTINCT ON(x.period_id) x.period_id,x.id,x.payer_kind,x.payer_user_id
   FROM public.accounting_rakeback_period_calculations x WHERE x.period_id IN(SELECT id FROM pg_temp._rp3_periods) ORDER BY x.period_id,x.id DESC;
  -- Per period: the stage's counts and sums, its tests of each allocation that
  -- need no source, and the md5 sums of each allocation as its source must be.
  SELECT jsonb_build_object('failed',false,'legacy',legacy_paid_cash_replay,'union_id',p_union_id,'standalone_club_id',standalone_club,
    'club_ids',to_jsonb(scope.club_ids),'periods',(SELECT count(*) FROM pg_temp._rp3_periods),
    'alloc',COALESCE(jsonb_agg(jsonb_build_array(x.period_id,x.cert_id,x.club_id,x.user_id,x.n,x.nd,x.generated,x.unrounded,x.elem_bad,x.d1,x.d2)),'[]'::jsonb)) INTO v
   FROM (SELECT pc.period_id,pc.id AS cert_id,pr.club_id,pr.user_id,count(*) AS n,
     count(DISTINCT ROW(COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END),a->>'source_id')) AS nd,
     sum((a->>'rake_credit')::numeric) AS generated,sum((a->>'rake_credit')::numeric*(a->>'rate')::numeric) AS unrounded,
     COALESCE(bool_or(COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) IS NULL OR COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) NOT IN('cash_rake_accrual','tournament_fee_accrual')
      OR (a->>'rate')::numeric IS NULL OR (a->>'rate')::numeric<0 OR (a->>'rate')::numeric>1
      OR (a->>'rate')::numeric::text IN('NaN','Infinity','-Infinity')
      OR a->>'payer_kind' IS DISTINCT FROM pc.payer_kind OR NULLIF(a->>'payer_user_id','')::uuid IS DISTINCT FROM pc.payer_user_id),false) AS elem_bad,
     sum(('x'||substr(hh.h,1,15))::bit(60)::bigint) AS d1,sum(('x'||substr(hh.h,16,15))::bit(60)::bigint) AS d2
    FROM pg_temp._rp3_certs pc JOIN pg_temp._rp3_periods pr ON pr.id=pc.period_id
    JOIN public.accounting_rakeback_period_calculations cc ON cc.id=pc.id
    CROSS JOIN LATERAL jsonb_array_elements(cc.source_allocations) a
    CROSS JOIN LATERAL (SELECT md5(concat_ws('|',COALESCE(COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END),'~'),
       COALESCE((a->>'source_id')::uuid::text,'~'),COALESCE(trim_scale((a->>'rake_credit')::numeric)::text,'~'),
       COALESCE((a->>'rake_record_id')::uuid::text,'~'),COALESCE(pc.payer_user_id::text,'~'))) AS h) hh
    GROUP BY pc.period_id,pc.id,pr.club_id,pr.user_id) x;
 EXCEPTION WHEN OTHERS THEN
  -- Anything this read cannot do, the stage does itself (and refuses as it refuses).
  v:=jsonb_build_object('failed',true,'error',SQLERRM,'sqlstate',SQLSTATE);
 END;
 INSERT INTO public.accounting_close_partials(kind,union_id,period_start,period_end,window_start,window_end,value,computed_at)
 VALUES('round3_'||p_scope_kind||'_plan',p_scope_id,p_period_start,p_period_end,p_period_start,p_period_end,v,clock_timestamp())
 ON CONFLICT(kind,union_id,period_start,period_end,window_start) DO UPDATE SET window_end=EXCLUDED.window_end,value=EXCLUDED.value,
  cash_ids=NULL,cash_md5=NULL,fee_ids=NULL,fee_md5=NULL,computed_at=EXCLUDED.computed_at;
 RETURN v;
END $f$;
REVOKE ALL ON FUNCTION public.fn_settle_accounting_rakeback_plan(text,uuid,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.fn_settle_accounting_rakeback_plan(text,uuid,timestamptz,timestamptz) IS
  'Chunked weekly close (20261003): round 3''s admitted periods, latest certificates and per-period allocation counts, sums, element-only tests and md5 sums, kept for the paying attempt; NULL outside a chunked close attempt.';

CREATE FUNCTION public.fn_settle_accounting_rakeback_advance(p_scope_kind text, p_scope_id uuid, p_period_start timestamptz, p_period_end timestamptz)
 RETURNS boolean
 LANGUAGE plpgsql
 VOLATILE
 SET search_path TO 'public'
AS $f$
-- Proves the missing round-3 windows of a closed week (at least one, none
-- started 120 s after the attempt began), then, in an attempt that has not
-- spent 60 s on windows, the certificates' read. True when it did work.
DECLARE w record; sc record; began timestamptz; proved boolean:=false; v_kind text:='round3_'||p_scope_kind||'_window';
BEGIN
 IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
  OR NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'') IS NULL
  OR p_scope_kind NOT IN('union','club') OR p_scope_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
  OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end) OR p_period_start>=p_period_end OR p_period_end>clock_timestamp() THEN
  RETURN NULL;
 END IF;
 began:=NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'')::timestamptz
  -COALESCE(NULLIF(current_setting('app.weekly_accounting_scope_budget',true),''),'8 minutes')::interval;
 FOR w IN SELECT * FROM public.fn_accounting_close_windows(p_period_start,p_period_end) ORDER BY 1 LOOP
  CONTINUE WHEN EXISTS(SELECT 1 FROM public.accounting_close_partials p WHERE p.kind=v_kind AND p.union_id=p_scope_id
   AND p.period_start=p_period_start AND p.period_end=p_period_end AND p.window_start=w.window_start AND p.window_end=w.window_end
   AND p.computed_at>=p_period_end AND p.computed_at>clock_timestamp()-interval '12 hours');
  IF proved AND clock_timestamp()>began+interval '120 seconds' THEN RETURN true; END IF;
  IF sc IS NULL THEN
   SELECT * INTO sc FROM public.fn_resolve_accounting_routing_scope(p_scope_kind,p_scope_id,p_period_start,p_period_end);
  END IF;
  INSERT INTO public.accounting_close_partials(kind,union_id,period_start,period_end,window_start,window_end,value,computed_at)
  VALUES(v_kind,p_scope_id,p_period_start,p_period_end,w.window_start,w.window_end,
   public.fn_settle_accounting_rakeback_window(sc.union_id,sc.standalone_club_id,w.window_start,w.window_end),clock_timestamp())
  ON CONFLICT(kind,union_id,period_start,period_end,window_start) DO UPDATE SET window_end=EXCLUDED.window_end,value=EXCLUDED.value,
   cash_ids=NULL,cash_md5=NULL,fee_ids=NULL,fee_md5=NULL,computed_at=EXCLUDED.computed_at;
  proved:=true;
 END LOOP;
 IF proved AND clock_timestamp()>began+interval '60 seconds' THEN RETURN true; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.accounting_close_partials p WHERE p.kind='round3_'||p_scope_kind||'_plan' AND p.union_id=p_scope_id
   AND p.period_start=p_period_start AND p.period_end=p_period_end AND p.window_start=p_period_start
   AND p.computed_at>=p_period_end AND p.computed_at>clock_timestamp()-interval '12 hours') THEN
  PERFORM public.fn_settle_accounting_rakeback_plan(p_scope_kind,p_scope_id,p_period_start,p_period_end);
  proved:=true;
 END IF;
 RETURN proved;
END $f$;
REVOKE ALL ON FUNCTION public.fn_settle_accounting_rakeback_advance(text,uuid,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.fn_settle_accounting_rakeback_advance(text,uuid,timestamptz,timestamptz) IS
  'Chunked weekly close (20261003): proves the missing two-hour round-3 windows of a closed week, then reads its certificates once (fn_settle_accounting_rakeback_plan); true when it did work, false when nothing was missing, NULL outside a chunked close attempt.';

CREATE FUNCTION public.fn_settle_accounting_rakeback_plan_get(p_scope_kind text, p_scope_id uuid, p_period_start timestamptz, p_period_end timestamptz,
  p_club_ids uuid[], p_union_id uuid, p_standalone_club_id uuid, p_legacy boolean)
 RETURNS jsonb
 LANGUAGE sql
 VOLATILE
 SET search_path TO 'public'
AS $f$
 -- The kept round-3 read of this book's week: only inside a chunked close
 -- attempt, for the same scope (union, standalone club, clubs) and the same
 -- (non-legacy) source typing, with every window and the certificates' read
 -- made after the week closed and within 12 hours. A period's any-bad flag is
 -- its element-only tests or its allocations' md5 sums disagreeing with its
 -- (club, player)'s sources.
 WITH p AS (SELECT p.value FROM public.accounting_close_partials p
  WHERE COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on'
   AND NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'') IS NOT NULL
   AND p.kind='round3_'||p_scope_kind||'_plan' AND p.union_id=p_scope_id AND p.period_start=p_period_start AND p.period_end=p_period_end
   AND p.window_start=p_period_start AND p.window_end=p_period_end
   AND p.computed_at>=p_period_end AND p.computed_at>clock_timestamp()-interval '12 hours'
   AND p.value->>'failed'='false' AND p_legacy IS FALSE AND p.value->>'legacy'='false'
   AND p.value->'club_ids'=to_jsonb(p_club_ids)
   AND (p.value->>'union_id')::uuid IS NOT DISTINCT FROM p_union_id
   AND (p.value->>'standalone_club_id')::uuid IS NOT DISTINCT FROM p_standalone_club_id),
 q AS MATERIALIZED (SELECT * FROM public.fn_settle_accounting_rakeback_pairs(p_scope_kind,p_scope_id,p_period_start,p_period_end) WHERE EXISTS(SELECT 1 FROM p))
 SELECT jsonb_build_object(
   'pairs',(SELECT COALESCE(jsonb_agg(jsonb_build_array(q.club_id,q.player_id)),'[]'::jsonb) FROM q),
   'counts',(SELECT COALESCE(jsonb_agg(jsonb_build_array(q.club_id,q.player_id,q.n)),'[]'::jsonb) FROM q),
   'nonhouse',(SELECT COALESCE(jsonb_agg(jsonb_build_array(q.club_id,q.player_id)),'[]'::jsonb) FROM q WHERE q.nn>0),
   'alloc',(SELECT COALESCE(jsonb_agg(jsonb_build_array(e->0,e->1,e->2,e->3,e->4,e->5,e->6,e->7,
      COALESCE((e->>8)::boolean,true) OR q2.d1 IS DISTINCT FROM (e->>9)::numeric OR q2.d2 IS DISTINCT FROM (e->>10)::numeric)),'[]'::jsonb)
     FROM p CROSS JOIN LATERAL jsonb_array_elements(p.value->'alloc') e
     LEFT JOIN q q2 ON q2.club_id=(e->>2)::uuid AND q2.player_id=(e->>3)::uuid))
 FROM p WHERE EXISTS(SELECT 1 FROM q)
$f$;
REVOKE ALL ON FUNCTION public.fn_settle_accounting_rakeback_plan_get(text,uuid,timestamptz,timestamptz,uuid[],uuid,uuid,boolean) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.fn_settle_accounting_rakeback_plan_get(text,uuid,timestamptz,timestamptz,uuid[],uuid,uuid,boolean) IS
  'Chunked weekly close (20261003): the kept round-3 read of a closed week (pairs, counts, non-house pairs, per-period allocation results) for the same scope, or NULL (outside a chunked close attempt, anything missing, older than 12 hours, failed, or legacy typing).';

DO $mig$
DECLARE s regprocedure; d text; a text; r text;
BEGIN
 -- round 3 stage
 s:='public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'d26e5bb97db6245ba78dfab7df5c4f5d' THEN RAISE EXCEPTION 'round 3 stage preimage %',md5(d); END IF;
 a:=$a$club_skip text;member_skip text;maintenance text;routing_context text;v4_ok boolean:=false;
BEGIN$a$;
 r:=$r$club_skip text;member_skip text;maintenance text;routing_context text;v4_ok boolean:=false;
 v_plan jsonb;v_plan_used boolean:=false;v_batched boolean:=false;v_stop timestamptz;v_remaining bigint:=0;
 v_paid_before numeric:=0;v_payees_before int:=0;
BEGIN$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'round 3 stage anchor 1 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$  payer_kind text,payer_user uuid,owed numeric,rake numeric,rate numeric,fingerprint text,status text) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_items;
$a$;
 r:=$r$  payer_kind text,payer_user uuid,owed numeric,rake numeric,rate numeric,fingerprint text,status text) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_items;
 -- CHUNKED CLOSE (20261003, round 3 read once): in a chunked close attempt the
 -- week's reads and allocation tests may come from the attempt that read them
 -- (fn_settle_accounting_rakeback_plan); see below for when they are used.
 v_plan:=public.fn_settle_accounting_rakeback_plan_get(p_scope_kind,p_scope_id,p_period_start,p_period_end,scope.club_ids,p_union_id,standalone_club,legacy_paid_cash_replay);
 CREATE TEMP TABLE IF NOT EXISTS _rr3_plan_nonhouse(club_id uuid,player_id uuid,PRIMARY KEY(club_id,player_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._rr3_plan_nonhouse;
 CREATE TEMP TABLE IF NOT EXISTS _rr3_week_v4(source_type text,source_id uuid,club_id uuid,player_id uuid,coordinator_union_id uuid,earned_at timestamptz,
    rake_credit numeric,rake_record_id uuid,agent_text text,house_text text,PRIMARY KEY(source_type,source_id)) ON COMMIT DROP;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'round 3 stage anchor 2 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$      AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club)) AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end)
   SELECT rp.* FROM public.rakeback_periods rp$a$;
 r:=$r$      AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club)) AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end
      AND v_plan IS NULL
     UNION SELECT (e->>0)::uuid,(e->>1)::uuid FROM jsonb_array_elements(v_plan->'pairs') e
      WHERE v_plan IS NOT NULL AND (e->>0)::uuid IN(SELECT pc.club_id FROM pclubs pc))
   SELECT rp.* FROM public.rakeback_periods rp$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'round 3 stage anchor 3 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$   CREATE TEMP TABLE IF NOT EXISTS _rr3_week_v4($a$;
 r:=$r$   CREATE TEMP TABLE IF NOT EXISTS _rr3_wn_v4(club_id uuid,player_id uuid,n bigint,PRIMARY KEY(club_id,player_id)) ON COMMIT DROP;
   TRUNCATE pg_temp._rr3_wn_v4;
   IF v_plan IS NOT NULL THEN
    CREATE TEMP TABLE IF NOT EXISTS _rr3_plan_alloc(period_id uuid PRIMARY KEY,cert_id bigint,club_id uuid,user_id uuid,allocation_count bigint,matched_count bigint,
     generated numeric,unrounded numeric,any_bad boolean) ON COMMIT DROP;
    TRUNCATE pg_temp._rr3_plan_alloc;
    INSERT INTO pg_temp._rr3_plan_alloc SELECT (e->>0)::uuid,(e->>1)::bigint,(e->>2)::uuid,(e->>3)::uuid,(e->>4)::bigint,(e->>5)::bigint,
     (e->>6)::numeric,(e->>7)::numeric,(e->>8)::boolean FROM jsonb_array_elements(v_plan->'alloc') e;
    IF NOT EXISTS(SELECT 1 FROM pg_temp._rr3_periods_v4 pr JOIN pg_temp._rr3_certs_v4 pc ON pc.period_id=pr.id
      WHERE NOT EXISTS(SELECT 1 FROM pg_temp._rr3_plan_alloc a WHERE a.period_id=pr.id AND a.cert_id=pc.id AND a.club_id=pr.club_id AND a.user_id=pr.user_id)) THEN
     v_plan_used:=true;
    END IF;
   END IF;
   IF NOT v_plan_used THEN
   CREATE TEMP TABLE IF NOT EXISTS _rr3_week_v4($r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'round 3 stage anchor 4 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$   ANALYZE pg_temp._rr3_week_v4;
$a$;
 r:=$r$   ANALYZE pg_temp._rr3_week_v4;
   END IF;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'round 3 stage anchor 5 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$   INSERT INTO pg_temp._rr3_alloc_v4 SELECT pc.period_id,count(*),
$a$;
 r:=$r$   IF v_plan_used THEN
    INSERT INTO pg_temp._rr3_alloc_v4 SELECT a.period_id,a.allocation_count,a.matched_count,a.generated,a.unrounded,a.any_bad
     FROM pg_temp._rr3_plan_alloc a JOIN pg_temp._rr3_certs_v4 pc ON pc.period_id=a.period_id AND pc.id=a.cert_id;
    INSERT INTO pg_temp._rr3_wn_v4 SELECT (e->>0)::uuid,(e->>1)::uuid,(e->>2)::bigint FROM jsonb_array_elements(v_plan->'counts') e;
    INSERT INTO pg_temp._rr3_plan_nonhouse SELECT (e->>0)::uuid,(e->>1)::uuid FROM jsonb_array_elements(v_plan->'nonhouse') e;
   ELSE
   INSERT INTO pg_temp._rr3_alloc_v4 SELECT pc.period_id,count(*),
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'round 3 stage anchor 6 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$    GROUP BY pc.period_id;
$a$;
 r:=$r$    GROUP BY pc.period_id;
   INSERT INTO pg_temp._rr3_wn_v4 SELECT w.club_id,w.player_id,count(*) FROM pg_temp._rr3_week_v4 w GROUP BY w.club_id,w.player_id;
   END IF;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'round 3 stage anchor 7 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$     LEFT JOIN (SELECT w.club_id,w.player_id,count(*) AS n FROM pg_temp._rr3_week_v4 w GROUP BY w.club_id,w.player_id) w ON w.club_id=pr.club_id AND w.player_id=pr.user_id
$a$;
 r:=$r$     LEFT JOIN pg_temp._rr3_wn_v4 w ON w.club_id=pr.club_id AND w.player_id=pr.user_id
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'round 3 stage anchor 8 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$ IF (CASE WHEN v4_ok THEN EXISTS(SELECT 1 FROM pg_temp._rr3_week_v4 rs
$a$;
 r:=$r$ PERFORM set_config('app.accounting_round3_plan_used',CASE WHEN v4_ok AND v_plan_used THEN 'on' ELSE '' END,true);
 IF (CASE WHEN v4_ok AND v_plan_used THEN EXISTS(SELECT 1 FROM pg_temp._rr3_plan_nonhouse rs
     WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.club_id=rs.club_id AND i.user_id=rs.player_id))
  WHEN v4_ok THEN EXISTS(SELECT 1 FROM pg_temp._rr3_week_v4 rs
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'round 3 stage anchor 9 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$ IF EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.status IS DISTINCT FROM 'pending'
   OR EXISTS(SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id))
$a$;
 r:=$r$ -- CHUNKED CLOSE (20261003, round 3 in batches): inside a chunked close attempt
 -- a period an earlier batch of THIS round paid is recognised by its own
 -- evidence and not paid again; outside one nothing is.
 v_batched:=COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on'
  AND NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'') IS NOT NULL;
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_done(period_id uuid PRIMARY KEY) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_done;
 IF v_batched THEN
  INSERT INTO pg_temp._routed_player_done SELECT i.period_id FROM pg_temp._routed_player_items i
   WHERE i.status='paid' AND (SELECT count(*) FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id)=1
    AND EXISTS(SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id AND pp.club_id=i.club_id AND pp.user_id=i.user_id
     AND pp.status='paid' AND pp.payout_amount=i.owed
     AND CASE WHEN i.owed>0 THEN EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.idempotency_key='round3-period:v3:'||i.period_id::text
       AND l.amount=i.owed AND l.club_id=i.club_id AND l.to_type='player_wallet' AND l.to_entity_id=i.user_id AND l.category='rakeback'
       AND l.metadata->>'accounting_scope_kind'=p_scope_kind AND l.metadata->>'accounting_scope_id'=p_scope_id::text
       AND l.metadata->>'certificate_id'=i.certificate_id::text AND l.metadata->>'payout_id'=pp.id::text
       AND l.metadata->>'source_fingerprint' IS NOT DISTINCT FROM i.fingerprint) ELSE true END);
 END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_todo(LIKE pg_temp._routed_player_items) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_todo;
 INSERT INTO pg_temp._routed_player_todo SELECT i.* FROM pg_temp._routed_player_items i
  WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_done d WHERE d.period_id=i.period_id);
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_now(period_id uuid PRIMARY KEY) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_now;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_player_todo i WHERE i.status IS DISTINCT FROM 'pending'
   OR EXISTS(SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id))
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'round 3 stage anchor 10 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$  SELECT club_id,user_id,owed AS delta FROM pg_temp._routed_player_items
  UNION ALL SELECT club_id,payer_user,-owed FROM pg_temp._routed_player_items WHERE payer_kind='agent') x GROUP BY club_id,user_id;
$a$;
 r:=$r$  SELECT club_id,user_id,owed AS delta FROM pg_temp._routed_player_todo
  UNION ALL SELECT club_id,payer_user,-owed FROM pg_temp._routed_player_todo WHERE payer_kind='agent') x GROUP BY club_id,user_id;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'round 3 stage anchor 11 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$ PERFORM id FROM public.clubs WHERE id IN(SELECT club_id FROM pg_temp._routed_player_items) ORDER BY id FOR NO KEY UPDATE;
$a$;
 r:=$r$ PERFORM id FROM public.clubs WHERE id IN(SELECT club_id FROM pg_temp._routed_player_todo) ORDER BY id FOR NO KEY UPDATE;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'round 3 stage anchor 12 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$ IF EXISTS(SELECT 1 FROM(SELECT club_id,payer_user,sum(owed) owed FROM pg_temp._routed_player_items WHERE payer_kind='agent' GROUP BY club_id,payer_user) x
$a$;
 r:=$r$ IF EXISTS(SELECT 1 FROM(SELECT club_id,payer_user,sum(owed) owed FROM pg_temp._routed_player_todo WHERE payer_kind='agent' GROUP BY club_id,payer_user) x
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'round 3 stage anchor 13 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$ IF EXISTS(SELECT 1 FROM(SELECT club_id,sum(owed) owed FROM pg_temp._routed_player_items WHERE payer_kind='club' GROUP BY club_id) x
$a$;
 r:=$r$ IF EXISTS(SELECT 1 FROM(SELECT club_id,sum(owed) owed FROM pg_temp._routed_player_todo WHERE payer_kind='club' GROUP BY club_id) x
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'round 3 stage anchor 14 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$ FOR r IN SELECT * FROM pg_temp._routed_player_items ORDER BY club_id,payer_user NULLS FIRST,user_id,period_id LOOP
$a$;
 r:=$r$ v_stop:=clock_timestamp()+interval '90 seconds';
 FOR r IN SELECT * FROM pg_temp._routed_player_todo ORDER BY club_id,payer_user NULLS FIRST,user_id,period_id LOOP
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'round 3 stage anchor 15 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$  UPDATE public.rakeback_periods SET status='paid',paid_at=now() WHERE id=r.period_id;
 END LOOP;
$a$;
 r:=$r$  UPDATE public.rakeback_periods SET status='paid',paid_at=now() WHERE id=r.period_id;
  INSERT INTO pg_temp._routed_player_now VALUES(r.period_id);
  IF v_batched AND clock_timestamp()>v_stop THEN EXIT; END IF;
 END LOOP;
 SELECT count(*) INTO v_remaining FROM pg_temp._routed_player_todo t WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_now n WHERE n.period_id=t.period_id);
 IF v_remaining>0 THEN
  -- A batch: every locked wallet must hold exactly what this batch paid it.
  UPDATE pg_temp._routed_player_wallets w SET delta=COALESCE((SELECT sum(x.delta) FROM(
   SELECT t.club_id,t.user_id,t.owed AS delta FROM pg_temp._routed_player_todo t JOIN pg_temp._routed_player_now n ON n.period_id=t.period_id
   UNION ALL SELECT t.club_id,t.payer_user,-t.owed FROM pg_temp._routed_player_todo t JOIN pg_temp._routed_player_now n ON n.period_id=t.period_id WHERE t.payer_kind='agent') x
   WHERE x.club_id=w.club_id AND x.user_id=w.user_id),0);
 END IF;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'round 3 stage anchor 16 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$ THEN RAISE EXCEPTION 'routed_rakeback_final_balance_incorrect' USING ERRCODE='23514'; END IF;
$a$;
 r:=$r$ THEN RAISE EXCEPTION 'routed_rakeback_final_balance_incorrect' USING ERRCODE='23514'; END IF;
 IF v_remaining>0 THEN
  RETURN jsonb_build_object('success',false,'batch_committed',true,'round',3,'routing_version',3,'source_version',2,'scope_kind',p_scope_kind,'scope_id',p_scope_id,
   'periods',(SELECT count(*) FROM pg_temp._routed_player_items),'paid_periods',(SELECT count(*) FROM pg_temp._routed_player_done)+(SELECT count(*) FROM pg_temp._routed_player_now),
   'remaining',v_remaining,'source_fingerprint',fingerprint,'plan_used',v_plan_used);
 END IF;
 -- The round's totals include what earlier batches of it paid.
 SELECT COALESCE(sum(i.owed),0),count(*) INTO v_paid_before,v_payees_before FROM pg_temp._routed_player_items i
  JOIN pg_temp._routed_player_done d ON d.period_id=i.period_id WHERE i.owed>0;
 paid:=paid+v_paid_before;payees:=payees+v_payees_before;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'round 3 stage anchor 17 count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'round 3 stage postimage differs from the substituted text'; END IF;
 -- cascade
 s:='public.fn_union_settlement_cascade(uuid,timestamptz,timestamptz)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'938d51161f05ac629704a10b13516e6a' THEN RAISE EXCEPTION 'cascade preimage %',md5(d); END IF;
 a:=$a$  IF v_r3 IS NULL THEN
  v_r3 := public.fn_settle_round3_agents_to_players(p_union_id, v_from, v_to);
  END IF;
$a$;
 r:=$r$  IF v_r3 IS NULL THEN
  v_r3 := public.fn_settle_round3_agents_to_players(p_union_id, v_from, v_to);
  END IF;
  -- CHUNKED CLOSE (20261003, round 3 in batches): a batch that paid part of
  -- round 3 ends this attempt as a committed step; the next attempt pays on.
  IF v_chunked AND v_r3->>'batch_committed' = 'true' THEN
    RETURN jsonb_build_object('success', false, 'chunk_committed', true, 'committed_round', 3, 'stage', 'round3_batch',
      'union_id', p_union_id, 'period_start', v_from, 'period_end', v_to, 'round3_batch', v_r3);
  END IF;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'cascade anchor 1 count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'cascade postimage differs from the substituted text'; END IF;
 -- scheduler
 s:='public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'e4c537a653cb577dc4c12d909a01c206' THEN RAISE EXCEPTION 'scheduler preimage %',md5(d); END IF;
 a:=$a$          IF v_chunked AND v_stage3->>'duplicate' IS DISTINCT FROM 'true' THEN
$a$;
 r:=$r$          -- CHUNKED CLOSE (20261003, round 3 in batches): as for a union book.
          IF v_chunked AND v_stage3->>'batch_committed'='true' THEN
            v_result:=jsonb_build_object('success',false,'chunk_committed',true,'committed_round',3,'stage','round3_batch','scope_kind','club','scope_id',v_club.id,
              'period_start',v_from,'period_end',v_end,'round2',v_stage2-'duplicate','round3_batch',v_stage3);
          ELSIF v_chunked AND v_stage3->>'duplicate' IS DISTINCT FROM 'true' THEN
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'scheduler anchor 1 count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'scheduler postimage differs from the substituted text'; END IF;
 -- windows pending
 s:='public.fn_accounting_close_windows_pending(uuid,uuid,timestamptz,timestamptz)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'5b0ffee25e034a08cbe13df5fd64332a' THEN RAISE EXCEPTION 'windows pending preimage %',md5(d); END IF;
 a:=$a$ IF EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r WHERE r.scope_kind=v_kind AND r.scope_id=v_scope
   AND r.period_start=p_period_start AND r.period_end=p_period_end AND r.round_no=2) THEN
  RETURN false;
 END IF;
$a$;
 r:=$r$ IF NOT EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r WHERE r.scope_kind=v_kind AND r.scope_id=v_scope
   AND r.period_start=p_period_start AND r.period_end=p_period_end AND r.round_no=2) THEN
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'windows pending anchor 1 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$ IF n_have=n_expected THEN RETURN false; END IF;
 PERFORM public.fn_settle_accounting_commission_advance(v_kind,v_scope,p_period_start,p_period_end);
 RETURN true;
END$a$;
 r:=$r$ IF n_have<>n_expected THEN
  PERFORM public.fn_settle_accounting_commission_advance(v_kind,v_scope,p_period_start,p_period_end);
  RETURN true;
 END IF;
 END IF;
 -- ROUND 3 READ ONCE (20261003): a book whose round 3 has no receipt proves its
 -- week's round-3 windows and reads its certificates once
 -- (fn_settle_accounting_rakeback_advance) in attempts of their own.
 IF NOT EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r WHERE r.scope_kind=v_kind AND r.scope_id=v_scope
   AND r.period_start=p_period_start AND r.period_end=p_period_end AND r.round_no=3)
  AND public.fn_settle_accounting_rakeback_advance(v_kind,v_scope,p_period_start,p_period_end) THEN
  RETURN true;
 END IF;
 RETURN false;
END$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'windows pending anchor 2 count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'windows pending postimage differs from the substituted text'; END IF;
END
$mig$;
COMMENT ON FUNCTION public.fn_accounting_close_windows_pending(uuid,uuid,timestamptz,timestamptz) IS
  'Chunked weekly close (20261003): proves the missing round-2 windows of a book whose round 2 has no receipt, or proves round 3''s windows and reads its certificates once (fn_settle_accounting_rakeback_advance) for a book whose round 3 has no receipt, and returns true (the attempt ends as a committed step); false when there was nothing to do or outside a chunked close attempt.';

COMMIT;
