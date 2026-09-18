-- SOURCE-ONLY / NATIVE UNRUN. Private disposable PG17 provider supplement; never production installation.
-- psql -v execution_uuid=<canonical v4 UUID>; exact qual_spin_expiry_<compact UUID>, postgres, Unix socket only.
-- Owning runner must provide resource/namespace admission, source custody, deadline, stop and disposal.
-- No business rows, financial stubs, helper invocations or successful fee/terminal receipts are created here.
-- Captured authority: 2026-09-17T23:52:59.30389+00:00; catalog: 2026-09-17T23:53:24.984021+00:00.
-- authority.json SHA256 193d8f25921068b2e4402d4d4b3861195917542b67a95fc854d6844842a29bd2
-- catalog.json SHA256 329b95dfe4489c1099502e517005904d014d1e6fe2630f66433361aaec99b418
-- Source dependency closure remains incomplete: net-plan/recognizer/stamp closure is a separately owned leaf.
-- Installing definitions is not financial, terminal, lane, replay or historical qualification.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='20s';
SET LOCAL lock_timeout='1s';
SET LOCAL search_path=pg_catalog,public,pg_temp;
SELECT set_config('qualification.execution_uuid', :'execution_uuid', true) AS execution_uuid;
-- Authentic Spin base preimage, independently extracted from schema.sql/access.sql; all unexpected drift refuses.
-- Base schema SHA256 5a5966afca3b2c9699aba326baf5f32d6c0e1baa2ad09340feaa3b23f4d9dc0a; access SHA256 ad2cb0ddc955bd97c9ef719e9106aad9f55be5cf034e014d04c90b3a1667c541.
DO $guard$
DECLARE expected jsonb;actual jsonb;prior jsonb;target jsonb;old_functions jsonb:=$captured$[{"signature":"fn_accounting_tournament_bank_proof(uuid,timestamp with time zone,uuid,uuid,numeric,uuid,uuid)","absent":true},{"signature":"fn_accounting_tournament_fee_fingerprint(rake_records)","absent":true},{"signature":"fn_accounting_tournament_terminal_fee_receipt(uuid)","absent":true},{"signature":"fn_ca_lock_settlement_lane_for_finish(uuid)","absent":true},{"signature":"fn_ca_lock_settlement_lane_global()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"6b4cf15d9a7cd253e957e1571b300f40","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_ca_settlement_lane_doctrine()","absent":true},{"signature":"fn_ca_tournament_terminal_receipt(uuid,uuid)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public","statement_timeout=30s"],"full_md5":"317b582f72d120c745a5b7073d9b559a","volatility":"s","security_definer":true,"kind":"f"},{"signature":"fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public","statement_timeout=45s"],"full_md5":"062c9a1314f33a5c8af4fdf5e00a046d","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_complete_tournament_terminal(uuid,uuid,text)","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp","statement_timeout=45s"],"full_md5":"480be3139fe0878e637ce54f533a2170","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_lock_accounting_tournament_recognition_week(uuid,timestamp with time zone)","absent":true},{"signature":"fn_settle_tournament_places(uuid,uuid)","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public","statement_timeout=30s"],"full_md5":"c412c8b17186976df139f73a706175f2","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_settle_tournament_rake(uuid,text)","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp","statement_timeout=30s"],"full_md5":"7cf1d81246d015b65d416ee6b3f96838","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_union_week_start(timestamp with time zone)","owner":"postgres","acl":"{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}","config":["search_path=public, extensions"],"full_md5":"103f192a228084dad0e4268c36c82c4b","volatility":"i","security_definer":false,"kind":"f"},{"signature":"fn_accounting_agreement_history_immutable()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"3fa4099435ff1e9d5c48fa1934b63549","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_accounting_tournament_fee_receipt_immutable()","absent":true},{"signature":"fn_tournament_terminal_receipts_are_append_only()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"618843a6d0646709dac2a9c3b24a7652","volatility":"v","security_definer":false,"kind":"f"}]$captured$::jsonb;new_functions jsonb:=$captured$[{"signature":"fn_accounting_tournament_bank_proof(uuid,timestamp with time zone,uuid,uuid,numeric,uuid,uuid)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"e56aa8c8280c59e2f0406ea6c504dc4e","volatility":"s","security_definer":true,"kind":"f"},{"signature":"fn_accounting_tournament_fee_fingerprint(rake_records)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"dd55cceba87b1578472171e1c80ba1fb","volatility":"i","security_definer":false,"kind":"f"},{"signature":"fn_accounting_tournament_terminal_fee_receipt(uuid)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"6e446f6d6d19ec8b28b31d124a8c6ac3","volatility":"s","security_definer":true,"kind":"f"},{"signature":"fn_ca_lock_settlement_lane_for_finish(uuid)","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"76e4c6b5291bab20f0cfc65dd060022b","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_ca_lock_settlement_lane_global()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"7c759bb7a639c3124de2607bdbf12577","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_ca_settlement_lane_doctrine()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"8dd361600c8facb1cbb99b3df853e5b9","volatility":"s","security_definer":true,"kind":"f"},{"signature":"fn_ca_tournament_terminal_receipt(uuid,uuid)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public","statement_timeout=30s"],"full_md5":"787eb9a718a648ac29753dfc9234f4c3","volatility":"s","security_definer":true,"kind":"f"},{"signature":"fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public","statement_timeout=45s"],"full_md5":"6a45fe9bf30c94f9366ec88f0863087e","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_complete_tournament_terminal(uuid,uuid,text)","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp","statement_timeout=45s"],"full_md5":"c64e049911fd99c1d784cdb042ca714b","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_lock_accounting_tournament_recognition_week(uuid,timestamp with time zone)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"d5339cec8b0e00be748c4c15bc3dba83","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_settle_tournament_places(uuid,uuid)","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public","statement_timeout=30s"],"full_md5":"c412c8b17186976df139f73a706175f2","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_settle_tournament_rake(uuid,text)","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp","statement_timeout=30s"],"full_md5":"0492f5a78bc3c84d54c24fd45549a0be","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_union_week_start(timestamp with time zone)","owner":"postgres","acl":"{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}","config":["search_path=public, extensions"],"full_md5":"103f192a228084dad0e4268c36c82c4b","volatility":"i","security_definer":false,"kind":"f"},{"signature":"fn_accounting_agreement_history_immutable()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"3fa4099435ff1e9d5c48fa1934b63549","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_accounting_tournament_fee_receipt_immutable()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"bdc4ee4b75e3471cd33a5ed4b250ec0f","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_tournament_terminal_receipts_are_append_only()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"618843a6d0646709dac2a9c3b24a7652","volatility":"v","security_definer":false,"kind":"f"}]$captured$::jsonb;
BEGIN
  IF session_user<>'postgres' OR current_user<>'postgres'
     OR current_setting('server_version_num')::integer/10000<>17
     OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>''
     OR current_setting('session_replication_role')<>'origin'
     OR current_setting('qualification.execution_uuid') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR current_database()<>'qual_spin_expiry_'||replace(current_setting('qualification.execution_uuid'),'-','') THEN
    RAISE EXCEPTION 'current accounting catalog requires its exact private PG17 Unix-socket allocation' USING ERRCODE='55000';
  END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'restore requires read committed'; END IF;
  IF to_regclass('public.accounting_routed_settlement_runs') IS NOT NULL THEN RAISE EXCEPTION 'accounting provider requires absent new relation: accounting_routed_settlement_runs'; END IF;
  IF to_regclass('public.accounting_tournament_fee_batches') IS NOT NULL THEN RAISE EXCEPTION 'accounting provider requires absent new relation: accounting_tournament_fee_batches'; END IF;
  IF to_regclass('public.accounting_tournament_fee_recognitions') IS NOT NULL THEN RAISE EXCEPTION 'accounting provider requires absent new relation: accounting_tournament_fee_recognitions'; END IF;
  IF to_regclass('public.accounting_tournament_fee_sources') IS NOT NULL THEN RAISE EXCEPTION 'accounting provider requires absent new relation: accounting_tournament_fee_sources'; END IF;
  IF to_regclass('public.accounting_tournament_recognized_sources') IS NOT NULL THEN RAISE EXCEPTION 'accounting provider requires absent new relation: accounting_tournament_recognized_sources'; END IF;
  expected:=$captured${"acl":"{postgres=arwdDxtm/postgres}","rls":true,"name":"tournament_terminal_settlements","owner":"postgres","columns":[{"name":"tournament_id","type":"uuid","number":1,"default":null,"identity":"","not_null":true,"generated":""},{"name":"winner_id","type":"uuid","number":2,"default":null,"identity":"","not_null":true,"generated":""},{"name":"settlement_mode","type":"text","number":3,"default":null,"identity":"","not_null":true,"generated":""},{"name":"started_status","type":"text","number":4,"default":null,"identity":"","not_null":true,"generated":""},{"name":"prize_pool","type":"numeric(15,2)","number":5,"default":null,"identity":"","not_null":true,"generated":""},{"name":"bounty_pool","type":"numeric(15,2)","number":6,"default":null,"identity":"","not_null":true,"generated":""},{"name":"cash_payout_count","type":"integer","number":7,"default":null,"identity":"","not_null":true,"generated":""},{"name":"cash_payout_total","type":"numeric(15,2)","number":8,"default":null,"identity":"","not_null":true,"generated":""},{"name":"bounty_payout_total","type":"numeric(15,2)","number":9,"default":null,"identity":"","not_null":true,"generated":""},{"name":"mystery_was_active","type":"boolean","number":10,"default":null,"identity":"","not_null":true,"generated":""},{"name":"mystery_pool_cents","type":"bigint","number":11,"default":null,"identity":"","not_null":true,"generated":""},{"name":"cash_receipt","type":"jsonb","number":12,"default":null,"identity":"","not_null":true,"generated":""},{"name":"mystery_receipt","type":"jsonb","number":13,"default":null,"identity":"","not_null":true,"generated":""},{"name":"bounty_receipt","type":"jsonb","number":14,"default":null,"identity":"","not_null":true,"generated":""},{"name":"closed_table_count","type":"integer","number":15,"default":null,"identity":"","not_null":true,"generated":""},{"name":"closed_table_ids","type":"uuid[]","number":16,"default":null,"identity":"","not_null":true,"generated":""},{"name":"source_seat_count","type":"integer","number":17,"default":null,"identity":"","not_null":true,"generated":""},{"name":"source_seat_ids","type":"uuid[]","number":18,"default":null,"identity":"","not_null":true,"generated":""},{"name":"released_seat_count","type":"integer","number":19,"default":null,"identity":"","not_null":true,"generated":""},{"name":"released_seat_ids","type":"uuid[]","number":20,"default":null,"identity":"","not_null":true,"generated":""},{"name":"rake_amount","type":"numeric(15,2)","number":21,"default":null,"identity":"","not_null":true,"generated":""},{"name":"rake_destination","type":"text","number":22,"default":null,"identity":"","not_null":true,"generated":""},{"name":"rake_settled_at","type":"timestamp with time zone","number":23,"default":null,"identity":"","not_null":true,"generated":""},{"name":"rake_attributed_at","type":"timestamp with time zone","number":24,"default":null,"identity":"","not_null":true,"generated":""},{"name":"rake_attributed_users","type":"integer","number":25,"default":null,"identity":"","not_null":true,"generated":""},{"name":"escrow_closed_at","type":"timestamp with time zone","number":26,"default":null,"identity":"","not_null":true,"generated":""},{"name":"escrow_close_note","type":"text","number":27,"default":null,"identity":"","not_null":true,"generated":""},{"name":"completed_at","type":"timestamp with time zone","number":28,"default":null,"identity":"","not_null":true,"generated":""},{"name":"settled_at","type":"timestamp with time zone","number":29,"default":"transaction_timestamp()","identity":"","not_null":true,"generated":""},{"name":"receipt_version","type":"integer","number":30,"default":"1","identity":"","not_null":true,"generated":""}],"indexes":["CREATE UNIQUE INDEX tournament_terminal_settlements_pkey ON public.tournament_terminal_settlements USING btree (tournament_id)"],"policies":null,"triggers":[{"name":"tournament_terminal_settlements_append_only","enabled":"O","function":"fn_tournament_terminal_receipts_are_append_only()","definition":"CREATE TRIGGER tournament_terminal_settlements_append_only BEFORE DELETE OR UPDATE ON public.tournament_terminal_settlements FOR EACH ROW EXECUTE FUNCTION fn_tournament_terminal_receipts_are_append_only()"}],"force_rls":false,"constraints":[{"name":"tournament_terminal_settlements_bounty_payout_total_check","validated":true,"definition":"CHECK (((bounty_payout_total >= (0)::numeric) AND (bounty_payout_total = round(bounty_payout_total, 2))))"},{"name":"tournament_terminal_settlements_bounty_pool_check","validated":true,"definition":"CHECK (((bounty_pool >= (0)::numeric) AND (bounty_pool = round(bounty_pool, 2))))"},{"name":"tournament_terminal_settlements_bounty_receipt_check","validated":true,"definition":"CHECK ((jsonb_typeof(bounty_receipt) = 'object'::text))"},{"name":"tournament_terminal_settlements_cash_payout_count_check","validated":true,"definition":"CHECK ((cash_payout_count >= 0))"},{"name":"tournament_terminal_settlements_cash_payout_total_check","validated":true,"definition":"CHECK (((cash_payout_total >= (0)::numeric) AND (cash_payout_total = round(cash_payout_total, 2))))"},{"name":"tournament_terminal_settlements_cash_receipt_check","validated":true,"definition":"CHECK ((jsonb_typeof(cash_receipt) = 'object'::text))"},{"name":"tournament_terminal_settlements_check","validated":true,"definition":"CHECK ((cash_payout_total = prize_pool))"},{"name":"tournament_terminal_settlements_check1","validated":true,"definition":"CHECK ((bounty_payout_total = bounty_pool))"},{"name":"tournament_terminal_settlements_check2","validated":true,"definition":"CHECK (((mystery_was_active AND (mystery_pool_cents > 0)) OR ((NOT mystery_was_active) AND (mystery_pool_cents = 0))))"},{"name":"tournament_terminal_settlements_check3","validated":true,"definition":"CHECK ((closed_table_count = cardinality(closed_table_ids)))"},{"name":"tournament_terminal_settlements_check4","validated":true,"definition":"CHECK ((source_seat_count = cardinality(source_seat_ids)))"},{"name":"tournament_terminal_settlements_check5","validated":true,"definition":"CHECK ((released_seat_count = cardinality(released_seat_ids)))"},{"name":"tournament_terminal_settlements_check6","validated":true,"definition":"CHECK ((released_seat_ids <@ source_seat_ids))"},{"name":"tournament_terminal_settlements_check7","validated":true,"definition":"CHECK (((rake_settled_at <= settled_at) AND (rake_attributed_at <= settled_at)))"},{"name":"tournament_terminal_settlements_check8","validated":true,"definition":"CHECK ((escrow_closed_at <= settled_at))"},{"name":"tournament_terminal_settlements_check9","validated":true,"definition":"CHECK ((completed_at <= settled_at))"},{"name":"tournament_terminal_settlements_closed_table_count_check","validated":true,"definition":"CHECK ((closed_table_count >= 0))"},{"name":"tournament_terminal_settlements_closed_table_ids_check","validated":true,"definition":"CHECK ((array_position(closed_table_ids, NULL::uuid) IS NULL))"},{"name":"tournament_terminal_settlements_escrow_close_note_check","validated":true,"definition":"CHECK ((length(btrim(escrow_close_note)) > 0))"},{"name":"tournament_terminal_settlements_mystery_pool_cents_check","validated":true,"definition":"CHECK ((mystery_pool_cents >= 0))"},{"name":"tournament_terminal_settlements_mystery_receipt_check","validated":true,"definition":"CHECK ((jsonb_typeof(mystery_receipt) = 'object'::text))"},{"name":"tournament_terminal_settlements_pkey","validated":true,"definition":"PRIMARY KEY (tournament_id)"},{"name":"tournament_terminal_settlements_prize_pool_check","validated":true,"definition":"CHECK (((prize_pool >= (0)::numeric) AND (prize_pool = round(prize_pool, 2))))"},{"name":"tournament_terminal_settlements_rake_amount_check","validated":true,"definition":"CHECK (((rake_amount >= (0)::numeric) AND (rake_amount = round(rake_amount, 2))))"},{"name":"tournament_terminal_settlements_rake_attributed_users_check","validated":true,"definition":"CHECK ((rake_attributed_users >= 0))"},{"name":"tournament_terminal_settlements_rake_destination_check","validated":true,"definition":"CHECK ((length(btrim(rake_destination)) > 0))"},{"name":"tournament_terminal_settlements_receipt_version_check","validated":true,"definition":"CHECK ((receipt_version = 1))"},{"name":"tournament_terminal_settlements_released_seat_count_check","validated":true,"definition":"CHECK ((released_seat_count >= 0))"},{"name":"tournament_terminal_settlements_released_seat_ids_check","validated":true,"definition":"CHECK ((array_position(released_seat_ids, NULL::uuid) IS NULL))"},{"name":"tournament_terminal_settlements_settlement_mode_check","validated":true,"definition":"CHECK ((settlement_mode = ANY (ARRAY['places'::text, 'final_table_deal'::text])))"},{"name":"tournament_terminal_settlements_source_seat_count_check","validated":true,"definition":"CHECK ((source_seat_count >= 0))"},{"name":"tournament_terminal_settlements_source_seat_ids_check","validated":true,"definition":"CHECK ((array_position(source_seat_ids, NULL::uuid) IS NULL))"},{"name":"tournament_terminal_settlements_started_status_check","validated":true,"definition":"CHECK ((started_status = ANY (ARRAY['RUNNING'::text, 'COMPLETING'::text])))"},{"name":"tournament_terminal_settlements_tournament_id_fkey","validated":true,"definition":"FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE RESTRICT"}]}$captured$::jsonb;
  SELECT jsonb_build_object(
 'name',cl.relname,'owner',pg_get_userbyid(cl.relowner),'acl',cl.relacl::text,
 'rls',cl.relrowsecurity,'force_rls',cl.relforcerowsecurity,
 'columns',(SELECT jsonb_agg(jsonb_build_object('name',at.attname,'type',format_type(at.atttypid,at.atttypmod),
   'number',at.attnum,'default',pg_get_expr(ad.adbin,ad.adrelid),'identity',at.attidentity,
   'not_null',at.attnotnull,'generated',at.attgenerated) ORDER BY at.attnum)
   FROM pg_attribute at LEFT JOIN pg_attrdef ad ON ad.adrelid=at.attrelid AND ad.adnum=at.attnum
   WHERE at.attrelid=cl.oid AND at.attnum>0 AND NOT at.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_object('name',co.conname,'validated',co.convalidated,
   'definition',pg_get_constraintdef(co.oid,false)) ORDER BY co.conname) FROM pg_constraint co WHERE co.conrelid=cl.oid),
 'indexes',(SELECT jsonb_agg(pg_get_indexdef(ix.indexrelid) ORDER BY ci.relname)
   FROM pg_index ix JOIN pg_class ci ON ci.oid=ix.indexrelid WHERE ix.indrelid=cl.oid),
 'policies',(SELECT CASE WHEN count(*)=0 THEN NULL::jsonb ELSE jsonb_build_object('unexpected_policy_count',count(*)) END
   FROM pg_policy po WHERE po.polrelid=cl.oid),
 'triggers',(SELECT jsonb_agg(jsonb_build_object('name',tr.tgname,'enabled',tr.tgenabled,
   'function',tr.tgfoid::regprocedure::text,'definition',pg_get_triggerdef(tr.oid,false)) ORDER BY tr.tgname)
   FROM pg_trigger tr WHERE tr.tgrelid=cl.oid AND NOT tr.tgisinternal))
 FROM pg_class cl JOIN pg_namespace ns ON ns.oid=cl.relnamespace
 WHERE ns.nspname='public' AND cl.relname=expected->>'name' AND cl.relkind='r' INTO actual;
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'terminal table preimage differs from the captured known accounting upgrade' USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT 1 FROM public.tournament_terminal_settlements) THEN RAISE EXCEPTION 'terminal table must be empty before its guarded fixture upgrade'; END IF;
  PERFORM set_config('qualification.accounting_terminal_oid','public.tournament_terminal_settlements'::regclass::oid::text,true);
  FOR expected IN SELECT value FROM jsonb_array_elements(new_functions) LOOP
    SELECT jsonb_build_object('signature',expected->>'signature','owner',pg_get_userbyid(pr.proowner),
 'acl',pr.proacl::text,'config',to_jsonb(pr.proconfig),'full_md5',md5(pg_get_functiondef(pr.oid)),
 'volatility',pr.provolatile,'security_definer',pr.prosecdef,'kind',pr.prokind)
 FROM pg_proc pr WHERE pr.oid=to_regprocedure('public.'||(expected->>'signature')) INTO actual;
    SELECT value INTO prior FROM jsonb_array_elements(old_functions) WHERE value->>'signature'=expected->>'signature';
    IF actual IS DISTINCT FROM expected AND NOT ((COALESCE((prior->>'absent')::boolean,false) AND actual IS NULL) OR (NOT (prior ? 'absent') AND actual IS NOT DISTINCT FROM prior)) THEN
      RAISE EXCEPTION 'function preimage drift: %',expected->>'signature' USING ERRCODE='55000';
    END IF;
  END LOOP;
END $guard$;
CREATE TABLE public."accounting_routed_settlement_runs" (
  "union_id" uuid,
  "period_start" timestamp with time zone NOT NULL,
  "period_end" timestamp with time zone NOT NULL,
  "round_no" integer NOT NULL,
  "routing_version" integer DEFAULT 3 NOT NULL,
  "source_fingerprint" text NOT NULL,
  "result" jsonb NOT NULL,
  "completed_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  "standalone_club_id" uuid,
  "scope_kind" text GENERATED ALWAYS AS (
CASE
    WHEN (union_id IS NULL) THEN 'club'::text
    ELSE 'union'::text
END) STORED NOT NULL,
  "scope_id" uuid GENERATED ALWAYS AS (COALESCE(union_id, standalone_club_id)) STORED NOT NULL
);
CREATE TABLE public."accounting_tournament_fee_batches" (
  "rake_record_id" uuid NOT NULL,
  "tournament_id" uuid NOT NULL,
  "source_fingerprint" text NOT NULL,
  "status" text DEFAULT 'captured'::text NOT NULL,
  "source_version" integer DEFAULT 2 NOT NULL,
  "source_manifest" jsonb,
  "rake_amount" numeric NOT NULL,
  "captured_at" timestamp with time zone DEFAULT transaction_timestamp() NOT NULL
);
CREATE TABLE public."accounting_tournament_fee_recognitions" (
  "tournament_id" uuid NOT NULL,
  "recognized_at" timestamp with time zone NOT NULL,
  "status" text NOT NULL,
  "net_rake" numeric NOT NULL,
  "union_id" uuid,
  "bank_club_id" uuid,
  "union_wallet_transaction_id" uuid,
  "bank_journal_id" uuid,
  "source_fingerprint" text NOT NULL,
  "plan" jsonb NOT NULL
);
CREATE TABLE public."accounting_tournament_fee_sources" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "rake_record_id" uuid NOT NULL,
  "tournament_id" uuid NOT NULL,
  "player_id" uuid NOT NULL,
  "club_id" uuid NOT NULL,
  "union_id" uuid,
  "coordinator_union_id" uuid,
  "game_type" text NOT NULL,
  "registration_id" uuid NOT NULL,
  "source_charge_ledger_id" uuid NOT NULL,
  "source_entitlement_id" uuid NOT NULL,
  "charged_at" timestamp with time zone NOT NULL,
  "rake_credit" numeric NOT NULL,
  "contract" jsonb NOT NULL,
  "recorded_at" timestamp with time zone DEFAULT transaction_timestamp() NOT NULL
);
CREATE TABLE public."accounting_tournament_recognized_sources" (
  "source_id" uuid NOT NULL,
  "tournament_id" uuid NOT NULL,
  "recognized_at" timestamp with time zone NOT NULL,
  "disposition" text NOT NULL,
  "rake_credit" numeric NOT NULL
);
ALTER TABLE public."accounting_routed_settlement_runs" ADD CONSTRAINT "accounting_routed_run_one_scope" CHECK ((num_nonnulls(union_id, standalone_club_id) = 1));
ALTER TABLE public."accounting_routed_settlement_runs" ADD CONSTRAINT "accounting_routed_settlement_runs_check" CHECK ((period_start < period_end));
ALTER TABLE public."accounting_routed_settlement_runs" ADD CONSTRAINT "accounting_routed_settlement_runs_pkey" PRIMARY KEY (scope_kind, scope_id, period_start, period_end, round_no);
ALTER TABLE public."accounting_routed_settlement_runs" ADD CONSTRAINT "accounting_routed_settlement_runs_round_no_check" CHECK ((round_no = ANY (ARRAY[2, 3])));
ALTER TABLE public."accounting_routed_settlement_runs" ADD CONSTRAINT "accounting_routed_settlement_runs_routing_version_check" CHECK ((routing_version = 3));
ALTER TABLE public."accounting_tournament_fee_batches" ADD CONSTRAINT "accounting_tournament_fee_batches_check" CHECK (((status = 'legacy_unverified'::text) OR (jsonb_typeof(source_manifest) = 'object'::text)));
ALTER TABLE public."accounting_tournament_fee_batches" ADD CONSTRAINT "accounting_tournament_fee_batches_pkey" PRIMARY KEY (rake_record_id);
ALTER TABLE public."accounting_tournament_fee_batches" ADD CONSTRAINT "accounting_tournament_fee_batches_rake_amount_check" CHECK (((rake_amount > (0)::numeric) AND (rake_amount = round(rake_amount, 2)) AND ((rake_amount)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text]))));
ALTER TABLE public."accounting_tournament_fee_batches" ADD CONSTRAINT "accounting_tournament_fee_batches_source_version_check" CHECK ((source_version = 2));
ALTER TABLE public."accounting_tournament_fee_batches" ADD CONSTRAINT "accounting_tournament_fee_batches_status_check" CHECK ((status = ANY (ARRAY['captured'::text, 'legacy_unverified'::text])));
ALTER TABLE public."accounting_tournament_fee_recognitions" ADD CONSTRAINT "accounting_tournament_fee_recog_union_wallet_transaction_id_key" UNIQUE (union_wallet_transaction_id);
ALTER TABLE public."accounting_tournament_fee_recognitions" ADD CONSTRAINT "accounting_tournament_fee_recognitions_bank_journal_id_key" UNIQUE (bank_journal_id);
ALTER TABLE public."accounting_tournament_fee_recognitions" ADD CONSTRAINT "accounting_tournament_fee_recognitions_check" CHECK (((net_rake = (0)::numeric) OR (bank_club_id IS NOT NULL)));
ALTER TABLE public."accounting_tournament_fee_recognitions" ADD CONSTRAINT "accounting_tournament_fee_recognitions_check1" CHECK ((((net_rake = (0)::numeric) AND (union_wallet_transaction_id IS NULL) AND (bank_journal_id IS NULL)) OR ((net_rake > (0)::numeric) AND ((((union_wallet_transaction_id IS NOT NULL))::integer + ((bank_journal_id IS NOT NULL))::integer) = 1))));
ALTER TABLE public."accounting_tournament_fee_recognitions" ADD CONSTRAINT "accounting_tournament_fee_recognitions_net_rake_check" CHECK (((net_rake >= (0)::numeric) AND (net_rake = round(net_rake, 2)) AND ((net_rake)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text]))));
ALTER TABLE public."accounting_tournament_fee_recognitions" ADD CONSTRAINT "accounting_tournament_fee_recognitions_pkey" PRIMARY KEY (tournament_id);
ALTER TABLE public."accounting_tournament_fee_recognitions" ADD CONSTRAINT "accounting_tournament_fee_recognitions_status_check" CHECK ((status = ANY (ARRAY['recognized'::text, 'cancelled'::text, 'banked_accrual_deferred'::text])));
ALTER TABLE public."accounting_tournament_fee_sources" ADD CONSTRAINT "accounting_tournament_fee_sources_pkey" PRIMARY KEY (id);
ALTER TABLE public."accounting_tournament_fee_sources" ADD CONSTRAINT "accounting_tournament_fee_sources_rake_credit_check" CHECK (((rake_credit >= (0)::numeric) AND (rake_credit = round(rake_credit, 2)) AND ((rake_credit)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text]))));
ALTER TABLE public."accounting_tournament_fee_sources" ADD CONSTRAINT "accounting_tournament_fee_sources_rake_record_id_player_id_key" UNIQUE (rake_record_id, player_id);
ALTER TABLE public."accounting_tournament_fee_sources" ADD CONSTRAINT "accounting_tournament_fee_sources_source_entitlement_id_key" UNIQUE (source_entitlement_id);
ALTER TABLE public."accounting_tournament_recognized_sources" ADD CONSTRAINT "accounting_tournament_recognized_sources_disposition_check" CHECK ((disposition = ANY (ARRAY['earned'::text, 'refunded'::text])));
ALTER TABLE public."accounting_tournament_recognized_sources" ADD CONSTRAINT "accounting_tournament_recognized_sources_pkey" PRIMARY KEY (source_id);
ALTER TABLE public."accounting_tournament_recognized_sources" ADD CONSTRAINT "accounting_tournament_recognized_sources_rake_credit_check" CHECK (((rake_credit >= (0)::numeric) AND (rake_credit = round(rake_credit, 2)) AND ((rake_credit)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text]))));
ALTER TABLE public."accounting_tournament_fee_batches" ADD CONSTRAINT "accounting_tournament_fee_batches_rake_record_id_fkey" FOREIGN KEY (rake_record_id) REFERENCES rake_records(id);
ALTER TABLE public."accounting_tournament_fee_recognitions" ADD CONSTRAINT "accounting_tournament_fee_reco_union_wallet_transaction_id_fkey" FOREIGN KEY (union_wallet_transaction_id) REFERENCES union_wallet_transactions(id);
ALTER TABLE public."accounting_tournament_fee_recognitions" ADD CONSTRAINT "accounting_tournament_fee_recognitions_bank_journal_id_fkey" FOREIGN KEY (bank_journal_id) REFERENCES chip_ledger(id);
ALTER TABLE public."accounting_tournament_fee_sources" ADD CONSTRAINT "accounting_tournament_fee_sources_rake_record_id_fkey" FOREIGN KEY (rake_record_id) REFERENCES accounting_tournament_fee_batches(rake_record_id);
ALTER TABLE public."accounting_tournament_recognized_sources" ADD CONSTRAINT "accounting_tournament_recognized_sources_source_id_fkey" FOREIGN KEY (source_id) REFERENCES accounting_tournament_fee_sources(id);
ALTER TABLE public."accounting_tournament_recognized_sources" ADD CONSTRAINT "accounting_tournament_recognized_sources_tournament_id_fkey" FOREIGN KEY (tournament_id) REFERENCES accounting_tournament_fee_recognitions(tournament_id);
CREATE INDEX accounting_tournament_fee_sources_event ON public.accounting_tournament_fee_sources USING btree (tournament_id, rake_record_id);
CREATE INDEX accounting_tournament_recognized_sources_week ON public.accounting_tournament_recognized_sources USING btree (recognized_at, tournament_id);
ALTER TABLE public.tournament_terminal_settlements ADD COLUMN accounting_state text NOT NULL DEFAULT 'legacy',
  ALTER COLUMN rake_attributed_at DROP NOT NULL, DROP CONSTRAINT tournament_terminal_settlements_receipt_version_check;
