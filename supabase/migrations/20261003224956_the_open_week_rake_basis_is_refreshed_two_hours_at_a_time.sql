-- 20261003224956_the_open_week_rake_basis_is_refreshed_two_hours_at_a_time.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE OPEN-WEEK RAKE BASIS IS REFRESHED TWO HOURS AT A TIME
--
-- Job 123 (union-integrity-sweep) ends with fn_union_rake_basis_refresh, a
-- reporting snapshot of the open week's certified earned plan. It proved the
-- whole week so far in one read every hour (Midway, 2026-10-03: 1.2M cash
-- sources by Saturday evening; one peak two-hour window alone took 35.6 s), so
-- since 2026-09-28 21:35 every run reached the job's 300 s statement timeout,
-- the refresh rolled back and the snapshot stayed stale. Its own input stamp
-- read the earning-sources view over the whole week (over 60 s on its own).
--
-- WHAT CHANGES:
--  1. union_rake_basis_windows keeps, per union and open week, each closed
--     two-hour window's plan (fn_accounting_union_earned_plan_window, the
--     chunked close's proved window) with the window's input stamp: its bank
--     rows (count, sum), cash bank receipts, fee recognitions, recognized fee
--     sources, cash accrual batches, the agreement history observed before the
--     window ends (count, max id) and the clubs scope digest. Every one of
--     those tables is append-only, and a window is closed only once the
--     settler's accrual cursor has passed its end.
--  2. fn_union_rake_basis_windowed(union, start, through) reuses each closed
--     window whose stamp is unchanged, proves new or changed ones (starting
--     none 120 s into the statement) and the open tail window (none 180 s in),
--     and combines them exactly as fn_accounting_union_earned_plan_combine
--     does. It answers 'in_progress' while windows remain (the next hour
--     continues from the saved ones), and NULL whenever a window does not prove
--     or the windows do not conserve the bank, or the period has a final
--     settlement witness: the refresh then reads fn_union_club_rake_basis as
--     before, which refuses exactly as it always did.
--  3. fn_union_rake_basis_refresh uses it, and its whole-week input stamp
--     counts accrual batches and recognized fee sources instead of reading the
--     earning-sources view (sources are written with their batch or their
--     recognition, so the same counts are the same sources).
--
-- @live-proof: to_regclass('public.union_rake_basis_windows') IS NOT NULL
-- @live-proof: position('fn_union_rake_basis_windowed' in pg_get_functiondef('public.fn_union_rake_basis_refresh(uuid,timestamptz,timestamptz)'::regprocedure)) > 0
-- @live-proof: position('accounting_payable_earning_sources' in pg_get_functiondef('public.fn_union_rake_basis_refresh(uuid,timestamptz,timestamptz)'::regprocedure)) = 0
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '90s';

CREATE TABLE public.union_rake_basis_windows (
  union_id uuid NOT NULL,
  period_start timestamptz NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  input_stamp jsonb NOT NULL,
  value jsonb NOT NULL,
  compute_ms integer NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (union_id, period_start, window_start),
  CHECK (window_end = window_start + interval '2 hours')
);
ALTER TABLE public.union_rake_basis_windows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.union_rake_basis_windows FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.union_rake_basis_windows IS
  'Open-week rake basis (20261003): each closed two-hour window''s earned plan (fn_accounting_union_earned_plan_window value) with the input stamp it was proved under; fn_union_rake_basis_windowed reuses a window while its stamp is unchanged.';

CREATE FUNCTION public.fn_union_rake_basis_windowed(p_union_id uuid, p_start timestamptz, p_through timestamptz)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $f$
-- THE OPEN-WEEK RAKE BASIS, TWO HOURS AT A TIME (20261003). The basis detail
-- of fn_accounting_union_earned_plan(p_union_id,p_start,p_through), combined
-- from proved two-hour windows exactly as fn_accounting_union_earned_plan_combine
-- combines a closed week's. NULL sends the caller to the one-read plan.
DECLARE began timestamptz:=statement_timestamp(); w record; r record; v jsonb; st jsonb; stamps jsonb;
 vals jsonb:='[]'::jsonb; n_win int:=0; n_reused int:=0; n_computed int:=0; t0 timestamptz; closed boolean;
 v_sref text; digest text; bank numeric; src numeric; detail jsonb;
