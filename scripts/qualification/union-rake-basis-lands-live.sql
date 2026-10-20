-- Production's open-week rake basis path as installed on 2026-10-20 00:45 UTC, for
-- scripts/qualification/union-rake-basis-lands.py. Loaded over the accounting fixture
-- scripts/ci/fixtures/launch-reset/accounting/floor-admission-qualification.sql (which already
-- carries fn_accounting_union_earned_plan_window 102e5be4..., fn_accounting_close_windows 349f9402...
-- and fn_accounting_clubs_scope_digest a03f99fb..., each equal to production's md5). The three bodies
-- below are pg_get_functiondef of production, md5 read read-only on 2026-10-20:
--   fn_union_rake_basis_windowed  2c2bbb252ef5d119bc6e9813bcc9354b
--   fn_union_rake_basis_refresh   9fdc0af3d23759ab843ce122ecaefb03
--   fn_union_integrity_sweep_all  12861fc647dd2b033ecc875f7b5fa3f7
-- The tables are production's columns, keys and checks (pg_attribute/pg_constraint, same date).
CREATE TABLE IF NOT EXISTS public.union_rake_basis_snapshot (union_id uuid NOT NULL, period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL, through timestamptz NOT NULL, computed_at timestamptz NOT NULL DEFAULT now(),
  compute_ms integer, detail jsonb NOT NULL, input_stamp jsonb, PRIMARY KEY (union_id, period_start, period_end));
CREATE TABLE IF NOT EXISTS public.union_rake_basis_windows (union_id uuid NOT NULL, period_start timestamptz NOT NULL,
  window_start timestamptz NOT NULL, window_end timestamptz NOT NULL, input_stamp jsonb NOT NULL, value jsonb NOT NULL,
  compute_ms integer NOT NULL, computed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (union_id, period_start, window_start), CHECK (window_end = window_start + interval '2 hours'));
CREATE OR REPLACE FUNCTION public.fn_union_rake_basis_windowed(p_union_id uuid, p_start timestamp with time zone, p_through timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
$function$

;
REVOKE ALL ON FUNCTION public.fn_union_rake_basis_windowed(uuid,timestamptz,timestamptz) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.fn_union_rake_basis_windowed(uuid,timestamptz,timestamptz) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_union_rake_basis_refresh(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_through timestamptz; v_t0 timestamptz := clock_timestamp(); v_detail jsonb; v_n int;
  v_accrued timestamptz; v_stamp jsonb; v_prev jsonb; v_win jsonb; v_unaccrued timestamptz;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR NOT public.fn_is_platform_admin()) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;
  IF p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR p_end <= p_start THEN
    RETURN jsonb_build_object('success', false, 'error', 'bad_params');
  END IF;
  IF LEAST(p_end, now()) <= p_start THEN
    RETURN jsonb_build_object('success', false, 'error', 'window_not_open_yet');
  END IF;

  -- Cash earning sources are written by the rakeback settler as its durable
  -- cursor advances; every bank receipt below the cursor has been accrued and
  -- none above it is claimed. Read through that instant, never through now().
  SELECT d.high_water_mark INTO v_accrued FROM public.daemon_state d WHERE d.daemon = 'rakeback_settler';
  IF v_accrued IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'accrual_cursor_unknown');
  END IF;
  v_through := LEAST(p_end, now(), v_accrued);
  -- A REFUSED SOURCE BELOW THE CURSOR IS NOT ACCRUED (2026-10-19). The settler
  -- moves its cursor past a source whose accrual was refused (a durable
  -- 'blocked' receipt the retry queue owns), so the cursor alone does not
  -- prove what lies below it. Stop before the first of this union's bank
  -- receipts in the window whose source work is still blocked; the horizon
  -- moves on by itself when the retry accrues it.
  SELECT min(c.banked_at) INTO v_unaccrued
    FROM public.accounting_cash_source_work w
    JOIN public.accounting_cash_bank_receipts c ON c.rake_record_id = w.rake_record_id
   WHERE w.status = 'blocked' AND c.union_id = p_union_id
     AND c.banked_at >= p_start AND c.banked_at < v_through;
  v_through := LEAST(v_through, v_unaccrued);
  IF v_through <= p_start THEN
    RETURN jsonb_build_object('success', false, 'error', 'accrual_not_yet_in_window',
                              'accrued_through', v_accrued, 'unaccrued_from', v_unaccrued);
  END IF;

  -- WHAT THIS REFRESH WOULD READ (2026-09-26). Every table the plan reads its
  -- rows from is append-only, so the same through and the same counts in the
  -- window are the same rows, and the same rows are the same detail. An
  -- unchanged stamp is not recomputed; a moved cursor or a new row is.
  v_stamp := jsonb_build_object(
    'through', v_through,
    'bank', (SELECT jsonb_build_array(count(*), COALESCE(sum(t.amount), 0))
               FROM public.union_wallet_transactions t
              WHERE t.union_id = p_union_id AND t.wallet = 'rake_wallet' AND t.direction = 'credit'
                AND t.tx_type = 'rake' AND t.created_at >= p_start AND t.created_at < v_through),
    'cash_receipts', (SELECT count(*) FROM public.accounting_cash_bank_receipts c
                       WHERE c.union_id = p_union_id AND c.banked_at >= p_start AND c.banked_at < v_through),
    'recognitions', (SELECT count(*) FROM public.accounting_tournament_fee_recognitions f
                      WHERE f.union_id = p_union_id AND f.recognized_at >= p_start AND f.recognized_at < v_through),
    -- 20261003: sources are written with their accrual batch or their
    -- recognition; counting those replaces a whole-week read of the view.
    'batches', (SELECT count(*) FROM public.accounting_cash_accrual_batches b
                 WHERE b.earned_at >= p_start AND b.earned_at < v_through),
    'recognized', (SELECT count(*) FROM public.accounting_tournament_recognized_sources rs
                    WHERE rs.recognized_at >= p_start AND rs.recognized_at < v_through),
    'agreements', (SELECT jsonb_build_array(count(*), max(h.id)) FROM public.accounting_agreement_history h));

  SELECT s.input_stamp INTO v_prev FROM public.union_rake_basis_snapshot s
   WHERE s.union_id = p_union_id AND s.period_start = p_start AND s.period_end = p_end;
  IF v_prev IS NOT NULL AND v_prev = v_stamp THEN
    RETURN jsonb_build_object('success', true, 'skipped', true, 'reason', 'inputs_unchanged',
                              'union_id', p_union_id, 'period_start', p_start, 'period_end', p_end,
                              'through', v_through, 'accrued_through', v_accrued,
                              'check_ms', (extract(epoch from clock_timestamp() - v_t0) * 1000)::int);
  END IF;

  -- TWO HOURS AT A TIME (20261003): the same basis from proved two-hour
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

  INSERT INTO public.union_rake_basis_snapshot (union_id, period_start, period_end, through, computed_at, compute_ms, detail, input_stamp)
  VALUES (p_union_id, p_start, p_end, v_through, now(),
          (extract(epoch from clock_timestamp() - v_t0) * 1000)::int, v_detail, v_stamp)
  ON CONFLICT (union_id, period_start, period_end) DO UPDATE
    SET through = EXCLUDED.through, computed_at = EXCLUDED.computed_at,
        compute_ms = EXCLUDED.compute_ms, detail = EXCLUDED.detail,
        input_stamp = EXCLUDED.input_stamp;

  RETURN jsonb_build_object('success', true, 'skipped', false, 'union_id', p_union_id, 'period_start', p_start,
                            'period_end', p_end, 'through', v_through, 'rows', v_n,
                            'accrued_through', v_accrued, 'unaccrued_from', v_unaccrued,
                            'compute_ms', (extract(epoch from clock_timestamp() - v_t0) * 1000)::int);
END;
$function$

;
REVOKE ALL ON FUNCTION public.fn_union_rake_basis_refresh(uuid,timestamptz,timestamptz) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.fn_union_rake_basis_refresh(uuid,timestamptz,timestamptz) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_union_integrity_sweep_all(p_hours integer DEFAULT 24)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  u record; v_one jsonb; v_signals int := 0; v_unions int := 0; v_failed int := 0;
  v_suspended int := 0; v_restored int := 0; v_sl jsonb;
  v_rb jsonb; v_rb_refreshed int := 0; v_rb_skipped int := 0; v_rb_failed int := 0;
  v_rb_out_of_time boolean := false;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.fn_is_platform_admin())) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  FOR u IN SELECT id FROM unions LOOP
    BEGIN
      v_one := public.fn_union_integrity_sweep(u.id, p_hours);
      v_signals := v_signals + COALESCE((v_one->>'signals')::int, 0);
      v_unions := v_unions + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
    END;

    -- Age and chase what is past due, before enforcement reads it.
    BEGIN
      PERFORM public.fn_union_age_invoices(u.id);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO financial_alerts (source, severity, message, context)
      VALUES ('fn_union_age_invoices', 'warning',
              'Ageing unpaid statements failed for a union',
              jsonb_build_object('union_id', u.id, 'error', SQLERRM));
    END;

    -- Stop-loss enforcement rides the sweep rather than taking a schedule of
    -- its own (World Hub CLAUDE.md 11.3). It must never be able to stop the
    -- integrity sweep from finishing.
    BEGIN
      v_sl := public.fn_union_enforce_stop_loss(u.id);
      v_suspended := v_suspended + COALESCE((v_sl->>'suspended')::int, 0);
      v_restored  := v_restored  + COALESCE((v_sl->>'restored')::int, 0);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO financial_alerts (source, severity, message, context)
      VALUES ('fn_union_enforce_stop_loss', 'warning',
              'Stop-loss enforcement failed for a union',
              jsonb_build_object('union_id', u.id, 'error', SQLERRM));
    END;
  END LOOP;

  -- Expire locks whose time has passed. expire_settlement_locks() has
  -- existed since long before this and was called by nothing at all.
  BEGIN
    PERFORM public.expire_settlement_locks();
    PERFORM public.fn_settlement_lock_hygiene();
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO financial_alerts (source, severity, message, context)
    VALUES ('fn_settlement_lock_hygiene', 'warning',
            'Settlement lock hygiene failed',
            jsonb_build_object('error', SQLERRM));
  END;

  -- Close what is due. Never allowed to stop the sweep finishing.
  BEGIN
    PERFORM public.fn_close_due_settlement_periods();
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO financial_alerts (source, severity, message, context)
    VALUES ('fn_close_due_settlement_periods', 'warning',
            'Closing due settlement periods failed',
            jsonb_build_object('error', SQLERRM));
  END;

  -- THE OPEN-WEEK SNAPSHOT RUNS LAST (2026-09-26). It is a reporting read of
  -- the certified plan, linear in the week the settler has reached, and
  -- nothing above reads it. It runs after every money control so that its
  -- cost can never roll them back: a statement timeout (query_canceled, which
  -- WHEN OTHERS does not match) is trapped here, rolls back only this
  -- refresh, and ends the refreshing for this hour because the timer is spent.
  FOR u IN SELECT id FROM unions ORDER BY id LOOP
    BEGIN
      v_rb := public.fn_union_rake_basis_refresh(u.id, public.fn_union_week_start(now()),
                                                 public.fn_union_week_start(now()) + interval '7 days');
      IF COALESCE((v_rb->>'skipped')::boolean, false) THEN
        v_rb_skipped := v_rb_skipped + 1;
      ELSIF COALESCE((v_rb->>'success')::boolean, false) THEN
        v_rb_refreshed := v_rb_refreshed + 1;
        -- A REFRESH THAT LANDED ENDS ITS OUT-OF-TIME WARNING (2026-10-17). The
        -- warning below describes a snapshot that kept its previous refresh;
        -- this one did not, so the warning is over. Nothing else closed it.
        UPDATE financial_alerts a
           SET resolved = true, resolved_at = now(),
               resolution = 'Cleared by fn_union_integrity_sweep_all at ' || now()::text
                 || ': the open-week rake basis snapshot refreshed again (through '
                 || COALESCE(v_rb->>'through', 'unknown') || ').'
         WHERE a.source = 'fn_union_rake_basis_refresh' AND NOT a.resolved
           AND a.context->>'kind' = 'out_of_time'
           AND a.context->>'union_id' = u.id::text;
      END IF;
    EXCEPTION
      WHEN query_canceled THEN
        v_rb_out_of_time := true;
        -- One open warning says so, not one an hour (the table has no reader
        -- but this warning; its readers are people).
        IF NOT EXISTS (SELECT 1 FROM financial_alerts a
                        WHERE a.source = 'fn_union_rake_basis_refresh' AND NOT a.resolved
                          AND a.context->>'kind' = 'out_of_time'
                          AND a.context->>'union_id' = u.id::text) THEN
          INSERT INTO financial_alerts (source, severity, message, context)
          VALUES ('fn_union_rake_basis_refresh', 'warning',
                  'Refreshing the open-week rake basis snapshot ran out of the sweep''s time; the money controls committed and the snapshot keeps its previous refresh',
                  jsonb_build_object('kind', 'out_of_time', 'union_id', u.id, 'error', SQLERRM));
        END IF;
        EXIT;
      WHEN OTHERS THEN
        v_rb_failed := v_rb_failed + 1;
        INSERT INTO financial_alerts (source, severity, message, context)
        VALUES ('fn_union_rake_basis_refresh', 'warning',
                'Refreshing the open-week rake basis snapshot failed for a union',
                jsonb_build_object('union_id', u.id, 'error', SQLERRM));
    END;
  END LOOP;

  RETURN jsonb_build_object('unions_swept', v_unions, 'unions_failed', v_failed,
                            'signals', v_signals,
                            'clubs_suspended', v_suspended, 'clubs_restored', v_restored,
                            'rake_basis', jsonb_build_object('refreshed', v_rb_refreshed,
                                                             'skipped', v_rb_skipped,
                                                             'failed', v_rb_failed,
                                                             'out_of_time', v_rb_out_of_time),
                            'window_hours', p_hours, 'ran_at', now());
END $function$

;
REVOKE ALL ON FUNCTION public.fn_union_integrity_sweep_all(integer) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.fn_union_integrity_sweep_all(integer) TO service_role;
