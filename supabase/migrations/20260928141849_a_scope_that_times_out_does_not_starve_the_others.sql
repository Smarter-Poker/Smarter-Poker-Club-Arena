-- A SCOPE THAT TIMES OUT DOES NOT STARVE THE OTHERS (2026-09-28).
--
-- The weekly scheduler (fn_process_weekly_accounting_scope with no scope,
-- driven by cron job union-weekly-rakeback-close with a 2400s statement budget
-- and by the engine's RakebackSettler RPC with service_role's 8s) runs every
-- due scope inside ONE statement, ordered by the last visit stamped on a run
-- row. When Midway Union's close hit the statement timeout, the cancel is not
-- caught by any WHEN OTHERS handler, so the whole tick rolled back, including
-- the visit stamp and every scope finished before it. Midway, with no run row
-- of its own yet, stayed first in line (NULLS FIRST) and every other union and
-- club was starved on every tick since 09:30 UTC.
--
-- Now each scope's visit is its own subtransaction:
--   * the statement budget running out inside a scope rolls back that scope
--     only, records the visit as 'statement_timeout' and ends the tick (the
--     budget is spent), committing every scope finished before it;
--   * any other error raised out of a scope rolls back that scope only,
--     records 'error' and the tick continues with the next scope;
--   * an operator's cancel ("user request") still stops and rolls back the
--     whole tick, exactly as before;
--   * the durable visit lives in weekly_accounting_scheduler_visits, which
--     exists even when the scope has no run row, and a scope whose last visit
--     did not finish is ordered after every scope whose visit finished;
--   * a new alert is raised when a scope's unfinished outcome changes (for a
--     timeout only when the tick had a cron-sized budget, >= 20 minutes; the
--     engine's 8s probe running out is not an incident).
-- Before its scopes, a tick with a cron-sized budget seals any closed week's
-- original inventory checkpoint (fn_union_pnl_inventory_checkpoint_due, from
-- 20260928141826), so the closes that follow read it instead of the history.
-- Scope work, run rows, ledgers and settlement rules are unchanged.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure))
     IS DISTINCT FROM 'd4cef10e4639de0d0f1d3cf0b8b2d926' THEN
    RAISE EXCEPTION 'preimage mismatch: fn_process_weekly_accounting_scope is not the reviewed definition';
  END IF;
  IF to_regclass('public.weekly_accounting_scheduler_visits') IS NOT NULL THEN
    RAISE EXCEPTION 'preimage mismatch: weekly_accounting_scheduler_visits already exists';
  END IF;
END $pre$;

CREATE TABLE public.weekly_accounting_scheduler_visits (
  scope_kind text NOT NULL CHECK (scope_kind IN ('union','club')),
  scope_id uuid NOT NULL,
  last_visit_at timestamptz NOT NULL,
  last_outcome text NOT NULL CHECK (last_outcome IN ('visited','error','statement_timeout')),
  last_error jsonb,
  unfinished_visits integer NOT NULL DEFAULT 0 CHECK (unfinished_visits >= 0),
  PRIMARY KEY (scope_kind, scope_id),
  CHECK ((last_outcome = 'visited') = (last_error IS NULL))
);
ALTER TABLE public.weekly_accounting_scheduler_visits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.weekly_accounting_scheduler_visits FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.weekly_accounting_scheduler_visits TO service_role;
COMMENT ON TABLE public.weekly_accounting_scheduler_visits IS
 'The weekly scheduler''s last visit of each scope and how it ended. Written only by fn_process_weekly_accounting_scope, outside the scope''s own subtransaction, so a scope that raised or ran out of statement budget is recorded and ordered last instead of rolling the tick back.';

DO $patch$
DECLARE source text; needle text; replacement text;
BEGIN
 source:=pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure);

 needle:=$n$  v_msg text; v_detail text; v_state text;
BEGIN$n$;
 IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN
  RAISE EXCEPTION 'scheduler_declarations_changed' USING ERRCODE='55000'; END IF;
 replacement:=$r$  v_msg text; v_detail text; v_state text;
  v_scope_outcome text; v_scope_error jsonb; v_prior_outcome text;
  -- A cron-sized statement budget (the 2400s tick), as opposed to the
  -- engine's 8s service_role probe.
  v_tick_budget_large boolean := current_setting('statement_timeout') IN ('0','0ms')
    OR current_setting('statement_timeout')::interval >= interval '20 minutes';