BEGIN
 IF p_union_id IS NULL OR p_start IS NULL OR p_through IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_through)
  OR p_through<=p_start
  OR NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton AND starts_at<=p_start) THEN
  RETURN NULL;
 END IF;
 -- A period with a final settlement is read from its witness, as before.
 v_sref := p_union_id::text || ':'
   || to_char(p_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '..'
   || to_char(p_through at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
 IF EXISTS (SELECT 1 FROM public.ca_settlements s
             WHERE s.settlement_type = 'union_rakeback_close' AND s.union_id = p_union_id
               AND s.state = 'final' AND s.external_ref = v_sref AND s.totals ? 'basis_detail') THEN
  RETURN NULL;
 END IF;
 digest:=public.fn_accounting_clubs_scope_digest();
 -- Every window's input stamp, one read per table.
 WITH win AS (SELECT * FROM public.fn_accounting_close_windows(p_start,p_through)),
 bank AS (SELECT date_bin('2 hours',t.created_at,p_start) AS ws,jsonb_build_array(count(*),sum(t.amount)) AS v
   FROM public.union_wallet_transactions t
  WHERE t.union_id=p_union_id AND t.wallet='rake_wallet' AND t.direction='credit' AND t.tx_type='rake'
    AND t.created_at>=p_start AND t.created_at<p_through GROUP BY 1),
 rcpt AS (SELECT date_bin('2 hours',c.banked_at,p_start) AS ws,count(*) AS n FROM public.accounting_cash_bank_receipts c
  WHERE c.union_id=p_union_id AND c.banked_at>=p_start AND c.banked_at<p_through GROUP BY 1),
 recog AS (SELECT date_bin('2 hours',f.recognized_at,p_start) AS ws,count(*) AS n FROM public.accounting_tournament_fee_recognitions f
  WHERE f.union_id=p_union_id AND f.recognized_at>=p_start AND f.recognized_at<p_through GROUP BY 1),
 rsrc AS (SELECT date_bin('2 hours',rs.recognized_at,p_start) AS ws,count(*) AS n FROM public.accounting_tournament_recognized_sources rs
  WHERE rs.recognized_at>=p_start AND rs.recognized_at<p_through GROUP BY 1),
 bat AS (SELECT date_bin('2 hours',b.earned_at,p_start) AS ws,count(*) AS n FROM public.accounting_cash_accrual_batches b
  WHERE b.earned_at>=p_start AND b.earned_at<p_through GROUP BY 1)
 SELECT jsonb_object_agg(win.window_start::text,jsonb_build_object('end',win.window_end,
   'bank',COALESCE(bank.v,jsonb_build_array(0,NULL)),'receipts',COALESCE(rcpt.n,0),'recognitions',COALESCE(recog.n,0),
   'recognized',COALESCE(rsrc.n,0),'batches',COALESCE(bat.n,0),
   'agreements',(SELECT jsonb_build_array(count(*),max(h.id)) FROM public.accounting_agreement_history h WHERE h.observed_at<win.window_end),
   'clubs',digest))
  INTO stamps
  FROM win LEFT JOIN bank ON bank.ws=win.window_start LEFT JOIN rcpt ON rcpt.ws=win.window_start
   LEFT JOIN recog ON recog.ws=win.window_start LEFT JOIN rsrc ON rsrc.ws=win.window_start LEFT JOIN bat ON bat.ws=win.window_start;
 FOR w IN SELECT * FROM public.fn_accounting_close_windows(p_start,p_through) ORDER BY 1 LOOP
  n_win:=n_win+1;
  st:=stamps->(w.window_start::text);
  closed:=w.window_end=w.window_start+interval '2 hours';
  v:=NULL;
  IF closed THEN
   SELECT b.value INTO v FROM public.union_rake_basis_windows b
    WHERE b.union_id=p_union_id AND b.period_start=p_start AND b.window_start=w.window_start
      AND b.window_end=w.window_end AND b.input_stamp=st;
  END IF;
  IF v IS NOT NULL THEN
   n_reused:=n_reused+1;
  ELSE
   IF clock_timestamp()>began+(CASE WHEN closed THEN interval '120 seconds' ELSE interval '180 seconds' END) THEN
    RETURN jsonb_build_object('status','in_progress','windows',(SELECT count(*) FROM public.fn_accounting_close_windows(p_start,p_through)),
     'reused',n_reused,'computed',n_computed);
   END IF;
   t0:=clock_timestamp();
   SELECT * INTO r FROM public.fn_accounting_union_earned_plan_window(p_union_id,w.window_start,w.window_end);
   IF NOT FOUND THEN RETURN NULL; END IF;
   v:=r.value;
   n_computed:=n_computed+1;
   IF closed THEN
    INSERT INTO public.union_rake_basis_windows AS b(union_id,period_start,window_start,window_end,input_stamp,value,compute_ms,computed_at)
    VALUES(p_union_id,p_start,w.window_start,w.window_end,st,v,(extract(epoch FROM clock_timestamp()-t0)*1000)::int,clock_timestamp())
    ON CONFLICT(union_id,period_start,window_start) DO UPDATE SET window_end=EXCLUDED.window_end,input_stamp=EXCLUDED.input_stamp,
     value=EXCLUDED.value,compute_ms=EXCLUDED.compute_ms,computed_at=EXCLUDED.computed_at;
   END IF;
  END IF;
  vals:=vals||jsonb_build_array(v);
 END LOOP;
 IF n_win=0 THEN RETURN NULL; END IF;
 -- fn_accounting_union_earned_plan_combine's own sums, test and basis.
 SELECT COALESCE(sum((x->>'bank_sum')::numeric),0),COALESCE(sum((x->>'source_sum')::numeric),0)
   INTO bank,src FROM jsonb_array_elements(vals) x;
 IF src IS DISTINCT FROM bank THEN RETURN NULL; END IF;
 SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY club_id,game_type),'[]') INTO detail FROM (
  SELECT (e->>'club_id')::uuid AS club_id,e->>'game_type' AS game_type,sum((e->>'rake_in')::numeric) AS rake_in,
   CASE WHEN sum((e->>'rake_in')::numeric)>0 THEN sum((e->>'weighted')::numeric)/sum((e->>'rake_in')::numeric) ELSE 0 END AS rate,
   trunc(sum((e->>'weighted')::numeric),2) AS payout
   FROM jsonb_array_elements(vals) x CROSS JOIN LATERAL jsonb_array_elements(x->'basis') e
   GROUP BY (e->>'club_id')::uuid,e->>'game_type') b;
 RETURN jsonb_build_object('status','ready','basis_detail',detail,'windows',n_win,'reused',n_reused,'computed',n_computed);