ALTER TABLE public.tournament_terminal_settlements ADD CONSTRAINT "terminal_rake_attribution_matches_accounting_state" CHECK ((((accounting_state = 'banked_accrual_deferred'::text) AND (rake_attributed_at IS NULL) AND (rake_attributed_users = 0)) OR ((accounting_state <> 'banked_accrual_deferred'::text) AND (rake_attributed_at IS NOT NULL))));
ALTER TABLE public.tournament_terminal_settlements ADD CONSTRAINT "terminal_receipt_version_matches_accounting_state" CHECK ((receipt_version =
CASE
    WHEN (accounting_state = 'legacy'::text) THEN 1
    ELSE 2
END));
ALTER TABLE public.tournament_terminal_settlements ADD CONSTRAINT "tournament_terminal_settlements_accounting_state_check" CHECK ((accounting_state = ANY (ARRAY['legacy'::text, 'recognized'::text, 'cancelled'::text, 'banked_accrual_deferred'::text])));

-- Captured full-definition MD5 e56aa8c8280c59e2f0406ea6c504dc4e
CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_bank_proof(p_tournament_id uuid, p_recognized_at timestamp with time zone, p_bank_club_id uuid, p_union_id uuid, p_net_fee numeric, p_union_wallet_transaction_id uuid, p_bank_journal_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$DECLARE bank record;BEGIN
 IF (p_bank_club_id IS NULL AND p_net_fee>0) OR p_recognized_at IS NULL OR NOT isfinite(p_recognized_at)
  OR p_net_fee IS NULL OR p_net_fee<0 OR p_net_fee<>round(p_net_fee,2) OR p_net_fee::text IN('NaN','Infinity','-Infinity') THEN
  RAISE EXCEPTION 'tournament_fee_bank_proof_invalid' USING ERRCODE='23514'; END IF;
 IF p_net_fee=0 THEN
  IF p_union_wallet_transaction_id IS NOT NULL OR p_bank_journal_id IS NOT NULL THEN
   RAISE EXCEPTION 'zero_tournament_fee_has_no_bank_credit' USING ERRCODE='23514'; END IF;
 ELSIF p_union_id IS NOT NULL THEN
  SELECT * INTO bank FROM public.union_wallet_transactions WHERE id=p_union_wallet_transaction_id;
  IF p_bank_journal_id IS NOT NULL OR bank.id IS NULL OR bank.union_id IS DISTINCT FROM p_union_id
   OR bank.club_id IS DISTINCT FROM p_bank_club_id OR bank.wallet IS DISTINCT FROM 'rake_wallet'
   OR bank.direction IS DISTINCT FROM 'credit' OR bank.tx_type IS DISTINCT FROM 'rake' OR bank.amount IS DISTINCT FROM p_net_fee
   OR bank.created_at IS DISTINCT FROM p_recognized_at
   OR position('[tournament '||p_tournament_id::text||']' IN COALESCE(bank.notes,''))=0 THEN
   RAISE EXCEPTION 'tournament_fee_union_bank_receipt_mismatch' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT * INTO bank FROM public.chip_ledger WHERE id=p_bank_journal_id;
  IF p_union_wallet_transaction_id IS NOT NULL OR bank.id IS NULL OR bank.from_type IS DISTINCT FROM 'prize_liability'
   OR bank.from_entity_id IS DISTINCT FROM p_tournament_id OR bank.to_type IS DISTINCT FROM 'chip_retirement'
   OR bank.to_entity_id IS NOT NULL OR bank.club_id IS DISTINCT FROM p_bank_club_id OR bank.category IS DISTINCT FROM 'burn'
   OR bank.amount IS DISTINCT FROM p_net_fee OR bank.created_at IS DISTINCT FROM p_recognized_at THEN
   RAISE EXCEPTION 'tournament_fee_club_bank_receipt_mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN jsonb_build_object('bank_amount',p_net_fee,'banked_at',p_recognized_at,'bank_club_id',p_bank_club_id,'bank_union_id',p_union_id,
  'bank_receipt_kind',CASE WHEN p_net_fee=0 THEN 'none' WHEN p_union_id IS NULL THEN 'chip_ledger' ELSE 'union_wallet_transaction' END,
  'bank_receipt_id',COALESCE(p_union_wallet_transaction_id,p_bank_journal_id));
END$function$;
ALTER FUNCTION public.fn_accounting_tournament_bank_proof(uuid,timestamp with time zone,uuid,uuid,numeric,uuid,uuid) OWNER TO "postgres";
DO $acl$ DECLARE grantee text; BEGIN FOR grantee IN
 SELECT DISTINCT CASE WHEN ac.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ac.grantee) END
 FROM pg_proc pr CROSS JOIN LATERAL aclexplode(COALESCE(pr.proacl,acldefault('f',pr.proowner))) ac
 WHERE pr.oid=to_regprocedure('public.fn_accounting_tournament_bank_proof(uuid,timestamp with time zone,uuid,uuid,numeric,uuid,uuid)') LOOP
 EXECUTE 'REVOKE ALL ON FUNCTION public.fn_accounting_tournament_bank_proof(uuid,timestamp with time zone,uuid,uuid,numeric,uuid,uuid) FROM '||CASE WHEN grantee='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(grantee) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_accounting_tournament_bank_proof(uuid,timestamp with time zone,uuid,uuid,numeric,uuid,uuid) TO "postgres";

-- Captured full-definition MD5 dd55cceba87b1578472171e1c80ba1fb
CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_fee_fingerprint(p_row rake_records)
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
$function$;
ALTER FUNCTION public.fn_accounting_tournament_fee_fingerprint(rake_records) OWNER TO "postgres";
DO $acl$ DECLARE grantee text; BEGIN FOR grantee IN
 SELECT DISTINCT CASE WHEN ac.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ac.grantee) END
 FROM pg_proc pr CROSS JOIN LATERAL aclexplode(COALESCE(pr.proacl,acldefault('f',pr.proowner))) ac
 WHERE pr.oid=to_regprocedure('public.fn_accounting_tournament_fee_fingerprint(rake_records)') LOOP
 EXECUTE 'REVOKE ALL ON FUNCTION public.fn_accounting_tournament_fee_fingerprint(rake_records) FROM '||CASE WHEN grantee='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(grantee) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_accounting_tournament_fee_fingerprint(rake_records) TO "postgres";

-- Captured full-definition MD5 6e446f6d6d19ec8b28b31d124a8c6ac3
CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$DECLARE r record;proof jsonb;fp text;credits numeric;n int;BEGIN
 SELECT * INTO r FROM public.accounting_tournament_fee_recognitions WHERE tournament_id=p_tournament_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT md5(COALESCE(string_agg(public.fn_accounting_tournament_fee_fingerprint(q),':' ORDER BY q.id),'')) INTO fp
  FROM public.rake_records q WHERE q.tournament_id=p_tournament_id AND q.is_tournament;
 IF r.source_fingerprint IS DISTINCT FROM fp THEN RAISE EXCEPTION 'recognized_tournament_fee_sources_changed' USING ERRCODE='23514'; END IF;
 proof:=public.fn_accounting_tournament_bank_proof(r.tournament_id,r.recognized_at,r.bank_club_id,r.union_id,r.net_rake,r.union_wallet_transaction_id,r.bank_journal_id);
 SELECT COALESCE(sum(x.rake_credit),0),count(*) INTO credits,n FROM public.accounting_tournament_recognized_sources x WHERE x.tournament_id=p_tournament_id;
 IF (r.status='banked_accrual_deferred' AND (n<>0 OR r.plan->>'payable' IS DISTINCT FROM 'false' OR NULLIF(r.plan->>'reason','') IS NULL))
  OR (r.status<>'banked_accrual_deferred' AND (credits IS DISTINCT FROM r.net_rake
    OR n<>(SELECT count(*) FROM public.accounting_tournament_fee_sources f WHERE f.tournament_id=p_tournament_id)
    OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources f LEFT JOIN public.accounting_tournament_recognized_sources x ON x.source_id=f.id
      WHERE f.tournament_id=p_tournament_id AND (x.source_id IS NULL OR x.tournament_id IS DISTINCT FROM p_tournament_id
        OR x.recognized_at IS DISTINCT FROM r.recognized_at OR x.rake_credit IS DISTINCT FROM CASE WHEN x.disposition='earned' THEN f.rake_credit ELSE 0 END))
    OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources f
      JOIN public.accounting_tournament_recognized_sources x ON x.source_id=f.id AND x.disposition='earned'
      CROSS JOIN LATERAL jsonb_array_elements(f.contract->'tiers')tier
      WHERE f.tournament_id=p_tournament_id AND (tier->>'amount')::numeric>0 AND NOT EXISTS(
       SELECT 1 FROM public.agent_commissions c WHERE c.source_type='tournament_fee_accrual' AND c.source_id=f.id
        AND c.user_id::text=tier->>'user_id' AND c.club_id=f.club_id AND c.created_at=r.recognized_at
        AND c.amount=(tier->>'amount')::numeric AND c.commission_rate=(tier->>'rate')::numeric)))) THEN
  RAISE EXCEPTION 'tournament_fee_recognition_source_receipt_incomplete' USING ERRCODE='23514'; END IF;
 RETURN proof||jsonb_build_object('accounting_version',2,'tournament_id',p_tournament_id,'status',r.status,
  'source_fingerprint',fp,'reason',r.plan->>'reason','payable',r.status='recognized','recognized_source_count',n);
END$function$;
ALTER FUNCTION public.fn_accounting_tournament_terminal_fee_receipt(uuid) OWNER TO "postgres";
DO $acl$ DECLARE grantee text; BEGIN FOR grantee IN
 SELECT DISTINCT CASE WHEN ac.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ac.grantee) END
 FROM pg_proc pr CROSS JOIN LATERAL aclexplode(COALESCE(pr.proacl,acldefault('f',pr.proowner))) ac
 WHERE pr.oid=to_regprocedure('public.fn_accounting_tournament_terminal_fee_receipt(uuid)') LOOP
 EXECUTE 'REVOKE ALL ON FUNCTION public.fn_accounting_tournament_terminal_fee_receipt(uuid) FROM '||CASE WHEN grantee='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(grantee) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_accounting_tournament_terminal_fee_receipt(uuid) TO "postgres";

-- Captured full-definition MD5 76e4c6b5291bab20f0cfc65dd060022b
CREATE OR REPLACE FUNCTION public.fn_ca_lock_settlement_lane_for_finish(p_tournament_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_held text := COALESCE(current_setting('ca.finish_lane_tournament', true), '');
  -- Unknown until the row proves it is a plain tournament: the whole lane.
  v_satellite boolean := true;
BEGIN
  -- Re-entry: this transaction already holds a finish lane. Every key below
  -- is already held by this backend, so nothing waits; a second tournament
  -- is refused, a transaction never holds two tournaments' lanes.
  IF v_held <> '' THEN
    IF p_tournament_id IS NOT NULL AND v_held <> p_tournament_id::text THEN
      RAISE EXCEPTION 'finish lane is held for tournament %, refused for %',
        v_held, p_tournament_id USING ERRCODE = '55000';
    END IF;
    PERFORM pg_advisory_xact_lock_shared(
      hashtextextended('ca:tournament-terminal-settlement:v1', 0));
    PERFORM pg_advisory_xact_lock(
      hashtextextended('ca:tournament-finish-lane:v1', 0));
    PERFORM pg_advisory_xact_lock(
      hashtextextended('ca:tournament-terminal-settlement:v1:' || v_held, 0));
    RETURN;
  END IF;

  -- Resolve the tournament before any lock. variant, tournament_type and the
  -- satellite target are fixed for the life of the row, so reading them
  -- unlocked gives the answer reading them under the lane would.
  IF p_tournament_id IS NOT NULL THEN
    SELECT (lower(COALESCE(t.variant::text, '')) = 'satellite'
            OR upper(COALESCE(t.tournament_type::text, '')) = 'SATELLITE'
            OR t.satellite_target_id IS NOT NULL
            OR t.satellite_target IS NOT NULL)
      INTO v_satellite
      FROM public.tournaments t
     WHERE t.id = p_tournament_id;
    IF NOT FOUND THEN
      v_satellite := true;
    END IF;
  END IF;

  -- A satellite finish writes the target tournament's rows, and an unknown
  -- tournament cannot be scoped: the whole lane, as it always was.
  IF v_satellite THEN
    PERFORM public.fn_ca_lock_settlement_lane_global();
    RETURN;
  END IF;

  -- G SHARED: waits for, and excludes, the rare global authorities (G
  -- exclusive) and nothing else. Hands and rolling authorities of other
  -- tournaments run beside this finish.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:tournament-terminal-settlement:v1', 0));
  -- F EXCLUSIVE: one finish on the platform at a time, so finish-against-
  -- finish wallet order is what it was under G exclusive.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-finish-lane:v1', 0));
  -- T(id) EXCLUSIVE: this tournament's hands (T shared) and rolling
  -- authorities (T exclusive) wait for the finish, and the proof-of-
  -- authority guards read it as this backend's authority over the rows.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1:' || p_tournament_id::text, 0));
  -- The rest of this transaction re-enters this lane through
  -- fn_ca_lock_settlement_lane_global; transaction-local, gone at commit.
  PERFORM set_config('ca.finish_lane_tournament', p_tournament_id::text, true);
END;
$function$;
ALTER FUNCTION public.fn_ca_lock_settlement_lane_for_finish(uuid) OWNER TO "postgres";
DO $acl$ DECLARE grantee text; BEGIN FOR grantee IN
 SELECT DISTINCT CASE WHEN ac.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ac.grantee) END
 FROM pg_proc pr CROSS JOIN LATERAL aclexplode(COALESCE(pr.proacl,acldefault('f',pr.proowner))) ac
 WHERE pr.oid=to_regprocedure('public.fn_ca_lock_settlement_lane_for_finish(uuid)') LOOP
 EXECUTE 'REVOKE ALL ON FUNCTION public.fn_ca_lock_settlement_lane_for_finish(uuid) FROM '||CASE WHEN grantee='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(grantee) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_ca_lock_settlement_lane_for_finish(uuid) TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_ca_lock_settlement_lane_for_finish(uuid) TO "service_role";

-- Captured full-definition MD5 7c759bb7a639c3124de2607bdbf12577
CREATE OR REPLACE FUNCTION public.fn_ca_lock_settlement_lane_global()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Inside a non-satellite finish (2026-09-17) this transaction already
  -- holds that finish's lane: G shared, F exclusive, T(id) exclusive. The
  -- finish body and the settle functions still call this helper; re-enter
  -- the lane that is held instead of requesting G exclusively, which would
  -- be an upgrade of a shared hold (2026-09-10: no upgrades, they deadlock).
  IF COALESCE(current_setting('ca.finish_lane_tournament', true), '') <> '' THEN
    PERFORM public.fn_ca_lock_settlement_lane_for_finish(NULL);
    RETURN;
  END IF;
  -- G then B. Terminal / rare authorities: serialised against every other
  -- authority AND against every hand settlement, as on 2026-09-09.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1', 0));
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:hand-settlement-barrier:v1', 0));
END;
$function$;
ALTER FUNCTION public.fn_ca_lock_settlement_lane_global() OWNER TO "postgres";
DO $acl$ DECLARE grantee text; BEGIN FOR grantee IN
 SELECT DISTINCT CASE WHEN ac.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ac.grantee) END
 FROM pg_proc pr CROSS JOIN LATERAL aclexplode(COALESCE(pr.proacl,acldefault('f',pr.proowner))) ac
 WHERE pr.oid=to_regprocedure('public.fn_ca_lock_settlement_lane_global()') LOOP
 EXECUTE 'REVOKE ALL ON FUNCTION public.fn_ca_lock_settlement_lane_global() FROM '||CASE WHEN grantee='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(grantee) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_ca_lock_settlement_lane_global() TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_ca_lock_settlement_lane_global() TO "service_role";

-- Captured full-definition MD5 8dd361600c8facb1cbb99b3df853e5b9
CREATE OR REPLACE FUNCTION public.fn_ca_settlement_lane_doctrine()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_violations jsonb := '[]'::jsonb;
  v_set text;
  v_path text;
  v_node text;
  v_unknown text;
  v_globals text[];
  v_frontier text[];
  v_visited text[];
  v_next text[];
  v_parent jsonb := '{}'::jsonb;
  v_depth integer;
  r record;
  -- Every function allowed to take the global lane (G and B exclusive):
  -- the rare and cross-tournament authorities reviewed on 2026-09-17. A new
  -- name is a new authority nobody has classified as rolling, finish or
  -- global: it fails CI until someone reads it for what it writes.
  v_global_allowed CONSTANT text[] := ARRAY[
    'atomic_cancel_tournament','fn_award_satellite_seat','fn_backpay_unfinalised_bounty_pools',
    'fn_begin_tournament_deal_review','fn_ca_lock_settlement_lane_for_finish',
    'fn_ca_lock_settlement_lane_for_satellite_finish',
    'fn_ca_return_satellite_entitlement_as_ticket','fn_ca_tournament_deal_snapshot',
    'fn_cancel_tournament_deal_review','fn_close_managed_game','fn_close_tournament_deal_review',
    'fn_complete_tournament_terminal_pre_seat_guard','fn_complete_tournament_terminal_proposal',
    'fn_deliver_satellite_ticket_exact','fn_execute_managed_game_command','fn_finalize_bounty_pool',
    'fn_get_tournament_deal_consensus','fn_mystery_bounty_settle','fn_poker_diamond_tournament_cancel',
    'fn_request_tournament_deal_review','fn_resolve_satellite_settlement_outcome',
    'fn_resolve_tournament_terminal_proposal_outcome','fn_settle_final_table_deal_atomic',
    'fn_settle_satellite_finish_atomic','fn_settle_tournament_final_table_deal',
    'fn_settle_tournament_places','fn_settle_tournament_rake','fn_sweep_unsettled_tournament_rake'];
BEGIN
  IF NOT public.fn_caller_is_engine() AND session_user <> 'postgres' THEN
    RAISE EXCEPTION 'lane doctrine is read by the engine role' USING ERRCODE = '42501';
  END IF;

  -- 1. G is taken exclusively only by the two lane helpers.
  SELECT string_agg(p.proname::text, ',' ORDER BY p.proname::text COLLATE "C")
    INTO v_set
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosrc ~ 'pg_advisory_xact_lock\(\s*hashtextextended\(\s*''ca:tournament-terminal-settlement:v1''\s*,\s*0\s*\)\s*\)';
  IF v_set IS DISTINCT FROM 'fn_ca_lock_settlement_lane_for_tournament,fn_ca_lock_settlement_lane_global' THEN
    v_violations := v_violations || jsonb_build_object('rule', 'g_exclusive_only_by_helpers', 'found', v_set);
  END IF;

  -- 2. F is named only by the three finish-lane helpers.
  SELECT string_agg(p.proname::text, ',' ORDER BY p.proname::text COLLATE "C")
    INTO v_set
    FROM pg_catalog.pg_proc p
   WHERE p.prosrc LIKE '%ca:tournament-finish-lane' || ':v1%';
  IF v_set IS DISTINCT FROM
     'fn_ca_lock_settlement_lane_for_finish,fn_ca_lock_settlement_lane_for_satellite_finish,'
     'fn_ca_lock_settlement_lane_for_sweep_member' THEN
    v_violations := v_violations || jsonb_build_object('rule', 'f_named_only_by_finish_helpers', 'found', v_set);
  END IF;

  -- 3. Every function naming the global helper is a reviewed global authority.
  SELECT string_agg(p.proname::text, ',' ORDER BY p.proname::text COLLATE "C")
    INTO v_unknown
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosrc LIKE '%fn_ca_lock_settlement_lane_global' || '(%'
     AND p.proname <> 'fn_ca_lock_settlement_lane_global'
     AND NOT (p.proname::text = ANY (v_global_allowed));
  IF v_unknown IS NOT NULL THEN
    v_violations := v_violations || jsonb_build_object('rule', 'global_lane_callers_are_reviewed', 'found', v_unknown);
  END IF;

  -- 4. No rolling authority reaches the global lane within four calls.
  --    A breadth-first walk from every function that names a rolling lane
  --    helper, expanding only the frontier: the callees of a function are the
  --    public function names its source writes with a '(' behind them. The
  --    first version of this rule (20260917191322) built the whole call graph
  --    with a 3,592 x 3,592 strpos join and took eight seconds, which is
  --    exactly the engine role's statement timeout; CI read a 57014 instead
  --    of an answer. This walk touches a few hundred sources and answers in
  --    well under a second.
  SELECT COALESCE(array_agg(DISTINCT p.proname::text), '{}'::text[]) INTO v_globals
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f'
     AND strpos(p.prosrc, 'fn_ca_lock_settlement_lane_global' || '(') > 0
     AND p.proname::text NOT IN ('fn_ca_lock_settlement_lane_global',
                                 'fn_ca_lock_settlement_lane_for_finish',
                                 'fn_ca_lock_settlement_lane_for_satellite_finish');

  SELECT COALESCE(array_agg(DISTINCT p.proname::text), '{}'::text[]) INTO v_frontier
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f'
     AND (strpos(p.prosrc, 'fn_ca_lock_settlement_lane_for_tournament' || '(') > 0
          OR strpos(p.prosrc, 'fn_ca_lock_tournament_seat_acquisition' || '(') > 0)
     AND p.proname::text NOT IN ('fn_ca_lock_settlement_lane_for_tournament',
                                 'fn_ca_lock_tournament_seat_acquisition',
                                 'fn_resolve_tournament_terminal_outcome')
     AND NOT (p.proname::text = ANY (v_globals));
  v_visited := v_frontier;

  <<walk>>
  FOR v_depth IN 1..4 LOOP
    EXIT walk WHEN cardinality(v_frontier) = 0;
    v_next := '{}'::text[];
    FOR r IN
      SELECT DISTINCT ON (c.callee) c.callee, c.caller
        FROM (SELECT a.proname::text AS caller, t.m[1] AS callee
                FROM pg_catalog.pg_proc a
                JOIN pg_catalog.pg_namespace n ON n.oid = a.pronamespace
                CROSS JOIN LATERAL regexp_matches(a.prosrc, '\m([A-Za-z_][A-Za-z0-9_]*)\(', 'g') AS t(m)
               WHERE n.nspname = 'public' AND a.prokind = 'f'
                 AND a.proname::text = ANY (v_frontier)) c
       WHERE c.callee <> c.caller
         AND length(c.callee) > 6
         AND NOT (c.callee = ANY (v_visited))
         AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc b
                       JOIN pg_catalog.pg_namespace nb ON nb.oid = b.pronamespace
                      WHERE nb.nspname = 'public' AND b.prokind = 'f'
                        AND b.proname = c.callee::name)
       ORDER BY c.callee, c.caller
    LOOP
      v_parent := v_parent || jsonb_build_object(r.callee, r.caller);
      v_next := v_next || r.callee;
      IF r.callee = 'fn_ca_lock_settlement_lane_global' OR r.callee = ANY (v_globals) THEN
        v_path := r.callee;
        v_node := r.caller;
        WHILE v_node IS NOT NULL LOOP
          v_path := v_node || ' > ' || v_path;
          v_node := v_parent ->> v_node;
        END LOOP;
        v_violations := v_violations || jsonb_build_object('rule', 'rolling_authority_never_reaches_global_lane', 'found', v_path);
        EXIT walk;
      END IF;
    END LOOP;
    v_visited := v_visited || v_next;
    v_frontier := v_next;
  END LOOP walk;

  RETURN jsonb_build_object(
    'ok', jsonb_array_length(v_violations) = 0,
    'checked_at', now(),
    'violations', v_violations);
END;
$function$;
ALTER FUNCTION public.fn_ca_settlement_lane_doctrine() OWNER TO "postgres";
DO $acl$ DECLARE grantee text; BEGIN FOR grantee IN
 SELECT DISTINCT CASE WHEN ac.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ac.grantee) END
 FROM pg_proc pr CROSS JOIN LATERAL aclexplode(COALESCE(pr.proacl,acldefault('f',pr.proowner))) ac
 WHERE pr.oid=to_regprocedure('public.fn_ca_settlement_lane_doctrine()') LOOP
 EXECUTE 'REVOKE ALL ON FUNCTION public.fn_ca_settlement_lane_doctrine() FROM '||CASE WHEN grantee='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(grantee) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_ca_settlement_lane_doctrine() TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_ca_settlement_lane_doctrine() TO "service_role";

