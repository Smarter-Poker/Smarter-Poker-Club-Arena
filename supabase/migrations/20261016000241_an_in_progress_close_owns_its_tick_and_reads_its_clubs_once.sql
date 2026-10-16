-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure)) IN ('faa32923eae3b055b18e85d5f3df356d','a0ffe85a2f16c82af0221de03202fa26') AND md5(pg_get_functiondef('public.fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz)'::regprocedure))='7d216ca8b05a7c4b5b47133d6bd95ed1')
-- 20261016000241_an_in_progress_close_owns_its_tick_and_reads_its_clubs_once.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- Installs after 20261015182133 (a proving week advances on its own tick,
-- PR #6995): its postimage of fn_process_weekly_accounting_scope is this
-- file's preimage. 20261015234926 (a completed week reads its earning clubs
-- once, PR #7040) pins that same preimage and edits disjoint lines, so it
-- installs BEFORE this file: this file accepts either #6995's text or #7040's
-- postimage of it (e4c2252d...), and refuses anything else.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- The Midway Union close of 2026-10-05 -> 2026-10-12 (union fade0000,
-- union_accounting_runs status 'running', stage 'prepared', committed_round 0)
-- proved its 84 round 2 windows by 23:12:54 UTC on 2026-10-15 and its 84
-- round 3 windows and round 3 plan by 23:28:36. Every job 272 tick since
-- (23:15, 23:20, 23:30, 23:35, ...) cancelled the union's visit with
-- weekly_scope_statement_budget_exhausted (57014), so no round has been paid.
--
-- Measured read-only on production between 23:30 and 00:05 UTC:
--
-- 1. The certified P&L boundaries ARE reused. Inside an attempt context
--    (app.weekly_accounting_chunked and app.accounting_close_memo on), both
--    pnl_boundary certificates, pnl_flows, pnl_touched and pnl_clubs are read
--    from accounting_close_certificates under generation
--    original-inventory-245-v1:96ac03a8... in under 2.1 s together, and
--    fn_union_pnl_boundary is never called. The 102.7 s boundary and the
--    170 s close quality measured earlier were direct calls outside an
--    attempt, where fn_accounting_close_certificate deliberately answers
--    NULL. fn_union_pnl_evidence_report is not changed here: its definition
--    is hashed into the certificates' generation, so editing it would void
--    every certificate this week has.
-- 2. fn_accounting_week_clubs(union, week) takes 21 s warm and 84.6 s cold
--    for this week (2,042,292 cash sources, 522,518 tournament fee sources)
--    and returns 2 clubs. It materialises every accepted earning (about 2.5
--    million rows) to UNION them down to their clubs, and one paying attempt
--    calls it from preparation, the scheduler's accrual check, the cascade
--    (3 calls) and the conservation assertion (3 calls).
-- 3. The union's visit runs last in its tick. The 23:30 tick finished the
--    standalone club 2a1132b9 (a book complete since 2026-10-12) at 23:33:16,
--    196 s into the 240 s statement; the 23:35 tick at 23:37:05, 125 s in.
--    A scope whose last visit did not finish is ordered after every scope
--    whose visit finished, so once the union was cancelled for want of time
--    it was put behind the club for good and was cancelled every tick.
--
-- The fixes, at those lines:
--
-- A. fn_accounting_week_clubs reads a union's earning clubs per club: the
--    week's cash sources grouped per club (latest earned_at), and each club
--    with tournament fee sources in this union accepted by one indexed
--    existence test of its own recognized rows in the week, carrying the
--    per-row tests unchanged; each club's launch cutoff is asked once as
--    before. A club is accepted exactly when the old per-row test accepted
--    one of its rows. Measured on production at 00:58 UTC: 15.6 s against
--    23.9 s for the old read run right after it, the same 2 clubs; the
--    existence test costs 1.3 s for a club with no row and milliseconds for
--    a club with one. Inside one union close attempt,
--    while this transaction holds the exclusive week lock that every source
--    writer (fn_accrue_cash_hand_commissions,
--    fn_lock_accounting_tournament_recognition_week,
--    fn_lock_cash_bank_accounting_week) must share, the answer is kept for
--    the rest of that attempt (key: union, week and the attempt's own
--    deadline); no source of that week can be written while the lock is
--    held, so a second read could only return the same clubs. Without the
--    lock, outside an attempt, or in the next attempt, it is read again.
-- B. fn_process_weekly_accounting_scope: a book with a committed step and
--    more to do (status 'running', chunk_committed) is visited first in its
--    tick, and the tick ends after it, as a calculating week (20261015173123)
--    and a proving week (20261015182133) already own theirs. If such a visit
--    is itself cancelled or raises, its visit record says so
--    ('in_progress_visit': true) and the book gives its place back for one
--    tick (the existing rule: an unfinished scope goes last), so it can never
--    hold the other scopes back for more than every other tick.
--
-- Nothing else moves: no money, receipt, certificate, window or round is
-- written here, and no accounting check is skipped or weakened; the rounds,
-- preparation and certificates prove exactly what they proved before.
--
-- Regression: scripts/ci/test-in-progress-close-owns-its-tick.py (native
-- PostgreSQL), run by .github/workflows/in-progress-close-owns-its-tick.yml.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
SET LOCAL search_path=public;
DO $guard$BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.role',true),'') IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.sub',true),'') IS NOT NULL THEN RAISE EXCEPTION 'in_progress_close_operator_refused' USING ERRCODE='42501';END IF;
 IF NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL THEN RAISE EXCEPTION 'in_progress_close_override_refused';END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN RAISE EXCEPTION 'in_progress_close_freeze_refused';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN RAISE EXCEPTION 'in_progress_close_reader_owned';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261016000241') THEN RAISE EXCEPTION 'in_progress_close_history_replay';END IF;
 IF NOT EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261015182133') THEN RAISE EXCEPTION 'in_progress_close_requires_window_advance';END IF;
 IF to_regprocedure('public.fn_accounting_window_advance_due()') IS NULL THEN RAISE EXCEPTION 'in_progress_close_window_advance_missing';END IF;
