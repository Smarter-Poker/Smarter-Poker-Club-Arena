SET check_function_bodies=off;
DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;END IF;END$$;
CREATE TABLE public.union_pnl_inventory_capture(singleton boolean NOT NULL,captured_at timestamp with time zone NOT NULL,contract_version integer NOT NULL,source_counts jsonb NOT NULL);
CREATE TABLE public.union_pnl_inventory_checkpoint_issues(boundary timestamp with time zone NOT NULL,source_name text NOT NULL,row_id uuid NOT NULL,event_id bigint NOT NULL);
CREATE TABLE public.union_pnl_inventory_checkpoint_rows(boundary timestamp with time zone NOT NULL,source_name text NOT NULL,row_id uuid NOT NULL,latest_event_id bigint NOT NULL,first_operation text NOT NULL,after_row jsonb);
CREATE TABLE public.union_pnl_inventory_checkpoints(boundary timestamp with time zone NOT NULL,base_boundary timestamp with time zone,max_event_id bigint,row_count bigint NOT NULL,issue_count bigint NOT NULL,rows_md5 text NOT NULL,issues_md5 text NOT NULL,result_md5 text NOT NULL,legacy_verified boolean NOT NULL,seal_ms bigint NOT NULL,sealed_by text NOT NULL,sealed_at timestamp with time zone NOT NULL);
CREATE TABLE public.union_pnl_inventory_events(event_id bigint NOT NULL,source_name text NOT NULL,row_id uuid NOT NULL,observed_at timestamp with time zone NOT NULL,transaction_id xid8 NOT NULL,operation text NOT NULL,before_row jsonb,after_row jsonb);
CREATE UNLOGGED TABLE public.union_pnl_inventory_seal_layer_issues(boundary timestamp with time zone NOT NULL,source_name text NOT NULL,row_id uuid NOT NULL,layer_end timestamp with time zone NOT NULL,event_id bigint NOT NULL);
CREATE UNLOGGED TABLE public.union_pnl_inventory_seal_layer_rows(boundary timestamp with time zone NOT NULL,source_name text NOT NULL,row_id uuid NOT NULL,layer_end timestamp with time zone NOT NULL,latest_event_id bigint NOT NULL,first_operation text,after_row jsonb);
CREATE UNLOGGED TABLE public.union_pnl_inventory_seal_layers(boundary timestamp with time zone NOT NULL,layer_end timestamp with time zone NOT NULL,layer_start timestamp with time zone NOT NULL,base_boundary timestamp with time zone,row_count bigint NOT NULL,issue_count bigint NOT NULL,layer_ms bigint NOT NULL,computed_at timestamp with time zone NOT NULL);
ALTER TABLE public.union_pnl_inventory_checkpoints ADD PRIMARY KEY(boundary), ALTER COLUMN sealed_by SET DEFAULT session_user,ALTER COLUMN sealed_at SET DEFAULT clock_timestamp();
ALTER TABLE public.union_pnl_inventory_checkpoint_rows ADD PRIMARY KEY(boundary,source_name,row_id), ADD FOREIGN KEY(boundary) REFERENCES public.union_pnl_inventory_checkpoints(boundary) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.union_pnl_inventory_checkpoint_issues ADD PRIMARY KEY(boundary,source_name,row_id,event_id), ADD FOREIGN KEY(boundary) REFERENCES public.union_pnl_inventory_checkpoints(boundary) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.union_pnl_inventory_seal_layers ADD PRIMARY KEY(boundary,layer_end),ALTER COLUMN computed_at SET DEFAULT clock_timestamp();
ALTER TABLE public.union_pnl_inventory_seal_layer_rows ADD PRIMARY KEY(boundary,source_name,row_id,layer_end);
ALTER TABLE public.union_pnl_inventory_seal_layer_issues ADD PRIMARY KEY(boundary,source_name,row_id,layer_end,event_id);
ALTER TABLE public.union_pnl_inventory_events ADD PRIMARY KEY(event_id);
CREATE FUNCTION public.fn_union_pnl_inventory_immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'original_inventory_is_immutable' USING ERRCODE='55000'; END$$;
CREATE FUNCTION public.fn_union_week_start(p_at timestamptz) RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$SELECT date_trunc('week',p_at AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'America/Los_Angeles'$$;
CREATE FUNCTION public.fn_caller_is_engine() RETURNS boolean LANGUAGE sql AS $$SELECT true$$;
CREATE TABLE public.accounting_close_certificates(kind text NOT NULL,union_id uuid,period_start timestamptz,period_end timestamptz,certified_at timestamptz,value jsonb,CONSTRAINT accounting_close_certificates_kind_check CHECK(kind IN('earned_plan','pnl_boundary','pnl_flows','pnl_touched','pnl_clubs')));
CREATE SCHEMA cron;
CREATE TABLE cron.job(jobid bigint PRIMARY KEY,schedule text,command text,nodename text,nodeport integer,database text,username text,active boolean,jobname text);
CREATE FUNCTION cron.alter_job(job_id bigint,schedule text DEFAULT NULL,command text DEFAULT NULL,database text DEFAULT NULL,username text DEFAULT NULL,active boolean DEFAULT NULL) RETURNS void LANGUAGE sql AS $$UPDATE cron.job SET command=$3 WHERE jobid=$1$$;
INSERT INTO cron.job(jobid,schedule,command,nodename,nodeport,database,username,active,jobname) VALUES(272,'*/5 * * * *','SELECT set_config(''statement_timeout'',CASE WHEN x.big THEN ''3600s'' ELSE ''720s'' END,false),set_config(''app.weekly_accounting_attempt_budget'',''1'',false),set_config(''app.weekly_accounting_scope_budget'',CASE WHEN x.big THEN ''50 minutes'' ELSE ''9 minutes'' END,false),set_config(''app.weekly_accounting_chunked'',''on'',false) FROM (SELECT (NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_checkpoints c WHERE c.boundary=public.fn_union_week_start(now())) AND NOT public.fn_accounting_close_seal_held(public.fn_union_week_start(now()))) OR EXISTS(SELECT 1 FROM public.weekly_accounting_scheduler_visits v WHERE v.last_outcome=''statement_timeout'' AND v.last_visit_at>now()-interval ''3 hours'') OR EXISTS(SELECT 1 FROM public.union_accounting_runs q WHERE q.status=''failed'' AND q.result->>''error''=''weekly_scope_time_budget_exhausted'' AND q.finished_at>now()-interval ''3 hours'') AS big) x; SELECT CASE WHEN extract(minute FROM now()) BETWEEN 40 AND 44 OR (now() >= public.fn_union_accounting_run_at(public.fn_union_week_start(now())) AND now() < public.fn_union_accounting_run_at(public.fn_union_week_start(now())) + interval ''40 minutes'') OR EXISTS(SELECT 1 FROM public.union_accounting_runs q WHERE q.status=''running'' AND q.result->>''chunk_committed''=''true'') OR EXISTS(SELECT 1 FROM public.union_accounting_runs q WHERE q.status=''failed'' AND q.result->>''error''=''weekly_scope_time_budget_exhausted'' AND q.finished_at>now()-interval ''3 hours'') OR public.fn_accounting_close_gate_lifted_unstarted() OR public.fn_union_pnl_inventory_seal_in_progress() THEN public.fn_union_settlement_cascade_due() END;','localhost',5432,'postgres','postgres',true,'union-weekly-rakeback-close');
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
;
CREATE OR REPLACE FUNCTION public.fn_union_pnl_evidence_report(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_open jsonb; v_close jsonb; v_issues jsonb:='[]'; v_clubs jsonb; v_eco jsonb; v_terms jsonb;
 v_fence timestamptz; v_bad bigint; v_hands bigint; v_resolved bigint:=0; v_rows bigint; v_cash_reconciled boolean; v_terms_value jsonb; v_cash_rake numeric; v_accepted_rake numeric;
 v_memo_key text; v_memo jsonb; v_report jsonb; v_flows jsonb; v_open_resolved uuid[];
 v_inv boolean; v_cash boolean; v_credit boolean;
 v_cert jsonb;
BEGIN
 IF p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end)
  OR p_start<>public.fn_union_week_start(p_start) OR p_end<>public.fn_union_week_start(p_start+interval '8 days')
  OR p_end>clock_timestamp() THEN RAISE EXCEPTION 'invalid_closed_pnl_evidence_period' USING ERRCODE='22023'; END IF;
 SELECT captured_at INTO v_fence FROM public.union_pnl_weekly_capture WHERE singleton;
 IF v_fence IS NULL OR p_start<=v_fence THEN
  RETURN jsonb_build_object('report_version',1,'status','blocked','basis_certified',false,'payment_authorized',false,
   'issues',jsonb_build_array('week_precedes_complete_original_capture'),'capture_started_at',v_fence,'all_players_included',false);
 END IF;
 -- UNION P&L EVIDENCE MEMO (20260928): one weekly close reaches this report
 -- through preparation (close quality), the cascade (qualified clubs, ECO,
 -- player P&L) and the invoices. Inside a union close attempt
 -- (app.accounting_close_memo='on', set only by fn_weekly_accounting_attempt_begin)
 -- the first complete report of this (union, week) is kept for the rest of
 -- the attempt; attempt_begin and attempt_end clear it and a rolled-back
 -- subtransaction forgets it with its settings. Everywhere else the report is
 -- proved on every call, exactly as before.
 IF current_setting('app.accounting_close_memo',true)='on' THEN
  v_memo_key:=p_union_id::text||'|'||p_start::text||'|'||p_end::text;
  v_memo:=NULLIF(current_setting('app.union_pnl_evidence_memo',true),'')::jsonb;
  IF v_memo ? v_memo_key THEN RETURN v_memo->v_memo_key; END IF;
 END IF;
 -- UNION P&L NARROW READS (20260929044303): the week's registration events,
 -- hands and tournament credits are read through their narrow projections
 -- (union_pnl_inventory_touches, union_pnl_cash_outcome_touches,
 -- union_pnl_credit_touches), each written by its source row's own insert,
 -- once the throttled backfill has proved it complete; until then through
 -- the original wide rows, statement for statement as before.
 v_inv:=public.fn_union_pnl_projection_ready('inventory_touches');
 v_cash:=public.fn_union_pnl_projection_ready('cash_outcome_touches');
 v_credit:=public.fn_union_pnl_projection_ready('credit_touches');
 -- Both readers wait for the original book's in-flight transactions; this
 -- function is VOLATILE so every subsequent query sees their committed facts.
 -- CHUNKED CLOSE CERTIFICATES (20261003): inside a chunked union close attempt
 -- each expensive read below that found nothing wrong is kept, once proved,
 -- in accounting_close_certificates for the rest of that close of this
 -- closed week (fn_accounting_close_certificate / fn_accounting_close_certify;
 -- both do nothing anywhere else). An attempt whose time budget is spent
 -- after a step it had to prove returns 'warming' - not ready, nothing
 -- certified for payment - and the next attempt continues from the kept
 -- steps. A step that found a problem is never kept: it is proved again.
 v_open:=public.fn_accounting_close_certificate('pnl_boundary',p_union_id,p_start,p_start);
 IF v_open IS NULL THEN
  v_open:=public.fn_union_pnl_boundary(p_union_id,p_start);
  IF v_open->>'status'='ready' THEN PERFORM public.fn_accounting_close_certify('pnl_boundary',p_union_id,p_start,p_start,v_open); END IF;
 END IF;
 IF public.fn_accounting_close_warm_stop() THEN RETURN jsonb_build_object('report_version',1,'status','warming','basis_certified',false,'payment_authorized',false,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,'issues',jsonb_build_array('union_pnl_certification_in_progress'),'all_players_included',false); END IF;
 v_close:=public.fn_accounting_close_certificate('pnl_boundary',p_union_id,p_end,p_end);
 IF v_close IS NULL THEN
  v_close:=public.fn_union_pnl_boundary(p_union_id,p_end);
  IF v_close->>'status'='ready' THEN PERFORM public.fn_accounting_close_certify('pnl_boundary',p_union_id,p_end,p_end,v_close); END IF;
 END IF;
 IF public.fn_accounting_close_warm_stop() THEN RETURN jsonb_build_object('report_version',1,'status','warming','basis_certified',false,'payment_authorized',false,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,'issues',jsonb_build_array('union_pnl_certification_in_progress'),'all_players_included',false); END IF;
 IF v_open->>'status' IS DISTINCT FROM 'ready' THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','opening_basis_incomplete','evidence',v_open)); END IF;
 IF v_close->>'status' IS DISTINCT FROM 'ready' THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','closing_basis_incomplete','evidence',v_close)); END IF;
 -- The registrations the opening boundary carried through a valid opening
 -- resolution (union_pnl_opening_registration_resolutions): each one's
 -- original entry is proved from the posted chip ledger, not a funding receipt.
 v_open_resolved:=ARRAY(SELECT (x->>'source_id')::uuid FROM jsonb_array_elements(COALESCE(v_open->'holdings','[]')) x
  WHERE x->>'kind'='deferred_tournament_result' AND x->>'basis'='opening_registration_resolution');
 -- A blocked outcome counts as accepted only through an immutable resolution
 -- receipt re-proved from primary receipts and bound to this exact outcome
 -- (hand, payload hash, evidence). The outcome row itself is never changed.
 -- Only a hand outside the ready/certified/all-players/same-scope shape can
 -- be refused or resolved: those hands (the predicate of
 -- union_pnl_cash_outcomes_unaccepted), found through the projection's shape
 -- flag and re-checked against their rows, never the whole week's evidence.
 SELECT count(*) FILTER(WHERE NOT public.fn_union_pnl_cash_outcome_accepted(o)),
  count(*) FILTER(WHERE (o.evidence->>'status' IS DISTINCT FROM 'ready' OR o.evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb)
   AND public.fn_union_pnl_cash_outcome_accepted(o))
 INTO v_bad,v_resolved FROM public.fn_union_pnl_week_shaped_hands(p_union_id,p_start,p_end,v_cash) o;
 -- A hand whose provenance link the engine never recorded (its outcome has no
 -- game scope) counts only through its immutable link resolution
 -- (union_pnl_cash_outcome_link_resolutions), in the Union its re-proved scope
 -- names, and is accepted only when its re-proved evidence is certified.
 SELECT v_bad+count(*) FILTER(WHERE NOT (k.evidence->>'status'='ready' AND k.evidence->'basis_certified'='true'::jsonb
   AND k.evidence->'all_players_included'='true'::jsonb)),
  v_resolved+count(*) FILTER(WHERE k.evidence->>'status'='ready' AND k.evidence->'basis_certified'='true'::jsonb
   AND k.evidence->'all_players_included'='true'::jsonb)
 INTO v_bad,v_resolved FROM public.fn_union_pnl_linked_cash_outcomes(p_union_id,p_start,p_end) k;
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','accepted_cash_basis_incomplete','count',v_bad)); END IF;
 -- A missing original game scope cannot silently disappear from every Union.
 SELECT count(*) INTO v_bad FROM public.union_pnl_cash_outcomes WHERE recognized_at>=p_start AND recognized_at<p_end
  AND NOT game_scope ?& ARRAY['game_union_id','host_club_id','tournament_id','is_private','asset','unit_scale']
  AND NOT EXISTS(SELECT 1 FROM public.fn_union_pnl_cash_outcome_link(union_pnl_cash_outcomes));
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','accepted_cash_original_scope_missing','count',v_bad)); END IF;
 SELECT count(*) INTO v_bad FROM public.union_pnl_original_flows WHERE recognized_at>=p_start AND recognized_at<p_end
  AND NOT game_scope ?& ARRAY['game_union_id','host_club_id','tournament_id','is_private','asset','unit_scale'];
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','original_money_flow_scope_missing','count',v_bad)); END IF;
 SELECT count(*) INTO v_bad FROM public.cash_participant_funding_receipts WHERE recorded_at>=v_fence AND recorded_at<p_end AND transaction_id IS NULL;
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array('post_capture_funding_transaction_identity_missing'); END IF;
 SELECT count(*) INTO v_bad FROM public.cash_funding_application_receipts WHERE applied_at>=v_fence AND applied_at<p_end AND transaction_id IS NULL;
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array('post_capture_application_transaction_identity_missing'); END IF;
 SELECT count(*) INTO v_bad FROM public.cash_hand_provenance_receipts WHERE accepted_at>=v_fence AND accepted_at<p_end AND transaction_id IS NULL;
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array('post_capture_hand_transaction_identity_missing'); END IF;
 -- The flow proof is read once; the P&L below reuses these exact rows.
 v_cert:=public.fn_accounting_close_certificate('pnl_flows',p_union_id,p_start,p_end);
 IF v_cert IS NOT NULL THEN
  v_bad:=(v_cert->>'bad')::bigint; v_flows:=v_cert->'flows';
 ELSE
 SELECT count(*) FILTER(WHERE NOT f.valid),COALESCE(jsonb_agg(to_jsonb(f)),'[]') INTO v_bad,v_flows
  FROM public.fn_union_pnl_original_flow_evidence(p_union_id,p_start,p_end) f;
  IF v_bad=0 THEN PERFORM public.fn_accounting_close_certify('pnl_flows',p_union_id,p_start,p_end,jsonb_build_object('bad',v_bad,'flows',v_flows)); END IF;
 END IF;
 IF public.fn_accounting_close_warm_stop() THEN RETURN jsonb_build_object('report_version',1,'status','warming','basis_certified',false,'payment_authorized',false,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,'issues',jsonb_build_array('union_pnl_certification_in_progress'),'all_players_included',false); END IF;
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','original_money_flow_basis_incomplete','count',v_bad)); END IF;
 -- Every touched tournament registration must have its original chip entry,
 -- including zero-rake players. Historical/current membership is never used.
 -- The week's registration events, each touched tournament's Union proved
 -- once through its own events (t.row_id::text equality kept; the uuid
 -- equality only lets the index find the same rows and is never attempted on
 -- a non-canonical id). The frame test is unchanged; i.observed_at repeats it
 -- because fn_union_pnl_inventory_observe, the only writer of framed events,
 -- stamps each event with its frame's observed_at (both tables immutable), so
 -- the same rows are reached through union_pnl_inventory_events_players_observed.
 -- Both reads (fn_union_pnl_touched_registrations, fn_union_pnl_tournament_in_union)
 -- come from union_pnl_inventory_touches once it is complete: the same keys,
 -- the frame's observed_at copied at capture, without the wide rows.
 v_cert:=public.fn_accounting_close_certificate('pnl_touched',p_union_id,p_start,p_end);
 IF v_cert IS NOT NULL THEN
  v_bad:=(v_cert->>'bad')::bigint;
 ELSE
 WITH touched AS MATERIALIZED (
  SELECT w.registration_id row_id,w.touched_tournament_id tournament_id
  FROM public.fn_union_pnl_touched_registrations(p_start,p_end,v_inv) w
 ), union_tournaments AS MATERIALIZED (
  SELECT d.tournament_id FROM (SELECT DISTINCT tournament_id FROM touched) d
  WHERE public.fn_union_pnl_tournament_in_union(d.tournament_id,p_union_id,v_inv)
 ), union_touched AS MATERIALIZED (
  SELECT i.row_id FROM touched i WHERE i.tournament_id IN (SELECT tournament_id FROM union_tournaments)
 ), entries AS MATERIALIZED (
  -- the two receipt tests, read once per touched registration (column for
  -- column: a whole-row argument would detoast every receipt's snapshots)
  SELECT r.registration_id,
   bool_or(r.asset='chips' AND public.fn_union_pnl_tournament_entry_club_of(r.asset,r.amount,r.funding_club_id,r.ledger_id,r.entitlement_id,r.registration_snapshot) IS NOT NULL) has_entry,
   bool_or(r.asset<>'chips' OR public.fn_union_pnl_tournament_entry_club_of(r.asset,r.amount,r.funding_club_id,r.ledger_id,r.entitlement_id,r.registration_snapshot) IS NULL) has_other
  FROM public.tournament_participant_funding_receipts r
  WHERE r.registration_id IN (SELECT row_id FROM union_touched)
  GROUP BY r.registration_id
 ) SELECT count(*) INTO v_bad FROM union_touched i LEFT JOIN entries e ON e.registration_id=i.row_id
 WHERE (NOT COALESCE(e.has_entry,false) AND i.row_id<>ALL(v_open_resolved)
   AND public.fn_union_pnl_satellite_seat_owner(i.row_id,NULL) IS NULL)
  OR COALESCE(e.has_other,false);
  IF v_bad=0 THEN PERFORM public.fn_accounting_close_certify('pnl_touched',p_union_id,p_start,p_end,jsonb_build_object('bad',v_bad)); END IF;
 END IF;
 IF public.fn_accounting_close_warm_stop() THEN RETURN jsonb_build_object('report_version',1,'status','warming','basis_certified',false,'payment_authorized',false,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,'issues',jsonb_build_array('union_pnl_certification_in_progress'),'all_players_included',false); END IF;
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','tournament_original_population_or_instrument_incomplete','count',v_bad)); END IF;
 -- An award must return to the original funding club; a changed credited
 -- wallet does not prove a new earning ownership agreement.
 -- The week's credits of this Union (its tournament snapshot's Union, its
 -- frame in the week) come from union_pnl_credit_touches once complete. The
 -- two whole-row resolutions (a whole-row value detoasts every snapshot of
 -- the credit) are asked only of a credit the entry test did not settle: the
 -- same conjunction, in an order the planner may not change.
 SELECT count(*) INTO v_bad FROM public.fn_union_pnl_week_union_credits(p_union_id,p_start,p_end,v_credit) w
 JOIN public.tournament_accounting_credit_receipts c ON c.id=w.credit_id
 WHERE CASE WHEN (cardinality(c.entry_receipt_ids)=0 OR EXISTS(SELECT 1 FROM unnest(c.entry_receipt_ids) original_id(receipt_id)
   LEFT JOIN public.tournament_participant_funding_receipts r ON r.id=original_id.receipt_id
   WHERE r.id IS NULL OR r.asset<>'chips' OR public.fn_union_pnl_tournament_entry_club_of(r.asset,r.amount,r.funding_club_id,r.ledger_id,r.entitlement_id,r.registration_snapshot) IS DISTINCT FROM c.credited_club_id OR r.user_id IS DISTINCT FROM c.user_id))
  THEN NOT public.fn_union_pnl_award_owner_resolved(c,p_union_id,p_start,v_open_resolved)
   AND NOT public.fn_union_pnl_award_satellite_owner(c) ELSE false END;
 IF v_bad>0 THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','tournament_award_original_earning_owner_incomplete','count',v_bad)); END IF;
 v_eco:=public.fn_union_eco_terms_evidence(p_union_id,p_start,p_end);
 IF v_eco->>'status' IS DISTINCT FROM 'ready' THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','eco_commercial_basis_incomplete','evidence',v_eco)); END IF;
 SELECT count(DISTINCT x->'terms') INTO v_bad FROM jsonb_array_elements(COALESCE(v_eco->'segments','[]')) x;
 IF v_bad<>1 THEN v_issues:=v_issues||jsonb_build_array('eco_intraweek_changed_terms_require_original_allocation'); END IF;
 v_terms_value:=v_eco#>'{segments,0,terms}';
 -- Validate every original bank/source leg even when the week has no rows.
 -- CHUNKED CLOSE WINDOWS (20261003): inside a chunked close the plan's
 -- two-hour windows are proved first, a few per attempt; until all are, the
 -- attempt stops warming (fn_accounting_union_earned_plan_advance is NULL,
 -- and this test passes, everywhere else).
 IF public.fn_accounting_union_earned_plan_advance(p_union_id,p_start,p_end) IS FALSE THEN RETURN jsonb_build_object('report_version',1,'status','warming','basis_certified',false,'payment_authorized',false,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,'issues',jsonb_build_array('union_pnl_certification_in_progress'),'all_players_included',false); END IF;
 PERFORM public.fn_accounting_union_earned_plan(p_union_id,p_start,p_end);
 IF public.fn_accounting_close_warm_stop() THEN RETURN jsonb_build_object('report_version',1,'status','warming','basis_certified',false,'payment_authorized',false,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,'issues',jsonb_build_array('union_pnl_certification_in_progress'),'all_players_included',false); END IF;
 v_cert:=public.fn_accounting_close_certificate('pnl_clubs',p_union_id,p_start,p_end);
 IF v_cert IS NOT NULL THEN
  v_clubs:=v_cert->'clubs'; v_cash_reconciled:=(v_cert->>'cash_reconciled')::boolean; v_rows:=(v_cert->>'rows')::bigint;
  v_cash_rake:=(v_cert->>'cash_rake')::numeric; v_hands:=(v_cert->>'hands')::bigint; v_accepted_rake:=(v_cert->>'accepted_rake')::numeric;
 ELSE
 WITH flows AS MATERIALIZED (SELECT * FROM jsonb_to_recordset(v_flows)
  AS f(ledger_id uuid,club_id uuid,user_id uuid,buyins numeric,cashouts numeric,kind text,valid boolean)),
 -- One read of the week's hands: each (club, player) delta total, and (kind 0)
 -- the hand count and accepted rake that used to cost two more reads.
 outcome_pass AS MATERIALIZED (
  SELECT x.kind,x.club_id,x.user_id,sum(x.delta) delta,count(*) hands,sum(x.rake) rake
  FROM (SELECT h.hand_accepted_rake accepted_rake,h.hand_participants participants
   FROM public.fn_union_pnl_week_hand_lines(p_union_id,p_start,p_end,v_cash) h
   -- with this Union's linked hands, through their link resolutions
   UNION ALL SELECT k.evidence->>'accepted_rake',k.evidence->'participants' FROM public.fn_union_pnl_linked_cash_outcomes(p_union_id,p_start,p_end) k) o CROSS JOIN LATERAL (
   SELECT 0 kind,NULL::uuid club_id,NULL::uuid user_id,NULL::numeric delta,o.accepted_rake::numeric rake
   UNION ALL
   SELECT 1,(p->>'earning_club_id')::uuid,(p->>'user_id')::uuid,(p->>'observed_stack_delta')::numeric,NULL::numeric
   FROM jsonb_array_elements(COALESCE(o.participants,'[]')) p) x
  GROUP BY x.kind,x.club_id,x.user_id
 ), hand_players AS (SELECT club_id,user_id,delta FROM outcome_pass WHERE kind=1
  -- JACKPOT SHARES ON THE FELT (20260929): a Bad Beat Jackpot share credited
  -- to a seat after its hand committed is that player's cash result too.
  UNION ALL SELECT a.club_id,a.user_id,a.amount FROM public.fn_union_pnl_week_bbj_stack_awards(p_union_id,p_start,p_end) a), opening AS (SELECT (x->>'club_id')::uuid club_id,sum((x->>'amount')::numeric) amount,
   sum((x->>'amount')::numeric) FILTER(WHERE x->>'kind'<>'deferred_tournament_result') cash
   FROM jsonb_array_elements(COALESCE(v_open->'holdings','[]')) x GROUP BY 1),
 closing AS (SELECT (x->>'club_id')::uuid club_id,sum((x->>'amount')::numeric) amount,
   sum((x->>'amount')::numeric) FILTER(WHERE x->>'kind'<>'deferred_tournament_result') cash
   FROM jsonb_array_elements(COALESCE(v_close->'holdings','[]')) x GROUP BY 1),
 -- The canonical payout basis excludes retained Union-house rake. Gross
 -- original rake still belongs in the all-player P&L and bank reconciliation.
 rake AS MATERIALIZED (
  SELECT s.club_id,sum(s.rake_credit) generated,COALESCE(k.earned,0) earned,
   sum(s.rake_credit) FILTER(WHERE s.source_type='cash_rake_accrual') cash_rake,
   sum(s.rake_credit) FILTER(WHERE s.source_type='tournament_fee_accrual') tournament_rake
  FROM public.accounting_payable_earning_sources s
  LEFT JOIN (SELECT club_id,sum(payout) earned FROM public.fn_union_club_rake_basis(p_union_id,p_start,p_end) GROUP BY club_id) k ON k.club_id=s.club_id
  WHERE s.union_id=p_union_id AND s.earned_at>=p_start AND s.earned_at<p_end GROUP BY s.club_id,k.earned
 ),
 roster AS (
  SELECT DISTINCT (COALESCE(after_row,before_row)->>'club_id')::uuid club_id FROM public.union_pnl_inventory_events
   WHERE source_name='union_clubs' AND COALESCE(after_row,before_row)->>'union_id'=p_union_id::text AND observed_at<p_end
    AND (observed_at>=p_start OR row_id::text IN(SELECT x#>>'{row,id}' FROM jsonb_array_elements(COALESCE(v_open#>'{inventory,population,union_clubs}','[]')) x))
  UNION SELECT club_id FROM rake UNION SELECT club_id FROM flows UNION SELECT club_id FROM hand_players UNION SELECT club_id FROM opening UNION SELECT club_id FROM closing
 ), movement AS (SELECT club_id,sum(buyins) buyins,sum(cashouts) cashouts,
  sum(cashouts-buyins) FILTER(WHERE kind IN('cash_funding','cash_return')) cash_flow,
  sum(buyins) FILTER(WHERE kind='cash_funding') cash_buyins,sum(cashouts) FILTER(WHERE kind='cash_return') cash_cashouts FROM flows GROUP BY club_id),
 hands AS (SELECT club_id,sum(delta) delta FROM hand_players GROUP BY club_id),
 people AS (SELECT club_id,count(DISTINCT user_id)::int players FROM(SELECT club_id,user_id FROM flows UNION SELECT club_id,user_id FROM hand_players
  UNION SELECT (x->>'club_id')::uuid,(x->>'user_id')::uuid FROM jsonb_array_elements(COALESCE(v_open->'holdings','[]')||COALESCE(v_close->'holdings','[]')) x) q GROUP BY club_id),
 club_rows AS (
  SELECT r.club_id,COALESCE(m.buyins,0) buyins,COALESCE(m.cashouts,0) cashouts,COALESCE(m.cash_buyins,0) cash_buyins,COALESCE(m.cash_cashouts,0) cash_cashouts,
   COALESCE(m.cashouts,0)-COALESCE(m.buyins,0) realized_net,COALESCE(o.amount,0) seated_start,COALESCE(c.amount,0) seated_end,
   COALESCE(o.cash,0) seated_start_cash,COALESCE(c.cash,0) seated_end_cash,
   COALESCE(c.amount,0)-COALESCE(o.amount,0) stack_delta,COALESCE(h.delta,0) cash_player_pnl,
   COALESCE(m.cashouts,0)-COALESCE(m.buyins,0)+COALESCE(c.amount,0)-COALESCE(o.amount,0)-COALESCE(h.delta,0) tournament_player_pnl,
   COALESCE(m.cash_flow,0)+COALESCE(c.cash,0)-COALESCE(o.cash,0)=COALESCE(h.delta,0) cash_reconciled,
   COALESCE(p.players,0) players,COALESCE(k.generated,0) rake_paid,COALESCE(k.earned,0) rake_earned,COALESCE(k.cash_rake,0) cash_rake,COALESCE(k.tournament_rake,0) tournament_rake,
   COALESCE(m.cashouts,0)-COALESCE(m.buyins,0)+COALESCE(c.amount,0)-COALESCE(o.amount,0)+COALESCE(k.generated,0) net
  FROM roster r LEFT JOIN movement m USING(club_id) LEFT JOIN opening o USING(club_id) LEFT JOIN closing c USING(club_id)
  LEFT JOIN hands h USING(club_id) LEFT JOIN people p USING(club_id) LEFT JOIN rake k USING(club_id)
  WHERE r.club_id IS NOT NULL
 ), player_results AS (
  SELECT club_id,user_id,sum(delta) delta FROM (
   SELECT club_id,user_id,cashouts-buyins delta FROM flows
   UNION ALL SELECT (x->>'club_id')::uuid,(x->>'user_id')::uuid,(x->>'amount')::numeric FROM jsonb_array_elements(COALESCE(v_close->'holdings','[]')) x
   UNION ALL SELECT (x->>'club_id')::uuid,(x->>'user_id')::uuid,-(x->>'amount')::numeric FROM jsonb_array_elements(COALESCE(v_open->'holdings','[]')) x
  ) amounts GROUP BY club_id,user_id
 ), wins AS(SELECT club_id,sum(greatest(delta,0)) winnings,sum(greatest(-delta,0)) losses FROM player_results GROUP BY club_id), complete AS (
  SELECT q.*,COALESCE(w.winnings,0) winnings,COALESCE(w.losses,0) losses,
   CASE v_terms_value->>'eco_base_mode'
    WHEN 'club_cash_profit' THEN rake_earned-cash_player_pnl
    WHEN 'net_invoice_position' THEN realized_net+stack_delta+rake_paid+rake_earned
    WHEN 'winnings_plus_rake' THEN realized_net+stack_delta+rake_paid
    WHEN 'winnings_only' THEN realized_net+stack_delta END eco_base
  FROM club_rows q LEFT JOIN wins w USING(club_id)
 ) SELECT COALESCE(jsonb_agg(to_jsonb(q)||jsonb_build_object('eco_amount',CASE WHEN v_terms_value->'eco_enabled'='true'::jsonb
  THEN round(-(v_terms_value->>'eco_rate')::numeric*eco_base,2) ELSE 0 END) ORDER BY club_id),'[]'),
  COALESCE(bool_and(cash_reconciled),true),count(*),COALESCE(sum(cash_rake),0),
  COALESCE((SELECT h.hands FROM outcome_pass h WHERE h.kind=0),0),(SELECT COALESCE(sum(h.rake),0) FROM outcome_pass h WHERE h.kind=0)
  INTO v_clubs,v_cash_reconciled,v_rows,v_cash_rake,v_hands,v_accepted_rake FROM complete q;
  IF v_cash_reconciled AND v_accepted_rake IS NOT DISTINCT FROM v_cash_rake THEN
   PERFORM public.fn_accounting_close_certify('pnl_clubs',p_union_id,p_start,p_end,jsonb_build_object('clubs',v_clubs,
    'cash_reconciled',v_cash_reconciled,'rows',v_rows,'cash_rake',v_cash_rake,'hands',v_hands,'accepted_rake',v_accepted_rake));
  END IF;
 END IF;
 IF v_accepted_rake IS DISTINCT FROM v_cash_rake THEN v_issues:=v_issues||jsonb_build_array('accepted_cash_rake_does_not_match_original_earning_and_bank_basis'); END IF;
 IF NOT v_cash_reconciled THEN v_issues:=v_issues||jsonb_build_array('accepted_cash_deltas_do_not_reconcile_original_flows_and_boundaries'); END IF;
 v_report:=jsonb_build_object('report_version',1,'status',CASE WHEN v_issues='[]'::jsonb THEN 'ready' ELSE 'blocked' END,
  'basis_certified',v_issues='[]'::jsonb,'payment_authorized',false,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,
  'issues',v_issues,'clubs',v_clubs,'opening_basis',v_open,'closing_basis',v_close,'eco_commercial_terms_evidence',v_eco,
  'accepted_cash_hands',v_hands,'accepted_cash_hands_resolved',v_resolved,'club_count',v_rows,'current_seats_used',false,'current_membership_used',false,
  'all_players_included',v_issues='[]'::jsonb,'tournament_basis','original_realized_settlement_deferred_while_open');
 IF v_memo_key IS NOT NULL THEN
  PERFORM set_config('app.union_pnl_evidence_memo',(COALESCE(NULLIF(current_setting('app.union_pnl_evidence_memo',true),'')::jsonb,'{}')
   ||jsonb_build_object(v_memo_key,v_report))::text,true);
 END IF;
 RETURN v_report;
END $function$
;
