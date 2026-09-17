-- Forward-only scheduler change after the shared coordinator and legacy-door
-- cutover. Financial stage bodies, rates, facts and completion witnesses stay
-- in the same private function; all-scope work delegates exact scopes to it.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$
DECLARE definition text;quality_anchor text:=
$quality$      IF v_complete AND v_orphans=0 AND v_previous->>'success'='true' AND v_previous->>'accounting_version'='3'
        AND public.fn_union_pnl_close_quality(v_union.id,v_from,v_end)->>'status'='ready' THEN$quality$;
BEGIN
 SELECT pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure) INTO definition;
 -- The preceding PNL component adds exactly this required predicate to J.
 -- Reverse only that unique addition when comparing the measured J preimage;
 -- retain the predicate in the actual definition patched below.
 IF position(quality_anchor IN definition)=0
  OR md5(replace(definition,quality_anchor,
   $original$      IF v_complete AND v_orphans=0 AND v_previous->>'success'='true' AND v_previous->>'accounting_version'='3' THEN$original$))
   IS DISTINCT FROM '63f8248cd6d804f450a0b8f0fbc05e77'
  OR md5(pg_get_functiondef('public.fn_process_weekly_accounting(uuid)'::regprocedure))
   IS DISTINCT FROM '5aec6700bf043463e9db2933ca63bca1'
  OR has_function_privilege('service_role','public.fn_process_weekly_accounting_scope(uuid,uuid)','EXECUTE')
  OR has_function_privilege('authenticated','public.fn_process_weekly_accounting_scope(uuid,uuid)','EXECUTE')
  OR has_function_privilege('anon','public.fn_process_weekly_accounting_scope(uuid,uuid)','EXECUTE')
  OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.union_accounting_runs'::regclass
   AND attname='last_scheduler_visit_at' AND NOT attisdropped) THEN
  RAISE EXCEPTION 'weekly scheduler fairness preimage changed';
 END IF;
END $guard$;
ALTER TABLE public.union_accounting_runs ADD COLUMN last_scheduler_visit_at timestamptz
 CHECK(last_scheduler_visit_at IS NULL OR isfinite(last_scheduler_visit_at));
COMMENT ON COLUMN public.union_accounting_runs.last_scheduler_visit_at IS 'Scheduler visit only; never an accounting attempt, successful close or financial completion timestamp.';