BEGIN$r$;
 source:=replace(source,needle,replacement);

 needle:=$n$  IF p_union_id IS NULL AND p_club_id IS NULL THEN
    v_saved_budget:=current_setting('app.weekly_accounting_attempt_budget',true);$n$;
 IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN
  RAISE EXCEPTION 'scheduler_entry_changed' USING ERRCODE='55000'; END IF;
 replacement:=$r$  IF p_union_id IS NULL AND p_club_id IS NULL THEN
    -- Seal any closed week's original inventory once, before a scope reads it,
    -- when this tick's budget can hold the seal.
    IF v_tick_budget_large AND to_regprocedure('public.fn_union_pnl_inventory_checkpoint_due()') IS NOT NULL THEN
      BEGIN
        PERFORM public.fn_union_pnl_inventory_checkpoint_due();
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
    v_saved_budget:=current_setting('app.weekly_accounting_attempt_budget',true);$r$;
 source:=replace(source,needle,replacement);

 needle:=$n$        ) SELECT e.kind,e.id,max(GREATEST(q.last_scheduler_visit_at,q.started_at)) AS last_visit
          FROM eligible e LEFT JOIN public.union_accounting_runs q ON q.scope_kind=e.kind AND q.scope_id=e.id
          GROUP BY e.kind,e.id
          ORDER BY last_visit NULLS FIRST,(e.kind='union') DESC,e.id$n$;
 IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN
  RAISE EXCEPTION 'scheduler_order_changed' USING ERRCODE='55000'; END IF;
 replacement:=$r$        ) SELECT e.kind,e.id,GREATEST(max(GREATEST(q.last_scheduler_visit_at,q.started_at)),max(v.last_visit_at)) AS last_visit,
            COALESCE(bool_or(v.last_outcome IN ('error','statement_timeout')),false) AS last_unfinished
          FROM eligible e LEFT JOIN public.union_accounting_runs q ON q.scope_kind=e.kind AND q.scope_id=e.id
          LEFT JOIN public.weekly_accounting_scheduler_visits v ON v.scope_kind=e.kind AND v.scope_id=e.id
          GROUP BY e.kind,e.id
          -- A scope whose last visit did not finish goes after every scope
          -- whose visit finished: it can never hold the others back.
          ORDER BY last_unfinished,last_visit NULLS FIRST,(e.kind='union') DESC,e.id$r$;
 source:=replace(source,needle,replacement);

 needle:=$n$        v_scope_result:=public.fn_process_weekly_accounting_scope(
          CASE WHEN v_scope.kind='union' THEN v_scope.id END,
          CASE WHEN v_scope.kind='club' THEN v_scope.id END);
        IF v_scope_result->>'skipped'='true' AND v_scope_result->>'reason'='maintenance_window' THEN
          v_more:=true;EXIT;END IF;
        IF jsonb_typeof(v_scope_result->'checked') IS DISTINCT FROM 'number'$n$;
 IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN
  RAISE EXCEPTION 'scheduler_visit_changed' USING ERRCODE='55000'; END IF;
 replacement:=$r$        -- The visit is its own subtransaction: whatever it raises rolls back
        -- this scope only, and is recorded below.
        v_scope_outcome:='visited'; v_scope_error:=NULL;
        BEGIN
        v_scope_result:=public.fn_process_weekly_accounting_scope(
          CASE WHEN v_scope.kind='union' THEN v_scope.id END,
          CASE WHEN v_scope.kind='club' THEN v_scope.id END);
        IF v_scope_result->>'skipped'='true' AND v_scope_result->>'reason'='maintenance_window' THEN
          v_scope_outcome:='maintenance';
        ELSE
        IF jsonb_typeof(v_scope_result->'checked') IS DISTINCT FROM 'number'$r$;
 source:=replace(source,needle,replacement);

 needle:=$n$          OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_scope_result->'detail')d
            WHERE CASE WHEN v_scope.kind='union' THEN d->>'union_id' ELSE d->>'club_id' END IS DISTINCT FROM v_scope.id::text) THEN
          RAISE EXCEPTION 'weekly_scope_scheduler_receipt_invalid' USING ERRCODE='23514';END IF;
        v_checked:=v_checked+v_scope_checked;v_failed:=v_failed+v_scope_failed;$n$;
 IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN
  RAISE EXCEPTION 'scheduler_receipt_check_changed' USING ERRCODE='55000'; END IF;
 replacement:=$r$          OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_scope_result->'detail')d
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
        v_checked:=v_checked+v_scope_checked;v_failed:=v_failed+v_scope_failed;$r$;
 source:=replace(source,needle,replacement);

 needle:=$n$          AND (q.period_start,q.period_end)=(SELECT r.period_start,r.period_end FROM public.union_accounting_runs r
            WHERE r.scope_kind=v_scope.kind AND r.scope_id=v_scope.id ORDER BY r.period_start DESC,r.period_end DESC LIMIT 1);
      END LOOP;$n$;
 IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN
  RAISE EXCEPTION 'scheduler_visit_stamp_changed' USING ERRCODE='55000'; END IF;
 replacement:=$r$          AND (q.period_start,q.period_end)=(SELECT r.period_start,r.period_end FROM public.union_accounting_runs r
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
      END LOOP;$r$;
 source:=replace(source,needle,replacement);

 EXECUTE source;
END $patch$;
REVOKE ALL ON FUNCTION public.fn_process_weekly_accounting_scope(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;

DO $post$
BEGIN
  IF md5(pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure))
     IS DISTINCT FROM 'fe62d1a4a7ecb63873b826426be031ff' THEN
    RAISE EXCEPTION 'postimage mismatch: fn_process_weekly_accounting_scope';
  END IF;
  IF (SELECT p.proacl::text FROM pg_proc p WHERE p.oid='public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure)
       IS DISTINCT FROM '{postgres=X/postgres}' THEN
    RAISE EXCEPTION 'postimage: coordinator acl changed';
  END IF;
  IF has_table_privilege('service_role','public.weekly_accounting_scheduler_visits','INSERT')
     OR has_table_privilege('authenticated','public.weekly_accounting_scheduler_visits','SELECT')
     OR has_table_privilege('anon','public.weekly_accounting_scheduler_visits','SELECT') THEN
    RAISE EXCEPTION 'postimage: scheduler visits are writable or browser-readable';
  END IF;
END $post$;

COMMIT;
