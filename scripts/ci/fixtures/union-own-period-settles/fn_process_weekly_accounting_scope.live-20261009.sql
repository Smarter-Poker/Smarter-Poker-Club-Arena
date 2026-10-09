CREATE OR REPLACE FUNCTION public.fn_process_weekly_accounting_scope(p_union_id uuid, p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_attempt_budget integer := LEAST(8,COALESCE(NULLIF(current_setting('app.weekly_accounting_attempt_budget',true),'')::integer,8));
  v_scheduler_started timestamptz := LEAST(clock_timestamp(),COALESCE(NULLIF(current_setting('app.weekly_accounting_scheduler_started',true),'')::timestamptz,clock_timestamp()));
  v_scope record;v_scope_result jsonb;v_scope_checked integer;v_scope_failed integer;
  v_saved_budget text;v_saved_started text;v_more boolean:=false;v_visits integer:=0;
  v_stage2 jsonb;v_stage3 jsonb;v_statements jsonb;v_validated_before text;
  v_preparation jsonb; v_club record; v_pass int; v_batch jsonb; v_credit jsonb; v_started timestamptz; 
  v_now timestamptz := clock_timestamp();
  v_seal jsonb;
  -- CHUNKED CLOSE (20261003): job 272 sets app.weekly_accounting_chunked.
  -- Each attempt then commits at most one money round of one book (the
  -- cascade or the standalone stages return 'chunk_committed'), the run row
  -- stays 'running' with that receipt, and the next tick continues from the
  -- rounds' own receipts. Unset, nothing below changes.
  v_chunked boolean := COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on';
  v_to timestamptz := public.fn_union_week_start(v_now);
  v_from timestamptz;
  v_first timestamptz;
  v_end timestamptz;
  v_due timestamptz;
  v_union record;
  v_previous jsonb;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_orphans integer;
  v_orphan_amount numeric;
  v_complete boolean;
  v_failed integer := 0;
  v_checked integer := 0;
  v_msg text; v_detail text; v_state text; v_context text;
  v_scope_outcome text; v_scope_error jsonb; v_prior_outcome text;
  -- A cron-sized statement budget (the 2400s tick), as opposed to the
  -- engine's 8s service_role probe.
  v_tick_budget_large boolean := current_setting('statement_timeout') IN ('0','0ms')
    OR current_setting('statement_timeout')::interval >= interval '20 minutes';
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'not_authorised' USING ERRCODE = '42501';
  END IF;
  IF (p_union_id IS NOT NULL AND p_club_id IS NOT NULL)
    OR (p_union_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.unions WHERE id=p_union_id))
    OR (p_club_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.clubs WHERE id=p_club_id AND is_union IS NOT TRUE)) THEN
    RAISE EXCEPTION 'invalid_weekly_accounting_scope' USING ERRCODE='22023';END IF;
  -- Transaction locks release on errors and also work in reused connections.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN
    RETURN jsonb_build_object('success',true,'skipped',true,'reason','already_running');
  END IF;
  IF public.fn_platform_frozen() OR extract(minute FROM v_now) >= 45 THEN
    RETURN jsonb_build_object('success',true,'skipped',true,'reason','maintenance_window');
  END IF;

  IF v_attempt_budget<1 OR NOT isfinite(v_scheduler_started) THEN
    RAISE EXCEPTION 'invalid_weekly_scheduler_budget' USING ERRCODE='22023';END IF;
  IF p_union_id IS NULL AND p_club_id IS NULL THEN
    -- Seal any closed week's original inventory once, before a scope reads it,
    -- when this tick's budget can hold the seal.
    IF v_tick_budget_large AND to_regprocedure('public.fn_union_pnl_inventory_checkpoint_due()') IS NOT NULL
      -- A gated week's seal waits with its close (20261003).
      AND NOT public.fn_accounting_close_seal_held(public.fn_union_week_start(v_now)) THEN
      BEGIN
        -- SPLIT SEAL (20261003): while the week's seal is still computed six
        -- hours at a time, this tick visits no scope (their P&L reads it);
        -- nor does the tick that sealed, which ran under the large budget.
        v_seal:=public.fn_union_pnl_inventory_checkpoint_due();
        IF v_seal->>'status'='sealing' OR jsonb_array_length(COALESCE(v_seal->'sealed','[]'::jsonb))>0 THEN
          RETURN jsonb_build_object('success',true,'checked',0,'failed',0,'visited_scopes',0,'more_remaining',true,
            'observed_at',clock_timestamp(),'detail','[]'::jsonb,'inventory_seal',v_seal);
        END IF;
      EXCEPTION
        WHEN query_canceled THEN
          GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT;
          IF v_msg IS DISTINCT FROM 'canceling statement due to statement timeout' THEN RAISE; END IF;
          RETURN jsonb_build_object('success',false,'checked',0,'failed',0,'visited_scopes',0,'more_remaining',true,
            'observed_at',clock_timestamp(),'detail','[]'::jsonb,'error','inventory_checkpoint_seal_exceeded_the_tick_budget');
        WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT,v_detail=PG_EXCEPTION_DETAIL,v_state=RETURNED_SQLSTATE;
          INSERT INTO public.financial_alerts(source,severity,message,context)
          VALUES('union_accounting_scheduler','critical','The weekly original inventory checkpoint could not be sealed',
            jsonb_build_object('error',v_msg,'sqlstate',v_state,'detail',v_detail));
      END;
    END IF;
    v_saved_budget:=current_setting('app.weekly_accounting_attempt_budget',true);
    v_saved_started:=current_setting('app.weekly_accounting_scheduler_started',true);
    BEGIN
      FOR v_scope IN
        WITH standalone_work AS (
          SELECT s.club_id,min(public.fn_union_week_start(s.earned_at)) AS first_week
           FROM public.accounting_payable_earning_sources s WHERE s.coordinator_union_id IS NULL AND s.earned_at<v_to GROUP BY s.club_id
          UNION ALL SELECT q.standalone_club_id,q.period_start FROM public.union_accounting_runs q
           WHERE q.standalone_club_id IS NOT NULL AND q.status<>'complete'
          UNION ALL SELECT q.standalone_club_id,q.period_start FROM public.union_accounting_runs q
           WHERE q.standalone_club_id IS NOT NULL AND q.status='complete' AND q.period_end<v_to
            AND NOT EXISTS(SELECT 1 FROM public.union_accounting_runs later
              WHERE later.standalone_club_id=q.standalone_club_id AND later.period_end>q.period_end)
          UNION ALL SELECT rp.club_id,min(public.fn_union_week_start(rp.period_start::timestamp AT TIME ZONE 'America/Los_Angeles'))
           FROM public.rakeback_periods rp WHERE rp.status='pending' AND rp.period_end<(v_to AT TIME ZONE 'America/Los_Angeles')::date
            AND NOT EXISTS(SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=rp.club_id) GROUP BY rp.club_id
          UNION ALL SELECT a.club_id,public.fn_union_prev_week_start(v_now) FROM public.agents a
           WHERE NOT COALESCE(a.is_prepaid,false) AND a.credit_used>0 AND NOT EXISTS(SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=a.club_id)
        ), union_floors AS (
          SELECT u.id,f.earliest_period_start,CASE WHEN f.earliest_period_start IS NULL THEN public.fn_union_prev_week_start(v_now)
             WHEN public.fn_union_week_start(f.earliest_period_start)<f.earliest_period_start
              THEN public.fn_union_week_start(public.fn_union_week_start(f.earliest_period_start)+interval '8 days')
             ELSE public.fn_union_week_start(f.earliest_period_start) END AS first_week
           FROM public.unions u LEFT JOIN public.union_settlement_floor f ON f.union_id=u.id
        ), union_work AS (
          SELECT u.id,LEAST(u.first_week,(SELECT min(q.period_start) FROM public.union_accounting_runs q
            WHERE q.union_id=u.id
              AND (q.status<>'complete' OR (u.earliest_period_start IS NULL
                AND q.status='complete' AND q.result->>'success'='true' AND q.result->>'accounting_version'='3'))
              AND (u.earliest_period_start IS NULL OR q.period_start>=u.first_week))) AS first_week
           FROM union_floors u
        ), eligible AS (
          -- Match the exact-scope floor rounding and per-week due check. An
          -- older union backlog remains due before this Monday's new close.
          SELECT 'union'::text AS kind,w.id FROM union_work w WHERE w.first_week<v_to
           AND v_now>=public.fn_union_accounting_run_at(public.fn_union_week_start(w.first_week+interval '8 days'))
          UNION ALL SELECT 'club',w.club_id FROM standalone_work w JOIN public.clubs c ON c.id=w.club_id
           WHERE c.is_union IS NOT TRUE AND GREATEST(w.first_week,public.fn_club_settlement_floor_week(w.club_id))<v_to
            AND v_now>=public.fn_union_accounting_run_at(public.fn_union_week_start(GREATEST(w.first_week,public.fn_club_settlement_floor_week(w.club_id))+interval '8 days')) GROUP BY w.club_id
        ) SELECT e.kind,e.id,GREATEST(max(GREATEST(q.last_scheduler_visit_at,q.started_at)),max(v.last_visit_at)) AS last_visit,
            COALESCE(bool_or(v.last_outcome IN ('error','statement_timeout')),false) AS last_unfinished
          FROM eligible e LEFT JOIN public.union_accounting_runs q ON q.scope_kind=e.kind AND q.scope_id=e.id
          LEFT JOIN public.weekly_accounting_scheduler_visits v ON v.scope_kind=e.kind AND v.scope_id=e.id
          GROUP BY e.kind,e.id
          -- A scope whose last visit did not finish goes after every scope
          -- whose visit finished: it can never hold the others back.
          ORDER BY last_unfinished,last_visit NULLS FIRST,(e.kind='union') DESC,e.id
      LOOP
        IF v_checked>=v_attempt_budget OR clock_timestamp()-v_scheduler_started>interval '15 minutes'
          OR extract(minute FROM clock_timestamp())>=45 OR public.fn_platform_frozen() THEN
          v_more:=true;EXIT;END IF;
        -- Transaction advisory locks are reentrant. The exact child call uses
        -- this same scheduler lock and only the remaining TOTAL attempt budget.
        PERFORM set_config('app.weekly_accounting_attempt_budget',(v_attempt_budget-v_checked)::text,true);
        PERFORM set_config('app.weekly_accounting_scheduler_started',v_scheduler_started::text,true);
        -- The visit is its own subtransaction: whatever it raises rolls back
        -- this scope only, and is recorded below.
        v_scope_outcome:='visited'; v_scope_error:=NULL;
        BEGIN
        v_scope_result:=public.fn_process_weekly_accounting_scope(
          CASE WHEN v_scope.kind='union' THEN v_scope.id END,
          CASE WHEN v_scope.kind='club' THEN v_scope.id END);
        IF v_scope_result->>'skipped'='true' AND v_scope_result->>'reason'='maintenance_window' THEN
          v_scope_outcome:='maintenance';
        ELSE
        IF jsonb_typeof(v_scope_result->'checked') IS DISTINCT FROM 'number'
          OR jsonb_typeof(v_scope_result->'failed') IS DISTINCT FROM 'number'
          OR jsonb_typeof(v_scope_result->'detail') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'weekly_scope_scheduler_receipt_invalid' USING ERRCODE='23514';END IF;
        v_scope_checked:=(v_scope_result->>'checked')::integer;v_scope_failed:=(v_scope_result->>'failed')::integer;
        IF v_scope_checked<0 OR v_scope_checked>v_attempt_budget-v_checked OR v_scope_failed<0
          OR v_scope_failed>v_scope_checked OR jsonb_array_length(v_scope_result->'detail')<>v_scope_checked
          OR v_scope_result->'checked' IS DISTINCT FROM to_jsonb(v_scope_checked)
          OR v_scope_result->'failed' IS DISTINCT FROM to_jsonb(v_scope_failed)
          OR v_scope_result->'success' IS DISTINCT FROM to_jsonb(v_scope_failed=0)
          OR (SELECT count(*) FROM jsonb_array_elements(v_scope_result->'detail')d WHERE d->'result'->'success' IS DISTINCT FROM 'true'::jsonb
            AND d->'result'->'chunk_committed' IS DISTINCT FROM 'true'::jsonb)<>v_scope_failed
          OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_scope_result->'detail')d
            WHERE CASE WHEN v_scope.kind='union' THEN d->>'union_id' ELSE d->>'club_id' END IS DISTINCT FROM v_scope.id::text) THEN
          RAISE EXCEPTION 'weekly_scope_scheduler_receipt_invalid' USING ERRCODE='23514';END IF;
        END IF;
        EXCEPTION
          WHEN query_canceled THEN
            GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT,v_state=RETURNED_SQLSTATE;
            -- An operator's cancel keeps its meaning: the whole tick stops.
            IF v_msg IS DISTINCT FROM 'canceling statement due to statement timeout' THEN RAISE; END IF;
            v_scope_outcome:='statement_timeout';
            v_scope_error:=jsonb_build_object('success',false,'error','weekly_scope_statement_budget_exhausted','sqlstate',v_state,
              'statement_timeout',current_setting('statement_timeout'));
          WHEN OTHERS THEN
            GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT,v_detail=PG_EXCEPTION_DETAIL,v_state=RETURNED_SQLSTATE;
            v_scope_outcome:='error';
            v_scope_error:=jsonb_build_object('success',false,'error',v_msg,'sqlstate',v_state,'detail',v_detail);
        END;
        IF v_scope_outcome='maintenance' THEN v_more:=true;EXIT;END IF;
        IF v_scope_outcome<>'visited' THEN
          v_scope_checked:=1;v_scope_failed:=1;
          v_scope_result:=jsonb_build_object('detail',jsonb_build_array(jsonb_build_object(
            CASE WHEN v_scope.kind='union' THEN 'union_id' ELSE 'club_id' END,v_scope.id,'result',v_scope_error)));
        END IF;
        v_checked:=v_checked+v_scope_checked;v_failed:=v_failed+v_scope_failed;
        v_results:=v_results||(v_scope_result->'detail');v_visits:=v_visits+1;
        v_more:=v_more OR COALESCE((v_scope_result->>'more_remaining')::boolean,false);
        -- Completed/zero-work scopes must move to the back too. Reuse one real
        -- run row; never change attempts, result, started_at or finished_at.
        UPDATE public.union_accounting_runs q SET last_scheduler_visit_at=clock_timestamp()
         WHERE q.scope_kind=v_scope.kind AND q.scope_id=v_scope.id
          AND (q.period_start,q.period_end)=(SELECT r.period_start,r.period_end FROM public.union_accounting_runs r
            WHERE r.scope_kind=v_scope.kind AND r.scope_id=v_scope.id ORDER BY r.period_start DESC,r.period_end DESC LIMIT 1);
        -- The durable visit exists even when the scope has no run row yet.
        SELECT s.last_outcome INTO v_prior_outcome FROM public.weekly_accounting_scheduler_visits s
         WHERE s.scope_kind=v_scope.kind AND s.scope_id=v_scope.id;
        INSERT INTO public.weekly_accounting_scheduler_visits AS s(scope_kind,scope_id,last_visit_at,last_outcome,last_error,unfinished_visits)
        VALUES(v_scope.kind,v_scope.id,clock_timestamp(),v_scope_outcome,v_scope_error,CASE WHEN v_scope_outcome='visited' THEN 0 ELSE 1 END)
        ON CONFLICT(scope_kind,scope_id) DO UPDATE SET last_visit_at=excluded.last_visit_at,last_outcome=excluded.last_outcome,
          last_error=excluded.last_error,unfinished_visits=CASE WHEN excluded.last_outcome='visited' THEN 0 ELSE s.unfinished_visits+1 END;
        IF v_scope_outcome<>'visited' AND v_prior_outcome IS DISTINCT FROM v_scope_outcome
          AND (v_scope_outcome='error' OR v_tick_budget_large) THEN
          INSERT INTO public.financial_alerts(source,severity,message,context)
          VALUES('union_accounting_scheduler','critical','A weekly accounting scope did not finish its scheduler visit',
            jsonb_build_object('scope_kind',v_scope.kind,'scope_id',v_scope.id,'outcome',v_scope_outcome,'result',v_scope_error));
        END IF;
        -- The statement budget is spent: nothing more can run in this tick.
        IF v_scope_outcome='statement_timeout' THEN v_more:=true;EXIT;END IF;
      END LOOP;
      PERFORM set_config('app.weekly_accounting_attempt_budget',COALESCE(v_saved_budget,''),true);
      PERFORM set_config('app.weekly_accounting_scheduler_started',COALESCE(v_saved_started,''),true);
    EXCEPTION WHEN OTHERS THEN
      PERFORM set_config('app.weekly_accounting_attempt_budget',COALESCE(v_saved_budget,''),true);
      PERFORM set_config('app.weekly_accounting_scheduler_started',COALESCE(v_saved_started,''),true);
      RAISE;
    END;
    RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,
      'visited_scopes',v_visits,'more_remaining',v_more,'observed_at',clock_timestamp(),'detail',v_results);
  END IF;

  FOR v_union IN SELECT u.id, f.earliest_period_start
    FROM public.unions u LEFT JOIN public.union_settlement_floor f ON f.union_id=u.id WHERE p_club_id IS NULL AND (p_union_id IS NULL OR u.id=p_union_id) ORDER BY u.id
  LOOP
    -- Catch up chronologically from the explicit clean-data floor. A union
    -- without one starts at the just-closed week, never an invented history.
    v_first := COALESCE(public.fn_union_week_start(v_union.earliest_period_start),
                        public.fn_union_prev_week_start(v_now));
    IF v_first < v_union.earliest_period_start THEN
      v_first := public.fn_union_week_start(v_first + interval '8 days');
    END IF;
    SELECT LEAST(v_first,min(q.period_start)) INTO v_first
      FROM public.union_accounting_runs q WHERE q.union_id=v_union.id
        AND (q.status<>'complete' OR (v_union.earliest_period_start IS NULL
          AND q.status='complete' AND q.result->>'success'='true' AND q.result->>'accounting_version'='3'))
        AND (v_union.earliest_period_start IS NULL OR q.period_start>=v_first);
    v_from := v_first;
    WHILE v_from < v_to LOOP
      v_end := public.fn_union_week_start(v_from + interval '8 days');
      v_due := public.fn_union_accounting_run_at(v_end);
      IF v_now < v_due THEN EXIT; END IF;
      -- A LONG WEEK'S FIRST CLOSE WAITS FOR A QUIET HOUR (20261003): while
      -- this book's week has a gate and no attempt yet, nothing of it runs
      -- (fn_accounting_close_gate_holds files one warning, never a critical).
      IF public.fn_accounting_close_gate_holds('union',v_union.id,v_from,v_end) THEN EXIT; END IF;

      IF clock_timestamp()-v_scheduler_started>interval '15 minutes'
        OR extract(minute FROM clock_timestamp())>=45 OR public.fn_platform_frozen() THEN
        RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,
          'more_remaining',true,'detail',v_results);
      END IF;
      PERFORM public.fn_union_pnl_closed_book_barrier(v_end);
      PERFORM pg_advisory_xact_lock(hashtextextended('union-accounting:'||v_union.id::text||':'||extract(epoch FROM v_from)::text||':'||extract(epoch FROM v_end)::text,0));
      SELECT result INTO v_previous FROM public.union_accounting_runs
       WHERE union_id=v_union.id AND period_start=v_from AND period_end=v_end;
      SELECT count(*), COALESCE(sum(rakeback_amount),0) INTO v_orphans,v_orphan_amount
        FROM public.rakeback_periods rp
       WHERE rp.club_id=v_union.id AND rp.status='pending' AND rp.rakeback_amount>0
         AND (rp.period_start::timestamp AT TIME ZONE 'UTC') < v_end
         AND ((rp.period_end+1)::timestamp AT TIME ZONE 'UTC') > v_from;

      SELECT NOT EXISTS (
        SELECT 1 FROM generate_series(1,4) n
        WHERE NOT EXISTS (SELECT 1 FROM public.union_settlement_rounds r
          WHERE r.union_id=v_union.id AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=n
            AND CASE
              WHEN n=1 THEN r.detail->>'success'='true'
              WHEN n IN(2,3) THEN
                COALESCE(r.detail->'latest_attempt',r.detail)->>'amount' IS NOT NULL
                AND COALESCE(r.detail->'latest_attempt',r.detail)->>'payees' IS NOT NULL
                AND COALESCE(r.detail->'latest_attempt',r.detail)->'shortfalls'='0'::jsonb
                AND COALESCE(COALESCE(r.detail->'latest_attempt',r.detail)->>'success','true')='true'
              ELSE r.detail->>'success'='true' AND COALESCE(r.detail->>'skipped','false')='false'
            END)) INTO v_complete;

      v_complete := v_complete AND NOT EXISTS (
        SELECT 1 FROM public.rakeback_periods rp
        JOIN public.fn_accounting_week_clubs(v_union.id,NULL,v_from,v_end) uc ON uc.club_id=rp.club_id
        WHERE rp.status='pending' AND rp.rakeback_amount>0
          AND rp.period_start >= (v_from AT TIME ZONE 'UTC')::date
          AND ((rp.period_end+1)::timestamp AT TIME ZONE 'UTC') <= v_end)
        AND NOT EXISTS (SELECT 1 FROM public.fn_accounting_week_clubs(v_union.id,NULL,v_from,v_end) uc
          WHERE uc.club_id<>v_union.id
            AND NOT EXISTS (SELECT 1 FROM public.settlement_invoices si
              WHERE si.club_id=uc.club_id AND si.invoice_type='union_weekly_squareup'
                AND si.breakdown->>'union_id'=v_union.id::text
                AND (si.breakdown->>'period_start')::timestamptz=v_from
                AND (si.breakdown->>'period_end')::timestamptz=v_end
                AND si.message_sent=true AND si.status<>'cancelled'));

      v_complete:=v_complete AND NOT EXISTS(SELECT 1 FROM public.fn_accounting_week_clubs(v_union.id,NULL,v_from,v_end) uc
        WHERE uc.club_id<>v_union.id AND NOT EXISTS(
          SELECT 1 FROM public.settlement_invoices i JOIN public.settlement_periods sp ON sp.id=i.period_id
          WHERE i.club_id=uc.club_id AND i.invoice_type='club_weekly_accounting' AND i.message_sent
            AND sp.club_id=uc.club_id AND sp.union_id=v_union.id AND sp.start_at=v_from AND sp.end_at=v_end AND sp.status IN('settled','closed') AND i.status<>'cancelled'));
      -- Completion is proved by the actual posted source receipts, not only
      -- the coordinator's summary JSON or another union's period document.
      v_complete:=v_complete AND EXISTS(SELECT 1 FROM public.ca_settlements c
        WHERE c.settlement_type='union_rakeback_close' AND c.union_id=v_union.id AND c.state='final'
         AND c.totals->>'accounting_version'='3' AND c.external_ref=v_union.id::text||':'
          ||to_char(v_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')||'..'
          ||to_char(v_end AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'))
        AND NOT EXISTS(SELECT 1 FROM generate_series(2,3) n WHERE NOT EXISTS(
          SELECT 1 FROM public.accounting_routed_settlement_runs r
           WHERE r.scope_kind='union' AND r.scope_id=v_union.id AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=n
            AND r.result->>'routing_version'='3' AND r.result->>'source_version'='2'
            AND r.result->>'success'='true' AND r.result->'shortfalls'='0'::jsonb
            AND r.result=(v_previous->CASE WHEN n=2 THEN 'round2_club_to_agents' ELSE 'round3_agents_to_players' END)-'duplicate'));
      IF v_complete AND v_orphans=0 AND v_previous->>'success'='true' AND v_previous->>'accounting_version'='3'
        -- A BOOK THIS SCHEDULER ALREADY CLOSED (20261002) is not re-proved:
        -- its evidence was certified before it was paid, and only that close
        -- writes status 'complete'. Anything else is checked as before.
        AND (CASE WHEN EXISTS(SELECT 1 FROM public.union_accounting_runs q
                    WHERE q.union_id=v_union.id AND q.period_start=v_from AND q.period_end=v_end
                      AND q.status='complete')
             THEN true
             ELSE public.fn_union_pnl_close_quality(v_union.id,v_from,v_end)->>'status'='ready' END) THEN
        v_from:=v_end; CONTINUE;
      END IF;
      -- Bounded recovery: never let a large history monopolize live wallets.
      IF v_checked>=v_attempt_budget OR clock_timestamp()-v_scheduler_started>interval '15 minutes'
        OR extract(minute FROM clock_timestamp())>=45 OR public.fn_platform_frozen() THEN
        RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,
          'more_remaining',true,'detail',v_results);
      END IF;
      INSERT INTO public.union_accounting_runs
        (union_id,period_start,period_end,scheduled_at,status,attempts,started_at)
      VALUES (v_union.id,v_from,v_end,v_due,'running',1,clock_timestamp())
      ON CONFLICT(union_id,period_start,period_end) DO UPDATE
        SET status='running',attempts=union_accounting_runs.attempts+1,started_at=clock_timestamp();

      PERFORM public.fn_weekly_accounting_attempt_begin(true);
      -- Keep a refused preparation request durable outside the wallet rollback.
      BEGIN
        v_preparation:=public.fn_prepare_accounting_week(v_union.id,NULL,v_from,v_end);
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT,v_detail=PG_EXCEPTION_DETAIL,v_state=RETURNED_SQLSTATE;
        v_preparation:=jsonb_build_object('success',false,'error',v_msg,'sqlstate',v_state,'detail',v_detail);
      END;

      -- Only this block may move chips. Any refused downstream stage raises
      -- and rolls back the whole union attempt, while the failure record below
      -- survives. Other unions have independent ledgers and transaction scopes.
      BEGIN
        -- CHUNKED CLOSE: a preparation that stopped while its book's P&L
        -- certificates are still being proved (fn_union_pnl_evidence_report
        -- 'warming': the steps proved so far are kept, nothing is paid) ends
        -- this attempt as a committed step, not a failure.
        IF v_chunked AND v_preparation->>'success' IS DISTINCT FROM 'true'
          AND jsonb_typeof(v_preparation->'problems')='array' AND jsonb_array_length(v_preparation->'problems')=1
          AND v_preparation#>'{problems,0,pnl_evidence,issues}'='["union_pnl_certification_in_progress"]'::jsonb THEN
          v_result:=jsonb_build_object('success',false,'chunk_committed',true,'committed_round',0,'stage','certifying',
            'union_id',v_union.id,'period_start',v_from,'period_end',v_end);
        -- SPLIT RECOMPUTE (20261003): a preparation whose only problems are
        -- clubs whose week is still calculated in parts ends this attempt as
        -- a committed step.
        ELSIF v_chunked AND public.fn_accounting_preparation_calculating(v_preparation) THEN
          v_result:=jsonb_build_object('success',false,'chunk_committed',true,'committed_round',0,'stage','calculating',
            'union_id',v_union.id,'period_start',v_from,'period_end',v_end);
        -- CHUNKED CLOSE (20261003, prepared): a preparation that did durable
        -- work of its own (a P&L step it kept, a weekly recompute it recorded)
        -- for more than 60 seconds ends this attempt as a committed step; the
        -- next attempt reuses those receipts and pays.
        ELSIF v_chunked AND v_preparation->>'success'='true' AND v_preparation->>'paid_scope_replay' IS DISTINCT FROM 'true'
          -- CHUNKED CLOSE WINDOWS (20261003): round 2's windows are proved in
          -- attempts of their own (after any long preparation, never with it)
          -- before the attempt that pays it.
          AND (CASE WHEN public.fn_accounting_close_prepared_long(v_union.id,NULL,v_from,v_end) THEN true
            ELSE public.fn_accounting_close_windows_pending(v_union.id,NULL,v_from,v_end) END) THEN
          v_result:=jsonb_build_object('success',false,'chunk_committed',true,'committed_round',0,'stage','prepared',
            'union_id',v_union.id,'period_start',v_from,'period_end',v_end);
        ELSE
        IF v_preparation->>'success' IS DISTINCT FROM 'true' THEN
          RAISE EXCEPTION 'weekly_accounting_calculation_incomplete' USING DETAIL=v_preparation::text;
        END IF;
        IF EXISTS(SELECT 1 FROM public.rake_records rr LEFT JOIN public.daemon_state ds ON ds.daemon='rakeback_settler'
          WHERE NOT COALESCE(rr.is_tournament,false) AND rr.tournament_id IS NULL AND rr.rake_amount>0
            AND rr.created_at>=v_from AND rr.created_at<v_end
            AND (rr.club_id=v_union.id OR EXISTS(SELECT 1 FROM public.fn_accounting_week_clubs(v_union.id,NULL,v_from,v_end) uc WHERE uc.club_id=rr.club_id))
            AND (ds.high_water_mark IS NULL OR rr.created_at>ds.high_water_mark OR
              (rr.created_at=ds.high_water_mark AND (ds.high_water_mark_id IS NULL OR rr.id>ds.high_water_mark_id)))) THEN
          RAISE EXCEPTION 'weekly_rake_source_not_fully_accrued';
        END IF;
        PERFORM public.fn_assert_cash_commission_period(v_union.id,NULL,v_from,v_end);
        IF v_orphans>0 THEN
          RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='union_rakeback_wrong_club',
            DETAIL=jsonb_build_object('pending_periods',v_orphans,'pending_amount',v_orphan_amount)::text;
        END IF;
        IF v_complete AND v_previous->>'accounting_version'='3' THEN
          v_result:=v_previous||jsonb_build_object('success',true,'already_posted',true);
        ELSE
          PERFORM public.fn_weekly_accounting_deadline_check();
          v_result:=public.fn_union_settlement_cascade(v_union.id,v_from,v_end);
          -- CHUNKED CLOSE: a committed round ends this attempt (it is not a
          -- failure and is not rolled back for the time it took).
          IF v_result->>'chunk_committed' IS DISTINCT FROM 'true' THEN
          PERFORM public.fn_weekly_accounting_deadline_check();
          IF v_result->>'success' IS DISTINCT FROM 'true' THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='union_settlement_incomplete',DETAIL=v_result::text;
          END IF;
          END IF;
        END IF;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT,v_detail=PG_EXCEPTION_DETAIL,v_state=RETURNED_SQLSTATE,v_context=PG_EXCEPTION_CONTEXT;
        v_result:=jsonb_build_object('success',false,'error',v_msg,'sqlstate',v_state,'detail',v_detail,'context',left(v_context,4000));
      END;

      PERFORM public.fn_weekly_accounting_attempt_end();
      IF v_result->>'success'='true' THEN v_result:=v_result||jsonb_build_object('accounting_version',3); END IF;
      v_checked:=v_checked+1;
      UPDATE public.union_accounting_runs
         SET status=CASE WHEN v_result->>'success'='true' THEN 'complete' WHEN v_result->>'chunk_committed'='true' THEN 'running' ELSE 'failed' END,
             finished_at=clock_timestamp(),result=v_result
       WHERE union_id=v_union.id AND period_start=v_from AND period_end=v_end;
      IF v_result->>'success' IS DISTINCT FROM 'true' AND v_result->>'chunk_committed' IS DISTINCT FROM 'true' THEN
        v_failed:=v_failed+1;
        -- Report a new failure or a changed failure, not the same alert every tick.
        IF public.fn_accounting_failure_identity(v_previous) IS DISTINCT FROM public.fn_accounting_failure_identity(v_result) THEN
          INSERT INTO public.financial_alerts(source,severity,message,context)
          -- CHUNKED CLOSE: an attempt that ran out of its 9-minute budget left
          -- nothing half-done (it rolled back to its last committed round)
          -- and the next tick retries it with the large budget; that is a
          -- warning, not an incident. Out of the large budget it is critical.
          VALUES ('union_accounting_scheduler',CASE WHEN v_chunked AND NOT v_tick_budget_large AND v_result->>'error'='weekly_scope_time_budget_exhausted' THEN 'warning' ELSE 'critical' END,'Weekly union accounting is incomplete',
            jsonb_build_object('union_id',v_union.id,'period_start',v_from,'period_end',v_end,
                               'scheduled_at',v_due,'result',v_result));
        END IF;
      END IF;
      v_results:=v_results||jsonb_build_array(jsonb_build_object('union_id',v_union.id,
        'period_start',v_from,'period_end',v_end,'result',v_result));
      -- CHUNKED CLOSE: the next round of this book is the next tick's.
      IF v_result->>'chunk_committed'='true' THEN
        RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,
          'more_remaining',true,'detail',v_results);
      END IF;
      -- Resolve an older period before posting a later one for the same union.
      IF v_result->>'success' IS DISTINCT FROM 'true' THEN EXIT; END IF;
      v_from:=v_end;
    END LOOP;
  END LOOP;

  -- Standalone and formerly standalone earnings use this same coordinator,
  -- run table, preparation, routed stages and document sender.
  IF p_union_id IS NULL THEN
    FOR v_club IN
      WITH pending_scope AS (
        SELECT s.club_id,min(public.fn_union_week_start(s.earned_at)) AS first_week
         FROM public.accounting_payable_earning_sources s WHERE s.coordinator_union_id IS NULL AND s.earned_at<v_to GROUP BY s.club_id
        UNION ALL SELECT q.standalone_club_id,q.period_start FROM public.union_accounting_runs q
         WHERE q.standalone_club_id IS NOT NULL AND q.status<>'complete'
        UNION ALL SELECT q.standalone_club_id,q.period_start FROM public.union_accounting_runs q
         WHERE q.standalone_club_id IS NOT NULL AND q.status='complete' AND q.period_end<v_to
          AND NOT EXISTS(SELECT 1 FROM public.union_accounting_runs later
            WHERE later.standalone_club_id=q.standalone_club_id AND later.period_end>q.period_end)
        UNION ALL SELECT rp.club_id,min(public.fn_union_week_start(rp.period_start::timestamp AT TIME ZONE 'America/Los_Angeles'))
         FROM public.rakeback_periods rp WHERE rp.status='pending' AND rp.period_end<(v_to AT TIME ZONE 'America/Los_Angeles')::date
          AND NOT EXISTS(SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=rp.club_id) GROUP BY rp.club_id
        UNION ALL SELECT a.club_id,public.fn_union_prev_week_start(v_now) FROM public.agents a
         WHERE NOT COALESCE(a.is_prepaid,false) AND a.credit_used>0 AND NOT EXISTS(SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=a.club_id)
      ) SELECT x.club_id AS id,GREATEST(min(x.first_week),public.fn_club_settlement_floor_week(x.club_id)) AS first_week FROM pending_scope x JOIN public.clubs c ON c.id=x.club_id
       WHERE c.is_union IS NOT TRUE AND (p_club_id IS NULL OR x.club_id=p_club_id) GROUP BY x.club_id ORDER BY x.club_id
    LOOP
      v_from:=v_club.first_week;
      WHILE v_from<v_to LOOP
        v_end:=public.fn_union_week_start(v_from+interval '8 days');v_due:=public.fn_union_accounting_run_at(v_end);
        IF v_now<v_due THEN EXIT;END IF;
        -- A LONG WEEK'S FIRST CLOSE WAITS FOR A QUIET HOUR (20261003): as for a union book.
        IF public.fn_accounting_close_gate_holds('club',v_club.id,v_from,v_end) THEN EXIT;END IF;
        IF v_checked>=v_attempt_budget OR clock_timestamp()-v_scheduler_started>interval '15 minutes'
          OR extract(minute FROM clock_timestamp())>=45 OR public.fn_platform_frozen() THEN
          RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,'more_remaining',true,'detail',v_results);
        END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended('club-accounting:'||v_club.id::text||':'||extract(epoch FROM v_from)::text||':'||extract(epoch FROM v_end)::text,0));
        SELECT result INTO v_previous FROM public.union_accounting_runs q
          WHERE q.standalone_club_id=v_club.id AND q.period_start=v_from AND q.period_end=v_end;
        IF v_previous->>'success'='true' AND v_previous->>'accounting_version'='3'
          AND EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r WHERE r.scope_kind='club' AND r.scope_id=v_club.id
            AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=2 AND r.result=v_previous->'round2')
          AND EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r WHERE r.scope_kind='club' AND r.scope_id=v_club.id
            AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=3 AND r.result=v_previous->'round3')
          AND EXISTS(SELECT 1 FROM public.settlement_invoices i JOIN public.settlement_periods sp ON sp.id=i.period_id
            WHERE sp.club_id=v_club.id AND sp.union_id IS NULL AND sp.start_at=v_from AND sp.end_at=v_end
             AND sp.status IN('settled','closed') AND i.club_id=v_club.id
             AND i.invoice_type='club_weekly_accounting' AND i.message_sent AND i.status<>'cancelled') THEN
          v_from:=v_end;CONTINUE;
        END IF;
        -- A source writer may have held this period lock across the deadline,
        -- maintenance announcement or a freeze change. Recheck after the lock
        -- and completion reads before creating a new financial attempt.
        IF v_checked>=v_attempt_budget OR clock_timestamp()-v_scheduler_started>interval '15 minutes'
          OR extract(minute FROM clock_timestamp())>=45 OR public.fn_platform_frozen() THEN
          RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,'more_remaining',true,'detail',v_results);
        END IF;
        INSERT INTO public.union_accounting_runs(standalone_club_id,period_start,period_end,scheduled_at,status,attempts,started_at)
          VALUES(v_club.id,v_from,v_end,v_due,'running',1,clock_timestamp())
          ON CONFLICT(scope_kind,scope_id,period_start,period_end) DO UPDATE
          SET status='running',attempts=union_accounting_runs.attempts+1,started_at=clock_timestamp();
        -- Preparation writes a durable queue result even if wallet work below
        -- refuses. No source calculator reports an unpersisted ready flag.
        PERFORM public.fn_weekly_accounting_attempt_begin(false);
        BEGIN v_preparation:=public.fn_prepare_accounting_week(NULL,v_club.id,v_from,v_end);
        EXCEPTION WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT,v_detail=PG_EXCEPTION_DETAIL,v_state=RETURNED_SQLSTATE;
          v_preparation:=jsonb_build_object('success',false,'error',v_msg,'sqlstate',v_state,'detail',v_detail);
        END;
        BEGIN
          IF v_preparation->>'success' IS DISTINCT FROM 'true'
            AND NOT (v_chunked AND public.fn_accounting_preparation_calculating(v_preparation)) THEN
            RAISE EXCEPTION 'weekly_accounting_calculation_incomplete' USING DETAIL=v_preparation::text;END IF;
          -- CHUNKED CLOSE (20261003, prepared): as for a union book.
          -- SPLIT RECOMPUTE (20261003): a club whose week is still calculated in
          -- parts ends this attempt as a committed step ('calculating').
          IF v_chunked AND (CASE WHEN public.fn_accounting_preparation_calculating(v_preparation) THEN true
            WHEN public.fn_accounting_close_prepared_long(NULL,v_club.id,v_from,v_end) THEN true
            ELSE public.fn_accounting_close_windows_pending(NULL,v_club.id,v_from,v_end) END) THEN
            v_result:=jsonb_build_object('success',false,'chunk_committed',true,'committed_round',0,
              'stage',CASE WHEN public.fn_accounting_preparation_calculating(v_preparation) THEN 'calculating' ELSE 'prepared' END,'scope_kind','club','scope_id',v_club.id,
              'period_start',v_from,'period_end',v_end);
          ELSE
          PERFORM public.fn_assert_cash_commission_period(NULL,v_club.id,v_from,v_end);
          PERFORM public.fn_weekly_accounting_deadline_check();
          PERFORM public.fn_bank_standalone_week_rake(v_club.id,v_from,v_end);
          -- CHUNKED CLOSE (20261003): a round an earlier attempt committed is
          -- answered from its own receipt (what the stage returns for it as a
          -- duplicate) instead of reading the week again.
          v_stage2:=NULL; v_stage3:=NULL;
          IF v_chunked THEN
            SELECT r.result||jsonb_build_object('duplicate',true) INTO v_stage2 FROM public.accounting_routed_settlement_runs r
             WHERE r.scope_kind='club' AND r.scope_id=v_club.id AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=2;
            SELECT r.result||jsonb_build_object('duplicate',true) INTO v_stage3 FROM public.accounting_routed_settlement_runs r
             WHERE r.scope_kind='club' AND r.scope_id=v_club.id AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=3;
          END IF;
          IF v_stage2 IS NULL THEN
          v_stage2:=public.fn_settle_accounting_commission_stage('club',v_club.id,v_from,v_end);
          END IF;
          -- CHUNKED CLOSE: a round 2 or round 3 that paid commits on its own
          -- (after the same receipt tests the unchunked path applies to it);
          -- the next tick finds its receipt and the stage returns it as a
          -- duplicate. Credit invoices, the settled period and the weekly
          -- statements wait for the attempt that finds both rounds committed.
          IF v_chunked AND v_stage2->>'duplicate' IS DISTINCT FROM 'true' THEN
            IF v_stage2->>'success' IS DISTINCT FROM 'true' OR v_stage2->>'routing_version' IS DISTINCT FROM '3'
              OR v_stage2->>'source_version' IS DISTINCT FROM '2' OR v_stage2->'shortfalls' IS DISTINCT FROM '0'::jsonb
              OR NOT EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r WHERE r.scope_kind='club' AND r.scope_id=v_club.id
                AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=2 AND r.result=(v_stage2-'duplicate')) THEN
              RAISE EXCEPTION 'weekly_routing_receipt_not_confirmed' USING ERRCODE='23514';END IF;
            v_result:=jsonb_build_object('success',false,'chunk_committed',true,'committed_round',2,'scope_kind','club','scope_id',v_club.id,
              'period_start',v_from,'period_end',v_end,'round2',v_stage2);
          ELSE
          PERFORM public.fn_weekly_accounting_deadline_check();
          IF v_stage3 IS NULL THEN
          v_stage3:=public.fn_settle_accounting_rakeback_stage('club',v_club.id,v_from,v_end);
          END IF;
          -- CHUNKED CLOSE (20261003, round 3 in batches): as for a union book.
          IF v_chunked AND v_stage3->>'batch_committed'='true' THEN
            v_result:=jsonb_build_object('success',false,'chunk_committed',true,'committed_round',3,'stage','round3_batch','scope_kind','club','scope_id',v_club.id,
              'period_start',v_from,'period_end',v_end,'round2',v_stage2-'duplicate','round3_batch',v_stage3);
          ELSIF v_chunked AND v_stage3->>'duplicate' IS DISTINCT FROM 'true' THEN
            IF v_stage3->>'success' IS DISTINCT FROM 'true' OR v_stage3->>'routing_version' IS DISTINCT FROM '3'
              OR v_stage3->>'source_version' IS DISTINCT FROM '2' OR v_stage3->'shortfalls' IS DISTINCT FROM '0'::jsonb
              OR NOT EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r WHERE r.scope_kind='club' AND r.scope_id=v_club.id
                AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=3 AND r.result=(v_stage3-'duplicate')) THEN
              RAISE EXCEPTION 'weekly_routing_receipt_not_confirmed' USING ERRCODE='23514';END IF;
            v_result:=jsonb_build_object('success',false,'chunk_committed',true,'committed_round',3,'scope_kind','club','scope_id',v_club.id,
              'period_start',v_from,'period_end',v_end,'round2',v_stage2-'duplicate','round3',v_stage3);
          ELSE
          PERFORM public.fn_weekly_accounting_deadline_check();
          IF v_stage2->>'success' IS DISTINCT FROM 'true' OR v_stage3->>'success' IS DISTINCT FROM 'true'
            OR v_stage2->>'routing_version' IS DISTINCT FROM '3' OR v_stage3->>'routing_version' IS DISTINCT FROM '3'
            OR v_stage2->>'source_version' IS DISTINCT FROM '2' OR v_stage3->>'source_version' IS DISTINCT FROM '2'
            OR v_stage2->'shortfalls' IS DISTINCT FROM '0'::jsonb OR v_stage3->'shortfalls' IS DISTINCT FROM '0'::jsonb
            OR NOT EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r WHERE r.scope_kind='club' AND r.scope_id=v_club.id
              AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=2 AND r.result=(v_stage2-'duplicate'))
            OR NOT EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r WHERE r.scope_kind='club' AND r.scope_id=v_club.id
              AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=3 AND r.result=(v_stage3-'duplicate')) THEN
            RAISE EXCEPTION 'weekly_routing_receipt_not_confirmed' USING ERRCODE='23514';END IF;
          v_credit:=public.fn_generate_scope_credit_invoices(v_club.id,v_from,v_end);
          IF v_credit->>'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'weekly_credit_invoice_incomplete' USING ERRCODE='23514';END IF;
          PERFORM public.fn_mark_scope_accounting_settled('club',v_club.id,v_from,v_end);
          v_validated_before:=current_setting('app.accounting_validated_scope',true);
          PERFORM set_config('app.accounting_validated_scope','club:'||v_club.id::text||':'||v_from::text||':'||v_end::text,true);
          PERFORM public.fn_weekly_accounting_deadline_check();
          v_statements:=public.fn_issue_scope_weekly_accounting('club',v_club.id,v_from,v_end);
          PERFORM public.fn_weekly_accounting_deadline_check();
          PERFORM set_config('app.accounting_validated_scope',COALESCE(v_validated_before,''),true);
          IF v_statements->>'success' IS DISTINCT FROM 'true' OR NOT EXISTS(
            SELECT 1 FROM public.settlement_invoices i JOIN public.settlement_periods sp ON sp.id=i.period_id
             WHERE sp.club_id=v_club.id AND sp.union_id IS NULL AND sp.start_at=v_from AND sp.end_at=v_end
              AND sp.status IN('settled','closed') AND i.club_id=v_club.id
              AND i.invoice_type='club_weekly_accounting' AND i.message_sent AND i.status<>'cancelled') THEN
            RAISE EXCEPTION 'weekly_club_statement_delivery_incomplete' USING ERRCODE='23514';END IF;
          v_result:=jsonb_build_object('success',true,'scope_kind','club','scope_id',v_club.id,'period_start',v_from,'period_end',v_end,
            'round2',v_stage2-'duplicate','round3',v_stage3-'duplicate','credit_invoices',v_credit,'club_weekly_statements',v_statements,'accounting_version',3);
          END IF;
          END IF;
          END IF;
        EXCEPTION WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT,v_detail=PG_EXCEPTION_DETAIL,v_state=RETURNED_SQLSTATE;
          v_result:=jsonb_build_object('success',false,'error',v_msg,'sqlstate',v_state,'detail',v_detail);
        END;
        PERFORM public.fn_weekly_accounting_attempt_end();
        UPDATE public.union_accounting_runs SET status=CASE WHEN v_result->>'success'='true' THEN 'complete' WHEN v_result->>'chunk_committed'='true' THEN 'running' ELSE 'failed' END,
          finished_at=clock_timestamp(),result=v_result WHERE standalone_club_id=v_club.id AND period_start=v_from AND period_end=v_end;
        IF v_result->>'success' IS DISTINCT FROM 'true' AND v_result->>'chunk_committed' IS DISTINCT FROM 'true' THEN
          v_failed:=v_failed+1;
          IF public.fn_accounting_failure_identity(v_previous) IS DISTINCT FROM public.fn_accounting_failure_identity(v_result) THEN
            INSERT INTO public.financial_alerts(source,severity,message,context) VALUES('weekly_club_accounting',CASE WHEN v_chunked AND NOT v_tick_budget_large AND v_result->>'error'='weekly_scope_time_budget_exhausted' THEN 'warning' ELSE 'critical' END,'Weekly club accounting is incomplete',
              jsonb_build_object('club_id',v_club.id,'period_start',v_from,'period_end',v_end,'result',v_result));
          END IF;
        END IF;
        v_checked:=v_checked+1;
        v_results:=v_results||jsonb_build_array(jsonb_build_object('club_id',v_club.id,'period_start',v_from,'period_end',v_end,'result',v_result));
        IF v_result->>'chunk_committed'='true' THEN
          RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,'more_remaining',true,'detail',v_results);
        END IF;
        IF v_result->>'success' IS DISTINCT FROM 'true' THEN EXIT;END IF;
        v_from:=v_end;
      END LOOP;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,
    'observed_at',clock_timestamp(),'detail',v_results);
END $function$
