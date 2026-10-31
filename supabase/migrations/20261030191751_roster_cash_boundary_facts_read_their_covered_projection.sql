-- Version reserved by scripts/new-migration.mjs.
-- Installed D2 preserves cash math but its 100-member boundary projection
-- still exceeded 8s fetching 38,895 heap tuples. The same keys-only read
-- took 504ms/zero heap fetches. Cover precisely the unchanged reader's payload.
-- No function, original index, financial source row or privilege changes.
-- Establish actual disk capacity and the existing 600s CCI budget BEFORE
-- dispatch. Inspect any interrupted INVALID prefix; never blindly retry it.
-- @live-proof: (SELECT indisvalid AND indisready AND indislive FROM pg_index WHERE indexrelid=to_regclass('public.ca_hand_facts_cash_member_time_cover'))
CREATE INDEX CONCURRENTLY IF NOT EXISTS ca_hand_facts_cash_member_time_cover
 ON public.ca_hand_facts(user_id,played_at)
 INCLUDE(table_id,hand_id,club_id,net) WHERE tournament_id IS NULL;
BEGIN;
SET LOCAL statement_timeout='5s';
SET LOCAL lock_timeout='1s';
DO $guard$
DECLARE
 v_before jsonb; v_after jsonb;
 v_snapshot CONSTANT text := $snapshot$
 SELECT jsonb_build_object(
  'generation',smarter_private.original_inventory_basis_generation(),
  'source_seal',pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure),
  'functions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid)FROM pg_proc p WHERE p.oid IN('public.ca_club_members_win_loss(uuid,uuid[],text)'::regprocedure,'public.ca_club_members_cash_window(uuid,uuid[],date,date)'::regprocedure)),
  'relation',(SELECT jsonb_build_object('kind',relkind,'persistence',relpersistence,'owner',relowner,'acl',relacl,'rls',relrowsecurity,'force_rls',relforcerowsecurity)FROM pg_class WHERE oid='public.ca_hand_facts'::regclass),
  'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',a.atttypid,'modifier',a.atttypmod,'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid))ORDER BY a.attnum)FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.ca_hand_facts'::regclass AND a.attnum>0 AND NOT a.attisdropped),
  'constraints',(SELECT jsonb_agg(jsonb_build_object('name',conname,'definition',pg_get_constraintdef(oid,true))ORDER BY conname)FROM pg_constraint WHERE conrelid='public.ca_hand_facts'::regclass),
  'indexes',(SELECT jsonb_agg(jsonb_build_object('oid',indexrelid,'definition',pg_get_indexdef(indexrelid))ORDER BY indexrelid)FROM pg_index WHERE indrelid='public.ca_hand_facts'::regclass AND indexrelid<>'public.ca_hand_facts_cash_member_time_cover'::regclass))
 $snapshot$;
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres'
  OR nullif(current_setting('request.jwt.claims',true),'')IS NOT NULL
  OR nullif(current_setting('request.jwt.claim.role',true),'')IS NOT NULL
  OR nullif(current_setting('request.jwt.claim.sub',true),'')IS NOT NULL
 THEN RAISE EXCEPTION 'roster_cash_cover_operator_refused';END IF;
 IF public.fn_ca_break_window_refuses_migrations(now())IS NOT NULL
  OR public.fn_platform_frozen()IS DISTINCT FROM false
  OR public.fn_active_maintenance_release_boundary()IS NOT NULL
 THEN RAISE EXCEPTION 'roster_cash_cover_window_refused';END IF;
 EXECUTE v_snapshot INTO v_before;
 IF smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true
  OR v_before->>'generation' IS NULL
 THEN RAISE EXCEPTION 'roster_cash_cover_current_source_generation_required';END IF;
 IF NOT EXISTS(SELECT FROM pg_class WHERE oid='public.ca_hand_facts'::regclass AND relkind='r' AND relpersistence='p' AND relowner='postgres'::regrole AND relrowsecurity AND NOT relforcerowsecurity AND relacl::text='{postgres=arwdDxtm/postgres,authenticated=r/postgres,service_role=arwdDxtm/postgres}')
 THEN RAISE EXCEPTION 'roster_cash_cover_source_access_changed';END IF;
 IF EXISTS(SELECT FROM(VALUES('hand_id','uuid',true),('user_id','uuid',true),('table_id','uuid',false),('club_id','uuid',false),('net','numeric',true),('played_at','timestamp with time zone',true),('tournament_id','uuid',false))x(name,type,not_null) LEFT JOIN pg_attribute a ON a.attrelid='public.ca_hand_facts'::regclass AND a.attname=x.name AND NOT a.attisdropped WHERE a.attname IS NULL OR format_type(a.atttypid,a.atttypmod)<>x.type OR a.attnotnull<>x.not_null)
 THEN RAISE EXCEPTION 'roster_cash_cover_projection_columns_changed';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc WHERE oid='public.ca_club_members_win_loss(uuid,uuid[],text)'::regprocedure AND proowner='postgres'::regrole AND md5(pg_get_functiondef(oid))='2c02c3c5ab3cff998243a34de1cec02c' AND proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}')
  OR NOT EXISTS(SELECT FROM pg_proc WHERE oid='public.ca_club_members_cash_window(uuid,uuid[],date,date)'::regprocedure AND proowner='postgres'::regrole AND md5(prosrc)='0af290178a97c7e49bdb8db65fa8cec1' AND proacl::text='{postgres=X/postgres}')
 THEN RAISE EXCEPTION 'roster_cash_cover_installed_reader_changed';END IF;
 IF NOT EXISTS(SELECT FROM pg_index WHERE indexrelid='public.ca_hand_facts_cash_member_time_idx'::regclass AND pg_get_indexdef(indexrelid)='CREATE INDEX ca_hand_facts_cash_member_time_idx ON public.ca_hand_facts USING btree (user_id, played_at) WHERE (tournament_id IS NULL)')
  OR EXISTS(SELECT FROM pg_index WHERE indrelid='public.ca_hand_facts'::regclass AND(NOT indisvalid OR NOT indisready OR NOT indislive))
 THEN RAISE EXCEPTION 'roster_cash_cover_existing_indexes_changed';END IF;
 IF NOT EXISTS(SELECT FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am m ON m.oid=c.relam WHERE i.indexrelid='public.ca_hand_facts_cash_member_time_cover'::regclass AND i.indrelid='public.ca_hand_facts'::regclass AND i.indisvalid AND i.indisready AND i.indislive AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion AND i.indnkeyatts=2 AND i.indnatts=6 AND i.indexprs IS NULL AND c.relowner='postgres'::regrole AND c.relkind='i' AND c.relpersistence='p' AND m.amname='btree' AND pg_get_indexdef(i.indexrelid)='CREATE INDEX ca_hand_facts_cash_member_time_cover ON public.ca_hand_facts USING btree (user_id, played_at) INCLUDE (table_id, hand_id, club_id, net) WHERE (tournament_id IS NULL)')
 THEN RAISE EXCEPTION 'roster_cash_cover_exact_valid_prefix_required';END IF;
 -- No public DDL or source writes follow the prefix. Keep the actual current
 -- generation, all original indexes and complete table/function metadata.
 EXECUTE v_snapshot INTO v_after;
 IF smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true OR v_after IS DISTINCT FROM v_before
 THEN RAISE EXCEPTION 'roster_cash_cover_original_source_changed';END IF;
END$guard$;
COMMIT;
