-- 20261003140241_the_earned_plan_is_proved_two_hours_at_a_time.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE EARNED PLAN IS PROVED TWO HOURS AT A TIME
--
-- The lease agent found (2026-10-03) that any transaction running more than
-- ~9 minutes during play bloats the tournament lease rows and expires leases
-- (~800 at 09:34-09:38 during a 15-minute probe), and the coordinator capped
-- every close transaction at 5 minutes. The union earned plan
-- (fn_accounting_union_earned_plan_sets) took 193 s and 320 s for Midway's
-- week of 2026-09-21 (548k sources, jobs 414 and 417); the week closing
-- 2026-10-05 is projected at ~3.2x the sources (1.09M cash sources by
-- 2026-10-03 12:45 UTC, ~13k an hour since), 10-17 minutes in one statement.
--
-- WHAT CHANGES, ONLY INSIDE A CHUNKED UNION CLOSE ATTEMPT (job 272 sets
-- app.weekly_accounting_chunked; app.accounting_close_memo is on):
--  1. fn_accounting_union_earned_plan_window is the set path itself
--     (fn_accounting_union_earned_plan_sets, derived from its live text by the
--     anchored edits below) run over one two-hour window of the week. Every one
--     of its six proofs is a test of one source, bank row or receipt against
--     rows of the same instant, so the week passes exactly when every window
--     passes. For a passing window it returns the window's raw sums (bank,
--     sources, house), its club/game basis sums (rake and rake x rate) and
--     every source's own row md5 with its id; for anything else, nothing.
--  2. fn_accounting_union_earned_plan_advance proves the week's missing
--     windows in order, at least one per attempt and none started more than
--     120 s after the attempt began, and keeps each in the unlogged
--     accounting_close_partials (a cache of a closed week, recomputed if lost).
--     A window the set path does not certify is proved by
--     fn_accounting_union_earned_plan_v3 over that window, which refuses
--     exactly as it refuses the week; if v3 passes it, the attempt refuses with
--     union_earned_plan_window_unproved and nothing is paid.
--  3. fn_accounting_union_earned_plan_combine builds the plan from all the
--     windows, kept after the period closed and within 12 hours: the same
--     conservation refusal, the sums of the window sums (numeric, exact), the
--     club basis rate and payout from the summed rake and rake x rate, and the
--     fingerprint as the md5 of every source's row md5 in (source_type,
--     source_id) order - the same value, byte for byte, as the set path.
--     fn_accounting_union_earned_plan answers from it before the set path.
--  4. fn_union_pnl_evidence_report advances the windows before its earned plan
--     step and stops 'warming' while any is missing.
-- Outside a chunked close nothing here runs and nothing changes.
--
-- PROOF: the combined plan of Midway's closed week 2026-09-21..28 is compared,
-- by md5 of its text, with dab1e5a65a3084c4c0dffb8ca18f7a45, the md5 of the
-- plan the set path and v3 returned for that week (jobs 414 and 417); the
-- result is recorded in docs/changelog/2026-10-03-the-earned-plan-is-proved-
-- two-hours-at-a-time.md.
--
-- @live-proof: to_regprocedure('public.fn_accounting_union_earned_plan_combine(uuid,timestamptz,timestamptz)') IS NOT NULL
-- @live-proof: position('fn_accounting_union_earned_plan_advance' in pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'::regprocedure)) > 0
-- @live-proof: position('fn_accounting_union_earned_plan_combine' in pg_get_functiondef('public.fn_accounting_union_earned_plan(uuid,timestamptz,timestamptz)'::regprocedure)) > 0
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '90s';

-- Partial results of a chunked close, per window of its closed week. Unlogged:
-- a cache of a closed week's deterministic proofs, recomputed if a crash
-- empties it, and kept out of the WAL of a WAL-bound database.
CREATE UNLOGGED TABLE public.accounting_close_partials (
  kind text NOT NULL CHECK (kind IN ('earned_plan_window')),
  union_id uuid NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  value jsonb NOT NULL,
  cash_ids uuid[],
  cash_md5 bytea,
  fee_ids uuid[],
  fee_md5 bytea,
  computed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (kind, union_id, period_start, period_end, window_start)
);
ALTER TABLE public.accounting_close_partials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_close_partials FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.accounting_close_partials IS
  'Chunked weekly close (20261003): proved partial results of one window of a closed week (earned plan sums, basis sums and per-source row md5s), combined into the week''s result by the close. Unlogged cache; read only inside a chunked close attempt, for 12 hours after it was proved.';

CREATE FUNCTION public.fn_accounting_close_windows(p_start timestamptz, p_end timestamptz)
 RETURNS TABLE(window_start timestamptz, window_end timestamptz)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $f$
 SELECT g, LEAST(g+interval '2 hours', p_end)
   FROM generate_series(p_start, p_end-interval '1 microsecond', interval '2 hours') g
  WHERE p_start<p_end AND isfinite(p_start) AND isfinite(p_end)
$f$;
REVOKE ALL ON FUNCTION public.fn_accounting_close_windows(timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.fn_accounting_close_windows(timestamptz,timestamptz) IS
  'Chunked weekly close (20261003): the two-hour windows of a closed period, in order, the last one cut at the period end.';

DO $mig$
DECLARE s regprocedure; d text; a text; r text;
BEGIN
 -- earned plan window
 s:='public.fn_accounting_union_earned_plan_sets(uuid,timestamptz,timestamptz)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'c7548ae4cfa6ff517316bee6715447b4' THEN RAISE EXCEPTION 'earned plan window preimage %',md5(d); END IF;
 a:=$a$CREATE OR REPLACE FUNCTION public.fn_accounting_union_earned_plan_sets(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS jsonb
$a$;
 r:=$r$CREATE OR REPLACE FUNCTION public.fn_accounting_union_earned_plan_window(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS TABLE(value jsonb, cash_ids uuid[], cash_md5 bytea, fee_ids uuid[], fee_md5 bytea)
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'earned plan window anchor 1 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$BEGIN
 -- THE EARNED PLAN, READ AS SETS (20261003).$a$;
 r:=$r$BEGIN
 -- ONE WINDOW OF THE EARNED PLAN (chunked close, 20261003): the set path
 -- below, derived from fn_accounting_union_earned_plan_sets, over one window
 -- p_start..p_end of a closed week. A passing window returns its raw sums, its
 -- club/game basis sums and every source's row md5 with its id, which
 -- fn_accounting_union_earned_plan_combine adds up into the week's plan.
 -- Anything else returns no row. The set path's own header follows.
 -- THE EARNED PLAN, READ AS SETS (20261003).$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'earned plan window anchor 2 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$  SELECT k.q1,k.q2,k.q3,k.q4,k.q5,k.q6,
   (SELECT COALESCE(sum(amount),0) FROM tw) AS bank_total,
   (SELECT COALESCE(sum(rake_credit),0) FROM src) AS source_total,
   (SELECT COALESCE(sum(rake_credit) FILTER(WHERE house_flag),0) FROM src) AS house_total,
   (SELECT md5(COALESCE(string_agg(row_md5,'' ORDER BY source_type,source_id),'')) FROM src) AS fingerprint,
   (SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY club_id,game_type),'[]') FROM basis b) AS detail
  FROM counts k
$a$;
 r:=$r$  SELECT k.q1,k.q2,k.q3,k.q4,k.q5,k.q6,
   (SELECT sum(amount) FROM tw) AS bank_sum,
   (SELECT sum(rake_credit) FROM src) AS source_sum,
   (SELECT sum(rake_credit) FILTER(WHERE house_flag) FROM src) AS house_sum,
   (SELECT COALESCE(jsonb_agg(jsonb_build_object('club_id',p.club_id,'game_type',p.game_type,'rake_in',p.rake_in,'weighted',p.weighted) ORDER BY p.club_id,p.game_type),'[]')
     FROM (SELECT club_id,game_type,sum(rake_credit) AS rake_in,sum(rake_credit*rate) AS weighted FROM src WHERE is_house IS FALSE GROUP BY club_id,game_type) p) AS basis_part,
   (SELECT count(*) FROM src WHERE source_type NOT IN('cash_rake_accrual','tournament_fee_accrual')) AS other_types,
   (SELECT array_agg(source_id ORDER BY source_id) FROM src WHERE source_type='cash_rake_accrual') AS cash_ids,
   (SELECT string_agg(decode(row_md5,'hex'),''::bytea ORDER BY source_id) FROM src WHERE source_type='cash_rake_accrual') AS cash_md5,
   (SELECT array_agg(source_id ORDER BY source_id) FROM src WHERE source_type='tournament_fee_accrual') AS fee_ids,
   (SELECT string_agg(decode(row_md5,'hex'),''::bytea ORDER BY source_id) FROM src WHERE source_type='tournament_fee_accrual') AS fee_md5
  FROM counts k
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'earned plan window anchor 3 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$ IF res.q1<>0 OR res.q2<>0 OR res.q3<>0 OR res.q4<>0 OR res.q5<>0 OR res.q6<>0
  OR res.bank_total IS NULL OR res.source_total IS DISTINCT FROM res.bank_total THEN
  RETURN NULL;
 END IF;
 RETURN jsonb_build_object('accounting_version',3,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,
  'period_rake',res.bank_total,'earned_rake',res.source_total,'house_rake',res.house_total,'source_fingerprint',res.fingerprint,'basis_detail',res.detail);
$a$;
 r:=$r$ -- The week's conservation test (sources = bank) is the combine's: a window
 -- may hold a bank row whose sources are in it and still differ in its sums.
 IF res.q1<>0 OR res.q2<>0 OR res.q3<>0 OR res.q4<>0 OR res.q5<>0 OR res.q6<>0 OR res.other_types<>0 THEN
  RETURN;
 END IF;
 RETURN QUERY SELECT jsonb_build_object('bank_sum',res.bank_sum,'source_sum',res.source_sum,'house_sum',res.house_sum,'basis',res.basis_part),
  res.cash_ids,res.cash_md5,res.fee_ids,res.fee_md5;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'earned plan window anchor 4 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$RETURN NULL;$a$;
 r:=$r$RETURN;$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>2 THEN RAISE EXCEPTION 'earned plan window anchor 5 count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef('public.fn_accounting_union_earned_plan_window(uuid,timestamptz,timestamptz)'::regprocedure)<>d THEN RAISE EXCEPTION 'earned plan window postimage differs from the substituted text'; END IF;
 REVOKE ALL ON FUNCTION public.fn_accounting_union_earned_plan_window(uuid,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
END
$mig$;

CREATE FUNCTION public.fn_accounting_union_earned_plan_combine(p_union_id uuid, p_start timestamptz, p_end timestamptz)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SET search_path TO 'public'
AS $f$
DECLARE n_expected bigint; n_have bigint; bank numeric; src numeric; house numeric; fp text; detail jsonb;
BEGIN
 IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
  OR current_setting('app.accounting_close_memo',true) IS DISTINCT FROM 'on'
  OR p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end) OR p_start>=p_end
  OR p_end>clock_timestamp()
  OR NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton AND starts_at<=p_start) THEN
  RETURN NULL;
 END IF;
 CREATE TEMP TABLE IF NOT EXISTS _close_plan_windows(window_start timestamptz PRIMARY KEY,value jsonb,cash_ids uuid[],cash_md5 bytea,fee_ids uuid[],fee_md5 bytea) ON COMMIT DROP;
 TRUNCATE pg_temp._close_plan_windows;
 INSERT INTO pg_temp._close_plan_windows SELECT p.window_start,p.value,p.cash_ids,p.cash_md5,p.fee_ids,p.fee_md5
  FROM public.fn_accounting_close_windows(p_start,p_end) w JOIN public.accounting_close_partials p
   ON p.kind='earned_plan_window' AND p.union_id=p_union_id AND p.period_start=p_start AND p.period_end=p_end
   AND p.window_start=w.window_start AND p.window_end=w.window_end
   AND p.computed_at>=p_end AND p.computed_at>clock_timestamp()-interval '12 hours';
 GET DIAGNOSTICS n_have=ROW_COUNT;
 SELECT count(*) INTO n_expected FROM public.fn_accounting_close_windows(p_start,p_end);
 IF n_have<>n_expected OR n_expected=0 THEN RETURN NULL; END IF;
 SELECT COALESCE(sum((value->>'bank_sum')::numeric),0),COALESCE(sum((value->>'source_sum')::numeric),0),
  COALESCE(sum((value->>'house_sum')::numeric),0) INTO bank,src,house FROM pg_temp._close_plan_windows;
 -- Every window passed the six source proofs, so the set path (and v3) would
 -- reach exactly this conservation test of the week, and refuse as v3 does.
 IF src IS DISTINCT FROM bank THEN RAISE EXCEPTION 'union_earned_rake_does_not_conserve_bank' USING ERRCODE='55000'; END IF;
 -- The set path's fingerprint: md5 of every source's row md5 in (source_type,
 -- source_id) order; every cash_rake_accrual sorts before every
 -- tournament_fee_accrual.
 SELECT md5(COALESCE((SELECT string_agg(encode(substring(w.cash_md5 FROM (u.ord::int-1)*16+1 FOR 16),'hex'),'' ORDER BY u.id)
     FROM pg_temp._close_plan_windows w CROSS JOIN LATERAL unnest(w.cash_ids) WITH ORDINALITY u(id,ord)),'')
  ||COALESCE((SELECT string_agg(encode(substring(w.fee_md5 FROM (u.ord::int-1)*16+1 FOR 16),'hex'),'' ORDER BY u.id)
     FROM pg_temp._close_plan_windows w CROSS JOIN LATERAL unnest(w.fee_ids) WITH ORDINALITY u(id,ord)),'')) INTO fp;
 SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY club_id,game_type),'[]') INTO detail FROM (
  SELECT (e->>'club_id')::uuid AS club_id,e->>'game_type' AS game_type,sum((e->>'rake_in')::numeric) AS rake_in,
   CASE WHEN sum((e->>'rake_in')::numeric)>0 THEN sum((e->>'weighted')::numeric)/sum((e->>'rake_in')::numeric) ELSE 0 END AS rate,
   trunc(sum((e->>'weighted')::numeric),2) AS payout
   FROM pg_temp._close_plan_windows w CROSS JOIN LATERAL jsonb_array_elements(w.value->'basis') e
   GROUP BY (e->>'club_id')::uuid,e->>'game_type') b;
 RETURN jsonb_build_object('accounting_version',3,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,
  'period_rake',bank,'earned_rake',src,'house_rake',house,'source_fingerprint',fp,'basis_detail',detail);
