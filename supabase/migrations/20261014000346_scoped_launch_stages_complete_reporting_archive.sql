-- 20261014000346_scoped_launch_stages_complete_reporting_archive
-- The live scoped recovery rehearsal timed out at270 seconds while archiving
-- tournament reporting rows omitted from the prior volume fixture. Preserve all
-- records by prearchiving all20 derived stores under this original parked
-- operation, then verify their exact full rowsets under locked freeze ownership.
-- Existing financial closing, current-week waivers, retired profiles, Mint,
-- exact undo and full285-second recovery reserve remain authoritative.
-- Installation performs no stage, balance change, waiver or resume.
-- Validation permits only updated_at audit-stamp changes, the existing exact-undo
-- exception. All business fields, keys, counts and archived full-row hashes remain strict.
-- Preserve complete archived-row hashes while allowing only the original updated_at audit exception.
-- Guarded full derived-reporting prearchive for original scoped launch operation.
-- Install only schema/functions; no staging, reset, invoice waiver or financial movement.
-- Stage outside freeze under own parked/drained repeatable-read snapshot; freeze verifies exact whole rowsets.
-- @live-proof: (SELECT encode(sha256(convert_to(pg_get_functiondef(q.oid),'UTF8')),'hex')='8af3d35945bf44cafd700e576ef71e681044f46c64a688fb592181d8ed320e1e' AND md5(q.prosrc)='868303c748d5fddd201d78a44721f04f' AND pg_get_userbyid(q.proowner)='postgres' AND q.prosecdef IS TRUE AND to_jsonb(q.proconfig) IS NOT DISTINCT FROM '["search_path=pg_catalog, public", "TimeZone=UTC"]'::jsonb AND q.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}' FROM pg_proc q WHERE q.oid=to_regprocedure('public.fn_ca_launch_accounting_activate(uuid)')) IS TRUE
-- @live-proof: (SELECT encode(sha256(convert_to(pg_get_functiondef(q.oid),'UTF8')),'hex')='f6feb1106faf7e83bb5d2b5128ef13c5cd7a65bb0e88875d486bb715951fb8e9' AND md5(q.prosrc)='479383463715255a4222717e8b35dd1f' AND pg_get_userbyid(q.proowner)='postgres' AND q.prosecdef IS TRUE AND to_jsonb(q.proconfig) IS NOT DISTINCT FROM '["search_path=pg_catalog, public, smarter_private", "TimeZone=UTC"]'::jsonb AND q.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' FROM pg_proc q WHERE q.oid=to_regprocedure('public.fn_ca_launch_cache_stage(uuid,text,uuid)')) IS TRUE
-- @live-proof: (SELECT encode(sha256(convert_to(pg_get_functiondef(q.oid),'UTF8')),'hex')='077c49e92e7a57c9a246f57bba3406ae432f1b1c3d59ac0431a5058315c57be0' AND md5(q.prosrc)='14abdcb103d1dd97ada5054967ae6038' AND pg_get_userbyid(q.proowner)='postgres' AND q.prosecdef IS TRUE AND to_jsonb(q.proconfig) IS NOT DISTINCT FROM '["search_path=pg_catalog, public, smarter_private", "TimeZone=UTC"]'::jsonb AND q.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}' FROM pg_proc q WHERE q.oid=to_regprocedure('public.fn_ca_launch_cache_validate(uuid)')) IS TRUE
-- @live-proof: (SELECT relrowsecurity AND relowner='postgres'::regrole FROM pg_class WHERE oid=to_regclass('smarter_private.ca_launch_cache_stages')) IS TRUE
BEGIN;
SET LOCAL lock_timeout='4s';
CREATE TABLE smarter_private.ca_launch_cache_stages(operation_id uuid PRIMARY KEY,actor_id uuid NOT NULL,certificate_sha256 text NOT NULL,scope_ids uuid[] NOT NULL,staged_at timestamptz NOT NULL,source_sha256 text NOT NULL,relation_counts jsonb NOT NULL CHECK(jsonb_typeof(relation_counts)='object'));
ALTER TABLE smarter_private.ca_launch_cache_stages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.ca_launch_cache_stages FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER launch_cache_stage_immutable BEFORE UPDATE OR DELETE ON smarter_private.ca_launch_cache_stages FOR EACH ROW EXECUTE FUNCTION public.fn_ca_launch_accounting_archive_immutable();
DO $g$ BEGIN IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_ca_launch_accounting_activate(uuid)'::regprocedure) IS DISTINCT FROM '41637a44f6d62daf0a4a710d566714b8' THEN RAISE EXCEPTION 'CACHE_STAGE_ORIGINAL_SOURCE_CHANGED';END IF;END $g$;
DO $g$ BEGIN IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_ca_launch_reset_assert_drained()'::regprocedure) IS DISTINCT FROM '5cea31e3160512ae2cbaba57b97e1559' THEN RAISE EXCEPTION 'CACHE_STAGE_ORIGINAL_SOURCE_CHANGED';END IF;END $g$;
DO $guard$ BEGIN IF NOT EXISTS(SELECT FROM pg_proc q WHERE oid='public.fn_ca_launch_reset_assert_drained()'::regprocedure AND md5(pg_get_functiondef(oid))='2ee23418c79e82e62d066b214df16eda' AND pg_get_userbyid(proowner)='postgres' AND prosecdef IS TRUE AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND proconfig=ARRAY['search_path=public, pg_temp']) THEN RAISE EXCEPTION 'CACHE_STAGE_ORIGINAL_AUTHORITY_CHANGED';END IF;END $guard$;
DO $guard$ BEGIN IF NOT EXISTS(SELECT FROM pg_proc q WHERE oid='public.fn_ca_launch_accounting_store_query(text,text[])'::regprocedure AND md5(pg_get_functiondef(oid))='452073771b79800bedd7d773c9584f2a' AND pg_get_userbyid(proowner)='postgres' AND prosecdef IS TRUE AND proacl::text='{postgres=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog, public','TimeZone=UTC']) THEN RAISE EXCEPTION 'CACHE_STAGE_ORIGINAL_AUTHORITY_CHANGED';END IF;END $guard$;
DO $guard$ BEGIN IF NOT EXISTS(SELECT FROM pg_proc q WHERE oid='public.fn_ca_launch_accounting_activate(uuid)'::regprocedure AND md5(pg_get_functiondef(oid))='c2a380396a8d74304e07c817c4424ea1' AND pg_get_userbyid(proowner)='postgres' AND prosecdef IS TRUE AND proacl::text='{postgres=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog, public','TimeZone=UTC']) THEN RAISE EXCEPTION 'CACHE_STAGE_ORIGINAL_AUTHORITY_CHANGED';END IF;END $guard$;
CREATE FUNCTION public.fn_ca_launch_cache_stage(op uuid,certificate text,actor uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private SET timezone='UTC' AS $s$
DECLARE scope constant uuid[]:=ARRAY['a0000000-0000-0000-0000-000000000001','2a1132b9-5ba2-42e6-9f01-30a7fcffebe3','a41434bb-8d0c-400a-8f0d-e8b3d65afed4','fade0000-0000-0000-0000-000000000001']::uuid[];rel text;n bigint;stamp timestamptz:=clock_timestamp();counts jsonb:='{}'::jsonb;
BEGIN
 IF NOT EXISTS(SELECT FROM pg_proc WHERE oid='public.fn_ca_launch_accounting_store_query(text,text[])'::regprocedure AND md5(pg_get_functiondef(oid))='452073771b79800bedd7d773c9584f2a' AND pg_get_userbyid(proowner)='postgres' AND prosecdef IS TRUE AND proacl::text='{postgres=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog, public','TimeZone=UTC']) THEN RAISE EXCEPTION 'CACHE_STAGE_SOURCE_QUERY_AUTHORITY_CHANGED';END IF;

 IF public.fn_caller_is_engine() IS NOT TRUE OR (coalesce(auth.role(),'')<>'service_role' AND session_user NOT IN('postgres','supabase_admin')) THEN RAISE EXCEPTION 'LAUNCH_RESET_OPERATOR_ONLY' USING ERRCODE='42501'; END IF;

 IF EXISTS(SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id WHERE s.left_at IS NULL AND (s.club_id=ANY(scope) OR t.club_id=ANY(scope))) THEN RAISE EXCEPTION 'LAUNCH_RESET_HAS_LIVE_SEATS' USING ERRCODE='55006'; END IF;
 IF EXISTS(SELECT 1 FROM public.hand_atomic_commits h JOIN public.tables t ON t.id=h.table_id WHERE t.club_id=ANY(scope) AND h.post_commit_payload IS NOT NULL AND h.post_commit_completed_at IS NULL) THEN RAISE EXCEPTION 'LAUNCH_RESET_HAS_UNFINISHED_HAND' USING ERRCODE='55006'; END IF;
 IF EXISTS(SELECT 1 FROM public.table_pending_addons a JOIN public.tables t ON t.id=a.table_id WHERE t.club_id=ANY(scope) AND a.resolved_at IS NULL) THEN RAISE EXCEPTION 'LAUNCH_RESET_HAS_PENDING_ADDON' USING ERRCODE='55006'; END IF;
 IF EXISTS(SELECT 1 FROM public.tournaments WHERE club_id=ANY(scope) AND upper(status) NOT IN('COMPLETED','CANCELLED')) THEN RAISE EXCEPTION 'LAUNCH_RESET_HAS_OPEN_TOURNAMENT' USING ERRCODE='55006'; END IF;
 IF EXISTS(SELECT FROM public.chip_escrow WHERE club_id=ANY(scope) AND released_at IS NULL) THEN RAISE EXCEPTION 'CACHE_STAGE_HAS_UNRELEASED_ESCROW' USING ERRCODE='55006';END IF;
 IF EXISTS(SELECT 1 FROM public.club_members WHERE club_id=ANY(scope) AND (coalesce(held_chips,0)<>0 OR coalesce(locked_chips,0)<>0)) THEN RAISE EXCEPTION 'LAUNCH_RESET_HAS_HELD_PLAYER_CHIPS' USING ERRCODE='55006'; END IF;


 IF op IS DISTINCT FROM 'eece5c98-1bd4-45c5-a6d8-5a637c9a782c'::uuid OR actor IS DISTINCT FROM '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid THEN RAISE EXCEPTION 'CACHE_STAGE_ORIGINAL_OWNER_REQUIRED';END IF;
 IF public.fn_platform_frozen() IS TRUE THEN RAISE EXCEPTION 'CACHE_STAGE_ONLY_OUTSIDE_FREEZE';END IF;
 IF NOT EXISTS(SELECT FROM public.ca_engine_operator_commands WHERE id='5790e1ef-9bb1-40d7-a2da-0fed650bd4b8'::uuid AND actor_id=actor AND domain='floor' AND action='close_cash' AND status='completed') THEN RAISE EXCEPTION 'CACHE_STAGE_OWN_CASH_CLOSE_REQUIRED';END IF;
 IF actor IS NULL OR (public.fn_ca_operator_permissions(actor)->'permissions' ? 'clubs.write') IS NOT TRUE OR auth.uid() IS DISTINCT FROM actor OR NOT EXISTS(SELECT FROM public.profiles WHERE id=actor AND role IN('admin','god') AND status='active') THEN RAISE EXCEPTION 'CACHE_STAGE_ACTOR_REFUSED' USING ERRCODE='42501';END IF;
 IF op IS NULL OR certificate !~ '^[0-9a-f]{64}$' OR certificate IS NULL THEN RAISE EXCEPTION 'CACHE_STAGE_IDENTITY_REFUSED';END IF;
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'repeatable read' THEN RAISE EXCEPTION 'CACHE_STAGE_REPEATABLE_READ_REQUIRED';END IF;
 PERFORM pg_advisory_xact_lock_shared(530093);
 PERFORM 1 FROM public.ca_operator_floor_hold fh WHERE fh.operation_id='a970faa8-7a40-4af9-9096-51d8c67ca803'::uuid FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CACHE_STAGE_ORIGINAL_HOLD_MISSING';END IF;

 IF NOT EXISTS(SELECT FROM public.ca_operator_floor_hold h JOIN public.ca_launch_operator_scopes m ON m.operation_id=h.operation_id JOIN public.ca_engine_operator_commands c ON c.id=h.operation_id WHERE h.operation_id='a970faa8-7a40-4af9-9096-51d8c67ca803'::uuid AND h.mode='park' AND c.actor_id=actor AND m.actor_id=actor AND c.domain='floor' AND c.action='park' AND c.status='accepted' AND (SELECT array_agg(x ORDER BY x) FROM unnest(m.club_ids)x)=(SELECT array_agg(x ORDER BY x) FROM unnest(scope)x)) THEN RAISE EXCEPTION 'CACHE_STAGE_SCOPED_PARK_REQUIRED';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtext('ca_launch_reset')) THEN RAISE EXCEPTION 'CACHE_STAGE_BUSY' USING ERRCODE='55P03';END IF;

 IF public.fn_caller_is_engine() IS NOT TRUE OR (coalesce(auth.role(),'')<>'service_role' AND session_user NOT IN('postgres','supabase_admin')) THEN RAISE EXCEPTION 'LAUNCH_RESET_OPERATOR_ONLY' USING ERRCODE='42501'; END IF;

 IF EXISTS(SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id WHERE s.left_at IS NULL AND (s.club_id=ANY(scope) OR t.club_id=ANY(scope))) THEN RAISE EXCEPTION 'LAUNCH_RESET_HAS_LIVE_SEATS' USING ERRCODE='55006'; END IF;
 IF EXISTS(SELECT 1 FROM public.hand_atomic_commits h JOIN public.tables t ON t.id=h.table_id WHERE t.club_id=ANY(scope) AND h.post_commit_payload IS NOT NULL AND h.post_commit_completed_at IS NULL) THEN RAISE EXCEPTION 'LAUNCH_RESET_HAS_UNFINISHED_HAND' USING ERRCODE='55006'; END IF;
 IF EXISTS(SELECT 1 FROM public.table_pending_addons a JOIN public.tables t ON t.id=a.table_id WHERE t.club_id=ANY(scope) AND a.resolved_at IS NULL) THEN RAISE EXCEPTION 'LAUNCH_RESET_HAS_PENDING_ADDON' USING ERRCODE='55006'; END IF;
 IF EXISTS(SELECT 1 FROM public.tournaments WHERE club_id=ANY(scope) AND upper(status) NOT IN('COMPLETED','CANCELLED')) THEN RAISE EXCEPTION 'LAUNCH_RESET_HAS_OPEN_TOURNAMENT' USING ERRCODE='55006'; END IF;
 IF EXISTS(SELECT FROM public.chip_escrow WHERE club_id=ANY(scope) AND released_at IS NULL) THEN RAISE EXCEPTION 'CACHE_STAGE_HAS_UNRELEASED_ESCROW' USING ERRCODE='55006';END IF;
 IF EXISTS(SELECT 1 FROM public.club_members WHERE club_id=ANY(scope) AND (coalesce(held_chips,0)<>0 OR coalesce(locked_chips,0)<>0)) THEN RAISE EXCEPTION 'LAUNCH_RESET_HAS_HELD_PLAYER_CHIPS' USING ERRCODE='55006'; END IF;

 IF EXISTS(SELECT FROM public.ca_launch_reset_operations WHERE operation_id=op) OR EXISTS(SELECT FROM smarter_private.ca_launch_cache_stages WHERE operation_id=op) OR EXISTS(SELECT FROM public.ca_launch_accounting_archives WHERE operation_id=op) OR EXISTS(SELECT FROM public.ca_launch_accounting_boundaries WHERE scope_id=ANY(scope) AND undone_at IS NULL) THEN RAISE EXCEPTION 'CACHE_STAGE_REPLAY_OR_BOUNDARY_REFUSED';END IF;
 IF NOT EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261012181905' AND name='scoped_club_launch_reset_and_guarded_recovery' AND cardinality(statements)=1 AND encode(sha256(convert_to(statements[1],'UTF8')),'hex')='900ab93898c39d4adc77b1377be5a0d5d7394190776c4c6d37b241c8c59fbf9d') THEN RAISE EXCEPTION 'CACHE_STAGE_HISTORY_REFUSED';END IF;
 IF NOT EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261013133012' AND name='scoped_launch_operator_accepts_authoritative_json_claims' AND cardinality(statements)=1 AND encode(sha256(convert_to(statements[1],'UTF8')),'hex')='89b1671cf9aa507248b7620f734855fa03cdf586d133a1caa9890530fbd04df3') THEN RAISE EXCEPTION 'CACHE_STAGE_HISTORY_REFUSED';END IF;
 FOREACH rel IN ARRAY ARRAY['player_stats','player_stats_snapshots','club_member_daily_stats','club_member_play_totals','ca_club_commission_daily','ca_club_rake_daily','ca_club_rake_daily_user','club_rake_daily_user','club_rake_rollup_complete','club_table_rake_totals','club_hand_daily_shard','club_member_table_state','accounting_rakeback_period_evidence_checkpoints','accounting_recompute_split_parts','accounting_period_recompute_requests','ca_club_player_daily','ca_club_tournament_daily','ca_club_tournament_player_daily','club_table_daily','union_rake_weekly'] LOOP
 EXECUTE 'INSERT INTO public.ca_launch_accounting_archives(operation_id,relation_name,row_key,before_image,row_sha256,captured_at) SELECT $3,$4,e.row_key,e.row_image,encode(sha256(convert_to(e.row_image::text,''UTF8'')),''hex''),$5 FROM ('||public.fn_ca_launch_accounting_store_query(rel,NULL)||')e' USING scope,NULL::text[],op,rel,stamp;
  GET DIAGNOSTICS n=ROW_COUNT;counts:=counts||jsonb_build_object(rel,n);
 END LOOP;
 IF NOT EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261013202353' AND name='scoped_launch_preserves_retired_wallets_and_starts_current_w' AND cardinality(statements)=1 AND encode(sha256(convert_to(statements[1],'UTF8')),'hex')='9852a9174d6231d0c9dce79b413cdd50eb41970d59bb0cd7f5f491c34cbb7e20') THEN RAISE EXCEPTION 'CACHE_STAGE_FINAL_HISTORY_REFUSED';END IF;
 INSERT INTO smarter_private.ca_launch_cache_stages VALUES(op,actor,certificate,scope,stamp,'9852a9174d6231d0c9dce79b413cdd50eb41970d59bb0cd7f5f491c34cbb7e20',counts);
 ANALYZE public.ca_launch_accounting_archives;
 RETURN jsonb_build_object('staged',true,'operation_id',op,'metadata_only',true);