DO $patch$
DECLARE definition text;
BEGIN
 SELECT pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure) INTO definition;
 definition:=replace(definition,'  v_stage2 jsonb;',
$declarations$  v_attempt_budget integer := LEAST(8,COALESCE(NULLIF(current_setting('app.weekly_accounting_attempt_budget',true),'')::integer,8));
  v_scheduler_started timestamptz := LEAST(clock_timestamp(),COALESCE(NULLIF(current_setting('app.weekly_accounting_scheduler_started',true),'')::timestamptz,clock_timestamp()));
  v_scope record;v_scope_result jsonb;v_scope_checked integer;v_scope_failed integer;
  v_saved_budget text;v_saved_started text;v_more boolean:=false;v_visits integer:=0;
  v_stage2 jsonb;$declarations$);
 definition:=replace(definition,'v_checked>=8 OR clock_timestamp()-v_now>interval ''15 minutes''',
  'v_checked>=v_attempt_budget OR clock_timestamp()-v_scheduler_started>interval ''15 minutes''');
 -- No-floor unions normally begin at the just-closed week. A real older
 -- unresolved journal entry is known history and must be resolved first.
 -- Explicit clean floors still exclude earlier, uncertified history.
 definition:=replace(definition,'    v_from := v_first;',
$union_continuation$    SELECT LEAST(v_first,min(q.period_start)) INTO v_first
      FROM public.union_accounting_runs q WHERE q.union_id=v_union.id AND q.status<>'complete'
        AND (v_union.earliest_period_start IS NULL OR q.period_start>=v_first);
    v_from := v_first;$union_continuation$);
 -- If a standalone book had only a failed journal entry, completing its oldest
 -- week must not erase discovery of later due weeks after a bounded return.
 definition:=replace(definition,
$old_pending$         WHERE q.standalone_club_id IS NOT NULL AND q.status<>'complete'
        UNION ALL SELECT rp.club_id$old_pending$,
$new_pending$         WHERE q.standalone_club_id IS NOT NULL AND q.status<>'complete'
        UNION ALL SELECT q.standalone_club_id,q.period_start FROM public.union_accounting_runs q
         WHERE q.standalone_club_id IS NOT NULL AND q.status='complete' AND q.period_end<v_to
          AND NOT EXISTS(SELECT 1 FROM public.union_accounting_runs later
            WHERE later.standalone_club_id=q.standalone_club_id AND later.period_end>q.period_end)
        UNION ALL SELECT rp.club_id$new_pending$);
 -- A long completed history must also obey the shared deadline before reading
 -- the next week's completion witnesses. It does not consume an attempt.
 definition:=replace(definition,
  '      PERFORM pg_advisory_xact_lock(hashtextextended(''union-accounting:''||v_union.id',
$history_budget$      IF clock_timestamp()-v_scheduler_started>interval '15 minutes'
        OR extract(minute FROM clock_timestamp())>=45 OR public.fn_platform_frozen() THEN
        RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,
          'more_remaining',true,'detail',v_results);
      END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended('union-accounting:'||v_union.id$history_budget$);
 definition:=replace(definition,'  FOR v_union IN SELECT u.id, f.earliest_period_start',
$dispatch$  IF v_attempt_budget<1 OR NOT isfinite(v_scheduler_started) THEN
    RAISE EXCEPTION 'invalid_weekly_scheduler_budget' USING ERRCODE='22023';END IF;
  IF p_union_id IS NULL AND p_club_id IS NULL THEN
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
            WHERE q.union_id=u.id AND q.status<>'complete'
              AND (u.earliest_period_start IS NULL OR q.period_start>=u.first_week))) AS first_week
           FROM union_floors u
        ), eligible AS (
          -- Match the exact-scope floor rounding and per-week due check. An
          -- older union backlog remains due before this Monday's new close.
          SELECT 'union'::text AS kind,w.id FROM union_work w WHERE w.first_week<v_to
           AND v_now>=public.fn_union_accounting_run_at(public.fn_union_week_start(w.first_week+interval '8 days'))
          UNION ALL SELECT 'club',w.club_id FROM standalone_work w JOIN public.clubs c ON c.id=w.club_id
           WHERE c.is_union IS NOT TRUE AND w.first_week<v_to
            AND v_now>=public.fn_union_accounting_run_at(v_to) GROUP BY w.club_id
        ) SELECT e.kind,e.id,max(GREATEST(q.last_scheduler_visit_at,q.started_at)) AS last_visit
          FROM eligible e LEFT JOIN public.union_accounting_runs q ON q.scope_kind=e.kind AND q.scope_id=e.id
          GROUP BY e.kind,e.id
          ORDER BY last_visit NULLS FIRST,(e.kind='union') DESC,e.id
      LOOP
        IF v_checked>=v_attempt_budget OR clock_timestamp()-v_scheduler_started>interval '15 minutes'
          OR extract(minute FROM clock_timestamp())>=45 OR public.fn_platform_frozen() THEN
          v_more:=true;EXIT;END IF;
        -- Transaction advisory locks are reentrant. The exact child call uses
        -- this same scheduler lock and only the remaining TOTAL attempt budget.
        PERFORM set_config('app.weekly_accounting_attempt_budget',(v_attempt_budget-v_checked)::text,true);
        PERFORM set_config('app.weekly_accounting_scheduler_started',v_scheduler_started::text,true);
        v_scope_result:=public.fn_process_weekly_accounting_scope(
          CASE WHEN v_scope.kind='union' THEN v_scope.id END,
          CASE WHEN v_scope.kind='club' THEN v_scope.id END);
        IF v_scope_result->>'skipped'='true' AND v_scope_result->>'reason'='maintenance_window' THEN
          v_more:=true;EXIT;END IF;
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
          OR (SELECT count(*) FROM jsonb_array_elements(v_scope_result->'detail')d WHERE d->'result'->'success' IS DISTINCT FROM 'true'::jsonb)<>v_scope_failed
          OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_scope_result->'detail')d
            WHERE CASE WHEN v_scope.kind='union' THEN d->>'union_id' ELSE d->>'club_id' END IS DISTINCT FROM v_scope.id::text) THEN
          RAISE EXCEPTION 'weekly_scope_scheduler_receipt_invalid' USING ERRCODE='23514';END IF;
        v_checked:=v_checked+v_scope_checked;v_failed:=v_failed+v_scope_failed;
        v_results:=v_results||(v_scope_result->'detail');v_visits:=v_visits+1;
        v_more:=v_more OR COALESCE((v_scope_result->>'more_remaining')::boolean,false);
        -- Completed/zero-work scopes must move to the back too. Reuse one real
        -- run row; never change attempts, result, started_at or finished_at.
        UPDATE public.union_accounting_runs q SET last_scheduler_visit_at=clock_timestamp()
         WHERE q.scope_kind=v_scope.kind AND q.scope_id=v_scope.id
          AND (q.period_start,q.period_end)=(SELECT r.period_start,r.period_end FROM public.union_accounting_runs r
            WHERE r.scope_kind=v_scope.kind AND r.scope_id=v_scope.id ORDER BY r.period_start DESC,r.period_end DESC LIMIT 1);
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

  FOR v_union IN SELECT u.id, f.earliest_period_start$dispatch$);
 IF definition NOT LIKE '%v_attempt_budget integer%' OR definition NOT LIKE '%visited_scopes%'
  OR definition NOT LIKE '%AND public.fn_union_pnl_close_quality(v_union.id,v_from,v_end)->>''status''=''ready'' THEN%'
  OR definition NOT LIKE '%SELECT LEAST(v_first,min(q.period_start)) INTO v_first%'
  OR position($pending_anchor$         WHERE q.standalone_club_id IS NOT NULL AND q.status<>'complete'
        UNION ALL SELECT rp.club_id$pending_anchor$ IN definition)>0
  OR definition LIKE '%v_checked>=8%' THEN RAISE EXCEPTION 'weekly scheduler patch did not match';END IF;
 EXECUTE definition;
END $patch$;
REVOKE ALL ON FUNCTION public.fn_process_weekly_accounting_scope(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
UPDATE public.ca_money_rpc_registry SET notes='Single private weekly accounting implementation. All-scope scheduler rotates union and standalone books by last visit/attempt, delegates exact scope with one shared eight-attempt and fifteen-minute budget; visits never fabricate financial completion.'
 WHERE proname='fn_process_weekly_accounting_scope';
COMMIT;
