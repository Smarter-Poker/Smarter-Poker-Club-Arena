-- Reserved by scripts/new-migration.mjs:20261016173058.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz)'::regprocedure))='564c97815954807fb96daaaee7003eeb')
-- A real original-week rollback trial on 2026-10-16 passed the recording-time
-- guard but exhausted its unchanged three-minute budget before Round1.
-- Its two completed predecessors spent11.9/55.1 seconds discovering clubs;
-- preparation repeated the same reader for41.5 seconds. The planner had
-- decorrelated the per-club EXISTS into a half-million-row recognition join.
-- Walk the existing coordinator/club index once per distinct nonnull club,
-- and ask each event for a matching original source through club/event keys.
-- The event time restriction follows the existing equal-recognition-time test.
-- A read-only production execution of the exact replacement returned the
-- same two clubs in3.68 seconds. Native qualification covers independent
-- historical membership, cash/calculation/period sources, NULLs, cutoff/time,
-- mismatched recognition/disposition/rake/union and duplicate boundaries.
-- No financial rows, earning rule, memo lifetime, permission or budget changes.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.role',true),'') IS NOT NULL THEN RAISE EXCEPTION 'club_witness_operator_refused';END IF;
 IF NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL OR public.fn_platform_frozen() IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN RAISE EXCEPTION 'club_witness_freeze_or_override_refused';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN RAISE EXCEPTION 'club_witness_scheduler_owned';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261016173058') THEN RAISE EXCEPTION 'club_witness_history_replay';END IF;
 IF NOT EXISTS(SELECT FROM pg_index WHERE indexrelid=to_regclass('public.accounting_tournament_fee_sources_coordinator_club') AND indisvalid AND indisready AND indislive AND NOT indisunique AND indnkeyatts=2 AND indnatts=2 AND pg_get_indexdef(indexrelid,1,true)='coordinator_union_id' AND pg_get_indexdef(indexrelid,2,true)='club_id' AND indrelid='public.accounting_tournament_fee_sources'::regclass AND pg_get_expr(indpred,indrelid)='(coordinator_union_id IS NOT NULL)') THEN RAISE EXCEPTION 'club_witness_coordinator_index_required';END IF;
END $guard$;
DO $install$
DECLARE sig regprocedure:='public.fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz)'::regprocedure;def text:=pg_get_functiondef(sig);
 old1 text:=$old1$ SELECT DISTINCT s.club_id FROM public.accounting_tournament_fee_sources s WHERE s.coordinator_union_id=p_union_id$old1$;new1 text:=$new1$ SELECT w.club_id FROM (WITH RECURSIVE walk(club_id) AS ((SELECT s.club_id FROM public.accounting_tournament_fee_sources s WHERE s.coordinator_union_id=p_union_id AND s.club_id IS NOT NULL ORDER BY s.club_id LIMIT 1) UNION ALL SELECT n.club_id FROM walk w CROSS JOIN LATERAL (SELECT s.club_id FROM public.accounting_tournament_fee_sources s WHERE s.coordinator_union_id=p_union_id AND s.club_id>w.club_id ORDER BY s.club_id LIMIT 1) n) SELECT walk.club_id FROM walk) w$new1$;
 old2 text:=$old2$ WHERE EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources s
  JOIN public.accounting_tournament_recognized_sources rs ON rs.source_id=s.id AND rs.tournament_id=s.tournament_id
  JOIN public.accounting_tournament_fee_recognitions r ON r.tournament_id=s.tournament_id
  WHERE s.coordinator_union_id=p_union_id AND s.club_id=t.club_id AND rs.recognized_at>=p_from AND rs.recognized_at<p_to
   AND CASE WHEN b.cutoff IS NULL THEN true ELSE s.charged_at IS NOT NULL AND isfinite(s.charged_at) AND s.charged_at>=b.cutoff END
   AND CASE WHEN b.cutoff IS NULL THEN true ELSE rs.recognized_at IS NOT NULL AND isfinite(rs.recognized_at) AND rs.recognized_at>=b.cutoff END
   AND rs.disposition='earned' AND r.status='recognized'
   AND rs.rake_credit=s.rake_credit AND rs.recognized_at=r.recognized_at
   AND NOT s.union_id IS DISTINCT FROM r.union_id)$old2$;new2 text:=$new2$ WHERE EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions r JOIN LATERAL (SELECT 1 FROM (SELECT s.* FROM public.accounting_tournament_fee_sources s WHERE s.coordinator_union_id=p_union_id AND s.club_id=t.club_id AND s.tournament_id=r.tournament_id OFFSET 0) s JOIN public.accounting_tournament_recognized_sources rs ON rs.source_id=s.id AND rs.tournament_id=s.tournament_id
  WHERE s.tournament_id=r.tournament_id AND s.coordinator_union_id=p_union_id AND s.club_id=t.club_id AND rs.recognized_at>=p_from AND rs.recognized_at<p_to
   AND CASE WHEN b.cutoff IS NULL THEN true ELSE s.charged_at IS NOT NULL AND isfinite(s.charged_at) AND s.charged_at>=b.cutoff END
   AND CASE WHEN b.cutoff IS NULL THEN true ELSE rs.recognized_at IS NOT NULL AND isfinite(rs.recognized_at) AND rs.recognized_at>=b.cutoff END
   AND rs.disposition='earned' AND r.status='recognized'
   AND rs.rake_credit=s.rake_credit AND rs.recognized_at=r.recognized_at
   AND NOT s.union_id IS DISTINCT FROM r.union_id LIMIT 1 OFFSET 0) witness ON true WHERE r.status='recognized' AND r.recognized_at>=p_from AND r.recognized_at<p_to LIMIT 1 OFFSET 0)$new2$;
BEGIN
 IF md5(def)<>'7d216ca8b05a7c4b5b47133d6bd95ed1' OR (SELECT proowner<>'postgres'::regrole OR NOT prosecdef OR provolatile<>'s' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres}' OR proconfig IS DISTINCT FROM ARRAY['search_path=public'] FROM pg_proc WHERE oid=sig) THEN RAISE EXCEPTION 'club_witness_preimage_authority_refused';END IF;
 IF (length(def)-length(replace(def,old1,'')))/length(old1)<>1 OR (length(def)-length(replace(def,old2,'')))/length(old2)<>1 THEN RAISE EXCEPTION 'club_witness_exact_replacement_refused';END IF;
 def:=replace(replace(def,old1,new1),old2,new2);
 IF md5(def)<>'564c97815954807fb96daaaee7003eeb' THEN RAISE EXCEPTION 'club_witness_postimage_refused';END IF;
 EXECUTE def;
 IF md5(pg_get_functiondef(sig))<>'564c97815954807fb96daaaee7003eeb' THEN RAISE EXCEPTION 'club_witness_installed_source_refused';END IF;
END $install$;
COMMIT;