END $s$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_cache_stage(uuid,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_launch_cache_stage(uuid,text,uuid) TO service_role;
CREATE FUNCTION public.fn_ca_launch_cache_validate(op uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private SET timezone='UTC' AS $v$
DECLARE h smarter_private.ca_launch_cache_stages;o public.ca_launch_reset_operations;rel text;bad boolean;
BEGIN
 IF NOT EXISTS(SELECT FROM pg_proc WHERE oid='public.fn_ca_launch_accounting_store_query(text,text[])'::regprocedure AND md5(pg_get_functiondef(oid))='452073771b79800bedd7d773c9584f2a' AND pg_get_userbyid(proowner)='postgres' AND prosecdef IS TRUE AND proacl::text='{postgres=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog, public','TimeZone=UTC']) THEN RAISE EXCEPTION 'CACHE_STAGE_SOURCE_QUERY_AUTHORITY_CHANGED';END IF;
 SELECT * INTO h FROM smarter_private.ca_launch_cache_stages WHERE operation_id=op;
 IF NOT FOUND THEN IF EXISTS(SELECT FROM public.ca_launch_accounting_archives WHERE operation_id=op AND relation_name=ANY(ARRAY['player_stats','player_stats_snapshots','club_member_daily_stats','club_member_play_totals','ca_club_commission_daily','ca_club_rake_daily','ca_club_rake_daily_user','club_rake_daily_user','club_rake_rollup_complete','club_table_rake_totals','club_hand_daily_shard','club_member_table_state','accounting_rakeback_period_evidence_checkpoints','accounting_recompute_split_parts','accounting_period_recompute_requests','ca_club_player_daily','ca_club_tournament_daily','ca_club_tournament_player_daily','club_table_daily','union_rake_weekly'])) THEN RAISE EXCEPTION 'CACHE_STAGE_MISSING_HEADER';END IF;RETURN false;END IF;
 IF NOT EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261012181905' AND name='scoped_club_launch_reset_and_guarded_recovery' AND cardinality(statements)=1 AND encode(sha256(convert_to(statements[1],'UTF8')),'hex')='900ab93898c39d4adc77b1377be5a0d5d7394190776c4c6d37b241c8c59fbf9d') OR NOT EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261013133012' AND name='scoped_launch_operator_accepts_authoritative_json_claims' AND cardinality(statements)=1 AND encode(sha256(convert_to(statements[1],'UTF8')),'hex')='89b1671cf9aa507248b7620f734855fa03cdf586d133a1caa9890530fbd04df3') THEN RAISE EXCEPTION 'CACHE_STAGE_HISTORY_REFUSED';END IF;
 IF NOT EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261013202353' AND name='scoped_launch_preserves_retired_wallets_and_starts_current_w' AND cardinality(statements)=1 AND encode(sha256(convert_to(statements[1],'UTF8')),'hex')='9852a9174d6231d0c9dce79b413cdd50eb41970d59bb0cd7f5f491c34cbb7e20') THEN RAISE EXCEPTION 'CACHE_STAGE_FINAL_HISTORY_REFUSED';END IF;
 PERFORM pg_advisory_xact_lock_shared(530093);
 PERFORM 1 FROM public.ca_operator_floor_hold fh WHERE fh.operation_id='a970faa8-7a40-4af9-9096-51d8c67ca803'::uuid FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CACHE_STAGE_ORIGINAL_HOLD_MISSING';END IF;

 PERFORM public.fn_ca_launch_reset_assert_drained();
 IF op IS DISTINCT FROM 'eece5c98-1bd4-45c5-a6d8-5a637c9a782c'::uuid OR h.actor_id IS DISTINCT FROM '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid OR NOT EXISTS(SELECT FROM public.ca_operator_floor_hold fh JOIN public.ca_launch_operator_scopes m ON m.operation_id=fh.operation_id JOIN public.ca_engine_operator_commands c ON c.id=fh.operation_id WHERE fh.operation_id='a970faa8-7a40-4af9-9096-51d8c67ca803'::uuid AND fh.mode='park' AND c.actor_id=h.actor_id AND m.actor_id=h.actor_id AND c.domain='floor' AND c.action='park' AND c.status='accepted' AND (SELECT array_agg(x ORDER BY x) FROM unnest(m.club_ids)x)=(SELECT array_agg(x ORDER BY x) FROM unnest(h.scope_ids)x)) THEN RAISE EXCEPTION 'CACHE_STAGE_FREEZE_OWNER_CHANGED';END IF;
 SELECT * INTO o FROM public.ca_launch_reset_operations WHERE operation_id=op FOR UPDATE;
 IF public.fn_caller_is_engine() IS NOT TRUE OR public.fn_platform_frozen() IS NOT TRUE OR o.operation_id IS NULL OR o.state<>'captured' OR h.actor_id IS DISTINCT FROM o.performed_by OR h.certificate_sha256 IS DISTINCT FROM o.scoped_recovery_certificate_sha256 OR h.scope_ids IS DISTINCT FROM o.scoped_club_ids OR h.source_sha256 IS DISTINCT FROM '9852a9174d6231d0c9dce79b413cdd50eb41970d59bb0cd7f5f491c34cbb7e20' OR NOT isfinite(h.staged_at) OR h.staged_at>o.captured_at THEN RAISE EXCEPTION 'CACHE_STAGE_CAPTURE_IDENTITY_CHANGED';END IF;
 IF (SELECT array_agg(key ORDER BY key) FROM jsonb_each(h.relation_counts)) IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY['player_stats','player_stats_snapshots','club_member_daily_stats','club_member_play_totals','ca_club_commission_daily','ca_club_rake_daily','ca_club_rake_daily_user','club_rake_daily_user','club_rake_rollup_complete','club_table_rake_totals','club_hand_daily_shard','club_member_table_state','accounting_rakeback_period_evidence_checkpoints','accounting_recompute_split_parts','accounting_period_recompute_requests','ca_club_player_daily','ca_club_tournament_daily','ca_club_tournament_player_daily','club_table_daily','union_rake_weekly'])x) THEN RAISE EXCEPTION 'CACHE_STAGE_MANIFEST_CHANGED';END IF;
 FOREACH rel IN ARRAY ARRAY['player_stats','player_stats_snapshots','club_member_daily_stats','club_member_play_totals','ca_club_commission_daily','ca_club_rake_daily','ca_club_rake_daily_user','club_rake_daily_user','club_rake_rollup_complete','club_table_rake_totals','club_hand_daily_shard','club_member_table_state','accounting_rakeback_period_evidence_checkpoints','accounting_recompute_split_parts','accounting_period_recompute_requests','ca_club_player_daily','ca_club_tournament_daily','ca_club_tournament_player_daily','club_table_daily','union_rake_weekly'] LOOP
 IF (h.relation_counts->>rel)::bigint IS DISTINCT FROM (SELECT count(*) FROM public.ca_launch_accounting_archives WHERE operation_id=op AND relation_name=rel) THEN RAISE EXCEPTION 'CACHE_STAGE_COUNT_CHANGED';END IF;
 EXECUTE 'SELECT EXISTS(SELECT FROM ('||public.fn_ca_launch_accounting_store_query(rel,NULL)||')e FULL JOIN (SELECT row_key,before_image,row_sha256,captured_at FROM public.ca_launch_accounting_archives WHERE operation_id=$3 AND relation_name=$4)a USING(row_key) WHERE e.row_key IS NULL OR a.row_key IS NULL OR a.captured_at IS DISTINCT FROM $5 OR (e.row_image-''updated_at'') IS DISTINCT FROM (a.before_image-''updated_at'') OR encode(sha256(convert_to(a.before_image::text,''UTF8'')),''hex'') IS DISTINCT FROM a.row_sha256)' INTO bad USING o.scoped_club_ids,NULL::text[],op,rel,h.staged_at;
 IF bad THEN RAISE EXCEPTION 'CACHE_STAGE_ROWSET_CHANGED: %',rel;END IF;
 END LOOP;
 RETURN true;
