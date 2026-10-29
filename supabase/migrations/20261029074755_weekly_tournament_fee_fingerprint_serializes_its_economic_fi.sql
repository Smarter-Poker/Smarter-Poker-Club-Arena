-- Serialize the same 17 versioned economic fields once per fee fingerprint.
-- Prior object_agg repeatedly serialized the full 20-column row for each field.
-- JSONB canonical keys, SQL NULLs, numeric/timestamp representations and hashes stay identical.
-- Preserve every function attribute/ACL and the immutable unlimited admission ABI/guard.
-- No payout, source65, generation, ledger, balance, scheduler or TQ change.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_accounting_tournament_fee_fingerprint(public.rake_records)'::regprocedure))='89523554d8b64da3e73f8d82f9f9acbd')
BEGIN;
SET LOCAL search_path=public,pg_temp;SET LOCAL timezone='UTC';
SET LOCAL lock_timeout='1s';SET LOCAL statement_timeout='15s';
DO $fp_sources_before$DECLARE generation text;BEGIN
 IF current_user<>'postgres'OR session_user<>'postgres'OR auth.uid()IS NOT NULL
 OR NULLIF(current_setting('request.jwt.claims',true),'')IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.role',true),'')IS NOT NULL
 OR NULLIF(current_setting('ca.break_window_migration_override',true),'')IS NOT NULL THEN RAISE EXCEPTION 'weekly_fee_fp_operator_refused';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261029074755')THEN RAISE EXCEPTION 'weekly_fee_fp_history_replay';END IF;
 IF public.fn_ca_break_window_refuses_migrations(now())IS NOT NULL OR public.fn_platform_frozen()IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary()IS NOT NULL THEN RAISE EXCEPTION 'weekly_fee_fp_window_refused';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0))THEN RAISE EXCEPTION 'weekly_fee_fp_scheduler_owned';END IF;
 IF smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true THEN RAISE EXCEPTION 'weekly_fee_fp_source65_required';END IF;
 generation:=smarter_private.original_inventory_basis_generation();
 IF generation IS DISTINCT FROM 'original-inventory-245-v1:72b51e4349fc9cd371bfb7f771b7ae20' THEN RAISE EXCEPTION 'weekly_fee_fp_generation_required';END IF;
 PERFORM set_config('ca.weekly_fee_fp_qualification',jsonb_build_object('generation',generation,
 'seal_definition',pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure),
 'generation_definition',pg_get_functiondef('smarter_private.original_inventory_basis_generation()'::regprocedure),
 'rake_columns',(SELECT jsonb_agg(to_jsonb(t)ORDER BY attnum)FROM pg_attribute t WHERE attrelid='public.rake_records'::regclass AND attnum>0 AND NOT attisdropped))::text,true);
