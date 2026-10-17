-- AN IN-PROGRESS CLOSE IS VISITED WITHOUT THE WHOLE SCAN.
-- Job 272 ran its full scope-eligibility scan (every standalone cash and tournament
-- earning source) before every visit: 9.6 s warm, more than 95 s cold on 2026-10-17
-- (1.14M fee-source key reads), so the in-progress Midway Oct 5-12 close never got
-- its 180 s attempt and every tick hit the 240 s statement limit.
-- When no club book is in progress, every in-progress row of that scan is a union
-- row whose eligibility reads only unions, floors and runs. Those rows are the exact
-- in-progress prefix of the same ordering, and an in-progress visit ends the tick, so
-- the full scan is gated by a one-time filter and not read. Otherwise unchanged.
-- No money, certificate, partial, period, budget, memo, ACL, trigger or sealed source changes.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure))='6bd020f058339c34e51a88717cf4fbd6' AND smarter_private.original_inventory_proof_sources_match() IS TRUE)
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DO $in_progress_tick$
DECLARE def text;sig regprocedure;generation text;
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.role',true),'') IS NOT NULL THEN RAISE EXCEPTION 'in_progress_tick_operator_refused';END IF;
 IF NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL OR public.fn_platform_frozen() IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN RAISE EXCEPTION 'in_progress_tick_freeze_or_override_refused';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN RAISE EXCEPTION 'in_progress_tick_scheduler_owned';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261017121500') THEN RAISE EXCEPTION 'in_progress_tick_history_replay';END IF;
 generation:=smarter_private.original_inventory_basis_generation();
 IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true OR generation IS NULL THEN RAISE EXCEPTION 'in_progress_tick_inventory_seal_required';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_process_weekly_accounting_scope(uuid,uuid)') AND md5(pg_get_functiondef(p.oid))='f4a350ab6f0fb0dfe627fd81cb506147' AND md5(p.prosrc)='2f3f5b5522256a37e774593bcea3d452' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.provolatile='v' AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=public']) THEN RAISE EXCEPTION 'in_progress_tick_preimage_authority_refused';END IF;
 sig:='public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure;def:=pg_get_functiondef(sig);
 IF (length(def)-length(replace(def,$old_0$        ) SELECT e.kind,e.id,GREATEST(max(GREATEST(q.last_scheduler_visit_at,q.started_at)),max(v.last_visit_at)) AS last_visit,
            COALESCE(bool_or(v.last_outcome IN ('error','statement_timeout')),false) AS last_unfinished,
            -- AN IN-PROGRESS CLOSE OWNS ITS TICK (20261016000241): a book with a
            -- committed step and more to do goes first, unless its own last
            -- visit had that place and still did not finish.
            COALESCE(bool_or(q.status='running' AND q.result->>'chunk_committed'='true' AND q.period_end<=v_now),false)
             AND NOT COALESCE(bool_or(v.last_outcome IN ('error','statement_timeout') AND v.last_error->>'in_progress_visit'='true'),false) AS in_progress
          FROM eligible e LEFT JOIN public.union_accounting_runs q ON q.scope_kind=e.kind AND q.scope_id=e.id
          LEFT JOIN public.weekly_accounting_scheduler_visits v ON v.scope_kind=e.kind AND v.scope_id=e.id
          GROUP BY e.kind,e.id
          -- A scope whose last visit did not finish goes after every scope
          -- whose visit finished: it can never hold the others back.
          ORDER BY in_progress DESC,last_unfinished,last_visit NULLS FIRST,(e.kind='union') DESC,e.id$old_0$,'')))/length($old_0$        ) SELECT e.kind,e.id,GREATEST(max(GREATEST(q.last_scheduler_visit_at,q.started_at)),max(v.last_visit_at)) AS last_visit,
            COALESCE(bool_or(v.last_outcome IN ('error','statement_timeout')),false) AS last_unfinished,
            -- AN IN-PROGRESS CLOSE OWNS ITS TICK (20261016000241): a book with a
            -- committed step and more to do goes first, unless its own last
            -- visit had that place and still did not finish.
            COALESCE(bool_or(q.status='running' AND q.result->>'chunk_committed'='true' AND q.period_end<=v_now),false)
             AND NOT COALESCE(bool_or(v.last_outcome IN ('error','statement_timeout') AND v.last_error->>'in_progress_visit'='true'),false) AS in_progress
          FROM eligible e LEFT JOIN public.union_accounting_runs q ON q.scope_kind=e.kind AND q.scope_id=e.id
          LEFT JOIN public.weekly_accounting_scheduler_visits v ON v.scope_kind=e.kind AND v.scope_id=e.id
          GROUP BY e.kind,e.id
          -- A scope whose last visit did not finish goes after every scope
          -- whose visit finished: it can never hold the others back.
          ORDER BY in_progress DESC,last_unfinished,last_visit NULLS FIRST,(e.kind='union') DESC,e.id$old_0$)<>1 THEN RAISE EXCEPTION 'in_progress_tick_exact_replacement_refused';END IF;
 def:=replace(def,$old_0$        ) SELECT e.kind,e.id,GREATEST(max(GREATEST(q.last_scheduler_visit_at,q.started_at)),max(v.last_visit_at)) AS last_visit,
            COALESCE(bool_or(v.last_outcome IN ('error','statement_timeout')),false) AS last_unfinished,
            -- AN IN-PROGRESS CLOSE OWNS ITS TICK (20261016000241): a book with a
            -- committed step and more to do goes first, unless its own last
            -- visit had that place and still did not finish.
            COALESCE(bool_or(q.status='running' AND q.result->>'chunk_committed'='true' AND q.period_end<=v_now),false)
             AND NOT COALESCE(bool_or(v.last_outcome IN ('error','statement_timeout') AND v.last_error->>'in_progress_visit'='true'),false) AS in_progress
          FROM eligible e LEFT JOIN public.union_accounting_runs q ON q.scope_kind=e.kind AND q.scope_id=e.id
          LEFT JOIN public.weekly_accounting_scheduler_visits v ON v.scope_kind=e.kind AND v.scope_id=e.id
          GROUP BY e.kind,e.id
          -- A scope whose last visit did not finish goes after every scope
          -- whose visit finished: it can never hold the others back.
          ORDER BY in_progress DESC,last_unfinished,last_visit NULLS FIRST,(e.kind='union') DESC,e.id$old_0$,$new_0$        ), eligible_unions AS (
          -- AN IN-PROGRESS CLOSE IS VISITED WITHOUT THE WHOLE SCAN (20261017121500):
          -- exactly the union rows of eligible. When no club book is in progress,
          -- every in-progress row of eligible is one of these, so the rows below
          -- are the exact in-progress prefix of the full ordering, and the tick
          -- ends with the first one's visit; the full scan is then not read.
          SELECT 'union'::text AS kind,w.id FROM union_work w WHERE w.first_week<v_to
           AND v_now>=public.fn_union_accounting_run_at(public.fn_union_week_start(w.first_week+interval '8 days'))
        ), owned_tick AS MATERIALIZED (
          SELECT e.kind,e.id,GREATEST(max(GREATEST(q.last_scheduler_visit_at,q.started_at)),max(v.last_visit_at)) AS last_visit,
            COALESCE(bool_or(v.last_outcome IN ('error','statement_timeout')),false) AS last_unfinished,
            -- AN IN-PROGRESS CLOSE OWNS ITS TICK (20261016000241): a book with a
            -- committed step and more to do goes first, unless its own last
            -- visit had that place and still did not finish.
            COALESCE(bool_or(q.status='running' AND q.result->>'chunk_committed'='true' AND q.period_end<=v_now),false)
             AND NOT COALESCE(bool_or(v.last_outcome IN ('error','statement_timeout') AND v.last_error->>'in_progress_visit'='true'),false) AS in_progress
          FROM eligible_unions e LEFT JOIN public.union_accounting_runs q ON q.scope_kind=e.kind AND q.scope_id=e.id
          LEFT JOIN public.weekly_accounting_scheduler_visits v ON v.scope_kind=e.kind AND v.scope_id=e.id
          GROUP BY e.kind,e.id
        ), tick_owner AS MATERIALIZED (
          SELECT NOT EXISTS(SELECT 1 FROM public.union_accounting_runs q WHERE q.scope_kind='club' AND q.status='running'
              AND q.result->>'chunk_committed'='true' AND q.period_end<=v_now)
            AND EXISTS(SELECT 1 FROM owned_tick o WHERE o.in_progress) AS owned
        ) SELECT z.kind,z.id,z.last_visit,z.last_unfinished,z.in_progress FROM (
          SELECT o.kind,o.id,o.last_visit,o.last_unfinished,o.in_progress FROM owned_tick o
           WHERE o.in_progress AND (SELECT t.owned FROM tick_owner t)
          UNION ALL
          SELECT e.kind,e.id,GREATEST(max(GREATEST(q.last_scheduler_visit_at,q.started_at)),max(v.last_visit_at)) AS last_visit,
            COALESCE(bool_or(v.last_outcome IN ('error','statement_timeout')),false) AS last_unfinished,
            -- AN IN-PROGRESS CLOSE OWNS ITS TICK (20261016000241): a book with a
            -- committed step and more to do goes first, unless its own last
            -- visit had that place and still did not finish.
            COALESCE(bool_or(q.status='running' AND q.result->>'chunk_committed'='true' AND q.period_end<=v_now),false)
             AND NOT COALESCE(bool_or(v.last_outcome IN ('error','statement_timeout') AND v.last_error->>'in_progress_visit'='true'),false) AS in_progress
          FROM eligible e LEFT JOIN public.union_accounting_runs q ON q.scope_kind=e.kind AND q.scope_id=e.id
          LEFT JOIN public.weekly_accounting_scheduler_visits v ON v.scope_kind=e.kind AND v.scope_id=e.id
          WHERE NOT (SELECT t.owned FROM tick_owner t)
          GROUP BY e.kind,e.id
        ) z
          -- A scope whose last visit did not finish goes after every scope
          -- whose visit finished: it can never hold the others back.
          ORDER BY z.in_progress DESC,z.last_unfinished,z.last_visit NULLS FIRST,(z.kind='union') DESC,z.id$new_0$);
 IF md5(def)<>'6bd020f058339c34e51a88717cf4fbd6' THEN RAISE EXCEPTION 'in_progress_tick_postimage_refused';END IF;
 EXECUTE def;
 IF NOT EXISTS(SELECT FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_process_weekly_accounting_scope(uuid,uuid)') AND md5(pg_get_functiondef(p.oid))='6bd020f058339c34e51a88717cf4fbd6' AND md5(p.prosrc)='e8a3de1a65a7b3dca17c36cb42a2aab0' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.provolatile='v' AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=public']) THEN RAISE EXCEPTION 'in_progress_tick_installed_authority_refused';END IF;
 IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true OR smarter_private.original_inventory_basis_generation() IS DISTINCT FROM generation THEN RAISE EXCEPTION 'in_progress_tick_inventory_seal_changed';END IF;
END $in_progress_tick$;
COMMIT;