END $guard$;

DO $install$
DECLARE
 sig constant regprocedure:='public.fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz)'::regprocedure;
 def text:=pg_get_functiondef(sig);
 o1 text:=$anchor$AS $function$
BEGIN
 IF NOT public.fn_caller_is_engine() THEN$anchor$;
 n1 text:=$anchor$AS $function$
DECLARE v_key text; v_lock bigint; v_held boolean; v_clubs uuid[];
BEGIN
 IF NOT public.fn_caller_is_engine() THEN$anchor$;
 o2 text:=$anchor$  RETURN QUERY WITH cash_candidates AS MATERIALIZED (
 SELECT s.id,s.club_id,s.earned_at FROM public.accounting_cash_rake_sources s
 WHERE s.coordinator_union_id=p_union_id AND s.earned_at>=p_from AND s.earned_at<p_to
), tournament_candidates AS MATERIALIZED (
 SELECT s.id,s.club_id,s.charged_at,s.union_id,s.rake_credit,rs.recognized_at,rs.disposition,rs.rake_credit AS recognized_rake_credit,
 r.status AS recognition_status,r.recognized_at AS recognition_at,r.union_id AS recognition_union_id
 FROM public.accounting_tournament_fee_sources s
 JOIN public.accounting_tournament_recognized_sources rs ON rs.source_id=s.id AND rs.tournament_id=s.tournament_id
 JOIN public.accounting_tournament_fee_recognitions r ON r.tournament_id=s.tournament_id
 WHERE s.coordinator_union_id=p_union_id AND rs.recognized_at>=p_from AND rs.recognized_at<p_to
), earning_clubs AS MATERIALIZED (
 SELECT e.club_id FROM (SELECT c.club_id FROM cash_candidates c UNION ALL SELECT t.club_id FROM tournament_candidates t)e GROUP BY e.club_id
), earning_cutoffs AS MATERIALIZED (
 SELECT c.club_id,public.fn_ca_launch_accounting_cutoff('club',c.club_id) AS cutoff FROM earning_clubs c
), accepted_earnings AS (
 SELECT 'cash_rake_accrual'::text AS source_type,s.id AS source_id,s.club_id FROM cash_candidates s
 LEFT JOIN earning_cutoffs b ON b.club_id=s.club_id
 WHERE CASE WHEN b.cutoff IS NULL THEN true ELSE s.earned_at IS NOT NULL AND isfinite(s.earned_at) AND s.earned_at>=b.cutoff END
 UNION ALL
 SELECT 'tournament_fee_accrual'::text AS source_type,s.id AS source_id,s.club_id FROM tournament_candidates s
 LEFT JOIN earning_cutoffs b ON b.club_id=s.club_id
 WHERE CASE WHEN b.cutoff IS NULL THEN true ELSE s.charged_at IS NOT NULL AND isfinite(s.charged_at) AND s.charged_at>=b.cutoff END
 AND CASE WHEN b.cutoff IS NULL THEN true ELSE s.recognized_at IS NOT NULL AND isfinite(s.recognized_at) AND s.recognized_at>=b.cutoff END
 AND s.disposition='earned' AND s.recognition_status='recognized'
 AND s.recognized_rake_credit=s.rake_credit AND s.recognized_at=s.recognition_at
 AND NOT s.union_id IS DISTINCT FROM s.recognition_union_id
), initial AS ($anchor$;
 n2 text:=$anchor$  -- A WEEK'S CLUBS ARE READ ONCE PER CLOSE ATTEMPT (20261016000241). Inside
  -- one union close attempt (job 272's chunked tick, the attempt's memo and
  -- deadline set by fn_weekly_accounting_attempt_begin) and only while this
  -- transaction holds the week's exclusive close lock, which every writer of
  -- this week's cash and tournament sources must share, the answer is kept
  -- for the rest of that attempt: no source of the week can be written while
  -- the lock is held. Everywhere else the week is read on every call.
  v_key:=p_union_id::text||'|'||p_from::text||'|'||p_to::text||'|'||COALESCE(current_setting('app.weekly_accounting_scope_deadline',true),'');
  v_lock:=hashtextextended('union-accounting:'||p_union_id::text||':'||extract(epoch FROM p_from)::text||':'||extract(epoch FROM p_to)::text,0);
  v_held:=COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on'
   AND current_setting('app.accounting_close_memo',true)='on'
   AND NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'') IS NOT NULL
   AND EXISTS(SELECT 1 FROM pg_catalog.pg_locks l WHERE l.locktype='advisory' AND l.pid=pg_backend_pid() AND l.granted
    AND l.mode='ExclusiveLock' AND l.objsubid=1 AND l.database=(SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname=current_database())
    AND l.classid=((v_lock>>32)&4294967295)::oid AND l.objid=(v_lock&4294967295)::oid);
  IF v_held AND split_part(COALESCE(current_setting('app.accounting_week_clubs_memo',true),''),'=',1)=v_key THEN
   RETURN QUERY SELECT m.id::uuid FROM unnest(string_to_array(NULLIF(split_part(current_setting('app.accounting_week_clubs_memo',true),'=',2),''),',')) WITH ORDINALITY m(id,n) ORDER BY m.n;
   RETURN;
  END IF;
  -- PER CLUB (20261016000241): the week's cash sources are grouped per club,
  -- and a tournament club is accepted by one indexed existence test of its
  -- own rows, instead of materialising every accepted earning (2.5 million
  -- rows for the 2026-10-05 Midway week) to UNION them down to their clubs.
  -- The tests are the per-row tests, unchanged: with no launch cutoff, any
  -- cash row or any earned tournament row; with a cutoff, a cash row earned
  -- at or after it, or an earned tournament row both charged and recognized
  -- at or after it (finite instants only).
  SELECT COALESCE(array_agg(w.id ORDER BY w.id),ARRAY[]::uuid[]) INTO v_clubs FROM (WITH cash_clubs AS MATERIALIZED (
 SELECT s.club_id,max(s.earned_at) AS latest FROM public.accounting_cash_rake_sources s
 WHERE s.coordinator_union_id=p_union_id AND s.earned_at>=p_from AND s.earned_at<p_to GROUP BY s.club_id
), tournament_clubs AS MATERIALIZED (
 SELECT DISTINCT s.club_id FROM public.accounting_tournament_fee_sources s WHERE s.coordinator_union_id=p_union_id
), earning_clubs AS MATERIALIZED (
 SELECT e.club_id FROM (SELECT c.club_id FROM cash_clubs c UNION ALL SELECT t.club_id FROM tournament_clubs t)e GROUP BY e.club_id
), earning_cutoffs AS MATERIALIZED (
 SELECT c.club_id,public.fn_ca_launch_accounting_cutoff('club',c.club_id) AS cutoff FROM earning_clubs c
), accepted_earnings AS (
 SELECT c.club_id FROM cash_clubs c LEFT JOIN earning_cutoffs b ON b.club_id=c.club_id
 WHERE CASE WHEN b.cutoff IS NULL THEN true ELSE c.latest>=b.cutoff END
 UNION ALL
 SELECT t.club_id FROM tournament_clubs t LEFT JOIN earning_cutoffs b ON b.club_id=t.club_id
 WHERE EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources s
  JOIN public.accounting_tournament_recognized_sources rs ON rs.source_id=s.id AND rs.tournament_id=s.tournament_id
  JOIN public.accounting_tournament_fee_recognitions r ON r.tournament_id=s.tournament_id
  WHERE s.coordinator_union_id=p_union_id AND s.club_id=t.club_id AND rs.recognized_at>=p_from AND rs.recognized_at<p_to
   AND CASE WHEN b.cutoff IS NULL THEN true ELSE s.charged_at IS NOT NULL AND isfinite(s.charged_at) AND s.charged_at>=b.cutoff END
   AND CASE WHEN b.cutoff IS NULL THEN true ELSE rs.recognized_at IS NOT NULL AND isfinite(rs.recognized_at) AND rs.recognized_at>=b.cutoff END
   AND rs.disposition='earned' AND r.status='recognized'
   AND rs.rake_credit=s.rake_credit AND rs.recognized_at=r.recognized_at
   AND NOT s.union_id IS DISTINCT FROM r.union_id)
), initial AS ($anchor$;
 o3 text:=$anchor$  )x WHERE x.id IS NOT NULL AND x.id<>p_union_id ORDER BY x.id;
 END IF;$anchor$;
 n3 text:=$anchor$  )x WHERE x.id IS NOT NULL AND x.id<>p_union_id ORDER BY x.id) w;
  IF v_held THEN
   PERFORM set_config('app.accounting_week_clubs_memo',v_key||'='||array_to_string(v_clubs,','),true);
  END IF;
  RETURN QUERY SELECT m.id FROM unnest(v_clubs) WITH ORDINALITY m(id,n) ORDER BY m.n;
 END IF;$anchor$;
 before text; post text;
