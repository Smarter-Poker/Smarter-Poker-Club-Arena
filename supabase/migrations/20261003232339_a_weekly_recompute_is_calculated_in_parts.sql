-- 20261003232339_a_weekly_recompute_is_calculated_in_parts.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A WEEKLY RECOMPUTE IS CALCULATED IN PARTS
--
-- A book's weekly close prepares each club's week with one whole-period call of
-- fn_rakeback_recompute_periods / fn_calculate_cash_rakeback_periods, unless a
-- proven-current receipt exists. For Deep Stack Society that call took 285 s on
-- the week of 2026-09-21 (tournament gate ~80 s, three source-evidence counts
-- the bulk, the player plan and certificates the rest); the week closing
-- 2026-10-05 carries ~2.2-3.2x that, one transaction of ~15 minutes, beyond the
-- 5 minutes every close transaction keeps during play.
--
-- WHAT CHANGES (inside a chunked close attempt only; job 272 sets
-- app.weekly_accounting_chunked; everywhere else nothing does):
--  1. fn_rakeback_recompute_split(club, week) calculates the closed week in
--     parts of its own, committed by the attempts that make them, into the
--     unlogged accounting_recompute_split_parts, starting no part 90 s into the
--     attempt:
--     - the player pages (players in player_id order, about 20,000 sources a
--       page);
--     - the tournament gate in six-hour windows (fn_accounting_tournament_week_quality
--       over each window: every event the week checks is checked by exactly
--       the windows holding its recognition or bank instant, with the same
--       per-event proof; the week's answer is the first blocked event in
--       tournament_id order, so the windows' answer is the blocked answer with
--       the smallest tournament_id);
--     - the three source-evidence counts in two-hour windows
--       (fn_rakeback_split_counts: the calculator's own statement, its records
--       and its drifted sources restricted to the window; both partition the
--       week, and every count is a sum over them);
--     - a check pass over the pages (fn_rakeback_split_check: the calculator's
--       own plan query and every refusal of its loop, in its order, writing
--       nothing);
--     - only when the gate, the counts, the period test and every check pass:
--       a write pass over the pages (fn_rakeback_split_write: the calculator's
--       own plan query and loop body, verbatim);
--     then the receipt the whole-period call returns, recorded on the request
--     row exactly as fn_rakeback_recompute_periods records it. A refusal is
--     the one the whole-period call returns, in its order, with nothing
--     written. Parts are discarded when any source of the club-week was
--     recorded after the oldest of them (the preparation's own reuse rule),
--     when they are older than 12 hours, or computed before the week closed.
--  2. fn_prepare_accounting_week asks for it before the whole-period call; a
--     club still in progress is a problem 'weekly_calculation_in_progress'.
--  3. fn_process_weekly_accounting_scope ends an attempt whose preparation's
--     only problems are clubs in progress as a committed step ('calculating'),
--     for union books and standalone clubs alike.
--
-- @live-proof: to_regprocedure('public.fn_rakeback_recompute_split(uuid,date,date)') IS NOT NULL
-- @live-proof: position('fn_rakeback_recompute_split' in pg_get_functiondef('public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure)) > 0
-- @live-proof: position('fn_accounting_preparation_calculating' in pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure)) > 0
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '90s';

CREATE UNLOGGED TABLE public.accounting_recompute_split_parts (
  club_id uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('players','tq','counts','check','write')),
  part integer NOT NULL,
  value jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (club_id, period_start, kind, part)
);
ALTER TABLE public.accounting_recompute_split_parts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_recompute_split_parts FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.accounting_recompute_split_parts IS
  'Split weekly recompute (20261003): the parts of one club-week''s whole-period calculation (player pages, tournament gate windows, evidence count windows, check and write pages) proved by earlier chunked close attempts; unlogged, recomputed whenever lost or stale.';

DO $build$
DECLARE d text; cs integer; ce integer; c text; qs integer; qe integer; qry text; bd text; chk text; m text;
BEGIN
 d:=pg_get_functiondef('public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])'::regprocedure);
 IF md5(d)<>'80901b5c7d69f5ec2fed0d0d3d8364ee' THEN RAISE EXCEPTION 'calculator preimage %',md5(d); END IF;
 -- the whole-period counts statement
 m:=$m$ WITH week_records AS MATERIALIZED (
$m$;
 IF (length(d)-length(replace(d,m,'')))/length(m)<>1 THEN RAISE EXCEPTION 'calculator counts marker'; END IF;
 cs:=position(m in d);
 m:=$m$   FROM evidence,incomplete,drifted;
$m$;
 ce:=cs+position(m in substr(d,cs))-1+length(m);
 c:=substr(d,cs,ce-cs);
 m:=$m$   WHERE r.created_at>=v_from AND r.created_at<v_to AND r.rake_amount>0
$m$;
 IF (length(c)-length(replace(c,m,'')))/length(m)<>1 THEN RAISE EXCEPTION 'counts edit 1'; END IF;
 c:=replace(c,m,$r$   WHERE r.created_at>=w_from AND r.created_at<w_to AND r.rake_amount>0
$r$);
 m:=$m$   FROM public.accounting_cash_rake_sources s
   WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to
 ), scoped_records$m$;
 IF (length(c)-length(replace(c,m,'')))/length(m)<>1 THEN RAISE EXCEPTION 'counts edit 2'; END IF;
 c:=replace(c,m,$r$   FROM public.accounting_cash_rake_sources s JOIN week_records w ON w.id=s.rake_record_id
   WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to
 ), scoped_records$r$);
 m:=$m$   WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to
    AND (r.id IS NULL$m$;
 IF (length(c)-length(replace(c,m,'')))/length(m)<>1 THEN RAISE EXCEPTION 'counts edit 3'; END IF;
 c:=replace(c,m,$r$   WHERE s.club_id=p_club_id AND s.earned_at>=w_from AND s.earned_at<w_to
    AND (r.id IS NULL$r$);
 -- the plan query and the loop body
 m:=$m$ FOR player IN
$m$;
 IF (length(d)-length(replace(d,m,'')))/length(m)<>1 THEN RAISE EXCEPTION 'calculator loop marker'; END IF;
 qs:=position(m in d)+length(m);
 m:=$m$
 LOOP
$m$;
 qe:=qs+position(m in substr(d,qs))-1;
 qry:=substr(d,qs,qe-qs);
 qs:=qe+length(m);
 m:=$m$
 END LOOP;
$m$;
 qe:=qs+position(m in substr(d,qs))-1;
 bd:=substr(d,qs,qe-qs)||E'\n';
 m:=$m$   period_id:=existing.id;
$m$;
 IF (length(bd)-length(replace(bd,m,'')))/length(m)<>1 THEN RAISE EXCEPTION 'loop body marker'; END IF;
 chk:=substr(bd,1,position(m in bd)-1)||'  END IF;'||E'\n';
 EXECUTE $h$CREATE FUNCTION public.fn_rakeback_split_counts(p_club_id uuid, v_from timestamptz, v_to timestamptz, w_from timestamptz, w_to timestamptz)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $fn$
-- The three source-evidence counts of fn_calculate_cash_rakeback_periods'
-- whole-period call, over the rake records created and the sources earned in
-- w_from..w_to of the week v_from..v_to (20261003). Its own statement (built
-- from its text by this migration): only the record and drifted-source ranges
-- are the window's, and the sources a window record can join are read from
-- the whole week.
DECLARE scope_union uuid; evidence_issues bigint; incomplete_issues bigint; drifted_issues bigint;
BEGIN
 SELECT union_id INTO scope_union FROM public.clubs WHERE id=p_club_id;
$h$||c||$t$ RETURN jsonb_build_object('evidence',evidence_issues,'incomplete',incomplete_issues,'drifted',drifted_issues);
END
$fn$$t$;
 EXECUTE $h$CREATE FUNCTION public.fn_rakeback_split_check(p_club_id uuid, p_period_start date, p_period_end date, p_user_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $fn$
-- One page of fn_calculate_cash_rakeback_periods' loop, checked and not
-- written (20261003): its plan query for the page's players and every refusal
-- of its loop body, in its order, up to the certified-period test (both built
-- from its text by this migration). The first refusal is returned with its
-- player; otherwise the page's player count, how many already hold a
-- certificate of the same fingerprint, and a digest.
DECLARE
 v_from timestamptz; v_to timestamptz; existing public.rakeback_periods%ROWTYPE;
 certificate public.accounting_rakeback_period_calculations%ROWTYPE;
 player record; total_unrounded numeric; amount numeric; display_rate numeric;
 payer_kind text; payer_user uuid; coordinator_union uuid; allocations jsonb; plan jsonb;
 fingerprint text; period_id uuid; written integer:=0; confirmed integer:=0;
 n integer:=0; n_same integer:=0; dg text:='';
BEGIN
 v_from:=p_period_start::timestamp AT TIME ZONE 'America/Los_Angeles';
 v_to:=(p_period_end+1)::timestamp AT TIME ZONE 'America/Los_Angeles';
 BEGIN
 FOR player IN
$h$||qry||$x$
 LOOP
$x$||chk||$t$  n:=n+1;
  IF existing.id IS NOT NULL AND certificate.source_fingerprint=plan->>'source_fingerprint' THEN n_same:=n_same+1; END IF;
  dg:=md5(dg||player.player_id::text||':'||fingerprint);
 END LOOP;
 EXCEPTION WHEN SQLSTATE '55000' THEN
  RETURN jsonb_build_object('reason',SQLERRM,'player_id',player.player_id);
 END;
 RETURN jsonb_build_object('players',n,'same',n_same,'digest',dg);
END
$fn$$t$;
 EXECUTE $h$CREATE FUNCTION public.fn_rakeback_split_write(p_club_id uuid, p_period_start date, p_period_end date, p_user_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $fn$
-- One page of fn_calculate_cash_rakeback_periods' loop (20261003): its plan
-- query for the page's players and its loop body, verbatim (built from its
-- text by this migration). Called only after every page passed
-- fn_rakeback_split_check.
DECLARE
 v_from timestamptz; v_to timestamptz; existing public.rakeback_periods%ROWTYPE;
 certificate public.accounting_rakeback_period_calculations%ROWTYPE;
 player record; total_unrounded numeric; amount numeric; display_rate numeric;
 payer_kind text; payer_user uuid; coordinator_union uuid; allocations jsonb; plan jsonb;
 fingerprint text; period_id uuid; written integer:=0; confirmed integer:=0;
BEGIN
 v_from:=p_period_start::timestamp AT TIME ZONE 'America/Los_Angeles';
 v_to:=(p_period_end+1)::timestamp AT TIME ZONE 'America/Los_Angeles';
 FOR player IN
$h$||qry||$x$
 LOOP
$x$||bd||$t$ END LOOP;
 RETURN jsonb_build_object('written',written,'confirmed',confirmed);
END
$fn$$t$;
 IF md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_rakeback_split_counts(uuid,timestamptz,timestamptz,timestamptz,timestamptz)'::regprocedure))<>'0fcb9ee74db9f93000e3d78a2e21f599' THEN RAISE EXCEPTION 'counts source %',md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_rakeback_split_counts(uuid,timestamptz,timestamptz,timestamptz,timestamptz)'::regprocedure)); END IF;
 IF md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_rakeback_split_check(uuid,date,date,uuid[])'::regprocedure))<>'2adb0b499cb43e0731f8e379701407b9' THEN RAISE EXCEPTION 'check source %',md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_rakeback_split_check(uuid,date,date,uuid[])'::regprocedure)); END IF;
 IF md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_rakeback_split_write(uuid,date,date,uuid[])'::regprocedure))<>'85104036686f3cb3665018e4ee749f36' THEN RAISE EXCEPTION 'write source %',md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_rakeback_split_write(uuid,date,date,uuid[])'::regprocedure)); END IF;