-- Captured full-definition MD5 787eb9a718a648ac29753dfc9234f4c3
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_terminal_receipt(p_tournament_id uuid, p_observed_winner_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_accounting jsonb; v_deferred boolean := false;
  v_h public.tournament_terminal_settlements%ROWTYPE;
  v_t record;
  v_e public.tournament_escrow%ROWTYPE;
  v_r record;
  v_cash_count integer;
  v_cash_total numeric(15,2);
  v_cash_obligation_total numeric(15,2);
  v_bounty_total numeric(15,2);
  v_rake_total numeric(15,2);
  v_roster_count integer;
  v_winner_count integer;
  v_raw_winner_id uuid;
  v_raw_winner_amount numeric(15,2);
  v_bubble jsonb;
  v_durable_payouts jsonb;
  v_durable_deal_shares jsonb;
  v_durable_bubble jsonb;
  v_durable_table_ids uuid[];
  v_durable_table_count integer;
  v_durable_seat_ids uuid[];
  v_durable_seat_count integer;
  v_durable_released_count integer;
  v_mystery_evidence jsonb;
BEGIN
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'terminal receipt requires a tournament id'
      USING ERRCODE = '22004';
  END IF;

  SELECT * INTO v_h
    FROM public.tournament_terminal_settlements h
   WHERE h.tournament_id = p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % has no immutable terminal receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  v_accounting:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
  v_deferred:=COALESCE(v_accounting->>'status'='banked_accrual_deferred',false);
  IF v_h.accounting_state IS DISTINCT FROM COALESCE(v_accounting->>'status','legacy')
     OR (v_accounting IS NOT NULL AND v_h.receipt_version<>2) THEN
    RAISE EXCEPTION 'terminal accounting state has no exact durable receipt' USING ERRCODE='P0404';
  END IF;
  IF p_observed_winner_id IS NOT NULL
     AND v_h.winner_id IS DISTINCT FROM p_observed_winner_id THEN
    RAISE EXCEPTION 'tournament % receipt winner % differs from observed winner %',
      p_tournament_id, v_h.winner_id, p_observed_winner_id
      USING ERRCODE = '40001';
  END IF;

  SELECT t.id,t.status,t.variant,t.tournament_type,t.satellite_target_id,
         t.satellite_target,t.prize_pool,t.bounty_pool,t.bounty_pool_paid,
         t.is_bounty,t.is_pko,t.is_mystery_bounty,t.mystery_bounty_stage,
         t.mystery_bounty_pool_cents,t.club_id,t.ended_at,t.on_break,
         t.break_started_at,t.break_ends_at
    INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF v_t.id IS NULL THEN
    RAISE EXCEPTION 'terminal receipt lost tournament %', p_tournament_id
      USING ERRCODE = 'P0404';
  END IF;
  IF lower(COALESCE(v_t.variant::text, '')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type::text, '')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL
     OR v_t.satellite_target IS NOT NULL THEN
    RAISE EXCEPTION 'terminal receipt % belongs to a satellite', p_tournament_id
      USING ERRCODE = 'P0404';
  END IF;
  IF upper(COALESCE(v_t.status::text, '')) <> 'COMPLETED'
     OR v_t.ended_at IS DISTINCT FROM v_h.completed_at
     OR COALESCE(v_t.on_break, false)
     OR v_t.break_started_at IS NOT NULL
     OR v_t.break_ends_at IS NOT NULL THEN
    RAISE EXCEPTION 'tournament % is not durably closed by its receipt',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- Every mutable child carries the same tuple-owned close fact. This makes a
  -- replay prove the synchronous marker transition itself, while queued
  -- writers can reject from OLD after a row-lock wait without relying on a
  -- pre-wait statement snapshot of the parent or receipt.
  IF EXISTS (SELECT 1 FROM public.tournament_players x
              WHERE x.tournament_id=p_tournament_id
                AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_payouts x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_rake_settlements x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.rake_records x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_guarantee_overlays x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (
       SELECT 1 FROM public.table_seats s
       JOIN public.tables tb ON tb.id=s.table_id
        WHERE tb.tournament_id=p_tournament_id
          AND s.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.wallet_transactions x
                 WHERE x.related_entity_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (
       SELECT 1 FROM public.tournament_bounty_award_recipients r
       JOIN public.tournament_bounty_awards a ON a.id=r.award_id
        WHERE a.tournament_id=p_tournament_id
          AND r.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.tournament_escrow x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at)
     OR EXISTS (SELECT 1 FROM public.spin_reserve_ledger x
                 WHERE x.tournament_id=p_tournament_id
                   AND x.kind NOT IN ('contribution','jackpot_draw')
                   AND x.terminal_closed_at IS DISTINCT FROM v_h.completed_at) THEN
    RAISE EXCEPTION 'tournament % mutable evidence lacks its exact terminal marker',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Table closure is money-adjacent terminal state, not an asynchronous UI
  -- cleanup. The immutable identities prove that no tournament table vanished,
  -- appeared or reopened after this receipt and that every seat released by
  -- the terminal transaction still has its exact terminal state.
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id),ARRAY[]::uuid[]),count(*)
    INTO v_durable_table_ids,v_durable_table_count
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id;
  SELECT COALESCE(array_agg(s.id ORDER BY s.id),ARRAY[]::uuid[]),count(*)
    INTO v_durable_seat_ids,v_durable_seat_count
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id;
  SELECT count(*) INTO v_durable_released_count
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id
     AND s.id = ANY(v_h.released_seat_ids)
     AND s.left_at IS NOT DISTINCT FROM v_h.completed_at
     AND COALESCE(s.status,'') = 'left'
     AND COALESCE(s.leave_pending,false) IS FALSE
     AND COALESCE(s.is_sitting_out,false) IS FALSE;
  IF v_durable_table_ids IS DISTINCT FROM v_h.closed_table_ids
     OR v_durable_table_count IS DISTINCT FROM v_h.closed_table_count
     OR v_durable_seat_ids IS DISTINCT FROM v_h.source_seat_ids
     OR v_durable_seat_count IS DISTINCT FROM v_h.source_seat_count
     OR v_durable_released_count IS DISTINCT FROM v_h.released_seat_count
     OR EXISTS (
       SELECT 1 FROM public.tables tb
        WHERE tb.tournament_id = p_tournament_id
          AND (lower(COALESCE(tb.status::text,'')) <> 'closed'
            OR lower(COALESCE(tb.lifecycle,'')) <> 'closed'
            OR tb.current_players IS DISTINCT FROM 0
            OR tb.terminal_closed_at IS DISTINCT FROM v_h.completed_at))
     OR EXISTS (
       SELECT 1
         FROM public.table_seats s
         JOIN public.tables tb ON tb.id = s.table_id
        WHERE tb.tournament_id = p_tournament_id
          AND (s.left_at IS NULL
            OR s.status IS DISTINCT FROM 'left'
            OR s.terminal_closed_at IS DISTINCT FROM v_h.completed_at
            OR s.leave_pending IS DISTINCT FROM false
            OR s.is_sitting_out IS DISTINCT FROM false
            OR s.is_away IS DISTINCT FROM false
            OR s.sit_out_at IS NOT NULL
            OR s.scheduled_leave_hands IS NOT NULL)) THEN
    RAISE EXCEPTION 'tournament % table or seat closure differs from its immutable receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR round(v_t.prize_pool,2) IS DISTINCT FROM v_h.prize_pool
     OR v_t.bounty_pool IS NULL
     OR v_t.bounty_pool::text IN ('NaN','Infinity','-Infinity')
     OR round(v_t.bounty_pool,2) IS DISTINCT FROM v_h.bounty_pool THEN
    RAISE EXCEPTION 'tournament % pools differ from its immutable receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE tp.status::text = 'winner'
                            AND tp.position = 1)
    INTO v_roster_count,v_winner_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  IF v_roster_count < 1 OR v_winner_count <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.user_id = v_h.winner_id
          AND tp.status::text = 'winner' AND tp.position = 1
          AND tp.eliminated_at IS NULL
          AND tp.elimination_sequence IS NULL)
     OR (SELECT count(tp.position) FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id) <> v_roster_count
     OR (SELECT count(DISTINCT tp.position) FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id) <> v_roster_count
     OR (SELECT min(tp.position) FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id) <> 1
     OR (SELECT max(tp.position) FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id) <> v_roster_count
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.status::text NOT IN ('winner','eliminated')) THEN
    RAISE EXCEPTION 'tournament % has ambiguous or incomplete final standings',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF jsonb_typeof(v_h.cash_receipt->'payouts') <> 'array'
     OR COALESCE((v_h.cash_receipt->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_h.cash_receipt->>'fully_settled')::boolean,false) IS NOT TRUE
     OR upper(COALESCE(v_h.cash_receipt->>'status','')) <> 'COMPLETING'
     OR v_h.cash_receipt->>'winner_amount' IS NULL
     OR (v_h.cash_receipt->>'winner_amount')::numeric < 0
     OR (v_h.cash_receipt->>'winner_amount')::numeric IS DISTINCT FROM
          round((v_h.cash_receipt->>'winner_amount')::numeric,2)
     OR (v_h.settlement_mode = 'final_table_deal'
         AND v_h.cash_receipt->>'money_path'
               IS DISTINCT FROM 'fn_settle_tournament_final_table_deal') THEN
    RAISE EXCEPTION 'tournament % stored a malformed cash authority receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT (p->>'user_id')::uuid,(p->>'amount')::numeric
    INTO v_raw_winner_id,v_raw_winner_amount
    FROM jsonb_array_elements(v_h.cash_receipt->'payouts') p
   WHERE (p->>'place')::integer = 1;
  IF v_raw_winner_id IS DISTINCT FROM v_h.winner_id
     OR v_raw_winner_amount IS DISTINCT FROM
          (v_h.cash_receipt->>'winner_amount')::numeric
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_h.cash_receipt->'payouts') p
        WHERE p->>'place' IS NULL OR p->>'user_id' IS NULL
           OR p->>'amount' IS NULL
           OR (p->>'place')::integer < 1
           OR (p->>'amount')::numeric < 0
           OR (p->>'amount')::numeric IS DISTINCT FROM
                round((p->>'amount')::numeric,2)
           OR NOT EXISTS (
             SELECT 1 FROM public.tournament_players tp
              WHERE tp.tournament_id = p_tournament_id
                AND tp.position = (p->>'place')::integer
                AND tp.user_id = (p->>'user_id')::uuid))
     OR (SELECT count(*) FROM jsonb_array_elements(v_h.cash_receipt->'payouts')) < 1
     OR (SELECT count(DISTINCT (p->>'place')::integer)
           FROM jsonb_array_elements(v_h.cash_receipt->'payouts') p)
          <> (SELECT count(*) FROM jsonb_array_elements(v_h.cash_receipt->'payouts')) THEN
    RAISE EXCEPTION 'tournament % cash receipt does not name exact finishers',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Satellite and bounty records never consume the ordinary prize pool.
  IF EXISTS (
    SELECT 1 FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.source IN ('satellite_seat','satellite_ticket','satellite_remainder')
  ) THEN
    RAISE EXCEPTION 'non-satellite tournament % carries satellite payout evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  SELECT count(*),round(COALESCE(sum(p.amount),0),2)
    INTO v_cash_count,v_cash_total
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND p.source NOT IN (
       'bounty','bounty_residual','own_bounty','mystery_bounty',
       'mystery_bounty_residual','satellite_seat','satellite_ticket',
       'satellite_remainder');
  IF v_cash_count IS DISTINCT FROM v_h.cash_payout_count
     OR v_cash_total IS DISTINCT FROM v_h.cash_payout_total
     OR v_cash_total IS DISTINCT FROM v_h.prize_pool
     OR EXISTS (
       SELECT 1 FROM public.tournament_payouts p
        WHERE p.tournament_id = p_tournament_id
          AND p.source NOT IN (
            'bounty','bounty_residual','own_bounty','mystery_bounty',
            'mystery_bounty_residual','satellite_seat','satellite_ticket',
            'satellite_remainder')
          AND (p.amount IS NULL
            OR p.amount::text IN ('NaN','Infinity','-Infinity')
            OR p.amount <= 0 OR p.amount IS DISTINCT FROM round(p.amount,2)
            OR p.idempotency_key IS NULL OR NOT EXISTS (
              SELECT 1 FROM public.wallet_credit_idempotency k
               WHERE k.key = p.idempotency_key
                 AND k.user_id = p.user_id AND k.amount = p.amount))) THEN
    RAISE EXCEPTION 'tournament % cash payout evidence is incomplete or malformed',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'place',q.place,'user_id',q.user_id,'amount',q.amount)
           ORDER BY q.place,q.user_id),'[]'::jsonb)
    INTO v_durable_payouts
    FROM (
      SELECT tp.position AS place,p.user_id,round(sum(p.amount),2) AS amount
        FROM public.tournament_payouts p
        JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id AND tp.user_id = p.user_id
       WHERE p.tournament_id = p_tournament_id
         AND p.source <> 'bubble_protection'
         AND p.source NOT IN (
           'bounty','bounty_residual','own_bounty','mystery_bounty',
           'mystery_bounty_residual','satellite_seat','satellite_ticket',
           'satellite_remainder')
       GROUP BY tp.position,p.user_id
    ) q;
  IF v_h.prize_pool = 0 AND v_durable_payouts = '[]'::jsonb THEN
    -- A zero-cash event has a real winner and no wallet/payout mutation. Keep
    -- that explicit standings line in the receipt without inventing durable
    -- payment evidence.
    v_durable_payouts := jsonb_build_array(jsonb_build_object(
      'place',1,'user_id',v_h.winner_id,'amount',0));
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'place',q.place,'user_id',q.user_id,'amount',q.amount)
           ORDER BY q.place,q.user_id),'[]'::jsonb)
    INTO v_durable_deal_shares
    FROM (
      SELECT tp.position AS place,p.user_id,round(sum(p.amount),2) AS amount
        FROM public.tournament_payouts p
        JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id AND tp.user_id = p.user_id
       WHERE p.tournament_id = p_tournament_id
         AND p.source = 'final_table_deal'
       GROUP BY tp.position,p.user_id
    ) q;
  -- Match the terminal writer's one-recipient receipt across every verified
  -- partial credit interval. The exact credit-key and total checks still apply.
  IF (SELECT count(DISTINCT p.user_id) FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p.source = 'bubble_protection') > 1 THEN
    RAISE EXCEPTION 'tournament % has multiple durable bubble payout recipients',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  SELECT jsonb_build_object(
           'user_id',p.user_id,'position',tp.position,'amount',round(sum(p.amount),2))
    INTO v_durable_bubble
    FROM public.tournament_payouts p
    JOIN public.tournament_players tp
      ON tp.tournament_id = p_tournament_id AND tp.user_id = p.user_id
   WHERE p.tournament_id = p_tournament_id
     AND p.source = 'bubble_protection'
   GROUP BY p.user_id,tp.position;
  v_durable_bubble := COALESCE(v_durable_bubble,'null'::jsonb);
  IF v_h.cash_receipt->'payouts' IS DISTINCT FROM v_durable_payouts
     OR jsonb_typeof(v_h.cash_receipt->'deal_shares') <> 'array'
     OR v_h.cash_receipt->'deal_shares' IS DISTINCT FROM
          (CASE WHEN v_h.settlement_mode = 'final_table_deal'
                THEN v_durable_deal_shares ELSE '[]'::jsonb END)
     OR COALESCE(v_h.cash_receipt->'bubble_protection','null'::jsonb)
          IS DISTINCT FROM v_durable_bubble
     OR ((SELECT round(COALESCE(sum((p->>'amount')::numeric),0),2)
            FROM jsonb_array_elements(v_durable_payouts) p)
         + (CASE WHEN v_durable_bubble = 'null'::jsonb THEN 0
                 ELSE (v_durable_bubble->>'amount')::numeric END))
          IS DISTINCT FROM v_h.cash_payout_total THEN
    RAISE EXCEPTION
      'tournament % stored cash lines differ from complete durable payout evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(o.amount_paid),0),2)
    INTO v_cash_obligation_total
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND o.kind IN ('place','bubble_protection','final_table_deal');
  IF v_cash_obligation_total IS DISTINCT FROM v_h.prize_pool
     OR EXISTS (
       SELECT 1 FROM public.tournament_obligations o
        WHERE o.tournament_id = p_tournament_id
          AND (o.amount_owed IS NULL OR o.amount_paid IS NULL
            OR o.amount_owed::text IN ('NaN','Infinity','-Infinity')
            OR o.amount_paid::text IN ('NaN','Infinity','-Infinity')
            OR o.amount_owed < 0 OR o.amount_paid < 0
            OR o.amount_owed IS DISTINCT FROM round(o.amount_owed,2)
            OR o.amount_paid IS DISTINCT FROM round(o.amount_paid,2)
            OR o.amount_paid IS DISTINCT FROM o.amount_owed
            OR o.settled_at IS NULL)) THEN
    RAISE EXCEPTION 'tournament % has incomplete or malformed obligations',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(w.amount),0),2)
    INTO v_bounty_total
    FROM public.wallet_transactions w
   WHERE w.related_entity_id = p_tournament_id AND lower(w.category) = 'bounty';
  -- DIAMOND PHASE 9: a Diamond bounty is a ledger row, not a wallet row.
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    SELECT e.bounty_out INTO v_bounty_total
      FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;
  END IF;
  IF v_bounty_total IS DISTINCT FROM v_h.bounty_payout_total
     OR v_bounty_total IS DISTINCT FROM v_h.bounty_pool
     OR EXISTS (
       SELECT 1 FROM public.wallet_transactions w
        WHERE w.related_entity_id = p_tournament_id
          AND lower(w.category) = 'bounty'
          AND (lower(w.type) <> 'credit' OR w.amount <= 0
            OR w.amount::text IN ('NaN','Infinity','-Infinity')
            OR w.amount IS DISTINCT FROM round(w.amount,2)))
     OR COALESCE(v_t.bounty_pool_paid,0) IS DISTINCT FROM v_h.bounty_pool
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND COALESCE(tp.current_bounty,0) <> 0) THEN
    RAISE EXCEPTION 'tournament % bounty pool is underfunded, overfunded or still open',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_h.bounty_pool > 0 THEN
    IF NOT (COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
            OR COALESCE(v_t.is_mystery_bounty,false))
       OR COALESCE((v_h.bounty_receipt->>'ok')::boolean,false) IS NOT TRUE
       OR COALESCE((v_h.bounty_receipt->>'funded')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'tournament % bounty receipt is not a funded close',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSIF COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
        OR COALESCE(v_t.is_mystery_bounty,false)
        OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                    WHERE o.tournament_id = p_tournament_id
                      AND o.kind IN ('bounty','bounty_residual','mystery_bounty'))
        OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                    WHERE c.tournament_id = p_tournament_id)
        OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                    WHERE a.tournament_id = p_tournament_id) THEN
    RAISE EXCEPTION 'ordinary tournament % carries unfunded bounty state',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_h.mystery_was_active THEN
    v_mystery_evidence :=
      public.fn_ca_mystery_bounty_completion_evidence(
        p_tournament_id,v_h.winner_id);
    IF COALESCE(v_t.is_mystery_bounty,false) IS NOT TRUE
       OR v_t.mystery_bounty_stage IS DISTINCT FROM 'complete'
       OR COALESCE(v_t.mystery_bounty_pool_cents,0)
            IS DISTINCT FROM v_h.mystery_pool_cents
       OR COALESCE((v_h.mystery_receipt->>'ok')::boolean,false) IS NOT TRUE
       OR COALESCE((v_h.mystery_receipt->>'balanced')::boolean,false) IS NOT TRUE
       OR COALESCE((v_h.mystery_receipt->>'pool_cents')::bigint,-1)
            IS DISTINCT FROM v_h.mystery_pool_cents
       OR COALESCE((v_h.mystery_receipt->>'settled_cents')::bigint,-1)
            IS DISTINCT FROM v_h.mystery_pool_cents
       OR (SELECT COALESCE(sum(c.amount_cents),0)
             FROM public.tournament_bounty_chests c
            WHERE c.tournament_id = p_tournament_id)
            IS DISTINCT FROM v_h.mystery_pool_cents
       OR v_h.mystery_receipt->'payment_evidence'
            IS DISTINCT FROM v_mystery_evidence
       OR COALESCE((v_h.mystery_receipt->>'residual_paid_cents')::bigint,-1)
            IS DISTINCT FROM
              COALESCE((v_mystery_evidence->>'void_chest_cents')::bigint,0)
       OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                   WHERE c.tournament_id = p_tournament_id
                     AND c.status NOT IN ('paid','void'))
       OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                   WHERE a.tournament_id = p_tournament_id
                     AND a.status NOT IN ('completed','void'))
       OR EXISTS (
         SELECT 1 FROM public.tournament_bounty_awards a
          WHERE a.tournament_id = p_tournament_id
            AND ((a.status = 'completed' AND (
                  a.paid_at IS NULL OR
                  (SELECT COALESCE(sum(r.amount_cents),0)
                     FROM public.tournament_bounty_award_recipients r
                    WHERE r.award_id = a.id) <> a.amount_cents OR
                  EXISTS (SELECT 1
                            FROM public.tournament_bounty_award_recipients r
                           WHERE r.award_id = a.id
                             AND r.amount_cents > 0 AND r.paid_at IS NULL)))
              OR (a.status = 'void' AND EXISTS (
                  SELECT 1 FROM public.tournament_bounty_award_recipients r
                   WHERE r.award_id = a.id AND r.paid_at IS NOT NULL)))) THEN
      RAISE EXCEPTION 'tournament % has open or inconsistent mystery bounty evidence',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSE
    IF v_h.mystery_pool_cents <> 0
       OR COALESCE(v_h.mystery_receipt->>'reason','')
            NOT IN ('never_activated','not_a_mystery_tournament')
       OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                   WHERE c.tournament_id = p_tournament_id)
       OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                   WHERE a.tournament_id = p_tournament_id) THEN
      RAISE EXCEPTION 'tournament % stored an invalid non-active mystery close',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;

  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id;
  IF v_e.tournament_id IS NULL
     OR v_e.prize_balance IS DISTINCT FROM 0::numeric
     OR v_e.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_e.fee_balance IS DISTINCT FROM 0::numeric
     OR v_e.closed_at IS DISTINCT FROM v_h.escrow_closed_at
     OR v_e.close_note IS DISTINCT FROM v_h.escrow_close_note THEN
    RAISE EXCEPTION 'tournament % escrow is not an exact durable zero close',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(rr.rake_amount),0),2) INTO v_rake_total
    FROM public.rake_records rr
   WHERE rr.tournament_id = p_tournament_id AND rr.is_tournament;
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    -- DIAMOND PHASE 8: a Diamond event's fee is its fee bank, settled to the house.
    SELECT e.fee_balance + e.fee_out INTO v_rake_total
      FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;
  END IF;
  SELECT rs.* INTO v_r FROM public.tournament_rake_settlements rs
   WHERE rs.tournament_id = p_tournament_id;
  IF v_r.tournament_id IS NULL
     OR v_r.amount IS DISTINCT FROM v_rake_total
     OR v_r.amount IS DISTINCT FROM v_h.rake_amount
     OR v_r.destination IS DISTINCT FROM v_h.rake_destination
     OR v_r.settled_at IS DISTINCT FROM v_h.rake_settled_at
     OR v_r.attributed_at IS DISTINCT FROM v_h.rake_attributed_at
     OR v_r.attributed_users IS DISTINCT FROM v_h.rake_attributed_users
     OR v_r.attributed_users IS NULL OR v_r.attributed_users < 0
     OR (v_r.attribution_error IS NOT NULL AND NOT v_deferred)
     OR lower(v_r.destination) IN ('pending','')
     OR (v_r.amount > 0 AND v_t.club_id IS NOT NULL AND NOT public.fn_poker_diamond_tournament(p_tournament_id) AND NOT v_deferred
         AND (v_r.attributed_users < 1
           OR v_r.destination NOT LIKE 'union:%'
              AND v_r.destination NOT LIKE 'chip_retirement:%'
              AND NOT (v_h.receipt_version=1 AND v_h.accounting_state='legacy'
                       AND v_r.destination LIKE 'club_treasury:%'))) THEN
    RAISE EXCEPTION 'tournament % rake is not durably and successfully attributed',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  v_bubble := CASE WHEN v_h.cash_receipt ? 'bubble_protection'
                    THEN v_h.cash_receipt->'bubble_protection'
                   ELSE 'null'::jsonb END;

  RETURN jsonb_build_object(
    'ok',true,
    'fully_settled',true,
    'status','COMPLETED',
    'tournament_id',v_h.tournament_id,
    'winner_id',v_h.winner_id,
    'mode',v_h.settlement_mode,
    'settlement_mode',v_h.settlement_mode,
    'payouts',v_h.cash_receipt->'payouts',
    'deal_shares',v_h.cash_receipt->'deal_shares',
    'winner_amount',(v_h.cash_receipt->>'winner_amount')::numeric,
    'bubble_protection',v_bubble,
    'cash',v_h.cash_receipt,
    'mystery_bounty',v_h.mystery_receipt,
    'bounty',v_h.bounty_receipt,
    'closed_table_count',v_h.closed_table_count,
    'source_seat_count',v_h.source_seat_count,
    'released_seat_count',v_h.released_seat_count,
    'table_closure',jsonb_build_object(
      'closed_table_count',v_h.closed_table_count,
      'closed_table_ids',to_jsonb(v_h.closed_table_ids),
      'source_seat_count',v_h.source_seat_count,
      'source_seat_ids',to_jsonb(v_h.source_seat_ids),
      'released_seat_count',v_h.released_seat_count,
      'released_seat_ids',to_jsonb(v_h.released_seat_ids)),
    'rake',jsonb_build_object(
      'amount',v_h.rake_amount,
      'destination',v_h.rake_destination,
      'attributed',NOT v_deferred,
      'accounting',v_accounting,
      'attributed_users',v_h.rake_attributed_users,
      'settled_at',v_h.rake_settled_at,
      'attributed_at',v_h.rake_attributed_at),
    'escrow',jsonb_build_object(
      'prize_balance',v_e.prize_balance,
      'bounty_balance',v_e.bounty_balance,
      'fee_balance',v_e.fee_balance,
      'closed_at',v_h.escrow_closed_at,
      'close_note',v_h.escrow_close_note),
    'cash_payout_total',v_h.cash_payout_total,
    'bounty_payout_total',v_h.bounty_payout_total,
    'receipt_version',v_h.receipt_version,
    'settled_at',v_h.settled_at);
END;
$function$;
ALTER FUNCTION public.fn_ca_tournament_terminal_receipt(uuid,uuid) OWNER TO "postgres";
DO $acl$ DECLARE grantee text; BEGIN FOR grantee IN
 SELECT DISTINCT CASE WHEN ac.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ac.grantee) END
 FROM pg_proc pr CROSS JOIN LATERAL aclexplode(COALESCE(pr.proacl,acldefault('f',pr.proowner))) ac
 WHERE pr.oid=to_regprocedure('public.fn_ca_tournament_terminal_receipt(uuid,uuid)') LOOP
 EXECUTE 'REVOKE ALL ON FUNCTION public.fn_ca_tournament_terminal_receipt(uuid,uuid) FROM '||CASE WHEN grantee='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(grantee) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_terminal_receipt(uuid,uuid) TO "postgres";