BEGIN
 IF md5(def)<>'47df4a9dfae6291b7b3f3d3c16470cfc' THEN RAISE EXCEPTION 'in_progress_close_week_clubs_preimage_refused';END IF;
 IF (length(def)-length(replace(def,o1,'')))/length(o1)<>1 OR (length(def)-length(replace(def,o2,'')))/length(o2)<>1
  OR (length(def)-length(replace(def,o3,'')))/length(o3)<>1 THEN RAISE EXCEPTION 'in_progress_close_week_clubs_anchor_refused';END IF;
 SELECT string_agg(concat_ws('|',p.proowner::regrole,p.prosecdef,p.provolatile,array_to_string(p.proconfig,','),array_to_string(p.proacl,',')),';') INTO before FROM pg_proc p WHERE p.oid=sig;
 post:=replace(replace(replace(def,o1,n1),o2,n2),o3,n3);
 EXECUTE post;
 IF md5(pg_get_functiondef(sig))<>'7d216ca8b05a7c4b5b47133d6bd95ed1' THEN RAISE EXCEPTION 'in_progress_close_week_clubs_postimage_refused';END IF;
 IF (SELECT string_agg(concat_ws('|',p.proowner::regrole,p.prosecdef,p.provolatile,array_to_string(p.proconfig,','),array_to_string(p.proacl,',')),';') FROM pg_proc p WHERE p.oid=sig) IS DISTINCT FROM before THEN RAISE EXCEPTION 'in_progress_close_week_clubs_security_refused';END IF;