END $f$;
REVOKE ALL ON FUNCTION public.fn_accounting_union_earned_plan_combine(uuid,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.fn_accounting_union_earned_plan_combine(uuid,timestamptz,timestamptz) IS
  'Chunked weekly close (20261003): the union earned plan of a closed week combined from its proved two-hour windows (accounting_close_partials), identical to fn_accounting_union_earned_plan_sets; NULL outside a chunked close attempt or while any window is missing.';

CREATE FUNCTION public.fn_accounting_union_earned_plan_advance(p_union_id uuid, p_start timestamptz, p_end timestamptz)
 RETURNS boolean
 LANGUAGE plpgsql
 VOLATILE
 SET search_path TO 'public'
AS $f$
DECLARE w record; r record; began timestamptz; proved boolean:=false;
BEGIN
 IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
  OR current_setting('app.accounting_close_memo',true) IS DISTINCT FROM 'on'
  OR NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'') IS NULL
  OR p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end) OR p_start>=p_end
  OR p_end>clock_timestamp() THEN
  RETURN NULL;
 END IF;
 IF public.fn_accounting_close_certificate('earned_plan',p_union_id,p_start,p_end) IS NOT NULL THEN RETURN true; END IF;
 began:=NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'')::timestamptz
  -COALESCE(NULLIF(current_setting('app.weekly_accounting_scope_budget',true),''),'8 minutes')::interval;
 DELETE FROM public.accounting_close_partials WHERE computed_at<clock_timestamp()-interval '8 days';
 FOR w IN SELECT * FROM public.fn_accounting_close_windows(p_start,p_end) ORDER BY 1 LOOP
  CONTINUE WHEN EXISTS(SELECT 1 FROM public.accounting_close_partials p WHERE p.kind='earned_plan_window' AND p.union_id=p_union_id
   AND p.period_start=p_start AND p.period_end=p_end AND p.window_start=w.window_start AND p.window_end=w.window_end
   AND p.computed_at>=p_end AND p.computed_at>clock_timestamp()-interval '12 hours');
  IF proved AND clock_timestamp()>began+interval '120 seconds' THEN RETURN false; END IF;
  SELECT * INTO r FROM public.fn_accounting_union_earned_plan_window(p_union_id,w.window_start,w.window_end);
  IF NOT FOUND THEN
   -- v3 over the same window refuses exactly what it refuses in the week.
   PERFORM public.fn_accounting_union_earned_plan_v3(p_union_id,w.window_start,w.window_end);
   RAISE EXCEPTION 'union_earned_plan_window_unproved' USING ERRCODE='55000',
    DETAIL=jsonb_build_object('union_id',p_union_id,'period_start',p_start,'period_end',p_end,'window_start',w.window_start,'window_end',w.window_end)::text;
  END IF;
  INSERT INTO public.accounting_close_partials(kind,union_id,period_start,period_end,window_start,window_end,value,cash_ids,cash_md5,fee_ids,fee_md5,computed_at)
  VALUES('earned_plan_window',p_union_id,p_start,p_end,w.window_start,w.window_end,r.value,r.cash_ids,r.cash_md5,r.fee_ids,r.fee_md5,clock_timestamp())
  ON CONFLICT(kind,union_id,period_start,period_end,window_start) DO UPDATE SET window_end=EXCLUDED.window_end,value=EXCLUDED.value,
   cash_ids=EXCLUDED.cash_ids,cash_md5=EXCLUDED.cash_md5,fee_ids=EXCLUDED.fee_ids,fee_md5=EXCLUDED.fee_md5,computed_at=EXCLUDED.computed_at;
  proved:=true;
 END LOOP;
 RETURN true;