-- Captured full-definition MD5 6a45fe9bf30c94f9366ec88f0863087e
CREATE OR REPLACE FUNCTION public.fn_complete_tournament_terminal_pre_seat_guard(p_tournament_id uuid, p_observed_winner_id uuid, p_settlement_mode text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
DECLARE
  v_accounting jsonb; v_deferred boolean := false;
  v_mode text := lower(btrim(COALESCE(p_settlement_mode,'')));
  v_diamond boolean := false;  -- DIAMOND PHASE 8
  v_t record;
  v_e public.tournament_escrow%ROWTYPE;
  v_cash jsonb;
  v_mystery jsonb;
  v_mystery_evidence jsonb;
  v_bounty jsonb;
  v_rake_result jsonb;
  v_rake record;
  v_prior_rake record;
  v_winner_id uuid;
  v_winner_count integer;
  v_is_bounty boolean;
  v_mystery_active boolean := false;
  v_mystery_stage text := 'pending';
  v_mystery_pool_cents bigint := 0;
  v_inventory_cents bigint := 0;
  v_cash_count integer;
  v_bubble_line_count integer;
  v_cash_total numeric(15,2);
  v_cash_before numeric(15,2);
  v_bounty_before numeric(15,2);
  v_bounty_total numeric(15,2);
  v_rake_total numeric(15,2);
  v_expected_fee numeric(15,2);
  v_started_status text;
  v_completed_at timestamptz;
  v_rows integer;
  v_closed_table_ids uuid[] := ARRAY[]::uuid[];
  v_source_seat_ids uuid[] := ARRAY[]::uuid[];
  v_released_seat_ids uuid[] := ARRAY[]::uuid[];
  v_closed_table_count integer := 0;
  v_source_seat_count integer := 0;
  v_released_seat_count integer := 0;
  v_event_union_id uuid;
  v_current_union_id uuid;
  v_locked_current_union_id uuid;
  v_deal_shares jsonb := '[]'::jsonb;
  v_full_payouts jsonb := '[]'::jsonb;
  v_cash_bubble jsonb := 'null'::jsonb;
  v_full_winner_amount numeric(15,2);
BEGIN
  -- All satellite and non-satellite terminal money commits use this exact
  -- first lock. It eliminates cross-event cycles on shared club, union and
  -- recipient wallets without weakening any event-local row proof.
  PERFORM public.fn_ca_lock_settlement_lane_global();

  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'terminal completion requires a tournament id'
      USING ERRCODE = '22004';
  END IF;
  IF v_mode NOT IN ('places','final_table_deal') THEN
    RAISE EXCEPTION 'unknown terminal settlement mode %', p_settlement_mode
      USING ERRCODE = '22023';
  END IF;
  IF v_mode = 'places' AND p_observed_winner_id IS NULL THEN
    RAISE EXCEPTION 'places completion requires an observed winner id'
      USING ERRCODE = '22004';
  END IF;

  SELECT t.* INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  v_diamond := public.fn_poker_diamond_tournament(p_tournament_id);  -- DIAMOND PHASE 8

  -- Receipt first is the replay boundary. No money authority appears above it.
  IF EXISTS (
    SELECT 1 FROM public.tournament_terminal_settlements h
     WHERE h.tournament_id = p_tournament_id
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.tournament_terminal_settlements h
       WHERE h.tournament_id = p_tournament_id
         AND h.settlement_mode = v_mode
         AND (p_observed_winner_id IS NULL
              OR h.winner_id = p_observed_winner_id)
    ) THEN
      RAISE EXCEPTION 'terminal replay parameters disagree with stored receipt for %',
        p_tournament_id USING ERRCODE = '40001';
    END IF;
    RETURN public.fn_ca_tournament_terminal_receipt(
      p_tournament_id,p_observed_winner_id);
  END IF;

  IF lower(COALESCE(v_t.variant::text,'')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type::text,'')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL
     OR v_t.satellite_target IS NOT NULL THEN
    RAISE EXCEPTION 'tournament % is a satellite; use its whole-pool authority',
      p_tournament_id USING ERRCODE = '22023';
  END IF;
  v_started_status := upper(COALESCE(v_t.status::text,''));
  IF v_started_status NOT IN ('RUNNING','COMPLETING') THEN
    RAISE EXCEPTION 'tournament % cannot complete from status % without a receipt',
      p_tournament_id,v_t.status USING ERRCODE = '55000';
  END IF;
  IF v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.prize_pool < 0
     OR v_t.prize_pool IS DISTINCT FROM round(v_t.prize_pool,2)
     OR v_t.bounty_pool IS NULL
     OR v_t.bounty_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.bounty_pool < 0
     OR v_t.bounty_pool IS DISTINCT FROM round(v_t.bounty_pool,2) THEN
    RAISE EXCEPTION 'tournament % has malformed cash or bounty pools',
      p_tournament_id USING ERRCODE = '22003';
  END IF;

  IF NOT v_diamond THEN PERFORM public.fn_lock_accounting_tournament_recognition_week(p_tournament_id,transaction_timestamp()); END IF;

  -- Cross-event bank order is tournament -> club_wallets -> union_wallets
  -- (sorted) -> clubs, before a cash authority can apply an overlay. Rake uses
  -- club_wallets before its union/club destination; guarantee funding uses the
  -- union/club destination. Pre-owning both paths prevents two same-scope
  -- finishes from taking those shared banks in opposite order.
  v_event_union_id := CASE WHEN COALESCE(v_t.is_private,false)
                           THEN NULL ELSE v_t.union_id END;
  IF v_t.club_id IS NOT NULL THEN
    SELECT c.union_id INTO v_current_union_id
      FROM public.clubs c WHERE c.id = v_t.club_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'tournament % refers to missing club %',
        p_tournament_id,v_t.club_id USING ERRCODE = 'P0404';
    END IF;
    PERFORM 1 FROM public.club_wallets cw
     WHERE cw.club_id = v_t.club_id
     ORDER BY cw.club_id FOR NO KEY UPDATE;
    PERFORM 1 FROM public.union_wallets uw
     WHERE uw.union_id IN (
       SELECT DISTINCT x.union_id
         FROM unnest(ARRAY[v_event_union_id,v_current_union_id]::uuid[]) x(union_id)
        WHERE x.union_id IS NOT NULL)
     ORDER BY uw.union_id FOR NO KEY UPDATE;
    SELECT c.union_id INTO v_locked_current_union_id
      FROM public.clubs c
     WHERE c.id = v_t.club_id
     FOR NO KEY UPDATE;
    IF v_locked_current_union_id IS DISTINCT FROM v_current_union_id THEN
      RAISE EXCEPTION 'club % changed union while tournament % claimed terminal banks',
        v_t.club_id,p_tournament_id USING ERRCODE = '40001';
    END IF;
  END IF;

  -- Freeze every tournament-owned evidence set before the first payer. The
  -- canonical payers reacquire only rows already owned by this transaction.
  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
   ORDER BY tp.user_id,tp.id FOR UPDATE;
  PERFORM 1 FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
   ORDER BY o.kind,o.place NULLS LAST,o.id FOR UPDATE;
  PERFORM 1 FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id ORDER BY p.id FOR SHARE;
  PERFORM 1 FROM public.tournament_guarantee_overlays g
   WHERE g.tournament_id = p_tournament_id
   ORDER BY g.tournament_id FOR UPDATE;
  -- The final-table deal authority uses this same order after its money sets.
  -- Holding these locks before any bounty or rake row prevents a reversed
  -- terminal lock chain while retaining the tournament row as the root lock.
  PERFORM 1 FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id ORDER BY tb.id FOR UPDATE;
  PERFORM 1
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY s.id FOR UPDATE OF s;
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id),ARRAY[]::uuid[])
    INTO v_closed_table_ids
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id;
  v_closed_table_count := cardinality(v_closed_table_ids);
  SELECT COALESCE(array_agg(s.id ORDER BY s.id),ARRAY[]::uuid[])
    INTO v_source_seat_ids
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id;
  v_source_seat_count := cardinality(v_source_seat_ids);
  PERFORM 1 FROM public.wallet_transactions w
   WHERE w.related_entity_id = p_tournament_id
   ORDER BY w.id FOR SHARE;
  PERFORM 1 FROM public.tournament_bounty_chests c
   WHERE c.tournament_id = p_tournament_id ORDER BY c.id FOR UPDATE;
  PERFORM 1 FROM public.tournament_bounty_awards a
   WHERE a.tournament_id = p_tournament_id ORDER BY a.id FOR UPDATE;
  PERFORM 1
    FROM public.tournament_bounty_award_recipients r
    JOIN public.tournament_bounty_awards a ON a.id = r.award_id
   WHERE a.tournament_id = p_tournament_id ORDER BY r.id FOR UPDATE OF r;
  PERFORM 1 FROM public.rake_records rr
   WHERE rr.tournament_id = p_tournament_id AND rr.is_tournament
   ORDER BY rr.id FOR SHARE;
  PERFORM 1 FROM public.tournament_rake_settlements rs
   WHERE rs.tournament_id = p_tournament_id FOR UPDATE;

  v_is_bounty := COALESCE(v_t.is_bounty,false)
              OR COALESCE(v_t.is_pko,false)
              OR COALESCE(v_t.is_mystery_bounty,false);

  SELECT round(COALESCE(sum(w.amount),0),2) INTO v_bounty_before
    FROM public.wallet_transactions w
   WHERE w.related_entity_id = p_tournament_id
     AND lower(w.category) = 'bounty';
  -- DIAMOND PHASE 9: a Diamond bounty is a ledger row, not a wallet row.
  IF v_diamond THEN
    SELECT e.bounty_out INTO v_bounty_before
      FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.wallet_transactions w
     WHERE w.related_entity_id = p_tournament_id
       AND lower(w.category) = 'bounty'
       AND (lower(w.type) <> 'credit' OR w.amount <= 0
         OR w.amount::text IN ('NaN','Infinity','-Infinity')
         OR w.amount IS DISTINCT FROM round(w.amount,2))
  ) OR v_bounty_before < 0 OR v_bounty_before > v_t.bounty_pool
     OR COALESCE(v_t.bounty_pool_paid,0) IS DISTINCT FROM v_bounty_before THEN
    RAISE EXCEPTION 'tournament % has overpaid or contradictory bounty evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_is_bounty THEN
    IF v_t.bounty_pool <= 0 THEN
      RAISE EXCEPTION 'funded bounty tournament % has no positive bounty pool',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSIF v_t.bounty_pool <> 0 OR v_bounty_before <> 0
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id = p_tournament_id
                   AND o.kind IN ('bounty','bounty_residual','mystery_bounty'))
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                 WHERE c.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                 WHERE a.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_players tp
                 WHERE tp.tournament_id = p_tournament_id
                   AND COALESCE(tp.current_bounty,0) <> 0) THEN
    RAISE EXCEPTION 'ordinary tournament % carries unfunded bounty state',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF COALESCE(v_t.is_mystery_bounty,false) THEN
    v_mystery_stage := COALESCE(v_t.mystery_bounty_stage,'');
    IF v_mystery_stage NOT IN ('pending','active','complete') THEN
      RAISE EXCEPTION 'tournament % has ambiguous mystery stage % without a receipt',
        p_tournament_id,v_t.mystery_bounty_stage USING ERRCODE = '55000';
    END IF;
    -- A rolling cutover may meet an event whose old finish path already
    -- completed the mystery inventory but never completed cash, rake or the
    -- lifecycle. Treat both active and complete as a funded mystery branch.
    -- Active is settled below; complete must already prove the entire mystery
    -- obligation and every inventory row before the wrapper can continue.
    v_mystery_active := v_mystery_stage IN ('active','complete');
    IF v_mystery_active THEN
      v_mystery_pool_cents := COALESCE(v_t.mystery_bounty_pool_cents,0);
      SELECT COALESCE(sum(c.amount_cents),0) INTO v_inventory_cents
        FROM public.tournament_bounty_chests c
       WHERE c.tournament_id = p_tournament_id;
      IF v_mystery_pool_cents <= 0
         OR v_inventory_cents IS DISTINCT FROM v_mystery_pool_cents
         OR v_mystery_pool_cents > round(v_t.bounty_pool * 100)::bigint
         OR EXISTS (
           SELECT 1 FROM public.tournament_bounty_chests c
            WHERE c.tournament_id = p_tournament_id
              AND (c.amount_cents <= 0 OR c.status NOT IN
                   ('available','reserved','revealed','paid','void')))
         OR EXISTS (
           SELECT 1 FROM public.tournament_bounty_awards a
            WHERE a.tournament_id = p_tournament_id
              AND (a.amount_cents <= 0 OR a.status NOT IN
                   ('reserved','revealed','paid','completed','void'))) THEN
        RAISE EXCEPTION 'tournament % mystery bounty inventory is not exactly funded',
          p_tournament_id USING ERRCODE = 'P0404';
      END IF;
    ELSIF COALESCE(v_t.mystery_bounty_pool_cents,0) <> 0
       OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                   WHERE c.tournament_id = p_tournament_id)
       OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                   WHERE a.tournament_id = p_tournament_id) THEN
      RAISE EXCEPTION 'pending mystery tournament % already carries inventory',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSIF COALESCE(v_t.mystery_bounty_stage,'pending') <> 'pending'
     OR COALESCE(v_t.mystery_bounty_pool_cents,0) <> 0
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                 WHERE c.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                 WHERE a.tournament_id = p_tournament_id) THEN
    RAISE EXCEPTION 'non-mystery tournament % carries mystery bounty state',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(p.amount),0),2) INTO v_cash_before
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND p.source NOT IN (
       'bounty','bounty_residual','own_bounty','mystery_bounty',
       'mystery_bounty_residual','satellite_seat','satellite_ticket',
       'satellite_remainder');
  IF v_cash_before < 0 OR v_cash_before > v_t.prize_pool
     OR EXISTS (SELECT 1 FROM public.tournament_payouts p
                 WHERE p.tournament_id = p_tournament_id
                   AND p.source IN
                     ('satellite_seat','satellite_ticket','satellite_remainder')) THEN
    RAISE EXCEPTION 'tournament % has invalid pre-terminal cash evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(rr.rake_amount),0),2) INTO v_rake_total
    FROM public.rake_records rr
   WHERE rr.tournament_id = p_tournament_id AND rr.is_tournament;
  IF v_diamond THEN
    -- DIAMOND PHASE 8: the fee of a Diamond event is its fee bank (what came
    -- in as fee, less what was refunded), held in custody until it settles.
    SELECT e.fee_balance + e.fee_out INTO v_rake_total
      FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;
  END IF;
  IF v_rake_total < 0 OR v_rake_total::text IN ('NaN','Infinity','-Infinity')
     OR v_rake_total IS DISTINCT FROM round(v_rake_total,2) THEN
    RAISE EXCEPTION 'tournament % has malformed rake records',p_tournament_id
      USING ERRCODE = 'P0404';
  END IF;

  v_accounting:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
  v_deferred:=COALESCE(v_accounting->>'status'='banked_accrual_deferred',false);
  SELECT rs.* INTO v_prior_rake FROM public.tournament_rake_settlements rs
   WHERE rs.tournament_id = p_tournament_id;
  IF FOUND THEN
    IF v_prior_rake.amount IS DISTINCT FROM v_rake_total
       OR v_prior_rake.settled_at IS NULL
       OR (v_prior_rake.attributed_at IS NULL AND NOT v_deferred)
       OR v_prior_rake.attributed_users IS NULL
       OR v_prior_rake.attributed_users < 0
       OR (v_prior_rake.attribution_error IS NOT NULL AND NOT v_deferred)
       OR lower(v_prior_rake.destination) IN ('pending','')
       OR (v_prior_rake.amount > 0 AND v_t.club_id IS NOT NULL AND NOT v_diamond AND NOT v_deferred
           AND (v_prior_rake.attributed_users < 1
             OR (v_prior_rake.destination NOT LIKE 'union:%'
                 AND v_prior_rake.destination NOT LIKE 'chip_retirement:%'))) THEN
      RAISE EXCEPTION 'tournament % has a partial or unattributed prior rake row',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    v_expected_fee := 0;
  ELSE
    v_expected_fee := v_rake_total;
  END IF;

  IF v_diamond THEN
    -- DIAMOND PHASE 8: the escrow shadow of a Diamond event opens here, from
    -- its ledger with its exact parts, so every apply below moves it as a chip
    -- event's evidence moves it and the exact-zero close is the same close.
    PERFORM public.fn_poker_diamond_tournament_open_shadow(p_tournament_id);
  END IF;
  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id FOR UPDATE;
  IF v_e.tournament_id IS NULL
     OR v_e.prize_balance IS DISTINCT FROM round(v_t.prize_pool-v_cash_before,2)
     OR v_e.bounty_balance IS DISTINCT FROM round(v_t.bounty_pool-v_bounty_before,2)
     OR v_e.fee_balance IS DISTINCT FROM v_expected_fee
     OR v_e.prize_balance < 0 OR v_e.bounty_balance < 0
     OR v_e.fee_balance < 0
     OR v_e.closed_at IS NOT NULL
     OR v_e.close_note IS NOT NULL THEN
    RAISE EXCEPTION 'tournament % escrow does not exactly fund its remaining obligations',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Exactly one branch calls exactly one cash authority.
  IF v_mode = 'places' THEN
    v_cash := public.fn_settle_tournament_places(
      p_tournament_id,p_observed_winner_id);
  ELSE
    v_cash := public.fn_settle_tournament_final_table_deal(p_tournament_id);
  END IF;
  IF COALESCE((v_cash->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_cash->>'fully_settled')::boolean,false) IS NOT TRUE
     OR upper(COALESCE(v_cash->>'status','')) <> 'COMPLETING'
     OR jsonb_typeof(v_cash->'payouts') <> 'array'
     OR jsonb_array_length(v_cash->'payouts') < 1
     OR v_cash->>'winner_amount' IS NULL
     OR (v_cash->>'winner_amount')::numeric < 0
     OR (v_cash->>'winner_amount')::numeric IS DISTINCT FROM
          round((v_cash->>'winner_amount')::numeric,2)
     OR (v_mode = 'final_table_deal'
         AND v_cash->>'money_path'
               IS DISTINCT FROM 'fn_settle_tournament_final_table_deal') THEN
    RAISE EXCEPTION 'tournament % cash authority returned a partial result: %',
      p_tournament_id,v_cash USING ERRCODE = 'P0404';
  END IF;

  SELECT t.* INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id FOR UPDATE;
  IF upper(COALESCE(v_t.status::text,'')) <> 'COMPLETING'
     OR COALESCE(v_t.prize_pool_finalized,false) IS NOT TRUE
     OR v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.prize_pool < 0
     OR v_t.prize_pool IS DISTINCT FROM round(v_t.prize_pool,2) THEN
    RAISE EXCEPTION 'tournament % cash authority did not claim one finalized pool',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_winner_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text = 'winner' AND tp.position = 1;
  SELECT tp.user_id INTO v_winner_id
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text = 'winner' AND tp.position = 1;
  IF v_winner_count <> 1 OR v_winner_id IS NULL
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.user_id = v_winner_id
          AND (tp.eliminated_at IS NOT NULL
            OR tp.elimination_sequence IS NOT NULL))
     OR (p_observed_winner_id IS NOT NULL
         AND v_winner_id IS DISTINCT FROM p_observed_winner_id)
     OR (SELECT count(*) FROM jsonb_array_elements(v_cash->'payouts') p
          WHERE (p->>'place')::integer = 1
            AND (p->>'user_id')::uuid = v_winner_id
            AND (p->>'amount')::numeric =
                (v_cash->>'winner_amount')::numeric) <> 1 THEN
    RAISE EXCEPTION 'tournament % cash authority left an ambiguous winner',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*),round(COALESCE(sum(p.amount),0),2)
    INTO v_cash_count,v_cash_total
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND p.source NOT IN (
       'bounty','bounty_residual','own_bounty','mystery_bounty',
       'mystery_bounty_residual','satellite_seat','satellite_ticket',
       'satellite_remainder');
  IF v_cash_total IS DISTINCT FROM v_t.prize_pool
     OR EXISTS (
       SELECT 1 FROM public.tournament_payouts p
        WHERE p.tournament_id = p_tournament_id
          AND p.source NOT IN (
            'bounty','bounty_residual','own_bounty','mystery_bounty',
            'mystery_bounty_residual','satellite_seat','satellite_ticket',
            'satellite_remainder')
          AND (p.amount <= 0 OR p.amount IS DISTINCT FROM round(p.amount,2)
            OR p.idempotency_key IS NULL OR NOT EXISTS (
              SELECT 1 FROM public.wallet_credit_idempotency k
               WHERE k.key = p.idempotency_key
                 AND k.user_id = p.user_id AND k.amount = p.amount))) THEN
    RAISE EXCEPTION 'tournament % cash pool did not settle exactly',p_tournament_id
      USING ERRCODE = 'P0404';
  END IF;

  -- The deal authority returns only the still-live chop shares. That is the
  -- right presentation input for the table animation, but it is not the full
  -- prize-pool receipt when eliminated fixed places were already earned.
  -- Store both contracts explicitly: deal_shares is exactly the live chop;
  -- payouts is every non-bubble cash entitlement reconstructed from durable
  -- payout evidence and final standings. Bubble protection remains a distinct
  -- line, so sum(payouts.amount) + bubble_protection.amount is the full pool.
  IF v_mode = 'final_table_deal' THEN
    v_deal_shares := v_cash->'payouts';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'place',q.place,'user_id',q.user_id,'amount',q.amount)
           ORDER BY q.place,q.user_id),'[]'::jsonb)
    INTO v_full_payouts
    FROM (
      SELECT tp.position AS place,p.user_id,round(sum(p.amount),2) AS amount
        FROM public.tournament_payouts p
        JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id AND tp.user_id = p.user_id
       WHERE p.tournament_id = p_tournament_id
         AND p.source <> 'bubble_protection'
         AND p.source NOT IN (
           'bounty','bounty_residual','own_bounty','mystery_bounty',
           'mystery_bounty_residual','satellite_seat','satellite_ticket',
           'satellite_remainder')
       GROUP BY tp.position,p.user_id
    ) q;
  IF v_t.prize_pool = 0 AND v_full_payouts = '[]'::jsonb THEN
    -- The cash authority returns the derived zero-dollar winner line, but a
    -- zero payment correctly creates no tournament_payouts row.
    v_full_payouts := jsonb_build_array(jsonb_build_object(
      'place',1,'user_id',v_winner_id,'amount',0));
  END IF;
  -- A partly paid obligation has several immutable credit intervals, but
  -- exactly one Bubble recipient. Reconstruct that recipient's total from
  -- the durable payouts already verified against their exact credit keys.
  SELECT count(DISTINCT p.user_id) INTO v_bubble_line_count
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND p.source = 'bubble_protection';
  IF v_bubble_line_count > 1 THEN
    RAISE EXCEPTION 'tournament % has more than one durable bubble payout recipient',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  SELECT jsonb_build_object(
           'user_id',p.user_id,'position',tp.position,'amount',round(sum(p.amount),2))
    INTO v_cash_bubble
    FROM public.tournament_payouts p
    JOIN public.tournament_players tp
      ON tp.tournament_id = p_tournament_id AND tp.user_id = p.user_id
   WHERE p.tournament_id = p_tournament_id
     AND p.source = 'bubble_protection'
   GROUP BY p.user_id,tp.position;
  v_cash_bubble := COALESCE(v_cash_bubble,'null'::jsonb);
  SELECT (p->>'amount')::numeric INTO v_full_winner_amount
    FROM jsonb_array_elements(v_full_payouts) p
   WHERE (p->>'place')::integer = 1;
  IF v_full_winner_amount IS NULL THEN
    RAISE EXCEPTION 'tournament % has no durable winner cash line',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  v_cash := v_cash || jsonb_build_object(
    'payouts',v_full_payouts,
    'deal_shares',v_deal_shares,
    'bubble_protection',v_cash_bubble,
    'winner_amount',v_full_winner_amount);

  IF v_mystery_stage = 'active' THEN
    v_mystery := public.fn_mystery_bounty_settle(
      p_tournament_id,v_winner_id);
    IF COALESCE((v_mystery->>'ok')::boolean,false) IS NOT TRUE
       OR COALESCE((v_mystery->>'balanced')::boolean,false) IS NOT TRUE
       OR COALESCE((v_mystery->>'pool_cents')::bigint,-1)
            IS DISTINCT FROM v_mystery_pool_cents
       OR COALESCE((v_mystery->>'settled_cents')::bigint,-1)
            IS DISTINCT FROM v_mystery_pool_cents
       OR COALESCE((v_mystery->>'variance_cents')::bigint,1) <> 0 THEN
      RAISE EXCEPTION 'tournament % mystery bounty close was partial: %',
        p_tournament_id,v_mystery USING ERRCODE = 'P0404';
    END IF;
    v_mystery_evidence :=
      public.fn_ca_mystery_bounty_completion_evidence(
        p_tournament_id,v_winner_id);
    v_mystery := v_mystery || jsonb_build_object(
      'payment_evidence',v_mystery_evidence,
      'residual_paid_cents',
        (v_mystery_evidence->>'void_chest_cents')::bigint);
  ELSIF v_mystery_stage = 'complete' THEN
    -- No payer is rerun for an already-complete inventory. The preflight
    -- proved exact terminal chests, awards and mystery obligations plus their
    -- immutable credit-key intervals while all rows were locked. Store that
    -- canonical replay result before the bounty-pool finalizer checks the
    -- mystery completion receipt; this is evidence capture, not a second pay.
    v_mystery_evidence :=
      public.fn_ca_mystery_bounty_completion_evidence(
        p_tournament_id,v_winner_id);
    v_mystery := jsonb_build_object(
      'ok',true,'reason','already_complete',
      'pool_cents',v_mystery_pool_cents,
      'settled_cents',v_mystery_pool_cents,
      'unclaimed_cents',
        (v_mystery_evidence->>'void_chest_cents')::bigint,
      'residual_paid_cents',
        (v_mystery_evidence->>'void_chest_cents')::bigint,
      'balanced',true,'variance_cents',0,
      'payment_evidence',v_mystery_evidence);
    INSERT INTO public.tournament_bounty_completion_receipts
      (tournament_id,winner_user_id,mystery_settled_at,mystery_result,updated_at)
    VALUES (p_tournament_id,v_winner_id,now(),v_mystery,now())
    ON CONFLICT (tournament_id) DO UPDATE
      SET mystery_settled_at=COALESCE(
            public.tournament_bounty_completion_receipts.mystery_settled_at,
            EXCLUDED.mystery_settled_at),
          mystery_result=COALESCE(
            public.tournament_bounty_completion_receipts.mystery_result,
            EXCLUDED.mystery_result),
          winner_user_id=COALESCE(
            public.tournament_bounty_completion_receipts.winner_user_id,
            EXCLUDED.winner_user_id),
          updated_at=now();
    IF NOT EXISTS (
      SELECT 1 FROM public.tournament_bounty_completion_receipts r
       WHERE r.tournament_id=p_tournament_id
         AND r.winner_user_id=v_winner_id
         AND r.mystery_settled_at IS NOT NULL
         AND r.mystery_result IS NOT DISTINCT FROM v_mystery
    ) THEN
      RAISE EXCEPTION
        'tournament % completed mystery evidence receipt conflicts with canonical proof',
        p_tournament_id USING ERRCODE = '40001';
    END IF;
  ELSIF COALESCE(v_t.is_mystery_bounty,false) THEN
    v_mystery := jsonb_build_object(
      'ok',true,'reason','never_activated','pool_cents',0,
      'settled_cents',0,'unclaimed_cents',0,'balanced',true,
      'variance_cents',0,'residual_paid_cents',0);
  ELSE
    v_mystery := jsonb_build_object(
      'ok',true,'reason','not_a_mystery_tournament','pool_cents',0,
      'settled_cents',0,'unclaimed_cents',0,'balanced',true,
      'variance_cents',0,'residual_paid_cents',0);
  END IF;

  IF v_is_bounty THEN
    v_bounty := public.fn_finalize_bounty_pool(p_tournament_id,v_winner_id);
    IF COALESCE((v_bounty->>'ok')::boolean,false) IS NOT TRUE
       OR COALESCE((v_bounty->>'funded')::boolean,false) IS NOT TRUE
       OR v_bounty->>'residual' IS NULL
       OR (v_bounty->>'residual')::numeric < 0 THEN
      RAISE EXCEPTION 'tournament % bounty pool close was partial: %',
        p_tournament_id,v_bounty USING ERRCODE = 'P0404';
    END IF;
  ELSE
    v_bounty := jsonb_build_object(
      'ok',true,'funded',true,'residual',0,
      'reason','not_a_bounty_tournament');
  END IF;

  SELECT t.* INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id FOR UPDATE;
  SELECT round(COALESCE(sum(w.amount),0),2) INTO v_bounty_total
    FROM public.wallet_transactions w
   WHERE w.related_entity_id = p_tournament_id
     AND lower(w.category) = 'bounty';
  -- DIAMOND PHASE 9: the same reading after the close.
  IF v_diamond THEN
    SELECT e.bounty_out INTO v_bounty_total
      FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;
  END IF;
  IF v_bounty_total IS DISTINCT FROM v_t.bounty_pool
     OR COALESCE(v_t.bounty_pool_paid,0) IS DISTINCT FROM v_t.bounty_pool
     OR EXISTS (SELECT 1 FROM public.wallet_transactions w
                 WHERE w.related_entity_id = p_tournament_id
                   AND lower(w.category) = 'bounty'
                   AND (lower(w.type) <> 'credit' OR w.amount <= 0
                     OR w.amount IS DISTINCT FROM round(w.amount,2)))
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id = p_tournament_id
                   AND (o.amount_paid IS DISTINCT FROM o.amount_owed
                     OR o.settled_at IS NULL))
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_chests c
                 WHERE c.tournament_id = p_tournament_id
                   AND c.status NOT IN ('paid','void'))
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                 WHERE a.tournament_id = p_tournament_id
                   AND a.status NOT IN ('completed','void'))
     OR (v_mystery_active AND (
          v_mystery_evidence IS NULL
          OR COALESCE((v_mystery_evidence->>'pool_cents')::bigint,-1)
               IS DISTINCT FROM v_mystery_pool_cents
          OR COALESCE((v_mystery_evidence->>'legacy_credit_cents')::bigint,-1)
             + COALESCE((v_mystery_evidence->>'obligation_cents')::bigint,-1)
               IS DISTINCT FROM v_mystery_pool_cents))
     OR EXISTS (
       SELECT 1 FROM public.tournament_bounty_awards a
        WHERE a.tournament_id = p_tournament_id
          AND a.status = 'completed'
          AND (a.paid_at IS NULL
            OR (SELECT COALESCE(sum(r.amount_cents),0)
                  FROM public.tournament_bounty_award_recipients r
                 WHERE r.award_id = a.id) <> a.amount_cents
            OR EXISTS (SELECT 1
                         FROM public.tournament_bounty_award_recipients r
                        WHERE r.award_id = a.id
                          AND r.amount_cents > 0 AND r.paid_at IS NULL))) THEN
    RAISE EXCEPTION 'tournament % bounty obligations or chests remain open',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- current_bounty is the live head/cache, not payment evidence. The older
  -- finalizer clears only the champion when it itself pays a positive ordinary
  -- residual; an already-exhausted pool or mystery residual can therefore
  -- leave a stale live head after every chip is durably paid. Once exact pool,
  -- obligation and inventory conservation is proved above, zero every head in
  -- this same terminal commit so no completed player advertises open value.
  IF v_is_bounty THEN
    UPDATE public.tournament_players
       SET current_bounty = 0
     WHERE tournament_id = p_tournament_id
       AND COALESCE(current_bounty,0) <> 0;
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_players tp
              WHERE tp.tournament_id = p_tournament_id
                AND COALESCE(tp.current_bounty,0) <> 0) THEN
    RAISE EXCEPTION 'tournament % still has a live bounty head after close',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id FOR UPDATE;
  IF v_e.tournament_id IS NULL
     OR v_e.prize_balance IS DISTINCT FROM 0::numeric
     OR v_e.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_e.fee_balance IS DISTINCT FROM v_expected_fee THEN
    RAISE EXCEPTION 'tournament % cash/bounty close did not preserve fee escrow',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  v_rake_result := public.fn_settle_tournament_rake(
    p_tournament_id,'engine.fn_complete_tournament_terminal');
  IF COALESCE((v_rake_result->>'ok')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'tournament % rake authority refused: %',
      p_tournament_id,v_rake_result USING ERRCODE = 'P0404';
  END IF;
  v_accounting:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
  v_deferred:=COALESCE(v_accounting->>'status'='banked_accrual_deferred',false);
  SELECT rs.* INTO v_rake FROM public.tournament_rake_settlements rs
   WHERE rs.tournament_id = p_tournament_id FOR UPDATE;
  IF v_rake.tournament_id IS NULL
     OR v_rake.amount IS DISTINCT FROM v_rake_total
     OR v_rake.settled_at IS NULL OR (v_rake.attributed_at IS NULL AND NOT v_deferred)
     OR v_rake.attributed_users IS NULL OR v_rake.attributed_users < 0
     OR (v_rake.attribution_error IS NOT NULL AND NOT v_deferred)
     OR lower(v_rake.destination) IN ('pending','')
     OR (v_rake.amount > 0 AND v_t.club_id IS NOT NULL AND NOT v_diamond AND NOT v_deferred
         AND (v_rake.attributed_users < 1
           OR (v_rake.destination NOT LIKE 'union:%'
               AND v_rake.destination NOT LIKE 'chip_retirement:%'))) THEN
    RAISE EXCEPTION 'tournament % rake attribution did not complete: %',
      p_tournament_id,v_rake_result USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id FOR UPDATE;
  IF v_e.tournament_id IS NULL
     OR v_e.prize_balance IS DISTINCT FROM 0::numeric
     OR v_e.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_e.fee_balance IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION 'tournament % did not close all three escrow banks',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  v_completed_at := COALESCE(v_t.ended_at,transaction_timestamp());
  -- Persist the exact-zero proof before lifecycle. The historical after-status
  -- observer was detached above; this authority is now the only owner of the
  -- terminal escrow marker.
  UPDATE public.tournament_escrow
     SET closed_at = v_completed_at,
         close_note = 'terminal receipt: exact zero',
         updated_at = now()
   WHERE tournament_id = p_tournament_id
     AND prize_balance = 0 AND bounty_balance = 0 AND fee_balance = 0;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'tournament % lost its exact zero escrow close',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  -- Explicitly release every live seat and close every tournament table in
  -- this transaction. No timer, table manager or lifecycle watcher is part of
  -- the completion contract. IDs and counts are captured for immutable replay.
  WITH released AS (
    UPDATE public.table_seats s
       SET left_at = v_completed_at,
           status = 'left',
           leave_pending = false,
           is_sitting_out = false,
           is_away = false,
           sit_out_at = NULL,
           scheduled_leave_hands = NULL
      FROM public.tables tb
     WHERE tb.id = s.table_id
       AND tb.tournament_id = p_tournament_id
       AND s.left_at IS NULL
    RETURNING s.id
  )
  SELECT COALESCE(array_agg(r.id ORDER BY r.id),ARRAY[]::uuid[])
    INTO v_released_seat_ids
    FROM released r;
  v_released_seat_count := cardinality(v_released_seat_ids);

  -- Preserve an earlier departure time, but canonicalize every other mutable
  -- occupancy flag before the immutable source-seat snapshot is committed.
  UPDATE public.table_seats s
     SET status = 'left',
         leave_pending = false,
         is_sitting_out = false,
         is_away = false,
         sit_out_at = NULL,
         scheduled_leave_hands = NULL
   WHERE s.id = ANY(v_source_seat_ids)
     AND s.left_at IS NOT NULL
     AND (s.status IS DISTINCT FROM 'left'
       OR s.leave_pending IS DISTINCT FROM false
       OR s.is_sitting_out IS DISTINCT FROM false
       OR s.is_away IS DISTINCT FROM false
       OR s.sit_out_at IS NOT NULL
       OR s.scheduled_leave_hands IS NOT NULL);

  -- Publish terminal lifecycle after every seat is released but before table
  -- rows close. The managed table-status observer therefore sees a genuinely
  -- terminal parent and does not emit a false live-tournament incident. The
  -- deferred receipt constraint still requires the receipt later in this same
  -- transaction; any table or receipt failure rolls this update back too.
  UPDATE public.tournaments
     SET status = 'COMPLETED',
         ended_at = v_completed_at,
         on_break = false,
         break_started_at = NULL,
         break_ends_at = NULL,
         updated_at = now()
   WHERE id = p_tournament_id
     AND upper(COALESCE(status::text,'')) = 'COMPLETING';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'tournament % lost its terminal lifecycle claim',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  UPDATE public.tables
     SET status = 'closed',
         lifecycle = 'closed',
         current_players = 0,
         terminal_closed_at = v_completed_at,
         updated_at = now()
   WHERE tournament_id = p_tournament_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows IS DISTINCT FROM v_closed_table_count
     OR EXISTS (
       SELECT 1 FROM public.tables tb
        WHERE tb.tournament_id = p_tournament_id
          AND (lower(COALESCE(tb.status::text,'')) <> 'closed'
            OR lower(COALESCE(tb.lifecycle,'')) <> 'closed'
            OR tb.current_players IS DISTINCT FROM 0
            OR tb.terminal_closed_at IS DISTINCT FROM v_completed_at))
     OR EXISTS (
       SELECT 1
         FROM public.table_seats s
         JOIN public.tables tb ON tb.id = s.table_id
        WHERE tb.tournament_id = p_tournament_id
          AND (s.left_at IS NULL
            OR s.status IS DISTINCT FROM 'left'
            OR s.leave_pending IS DISTINCT FROM false
            OR s.is_sitting_out IS DISTINCT FROM false
            OR s.is_away IS DISTINCT FROM false
            OR s.sit_out_at IS NOT NULL
            OR s.scheduled_leave_hands IS NOT NULL)) THEN
    RAISE EXCEPTION 'tournament % did not durably release every seat and close every table',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  INSERT INTO public.tournament_terminal_settlements
    (tournament_id,winner_id,settlement_mode,started_status,
     prize_pool,bounty_pool,cash_payout_count,cash_payout_total,
     bounty_payout_total,mystery_was_active,mystery_pool_cents,
     cash_receipt,mystery_receipt,bounty_receipt,
     closed_table_count,closed_table_ids,source_seat_count,source_seat_ids,
     released_seat_count,released_seat_ids,
     rake_amount,rake_destination,rake_settled_at,rake_attributed_at,
     rake_attributed_users,escrow_closed_at,escrow_close_note,
     completed_at,settled_at,receipt_version,accounting_state)
  VALUES
    (p_tournament_id,v_winner_id,v_mode,v_started_status,
     v_t.prize_pool,v_t.bounty_pool,v_cash_count,v_cash_total,
     v_bounty_total,v_mystery_active,v_mystery_pool_cents,
     v_cash,v_mystery,v_bounty,
     v_closed_table_count,v_closed_table_ids,
     v_source_seat_count,v_source_seat_ids,
     v_released_seat_count,v_released_seat_ids,
     v_rake.amount,v_rake.destination,v_rake.settled_at,v_rake.attributed_at,
     v_rake.attributed_users,v_completed_at,'terminal receipt: exact zero',
     v_completed_at,transaction_timestamp(),CASE WHEN v_accounting IS NULL THEN 1 ELSE 2 END,COALESCE(v_accounting->>'status','legacy'));

  RETURN public.fn_ca_tournament_terminal_receipt(
    p_tournament_id,p_observed_winner_id);
END;
$function$;
ALTER FUNCTION public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text) OWNER TO "postgres";
DO $acl$ DECLARE grantee text; BEGIN FOR grantee IN
 SELECT DISTINCT CASE WHEN ac.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ac.grantee) END
 FROM pg_proc pr CROSS JOIN LATERAL aclexplode(COALESCE(pr.proacl,acldefault('f',pr.proowner))) ac
 WHERE pr.oid=to_regprocedure('public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)') LOOP
 EXECUTE 'REVOKE ALL ON FUNCTION public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text) FROM '||CASE WHEN grantee='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(grantee) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text) TO "postgres";