END $install$;

DO $install$
DECLARE
 sig constant regprocedure:='public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure;
 def text:=pg_get_functiondef(sig);
 o1 text:=$anchor$            COALESCE(bool_or(v.last_outcome IN ('error','statement_timeout')),false) AS last_unfinished
          FROM eligible e LEFT JOIN public.union_accounting_runs q ON q.scope_kind=e.kind AND q.scope_id=e.id
          LEFT JOIN public.weekly_accounting_scheduler_visits v ON v.scope_kind=e.kind AND v.scope_id=e.id
          GROUP BY e.kind,e.id
          -- A scope whose last visit did not finish goes after every scope
          -- whose visit finished: it can never hold the others back.
          ORDER BY last_unfinished,last_visit NULLS FIRST,(e.kind='union') DESC,e.id
$anchor$;
 n1 text:=$anchor$            COALESCE(bool_or(v.last_outcome IN ('error','statement_timeout')),false) AS last_unfinished,
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
          ORDER BY in_progress DESC,last_unfinished,last_visit NULLS FIRST,(e.kind='union') DESC,e.id
$anchor$;
 o2 text:=$anchor$        END;
        IF v_scope_outcome='maintenance' THEN v_more:=true;EXIT;END IF;
$anchor$;
 n2 text:=$anchor$        END;
        -- An in-progress book whose own visit had the tick and did not finish
        -- gives its place back for one tick (20261016000241).
        IF v_scope_outcome IN ('error','statement_timeout') AND v_scope.in_progress THEN
          v_scope_error:=v_scope_error||jsonb_build_object('in_progress_visit',true);
        END IF;
        IF v_scope_outcome='maintenance' THEN v_more:=true;EXIT;END IF;