END
$build$;
REVOKE ALL ON FUNCTION public.fn_rakeback_split_counts(uuid,timestamptz,timestamptz,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_rakeback_split_check(uuid,date,date,uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_rakeback_split_write(uuid,date,date,uuid[]) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.fn_accounting_preparation_calculating(p_preparation jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $f$
 -- A preparation whose only problems are clubs whose week is still being
 -- calculated in parts (20261003).
 SELECT CASE WHEN p_preparation->>'success' IS DISTINCT FROM 'true' AND jsonb_typeof(p_preparation->'problems')='array'
   THEN jsonb_array_length(p_preparation->'problems')>0
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_preparation->'problems') x
     WHERE x->>'reason' IS DISTINCT FROM 'weekly_calculation_in_progress')
   ELSE false END
$f$;
REVOKE ALL ON FUNCTION public.fn_accounting_preparation_calculating(jsonb) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.fn_rakeback_recompute_split(p_club_id uuid, p_period_start date, p_period_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $f$
-- A CLOSED WEEK'S RECOMPUTE IN PARTS (20261003). Inside a chunked close
-- attempt: the whole-period call of fn_rakeback_recompute_periods for this
-- club-week, made of parts kept across attempts (see the migration header).
-- Answers 'in_progress' while parts remain, or exactly what
-- fn_rakeback_recompute_periods returns, with the request row it records.
-- NULL outside a chunked close attempt, for an open or pre-cutover week and
-- for an unknown club: the caller then makes the whole-period call itself.
DECLARE v_from timestamptz; v_to timestamptz; cutover timestamptz; began timestamptz; did boolean:=false;
 oldest timestamptz; w record; v jsonb; pages jsonb; n_pages integer; i integer; ids uuid[];
 tq jsonb; ev bigint; inc bigint; dr bigint; issue_count bigint; receipt jsonb; result jsonb;
 request public.accounting_period_recompute_requests%ROWTYPE; request_state text;
BEGIN
 IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
  OR NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'') IS NULL
  OR p_club_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
  OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
  OR extract(isodow FROM p_period_start)<>1 OR p_period_end<>p_period_start+6 THEN
  RETURN NULL;
 END IF;
 v_from:=p_period_start::timestamp AT TIME ZONE 'America/Los_Angeles';
 v_to:=(p_period_end+1)::timestamp AT TIME ZONE 'America/Los_Angeles';
 SELECT starts_at INTO cutover FROM public.accounting_cash_accrual_cutover WHERE singleton;
 IF v_to>clock_timestamp() OR cutover IS NULL OR v_from<cutover
  OR NOT EXISTS(SELECT 1 FROM public.clubs WHERE id=p_club_id) THEN
  RETURN NULL;
 END IF;
 -- The calculator's own club-week lock, for every part and the receipt.
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_rakeback_period:'||p_club_id::text||':'||p_period_start::text,0));
 began:=NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'')::timestamptz
  -COALESCE(NULLIF(current_setting('app.weekly_accounting_scope_budget',true),''),'8 minutes')::interval;
 -- At least one part per attempt (not per club): a union book asks for each
 -- of its clubs in one attempt.
 did:=COALESCE(current_setting('app.accounting_split_did',true),'')='on';
 -- Parts are kept only while no source of this club-week was recorded after
 -- the oldest of them (the preparation's reuse rule), for 12 hours, and only
 -- when made after the week closed.
 SELECT min(computed_at) INTO oldest FROM public.accounting_recompute_split_parts
  WHERE club_id=p_club_id AND period_start=p_period_start;
 IF oldest IS NOT NULL AND (oldest<v_to OR oldest<clock_timestamp()-interval '12 hours'
   OR EXISTS(SELECT 1 FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start AND period_end<>p_period_end)
   OR EXISTS(SELECT 1 FROM public.accounting_cash_rake_sources s
     WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to AND s.recorded_at>oldest-interval '1 minute')
   OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources f
     WHERE f.club_id=p_club_id AND f.charged_at<v_to AND f.recorded_at>oldest-interval '1 minute')) THEN
  DELETE FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start;
 END IF;
 -- 1. The player pages.
 IF NOT EXISTS(SELECT 1 FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start AND kind='players') THEN
  IF did AND clock_timestamp()>began+interval '90 seconds' THEN
   RETURN jsonb_build_object('status','in_progress','club_id',p_club_id,'period_start',p_period_start,'period_end',p_period_end,'stage','players');
  END IF;
  WITH p AS (SELECT s.player_id,count(*) AS n FROM public.accounting_payable_earning_sources s
    WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to GROUP BY s.player_id),
  q AS (SELECT p.player_id,((sum(p.n) OVER(ORDER BY p.player_id)-p.n)/20000)::bigint AS pg FROM p)
  SELECT COALESCE(jsonb_agg(x.ids ORDER BY x.pg),'[]'::jsonb) INTO pages
   FROM (SELECT q.pg,jsonb_agg(q.player_id ORDER BY q.player_id) AS ids FROM q GROUP BY q.pg) x;
  INSERT INTO public.accounting_recompute_split_parts(club_id,period_start,period_end,kind,part,value)
  VALUES(p_club_id,p_period_start,p_period_end,'players',0,jsonb_build_object('pages',pages));
  did:=true; PERFORM set_config('app.accounting_split_did','on',true);
 END IF;
 SELECT value->'pages' INTO pages FROM public.accounting_recompute_split_parts
  WHERE club_id=p_club_id AND period_start=p_period_start AND kind='players' AND part=0;
 n_pages:=jsonb_array_length(pages);
 -- 2. The tournament gate, six hours at a time.
 FOR w IN SELECT (row_number() OVER(ORDER BY g)-1)::int AS idx,g AS ws,LEAST(g+interval '6 hours',v_to) AS we
   FROM generate_series(v_from,v_to-interval '1 microsecond',interval '6 hours') g ORDER BY 1 LOOP
  CONTINUE WHEN EXISTS(SELECT 1 FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start AND kind='tq' AND part=w.idx);
  IF did AND clock_timestamp()>began+interval '90 seconds' THEN EXIT; END IF;
  INSERT INTO public.accounting_recompute_split_parts(club_id,period_start,period_end,kind,part,value)
  VALUES(p_club_id,p_period_start,p_period_end,'tq',w.idx,public.fn_accounting_tournament_week_quality(p_club_id,w.ws,w.we));
  did:=true; PERFORM set_config('app.accounting_split_did','on',true);
 END LOOP;
 -- 3. The source-evidence counts, two hours at a time.
 FOR w IN SELECT (row_number() OVER(ORDER BY g)-1)::int AS idx,g AS ws,LEAST(g+interval '2 hours',v_to) AS we
   FROM generate_series(v_from,v_to-interval '1 microsecond',interval '2 hours') g ORDER BY 1 LOOP
  CONTINUE WHEN EXISTS(SELECT 1 FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start AND kind='counts' AND part=w.idx);
  IF did AND clock_timestamp()>began+interval '90 seconds' THEN EXIT; END IF;
  INSERT INTO public.accounting_recompute_split_parts(club_id,period_start,period_end,kind,part,value)
  VALUES(p_club_id,p_period_start,p_period_end,'counts',w.idx,public.fn_rakeback_split_counts(p_club_id,v_from,v_to,w.ws,w.we));
  did:=true; PERFORM set_config('app.accounting_split_did','on',true);
 END LOOP;
 IF (SELECT count(*) FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start AND kind='tq')
    <>(SELECT count(*) FROM generate_series(v_from,v_to-interval '1 microsecond',interval '6 hours'))
  OR (SELECT count(*) FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start AND kind='counts')
    <>(SELECT count(*) FROM generate_series(v_from,v_to-interval '1 microsecond',interval '2 hours')) THEN
  RETURN jsonb_build_object('status','in_progress','club_id',p_club_id,'period_start',p_period_start,'period_end',p_period_end,'stage','windows');
 END IF;
 -- The whole-period call's receipt and its tests, in its order.
 receipt:=jsonb_build_object('accounting_version',2,'club_id',p_club_id,'period_start',p_period_start,'period_end',p_period_end,'written',0,'status','blocked');
 SELECT p.value INTO tq FROM public.accounting_recompute_split_parts p
  WHERE p.club_id=p_club_id AND p.period_start=p_period_start AND p.kind='tq' AND p.value->>'status' IS DISTINCT FROM 'ready'
  ORDER BY (p.value->>'tournament_id')::uuid NULLS LAST,p.part LIMIT 1;
 IF tq IS NOT NULL THEN
  result:=receipt||tq||jsonb_build_object('written',0);
 ELSE
  SELECT sum((value->>'evidence')::bigint),sum((value->>'incomplete')::bigint),sum((value->>'drifted')::bigint) INTO ev,inc,dr
   FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start AND kind='counts';
  IF ev>0 THEN result:=receipt||jsonb_build_object('reason','cash_earning_evidence_incomplete','source_count',ev); END IF;
  IF result IS NULL THEN
   SELECT count(*) INTO issue_count FROM public.rakeback_periods rp
    WHERE rp.club_id=p_club_id AND rp.period_start<=p_period_end AND rp.period_end>=p_period_start
      AND (rp.status<>'pending' OR rp.period_start<>p_period_start OR rp.period_end<>p_period_end
        OR NOT EXISTS(SELECT 1 FROM public.accounting_rakeback_period_calculations c WHERE c.period_id=rp.id));
   IF issue_count>0 THEN result:=receipt||jsonb_build_object('reason','legacy_or_paid_period_requires_reconciliation','period_count',issue_count);
   ELSIF inc>0 THEN result:=receipt||jsonb_build_object('reason','cash_source_receipts_incomplete','source_count',inc);
   ELSIF dr>0 THEN result:=receipt||jsonb_build_object('reason','cash_source_receipts_drifted','source_count',dr);
   END IF;
  END IF;
 END IF;
 -- 4. The check pass, then 5. the write pass, page by page.
 IF result IS NULL THEN
  FOR i IN 0..n_pages-1 LOOP
   CONTINUE WHEN EXISTS(SELECT 1 FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start AND kind='check' AND part=i);
   IF did AND clock_timestamp()>began+interval '90 seconds' THEN
    RETURN jsonb_build_object('status','in_progress','club_id',p_club_id,'period_start',p_period_start,'period_end',p_period_end,'stage','check');
   END IF;
   ids:=ARRAY(SELECT jsonb_array_elements_text(pages->i)::uuid);
   INSERT INTO public.accounting_recompute_split_parts(club_id,period_start,period_end,kind,part,value)
   VALUES(p_club_id,p_period_start,p_period_end,'check',i,public.fn_rakeback_split_check(p_club_id,p_period_start,p_period_end,ids));
   did:=true; PERFORM set_config('app.accounting_split_did','on',true);
  END LOOP;
  SELECT receipt||jsonb_build_object('reason',p.value->>'reason') INTO result FROM public.accounting_recompute_split_parts p
   WHERE p.club_id=p_club_id AND p.period_start=p_period_start AND p.kind='check' AND p.value ? 'reason' ORDER BY p.part LIMIT 1;
 END IF;
 IF result IS NULL THEN
  FOR i IN 0..n_pages-1 LOOP
   CONTINUE WHEN EXISTS(SELECT 1 FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start AND kind='write' AND part=i);
   IF did AND clock_timestamp()>began+interval '90 seconds' THEN
    RETURN jsonb_build_object('status','in_progress','club_id',p_club_id,'period_start',p_period_start,'period_end',p_period_end,'stage','write');
   END IF;
   ids:=ARRAY(SELECT jsonb_array_elements_text(pages->i)::uuid);
   INSERT INTO public.accounting_recompute_split_parts(club_id,period_start,period_end,kind,part,value)
   VALUES(p_club_id,p_period_start,p_period_end,'write',i,public.fn_rakeback_split_write(p_club_id,p_period_start,p_period_end,ids));
   did:=true; PERFORM set_config('app.accounting_split_did','on',true);
  END LOOP;
  SELECT receipt||jsonb_build_object('status','ready','written',COALESCE(sum((value->>'written')::integer),0),'confirmed_players',COALESCE(sum((value->>'confirmed')::integer),0))
   INTO result FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start AND kind='write';
 END IF;
 -- The request row, exactly as fn_rakeback_recompute_periods records a
 -- whole-period call.
 INSERT INTO public.accounting_period_recompute_requests(club_id,period_start,period_end)
  VALUES(p_club_id,p_period_start,p_period_end)
  ON CONFLICT(club_id,period_start,period_end) DO UPDATE SET last_requested_at=clock_timestamp(),status='pending',reason=NULL
  RETURNING * INTO request;
 request_state:=CASE WHEN result->>'status'='ready' THEN 'complete' ELSE 'blocked' END;
 UPDATE public.accounting_period_recompute_requests SET status=request_state,reason=result->>'reason',
  attempted_at=clock_timestamp(),attempts=attempts+1,last_result=result WHERE id=request.id;
 DELETE FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start;
 RETURN result||jsonb_build_object('request_id',request.id,'requested_at',request.requested_at,
  'request_state',request_state,'request_recorded',true);