-- Captured full-definition MD5 c64e049911fd99c1d784cdb042ca714b
CREATE OR REPLACE FUNCTION public.fn_complete_tournament_terminal(p_tournament_id uuid, p_observed_winner_id uuid, p_settlement_mode text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '45s'
AS $function$
DECLARE
  v_token uuid;
  v_result jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'terminal settlement requires service authority'
      USING ERRCODE='28000';
  END IF;
  PERFORM public.fn_ca_lock_settlement_lane_for_finish(p_tournament_id);
  v_token:=public.fn_ca_open_tournament_seat_exit_authority(
    p_tournament_id,'terminal_finish',NULL);
  BEGIN
    v_result:=public.fn_complete_tournament_terminal_pre_seat_guard(
      p_tournament_id,p_observed_winner_id,p_settlement_mode);
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(
      v_token,COALESCE((v_result->>'ok')::boolean,false));
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,false);
    RAISE;
  END;
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text) OWNER TO "postgres";
DO $acl$ DECLARE grantee text; BEGIN FOR grantee IN
 SELECT DISTINCT CASE WHEN ac.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ac.grantee) END
 FROM pg_proc pr CROSS JOIN LATERAL aclexplode(COALESCE(pr.proacl,acldefault('f',pr.proowner))) ac
 WHERE pr.oid=to_regprocedure('public.fn_complete_tournament_terminal(uuid,uuid,text)') LOOP
 EXECUTE 'REVOKE ALL ON FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text) FROM '||CASE WHEN grantee='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(grantee) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text) TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text) TO "service_role";

-- Captured full-definition MD5 d5339cec8b0e00be748c4c15bc3dba83
CREATE OR REPLACE FUNCTION public.fn_lock_accounting_tournament_recognition_week(p_tournament_id uuid, p_recognized_at timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$DECLARE scope record;week_start timestamptz;week_end timestamptz;BEGIN
 week_start:=public.fn_union_week_start(p_recognized_at);
 week_end:=((week_start AT TIME ZONE 'America/Los_Angeles')+interval '7 days') AT TIME ZONE 'America/Los_Angeles';
 FOR scope IN
  WITH scopes AS (
   SELECT coordinator_union_id,club_id FROM public.accounting_tournament_fee_sources WHERE tournament_id=p_tournament_id
   UNION
   -- The actual bank also participates in the same close order. A legacy event
   -- may have no captured contributor; this names its game bank, never guesses
   -- a contributor's historical membership or commission agreement.
   SELECT f.union_id,t.club_id FROM public.tournaments t
    JOIN public.accounting_tournament_fee_sources f ON f.tournament_id=t.id WHERE t.id=p_tournament_id AND t.club_id IS NOT NULL
   UNION
   SELECT CASE WHEN t.is_private THEN NULL ELSE t.union_id END,t.club_id FROM public.tournaments t
    WHERE t.id=p_tournament_id AND t.club_id IS NOT NULL
     AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources f WHERE f.tournament_id=t.id)
  ) SELECT DISTINCT coordinator_union_id,club_id,
   CASE WHEN coordinator_union_id IS NULL THEN 'club-accounting:'||club_id::text ELSE 'union-accounting:'||coordinator_union_id::text END
    ||':'||extract(epoch FROM week_start)::text||':'||extract(epoch FROM week_end)::text lock_key
  FROM scopes ORDER BY lock_key
 LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(scope.lock_key,0));
  IF EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r WHERE r.period_start<=p_recognized_at AND r.period_end>p_recognized_at
   AND ((r.union_id IS NOT NULL AND r.union_id=scope.coordinator_union_id)
     OR (r.standalone_club_id IS NOT NULL AND scope.coordinator_union_id IS NULL AND r.standalone_club_id=scope.club_id))) THEN
   RAISE EXCEPTION 'tournament_accrual_closed_period_requires_adjustment' USING ERRCODE='23514'; END IF;
 END LOOP;
END$function$;
ALTER FUNCTION public.fn_lock_accounting_tournament_recognition_week(uuid,timestamp with time zone) OWNER TO "postgres";
DO $acl$ DECLARE grantee text; BEGIN FOR grantee IN
 SELECT DISTINCT CASE WHEN ac.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ac.grantee) END
 FROM pg_proc pr CROSS JOIN LATERAL aclexplode(COALESCE(pr.proacl,acldefault('f',pr.proowner))) ac
 WHERE pr.oid=to_regprocedure('public.fn_lock_accounting_tournament_recognition_week(uuid,timestamp with time zone)') LOOP
 EXECUTE 'REVOKE ALL ON FUNCTION public.fn_lock_accounting_tournament_recognition_week(uuid,timestamp with time zone) FROM '||CASE WHEN grantee='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(grantee) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_lock_accounting_tournament_recognition_week(uuid,timestamp with time zone) TO "postgres";