$anchor$;
 o3 text:=$anchor$        IF v_scope_outcome='statement_timeout' THEN v_more:=true;EXIT;END IF;
      END LOOP;
$anchor$;
 n3 text:=$anchor$        IF v_scope_outcome='statement_timeout' THEN v_more:=true;EXIT;END IF;
        -- The tick an in-progress book owned ends with its visit (20261016000241).
        IF v_scope.in_progress THEN v_more:=true;EXIT;END IF;
      END LOOP;
$anchor$;
 before text; post text;
BEGIN
 -- Either #6995's postimage, or that text after 20261015234926 (a completed
 -- week reads its earning clubs once, PR #7040), whose anchors are disjoint.
 IF md5(def) NOT IN ('009938740934b24744b35496477d02a1','e4c2252df2382259d164e1b11b00b82b') THEN RAISE EXCEPTION 'in_progress_close_scope_preimage_refused';END IF;
 IF (length(def)-length(replace(def,o1,'')))/length(o1)<>1 OR (length(def)-length(replace(def,o2,'')))/length(o2)<>1
  OR (length(def)-length(replace(def,o3,'')))/length(o3)<>1 THEN RAISE EXCEPTION 'in_progress_close_scope_anchor_refused';END IF;
 SELECT string_agg(concat_ws('|',p.proowner::regrole,p.prosecdef,p.provolatile,array_to_string(p.proconfig,','),array_to_string(p.proacl,',')),';') INTO before FROM pg_proc p WHERE p.oid=sig;
 post:=replace(replace(replace(def,o1,n1),o2,n2),o3,n3);
 EXECUTE post;
 IF md5(pg_get_functiondef(sig))<>(CASE md5(def) WHEN '009938740934b24744b35496477d02a1' THEN 'faa32923eae3b055b18e85d5f3df356d' ELSE 'a0ffe85a2f16c82af0221de03202fa26' END) THEN RAISE EXCEPTION 'in_progress_close_scope_postimage_refused';END IF;
 IF (SELECT string_agg(concat_ws('|',p.proowner::regrole,p.prosecdef,p.provolatile,array_to_string(p.proconfig,','),array_to_string(p.proacl,',')),';') FROM pg_proc p WHERE p.oid=sig) IS DISTINCT FROM before THEN RAISE EXCEPTION 'in_progress_close_scope_security_refused';END IF;
END $install$;

COMMIT;