END
$f$;
REVOKE ALL ON FUNCTION public.fn_rakeback_recompute_split(uuid,date,date) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.fn_rakeback_recompute_split(uuid,date,date) IS
  'Split weekly recompute (20261003): inside a chunked close attempt, the whole-period fn_rakeback_recompute_periods call of a closed club-week made of parts kept across attempts (player pages, tournament gate windows, evidence count windows, check and write pages); in_progress while parts remain, else its exact result and request row; NULL elsewhere.';

DO $mig$
DECLARE s regprocedure; d text; a text; r text;
BEGIN
 -- preparation
 s:='public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'33048b9230c8fb74e278fd915b053566' THEN RAISE EXCEPTION 'preparation preimage %',md5(d); END IF;
 a:=$a$  result:=public.fn_rakeback_recompute_periods(club,from_date,to_date,NULL);
$a$;
 r:=$r$  -- SPLIT RECOMPUTE (20261003): inside a chunked close attempt a closed week
  -- is calculated in parts of its own (fn_rakeback_recompute_split); NULL
  -- everywhere else, and the whole-period call follows as before.
  result:=public.fn_rakeback_recompute_split(club,from_date,to_date);
  IF result->>'status'='in_progress' THEN
   problems:=problems||jsonb_build_array(jsonb_build_object('club_id',club,'period_start',from_date,'period_end',to_date,
    'reason','weekly_calculation_in_progress'));
   CONTINUE;
  END IF;
  IF result IS NULL THEN
  result:=public.fn_rakeback_recompute_periods(club,from_date,to_date,NULL);
  END IF;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'preparation anchor 1 count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'preparation postimage differs from the substituted text'; END IF;
 -- scheduler
 s:='public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'7f78ea4582c827a26d5cb72093cea058' THEN RAISE EXCEPTION 'scheduler preimage %',md5(d); END IF;
 a:=$a$          v_result:=jsonb_build_object('success',false,'chunk_committed',true,'committed_round',0,'stage','certifying',
            'union_id',v_union.id,'period_start',v_from,'period_end',v_end);