-- Captured full-definition MD5 c412c8b17186976df139f73a706175f2
CREATE OR REPLACE FUNCTION public.fn_settle_tournament_places(p_tournament_id uuid, p_observed_winner_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_t record;
  v_ladder jsonb;
  v_payouts jsonb := '[]'::jsonb;
  v_status text;
  v_live_count integer;
  v_field_size integer;
  v_eliminated_count integer;
  v_sequenced_count integer;
  v_bubble_place integer;
  v_bubble_user_id uuid;
  v_bubble_amount numeric := 0;
  v_bubble_payout_count integer := 0;
  v_bubble_paid numeric := 0;
  v_bubble_ob_count integer := 0;
  v_bubble_ob public.tournament_obligations%ROWTYPE;
  v_bubble_result jsonb;
  v_winner public.tournament_players%ROWTYPE;
  v_row record;
  v_place integer;
  v_amount numeric;
  v_user_id uuid;
  v_ob public.tournament_obligations%ROWTYPE;
  v_evidence numeric;
  v_evidence_count integer;
  v_total_expected numeric := 0;
  v_winner_amount numeric := 0;
  v_result jsonb;
  v_guarantee_result jsonb;
  v_rows integer;
  v_unwitnessed_busts integer;
  v_misplaced_busts integer;
BEGIN
  -- Every rolling and terminal money authority enters one transaction lane
  -- before it can own an event, obligation, bank, or recipient row.
  PERFORM public.fn_ca_lock_settlement_lane_global();
  IF p_tournament_id IS NULL OR p_observed_winner_id IS NULL THEN
    RAISE EXCEPTION 'place settlement requires tournament and observed winner ids'
      USING ERRCODE = '22004';
  END IF;

  -- Canonical lock order. Re-locks inside owner-only callees are rows already
  -- owned by this transaction and therefore cannot invert a wait dependency.
  SELECT t.id, t.status, t.variant, t.tournament_type, t.is_premium_spin,
         t.satellite_target_id, t.satellite_target, t.prize_pool,
         t.bubble_protection, t.buy_in_amount, t.guaranteed_prize,
         t.prize_pool_finalized
    INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  v_status := upper(COALESCE(v_t.status,''));
  IF v_status NOT IN ('RUNNING','COMPLETING','COMPLETED') THEN
    RAISE EXCEPTION 'tournament % cannot settle from status %',
      p_tournament_id, v_t.status USING ERRCODE = '55000';
  END IF;
  IF lower(COALESCE(v_t.variant,'')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type,'')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL
     OR v_t.satellite_target IS NOT NULL THEN
    RAISE EXCEPTION 'tournament % is a satellite, not an ordinary cash ladder',
      p_tournament_id USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_payouts p
              WHERE p.tournament_id = p_tournament_id
                AND lower(COALESCE(p.source,'')) = 'final_table_deal')
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id = p_tournament_id
                   AND o.kind = 'final_table_deal') THEN
    RAISE EXCEPTION
      'tournament % carries final-table-deal evidence; use the deal authority',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- Funding the advertised guarantee is part of this settlement transaction,
  -- not a best-effort request made by the game process immediately beforehand.
  -- fn_apply_prize_guarantee re-locks the row already owned here and either
  -- debits the event-owned bank plus finalizes the pool, or raises. Prove its
  -- receipt against the refreshed row before deriving even the first place; a
  -- refusal therefore rolls back the overlay, every payout and the finish.
  IF v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.prize_pool < 0
     OR v_t.prize_pool IS DISTINCT FROM round(v_t.prize_pool, 2) THEN
    RAISE EXCEPTION 'tournament % has invalid whole-cent prize pool %',
      p_tournament_id, v_t.prize_pool USING ERRCODE = '22003';
  END IF;
  IF v_t.guaranteed_prize IS NOT NULL
     AND (v_t.guaranteed_prize::text IN ('NaN','Infinity','-Infinity')
       OR v_t.guaranteed_prize < 0
       OR v_t.guaranteed_prize IS DISTINCT FROM round(v_t.guaranteed_prize, 2)) THEN
    RAISE EXCEPTION 'tournament % has invalid whole-cent guarantee %',
      p_tournament_id, v_t.guaranteed_prize USING ERRCODE = '22003';
  END IF;
  v_guarantee_result := public.fn_apply_prize_guarantee(
    p_tournament_id, 'engine.fn_settle_tournament_places');
  IF COALESCE((v_guarantee_result->>'ok')::boolean, false) IS NOT TRUE
     OR (COALESCE((v_guarantee_result->>'overlay')::numeric,0) > 0
         AND COALESCE(
           (v_guarantee_result->>'overlay_journaled')::boolean,false)
             IS NOT TRUE) THEN
    RAISE EXCEPTION 'tournament % guarantee funding refused: %',
      p_tournament_id, v_guarantee_result USING ERRCODE = 'P0404';
  END IF;

  SELECT t.id, t.status, t.variant, t.tournament_type, t.is_premium_spin,
         t.satellite_target_id, t.satellite_target, t.prize_pool,
         t.bubble_protection, t.buy_in_amount, t.guaranteed_prize,
         t.prize_pool_finalized
    INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF COALESCE(v_t.prize_pool_finalized, false) IS NOT TRUE
     OR v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.prize_pool IS DISTINCT FROM round(v_t.prize_pool, 2)
     OR v_t.prize_pool < COALESCE(v_t.guaranteed_prize, 0)
     OR v_guarantee_result->>'prize_pool' IS NULL
     OR (v_guarantee_result->>'prize_pool')::numeric IS DISTINCT FROM v_t.prize_pool THEN
    RAISE EXCEPTION
      'tournament % guarantee funding did not produce one finalized locked pool: result %, pool %, guarantee %, finalized %',
      p_tournament_id, v_guarantee_result, v_t.prize_pool,
      v_t.guaranteed_prize, v_t.prize_pool_finalized USING ERRCODE = 'P0404';
  END IF;

  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
   ORDER BY tp.id FOR UPDATE;
  SELECT count(*) INTO v_field_size
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  IF EXISTS (SELECT 1 FROM public.tournament_players tp
              WHERE tp.tournament_id = p_tournament_id
                AND tp.status::text = 'registered') THEN
    RAISE EXCEPTION 'tournament % still has a registered unresolved player',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- The helper counts the final field, so derive only after the complete
  -- roster has joined the canonical tournament -> roster lock sequence.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'place',a.place,'amount',a.amount) ORDER BY a.place),'[]'::jsonb)
    INTO v_ladder
    FROM public.fn_ca_tournament_place_amounts(p_tournament_id) a;
  IF jsonb_array_length(v_ladder) = 0 THEN
    RAISE EXCEPTION 'tournament % derived an empty ladder', p_tournament_id
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO v_live_count FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text IN ('playing','winner');
  IF v_live_count > 1 THEN
    RAISE EXCEPTION 'tournament % still has % live players',
      p_tournament_id, v_live_count USING ERRCODE = '55000';
  ELSIF v_live_count = 1 THEN
    SELECT tp.* INTO v_winner FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text IN ('playing','winner');
  ELSE
    -- The observed last survivor may already have crossed through
    -- `eliminated` in an all-in race. The committed transition sequence, not
    -- a wall clock, proves that this row was the final elimination.
    SELECT tp.* INTO v_winner FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.user_id = p_observed_winner_id
       AND tp.status::text = 'eliminated'
       AND tp.elimination_sequence IS NOT NULL;
    IF FOUND AND EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.id <> v_winner.id
         AND tp.elimination_sequence = v_winner.elimination_sequence
    ) THEN
      RAISE EXCEPTION
        'tournament % has an ambiguous final elimination witness',
        p_tournament_id USING ERRCODE = '23505';
    END IF;
    IF FOUND AND EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status::text = 'eliminated'
         AND (tp.elimination_sequence IS NULL
              OR tp.elimination_sequence > v_winner.elimination_sequence)
    ) THEN
      v_winner := NULL;
    END IF;
  END IF;
  IF v_winner.id IS NULL OR v_winner.user_id IS DISTINCT FROM p_observed_winner_id THEN
    RAISE EXCEPTION 'observed winner % does not match locked winner % for tournament %',
      p_observed_winner_id, v_winner.user_id, p_tournament_id
      USING ERRCODE = '40001';
  END IF;

  -- Lock the whole set once, before validation or the ascending-place walk.
  PERFORM 1 FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
   ORDER BY o.kind, o.place NULLS LAST, o.id FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
       AND (o.place IS NULL OR NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_ladder) a
          WHERE (a->>'place')::integer = o.place))
  ) THEN
    RAISE EXCEPTION
      'tournament % has a place obligation outside its derived ladder',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  IF v_status = 'COMPLETED' THEN
    IF v_winner.status::text <> 'winner' OR v_winner.position <> 1 THEN
      RAISE EXCEPTION
        'COMPLETED tournament % is not an exact replay: winner is not durable',
        p_tournament_id USING ERRCODE = '55000';
    END IF;
  ELSE
    -- Recorded finish positions are the engine's live witness. Never rebuild
    -- an all-busted field from timestamps. Promotion may fill first place, but
    -- it cannot displace another recorded first or vacate a ladder place.
    IF EXISTS (SELECT 1 FROM public.tournament_players tp
                WHERE tp.tournament_id = p_tournament_id
                  AND tp.position = 1
                  AND tp.user_id <> v_winner.user_id) THEN
      RAISE EXCEPTION 'tournament % assigns first place to another player',
        p_tournament_id USING ERRCODE = '23505';
    END IF;
    IF v_winner.position IS NOT NULL AND v_winner.position <> 1
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_ladder) a
                    WHERE (a->>'place')::integer = v_winner.position) THEN
      RAISE EXCEPTION
        'promoting winner % would vacate cash place % in tournament %',
        v_winner.user_id, v_winner.position, p_tournament_id
        USING ERRCODE = '55000';
    END IF;
    UPDATE public.tournament_players
       SET status = 'winner', position = 1,
           eliminated_at = NULL, elimination_sequence = NULL
     WHERE id = v_winner.id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION
        'tournament % could not promote exactly one winner',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    -- Final numeric positions are derived from the transition witness, not
    -- from the field size that happened to exist when each player busted.
    -- This is the root fix for late registration enlarging the field after an
    -- early elimination. Existing money evidence is never relabelled: a
    -- legacy event whose paid place would move fails closed for explicit
    -- adjudication instead of rewriting settled history.
    SELECT count(*), count(tp.elimination_sequence),
           count(DISTINCT tp.elimination_sequence)
      INTO v_eliminated_count, v_sequenced_count, v_rows
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text = 'eliminated';
    IF v_eliminated_count <> v_field_size - 1
       OR v_sequenced_count <> v_eliminated_count
       OR v_rows <> v_eliminated_count THEN
      RAISE EXCEPTION
        'tournament % has no complete durable elimination sequence (%/% of %)',
        p_tournament_id, v_sequenced_count, v_rows, v_eliminated_count
        USING ERRCODE = 'P0404';
    END IF;

    /* A BUST IS RANKED BY WHEN IT HAPPENED (2026-09-11). Places were
       numbered in elimination_sequence order, which a trigger stamps when
       the knockout door RECORDS a bust, so a bust the door recorded hours
       late was paid a place it did not finish in. Each eliminated row is now
       ranked by when its bust happened, derived in the statement that uses
       it from what the door proved: the commit time of the accepted hand of
       the player's latest 'eliminated' knockout generation, plus one
       microsecond per earlier rank in that hand (smaller hand-start stack
       first, then user id - the rule the door stamps eliminated_at with).
       Busts in different hands are ordered by those hands' commit times.
       The hand-history prune deletes a horse-only hand's commit row after
       its retention window, and only a PENDING generation protects it; the
       generation rows themselves are never pruned, so a hand whose commit
       is gone is timed by when its first generation was captured (the
       earliest created_at of that hand's generations, written before the
       commit) - one time for the whole hand, so the same-hand stack rank
       still decides within it - never by when a bust was recorded. A row
       with no such witness keeps its eliminated_at; a row with neither is
       refused, never guessed. Equal times fall back to
       elimination_sequence, then id. elimination_sequence alone still names
       the last elimination, and so the winner, above. The same order decides
       whether anything moves, so a ladder already in true order is left
       exactly as it is. */
    WITH busts AS (
      SELECT tp.id, tp.position, tp.elimination_sequence,
             COALESCE((
               SELECT COALESCE(a.committed_at,
                               (SELECT min(g.created_at)
                                  FROM public.tournament_knockout_candidates g
                                 WHERE g.tournament_id = c.tournament_id
                                   AND g.table_id = c.table_id
                                   AND g.hand_number = c.hand_number
                                   AND g.hand_id = c.hand_id))
                      + (SELECT count(*)
                           FROM public.tournament_knockout_candidates s
                          WHERE s.tournament_id = c.tournament_id
                            AND s.table_id = c.table_id
                            AND s.hand_number = c.hand_number
                            AND s.hand_id = c.hand_id
                            AND (s.stack_before, s.eliminated_user_id)
                                < (c.stack_before, c.eliminated_user_id))::integer
                        * interval '1 microsecond'
                 FROM (SELECT k.tournament_id, k.table_id, k.hand_number,
                              k.hand_id, k.stack_before, k.eliminated_user_id
                         FROM public.tournament_knockout_candidates k
                        WHERE k.tournament_id = tp.tournament_id
                          AND k.eliminated_user_id = tp.user_id
                          AND k.state = 'eliminated'
                        ORDER BY k.hand_number DESC, k.id DESC
                        LIMIT 1) c
                 LEFT JOIN public.hand_atomic_commits a
                   ON a.table_id = c.table_id
                  AND a.hand_number = c.hand_number
                  AND a.hand_id = c.hand_id
             ), tp.eliminated_at) AS bust_at
        FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status::text = 'eliminated'
    ),
    ranked AS (
      SELECT b.id, b.position, b.bust_at,
             row_number() OVER (
               ORDER BY b.bust_at DESC, b.elimination_sequence DESC, b.id ASC
             )::integer + 1 AS expected_position
        FROM busts b
    )
    SELECT count(*) FILTER (WHERE ranked.bust_at IS NULL),
           count(*) FILTER (WHERE ranked.position IS DISTINCT FROM ranked.expected_position)
      INTO v_unwitnessed_busts, v_misplaced_busts
      FROM ranked;
    IF v_unwitnessed_busts > 0 THEN
      RAISE EXCEPTION
        'tournament % has % eliminated player(s) with no bust witness and no eliminated_at',
        p_tournament_id, v_unwitnessed_busts USING ERRCODE = 'P0404';
    END IF;

    IF v_misplaced_busts > 0 THEN
      IF EXISTS (
        SELECT 1 FROM public.tournament_payouts p
         WHERE p.tournament_id = p_tournament_id
           AND p."position" IS NOT NULL
      ) OR EXISTS (
        SELECT 1 FROM public.tournament_obligations o
         WHERE o.tournament_id = p_tournament_id
           AND o.kind = 'place'
      ) THEN
        /* Paid places are never relabelled. A COMPLETING event whose
           places are exactly the recording-order ladder was settled by the
           rule this replaces, and is replayed as it was paid, not refused. */
        IF v_status <> 'COMPLETING' OR EXISTS (
          SELECT 1
            FROM (
              SELECT tp.position,
                     row_number() OVER (
                       ORDER BY tp.elimination_sequence DESC, tp.id ASC
                     )::integer + 1 AS expected_position
                FROM public.tournament_players tp
               WHERE tp.tournament_id = p_tournament_id
                 AND tp.status::text = 'eliminated'
            ) recorded
           WHERE recorded.position IS DISTINCT FROM recorded.expected_position
        ) THEN
          RAISE EXCEPTION
            'tournament % needs a late-entry position normalization but already carries settled place evidence',
            p_tournament_id USING ERRCODE = 'P0404';
        END IF;
      ELSE
        UPDATE public.tournament_players tp
           SET position = NULL
         WHERE tp.tournament_id = p_tournament_id
           AND tp.status::text = 'eliminated';

        WITH busts AS (
        SELECT tp.id, tp.position, tp.elimination_sequence,
               COALESCE((
                 SELECT COALESCE(a.committed_at,
                                 (SELECT min(g.created_at)
                                    FROM public.tournament_knockout_candidates g
                                   WHERE g.tournament_id = c.tournament_id
                                     AND g.table_id = c.table_id
                                     AND g.hand_number = c.hand_number
                                     AND g.hand_id = c.hand_id))
                        + (SELECT count(*)
                             FROM public.tournament_knockout_candidates s
                            WHERE s.tournament_id = c.tournament_id
                              AND s.table_id = c.table_id
                              AND s.hand_number = c.hand_number
                              AND s.hand_id = c.hand_id
                              AND (s.stack_before, s.eliminated_user_id)
                                  < (c.stack_before, c.eliminated_user_id))::integer
                          * interval '1 microsecond'
                   FROM (SELECT k.tournament_id, k.table_id, k.hand_number,
                                k.hand_id, k.stack_before, k.eliminated_user_id
                           FROM public.tournament_knockout_candidates k
                          WHERE k.tournament_id = tp.tournament_id
                            AND k.eliminated_user_id = tp.user_id
                            AND k.state = 'eliminated'
                          ORDER BY k.hand_number DESC, k.id DESC
                          LIMIT 1) c
                   LEFT JOIN public.hand_atomic_commits a
                     ON a.table_id = c.table_id
                    AND a.hand_number = c.hand_number
                    AND a.hand_id = c.hand_id
               ), tp.eliminated_at) AS bust_at
          FROM public.tournament_players tp
         WHERE tp.tournament_id = p_tournament_id
           AND tp.status::text = 'eliminated'
        ),
        ranked AS (
          SELECT b.id,
                 row_number() OVER (
                   ORDER BY b.bust_at DESC, b.elimination_sequence DESC, b.id ASC
                 )::integer + 1 AS expected_position
            FROM busts b
        )
        UPDATE public.tournament_players tp
           SET position = ranked.expected_position
          FROM ranked
         WHERE tp.id = ranked.id;
      END IF;
    END IF;
  END IF;

  -- Derive the single pool-funded bubble promise after standings are final.
  -- The percentage helper has already reserved this exact amount from its
  -- ladder. Satellites never enter this authority: their bubble is paid the
  -- residual that cannot buy a full seat by the satellite settle path.
  SELECT max((a->>'place')::integer) + 1
    INTO v_bubble_place
    FROM jsonb_array_elements(v_ladder) a;
  IF COALESCE(v_t.bubble_protection, false)
     AND v_bubble_place IS NOT NULL
     AND v_bubble_place <= v_field_size THEN
    IF v_t.buy_in_amount IS NULL
       OR v_t.buy_in_amount::text IN ('NaN','Infinity','-Infinity')
       OR v_t.buy_in_amount <= 0
       OR v_t.buy_in_amount IS DISTINCT FROM round(v_t.buy_in_amount, 2) THEN
      RAISE EXCEPTION 'tournament % has invalid bubble buy-in %',
        p_tournament_id, v_t.buy_in_amount USING ERRCODE = '22003';
    END IF;
    v_bubble_amount := round(v_t.buy_in_amount, 2);
    IF v_bubble_amount > v_t.prize_pool THEN
      RAISE EXCEPTION 'tournament % bubble amount % exceeds pool %',
        p_tournament_id, v_bubble_amount, v_t.prize_pool
        USING ERRCODE = '23514';
    END IF;

    SELECT count(*), min(tp.user_id::text)::uuid
      INTO v_rows, v_bubble_user_id
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = v_bubble_place
       AND tp.status::text = 'eliminated';
    IF v_rows <> 1 OR v_bubble_user_id IS NULL THEN
      RAISE EXCEPTION 'tournament % has no single eliminated stone bubble at place %',
        p_tournament_id, v_bubble_place USING ERRCODE = 'P0404';
    END IF;
  END IF;

  SELECT count(*), COALESCE(sum(p.amount), 0)
    INTO v_bubble_payout_count, v_bubble_paid
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND p.source = 'bubble_protection';
  SELECT count(*) INTO v_bubble_ob_count
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND o.kind = 'bubble_protection';

  IF v_bubble_amount = 0 THEN
    IF v_bubble_payout_count <> 0 OR v_bubble_paid <> 0
       OR v_bubble_ob_count <> 0 THEN
      RAISE EXCEPTION 'tournament % carries bubble evidence but no bubble is due',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSE
    IF v_bubble_paid > v_bubble_amount
       OR EXISTS (
         SELECT 1 FROM public.tournament_payouts p
          WHERE p.tournament_id = p_tournament_id
            AND p.source = 'bubble_protection'
            AND (p.user_id IS DISTINCT FROM v_bubble_user_id
              OR p."position" IS NOT NULL
              OR p.amount IS NULL
              OR p.amount::text IN ('NaN','Infinity','-Infinity')
              OR p.amount <= 0
              OR p.amount IS DISTINCT FROM round(p.amount, 2)
              OR p.idempotency_key IS NULL
              OR NOT EXISTS (
                SELECT 1 FROM public.wallet_credit_idempotency k
                 WHERE k.key = p.idempotency_key
                   AND k.user_id = p.user_id
                   AND k.amount = p.amount))) THEN
      RAISE EXCEPTION 'tournament % has malformed bubble payout evidence',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    SELECT * INTO v_bubble_ob
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'bubble_protection'
       AND o.user_id = v_bubble_user_id;
    IF v_bubble_ob_count > 0
       AND (v_bubble_ob_count <> 1 OR v_bubble_ob.id IS NULL
         OR v_bubble_ob.place IS NOT NULL
         OR v_bubble_ob.amount_owed IS DISTINCT FROM v_bubble_amount
         OR v_bubble_ob.amount_paid IS DISTINCT FROM v_bubble_paid
         OR v_bubble_ob.amount_paid < 0
         OR v_bubble_ob.amount_paid > v_bubble_ob.amount_owed
         OR (v_bubble_ob.amount_paid = v_bubble_ob.amount_owed) IS DISTINCT FROM
            (v_bubble_ob.settled_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'tournament % has malformed bubble obligation evidence',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    IF v_bubble_ob_count = 0
       AND (v_bubble_payout_count <> 0 OR v_bubble_paid <> 0) THEN
      RAISE EXCEPTION 'tournament % has bubble money without its debt record',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    IF v_status = 'COMPLETED'
       AND (v_bubble_ob_count <> 1
         OR v_bubble_paid IS DISTINCT FROM v_bubble_amount
         OR v_bubble_ob.amount_paid IS DISTINCT FROM v_bubble_amount
         OR v_bubble_ob.settled_at IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM public.tournament_players tp
            WHERE tp.tournament_id = p_tournament_id
              AND tp.user_id = v_bubble_user_id
              AND tp.position = v_bubble_place
              AND tp.prize IS NOT DISTINCT FROM v_bubble_amount)) THEN
      RAISE EXCEPTION 'COMPLETED tournament % has no exact bubble replay',
        p_tournament_id USING ERRCODE = '55000';
    END IF;
  END IF;

  -- Anything paid from the prize bank outside the derived ladder makes a full
  -- structure payout unsafe. Bounty/seat sources belong to other authorities.
  IF EXISTS (
    SELECT 1 FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND COALESCE(p.source,'') NOT IN
           ('bounty','own_bounty','mystery_bounty','mystery_bounty_residual',
            'bounty_residual','satellite_seat','bubble_protection')
       AND (p."position" IS NULL OR NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_ladder) a
          WHERE (a->>'place')::integer = p."position"))
  ) THEN
    RAISE EXCEPTION 'tournament % has prize evidence outside its derived ladder',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- Obligation-shaped wallet identity with no exact payout row is mixed
  -- evidence. It is checked globally before any place can move.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_obligations o
      JOIN public.wallet_credit_idempotency k
        ON k.key LIKE 'tourney:' || p_tournament_id::text || ':obl:' || o.id::text || ':%'
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_payouts p
          WHERE p.idempotency_key = k.key
            AND p.tournament_id = p_tournament_id
            AND p.user_id = k.user_id AND p.amount = k.amount)
  ) THEN
    RAISE EXCEPTION
      'tournament % has wallet-credit identity without payout evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Preflight every place before settling the first one.
  FOR v_row IN
    SELECT (a->>'place')::integer AS place,
           (a->>'amount')::numeric AS amount, tp.user_id,
           tp.prize AS cached_prize
      FROM jsonb_array_elements(v_ladder) a
      LEFT JOIN public.tournament_players tp
        ON tp.tournament_id = p_tournament_id
       AND tp.position = (a->>'place')::integer
     ORDER BY (a->>'place')::integer
  LOOP
    v_place := v_row.place; v_amount := v_row.amount; v_user_id := v_row.user_id;
    IF v_user_id IS NULL THEN
      RAISE EXCEPTION 'tournament % has no finisher for cash place %',
        p_tournament_id, v_place USING ERRCODE = '23502';
    END IF;
    IF v_amount::text IN ('NaN','Infinity','-Infinity') OR v_amount < 0
       OR v_amount IS DISTINCT FROM round(v_amount,2) THEN
      RAISE EXCEPTION 'tournament % derived invalid amount % for place %',
        p_tournament_id, v_amount, v_place USING ERRCODE = '22003';
    END IF;
    v_total_expected := v_total_expected + v_amount;
    IF v_place = 1 THEN v_winner_amount := v_amount; END IF;
    IF v_status = 'COMPLETED'
       AND v_row.cached_prize IS DISTINCT FROM v_amount THEN
      RAISE EXCEPTION
        'COMPLETED tournament %, place % has stale prize cache % (expected %)',
        p_tournament_id, v_place, v_row.cached_prize, v_amount
        USING ERRCODE = '55000';
    END IF;

    -- Each payout row is also required to name an exact wallet-credit identity.
    IF EXISTS (
      SELECT 1 FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id AND p."position" = v_place
         AND (p.user_id IS DISTINCT FROM v_user_id OR p.amount IS NULL
           OR p.amount::text IN ('NaN','Infinity','-Infinity') OR p.amount < 0
           OR p.amount IS DISTINCT FROM round(p.amount,2)
           OR p.idempotency_key IS NULL OR NOT EXISTS (
             SELECT 1 FROM public.wallet_credit_idempotency k
              WHERE k.key = p.idempotency_key AND k.user_id = p.user_id
                AND k.amount = p.amount))
    ) THEN
      RAISE EXCEPTION
        'tournament %, place % has mixed/malformed/wrong-recipient evidence',
        p_tournament_id, v_place USING ERRCODE = 'P0404';
    END IF;
    SELECT count(*), COALESCE(sum(p.amount),0)
      INTO v_evidence_count, v_evidence
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id AND p."position" = v_place;
    v_evidence := round(v_evidence,2);
    IF v_evidence > v_amount THEN
      RAISE EXCEPTION 'tournament %, place % records % above entitlement %',
        p_tournament_id, v_place, v_evidence, v_amount USING ERRCODE = '23514';
    END IF;

    v_ob := NULL;
    SELECT * INTO v_ob FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'place' AND o.place = v_place;
    IF FOUND THEN
      IF v_ob.user_id IS DISTINCT FROM v_user_id OR v_ob.amount_owed IS NULL
         OR v_ob.amount_paid IS NULL
         OR v_ob.amount_owed::text IN ('NaN','Infinity','-Infinity')
         OR v_ob.amount_paid::text IN ('NaN','Infinity','-Infinity')
         OR v_ob.amount_owed IS DISTINCT FROM round(v_ob.amount_owed,2)
         OR v_ob.amount_paid IS DISTINCT FROM round(v_ob.amount_paid,2)
         OR v_ob.amount_owed < 0 OR v_ob.amount_paid < 0
         OR v_ob.amount_paid > v_ob.amount_owed
         OR v_ob.amount_owed > v_amount
         OR v_ob.amount_paid IS DISTINCT FROM v_evidence THEN
        RAISE EXCEPTION 'tournament %, place % has incompatible obligation',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;
    END IF;

    IF v_amount = 0 THEN
      -- Zero-valued ladder places are standings, not debts.
      IF v_evidence <> 0 OR (v_ob.id IS NOT NULL
         AND (v_ob.amount_owed <> 0 OR v_ob.amount_paid <> 0)) THEN
        RAISE EXCEPTION 'zero-value place % in tournament % carries money evidence',
          v_place, p_tournament_id USING ERRCODE = '23514';
      END IF;
    ELSIF v_status = 'COMPLETED' THEN
      IF v_ob.id IS NULL OR v_ob.amount_owed IS DISTINCT FROM v_amount
         OR v_ob.amount_paid IS DISTINCT FROM v_amount
         OR v_evidence IS DISTINCT FROM v_amount THEN
        RAISE EXCEPTION 'COMPLETED tournament %, place % is not an exact replay',
          p_tournament_id, v_place USING ERRCODE = '55000';
      END IF;
    END IF;
  END LOOP;

  IF round(v_total_expected + v_bubble_amount, 2)
       IS DISTINCT FROM v_t.prize_pool THEN
    RAISE EXCEPTION
      'tournament % ladder % plus bubble % does not equal locked pool %',
      p_tournament_id, v_total_expected, v_bubble_amount, v_t.prize_pool
      USING ERRCODE = '23514';
  END IF;

  IF v_status <> 'COMPLETED' THEN
    -- Materialize the bubble and the entire positive ladder before the first
    -- wallet credit. The payment walk is driven from one complete locked debt
    -- set, so failure on any recipient rolls every obligation and credit back.
    IF v_bubble_amount > 0 AND v_bubble_ob_count = 0 THEN
      INSERT INTO public.tournament_obligations
        (tournament_id,kind,place,user_id,amount_owed,amount_paid,source,settled_at)
      VALUES
        (p_tournament_id,'bubble_protection',NULL,v_bubble_user_id,
         v_bubble_amount,0,'engine.fn_settle_tournament_places',NULL)
      RETURNING * INTO v_bubble_ob;
      v_bubble_ob_count := 1;
    END IF;

    FOR v_row IN
      SELECT (a->>'place')::integer AS place,
             (a->>'amount')::numeric AS amount, tp.user_id
        FROM jsonb_array_elements(v_ladder) a
        JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id
         AND tp.position = (a->>'place')::integer
       WHERE (a->>'amount')::numeric > 0
       ORDER BY (a->>'place')::integer
    LOOP
      SELECT COALESCE(sum(p.amount),0) INTO v_evidence
        FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p."position" = v_row.place;

      UPDATE public.tournament_obligations o
         SET amount_owed = v_row.amount,
             source = COALESCE(o.source, 'engine.fn_settle_tournament_places'),
             updated_at = now()
       WHERE o.tournament_id = p_tournament_id
         AND o.kind = 'place' AND o.place = v_row.place;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows = 0 THEN
        INSERT INTO public.tournament_obligations
          (tournament_id,kind,place,user_id,amount_owed,amount_paid,source,settled_at)
        VALUES
          (p_tournament_id,'place',v_row.place,v_row.user_id,v_row.amount,
           v_evidence,'engine.fn_settle_tournament_places',
           CASE WHEN v_evidence = v_row.amount THEN now() ELSE NULL END);
      ELSIF v_rows <> 1 THEN
        RAISE EXCEPTION 'tournament %, place % matched % obligations',
          p_tournament_id, v_row.place, v_rows USING ERRCODE = '23505';
      END IF;
    END LOOP;

    -- Re-lock/prove the complete set immediately before any raw payer runs.
    PERFORM 1 FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind IN ('bubble_protection','place')
     ORDER BY o.kind, o.place NULLS LAST, o.id FOR UPDATE;

    IF v_bubble_amount > 0 THEN
      v_bubble_result := public.fn_ca_settle_tournament_bubble_raw(
        p_tournament_id, v_bubble_user_id, v_bubble_amount);
    END IF;

    FOR v_row IN
      SELECT (a->>'place')::integer AS place,
             (a->>'amount')::numeric AS amount, tp.user_id
        FROM jsonb_array_elements(v_ladder) a
        JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id
         AND tp.position = (a->>'place')::integer
       WHERE (a->>'amount')::numeric > 0
       ORDER BY (a->>'place')::integer
    LOOP
      v_result := public.fn_ca_settle_tournament_place_raw(
        p_tournament_id,v_row.place,v_row.user_id,v_row.amount);
      IF COALESCE((v_result->>'fully_settled')::boolean,false) IS NOT TRUE THEN
        RAISE EXCEPTION 'tournament %, place % returned a partial settlement',
          p_tournament_id, v_row.place USING ERRCODE = 'P0404';
      END IF;
    END LOOP;

    -- tournament_players.prize is presentation cache, stamped only from the
    -- successfully settled DB ladder and in this same transaction.
    UPDATE public.tournament_players SET prize = 0
     WHERE tournament_id = p_tournament_id;
    FOR v_row IN SELECT (a->>'place')::integer AS place,
                         (a->>'amount')::numeric AS amount
                   FROM jsonb_array_elements(v_ladder) a
    LOOP
      UPDATE public.tournament_players SET prize = v_row.amount
       WHERE tournament_id = p_tournament_id AND position = v_row.place;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'could not stamp one prize cache for tournament %, place %',
          p_tournament_id, v_row.place USING ERRCODE = 'P0404';
      END IF;
    END LOOP;

    IF v_bubble_amount > 0 THEN
      UPDATE public.tournament_players
         SET prize = v_bubble_amount
       WHERE tournament_id = p_tournament_id
         AND user_id = v_bubble_user_id
         AND position = v_bubble_place;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION
          'could not stamp one bubble prize cache for tournament %, place %',
          p_tournament_id, v_bubble_place USING ERRCODE = 'P0404';
      END IF;
    END IF;

    IF v_status = 'RUNNING' THEN
      UPDATE public.tournaments SET status = 'COMPLETING'
       WHERE id = p_tournament_id AND status = 'RUNNING';
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'tournament % lost its RUNNING finish claim',
          p_tournament_id USING ERRCODE = '40001';
      END IF;
      v_status := 'COMPLETING';
    END IF;
  END IF;

  IF v_bubble_amount > 0 AND v_status = 'COMPLETED' THEN
    -- Exact replay only: the completed preflight above proved this call cannot
    -- move money, while the raw helper proves every durable receipt again.
    v_bubble_result := public.fn_ca_settle_tournament_bubble_raw(
      p_tournament_id, v_bubble_user_id, v_bubble_amount);
  END IF;

  IF v_bubble_amount > 0 AND NOT EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.user_id = v_bubble_user_id
       AND tp.position = v_bubble_place
       AND tp.prize IS NOT DISTINCT FROM v_bubble_amount
  ) THEN
    RAISE EXCEPTION
      'post-settlement bubble prize-cache proof failed for tournament %, place %',
      p_tournament_id, v_bubble_place USING ERRCODE = 'P0404';
  END IF;

  -- Prove the durable end-state and build the presentation-only receipt.
  FOR v_row IN
    SELECT (a->>'place')::integer AS place,
           (a->>'amount')::numeric AS amount, tp.user_id,
           tp.prize AS cached_prize
      FROM jsonb_array_elements(v_ladder) a
      JOIN public.tournament_players tp
        ON tp.tournament_id = p_tournament_id
       AND tp.position = (a->>'place')::integer
     ORDER BY (a->>'place')::integer
  LOOP
    IF v_row.cached_prize IS DISTINCT FROM v_row.amount THEN
      RAISE EXCEPTION 'post-settlement prize-cache proof failed for tournament %, place %',
        p_tournament_id, v_row.place USING ERRCODE = 'P0404';
    END IF;
    IF v_row.amount > 0 THEN
      v_ob := NULL;
      SELECT * INTO v_ob FROM public.tournament_obligations o
       WHERE o.tournament_id = p_tournament_id
         AND o.kind = 'place' AND o.place = v_row.place;
      SELECT COALESCE(sum(p.amount),0) INTO v_evidence
        FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p."position" = v_row.place AND p.user_id = v_row.user_id;
      IF v_ob.id IS NULL OR v_ob.user_id IS DISTINCT FROM v_row.user_id
         OR v_ob.amount_owed IS DISTINCT FROM v_row.amount
         OR v_ob.amount_paid IS DISTINCT FROM v_row.amount
         OR v_evidence IS DISTINCT FROM v_row.amount THEN
        RAISE EXCEPTION 'post-settlement proof failed for tournament %, place %',
          p_tournament_id, v_row.place USING ERRCODE = 'P0404';
      END IF;
    END IF;
    v_payouts := v_payouts || jsonb_build_object(
      'place',v_row.place,'user_id',v_row.user_id,'amount',v_row.amount);
  END LOOP;

  RETURN jsonb_build_object(
    'ok',true,
    'fully_settled',true,
    'status',v_status,
    'payouts',v_payouts,
    'bubble_protection',CASE WHEN v_bubble_amount > 0 THEN
      jsonb_build_object('user_id',v_bubble_user_id,'position',v_bubble_place,
                         'amount',v_bubble_amount)
      ELSE 'null'::jsonb END,
    'winner_amount',v_winner_amount);
END;
$function$;
ALTER FUNCTION public.fn_settle_tournament_places(uuid,uuid) OWNER TO "postgres";
DO $acl$ DECLARE grantee text; BEGIN FOR grantee IN
 SELECT DISTINCT CASE WHEN ac.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ac.grantee) END
 FROM pg_proc pr CROSS JOIN LATERAL aclexplode(COALESCE(pr.proacl,acldefault('f',pr.proowner))) ac
 WHERE pr.oid=to_regprocedure('public.fn_settle_tournament_places(uuid,uuid)') LOOP
 EXECUTE 'REVOKE ALL ON FUNCTION public.fn_settle_tournament_places(uuid,uuid) FROM '||CASE WHEN grantee='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(grantee) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_places(uuid,uuid) TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_places(uuid,uuid) TO "service_role";

