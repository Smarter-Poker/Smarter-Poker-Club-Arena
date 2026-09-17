-- SOURCE-ONLY SUCCESSOR PROPOSAL. UNRUN. Not part of the sealed fcdb package.
-- One implementation, no new journal or payer. Only no-floor union discovery
-- changes. Existing source quality, PNL, due times, payments and ACLs remain.
BEGIN;

DO $successor$
DECLARE
 definition text;
 reconstructed text;
 replacement text;
 change record;
 exact_old text:=$exact_old$    SELECT LEAST(v_first,min(q.period_start)) INTO v_first
      FROM public.union_accounting_runs q WHERE q.union_id=v_union.id AND q.status<>'complete'
        AND (v_union.earliest_period_start IS NULL OR q.period_start>=v_first);$exact_old$;
 exact_new text:=$exact_new$    SELECT LEAST(v_first,min(q.period_start)) INTO v_first
      FROM public.union_accounting_runs q WHERE q.union_id=v_union.id
        AND (q.status<>'complete' OR (v_union.earliest_period_start IS NULL
          AND q.status='complete' AND q.result->>'success'='true' AND q.result->>'accounting_version'='3'))
        AND (v_union.earliest_period_start IS NULL OR q.period_start>=v_first);$exact_new$;
 dispatch_old text:=$dispatch_old$          SELECT u.id,LEAST(u.first_week,(SELECT min(q.period_start) FROM public.union_accounting_runs q
            WHERE q.union_id=u.id AND q.status<>'complete'
              AND (u.earliest_period_start IS NULL OR q.period_start>=u.first_week))) AS first_week$dispatch_old$;
 dispatch_new text:=$dispatch_new$          SELECT u.id,LEAST(u.first_week,(SELECT min(q.period_start) FROM public.union_accounting_runs q
            WHERE q.union_id=u.id
              AND (q.status<>'complete' OR (u.earliest_period_start IS NULL
                AND q.status='complete' AND q.result->>'success'='true' AND q.result->>'accounting_version'='3'))
              AND (u.earliest_period_start IS NULL OR q.period_start>=u.first_week))) AS first_week$dispatch_new$;