END
$f$;
REVOKE ALL ON FUNCTION public.fn_union_rake_basis_windowed(uuid,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.fn_union_rake_basis_windowed(uuid,timestamptz,timestamptz) IS
  'Open-week rake basis (20261003): the earned plan''s basis detail over p_start..p_through from proved two-hour windows (closed ones kept in union_rake_basis_windows while their input stamp is unchanged), combined as fn_accounting_union_earned_plan_combine; in_progress while windows remain; NULL sends the caller to fn_union_club_rake_basis.';

DO $mig$
DECLARE s regprocedure; d text; a text; r text;
BEGIN
 -- rake basis refresh
 s:='public.fn_union_rake_basis_refresh(uuid,timestamptz,timestamptz)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'3417a860ca6fa00907e7e7ef2f8b1c85' THEN RAISE EXCEPTION 'rake basis refresh preimage %',md5(d); END IF;
 a:=$a$  v_accrued timestamptz; v_stamp jsonb; v_prev jsonb;
$a$;
 r:=$r$  v_accrued timestamptz; v_stamp jsonb; v_prev jsonb; v_win jsonb;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'rake basis refresh anchor 1 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$    'sources', (SELECT jsonb_build_array(count(*), COALESCE(sum(s.rake_credit), 0))
                  FROM public.accounting_payable_earning_sources s
                 WHERE s.union_id = p_union_id AND s.earned_at >= p_start AND s.earned_at < v_through),
$a$;
 r:=$r$    -- 20261003: sources are written with their accrual batch or their
    -- recognition; counting those replaces a whole-week read of the view.
    'batches', (SELECT count(*) FROM public.accounting_cash_accrual_batches b
                 WHERE b.earned_at >= p_start AND b.earned_at < v_through),
    'recognized', (SELECT count(*) FROM public.accounting_tournament_recognized_sources rs
                    WHERE rs.recognized_at >= p_start AND rs.recognized_at < v_through),
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'rake basis refresh anchor 2 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$  SELECT COALESCE(jsonb_agg(jsonb_build_object('club_id', b.club_id, 'game_type', b.game_type,
                                               'rake_in', b.rake_in, 'rate', b.rate, 'payout', b.payout)
                            ORDER BY b.club_id, b.game_type), '[]'::jsonb), count(*)
    INTO v_detail, v_n
    FROM public.fn_union_club_rake_basis(p_union_id, p_start, v_through, true) b;
$a$;
 r:=$r$  -- TWO HOURS AT A TIME (20261003): the same basis from proved two-hour
  -- windows, the closed ones kept while their inputs are unchanged.
  v_win := public.fn_union_rake_basis_windowed(p_union_id, p_start, v_through);
  IF v_win->>'status' = 'in_progress' THEN
    RETURN jsonb_build_object('success', true, 'skipped', true, 'reason', 'windows_in_progress',
                              'union_id', p_union_id, 'period_start', p_start, 'period_end', p_end,
                              'through', v_through, 'accrued_through', v_accrued, 'windows', v_win,
                              'check_ms', (extract(epoch from clock_timestamp() - v_t0) * 1000)::int);
  END IF;
  IF v_win->>'status' = 'ready' THEN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('club_id', b.club_id, 'game_type', b.game_type,
                                               'rake_in', b.rake_in, 'rate', b.rate, 'payout', b.payout)
                            ORDER BY b.club_id, b.game_type), '[]'::jsonb), count(*)
    INTO v_detail, v_n
    FROM (SELECT (d->>'club_id')::uuid AS club_id, d->>'game_type' AS game_type, (d->>'rake_in')::numeric AS rake_in,
                 (d->>'rate')::numeric AS rate, (d->>'payout')::numeric AS payout
            FROM jsonb_array_elements(v_win->'basis_detail') d) b;
  ELSE
  SELECT COALESCE(jsonb_agg(jsonb_build_object('club_id', b.club_id, 'game_type', b.game_type,
                                               'rake_in', b.rake_in, 'rate', b.rate, 'payout', b.payout)
                            ORDER BY b.club_id, b.game_type), '[]'::jsonb), count(*)
    INTO v_detail, v_n
    FROM public.fn_union_club_rake_basis(p_union_id, p_start, v_through, true) b;
  END IF;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'rake basis refresh anchor 3 count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'rake basis refresh postimage differs from the substituted text'; END IF;
END
$mig$;

COMMIT;
