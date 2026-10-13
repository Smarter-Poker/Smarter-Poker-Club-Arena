-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_union_pnl_week_shaped_hands(uuid,timestamptz,timestamptz,boolean)'::regprocedure))='eda515d2a17344212d7c1a222dc0404d')
-- Replace forced per-candidate scalar touch lookup with an ordinary PK-proven join.
-- Same original outcome rows, all four refusal predicates, touch union/week/shape and raw branch.
-- Pure native rows qualified; planner evidence is not a runtime or financial success guarantee.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';
SET LOCAL search_path=public;
DO $guard$ BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.role',true),'') IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.sub',true),'') IS NOT NULL THEN RAISE EXCEPTION 'weekly_shaped_operator_refused' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261013215115') THEN RAISE EXCEPTION 'weekly_shaped_history_replay'; END IF;
 IF EXISTS(SELECT FROM(VALUES ('fn_platform_frozen()','ec683805e052fceeae74789e82dce4cc',false,'v','{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}',ARRAY['search_path=public, pg_temp']),('fn_active_maintenance_release_boundary()','05b537b57c9f51a5164e20a1cd0e67e0',true,'v','{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}',ARRAY['search_path=public, auth, pg_temp']),('fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)','edecfc5273ee4c96b608baa0ea863578',true,'v','{postgres=X/postgres}',ARRAY['search_path=public, pg_temp']),('fn_union_pnl_cash_outcome_accepted(union_pnl_cash_outcomes)','f1d7fbfbe0bcebb63579b19bc3143a95',false,'s','{postgres=X/postgres}',ARRAY['search_path=public, pg_temp']),('fn_union_pnl_cash_outcome_link(union_pnl_cash_outcomes)','627c6a7dd232bb8030d5400adf8346f2',false,'s','{postgres=X/postgres}',ARRAY['search_path=public, pg_temp']),('fn_union_pnl_projection_ready(text)','5f643c03d3595c20354d753087988476',true,'s','{postgres=X/postgres}',ARRAY['search_path=public, pg_temp']),('fn_union_pnl_week_shaped_hands(uuid,timestamp with time zone,timestamp with time zone,boolean)','78b5d525a31a79ff1b13a5cfe0ddf739',true,'s','{postgres=X/postgres}',ARRAY['search_path=public, pg_temp']),('smarter_private.original_inventory_basis_generation()','dbf5a3a18da9339ba60083cb2d3aea4c',false,'s','{postgres=X/postgres}',ARRAY['search_path=pg_catalog, public, smarter_private','TimeZone=UTC']),('smarter_private.original_inventory_proof_sources_match()','2f0091a1c85eb9f4ffadce1142ba31a4',false,'s','{postgres=X/postgres}',ARRAY['search_path=pg_catalog']) )v(signature,hash,secdef,volatility,acl,config) LEFT JOIN pg_proc p ON p.oid=to_regprocedure(v.signature) WHERE p.oid IS NULL OR md5(pg_get_functiondef(p.oid)) IS DISTINCT FROM v.hash OR p.proowner<>'postgres'::regrole OR p.prosecdef IS DISTINCT FROM v.secdef OR p.provolatile::text IS DISTINCT FROM v.volatility OR p.proacl::text IS DISTINCT FROM v.acl OR p.proconfig IS DISTINCT FROM v.config) THEN RAISE EXCEPTION 'weekly_shaped_authority_refused'; END IF;
 IF NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL THEN RAISE EXCEPTION 'weekly_shaped_override_refused'; END IF;
 IF NOT pg_try_advisory_xact_lock_shared(530090,1) THEN RAISE EXCEPTION 'weekly_shaped_settlement_lane_owned'; END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN RAISE EXCEPTION 'weekly_shaped_freeze_refused'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN RAISE EXCEPTION 'weekly_shaped_reader_owned'; END IF;
 IF EXISTS(SELECT FROM(VALUES ('20261013024122',6321,'8befef51b627728757b0cd164b89e084'),('20261013195428',11065,'7be7f54080357418424eaecfa552500d'))v(version,bytes,hash) WHERE (SELECT count(*) FROM supabase_migrations.schema_migrations m WHERE m.version=v.version)<>1 OR NOT EXISTS(SELECT FROM supabase_migrations.schema_migrations m WHERE m.version=v.version AND cardinality(m.statements)=1 AND octet_length(m.statements[1])=v.bytes AND md5(m.statements[1])=v.hash)) THEN RAISE EXCEPTION 'weekly_shaped_parent_history_refused'; END IF;
 IF EXISTS(SELECT FROM(VALUES ('union_pnl_cash_outcomes','table_id','uuid',true),('union_pnl_cash_outcomes','hand_number','bigint',true),('union_pnl_cash_outcomes','hand_id','uuid',true),('union_pnl_cash_outcomes','transaction_id','xid8',true),('union_pnl_cash_outcomes','recognized_at','timestamp with time zone',true),('union_pnl_cash_outcomes','payload_hash','text',true),('union_pnl_cash_outcomes','game_scope','jsonb',true),('union_pnl_cash_outcomes','evidence','jsonb',true),('union_pnl_cash_outcome_touches','table_id','uuid',true),('union_pnl_cash_outcome_touches','hand_number','bigint',true),('union_pnl_cash_outcome_touches','recognized_at','timestamp with time zone',false),('union_pnl_cash_outcome_touches','game_union_id','text',false),('union_pnl_cash_outcome_touches','shaped','boolean',true),('union_pnl_cash_outcome_touches','accepted_rake','text',false),('union_pnl_cash_outcome_touches','participants','jsonb',false))v(relation,name,type,is_not_null) LEFT JOIN pg_attribute a ON a.attrelid=to_regclass('public.'||v.relation) AND a.attname=v.name AND a.attnum>0 AND NOT a.attisdropped WHERE a.attnum IS NULL OR format_type(a.atttypid,a.atttypmod) IS DISTINCT FROM v.type OR a.attnotnull IS DISTINCT FROM v.is_not_null) OR (SELECT count(*) FROM pg_attribute WHERE attrelid IN('public.union_pnl_cash_outcomes'::regclass,'public.union_pnl_cash_outcome_touches'::regclass) AND attnum>0 AND NOT attisdropped)<>15 THEN RAISE EXCEPTION 'weekly_shaped_column_semantics_refused'; END IF;
 IF EXISTS(SELECT FROM(VALUES('public.union_pnl_cash_outcomes'),('public.union_pnl_cash_outcome_touches'))r(relation) WHERE NOT EXISTS(SELECT FROM pg_constraint c JOIN pg_index i ON i.indexrelid=c.conindid WHERE c.conrelid=to_regclass(r.relation) AND c.contype='p' AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred AND i.indisprimary AND i.indisunique AND i.indisvalid AND i.indisready AND i.indpred IS NULL AND i.indexprs IS NULL AND (SELECT array_agg(a.attname::text ORDER BY k.ordinality) FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ordinality) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum)=ARRAY['table_id','hand_number'])) THEN RAISE EXCEPTION 'weekly_shaped_pk_cardinality_refused'; END IF;
 IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN RAISE EXCEPTION 'weekly_shaped_source40_refused'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_union_pnl_week_shaped_hands(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_projected boolean)
 RETURNS SETOF union_pnl_cash_outcomes
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF p_projected THEN
  RETURN QUERY WITH candidates AS MATERIALIZED (
   SELECT q.* FROM public.union_pnl_cash_outcomes q
   WHERE q.game_scope->>'game_union_id'=p_union_id::text AND q.recognized_at>=p_start AND q.recognized_at<p_end
    AND (q.evidence->>'status' IS DISTINCT FROM 'ready' OR q.evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb
     OR q.evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb OR q.evidence->'game_scope' IS DISTINCT FROM q.game_scope)
  ) SELECT o.* FROM candidates o
   JOIN public.union_pnl_cash_outcome_touches h ON h.table_id=o.table_id AND h.hand_number=o.hand_number
   WHERE h.game_union_id=p_union_id::text AND h.recognized_at>=p_start AND h.recognized_at<p_end AND h.shaped IS TRUE;
 ELSE
  RETURN QUERY SELECT o.* FROM public.union_pnl_cash_outcomes o WHERE o.game_scope->>'game_union_id'=p_union_id::text AND o.recognized_at>=p_start AND o.recognized_at<p_end
   AND (o.evidence->>'status' IS DISTINCT FROM 'ready' OR o.evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb
    OR o.evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb OR o.evidence->'game_scope' IS DISTINCT FROM o.game_scope);
 END IF;
END $function$
;
ALTER FUNCTION public.fn_union_pnl_week_shaped_hands(uuid,timestamptz,timestamptz,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_union_pnl_week_shaped_hands(uuid,timestamptz,timestamptz,boolean) FROM PUBLIC,anon,authenticated,service_role;
DO $post$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_proc p WHERE p.oid='public.fn_union_pnl_week_shaped_hands(uuid,timestamptz,timestamptz,boolean)'::regprocedure AND md5(pg_get_functiondef(p.oid))='eda515d2a17344212d7c1a222dc0404d' AND md5(p.prosrc)='3b00a89bf56c2d8c95969b5fa4743bba' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.provolatile='s' AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=public, pg_temp']) THEN RAISE EXCEPTION 'weekly_shaped_postimage_refused'; END IF;
 IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN RAISE EXCEPTION 'weekly_shaped_post_source40_refused'; END IF;
END $post$;
COMMIT;