BEGIN
 SELECT pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure)
 INTO definition;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure
   AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proconfig=ARRAY['search_path=public']::text[])
  OR md5(pg_get_functiondef('public.fn_process_weekly_accounting(uuid)'::regprocedure)) IS DISTINCT FROM '5aec6700bf043463e9db2933ca63bca1'
  OR EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role'])r
    WHERE has_function_privilege(r,'public.fn_process_weekly_accounting_scope(uuid,uuid)','EXECUTE'))
  OR (SELECT count(*) FROM public.ca_money_rpc_registry WHERE proname='fn_process_weekly_accounting_scope' AND status='approved')<>1
  OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.union_accounting_runs'::regclass
    AND attname='last_scheduler_visit_at' AND atttypid='timestamptz'::regtype AND NOT attisdropped) THEN
  RAISE EXCEPTION 'union_continuation_authority_preimage_changed';
 END IF;

 -- No unmeasured final-function hash is invented. Reverse EVERY exact final
 -- fairness transform and the preceding PNL predicate, requiring exact chunk
 -- multiplicities, then compare with the previously measured J definition.
 -- Removed bytes are themselves literal preimages below; arbitrary inserted
 -- dispatch code cannot disappear from the hash check unnoticed.
 reconstructed:=definition;
 FOR change IN SELECT * FROM (VALUES
 ($fair_dispatch$  IF v_attempt_budget<1 OR NOT isfinite(v_scheduler_started) THEN
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

  FOR v_union IN SELECT u.id, f.earliest_period_start$fair_dispatch$,
 $original_dispatch$  FOR v_union IN SELECT u.id, f.earliest_period_start$original_dispatch$,1,1),
 ($fair_history$      IF clock_timestamp()-v_scheduler_started>interval '15 minutes'
        OR extract(minute FROM clock_timestamp())>=45 OR public.fn_platform_frozen() THEN
        RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,
          'more_remaining',true,'detail',v_results);
      END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended('union-accounting:'||v_union.id$fair_history$,
 $original_history$      PERFORM pg_advisory_xact_lock(hashtextextended('union-accounting:'||v_union.id$original_history$,1,2),
 ($fair_union$    SELECT LEAST(v_first,min(q.period_start)) INTO v_first
      FROM public.union_accounting_runs q WHERE q.union_id=v_union.id AND q.status<>'complete'
        AND (v_union.earliest_period_start IS NULL OR q.period_start>=v_first);
    v_from := v_first;$fair_union$,$original_union$    v_from := v_first;$original_union$,1,3),
 ($fair_club$         WHERE q.standalone_club_id IS NOT NULL AND q.status<>'complete'
        UNION ALL SELECT q.standalone_club_id,q.period_start FROM public.union_accounting_runs q
         WHERE q.standalone_club_id IS NOT NULL AND q.status='complete' AND q.period_end<v_to
          AND NOT EXISTS(SELECT 1 FROM public.union_accounting_runs later
            WHERE later.standalone_club_id=q.standalone_club_id AND later.period_end>q.period_end)
        UNION ALL SELECT rp.club_id$fair_club$,
 $original_club$         WHERE q.standalone_club_id IS NOT NULL AND q.status<>'complete'
        UNION ALL SELECT rp.club_id$original_club$,1,4),
 ($fair_declarations$  v_attempt_budget integer := LEAST(8,COALESCE(NULLIF(current_setting('app.weekly_accounting_attempt_budget',true),'')::integer,8));
  v_scheduler_started timestamptz := LEAST(clock_timestamp(),COALESCE(NULLIF(current_setting('app.weekly_accounting_scheduler_started',true),'')::timestamptz,clock_timestamp()));
  v_scope record;v_scope_result jsonb;v_scope_checked integer;v_scope_failed integer;
  v_saved_budget text;v_saved_started text;v_more boolean:=false;v_visits integer:=0;
  v_stage2 jsonb;$fair_declarations$,$original_declarations$  v_stage2 jsonb;$original_declarations$,1,5),
 ($fair_budget$v_checked>=v_attempt_budget OR clock_timestamp()-v_scheduler_started>interval '15 minutes'$fair_budget$,
 $original_budget$v_checked>=8 OR clock_timestamp()-v_now>interval '15 minutes'$original_budget$,2,6),
 ($pnl_skip$      IF v_complete AND v_orphans=0 AND v_previous->>'success'='true' AND v_previous->>'accounting_version'='3'
        AND public.fn_union_pnl_close_quality(v_union.id,v_from,v_end)->>'status'='ready' THEN$pnl_skip$,
 $original_skip$      IF v_complete AND v_orphans=0 AND v_previous->>'success'='true' AND v_previous->>'accounting_version'='3' THEN$original_skip$,1,7)
 ) AS reversals(installed_text,previous_text,occurrences,ordinal) ORDER BY ordinal
 LOOP
  IF length(reconstructed)-length(replace(reconstructed,change.installed_text,''))
    <> length(change.installed_text)*change.occurrences THEN
   RAISE EXCEPTION 'union_continuation_function_preimage_changed';
  END IF;
  reconstructed:=replace(reconstructed,change.installed_text,change.previous_text);
 END LOOP;
 IF md5(reconstructed) IS DISTINCT FROM '63f8248cd6d804f450a0b8f0fbc05e77' THEN
  RAISE EXCEPTION 'union_continuation_function_preimage_changed';END IF;
 IF length(definition)-length(replace(definition,exact_old,''))<>length(exact_old)
  OR length(definition)-length(replace(definition,dispatch_old,''))<>length(dispatch_old) THEN
  RAISE EXCEPTION 'union_continuation_patch_anchor_changed';END IF;
 replacement:=replace(replace(definition,exact_old,exact_new),dispatch_old,dispatch_new);
 IF replace(replace(replacement,exact_new,exact_old),dispatch_new,dispatch_old) IS DISTINCT FROM definition THEN
  RAISE EXCEPTION 'union_continuation_patch_not_reversible';END IF;
 EXECUTE replacement;
END $successor$;

REVOKE ALL ON FUNCTION public.fn_process_weekly_accounting_scope(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
