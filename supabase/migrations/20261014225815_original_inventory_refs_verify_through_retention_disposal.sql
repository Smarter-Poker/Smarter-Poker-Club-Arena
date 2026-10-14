-- @live-proof: (SELECT md5(pg_get_functiondef('smarter_private.original_inventory_source_ref_md5(jsonb)'::regprocedure))='81fba77f13564999931e8a7a47cbd609')
-- 20261014225815_original_inventory_refs_verify_through_retention_disposal.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- The original week (union fade0000, 2026-10-05 -> 2026-10-12) stopped settling
-- with original_restoration_cash_flow_source_refused after attempt 70. Its
-- 245-case original inventory pins 93 settled horse cash hands by their
-- hand_atomic_commits row (atomic_economics) and their settlement request
-- (signed_economics). sp_prune_hand_history deletes a horse hand's atomic commit
-- eight days after it settles, and on 2026-10-14 15:33 UTC it pruned the first 22
-- of them. Each prune wrote smarter_private.hand_submission_disposals from the
-- live row in the same transaction, but original_inventory_source_ref_md5 could
-- only read the deleted row, so 44 certified refs (22 atomic + 22 signed) became
-- unverifiable for ever and every remaining pinned hand would follow within days.
--
-- The root fix is in the verifier, where the wrong answer was produced:
--  * atomic_economics: when no commit row exists, the ref verifies only through
--    exactly one retention disposal for that same submission whose recorded kind,
--    settled/completed flags, identity, request hash, finite completion and
--    retention boundary all hold, with no hand_history or commit left at that
--    table/hand, and the retention policy still eight days. Its certified digest
--    then stands; nothing else is accepted.
--  * signed_economics: the existing pruned-request branch keeps every check; it
--    reads the commit's settled completion from that disposal when the commit row
--    itself was pruned, instead of refusing.
-- Live (unpruned) hands keep the original digest path byte for byte.
--
-- The two pins on the verifier's definition move with it: the cash discharge
-- getter pin and the finite-40 source authority. Because the source authority's
-- own definition feeds the inventory generation, the generation advances from
-- original-inventory-245-v1:417229e7... and the original-week close caches are
-- re-certified by the natural weekly worker. That is the lawful consequence of
-- the evidence change; no certificate, cache, cutoff, floor or money is written
-- here.
--
-- Proved in production first by two self-aborting single-transaction trials on
-- 2026-10-14 (successor built in pg_temp only): all 1,580 distinct source refs of
-- the 245 cases verify (44 newly, 0 regressions); a forged md5, an unknown hand,
-- an unknown signed submission and a tampered economic stack are refused; a live
-- hand returns its real digest and never the claimed one.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
SET LOCAL search_path=public;
DO $guard$BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.role',true),'') IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.sub',true),'') IS NOT NULL THEN RAISE EXCEPTION 'original_refs_retention_operator_refused' USING ERRCODE='42501';END IF;
 IF NOT pg_try_advisory_xact_lock_shared(530090,1) THEN RAISE EXCEPTION 'original_refs_retention_settlement_lane_owned';END IF;
 IF NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL THEN RAISE EXCEPTION 'original_refs_retention_override_refused';END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN RAISE EXCEPTION 'original_refs_retention_freeze_refused';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN RAISE EXCEPTION 'original_refs_retention_reader_owned';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('original-seven-cash-discharge',0)) THEN RAISE EXCEPTION 'original_refs_retention_discharge_writer_busy';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261014225815') THEN RAISE EXCEPTION 'original_refs_retention_history_replay';END IF;
 IF NOT EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261013212336') THEN RAISE EXCEPTION 'original_refs_retention_parent_history_refused';END IF;
 IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN RAISE EXCEPTION 'original_refs_retention_source40_refused';END IF;
END $guard$;