END $fp_sources_before$;
DO $fp_authority_before$DECLARE e jsonb;p pg_proc;actual jsonb;BEGIN
 FOR e IN SELECT value FROM jsonb_array_elements($admission_owners$[{"signature":"fn_ca_lock_mtt_admission_contract()","md5":"10644d522bb50245f76942ecce735cbc","metadata":{"oid":"35049258","proacl":["postgres=X/postgres"],"probin":null,"procost":100,"prokind":"f","prolang":"13573","proname":"fn_ca_lock_mtt_admission_contract","prorows":0,"pronargs":0,"proowner":"16384","proconfig":["search_path=pg_catalog, public"],"proretset":false,"prosecdef":true,"prorettype":"25","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"pronamespace":"2200","proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"fn_ca_read_mtt_admission_contract()","md5":"7f595febb21665580b47f8b992a5cf45","metadata":{"oid":"35059402","proacl":["postgres=X/postgres"],"probin":null,"procost":100,"prokind":"f","prolang":"13573","proname":"fn_ca_read_mtt_admission_contract","prorows":0,"pronargs":0,"proowner":"16384","proconfig":["search_path=pg_catalog, public"],"proretset":false,"prosecdef":true,"prorettype":"25","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"pronamespace":"2200","proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"fn_ca_guard_mtt_admission_contract()","md5":"98363a25bad4495a4b32e7cd99354c37","metadata":{"oid":"35049255","proacl":["postgres=X/postgres"],"probin":null,"procost":100,"prokind":"f","prolang":"13573","proname":"fn_ca_guard_mtt_admission_contract","prorows":0,"pronargs":0,"proowner":"16384","proconfig":["search_path=pg_catalog, public"],"proretset":false,"prosecdef":true,"prorettype":"2279","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"pronamespace":"2200","proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}}]$admission_owners$::jsonb)LOOP SELECT *INTO STRICT p FROM pg_proc WHERE oid=(e->>'signature')::regprocedure;
 IF md5(pg_get_functiondef(p.oid))IS DISTINCT FROM e->>'md5'OR to_jsonb(p)-'prosrc'IS DISTINCT FROM e->'metadata'THEN RAISE EXCEPTION 'weekly_fee_fp_admission_owner_changed';END IF;END LOOP;
 IF(SELECT jsonb_agg(to_jsonb(t)ORDER BY singleton)FROM public.ca_mtt_admission_contract t)IS DISTINCT FROM '[{"abi":"unlimited-mtt-v2","singleton":true}]'::jsonb THEN RAISE EXCEPTION 'weekly_fee_fp_admission_abi_changed';END IF;
 SELECT jsonb_agg(jsonb_build_object('name',tgname,'enabled',tgenabled,'definition',pg_get_triggerdef(oid))ORDER BY tgname)INTO actual FROM pg_trigger WHERE tgrelid='public.ca_mtt_admission_contract'::regclass AND NOT tgisinternal;
 IF actual IS DISTINCT FROM $admission_triggers$[{"name":"ca_mtt_admission_contract_immutable","enabled":"O","definition":"CREATE TRIGGER ca_mtt_admission_contract_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.ca_mtt_admission_contract FOR EACH ROW EXECUTE FUNCTION fn_ca_guard_mtt_admission_contract()"},{"name":"ca_mtt_admission_contract_no_truncate","enabled":"O","definition":"CREATE TRIGGER ca_mtt_admission_contract_no_truncate BEFORE TRUNCATE ON public.ca_mtt_admission_contract FOR EACH STATEMENT EXECUTE FUNCTION fn_ca_guard_mtt_admission_contract()"}]$admission_triggers$::jsonb THEN RAISE EXCEPTION 'weekly_fee_fp_admission_triggers_changed';END IF;
 SELECT jsonb_agg(jsonb_build_object('name',attname,'type',format_type(atttypid,atttypmod),'attnum',attnum)ORDER BY attnum)INTO actual FROM pg_attribute WHERE attrelid='public.rake_records'::regclass AND attnum>0 AND NOT attisdropped;
 IF actual IS DISTINCT FROM $rake_columns$[{"name":"id","type":"uuid","attnum":1},{"name":"hand_id","type":"uuid","attnum":2},{"name":"table_id","type":"uuid","attnum":3},{"name":"club_id","type":"uuid","attnum":4},{"name":"rake_amount","type":"numeric(18,4)","attnum":5},{"name":"bbj_contribution","type":"numeric(18,4)","attnum":6},{"name":"pot_size","type":"numeric(18,4)","attnum":7},{"name":"num_players","type":"integer","attnum":8},{"name":"created_at","type":"timestamp with time zone","attnum":9},{"name":"player_contributions","type":"jsonb","attnum":10},{"name":"global_hand_id","type":"bigint","attnum":11},{"name":"is_tournament","type":"boolean","attnum":12},{"name":"tournament_id","type":"uuid","attnum":13},{"name":"source","type":"text","attnum":14},{"name":"metadata","type":"jsonb","attnum":15},{"name":"rake_method","type":"text","attnum":16},{"name":"returned_uncalled","type":"jsonb","attnum":17},{"name":"terminal_closed_at","type":"timestamp with time zone","attnum":18},{"name":"seat_count_in_force","type":"integer","attnum":19},{"name":"max_rake_cap_in_force","type":"numeric(18,4)","attnum":20}]$rake_columns$::jsonb THEN RAISE EXCEPTION 'weekly_fee_fp_rake_columns_changed';END IF;
END $fp_authority_before$;
SET LOCAL statement_timeout='5s';
DO $fp_replace$DECLARE actual text;metadata jsonb;expected jsonb:=$fp_metadata${"oid":"34785501","proacl":["postgres=X/postgres"],"probin":null,"procost":100,"prokind":"f","prolang":"14","proname":"fn_accounting_tournament_fee_fingerprint","prorows":0,"pronargs":1,"proowner":"16384","proconfig":["search_path=public"],"proretset":false,"prosecdef":false,"prorettype":"25","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["p_row"],"proargtypes":["123163"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"i","proleakproof":false,"pronamespace":"2200","proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}$fp_metadata$::jsonb;
 old_definition constant text:=$fp_old$CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_fee_fingerprint(p_row rake_records)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
 -- Versioned economic fields are stable across unrelated schema additions.
 -- Tuple terminal markers are not economic source edits.
 SELECT md5(jsonb_object_agg(field,to_jsonb(p_row)->field ORDER BY field)::text)
 FROM unnest(ARRAY['id','hand_id','table_id','club_id','rake_amount','bbj_contribution','pot_size','num_players',
  'created_at','player_contributions','global_hand_id','is_tournament','tournament_id','source','metadata',
  'rake_method','returned_uncalled']::text[])field
$function$
$fp_old$;
 new_definition constant text:=$fp_new$CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_fee_fingerprint(p_row rake_records)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
 -- Versioned economic fields are stable across unrelated schema additions.
 -- Tuple terminal markers are not economic source edits.
 SELECT md5(jsonb_build_object('id',p_row.id,'hand_id',p_row.hand_id,'table_id',p_row.table_id,'club_id',p_row.club_id,'rake_amount',p_row.rake_amount,'bbj_contribution',p_row.bbj_contribution,'pot_size',p_row.pot_size,'num_players',p_row.num_players,'created_at',p_row.created_at,'player_contributions',p_row.player_contributions,'global_hand_id',p_row.global_hand_id,'is_tournament',p_row.is_tournament,'tournament_id',p_row.tournament_id,'source',p_row.source,'metadata',p_row.metadata,'rake_method',p_row.rake_method,'returned_uncalled',p_row.returned_uncalled)::text)
$function$
$fp_new$;
BEGIN
 SELECT pg_get_functiondef(p.oid),to_jsonb(p)-'prosrc'INTO STRICT actual,metadata FROM pg_proc p WHERE oid='public.fn_accounting_tournament_fee_fingerprint(public.rake_records)'::regprocedure;
 IF actual IS DISTINCT FROM old_definition OR metadata IS DISTINCT FROM expected OR md5(actual)<>'dd55cceba87b1578472171e1c80ba1fb' THEN RAISE EXCEPTION 'weekly_fee_fp_exact_preimage_required';END IF;
 IF md5(new_definition)<>'89523554d8b64da3e73f8d82f9f9acbd' THEN RAISE EXCEPTION 'weekly_fee_fp_exact_patch_required';END IF;
 EXECUTE new_definition;
 IF pg_get_functiondef('public.fn_accounting_tournament_fee_fingerprint(public.rake_records)'::regprocedure)IS DISTINCT FROM new_definition
 OR(SELECT to_jsonb(p)-'prosrc'FROM pg_proc p WHERE oid='public.fn_accounting_tournament_fee_fingerprint(public.rake_records)'::regprocedure)IS DISTINCT FROM metadata THEN RAISE EXCEPTION 'weekly_fee_fp_exact_postimage_required';END IF;
END $fp_replace$;
SET LOCAL statement_timeout='15s';
DO $fp_authority_after$DECLARE e jsonb;p pg_proc;actual jsonb;BEGIN
 FOR e IN SELECT value FROM jsonb_array_elements($admission_owners$[{"signature":"fn_ca_lock_mtt_admission_contract()","md5":"10644d522bb50245f76942ecce735cbc","metadata":{"oid":"35049258","proacl":["postgres=X/postgres"],"probin":null,"procost":100,"prokind":"f","prolang":"13573","proname":"fn_ca_lock_mtt_admission_contract","prorows":0,"pronargs":0,"proowner":"16384","proconfig":["search_path=pg_catalog, public"],"proretset":false,"prosecdef":true,"prorettype":"25","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"pronamespace":"2200","proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"fn_ca_read_mtt_admission_contract()","md5":"7f595febb21665580b47f8b992a5cf45","metadata":{"oid":"35059402","proacl":["postgres=X/postgres"],"probin":null,"procost":100,"prokind":"f","prolang":"13573","proname":"fn_ca_read_mtt_admission_contract","prorows":0,"pronargs":0,"proowner":"16384","proconfig":["search_path=pg_catalog, public"],"proretset":false,"prosecdef":true,"prorettype":"25","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"pronamespace":"2200","proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"fn_ca_guard_mtt_admission_contract()","md5":"98363a25bad4495a4b32e7cd99354c37","metadata":{"oid":"35049255","proacl":["postgres=X/postgres"],"probin":null,"procost":100,"prokind":"f","prolang":"13573","proname":"fn_ca_guard_mtt_admission_contract","prorows":0,"pronargs":0,"proowner":"16384","proconfig":["search_path=pg_catalog, public"],"proretset":false,"prosecdef":true,"prorettype":"2279","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"pronamespace":"2200","proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}}]$admission_owners$::jsonb)LOOP SELECT *INTO STRICT p FROM pg_proc WHERE oid=(e->>'signature')::regprocedure;
 IF md5(pg_get_functiondef(p.oid))IS DISTINCT FROM e->>'md5'OR to_jsonb(p)-'prosrc'IS DISTINCT FROM e->'metadata'THEN RAISE EXCEPTION 'weekly_fee_fp_admission_owner_changed';END IF;END LOOP;
 IF(SELECT jsonb_agg(to_jsonb(t)ORDER BY singleton)FROM public.ca_mtt_admission_contract t)IS DISTINCT FROM '[{"abi":"unlimited-mtt-v2","singleton":true}]'::jsonb THEN RAISE EXCEPTION 'weekly_fee_fp_admission_abi_changed';END IF;
 SELECT jsonb_agg(jsonb_build_object('name',tgname,'enabled',tgenabled,'definition',pg_get_triggerdef(oid))ORDER BY tgname)INTO actual FROM pg_trigger WHERE tgrelid='public.ca_mtt_admission_contract'::regclass AND NOT tgisinternal;
 IF actual IS DISTINCT FROM $admission_triggers$[{"name":"ca_mtt_admission_contract_immutable","enabled":"O","definition":"CREATE TRIGGER ca_mtt_admission_contract_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.ca_mtt_admission_contract FOR EACH ROW EXECUTE FUNCTION fn_ca_guard_mtt_admission_contract()"},{"name":"ca_mtt_admission_contract_no_truncate","enabled":"O","definition":"CREATE TRIGGER ca_mtt_admission_contract_no_truncate BEFORE TRUNCATE ON public.ca_mtt_admission_contract FOR EACH STATEMENT EXECUTE FUNCTION fn_ca_guard_mtt_admission_contract()"}]$admission_triggers$::jsonb THEN RAISE EXCEPTION 'weekly_fee_fp_admission_triggers_changed';END IF;
 SELECT jsonb_agg(jsonb_build_object('name',attname,'type',format_type(atttypid,atttypmod),'attnum',attnum)ORDER BY attnum)INTO actual FROM pg_attribute WHERE attrelid='public.rake_records'::regclass AND attnum>0 AND NOT attisdropped;
 IF actual IS DISTINCT FROM $rake_columns$[{"name":"id","type":"uuid","attnum":1},{"name":"hand_id","type":"uuid","attnum":2},{"name":"table_id","type":"uuid","attnum":3},{"name":"club_id","type":"uuid","attnum":4},{"name":"rake_amount","type":"numeric(18,4)","attnum":5},{"name":"bbj_contribution","type":"numeric(18,4)","attnum":6},{"name":"pot_size","type":"numeric(18,4)","attnum":7},{"name":"num_players","type":"integer","attnum":8},{"name":"created_at","type":"timestamp with time zone","attnum":9},{"name":"player_contributions","type":"jsonb","attnum":10},{"name":"global_hand_id","type":"bigint","attnum":11},{"name":"is_tournament","type":"boolean","attnum":12},{"name":"tournament_id","type":"uuid","attnum":13},{"name":"source","type":"text","attnum":14},{"name":"metadata","type":"jsonb","attnum":15},{"name":"rake_method","type":"text","attnum":16},{"name":"returned_uncalled","type":"jsonb","attnum":17},{"name":"terminal_closed_at","type":"timestamp with time zone","attnum":18},{"name":"seat_count_in_force","type":"integer","attnum":19},{"name":"max_rake_cap_in_force","type":"numeric(18,4)","attnum":20}]$rake_columns$::jsonb THEN RAISE EXCEPTION 'weekly_fee_fp_rake_columns_changed';END IF;
END $fp_authority_after$;
DO $fp_sources_after$DECLARE witness jsonb;BEGIN
 witness:=NULLIF(current_setting('ca.weekly_fee_fp_qualification',true),'')::jsonb;
 IF witness IS NULL THEN RAISE EXCEPTION 'weekly_fee_fp_qualification_required';END IF;
 IF smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true THEN RAISE EXCEPTION 'weekly_fee_fp_source65_required';END IF;
 IF smarter_private.original_inventory_basis_generation()IS DISTINCT FROM witness->>'generation'
 OR pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure)IS DISTINCT FROM witness->>'seal_definition'
 OR pg_get_functiondef('smarter_private.original_inventory_basis_generation()'::regprocedure)IS DISTINCT FROM witness->>'generation_definition'
 THEN RAISE EXCEPTION 'weekly_fee_fp_generation_required';END IF;
 IF(SELECT jsonb_agg(to_jsonb(t)ORDER BY attnum)FROM pg_attribute t WHERE attrelid='public.rake_records'::regclass AND attnum>0 AND NOT attisdropped)IS DISTINCT FROM witness->'rake_columns'THEN RAISE EXCEPTION 'weekly_fee_fp_rake_columns_changed';END IF;
END $fp_sources_after$;
SET LOCAL statement_timeout='5s';
COMMIT;