-- Captured full-definition MD5 0492f5a78bc3c84d54c24fd45549a0be
CREATE OR REPLACE FUNCTION public.fn_settle_tournament_rake(p_tournament_id uuid, p_source text DEFAULT 'engine'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
 v_t record;v_prior record;v_claimed int;v_plan jsonb;v_att jsonb;v_res jsonb;
 v_net numeric;v_union uuid;v_dest text;v_reason text;v_raw record;v_bank_id uuid;v_journal_id uuid;v_matches int;
 v_week_start timestamptz;v_week_end timestamptz;v_lock_key text;v_attempt int:=0;
BEGIN
 PERFORM public.fn_ca_lock_settlement_lane_global();
 SELECT t.id,t.status,t.club_id,t.union_id,t.is_private,t.name,t.current_players INTO v_t
  FROM public.tournaments t WHERE t.id=p_tournament_id FOR NO KEY UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','not_found'); END IF;
 IF upper(COALESCE(v_t.status,'')) NOT IN('COMPLETING','COMPLETED','CANCELLED','CANCELED') THEN
  RETURN jsonb_build_object('ok',false,'reason','not_terminal','status',v_t.status); END IF;
 INSERT INTO public.tournament_rake_settlements(tournament_id,club_id,amount,destination,source)
 VALUES(p_tournament_id,v_t.club_id,0,'pending',COALESCE(p_source,'engine')) ON CONFLICT(tournament_id) DO NOTHING;
 GET DIAGNOSTICS v_claimed=ROW_COUNT;
 IF v_claimed=0 THEN
  SELECT * INTO v_prior FROM public.tournament_rake_settlements WHERE tournament_id=p_tournament_id;
  -- Historical claims do not authorize another fee transfer or a success
  -- claim unless their stored attribution actually completed.
  IF v_prior.settled_at IS NULL OR v_prior.attributed_at IS NULL
   OR v_prior.attributed_users IS NULL OR v_prior.attributed_users<0
   OR v_prior.attribution_error IS NOT NULL
   OR NULLIF(v_prior.destination,'') IS NULL OR v_prior.destination='pending' THEN
   RETURN jsonb_build_object('ok',false,'already_settled',true,
    'reason','settlement_attribution_incomplete','amount',v_prior.amount,
    'destination',v_prior.destination,'settled_at',v_prior.settled_at,'attributed',false);
  END IF;
  IF v_prior.amount>0 AND v_prior.union_id IS NULL AND NOT public.fn_poker_diamond_tournament(p_tournament_id)
   AND v_prior.destination IS DISTINCT FROM 'chip_retirement:'||v_prior.club_id::text THEN
   RAISE EXCEPTION 'tournament_fee_legacy_treasury_leg_requires_adjustment' USING ERRCODE='55000'; END IF;
  v_att:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
  IF v_prior.amount>0 AND v_prior.union_id IS NULL AND NOT public.fn_poker_diamond_tournament(p_tournament_id) AND v_att IS NULL THEN
   RAISE EXCEPTION 'tournament_fee_disposition_receipt_missing' USING ERRCODE='55000'; END IF;
  RETURN jsonb_build_object('ok',true,'already_settled',true,'amount',v_prior.amount,'destination',v_prior.destination,
    'settled_at',v_prior.settled_at,'attributed',true,'attributed_users',v_prior.attributed_users,
    'no_attribution_due',v_prior.amount=0,'accounting',v_att);
 END IF;
  -- DIAMOND PHASE 8: a Diamond event's fee sits in its custody rows, not in
  -- rake_records; it goes to the house, and then the emptied custody closes.
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    v_res := public.fn_poker_diamond_tournament_settle_fee(p_tournament_id, COALESCE(p_source, 'engine'));
    v_net := COALESCE((v_res->>'amount')::numeric, 0);
    UPDATE public.tournament_rake_settlements
       SET amount = v_net,
           destination = CASE WHEN v_net > 0 THEN 'diamond_house' ELSE 'none' END,
           settled_at = now(), attributed_at = now(), attributed_users = 0
     WHERE tournament_id = p_tournament_id;
    v_res := public.fn_poker_diamond_tournament_close_custody(p_tournament_id);
    RETURN jsonb_build_object('ok', true, 'amount', v_net,
      'destination', CASE WHEN v_net > 0 THEN 'diamond_house' ELSE 'none' END,
      'attributed', true, 'attributed_users', 0, 'members', 0, 'asset', 'diamonds',
      'custody_closed', v_res->>'closed', 'custody_still_held', v_res->>'still_held');
  END IF;

 -- Deferred capture is normally already committed. A same-transaction Spin
 -- close still captures the original exact charge before it can be recognized.
 FOR v_raw IN SELECT r.id FROM public.rake_records r WHERE r.tournament_id=p_tournament_id AND r.is_tournament
  AND r.rake_amount>0 AND r.created_at=transaction_timestamp()
  AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_batches b WHERE b.rake_record_id=r.id) ORDER BY r.id LOOP
  PERFORM public.fn_stamp_accounting_tournament_fee(v_raw.id);
 END LOOP;
 SELECT COALESCE(sum(r.rake_amount),0) INTO v_net FROM public.rake_records r WHERE r.tournament_id=p_tournament_id AND r.is_tournament;
 IF v_net<0 OR v_net<>round(v_net,2) OR v_net::text IN('NaN','Infinity','-Infinity') THEN
  RAISE EXCEPTION 'tournament_fee_net_invalid' USING ERRCODE='23514'; END IF;
 BEGIN
  v_plan:=public.fn_accounting_tournament_fee_net_plan(p_tournament_id);
 EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM NOT IN('tournament_fee_sources_require_reconciliation','accounting_terms_not_observed','accounting_terms_not_active','tournament_fee_not_captured_by_original_producer') THEN RAISE; END IF;
  v_reason:=SQLERRM;
  -- A new positive fee cannot leave custody before its exact attribution is
  -- available. Throw: direct callers must also roll back the inserted claim.
  IF v_net>0 THEN
   RAISE EXCEPTION 'tournament % rake attribution incomplete: %',p_tournament_id,v_reason USING ERRCODE='P0404';
  END IF;
  -- Exact zero owes no new attribution. Preserve the predecessor's zero-fee
  -- completion without inventing a source, bank, commission or paid receipt.
 END;
 v_union:=CASE WHEN v_reason IS NULL THEN NULLIF(v_plan->>'union_id','')::uuid
  WHEN v_t.is_private THEN NULL ELSE v_t.union_id END;
 PERFORM public.fn_lock_accounting_tournament_recognition_week(p_tournament_id,transaction_timestamp());
 -- A legacy event may have no captured contributor scope. Its actual bank
 -- still takes the exact same close lock, before either wallet is touched.
 v_week_start:=public.fn_union_week_start(transaction_timestamp());
 v_week_end:=((v_week_start AT TIME ZONE 'America/Los_Angeles')+interval '7 days') AT TIME ZONE 'America/Los_Angeles';
 v_lock_key:=CASE WHEN v_union IS NULL THEN 'club-accounting:'||v_t.club_id::text ELSE 'union-accounting:'||v_union::text END
  ||':'||extract(epoch FROM v_week_start)::text||':'||extract(epoch FROM v_week_end)::text;
 IF v_lock_key IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended(v_lock_key,0)); END IF;
 IF EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs x WHERE x.period_start<=transaction_timestamp() AND x.period_end>transaction_timestamp()
   AND ((v_union IS NOT NULL AND x.union_id=v_union) OR(v_union IS NULL AND x.standalone_club_id=v_t.club_id))) THEN
  RAISE EXCEPTION 'tournament_accrual_closed_period_requires_adjustment' USING ERRCODE='23514'; END IF;
 IF v_net>0 THEN
  IF v_t.club_id IS NULL THEN RAISE EXCEPTION 'tournament_fee_bank_club_required' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM public.club_wallets WHERE club_id=v_t.club_id FOR NO KEY UPDATE;
  PERFORM set_config('app.ledger_category','rake',true);
  PERFORM set_config('app.ledger_counterparty','prize_liability',true);
  PERFORM set_config('app.ledger_counterparty_entity',p_tournament_id::text,true);
  IF v_union IS NOT NULL THEN
   v_res:=public.increment_union_wallet(v_union,v_net,v_t.club_id,
    'Tournament rake: '||COALESCE(v_t.name,'tournament')||' [tournament '||p_tournament_id::text||']');
   IF COALESCE((v_res->>'success')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION 'tournament_fee_union_credit_failed' USING ERRCODE='23514'; END IF;
   SELECT count(*),(array_agg(id))[1] INTO v_matches,v_bank_id FROM public.union_wallet_transactions
    WHERE union_id=v_union AND club_id=v_t.club_id AND wallet='rake_wallet' AND direction='credit' AND tx_type='rake'
     AND amount=v_net AND created_at=transaction_timestamp() AND position('[tournament '||p_tournament_id::text||']' IN COALESCE(notes,''))>0;
   v_dest:='union:'||v_union::text;
  ELSE
   -- The original settlement-row trigger removes this exact fee from escrow.
   -- Retire that liability in the canonical journal; never debit a treasury or
   -- call fn_ca_burn, which would take these same chips from a wallet again.
   UPDATE public.clubs SET total_rake=COALESCE(total_rake,0)+v_net,updated_at=now()
    WHERE id=v_t.club_id;
   IF NOT FOUND THEN RAISE EXCEPTION 'tournament_fee_club_missing' USING ERRCODE='23514'; END IF;
   INSERT INTO public.chip_ledger
    (performed_by,from_type,from_entity_id,to_type,to_entity_id,club_id,tournament_id,category,amount,description)
   VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
    'prize_liability',p_tournament_id,'chip_retirement',NULL,v_t.club_id,p_tournament_id,'burn',v_net,
    'Standalone tournament fee retired (fn_settle_tournament_rake)') RETURNING id INTO v_journal_id;
   v_matches:=1;
   v_dest:='chip_retirement:'||v_t.club_id::text;
  END IF;
  IF v_matches<>1 THEN RAISE EXCEPTION 'tournament_fee_exact_bank_receipt_required' USING ERRCODE='23514'; END IF;
  UPDATE public.club_wallets SET period_rake_collected=COALESCE(period_rake_collected,0)+v_net,
   lifetime_rake_collected=COALESCE(lifetime_rake_collected,0)+v_net,updated_at=now() WHERE club_id=v_t.club_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'tournament_fee_club_wallet_missing' USING ERRCODE='23514'; END IF;
 ELSE v_dest:='none'; END IF;
 IF v_reason IS NULL THEN
  -- Preserve the installed bounded retry contract, now around the sole
  -- canonical recognition writer. Exhaustion and permanent errors escape the
  -- whole settlement; rolled-back attempts cannot retain partial attribution.
  LOOP
   v_attempt:=v_attempt+1;
   BEGIN
    v_att:=public.fn_recognize_accounting_tournament_fees(p_tournament_id,transaction_timestamp(),v_t.club_id,v_bank_id,v_journal_id);
    EXIT;
   EXCEPTION WHEN deadlock_detected OR lock_not_available THEN
    IF v_attempt>=4 THEN RAISE; END IF;
    PERFORM pg_sleep(CASE v_attempt WHEN 1 THEN 0.1 WHEN 2 THEN 0.3 ELSE 0.6 END);
   END;
  END LOOP;
  IF v_att->>'status' IS DISTINCT FROM (CASE WHEN v_net>0 THEN 'recognized' ELSE 'cancelled' END)
   OR (v_att->>'attributed_chips')::numeric IS DISTINCT FROM v_net
   OR (v_net>0 AND COALESCE((v_att->>'attributed_users')::int,0)<1) THEN
   RAISE EXCEPTION 'tournament % rake attribution incomplete: canonical source receipt',p_tournament_id USING ERRCODE='P0404';
  END IF;
 END IF;
 UPDATE public.tournament_rake_settlements SET amount=v_net,union_id=v_union,destination=v_dest,settled_at=transaction_timestamp(),
  attributed_at=transaction_timestamp(),attributed_users=COALESCE((v_att->>'attributed_users')::int,0),
  attribution_error=NULL WHERE tournament_id=p_tournament_id;
 RETURN jsonb_build_object('ok',true,'amount',v_net,'destination',v_dest,'attributed',true,
  'attributed_users',COALESCE((v_att->>'attributed_users')::int,0),'attribution_attempts',v_attempt,
  'no_attribution_due',v_net=0,'accounting',public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id));
END;
$function$;
ALTER FUNCTION public.fn_settle_tournament_rake(uuid,text) OWNER TO "postgres";
DO $acl$ DECLARE grantee text; BEGIN FOR grantee IN
 SELECT DISTINCT CASE WHEN ac.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ac.grantee) END
 FROM pg_proc pr CROSS JOIN LATERAL aclexplode(COALESCE(pr.proacl,acldefault('f',pr.proowner))) ac
 WHERE pr.oid=to_regprocedure('public.fn_settle_tournament_rake(uuid,text)') LOOP
 EXECUTE 'REVOKE ALL ON FUNCTION public.fn_settle_tournament_rake(uuid,text) FROM '||CASE WHEN grantee='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(grantee) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_rake(uuid,text) TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_rake(uuid,text) TO "service_role";

-- Captured full-definition MD5 103f192a228084dad0e4268c36c82c4b
CREATE OR REPLACE FUNCTION public.fn_union_week_start(p_at timestamp with time zone DEFAULT now())
 RETURNS timestamp with time zone
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'extensions'
AS $function$
  SELECT date_trunc('week', (p_at AT TIME ZONE 'America/Los_Angeles'))
           AT TIME ZONE 'America/Los_Angeles';
$function$;
ALTER FUNCTION public.fn_union_week_start(timestamp with time zone) OWNER TO "postgres";
DO $acl$ DECLARE grantee text; BEGIN FOR grantee IN
 SELECT DISTINCT CASE WHEN ac.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ac.grantee) END
 FROM pg_proc pr CROSS JOIN LATERAL aclexplode(COALESCE(pr.proacl,acldefault('f',pr.proowner))) ac
 WHERE pr.oid=to_regprocedure('public.fn_union_week_start(timestamp with time zone)') LOOP
 EXECUTE 'REVOKE ALL ON FUNCTION public.fn_union_week_start(timestamp with time zone) FROM '||CASE WHEN grantee='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(grantee) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_union_week_start(timestamp with time zone) TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_union_week_start(timestamp with time zone) TO "authenticated";
GRANT EXECUTE ON FUNCTION public.fn_union_week_start(timestamp with time zone) TO "service_role";

-- Captured full-definition MD5 3fa4099435ff1e9d5c48fa1934b63549
CREATE OR REPLACE FUNCTION public.fn_accounting_agreement_history_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN RAISE EXCEPTION 'accounting_agreement_history_is_immutable' USING ERRCODE='55000'; END $function$;
ALTER FUNCTION public.fn_accounting_agreement_history_immutable() OWNER TO "postgres";
DO $acl$ DECLARE grantee text; BEGIN FOR grantee IN
 SELECT DISTINCT CASE WHEN ac.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ac.grantee) END
 FROM pg_proc pr CROSS JOIN LATERAL aclexplode(COALESCE(pr.proacl,acldefault('f',pr.proowner))) ac
 WHERE pr.oid=to_regprocedure('public.fn_accounting_agreement_history_immutable()') LOOP
 EXECUTE 'REVOKE ALL ON FUNCTION public.fn_accounting_agreement_history_immutable() FROM '||CASE WHEN grantee='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(grantee) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_accounting_agreement_history_immutable() TO "postgres";
GRANT EXECUTE ON FUNCTION public.fn_accounting_agreement_history_immutable() TO "service_role";

-- Captured full-definition MD5 bdc4ee4b75e3471cd33a5ed4b250ec0f
CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_fee_receipt_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$BEGIN
 RAISE EXCEPTION 'accounting_tournament_fee_receipt_is_immutable' USING ERRCODE='55000';
END$function$;
ALTER FUNCTION public.fn_accounting_tournament_fee_receipt_immutable() OWNER TO "postgres";
DO $acl$ DECLARE grantee text; BEGIN FOR grantee IN
 SELECT DISTINCT CASE WHEN ac.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ac.grantee) END
 FROM pg_proc pr CROSS JOIN LATERAL aclexplode(COALESCE(pr.proacl,acldefault('f',pr.proowner))) ac
 WHERE pr.oid=to_regprocedure('public.fn_accounting_tournament_fee_receipt_immutable()') LOOP
 EXECUTE 'REVOKE ALL ON FUNCTION public.fn_accounting_tournament_fee_receipt_immutable() FROM '||CASE WHEN grantee='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(grantee) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_accounting_tournament_fee_receipt_immutable() TO "postgres";

-- Captured full-definition MD5 618843a6d0646709dac2a9c3b24a7652
CREATE OR REPLACE FUNCTION public.fn_tournament_terminal_receipts_are_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  RAISE EXCEPTION
    'tournament terminal settlement evidence is immutable; % is refused for tournament %',
    TG_OP, OLD.tournament_id USING ERRCODE = 'restrict_violation';
END;
$function$;
ALTER FUNCTION public.fn_tournament_terminal_receipts_are_append_only() OWNER TO "postgres";
DO $acl$ DECLARE grantee text; BEGIN FOR grantee IN
 SELECT DISTINCT CASE WHEN ac.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ac.grantee) END
 FROM pg_proc pr CROSS JOIN LATERAL aclexplode(COALESCE(pr.proacl,acldefault('f',pr.proowner))) ac
 WHERE pr.oid=to_regprocedure('public.fn_tournament_terminal_receipts_are_append_only()') LOOP
 EXECUTE 'REVOKE ALL ON FUNCTION public.fn_tournament_terminal_receipts_are_append_only() FROM '||CASE WHEN grantee='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(grantee) END; END LOOP; END $acl$;
GRANT EXECUTE ON FUNCTION public.fn_tournament_terminal_receipts_are_append_only() TO "postgres";
ALTER TABLE public."accounting_routed_settlement_runs" OWNER TO postgres;
DO $acl$ DECLARE grantee text; BEGIN FOR grantee IN
 SELECT DISTINCT CASE WHEN ac.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ac.grantee) END
 FROM pg_class cl CROSS JOIN LATERAL aclexplode(COALESCE(cl.relacl,acldefault('r',cl.relowner))) ac
 WHERE cl.oid='public.accounting_routed_settlement_runs'::regclass LOOP
 EXECUTE 'REVOKE ALL ON TABLE public."accounting_routed_settlement_runs" FROM '||CASE WHEN grantee='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(grantee) END; END LOOP; END $acl$;
GRANT ALL ON TABLE public."accounting_routed_settlement_runs" TO postgres;
GRANT SELECT ON TABLE public."accounting_routed_settlement_runs" TO service_role;
ALTER TABLE public."accounting_routed_settlement_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."accounting_routed_settlement_runs" NO FORCE ROW LEVEL SECURITY;
CREATE TRIGGER accounting_routed_run_immutable BEFORE DELETE OR UPDATE ON public.accounting_routed_settlement_runs FOR EACH ROW EXECUTE FUNCTION fn_accounting_agreement_history_immutable();
CREATE TRIGGER accounting_routed_run_no_truncate BEFORE TRUNCATE ON public.accounting_routed_settlement_runs FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_agreement_history_immutable();
ALTER TABLE public."accounting_tournament_fee_batches" OWNER TO postgres;
DO $acl$ DECLARE grantee text; BEGIN FOR grantee IN
 SELECT DISTINCT CASE WHEN ac.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ac.grantee) END
 FROM pg_class cl CROSS JOIN LATERAL aclexplode(COALESCE(cl.relacl,acldefault('r',cl.relowner))) ac
 WHERE cl.oid='public.accounting_tournament_fee_batches'::regclass LOOP
 EXECUTE 'REVOKE ALL ON TABLE public."accounting_tournament_fee_batches" FROM '||CASE WHEN grantee='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(grantee) END; END LOOP; END $acl$;
GRANT ALL ON TABLE public."accounting_tournament_fee_batches" TO postgres;
GRANT SELECT ON TABLE public."accounting_tournament_fee_batches" TO service_role;
ALTER TABLE public."accounting_tournament_fee_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."accounting_tournament_fee_batches" NO FORCE ROW LEVEL SECURITY;
CREATE TRIGGER accounting_tournament_fee_batches_immutable BEFORE DELETE OR UPDATE ON public.accounting_tournament_fee_batches FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_tournament_fee_batches_no_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_batches FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable();
ALTER TABLE public."accounting_tournament_fee_recognitions" OWNER TO postgres;
DO $acl$ DECLARE grantee text; BEGIN FOR grantee IN
 SELECT DISTINCT CASE WHEN ac.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ac.grantee) END
 FROM pg_class cl CROSS JOIN LATERAL aclexplode(COALESCE(cl.relacl,acldefault('r',cl.relowner))) ac
 WHERE cl.oid='public.accounting_tournament_fee_recognitions'::regclass LOOP
 EXECUTE 'REVOKE ALL ON TABLE public."accounting_tournament_fee_recognitions" FROM '||CASE WHEN grantee='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(grantee) END; END LOOP; END $acl$;
GRANT ALL ON TABLE public."accounting_tournament_fee_recognitions" TO postgres;
GRANT SELECT ON TABLE public."accounting_tournament_fee_recognitions" TO service_role;
ALTER TABLE public."accounting_tournament_fee_recognitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."accounting_tournament_fee_recognitions" NO FORCE ROW LEVEL SECURITY;
CREATE TRIGGER accounting_tournament_fee_recognitions_immutable BEFORE DELETE OR UPDATE ON public.accounting_tournament_fee_recognitions FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_tournament_fee_recognitions_no_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_recognitions FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable();
ALTER TABLE public."accounting_tournament_fee_sources" OWNER TO postgres;
DO $acl$ DECLARE grantee text; BEGIN FOR grantee IN
 SELECT DISTINCT CASE WHEN ac.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ac.grantee) END
 FROM pg_class cl CROSS JOIN LATERAL aclexplode(COALESCE(cl.relacl,acldefault('r',cl.relowner))) ac
 WHERE cl.oid='public.accounting_tournament_fee_sources'::regclass LOOP
 EXECUTE 'REVOKE ALL ON TABLE public."accounting_tournament_fee_sources" FROM '||CASE WHEN grantee='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(grantee) END; END LOOP; END $acl$;
GRANT ALL ON TABLE public."accounting_tournament_fee_sources" TO postgres;
GRANT SELECT ON TABLE public."accounting_tournament_fee_sources" TO service_role;
ALTER TABLE public."accounting_tournament_fee_sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."accounting_tournament_fee_sources" NO FORCE ROW LEVEL SECURITY;
CREATE TRIGGER accounting_tournament_fee_sources_immutable BEFORE DELETE OR UPDATE ON public.accounting_tournament_fee_sources FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_tournament_fee_sources_no_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_sources FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable();
ALTER TABLE public."accounting_tournament_recognized_sources" OWNER TO postgres;
DO $acl$ DECLARE grantee text; BEGIN FOR grantee IN
 SELECT DISTINCT CASE WHEN ac.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(ac.grantee) END
 FROM pg_class cl CROSS JOIN LATERAL aclexplode(COALESCE(cl.relacl,acldefault('r',cl.relowner))) ac
 WHERE cl.oid='public.accounting_tournament_recognized_sources'::regclass LOOP
 EXECUTE 'REVOKE ALL ON TABLE public."accounting_tournament_recognized_sources" FROM '||CASE WHEN grantee='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(grantee) END; END LOOP; END $acl$;