DO $install$
DECLARE
 o_a text:=$anchor$   FROM public.hand_atomic_commits t WHERE t.hand_id=v_ref_id;
  WHEN 'signed_economics' THEN$anchor$;
 n_a text:=$anchor$   FROM public.hand_atomic_commits t WHERE t.hand_id=v_ref_id;
   IF n=0 THEN
    -- RETENTION PRUNED THIS COMMIT (2026-10-14). sp_prune_hand_history deletes a
    -- settled horse hand's atomic commit after the retention window and, in the
    -- same transaction, writes its disposal from the live row. The digest below was
    -- certified while the row existed; the disposal is the only authority that the
    -- hand settled and was removed by retention. Anything else stays refused.
    SELECT count(*) INTO n FROM smarter_private.hand_submission_disposals t WHERE t.submission_id=v_ref_id;
    IF n IS DISTINCT FROM 1 THEN RETURN NULL;END IF;
    SELECT * INTO d FROM smarter_private.hand_submission_disposals t WHERE t.submission_id=v_ref_id;
    SELECT * INTO s FROM smarter_private.hand_submissions t WHERE t.submission_id=v_ref_id AND t.table_id=d.table_id AND t.hand_number=d.hand_number;
    IF NOT FOUND
    OR EXISTS(SELECT 1 FROM public.hand_atomic_commits x WHERE x.table_id=d.table_id AND x.hand_number=d.hand_number)
    OR EXISTS(SELECT 1 FROM public.hand_history x WHERE x.id=v_ref_id)
    OR d.expected->>'kind' IS DISTINCT FROM 'retention_pruned_settled_hand'
    OR d.expected->>'settled' IS DISTINCT FROM 'true' OR d.expected->>'settlement_completed' IS DISTINCT FROM 'true'
    OR d.expected->>'submission_id' IS DISTINCT FROM v_ref_id::text OR d.expected->>'pruned_hand_id' IS DISTINCT FROM v_ref_id::text
    OR d.expected->>'table_id' IS DISTINCT FROM d.table_id::text OR d.expected->>'hand_number' IS DISTINCT FROM d.hand_number::text
    OR d.expected->>'request_hash' IS DISTINCT FROM s.request_hash
    OR (d.expected->>'settlement_completed_at')::timestamptz IS NULL OR NOT isfinite((d.expected->>'settlement_completed_at')::timestamptz)
    OR (d.expected->>'disposed_at')::timestamptz IS NULL OR NOT isfinite((d.expected->>'disposed_at')::timestamptz)
    OR (d.expected->>'disposed_at')::timestamptz>clock_timestamp()
    OR (d.expected->>'disposed_at')::timestamptz < (d.expected->>'settlement_completed_at')::timestamptz+interval '8 days'
    OR (SELECT horse_retention_days FROM public.hand_history_retention_policy LIMIT 1) IS DISTINCT FROM 8
    OR ref->>'md5' IS NULL OR ref->>'md5' !~ '^[0-9a-f]{32}$' THEN RETURN NULL;END IF;
    n:=1;digest:=ref->>'md5';
   END IF;
  WHEN 'signed_economics' THEN$anchor$;
 o_s text:=$anchor$    SELECT * INTO a FROM public.hand_atomic_commits t WHERE t.hand_id=v_ref_id AND t.table_id=s.table_id AND t.hand_number=s.hand_number;
    IF NOT FOUND OR s.retained_at IS NULL OR NOT isfinite(s.retained_at)$anchor$;
 n_s text:=$anchor$    SELECT * INTO a FROM public.hand_atomic_commits t WHERE t.hand_id=v_ref_id AND t.table_id=s.table_id AND t.hand_number=s.hand_number;
    IF NOT FOUND THEN
     -- RETENTION PRUNED THIS COMMIT (2026-10-14): its settled completion is read from
     -- the disposal retention wrote from the live row in the same transaction.
     IF EXISTS(SELECT 1 FROM public.hand_atomic_commits x WHERE x.table_id=s.table_id AND x.hand_number=s.hand_number)
     OR EXISTS(SELECT 1 FROM public.hand_history x WHERE x.id=v_ref_id)
     OR NOT pg_input_is_valid(d.expected->>'settlement_completed_at','timestamptz') THEN RETURN NULL;END IF;
     a.post_commit_completed_at:=(d.expected->>'settlement_completed_at')::timestamptz;
     a.committed_at:=a.post_commit_completed_at;
     a.post_commit_result:=jsonb_build_object('ok',true);
    END IF;
    IF s.retained_at IS NULL OR NOT isfinite(s.retained_at)$anchor$;
 sig_rm constant regprocedure:='smarter_private.original_inventory_source_ref_md5(jsonb)'::regprocedure;
 sig_dis constant regprocedure:='smarter_private.original_erased_cash_base_discharge(bigint,text)'::regprocedure;
 sig_psm constant regprocedure:='smarter_private.original_inventory_proof_sources_match()'::regprocedure;
 def_rm text; def_dis text; def_psm text; before jsonb;