END $f$;
REVOKE ALL ON FUNCTION public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz) IS
  'Chunked weekly close (20261003): proves the missing two-hour windows of a closed week''s union earned plan, at least one per attempt and none started 120 s after the attempt began; true when every window is proved, false to stop the attempt warming, NULL outside a chunked close attempt.';

DO $mig$
DECLARE s regprocedure; d text; a text; r text;
BEGIN
 -- earned plan
 s:='public.fn_accounting_union_earned_plan(uuid,timestamptz,timestamptz)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'18e01899de9b60bd34ad9f8c15920fbb' THEN RAISE EXCEPTION 'earned plan preimage %',md5(d); END IF;
 a:=$a$ plan:=public.fn_accounting_union_earned_plan_sets(p_union_id,p_start,p_end);
$a$;
 r:=$r$ -- CHUNKED CLOSE WINDOWS (20261003): inside a chunked close the plan is
 -- combined from its proved two-hour windows; NULL everywhere else and
 -- while any window is missing, when the set path runs as before.
 plan:=public.fn_accounting_union_earned_plan_combine(p_union_id,p_start,p_end);
 IF plan IS NULL THEN
 plan:=public.fn_accounting_union_earned_plan_sets(p_union_id,p_start,p_end);
 END IF;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'earned plan anchor 1 count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'earned plan postimage differs from the substituted text'; END IF;
 -- evidence report
 s:='public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'b2d68af9c148c5ab69af9a8c2948b9a7' THEN RAISE EXCEPTION 'evidence report preimage %',md5(d); END IF;
 a:=$a$ -- Validate every original bank/source leg even when the week has no rows.
 PERFORM public.fn_accounting_union_earned_plan(p_union_id,p_start,p_end);
$a$;
 r:=$r$ -- Validate every original bank/source leg even when the week has no rows.
 -- CHUNKED CLOSE WINDOWS (20261003): inside a chunked close the plan's
 -- two-hour windows are proved first, a few per attempt; until all are, the
 -- attempt stops warming (fn_accounting_union_earned_plan_advance is NULL,
 -- and this test passes, everywhere else).
 IF public.fn_accounting_union_earned_plan_advance(p_union_id,p_start,p_end) IS FALSE THEN RETURN jsonb_build_object('report_version',1,'status','warming','basis_certified',false,'payment_authorized',false,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,'issues',jsonb_build_array('union_pnl_certification_in_progress'),'all_players_included',false); END IF;
 PERFORM public.fn_accounting_union_earned_plan(p_union_id,p_start,p_end);
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'evidence report anchor 1 count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'evidence report postimage differs from the substituted text'; END IF;
END
$mig$;

COMMENT ON FUNCTION public.fn_accounting_union_earned_plan_window(uuid,timestamptz,timestamptz) IS
  'Chunked weekly close (20261003): fn_accounting_union_earned_plan_sets over one window of a closed week, returning the window''s partial sums, basis sums and per-source row md5s when every proof passes, no row otherwise.';

COMMIT;