GRANT ALL ON TABLE public."accounting_tournament_recognized_sources" TO postgres;
GRANT SELECT ON TABLE public."accounting_tournament_recognized_sources" TO service_role;
ALTER TABLE public."accounting_tournament_recognized_sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."accounting_tournament_recognized_sources" NO FORCE ROW LEVEL SECURITY;
CREATE TRIGGER accounting_tournament_recognized_sources_immutable BEFORE DELETE OR UPDATE ON public.accounting_tournament_recognized_sources FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable();
CREATE TRIGGER accounting_tournament_recognized_sources_no_truncate BEFORE TRUNCATE ON public.accounting_tournament_recognized_sources FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable();
DO $verify$
DECLARE expected jsonb;actual jsonb;n bigint;
BEGIN
  IF session_user<>'postgres' OR current_user<>'postgres'
     OR current_setting('server_version_num')::integer/10000<>17
     OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>''
     OR current_setting('session_replication_role')<>'origin'
     OR current_setting('qualification.execution_uuid') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR current_database()<>'qual_spin_expiry_'||replace(current_setting('qualification.execution_uuid'),'-','') THEN
    RAISE EXCEPTION 'current accounting catalog requires its exact private PG17 Unix-socket allocation' USING ERRCODE='55000';
  END IF;
  FOR expected IN SELECT value FROM jsonb_array_elements($captured$[{"acl":"{postgres=arwdDxtm/postgres,service_role=r/postgres}","rls":true,"name":"accounting_routed_settlement_runs","owner":"postgres","columns":[{"name":"union_id","type":"uuid","number":1,"default":null,"identity":"","not_null":false,"generated":""},{"name":"period_start","type":"timestamp with time zone","number":2,"default":null,"identity":"","not_null":true,"generated":""},{"name":"period_end","type":"timestamp with time zone","number":3,"default":null,"identity":"","not_null":true,"generated":""},{"name":"round_no","type":"integer","number":4,"default":null,"identity":"","not_null":true,"generated":""},{"name":"routing_version","type":"integer","number":5,"default":"3","identity":"","not_null":true,"generated":""},{"name":"source_fingerprint","type":"text","number":6,"default":null,"identity":"","not_null":true,"generated":""},{"name":"result","type":"jsonb","number":7,"default":null,"identity":"","not_null":true,"generated":""},{"name":"completed_at","type":"timestamp with time zone","number":8,"default":"clock_timestamp()","identity":"","not_null":true,"generated":""},{"name":"standalone_club_id","type":"uuid","number":9,"default":null,"identity":"","not_null":false,"generated":""},{"name":"scope_kind","type":"text","number":10,"default":"\nCASE\n    WHEN (union_id IS NULL) THEN 'club'::text\n    ELSE 'union'::text\nEND","identity":"","not_null":true,"generated":"s"},{"name":"scope_id","type":"uuid","number":11,"default":"COALESCE(union_id, standalone_club_id)","identity":"","not_null":true,"generated":"s"}],"indexes":["CREATE UNIQUE INDEX accounting_routed_settlement_runs_pkey ON public.accounting_routed_settlement_runs USING btree (scope_kind, scope_id, period_start, period_end, round_no)"],"policies":null,"triggers":[{"name":"accounting_routed_run_immutable","enabled":"O","function":"fn_accounting_agreement_history_immutable()","definition":"CREATE TRIGGER accounting_routed_run_immutable BEFORE DELETE OR UPDATE ON public.accounting_routed_settlement_runs FOR EACH ROW EXECUTE FUNCTION fn_accounting_agreement_history_immutable()"},{"name":"accounting_routed_run_no_truncate","enabled":"O","function":"fn_accounting_agreement_history_immutable()","definition":"CREATE TRIGGER accounting_routed_run_no_truncate BEFORE TRUNCATE ON public.accounting_routed_settlement_runs FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_agreement_history_immutable()"}],"force_rls":false,"constraints":[{"name":"accounting_routed_run_one_scope","validated":true,"definition":"CHECK ((num_nonnulls(union_id, standalone_club_id) = 1))"},{"name":"accounting_routed_settlement_runs_check","validated":true,"definition":"CHECK ((period_start < period_end))"},{"name":"accounting_routed_settlement_runs_pkey","validated":true,"definition":"PRIMARY KEY (scope_kind, scope_id, period_start, period_end, round_no)"},{"name":"accounting_routed_settlement_runs_round_no_check","validated":true,"definition":"CHECK ((round_no = ANY (ARRAY[2, 3])))"},{"name":"accounting_routed_settlement_runs_routing_version_check","validated":true,"definition":"CHECK ((routing_version = 3))"}]},{"acl":"{postgres=arwdDxtm/postgres,service_role=r/postgres}","rls":true,"name":"accounting_tournament_fee_batches","owner":"postgres","columns":[{"name":"rake_record_id","type":"uuid","number":1,"default":null,"identity":"","not_null":true,"generated":""},{"name":"tournament_id","type":"uuid","number":2,"default":null,"identity":"","not_null":true,"generated":""},{"name":"source_fingerprint","type":"text","number":3,"default":null,"identity":"","not_null":true,"generated":""},{"name":"status","type":"text","number":4,"default":"'captured'::text","identity":"","not_null":true,"generated":""},{"name":"source_version","type":"integer","number":5,"default":"2","identity":"","not_null":true,"generated":""},{"name":"source_manifest","type":"jsonb","number":6,"default":null,"identity":"","not_null":false,"generated":""},{"name":"rake_amount","type":"numeric","number":7,"default":null,"identity":"","not_null":true,"generated":""},{"name":"captured_at","type":"timestamp with time zone","number":8,"default":"transaction_timestamp()","identity":"","not_null":true,"generated":""}],"indexes":["CREATE UNIQUE INDEX accounting_tournament_fee_batches_pkey ON public.accounting_tournament_fee_batches USING btree (rake_record_id)"],"policies":null,"triggers":[{"name":"accounting_tournament_fee_batches_immutable","enabled":"O","function":"fn_accounting_tournament_fee_receipt_immutable()","definition":"CREATE TRIGGER accounting_tournament_fee_batches_immutable BEFORE DELETE OR UPDATE ON public.accounting_tournament_fee_batches FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable()"},{"name":"accounting_tournament_fee_batches_no_truncate","enabled":"O","function":"fn_accounting_tournament_fee_receipt_immutable()","definition":"CREATE TRIGGER accounting_tournament_fee_batches_no_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_batches FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable()"}],"force_rls":false,"constraints":[{"name":"accounting_tournament_fee_batches_check","validated":true,"definition":"CHECK (((status = 'legacy_unverified'::text) OR (jsonb_typeof(source_manifest) = 'object'::text)))"},{"name":"accounting_tournament_fee_batches_pkey","validated":true,"definition":"PRIMARY KEY (rake_record_id)"},{"name":"accounting_tournament_fee_batches_rake_amount_check","validated":true,"definition":"CHECK (((rake_amount > (0)::numeric) AND (rake_amount = round(rake_amount, 2)) AND ((rake_amount)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text]))))"},{"name":"accounting_tournament_fee_batches_rake_record_id_fkey","validated":true,"definition":"FOREIGN KEY (rake_record_id) REFERENCES rake_records(id)"},{"name":"accounting_tournament_fee_batches_source_version_check","validated":true,"definition":"CHECK ((source_version = 2))"},{"name":"accounting_tournament_fee_batches_status_check","validated":true,"definition":"CHECK ((status = ANY (ARRAY['captured'::text, 'legacy_unverified'::text])))"}]},{"acl":"{postgres=arwdDxtm/postgres,service_role=r/postgres}","rls":true,"name":"accounting_tournament_fee_recognitions","owner":"postgres","columns":[{"name":"tournament_id","type":"uuid","number":1,"default":null,"identity":"","not_null":true,"generated":""},{"name":"recognized_at","type":"timestamp with time zone","number":2,"default":null,"identity":"","not_null":true,"generated":""},{"name":"status","type":"text","number":3,"default":null,"identity":"","not_null":true,"generated":""},{"name":"net_rake","type":"numeric","number":4,"default":null,"identity":"","not_null":true,"generated":""},{"name":"union_id","type":"uuid","number":5,"default":null,"identity":"","not_null":false,"generated":""},{"name":"bank_club_id","type":"uuid","number":6,"default":null,"identity":"","not_null":false,"generated":""},{"name":"union_wallet_transaction_id","type":"uuid","number":7,"default":null,"identity":"","not_null":false,"generated":""},{"name":"bank_journal_id","type":"uuid","number":8,"default":null,"identity":"","not_null":false,"generated":""},{"name":"source_fingerprint","type":"text","number":9,"default":null,"identity":"","not_null":true,"generated":""},{"name":"plan","type":"jsonb","number":10,"default":null,"identity":"","not_null":true,"generated":""}],"indexes":["CREATE UNIQUE INDEX accounting_tournament_fee_recog_union_wallet_transaction_id_key ON public.accounting_tournament_fee_recognitions USING btree (union_wallet_transaction_id)","CREATE UNIQUE INDEX accounting_tournament_fee_recognitions_bank_journal_id_key ON public.accounting_tournament_fee_recognitions USING btree (bank_journal_id)","CREATE UNIQUE INDEX accounting_tournament_fee_recognitions_pkey ON public.accounting_tournament_fee_recognitions USING btree (tournament_id)"],"policies":null,"triggers":[{"name":"accounting_tournament_fee_recognitions_immutable","enabled":"O","function":"fn_accounting_tournament_fee_receipt_immutable()","definition":"CREATE TRIGGER accounting_tournament_fee_recognitions_immutable BEFORE DELETE OR UPDATE ON public.accounting_tournament_fee_recognitions FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable()"},{"name":"accounting_tournament_fee_recognitions_no_truncate","enabled":"O","function":"fn_accounting_tournament_fee_receipt_immutable()","definition":"CREATE TRIGGER accounting_tournament_fee_recognitions_no_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_recognitions FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable()"}],"force_rls":false,"constraints":[{"name":"accounting_tournament_fee_reco_union_wallet_transaction_id_fkey","validated":true,"definition":"FOREIGN KEY (union_wallet_transaction_id) REFERENCES union_wallet_transactions(id)"},{"name":"accounting_tournament_fee_recog_union_wallet_transaction_id_key","validated":true,"definition":"UNIQUE (union_wallet_transaction_id)"},{"name":"accounting_tournament_fee_recognitions_bank_journal_id_fkey","validated":true,"definition":"FOREIGN KEY (bank_journal_id) REFERENCES chip_ledger(id)"},{"name":"accounting_tournament_fee_recognitions_bank_journal_id_key","validated":true,"definition":"UNIQUE (bank_journal_id)"},{"name":"accounting_tournament_fee_recognitions_check","validated":true,"definition":"CHECK (((net_rake = (0)::numeric) OR (bank_club_id IS NOT NULL)))"},{"name":"accounting_tournament_fee_recognitions_check1","validated":true,"definition":"CHECK ((((net_rake = (0)::numeric) AND (union_wallet_transaction_id IS NULL) AND (bank_journal_id IS NULL)) OR ((net_rake > (0)::numeric) AND ((((union_wallet_transaction_id IS NOT NULL))::integer + ((bank_journal_id IS NOT NULL))::integer) = 1))))"},{"name":"accounting_tournament_fee_recognitions_net_rake_check","validated":true,"definition":"CHECK (((net_rake >= (0)::numeric) AND (net_rake = round(net_rake, 2)) AND ((net_rake)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text]))))"},{"name":"accounting_tournament_fee_recognitions_pkey","validated":true,"definition":"PRIMARY KEY (tournament_id)"},{"name":"accounting_tournament_fee_recognitions_status_check","validated":true,"definition":"CHECK ((status = ANY (ARRAY['recognized'::text, 'cancelled'::text, 'banked_accrual_deferred'::text])))"}]},{"acl":"{postgres=arwdDxtm/postgres,service_role=r/postgres}","rls":true,"name":"accounting_tournament_fee_sources","owner":"postgres","columns":[{"name":"id","type":"uuid","number":1,"default":"gen_random_uuid()","identity":"","not_null":true,"generated":""},{"name":"rake_record_id","type":"uuid","number":2,"default":null,"identity":"","not_null":true,"generated":""},{"name":"tournament_id","type":"uuid","number":3,"default":null,"identity":"","not_null":true,"generated":""},{"name":"player_id","type":"uuid","number":4,"default":null,"identity":"","not_null":true,"generated":""},{"name":"club_id","type":"uuid","number":5,"default":null,"identity":"","not_null":true,"generated":""},{"name":"union_id","type":"uuid","number":6,"default":null,"identity":"","not_null":false,"generated":""},{"name":"coordinator_union_id","type":"uuid","number":7,"default":null,"identity":"","not_null":false,"generated":""},{"name":"game_type","type":"text","number":8,"default":null,"identity":"","not_null":true,"generated":""},{"name":"registration_id","type":"uuid","number":9,"default":null,"identity":"","not_null":true,"generated":""},{"name":"source_charge_ledger_id","type":"uuid","number":10,"default":null,"identity":"","not_null":true,"generated":""},{"name":"source_entitlement_id","type":"uuid","number":11,"default":null,"identity":"","not_null":true,"generated":""},{"name":"charged_at","type":"timestamp with time zone","number":12,"default":null,"identity":"","not_null":true,"generated":""},{"name":"rake_credit","type":"numeric","number":13,"default":null,"identity":"","not_null":true,"generated":""},{"name":"contract","type":"jsonb","number":14,"default":null,"identity":"","not_null":true,"generated":""},{"name":"recorded_at","type":"timestamp with time zone","number":15,"default":"transaction_timestamp()","identity":"","not_null":true,"generated":""}],"indexes":["CREATE INDEX accounting_tournament_fee_sources_event ON public.accounting_tournament_fee_sources USING btree (tournament_id, rake_record_id)","CREATE UNIQUE INDEX accounting_tournament_fee_sources_pkey ON public.accounting_tournament_fee_sources USING btree (id)","CREATE UNIQUE INDEX accounting_tournament_fee_sources_rake_record_id_player_id_key ON public.accounting_tournament_fee_sources USING btree (rake_record_id, player_id)","CREATE UNIQUE INDEX accounting_tournament_fee_sources_source_entitlement_id_key ON public.accounting_tournament_fee_sources USING btree (source_entitlement_id)"],"policies":null,"triggers":[{"name":"accounting_tournament_fee_sources_immutable","enabled":"O","function":"fn_accounting_tournament_fee_receipt_immutable()","definition":"CREATE TRIGGER accounting_tournament_fee_sources_immutable BEFORE DELETE OR UPDATE ON public.accounting_tournament_fee_sources FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable()"},{"name":"accounting_tournament_fee_sources_no_truncate","enabled":"O","function":"fn_accounting_tournament_fee_receipt_immutable()","definition":"CREATE TRIGGER accounting_tournament_fee_sources_no_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_sources FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable()"}],"force_rls":false,"constraints":[{"name":"accounting_tournament_fee_sources_pkey","validated":true,"definition":"PRIMARY KEY (id)"},{"name":"accounting_tournament_fee_sources_rake_credit_check","validated":true,"definition":"CHECK (((rake_credit >= (0)::numeric) AND (rake_credit = round(rake_credit, 2)) AND ((rake_credit)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text]))))"},{"name":"accounting_tournament_fee_sources_rake_record_id_fkey","validated":true,"definition":"FOREIGN KEY (rake_record_id) REFERENCES accounting_tournament_fee_batches(rake_record_id)"},{"name":"accounting_tournament_fee_sources_rake_record_id_player_id_key","validated":true,"definition":"UNIQUE (rake_record_id, player_id)"},{"name":"accounting_tournament_fee_sources_source_entitlement_id_key","validated":true,"definition":"UNIQUE (source_entitlement_id)"}]},{"acl":"{postgres=arwdDxtm/postgres,service_role=r/postgres}","rls":true,"name":"accounting_tournament_recognized_sources","owner":"postgres","columns":[{"name":"source_id","type":"uuid","number":1,"default":null,"identity":"","not_null":true,"generated":""},{"name":"tournament_id","type":"uuid","number":2,"default":null,"identity":"","not_null":true,"generated":""},{"name":"recognized_at","type":"timestamp with time zone","number":3,"default":null,"identity":"","not_null":true,"generated":""},{"name":"disposition","type":"text","number":4,"default":null,"identity":"","not_null":true,"generated":""},{"name":"rake_credit","type":"numeric","number":5,"default":null,"identity":"","not_null":true,"generated":""}],"indexes":["CREATE UNIQUE INDEX accounting_tournament_recognized_sources_pkey ON public.accounting_tournament_recognized_sources USING btree (source_id)","CREATE INDEX accounting_tournament_recognized_sources_week ON public.accounting_tournament_recognized_sources USING btree (recognized_at, tournament_id)"],"policies":null,"triggers":[{"name":"accounting_tournament_recognized_sources_immutable","enabled":"O","function":"fn_accounting_tournament_fee_receipt_immutable()","definition":"CREATE TRIGGER accounting_tournament_recognized_sources_immutable BEFORE DELETE OR UPDATE ON public.accounting_tournament_recognized_sources FOR EACH ROW EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable()"},{"name":"accounting_tournament_recognized_sources_no_truncate","enabled":"O","function":"fn_accounting_tournament_fee_receipt_immutable()","definition":"CREATE TRIGGER accounting_tournament_recognized_sources_no_truncate BEFORE TRUNCATE ON public.accounting_tournament_recognized_sources FOR EACH STATEMENT EXECUTE FUNCTION fn_accounting_tournament_fee_receipt_immutable()"}],"force_rls":false,"constraints":[{"name":"accounting_tournament_recognized_sources_disposition_check","validated":true,"definition":"CHECK ((disposition = ANY (ARRAY['earned'::text, 'refunded'::text])))"},{"name":"accounting_tournament_recognized_sources_pkey","validated":true,"definition":"PRIMARY KEY (source_id)"},{"name":"accounting_tournament_recognized_sources_rake_credit_check","validated":true,"definition":"CHECK (((rake_credit >= (0)::numeric) AND (rake_credit = round(rake_credit, 2)) AND ((rake_credit)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text]))))"},{"name":"accounting_tournament_recognized_sources_source_id_fkey","validated":true,"definition":"FOREIGN KEY (source_id) REFERENCES accounting_tournament_fee_sources(id)"},{"name":"accounting_tournament_recognized_sources_tournament_id_fkey","validated":true,"definition":"FOREIGN KEY (tournament_id) REFERENCES accounting_tournament_fee_recognitions(tournament_id)"}]},{"acl":"{postgres=arwdDxtm/postgres}","rls":true,"name":"tournament_terminal_settlements","owner":"postgres","columns":[{"name":"tournament_id","type":"uuid","number":1,"default":null,"identity":"","not_null":true,"generated":""},{"name":"winner_id","type":"uuid","number":2,"default":null,"identity":"","not_null":true,"generated":""},{"name":"settlement_mode","type":"text","number":3,"default":null,"identity":"","not_null":true,"generated":""},{"name":"started_status","type":"text","number":4,"default":null,"identity":"","not_null":true,"generated":""},{"name":"prize_pool","type":"numeric(15,2)","number":5,"default":null,"identity":"","not_null":true,"generated":""},{"name":"bounty_pool","type":"numeric(15,2)","number":6,"default":null,"identity":"","not_null":true,"generated":""},{"name":"cash_payout_count","type":"integer","number":7,"default":null,"identity":"","not_null":true,"generated":""},{"name":"cash_payout_total","type":"numeric(15,2)","number":8,"default":null,"identity":"","not_null":true,"generated":""},{"name":"bounty_payout_total","type":"numeric(15,2)","number":9,"default":null,"identity":"","not_null":true,"generated":""},{"name":"mystery_was_active","type":"boolean","number":10,"default":null,"identity":"","not_null":true,"generated":""},{"name":"mystery_pool_cents","type":"bigint","number":11,"default":null,"identity":"","not_null":true,"generated":""},{"name":"cash_receipt","type":"jsonb","number":12,"default":null,"identity":"","not_null":true,"generated":""},{"name":"mystery_receipt","type":"jsonb","number":13,"default":null,"identity":"","not_null":true,"generated":""},{"name":"bounty_receipt","type":"jsonb","number":14,"default":null,"identity":"","not_null":true,"generated":""},{"name":"closed_table_count","type":"integer","number":15,"default":null,"identity":"","not_null":true,"generated":""},{"name":"closed_table_ids","type":"uuid[]","number":16,"default":null,"identity":"","not_null":true,"generated":""},{"name":"source_seat_count","type":"integer","number":17,"default":null,"identity":"","not_null":true,"generated":""},{"name":"source_seat_ids","type":"uuid[]","number":18,"default":null,"identity":"","not_null":true,"generated":""},{"name":"released_seat_count","type":"integer","number":19,"default":null,"identity":"","not_null":true,"generated":""},{"name":"released_seat_ids","type":"uuid[]","number":20,"default":null,"identity":"","not_null":true,"generated":""},{"name":"rake_amount","type":"numeric(15,2)","number":21,"default":null,"identity":"","not_null":true,"generated":""},{"name":"rake_destination","type":"text","number":22,"default":null,"identity":"","not_null":true,"generated":""},{"name":"rake_settled_at","type":"timestamp with time zone","number":23,"default":null,"identity":"","not_null":true,"generated":""},{"name":"rake_attributed_at","type":"timestamp with time zone","number":24,"default":null,"identity":"","not_null":false,"generated":""},{"name":"rake_attributed_users","type":"integer","number":25,"default":null,"identity":"","not_null":true,"generated":""},{"name":"escrow_closed_at","type":"timestamp with time zone","number":26,"default":null,"identity":"","not_null":true,"generated":""},{"name":"escrow_close_note","type":"text","number":27,"default":null,"identity":"","not_null":true,"generated":""},{"name":"completed_at","type":"timestamp with time zone","number":28,"default":null,"identity":"","not_null":true,"generated":""},{"name":"settled_at","type":"timestamp with time zone","number":29,"default":"transaction_timestamp()","identity":"","not_null":true,"generated":""},{"name":"receipt_version","type":"integer","number":30,"default":"1","identity":"","not_null":true,"generated":""},{"name":"accounting_state","type":"text","number":31,"default":"'legacy'::text","identity":"","not_null":true,"generated":""}],"indexes":["CREATE UNIQUE INDEX tournament_terminal_settlements_pkey ON public.tournament_terminal_settlements USING btree (tournament_id)"],"policies":null,"triggers":[{"name":"tournament_terminal_settlements_append_only","enabled":"O","function":"fn_tournament_terminal_receipts_are_append_only()","definition":"CREATE TRIGGER tournament_terminal_settlements_append_only BEFORE DELETE OR UPDATE ON public.tournament_terminal_settlements FOR EACH ROW EXECUTE FUNCTION fn_tournament_terminal_receipts_are_append_only()"}],"force_rls":false,"constraints":[{"name":"terminal_rake_attribution_matches_accounting_state","validated":true,"definition":"CHECK ((((accounting_state = 'banked_accrual_deferred'::text) AND (rake_attributed_at IS NULL) AND (rake_attributed_users = 0)) OR ((accounting_state <> 'banked_accrual_deferred'::text) AND (rake_attributed_at IS NOT NULL))))"},{"name":"terminal_receipt_version_matches_accounting_state","validated":true,"definition":"CHECK ((receipt_version =\nCASE\n    WHEN (accounting_state = 'legacy'::text) THEN 1\n    ELSE 2\nEND))"},{"name":"tournament_terminal_settlements_accounting_state_check","validated":true,"definition":"CHECK ((accounting_state = ANY (ARRAY['legacy'::text, 'recognized'::text, 'cancelled'::text, 'banked_accrual_deferred'::text])))"},{"name":"tournament_terminal_settlements_bounty_payout_total_check","validated":true,"definition":"CHECK (((bounty_payout_total >= (0)::numeric) AND (bounty_payout_total = round(bounty_payout_total, 2))))"},{"name":"tournament_terminal_settlements_bounty_pool_check","validated":true,"definition":"CHECK (((bounty_pool >= (0)::numeric) AND (bounty_pool = round(bounty_pool, 2))))"},{"name":"tournament_terminal_settlements_bounty_receipt_check","validated":true,"definition":"CHECK ((jsonb_typeof(bounty_receipt) = 'object'::text))"},{"name":"tournament_terminal_settlements_cash_payout_count_check","validated":true,"definition":"CHECK ((cash_payout_count >= 0))"},{"name":"tournament_terminal_settlements_cash_payout_total_check","validated":true,"definition":"CHECK (((cash_payout_total >= (0)::numeric) AND (cash_payout_total = round(cash_payout_total, 2))))"},{"name":"tournament_terminal_settlements_cash_receipt_check","validated":true,"definition":"CHECK ((jsonb_typeof(cash_receipt) = 'object'::text))"},{"name":"tournament_terminal_settlements_check","validated":true,"definition":"CHECK ((cash_payout_total = prize_pool))"},{"name":"tournament_terminal_settlements_check1","validated":true,"definition":"CHECK ((bounty_payout_total = bounty_pool))"},{"name":"tournament_terminal_settlements_check2","validated":true,"definition":"CHECK (((mystery_was_active AND (mystery_pool_cents > 0)) OR ((NOT mystery_was_active) AND (mystery_pool_cents = 0))))"},{"name":"tournament_terminal_settlements_check3","validated":true,"definition":"CHECK ((closed_table_count = cardinality(closed_table_ids)))"},{"name":"tournament_terminal_settlements_check4","validated":true,"definition":"CHECK ((source_seat_count = cardinality(source_seat_ids)))"},{"name":"tournament_terminal_settlements_check5","validated":true,"definition":"CHECK ((released_seat_count = cardinality(released_seat_ids)))"},{"name":"tournament_terminal_settlements_check6","validated":true,"definition":"CHECK ((released_seat_ids <@ source_seat_ids))"},{"name":"tournament_terminal_settlements_check7","validated":true,"definition":"CHECK (((rake_settled_at <= settled_at) AND (rake_attributed_at <= settled_at)))"},{"name":"tournament_terminal_settlements_check8","validated":true,"definition":"CHECK ((escrow_closed_at <= settled_at))"},{"name":"tournament_terminal_settlements_check9","validated":true,"definition":"CHECK ((completed_at <= settled_at))"},{"name":"tournament_terminal_settlements_closed_table_count_check","validated":true,"definition":"CHECK ((closed_table_count >= 0))"},{"name":"tournament_terminal_settlements_closed_table_ids_check","validated":true,"definition":"CHECK ((array_position(closed_table_ids, NULL::uuid) IS NULL))"},{"name":"tournament_terminal_settlements_escrow_close_note_check","validated":true,"definition":"CHECK ((length(btrim(escrow_close_note)) > 0))"},{"name":"tournament_terminal_settlements_mystery_pool_cents_check","validated":true,"definition":"CHECK ((mystery_pool_cents >= 0))"},{"name":"tournament_terminal_settlements_mystery_receipt_check","validated":true,"definition":"CHECK ((jsonb_typeof(mystery_receipt) = 'object'::text))"},{"name":"tournament_terminal_settlements_pkey","validated":true,"definition":"PRIMARY KEY (tournament_id)"},{"name":"tournament_terminal_settlements_prize_pool_check","validated":true,"definition":"CHECK (((prize_pool >= (0)::numeric) AND (prize_pool = round(prize_pool, 2))))"},{"name":"tournament_terminal_settlements_rake_amount_check","validated":true,"definition":"CHECK (((rake_amount >= (0)::numeric) AND (rake_amount = round(rake_amount, 2))))"},{"name":"tournament_terminal_settlements_rake_attributed_users_check","validated":true,"definition":"CHECK ((rake_attributed_users >= 0))"},{"name":"tournament_terminal_settlements_rake_destination_check","validated":true,"definition":"CHECK ((length(btrim(rake_destination)) > 0))"},{"name":"tournament_terminal_settlements_released_seat_count_check","validated":true,"definition":"CHECK ((released_seat_count >= 0))"},{"name":"tournament_terminal_settlements_released_seat_ids_check","validated":true,"definition":"CHECK ((array_position(released_seat_ids, NULL::uuid) IS NULL))"},{"name":"tournament_terminal_settlements_settlement_mode_check","validated":true,"definition":"CHECK ((settlement_mode = ANY (ARRAY['places'::text, 'final_table_deal'::text])))"},{"name":"tournament_terminal_settlements_source_seat_count_check","validated":true,"definition":"CHECK ((source_seat_count >= 0))"},{"name":"tournament_terminal_settlements_source_seat_ids_check","validated":true,"definition":"CHECK ((array_position(source_seat_ids, NULL::uuid) IS NULL))"},{"name":"tournament_terminal_settlements_started_status_check","validated":true,"definition":"CHECK ((started_status = ANY (ARRAY['RUNNING'::text, 'COMPLETING'::text])))"},{"name":"tournament_terminal_settlements_tournament_id_fkey","validated":true,"definition":"FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE RESTRICT"}]}]$captured$::jsonb) LOOP
    SELECT jsonb_build_object(
 'name',cl.relname,'owner',pg_get_userbyid(cl.relowner),'acl',cl.relacl::text,
 'rls',cl.relrowsecurity,'force_rls',cl.relforcerowsecurity,
 'columns',(SELECT jsonb_agg(jsonb_build_object('name',at.attname,'type',format_type(at.atttypid,at.atttypmod),
   'number',at.attnum,'default',pg_get_expr(ad.adbin,ad.adrelid),'identity',at.attidentity,
   'not_null',at.attnotnull,'generated',at.attgenerated) ORDER BY at.attnum)
   FROM pg_attribute at LEFT JOIN pg_attrdef ad ON ad.adrelid=at.attrelid AND ad.adnum=at.attnum
   WHERE at.attrelid=cl.oid AND at.attnum>0 AND NOT at.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_object('name',co.conname,'validated',co.convalidated,
   'definition',pg_get_constraintdef(co.oid,false)) ORDER BY co.conname) FROM pg_constraint co WHERE co.conrelid=cl.oid),
 'indexes',(SELECT jsonb_agg(pg_get_indexdef(ix.indexrelid) ORDER BY ci.relname)
   FROM pg_index ix JOIN pg_class ci ON ci.oid=ix.indexrelid WHERE ix.indrelid=cl.oid),
 'policies',(SELECT CASE WHEN count(*)=0 THEN NULL::jsonb ELSE jsonb_build_object('unexpected_policy_count',count(*)) END
   FROM pg_policy po WHERE po.polrelid=cl.oid),
 'triggers',(SELECT jsonb_agg(jsonb_build_object('name',tr.tgname,'enabled',tr.tgenabled,
   'function',tr.tgfoid::regprocedure::text,'definition',pg_get_triggerdef(tr.oid,false)) ORDER BY tr.tgname)
   FROM pg_trigger tr WHERE tr.tgrelid=cl.oid AND NOT tr.tgisinternal))
 FROM pg_class cl JOIN pg_namespace ns ON ns.oid=cl.relnamespace
 WHERE ns.nspname='public' AND cl.relname=expected->>'name' AND cl.relkind='r' INTO actual;
    IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'restore relation differs: %',expected->>'name' USING ERRCODE='55000'; END IF;
    EXECUTE format('SELECT count(*) FROM public.%I',expected->>'name') INTO n;
    IF n<>0 THEN RAISE EXCEPTION 'accounting catalog requires empty fixture relation: %',expected->>'name'; END IF;
  END LOOP;
  FOR expected IN SELECT value FROM jsonb_array_elements($captured$[{"signature":"fn_accounting_tournament_bank_proof(uuid,timestamp with time zone,uuid,uuid,numeric,uuid,uuid)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"e56aa8c8280c59e2f0406ea6c504dc4e","volatility":"s","security_definer":true,"kind":"f"},{"signature":"fn_accounting_tournament_fee_fingerprint(rake_records)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"dd55cceba87b1578472171e1c80ba1fb","volatility":"i","security_definer":false,"kind":"f"},{"signature":"fn_accounting_tournament_terminal_fee_receipt(uuid)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"6e446f6d6d19ec8b28b31d124a8c6ac3","volatility":"s","security_definer":true,"kind":"f"},{"signature":"fn_ca_lock_settlement_lane_for_finish(uuid)","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"76e4c6b5291bab20f0cfc65dd060022b","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_ca_lock_settlement_lane_global()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"7c759bb7a639c3124de2607bdbf12577","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_ca_settlement_lane_doctrine()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"],"full_md5":"8dd361600c8facb1cbb99b3df853e5b9","volatility":"s","security_definer":true,"kind":"f"},{"signature":"fn_ca_tournament_terminal_receipt(uuid,uuid)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public","statement_timeout=30s"],"full_md5":"787eb9a718a648ac29753dfc9234f4c3","volatility":"s","security_definer":true,"kind":"f"},{"signature":"fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public","statement_timeout=45s"],"full_md5":"6a45fe9bf30c94f9366ec88f0863087e","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_complete_tournament_terminal(uuid,uuid,text)","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp","statement_timeout=45s"],"full_md5":"c64e049911fd99c1d784cdb042ca714b","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_lock_accounting_tournament_recognition_week(uuid,timestamp with time zone)","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"d5339cec8b0e00be748c4c15bc3dba83","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_settle_tournament_places(uuid,uuid)","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public","statement_timeout=30s"],"full_md5":"c412c8b17186976df139f73a706175f2","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_settle_tournament_rake(uuid,text)","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp","statement_timeout=30s"],"full_md5":"0492f5a78bc3c84d54c24fd45549a0be","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_union_week_start(timestamp with time zone)","owner":"postgres","acl":"{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}","config":["search_path=public, extensions"],"full_md5":"103f192a228084dad0e4268c36c82c4b","volatility":"i","security_definer":false,"kind":"f"},{"signature":"fn_accounting_agreement_history_immutable()","owner":"postgres","acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public"],"full_md5":"3fa4099435ff1e9d5c48fa1934b63549","volatility":"v","security_definer":false,"kind":"f"},{"signature":"fn_accounting_tournament_fee_receipt_immutable()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"bdc4ee4b75e3471cd33a5ed4b250ec0f","volatility":"v","security_definer":true,"kind":"f"},{"signature":"fn_tournament_terminal_receipts_are_append_only()","owner":"postgres","acl":"{postgres=X/postgres}","config":["search_path=public"],"full_md5":"618843a6d0646709dac2a9c3b24a7652","volatility":"v","security_definer":false,"kind":"f"}]$captured$::jsonb) LOOP
    SELECT jsonb_build_object('signature',expected->>'signature','owner',pg_get_userbyid(pr.proowner),
 'acl',pr.proacl::text,'config',to_jsonb(pr.proconfig),'full_md5',md5(pg_get_functiondef(pr.oid)),
 'volatility',pr.provolatile,'security_definer',pr.prosecdef,'kind',pr.prokind)
 FROM pg_proc pr WHERE pr.oid=to_regprocedure('public.'||(expected->>'signature')) INTO actual;
    IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'restore function differs: %',expected->>'signature' USING ERRCODE='55000'; END IF;
  END LOOP;
  IF 'public.tournament_terminal_settlements'::regclass::oid::text IS DISTINCT FROM current_setting('qualification.accounting_terminal_oid') THEN RAISE EXCEPTION 'terminal table OID changed'; END IF;
END $verify$;
SELECT jsonb_build_object('stage','current_accounting_catalog_restore','execution_uuid',current_setting('qualification.execution_uuid'),'database',current_database(),'catalog_exact',true,'relations',6,'captured_functions',16,'empty',true,'terminal_table_oid','public.tournament_terminal_settlements'::regclass::oid,'authority_sha256','193d8f25921068b2e4402d4d4b3861195917542b67a95fc854d6844842a29bd2','catalog_sha256','329b95dfe4489c1099502e517005904d014d1e6fe2630f66433361aaec99b418','full_qualification',false,'financial_qualification',false,'dependency_closure_proved',false) AS accounting_catalog_receipt;
COMMIT;