END $v$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_cache_validate(uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.fn_ca_launch_accounting_activate(p_operation uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE o record;r record;v_rows jsonb;v_after jsonb;v_saved text;v_columns text[];v_set text;v_predicate text;
 v_relations text[]:=ARRAY['club_members','agents','clubs','unions','settlement_invoices','credit_invoices','rakeback_periods','club_settlement_floor','union_settlement_floor','player_stats','player_stats_snapshots','club_member_daily_stats','club_member_play_totals','ca_club_commission_daily','ca_club_rake_daily','ca_club_rake_daily_user','club_rake_daily_user','club_rake_rollup_complete','club_table_rake_totals','club_hand_daily_shard','club_member_table_state','accounting_rakeback_period_evidence_checkpoints','accounting_recompute_split_parts','accounting_period_recompute_requests','ca_club_player_daily','ca_club_tournament_daily','ca_club_tournament_player_daily','club_table_daily','union_rake_weekly'];
 v_relation text;v_staged boolean;
BEGIN
 IF public.fn_caller_is_engine() IS NOT TRUE OR public.fn_platform_frozen() IS NOT TRUE THEN RAISE EXCEPTION 'launch_accounting_requires_engine_and_freeze' USING ERRCODE='42501'; END IF;
 SELECT x.* INTO o FROM public.ca_launch_reset_operations x WHERE x.operation_id=p_operation FOR UPDATE;
 IF NOT FOUND OR o.state<>'captured' OR NOT isfinite(o.captured_at) OR
  (SELECT array_agg(x ORDER BY x) FROM unnest(o.scoped_club_ids)x) IS DISTINCT FROM ARRAY['2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid,'a0000000-0000-0000-0000-000000000001'::uuid,'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid,'fade0000-0000-0000-0000-000000000001'::uuid]
 THEN RAISE EXCEPTION 'launch_accounting_operation_scope_or_state_invalid'; END IF;
 IF EXISTS(SELECT 1 FROM public.ca_launch_accounting_boundaries WHERE operation_id=p_operation) THEN RAISE EXCEPTION 'launch_accounting_already_activated'; END IF;
 IF EXISTS(SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id WHERE s.left_at IS NULL AND s.user_id IS NOT NULL AND (t.club_id=ANY(o.scoped_club_ids) OR t.union_id=ANY(o.scoped_club_ids))) THEN RAISE EXCEPTION 'launch_accounting_live_scope_seats'; END IF;
 -- Today's week has not been certified yet. Do not overwrite a paid or cached current-week certificate.
 IF EXISTS(SELECT 1 FROM public.rakeback_periods p WHERE p.club_id=ANY(o.scoped_club_ids) AND p.period_start=(public.fn_union_week_start(o.captured_at) AT TIME ZONE 'America/Los_Angeles')::date AND (p.status IS DISTINCT FROM 'pending' OR p.paid_at IS NOT NULL OR p.created_at IS NULL OR p.created_at>=o.captured_at OR EXISTS(SELECT FROM public.rakeback_period_payouts x WHERE x.rakeback_period_id=p.id))) THEN RAISE EXCEPTION 'launch_accounting_current_week_period_requires_qualification'; END IF;
 v_saved:=current_setting('app.launch_reset_operation',true);PERFORM set_config('app.launch_reset_operation',p_operation::text,true);
 -- Freeze-owned locks cover every derived store and the table-to-club scope map.
 LOCK TABLE public.tables IN SHARE MODE;
 LOCK TABLE public.player_stats,public.player_stats_snapshots,public.club_member_daily_stats,public.club_member_play_totals,public.ca_club_commission_daily,public.ca_club_rake_daily,public.ca_club_rake_daily_user,public.club_rake_daily_user,public.club_rake_rollup_complete,public.club_table_rake_totals,public.club_hand_daily_shard,public.club_member_table_state,public.accounting_rakeback_period_evidence_checkpoints,public.accounting_recompute_split_parts,public.accounting_period_recompute_requests,public.ca_club_player_daily,public.ca_club_tournament_daily,public.ca_club_tournament_player_daily,public.club_table_daily,public.union_rake_weekly IN SHARE ROW EXCLUSIVE MODE;
 v_staged:=public.fn_ca_launch_cache_validate(p_operation);
 FOREACH v_relation IN ARRAY v_relations LOOP
  IF v_staged AND v_relation=ANY(v_relations[10:29]) THEN CONTINUE;END IF;
  EXECUTE 'INSERT INTO public.ca_launch_accounting_archives(operation_id,relation_name,row_key,before_image,row_sha256,captured_at) SELECT $3,$4,e.row_key,e.row_image,encode(sha256(convert_to(e.row_image::text,''UTF8'')),''hex''),$5 FROM ('||public.fn_ca_launch_accounting_store_query(v_relation,NULL)||')e' USING o.scoped_club_ids,NULL::text[],p_operation,v_relation,o.captured_at;
 END LOOP;
 INSERT INTO public.ca_launch_profile_hand_baselines(operation_id,user_id,hand_offset,captured_total_hands,remaining_club_hands,restored_scope_hands,captured_at)
 SELECT p_operation,p.id,COALESCE(p.total_hands_played,0)-COALESCE((SELECT sum(s.hands_played) FROM public.player_stats s WHERE s.user_id=p.id AND (s.club_id=ANY(o.scoped_club_ids)) IS NOT TRUE),0),COALESCE(p.total_hands_played,0),COALESCE((SELECT sum(s.hands_played) FROM public.player_stats s WHERE s.user_id=p.id AND (s.club_id=ANY(o.scoped_club_ids)) IS NOT TRUE),0),COALESCE((SELECT sum(s.hands_played) FROM public.player_stats s WHERE s.user_id=p.id AND s.club_id=ANY(o.scoped_club_ids)),0),o.captured_at
 FROM public.profiles p WHERE EXISTS(SELECT 1 FROM public.club_members m WHERE m.user_id=p.id AND m.club_id=ANY(o.scoped_club_ids)) OR EXISTS(SELECT 1 FROM public.player_stats s WHERE s.user_id=p.id AND s.club_id=ANY(o.scoped_club_ids));
 INSERT INTO public.ca_launch_accounting_boundaries(scope_kind,scope_id,operation_id,cutoff_at) SELECT 'club',x,p_operation,o.captured_at FROM unnest(o.scoped_club_ids)x;
 INSERT INTO public.ca_launch_accounting_boundaries(scope_kind,scope_id,operation_id,cutoff_at) VALUES('union','fade0000-0000-0000-0000-000000000001',p_operation,o.captured_at);
 UPDATE public.club_members SET credit_used=0,sessions_played=0,chips_won=0,chips_lost=0,hands_played=0,total_rake_paid=0,biggest_pot=0,promo_received_total=0,promo_wagered=0,promo_playthrough_required=0,missions_completed=0 WHERE club_id=ANY(o.scoped_club_ids);
 UPDATE public.agents SET credit_used=0,weekly_rake_generated=0,lifetime_earnings=0,lifetime_rake_generated=0 WHERE club_id=ANY(o.scoped_club_ids);
 UPDATE public.clubs SET total_rake=0,hands_played=0 WHERE id=ANY(o.scoped_club_ids);
 UPDATE public.unions SET total_rake=0 WHERE id=ANY(o.scoped_club_ids);
 UPDATE public.settlement_invoices SET status='cancelled',updated_at=o.captured_at WHERE club_id=ANY(o.scoped_club_ids) AND status IN('pending','generated','overdue','disputed');
 UPDATE public.credit_invoices c SET status='void',amount_remaining=0,void_reason='Owner Directed Launch Waiver '||p_operation::text WHERE status IN('pending','partial','overdue','disputed') AND EXISTS(SELECT 1 FROM public.agents a WHERE a.id=c.agent_id AND a.club_id=ANY(o.scoped_club_ids));
 UPDATE public.rakeback_periods SET status='expired',deferred_reason='Owner Directed Launch Waiver '||p_operation::text,deferred_at=o.captured_at WHERE club_id=ANY(o.scoped_club_ids) AND status IN('pending','open','closed','claiming');
 INSERT INTO public.club_settlement_floor(club_id,earliest_period_start,reason) SELECT x,public.fn_union_week_start(o.captured_at),'Owner Directed Launch Waiver '||p_operation::text FROM unnest(o.scoped_club_ids)x ON CONFLICT(club_id) DO UPDATE SET earliest_period_start=EXCLUDED.earliest_period_start,reason=EXCLUDED.reason;
 INSERT INTO public.union_settlement_floor(union_id,earliest_period_start,reason) VALUES('fade0000-0000-0000-0000-000000000001',public.fn_union_week_start(o.captured_at),'Owner Directed Launch Waiver '||p_operation::text) ON CONFLICT(union_id) DO UPDATE SET earliest_period_start=EXCLUDED.earliest_period_start,reason=EXCLUDED.reason;
 FOREACH v_relation IN ARRAY v_relations[10:29] LOOP
  IF v_relation='club_member_table_state' THEN EXECUTE 'DELETE FROM public.club_member_table_state t WHERE EXISTS(SELECT 1 FROM public.tables x WHERE x.id=t.table_id AND x.club_id=ANY($1))' USING o.scoped_club_ids;
  ELSE EXECUTE format('DELETE FROM public.%I t WHERE t.club_id=ANY($1)',v_relation) USING o.scoped_club_ids;END IF;
 END LOOP;
 FOREACH v_relation IN ARRAY v_relations LOOP
  v_columns:=CASE v_relation
   WHEN 'club_members' THEN ARRAY['credit_used','sessions_played','chips_won','chips_lost','hands_played','total_rake_paid','biggest_pot','promo_received_total','promo_wagered','promo_playthrough_required','missions_completed']
   WHEN 'agents' THEN ARRAY['credit_used','weekly_rake_generated','lifetime_earnings','lifetime_rake_generated']
   WHEN 'clubs' THEN ARRAY['total_rake','hands_played'] WHEN 'unions' THEN ARRAY['total_rake']
   WHEN 'settlement_invoices' THEN ARRAY['status','updated_at'] WHEN 'credit_invoices' THEN ARRAY['status','amount_remaining','void_reason']
   WHEN 'rakeback_periods' THEN ARRAY['status','deferred_reason','deferred_at']
   WHEN 'club_settlement_floor' THEN ARRAY['earliest_period_start','reason'] WHEN 'union_settlement_floor' THEN ARRAY['earliest_period_start','reason'] ELSE NULL END;
  EXECUTE 'INSERT INTO public.ca_launch_accounting_postimages(operation_id,relation_name,row_key,row_image,row_sha256) SELECT $3,$4,e.row_key,e.row_image,encode(sha256(convert_to(e.row_image::text,''UTF8'')),''hex'') FROM ('||public.fn_ca_launch_accounting_store_query(v_relation,v_columns)||')e' USING o.scoped_club_ids,v_columns,p_operation,v_relation;
  INSERT INTO public.ca_launch_accounting_store_receipts(operation_id,relation_name,mutated_columns,after_row_count,receipt_sha256)
  SELECT p_operation,v_relation,v_columns,count(*),encode(sha256(convert_to(p_operation::text||':'||v_relation||':'||count(*)::text,'UTF8')),'hex') FROM public.ca_launch_accounting_postimages WHERE operation_id=p_operation AND relation_name=v_relation;
 END LOOP;
 PERFORM public.fn_ca_launch_accounting_analyze(p_operation);
 PERFORM set_config('app.launch_reset_operation',COALESCE(v_saved,''),true);
 RETURN jsonb_build_object('activated',true,'operation_id',p_operation,'cutoff_at',o.captured_at,'relations',cardinality(v_relations),'waiver_is_payment',false);
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_launch_accounting_activate(uuid) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