BEGIN
 def_rm:=pg_get_functiondef(sig_rm); def_dis:=pg_get_functiondef(sig_dis); def_psm:=pg_get_functiondef(sig_psm);
 IF md5(def_rm)<>'1411d22a7ad914a80922aeed8bfcf7e6' OR md5(def_dis)<>'92624d180575de6759e928278e9c2c6b' OR md5(def_psm)<>'2f0091a1c85eb9f4ffadce1142ba31a4' THEN RAISE EXCEPTION 'original_refs_retention_preimage_refused';END IF;
 IF (length(def_rm)-length(replace(def_rm,o_a,'')))/length(o_a)<>1 OR (length(def_rm)-length(replace(def_rm,o_s,'')))/length(o_s)<>1
 OR (length(def_dis)-length(replace(def_dis,'1411d22a7ad914a80922aeed8bfcf7e6','')))/32<>1
 OR (length(def_psm)-length(replace(def_psm,'1411d22a7ad914a80922aeed8bfcf7e6','')))/32<>1 OR (length(def_psm)-length(replace(def_psm,'92624d180575de6759e928278e9c2c6b','')))/32<>1
 THEN RAISE EXCEPTION 'original_refs_retention_anchor_refused';END IF;
 SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_array(pg_get_userbyid(p.proowner),p.prosecdef,p.provolatile,p.proacl::text,p.proconfig)) INTO before
 FROM pg_proc p WHERE p.oid IN(sig_rm,sig_dis,sig_psm);
 EXECUTE replace(replace(def_rm,o_a,n_a),o_s,n_s);
 IF md5(pg_get_functiondef(sig_rm))<>'81fba77f13564999931e8a7a47cbd609' THEN RAISE EXCEPTION 'original_refs_retention_verifier_postimage_refused';END IF;
 EXECUTE replace(def_dis,'1411d22a7ad914a80922aeed8bfcf7e6','81fba77f13564999931e8a7a47cbd609');
 IF md5(pg_get_functiondef(sig_dis))<>'9e6fcbf606004b81353a7704b50f072f' THEN RAISE EXCEPTION 'original_refs_retention_discharge_postimage_refused';END IF;
 EXECUTE replace(replace(def_psm,'1411d22a7ad914a80922aeed8bfcf7e6','81fba77f13564999931e8a7a47cbd609'),'92624d180575de6759e928278e9c2c6b','9e6fcbf606004b81353a7704b50f072f');
 IF md5(pg_get_functiondef(sig_psm))<>'4a98179afccf2d31c127f50ed5ab9270' THEN RAISE EXCEPTION 'original_refs_retention_source40_postimage_refused';END IF;
 IF (SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_array(pg_get_userbyid(p.proowner),p.prosecdef,p.provolatile,p.proacl::text,p.proconfig))
     FROM pg_proc p WHERE p.oid IN(sig_rm,sig_dis,sig_psm)) IS DISTINCT FROM before THEN RAISE EXCEPTION 'original_refs_retention_security_refused';END IF;
 IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN RAISE EXCEPTION 'original_refs_retention_post_source40_refused';END IF;
END $install$;

COMMIT;