$a$;
 r:=$r$          v_result:=jsonb_build_object('success',false,'chunk_committed',true,'committed_round',0,'stage','certifying',
            'union_id',v_union.id,'period_start',v_from,'period_end',v_end);
        -- SPLIT RECOMPUTE (20261003): a preparation whose only problems are
        -- clubs whose week is still calculated in parts ends this attempt as
        -- a committed step.
        ELSIF v_chunked AND public.fn_accounting_preparation_calculating(v_preparation) THEN
          v_result:=jsonb_build_object('success',false,'chunk_committed',true,'committed_round',0,'stage','calculating',
            'union_id',v_union.id,'period_start',v_from,'period_end',v_end);
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'scheduler anchor 1 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$          IF v_preparation->>'success' IS DISTINCT FROM 'true' THEN
            RAISE EXCEPTION 'weekly_accounting_calculation_incomplete' USING DETAIL=v_preparation::text;END IF;
$a$;
 r:=$r$          IF v_preparation->>'success' IS DISTINCT FROM 'true'
            AND NOT (v_chunked AND public.fn_accounting_preparation_calculating(v_preparation)) THEN
            RAISE EXCEPTION 'weekly_accounting_calculation_incomplete' USING DETAIL=v_preparation::text;END IF;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'scheduler anchor 2 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$          IF v_chunked AND (CASE WHEN public.fn_accounting_close_prepared_long(NULL,v_club.id,v_from,v_end) THEN true
$a$;
 r:=$r$          -- SPLIT RECOMPUTE (20261003): a club whose week is still calculated in
          -- parts ends this attempt as a committed step ('calculating').
          IF v_chunked AND (CASE WHEN public.fn_accounting_preparation_calculating(v_preparation) THEN true
            WHEN public.fn_accounting_close_prepared_long(NULL,v_club.id,v_from,v_end) THEN true
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'scheduler anchor 3 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$            v_result:=jsonb_build_object('success',false,'chunk_committed',true,'committed_round',0,'stage','prepared','scope_kind','club','scope_id',v_club.id,
$a$;
 r:=$r$            v_result:=jsonb_build_object('success',false,'chunk_committed',true,'committed_round',0,
              'stage',CASE WHEN public.fn_accounting_preparation_calculating(v_preparation) THEN 'calculating' ELSE 'prepared' END,'scope_kind','club','scope_id',v_club.id,
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'scheduler anchor 4 count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'scheduler postimage differs from the substituted text'; END IF;
END
$mig$;

COMMIT;
