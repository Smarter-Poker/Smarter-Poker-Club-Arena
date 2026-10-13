-- A retained original hand corrects its exact refused source once.
-- Exact closed30 (original18 plus qualified12) witnesses retain their original request, failed handoff and result.
-- Installation creates authority only: no certificate, financial claim or payment.
-- Ordinary uncatalogued/spent hands retain the original refusal. The existing
-- resume owner retains lease/F06/seat/freeze/atomic/postcommit authority.
BEGIN;
SET LOCAL statement_timeout='20s';
SET LOCAL lock_timeout='2s';
DO $pre$
BEGIN
 IF current_user IS DISTINCT FROM 'postgres' OR session_user IS DISTINCT FROM 'postgres'
 OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL THEN RAISE EXCEPTION 'ORIGINAL30_INSTALLER_OPERATOR_ONLY' USING ERRCODE='42501';END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RAISE EXCEPTION 'ORIGINAL30_INSTALLER_FROZEN' USING ERRCODE='55000';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('original-hand-source-correction:20261013022132',0)) THEN RAISE EXCEPTION 'ORIGINAL30_INSTALLER_OWNED' USING ERRCODE='55P03';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261013022132')
 OR to_regclass('smarter_private.hand_submission_source_corrections') IS NOT NULL
 OR to_regclass('smarter_private.hand_submission_correction_claims') IS NOT NULL
 OR to_regclass('smarter_private.hand_submission_correction_results') IS NOT NULL THEN RAISE EXCEPTION 'ORIGINAL30_INSTALLER_ALREADY_PRESENT' USING ERRCODE='55000';END IF;
 IF (SELECT count(*)=1 AND bool_and((cardinality(statements)=1 AND octet_length(statements[1])=10477 AND md5(statements[1])='4550b7577a9602c436c65869db8535ef') IS TRUE) FROM supabase_migrations.schema_migrations WHERE version='20261013021756') IS DISTINCT FROM true THEN RAISE EXCEPTION 'ORIGINAL30_QUALIFIED_NONE_HISTORY_REQUIRED' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p WHERE p.oid='public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure AND md5(pg_get_functiondef(p.oid))='ae0691448b3aed5902574d4ffdb2d05c' AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=pg_catalog, public"]'::jsonb) THEN RAISE EXCEPTION 'ORIGINAL30_RESUME_PREIMAGE_REQUIRED' USING ERRCODE='55000';END IF;
 IF ('fn_ca_resume_hand_submission'=ANY(public.fn_ca_guard_watchlist())) IS DISTINCT FROM false OR EXISTS(SELECT FROM public.ca_guard_defs WHERE proname='fn_ca_resume_hand_submission') THEN RAISE EXCEPTION 'ORIGINAL30_NEW_WATCH_DECLARATION_REQUIRED' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT FROM public.ca_money_rpc_registry WHERE proname='fn_ca_resume_hand_submission' AND status='approved') OR md5(pg_get_functiondef('public.fn_ca_money_rpc_registry_guard()'::regprocedure)) IS DISTINCT FROM '03928ac3da782be33306c2e07b0b8977' THEN RAISE EXCEPTION 'ORIGINAL30_EXISTING_MONEY_DECLARATION_REQUIRED' USING ERRCODE='55000';END IF;
 IF (
SELECT count(*)=26 AND bool_and((p.oid IS NOT NULL AND md5(pg_get_functiondef(p.oid))=x.full_md5 AND pg_get_userbyid(p.proowner)=x.owner AND p.prosecdef=x.prosecdef AND p.proacl::text=x.acl AND to_jsonb(p.proconfig) IS NOT DISTINCT FROM x.config) IS TRUE)
FROM jsonb_to_recordset($sourcepins$[{"signature":"fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)","full_md5":"b49192e78f472d7a931bcf20de46a702","body_md5":"f5fe4f574d43082134178d377dcc6a9b","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"]},{"signature":"fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)","full_md5":"c555fb7b83c889312995bc0038c1b275","body_md5":"21eee4aac1840bd768592caff4b2c492","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"]},{"signature":"fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)","full_md5":"3e9be2b005fafa4e0caabe5fcaa0ce70","body_md5":"7fc2e93d61e86b203b39876639bb9584","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, extensions, pg_temp"]},{"signature":"fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)","full_md5":"9877846ffabee004690e6b24a3ddcee2","body_md5":"3acb4c1d763181905cf5b64287f8f28f","owner":"postgres","prosecdef":false,"acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"]},{"signature":"fn_ca_process_hand_post_commit_obligations(uuid)","full_md5":"8d18dde12765610895b25e297a1f403f","body_md5":"9672653f9e15a45072de3b60ce5b0b2f","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, extensions, pg_temp"]},{"signature":"fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)","full_md5":"7c81a81de14275cf79ec2bc947f42884","body_md5":"b546f2132413ca1db68bcfd5b3f473d1","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres}","config":["search_path=public"]},{"signature":"fn_ca_settle_hand_stacks(uuid,uuid,bigint,jsonb,numeric,numeric)","full_md5":"a4a55e36088a04bce9c054e3cf6c9fc3","body_md5":"d528126ac9f053d6dc771c8328669c0f","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres}","config":["search_path=public"]},{"signature":"fn_ca_share_settlement_lane_for_table(uuid)","full_md5":"409b14ee72ce888d3b26524c52d49a68","body_md5":"7a4d464261d6cc5cb185ad6c8b846440","owner":"postgres","prosecdef":false,"acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"]},{"signature":"fn_engine_lease_stale_seconds()","full_md5":"483a7e0ee940744fd557f1f2144d9eba","body_md5":"32335e76e9c5680e0c9cfbcf9631375b","owner":"postgres","prosecdef":false,"acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"]},{"signature":"fn_f06_finish_hand(uuid,uuid,uuid,text,uuid)","full_md5":"f85ee8fbf794e9087926715fd340499d","body_md5":"6e92e7d8d9d65371909d19856171ddf0","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=pg_catalog, public, smarter_private"]},{"signature":"fn_platform_frozen()","full_md5":"ec683805e052fceeae74789e82dce4cc","body_md5":"112b1265824ee082b8adc67ea367d826","owner":"postgres","prosecdef":false,"acl":"{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"]},{"signature":"fn_poker_diamond_seat_keeps_custody()","full_md5":"d80aed613a97e567268cb2bf6fdfd094","body_md5":"19670c0a28ab630eef381da973fdf45b","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"]},{"signature":"smarter_private.accepted_hand_roster_first(uuid,bigint,uuid,jsonb,boolean,jsonb,text)","full_md5":"39c6f265b7dcd44b403de9b426ad5bb7","body_md5":"92f6fb3149144ded050e3b6996d32bd9","owner":"postgres","prosecdef":false,"acl":"{postgres=X/postgres}","config":["search_path=pg_catalog, public, pg_temp"]},{"signature":"smarter_private.accepted_hand_roster_replay(uuid,bigint,uuid,text)","full_md5":"2c0b32173cd0d78e9384c55b9c073c43","body_md5":"7c10c0c753ff08570e077c3afc67ebd9","owner":"postgres","prosecdef":false,"acl":"{postgres=X/postgres}","config":["search_path=pg_catalog, public, pg_temp"]},{"signature":"smarter_private.acknowledge_hand_submission(uuid,jsonb)","full_md5":"93673c13eb8a1c46751406e1f06106da","body_md5":"c644c35289f8e18da4a9de4f1a641933","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres}","config":["search_path=pg_catalog, public"]},{"signature":"smarter_private.adopt_retired_cash_original_hand(uuid,text,uuid)","full_md5":"cb60a3624bb45d03dbd77c4d8cdc3305","body_md5":"576c5a49e39c9d92a52a58c8a65f3a01","owner":"postgres","prosecdef":false,"acl":"{postgres=X/postgres}","config":["search_path=pg_catalog, public"]},{"signature":"smarter_private.assert_retained_hand_submission(jsonb)","full_md5":"6a3ab631fdab87ae9bcd353907de80b6","body_md5":"1bd5f0f6fc7070e073478bdab317e249","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres}","config":["search_path=pg_catalog"]},{"signature":"smarter_private.f06_authority(uuid,uuid,boolean)","full_md5":"848b06c8e958ad739e0a60b388430f38","body_md5":"939908ee892773e79e04fc73241c3f75","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres}","config":["search_path=pg_catalog, public, smarter_private"]},{"signature":"smarter_private.f06_hand_dispatch_guard(uuid,bigint)","full_md5":"efdb53d70cf631bd3179354e5caf1ec1","body_md5":"0adb860f94a9776de4aa24ffa461af88","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres}","config":["search_path=pg_catalog, public, smarter_private"]},{"signature":"smarter_private.f06_prefix(uuid,uuid,uuid[],uuid[])","full_md5":"dae9d5b5f71a68362f202dfdf89c8fae","body_md5":"d857e9d6270456d122ef385c751bc5f1","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres}","config":["search_path=pg_catalog, public, smarter_private"]},{"signature":"smarter_private.hand_submission_dispose_dealt_past(uuid,bigint)","full_md5":"6a80a96fcf4f13f8cd734f35169f16d7","body_md5":"8c9a78ddf5d498849966a8eb0efb647c","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres}","config":["search_path=pg_catalog"]},{"signature":"smarter_private.hand_submission_dispose_refused_vacated(uuid,uuid)","full_md5":"36c239ff43d4c4da204128b5ecb73284","body_md5":"9d380136fdbd8b0dc245ec2f679b039d","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres}","config":["search_path=pg_catalog"]},{"signature":"smarter_private.horse_settlement_original_result(uuid,uuid,jsonb)","full_md5":"9b34ace9a694e65a7bd0b3917c4a70fd","body_md5":"71551f0a298a104b131e9a92b2f15eca","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres}","config":["search_path=pg_catalog, public, pg_temp"]},{"signature":"smarter_private.restore_retired_original_tournament_hand(uuid,text,uuid)","full_md5":"a529e0bd2972a5b87eff0afa5fce7988","body_md5":"ee610ec07a119a322879c3c1999d9d46","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres}","config":["search_path=pg_catalog, public, smarter_private"]},{"signature":"smarter_private.retired_cash_original_stack(uuid,bigint,uuid,uuid,timestamp with time zone,numeric,numeric)","full_md5":"3fd8bc1b7a2a3e7fbf63ee64fb79dbc3","body_md5":"8a00151604c4d6ee956eceed4730a4ed","owner":"postgres","prosecdef":false,"acl":"{postgres=X/postgres}","config":["search_path=pg_catalog, public"]},{"signature":"smarter_private.retired_cash_original_time_bank(uuid,bigint,jsonb)","full_md5":"6dc8ad43d7e89ab492985adabaccc51d","body_md5":"c20856306cb4061702d63f4273aab865","owner":"postgres","prosecdef":false,"acl":"{postgres=X/postgres}","config":["search_path=pg_catalog, public"]}]$sourcepins$::jsonb) x(signature text,full_md5 text,owner text,prosecdef boolean,acl text,config jsonb)
LEFT JOIN pg_proc p ON p.oid=to_regprocedure(x.signature)
 ) IS DISTINCT FROM true THEN RAISE EXCEPTION 'ORIGINAL30_FINANCIAL_SOURCE_CHAIN_DRIFT' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p WHERE p.oid='public.fn_poker_diamond_jackpot_accept_hand()'::regprocedure AND md5(pg_get_functiondef(p.oid))='0db3d6146f5e1118c570ded9bfb5261f' AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef AND p.proacl::text='{postgres=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=public, pg_temp"]'::jsonb)
 OR (SELECT count(*)=1 AND bool_and(t.tgenabled='O' AND md5(pg_get_triggerdef(t.oid))='d520254027350e60b03aad1f1a73747a') FROM pg_trigger t WHERE t.tgfoid='public.fn_poker_diamond_jackpot_accept_hand()'::regprocedure AND NOT t.tgisinternal) IS DISTINCT FROM true THEN RAISE EXCEPTION 'ORIGINAL30_FIXED_NONE_SOURCE_WIRING_REQUIRED' USING ERRCODE='55000';END IF;
END $pre$;
CREATE FUNCTION smarter_private.original_hand_correction_sources_match() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,smarter_private AS $body$
SELECT count(*)=26 AND bool_and((p.oid IS NOT NULL AND md5(pg_get_functiondef(p.oid))=x.full_md5 AND pg_get_userbyid(p.proowner)=x.owner AND p.prosecdef=x.prosecdef AND p.proacl::text=x.acl AND to_jsonb(p.proconfig) IS NOT DISTINCT FROM x.config) IS TRUE)
FROM jsonb_to_recordset($sourcepins$[{"signature":"fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)","full_md5":"b49192e78f472d7a931bcf20de46a702","body_md5":"f5fe4f574d43082134178d377dcc6a9b","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"]},{"signature":"fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)","full_md5":"c555fb7b83c889312995bc0038c1b275","body_md5":"21eee4aac1840bd768592caff4b2c492","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"]},{"signature":"fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)","full_md5":"3e9be2b005fafa4e0caabe5fcaa0ce70","body_md5":"7fc2e93d61e86b203b39876639bb9584","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, extensions, pg_temp"]},{"signature":"fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)","full_md5":"9877846ffabee004690e6b24a3ddcee2","body_md5":"3acb4c1d763181905cf5b64287f8f28f","owner":"postgres","prosecdef":false,"acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"]},{"signature":"fn_ca_process_hand_post_commit_obligations(uuid)","full_md5":"8d18dde12765610895b25e297a1f403f","body_md5":"9672653f9e15a45072de3b60ce5b0b2f","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, extensions, pg_temp"]},{"signature":"fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)","full_md5":"7c81a81de14275cf79ec2bc947f42884","body_md5":"b546f2132413ca1db68bcfd5b3f473d1","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres}","config":["search_path=public"]},{"signature":"fn_ca_settle_hand_stacks(uuid,uuid,bigint,jsonb,numeric,numeric)","full_md5":"a4a55e36088a04bce9c054e3cf6c9fc3","body_md5":"d528126ac9f053d6dc771c8328669c0f","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres}","config":["search_path=public"]},{"signature":"fn_ca_share_settlement_lane_for_table(uuid)","full_md5":"409b14ee72ce888d3b26524c52d49a68","body_md5":"7a4d464261d6cc5cb185ad6c8b846440","owner":"postgres","prosecdef":false,"acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"]},{"signature":"fn_engine_lease_stale_seconds()","full_md5":"483a7e0ee940744fd557f1f2144d9eba","body_md5":"32335e76e9c5680e0c9cfbcf9631375b","owner":"postgres","prosecdef":false,"acl":"{postgres=X/postgres}","config":["search_path=public, pg_temp"]},{"signature":"fn_f06_finish_hand(uuid,uuid,uuid,text,uuid)","full_md5":"f85ee8fbf794e9087926715fd340499d","body_md5":"6e92e7d8d9d65371909d19856171ddf0","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=pg_catalog, public, smarter_private"]},{"signature":"fn_platform_frozen()","full_md5":"ec683805e052fceeae74789e82dce4cc","body_md5":"112b1265824ee082b8adc67ea367d826","owner":"postgres","prosecdef":false,"acl":"{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"]},{"signature":"fn_poker_diamond_seat_keeps_custody()","full_md5":"d80aed613a97e567268cb2bf6fdfd094","body_md5":"19670c0a28ab630eef381da973fdf45b","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres,service_role=X/postgres}","config":["search_path=public, pg_temp"]},{"signature":"smarter_private.accepted_hand_roster_first(uuid,bigint,uuid,jsonb,boolean,jsonb,text)","full_md5":"39c6f265b7dcd44b403de9b426ad5bb7","body_md5":"92f6fb3149144ded050e3b6996d32bd9","owner":"postgres","prosecdef":false,"acl":"{postgres=X/postgres}","config":["search_path=pg_catalog, public, pg_temp"]},{"signature":"smarter_private.accepted_hand_roster_replay(uuid,bigint,uuid,text)","full_md5":"2c0b32173cd0d78e9384c55b9c073c43","body_md5":"7c10c0c753ff08570e077c3afc67ebd9","owner":"postgres","prosecdef":false,"acl":"{postgres=X/postgres}","config":["search_path=pg_catalog, public, pg_temp"]},{"signature":"smarter_private.acknowledge_hand_submission(uuid,jsonb)","full_md5":"93673c13eb8a1c46751406e1f06106da","body_md5":"c644c35289f8e18da4a9de4f1a641933","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres}","config":["search_path=pg_catalog, public"]},{"signature":"smarter_private.adopt_retired_cash_original_hand(uuid,text,uuid)","full_md5":"cb60a3624bb45d03dbd77c4d8cdc3305","body_md5":"576c5a49e39c9d92a52a58c8a65f3a01","owner":"postgres","prosecdef":false,"acl":"{postgres=X/postgres}","config":["search_path=pg_catalog, public"]},{"signature":"smarter_private.assert_retained_hand_submission(jsonb)","full_md5":"6a3ab631fdab87ae9bcd353907de80b6","body_md5":"1bd5f0f6fc7070e073478bdab317e249","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres}","config":["search_path=pg_catalog"]},{"signature":"smarter_private.f06_authority(uuid,uuid,boolean)","full_md5":"848b06c8e958ad739e0a60b388430f38","body_md5":"939908ee892773e79e04fc73241c3f75","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres}","config":["search_path=pg_catalog, public, smarter_private"]},{"signature":"smarter_private.f06_hand_dispatch_guard(uuid,bigint)","full_md5":"efdb53d70cf631bd3179354e5caf1ec1","body_md5":"0adb860f94a9776de4aa24ffa461af88","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres}","config":["search_path=pg_catalog, public, smarter_private"]},{"signature":"smarter_private.f06_prefix(uuid,uuid,uuid[],uuid[])","full_md5":"dae9d5b5f71a68362f202dfdf89c8fae","body_md5":"d857e9d6270456d122ef385c751bc5f1","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres}","config":["search_path=pg_catalog, public, smarter_private"]},{"signature":"smarter_private.hand_submission_dispose_dealt_past(uuid,bigint)","full_md5":"6a80a96fcf4f13f8cd734f35169f16d7","body_md5":"8c9a78ddf5d498849966a8eb0efb647c","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres}","config":["search_path=pg_catalog"]},{"signature":"smarter_private.hand_submission_dispose_refused_vacated(uuid,uuid)","full_md5":"36c239ff43d4c4da204128b5ecb73284","body_md5":"9d380136fdbd8b0dc245ec2f679b039d","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres}","config":["search_path=pg_catalog"]},{"signature":"smarter_private.horse_settlement_original_result(uuid,uuid,jsonb)","full_md5":"9b34ace9a694e65a7bd0b3917c4a70fd","body_md5":"71551f0a298a104b131e9a92b2f15eca","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres}","config":["search_path=pg_catalog, public, pg_temp"]},{"signature":"smarter_private.restore_retired_original_tournament_hand(uuid,text,uuid)","full_md5":"a529e0bd2972a5b87eff0afa5fce7988","body_md5":"ee610ec07a119a322879c3c1999d9d46","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres}","config":["search_path=pg_catalog, public, smarter_private"]},{"signature":"smarter_private.retired_cash_original_stack(uuid,bigint,uuid,uuid,timestamp with time zone,numeric,numeric)","full_md5":"3fd8bc1b7a2a3e7fbf63ee64fb79dbc3","body_md5":"8a00151604c4d6ee956eceed4730a4ed","owner":"postgres","prosecdef":false,"acl":"{postgres=X/postgres}","config":["search_path=pg_catalog, public"]},{"signature":"smarter_private.retired_cash_original_time_bank(uuid,bigint,jsonb)","full_md5":"6dc8ad43d7e89ab492985adabaccc51d","body_md5":"c20856306cb4061702d63f4273aab865","owner":"postgres","prosecdef":false,"acl":"{postgres=X/postgres}","config":["search_path=pg_catalog, public"]}]$sourcepins$::jsonb) x(signature text,full_md5 text,owner text,prosecdef boolean,acl text,config jsonb)
LEFT JOIN pg_proc p ON p.oid=to_regprocedure(x.signature);
$body$;
ALTER FUNCTION smarter_private.original_hand_correction_sources_match() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.original_hand_correction_sources_match() FROM PUBLIC,anon,authenticated,service_role;

-- Draft source component; not installation/admission authority until full connected qualification.
CREATE TABLE smarter_private.hand_submission_source_corrections (
 submission_id uuid PRIMARY KEY,
 proof jsonb NOT NULL, admitted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE smarter_private.hand_submission_correction_claims (
 submission_id uuid PRIMARY KEY REFERENCES smarter_private.hand_submission_source_corrections(submission_id),
 request_hash text NOT NULL, instance_id text NOT NULL, lease_generation uuid NOT NULL,
 transaction_id bigint NOT NULL, claimed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE smarter_private.hand_submission_correction_results (
 submission_id uuid PRIMARY KEY REFERENCES smarter_private.hand_submission_correction_claims(submission_id),
 result jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION smarter_private.original_hand_source_correction_proof(e uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,smarter_private AS $body$
DECLARE x record;s smarter_private.hand_submissions;h smarter_private.hand_submission_handoffs;z smarter_private.hand_submission_handoff_results;p smarter_private.f06_hand_permits;stack_hand uuid;
BEGIN
 SELECT * INTO x FROM (VALUES
('0945dbd3-c650-4479-a536-1742217a2ec0'::uuid,'929b7e3f-d15a-42c7-b06e-62dd6d350618'::uuid,33736626,'1653c1f91fcd60a766e5e2563ced1acdb3e8c9f2df49a11d182e2f218c77a6c5','2482b488ca31a25623fd025f223d4479','9f35f1234b42931f7d3ce53a06cef9c8','3f252a761fa8b46e0c6057115ca3f2e1','a500fee7-57e8-4f39-9877-6ed81f1e8635'::uuid,'44836c931664090cd19183d4345547d4','e15326be807a8823a9f67a5650681ea8'),
('105a9907-49cf-4096-b0fc-2be7a721228c'::uuid,'8dc9df6a-73fd-484a-a9bb-a25b22e7d274'::uuid,33737494,'3c23fbbaf9797aabca9bd4a0305feae19baa937133f8ed4047bdb200361f9952','d110af43d796f22e633ee12bf18c44e1','f653cd0c9d00b77f0dbcbe2402ce91ff','7b30550a3a058ae538d03f62a26c2111','012f0006-11ca-4d7a-9cbe-e648d28393dc'::uuid,'a9ef02455b9539f6ad544b4fab1eb9ca','4c69f2cba5c8f0f33fff3f481db0f535'),
('1fa41967-8611-40dc-b724-edc4f2929a6c'::uuid,'e46b9128-bd44-4b90-b321-786716838dbf'::uuid,33737489,'20a8c68e1f2b8c8bce046cbbf7cfa1207432448662a8f82459dfe3cc72187288','2566e27a52f3e0680d5a27be8000f725','85ac37f87b518d5478daed24bb636d6f','37ab735d02a3d3c1ca47922bb3cc3a5a','b7f8e7cf-dc94-4208-b73e-b0ecb2332792'::uuid,'9645d571c8408a73f6aeef856536f1f9','d26d32f980b010a521bbc9870606b21c'),
('20626e7d-1470-429f-8761-cc089677a0d1'::uuid,'eff44da5-c2b9-44c7-bbd6-ec24d0480150'::uuid,33737556,'a7ff40411c7cc5df8c1dafcd3b184fb49f94afe3526ff23bca609ebde48cdb54','454f3b6d5140535279c148890e3adef8','2625149064a9050ffc61bfe808920cf4','04e8dab8de34ee57632be73fb46d5c00','c45477cc-0755-484e-862f-049de73a6c72'::uuid,'efbaadff149eb549d7986cd058511e32','330a2ae2e3f2348d2d617456b74fe8ae'),
('2ad46d92-7144-484b-8bf3-ede0cd19cc4e'::uuid,'b060b966-56e0-4f82-8ea7-83a9d3cfb3a1'::uuid,33736699,'8a4f78ba04fb6717206d039e89949dd1aa0bedfdaac8cf6bc6b4697de5bcb0d0','86300882364760083e36255a4431d226','42a13ee83def3da03ded5c2af7948c06','9394abcc55a7b15b43751d74746a0370','e8872636-d19b-4c97-ab70-b1e174513101'::uuid,'6ca4c0456de406f2fcda45611f3ded3c','c3b77bb61a1ec17479fc7cde6d2b9891'),
('33b3a4d3-d0df-4308-a602-2f007de7d744'::uuid,'42cfcc4c-b983-458d-ba36-4ca697a215d3'::uuid,33737530,'8b4dfe8e8beedbc6a515ba79209ca8c9f3850d358ef28cbdf80577721716e5b7','deac3b03f4320e513795f368ca0eb74d','608883039549df38a9cf1de66060fbca','13dfcff9ed628b2559fa9b17070952a8','8e82c6f0-8477-4f9b-a29e-8f626f2a1078'::uuid,'d0dbc3e4736bb4f8f5d3e454adaca97a','a270304c632403316417b35ef0e9a7d9'),
('515aa2db-425b-4328-9100-3cd823e97d81'::uuid,'771cda5f-9563-4b5e-baa2-30395770983e'::uuid,33737617,'6b41fd0e8b68a24b35e5ce7fb32a6acd8588a45b96b375ca8ccd4bcefb1bc6e0','e11ccb423fd1b11bd38aaa671162d040','e144ba7059f571585fa923c369128580','a8af618963730369ab3f72089ace2f1c','91539fa5-0047-45a2-a5e7-18b1ea4f8d3f'::uuid,'f59e887377bdda24d8f5db8c342fc783','58f7932974eda512a2af5b6448c01758'),
('5ca21a93-d89f-46f5-a132-e0d2a60f0fe2'::uuid,'445eca12-54a0-4cd6-801b-efe2f46542fb'::uuid,33737448,'cdb810473e4ebcd7fa50652d53eff8dd6d9416908e6ce47a311e62b348adc486','2523a5c67cc23f5389a4f2b77627d5d3','a4b71708c151beb08e3b235565ff24fa','f2e269c09587c19a0ad47ce9da841739','a5a3de62-febe-49cb-9914-75c6ff1599ea'::uuid,'b903479da3850a357074e1228645dc96','a25b6b9bb97e84e9a661c65df2fec054'),
('9596aed7-5261-4d12-b524-2499d1f35095'::uuid,'f13dd75a-c78d-4dca-bc56-4dc8724b6b39'::uuid,33737127,'74fec8603e1e1a1afd55ae607a4f8947c604a0217519a059287ee07d9c381c7d','2d27af4e123618020e4e19c9aa0e7e06','ed0302a8699a4f75ad2bd34a0be388c4','0a53e14f946d7fa341ff82c0c0f928a7','ae94f23e-eaae-4eec-80e5-ab8ab9545848'::uuid,'9966dac286379ff4639a41362237af2c','379e05f32e2452f41594ef98091990ec'),
('9aae1c79-e84b-44e9-a2c5-b03f452e3244'::uuid,'c32fcf03-abdc-4310-a681-e6d52432ee9c'::uuid,33736130,'58ff506d6759eefa94a4aa7ce332ecc82f97d10f3da952d0c95e686096a1ab92','519f242b8f2a18d8ca9c89f29e29c2e1','b0f547ff4a16595b568c42334bcacd48','e195f273716a13b7e7f37efb7c228726','768ce66b-f579-4920-9cbe-4597484f9b8f'::uuid,'40c64d0359ebefdce5ba1c4110338829','2434fa0cca8ae0f84df449da42e0a817'),
('a0b8e9b9-5a31-4281-b281-6aa4234e2aa4'::uuid,'5b34352d-bcc6-46d3-ac31-5a8d03c97346'::uuid,33737287,'f5615ea975425749276d0140f234e19d4160fb7d31a8a9b6889805885bf68d01','103ae657b3a7d23fc071625a57860563','2ef72c7234d581f68582d779257db546','9c3378f9907cf3c2b548d8d6d733b5a1','3be14515-60f8-4863-bcd6-1b680325bc5f'::uuid,'bf5d8a3b29637c67b855b4ce5e9141d4','12e8099ff4f0dc2bdb0b51b000911f51'),
('ce78a269-cd96-45f0-8a38-16cbd43cce07'::uuid,'0a35c345-bf7f-427e-b758-8ee38b708751'::uuid,33737097,'8b70e8070f8f0569a4017367ace2462d346043f56bf0bef7b9ebf4a5099c03cb','43c249a33f0edb782dbb9c5b58c96220','11f1a0ffeb79d19cd7d82d36732fa808','7919c1c353267fab9b829779c1c9efb4','fb7fdebb-aa4c-4159-b769-3c87986dad4b'::uuid,'70abcf1f4245a6ccf8b052dcc4e2d5aa','85281bb20303b8745c62549f84157c27'),
('e18f4150-3884-46eb-a1fb-189847df1a03'::uuid,'41e3b325-1a89-4f27-b143-8cf96bd7f417'::uuid,33737499,'017f14c9340ac9c4cc5165d7e8d0059bf0f99a6c88dba363dd33c5ce541c4778','acbed8c7a32d350206ef5ad6ed81bfc3','330c02b29bbfc12259bb4031b84ad8ad','6918ea25a0df5dc3571bef368f8dac59','8a609ccf-36bd-4376-ac96-aea1f04865f7'::uuid,'ece0d864671ef8fbda285c3c1d293c0c','b0aa1e6d160c044e4b85c7bae7dc6d0b'),
('e36cd364-32af-4467-880b-e9f5bd2d8b19'::uuid,'e3ad386b-5028-4934-b027-bbdb23342390'::uuid,33737590,'78550937fa136497a4725c1830b7d1654cbcaf144c32dafca1e8acba36bc9d5a','cae5c3eeb8ba5439ca4024037f13e888','9d2caa9aeebb0d87115c0cbe72bd6b8c','7fbd1f08da2861a149b4e646caa5087a','2084ff13-8fcb-4c75-a12e-6677eedefcbc'::uuid,'7d2394f43f520a9cd07f99826fa4192f','34ea6b950e82a65c20695734acd18476'),
('edb94d4b-4c0a-4a1e-95b7-5e76759180ee'::uuid,'12109654-1b5c-4a82-b470-400e2c2c6b52'::uuid,33737230,'78fd18616cbf0a2d5834d842e639ffe1fcbdbdd5969d0e28239e99057a6c99cf','4f2dc1262bf5ef4ce7b40ce606cab4c6','202c3cd1f0eb06768af0eecceb2801ac','157b5ae7b7e707f661a57a36f9548be0','a16ac846-3a98-482d-905a-43da6fbc1424'::uuid,'71882d781c4019255f2d230e9092fb83','5688344a158551943d396ba3a6813eb2'),
('f9eed0b6-785b-41da-bcd3-c7d00c8535f4'::uuid,'acd0939a-3a58-4ae9-bdd2-6327e4b2b513'::uuid,33737141,'883863eac5abdabcff0d0ba59e1d050b0c841db681435383d4ee7af8ce33aeec','b8f7955758c9b035ff5c85b2df98aa8b','5054934534d52883370f3664a0436553','44868eb6e82efe5af84b4c466b57bf18','a065fb44-9f69-4bed-8817-c56fe5a71a5a'::uuid,'47618fbdf8dc9be536142d22eed04dac','205170c643841c62236f08460a3ab874'),
('fc5f79e0-0a9b-4662-8aa8-85665a3bae07'::uuid,'bfe9674c-32c5-40b3-b397-5bb1e9a8e8d5'::uuid,33737229,'5df9bed0606dcef58f4c2bd9b47c1b63ac104869d94b070f854dd516c0bfd0de','505e0daf6999567a79a1631ecadc856b','a32cd00e4606b0334aa68d99e3f71f93','5f61fc5a7959667485713b2def0d2a45','141a3292-796f-419e-8030-9c92ad939ac4'::uuid,'ad1af6171e12e60107d102d85f213d20','dd733f5b1bbaa2f3d67d86fa1c9b5efe'),
('fd0abfa3-b0cd-4196-a1a5-4522ba8733ee'::uuid,'fdc83055-e5b3-45cb-bdc9-5eadaf6753eb'::uuid,33737457,'bb69d5ef907a182726437a024daff19dfc1a0890cc5742629e91fb46f26cba46','5ead86134c51de0da3a68ca6079c4c86','9b04e4b62afa76866921e829d827d6c5','596729632b85dbabc3336c674aeb0962','b6228f08-77ff-4d1b-af43-db2757df5f74'::uuid,'597a0890a05dc09896e87540728c7bfe','30c14771a7fd59a4d882dacd6df6f3b9'),
('583f3b5f-b68a-48b0-a0ee-e9cbae519366','108ab441-0311-4f38-8e65-c99bd97fe26b',33776323,'c6a93e33934d0346ba765c0079a34d183ff6080901df9790c1f429dbd690f00d','b46ebaaeaa5ad5a7a7f7d067483716ab','c7a4f903bd30dcf309b4f14447f9e244','b38980cc0e4efc410a9665f5c10cbf9c','207506c5-72b8-4184-88b9-8190a9b69d42','5ae3a2a2010cb0c7b9a3568e7cfc1234','eef42cab5357c593b993abea57b47af4'),
('08017ed0-8e0a-4685-99ac-62b432a444c4','d07308cd-a727-44b2-874a-76f5fa90c310',33776325,'2891045d55a8209584fca870b4bd95592cb3e38c1fcd0c7c94cb06c75743ebfc','0dbf4849f3631945e26e6e1a68a48c86','67385050b6905b0e299ad87be2f52e18','ed4695fa05ff6980501fb23512c0ed91','7e358032-1deb-476d-b743-c234cda66e5b','50ddd8469ef3a545bbd03bd78a748fd7','d0051b867964508a4790aa6fb2a1cd49'),
('860a67e6-fe1e-48b0-87d9-cfca56ec496c','da447c25-40ca-42a0-a709-cae35c3f33df',33776151,'8acfa4034c2491b78a58ef98049d9ced953d4e01bb8d27b4652293c106fcc85f','5a2323564d313d0fa9288fa4e41d7d73','03b77958a4bbc72dbcb4317d090e224e','b24934770e2a6248b90e773fed464420','73d0ba3b-3c06-4aad-a50b-709fd255b116','4701c87128524e02cecf4a53ab52808d','173c0f87d0f18184f6a380b09943f6fc'),
('c91c795f-6991-490b-a892-8487bd52b9c7','efc13493-caa9-49ca-8681-3b2542e3ddbd',33776330,'34ce8f783519d4c23e18e97d129182f4a7f4a4073e522f9c187b6550da2b21c1','618c69177c76720d73bb470f446feecb','28df096ca56c7222143ff1bcf93b7310','40dae9a96077d0c3096996149425f84a','79a5fca8-433b-46cb-be14-34b9f2080df7','14e24f494966558c8492e997f6dfc93c','00e727db293ec252c223a8b03b358e7e'),
('1e335ceb-2be5-4749-885f-c4457be3e300','e95b9def-6834-4159-9a64-dbf4c7fe689b',33776329,'76f3de8a2962c2633983fa1842262c1acc971523d2fbc794b882087fe4f6628a','45d00efbc9247939a5d21ed11b704d26','5e2ffb6188ad278a27d82e6594dc974e','4faaac8a05487ca5d5417934298e1683','ade049ea-3e4c-4f1b-a6b7-8f96cebf9984','d64837f60d893727c7c177f3f1887c65','95ecdebede0a8518be1dd4318dffd6d0'),
('69f549e8-adb0-43f3-aaea-0c8b93d033ea','015a1960-6974-48ad-aa43-4cd7649e0c87',33776147,'150fc8530ea6beae423a87bd2433a49d8e94016f4c28102982495558bcd6509d','9c3c172613442cb82a7a6ec32cb67956','976de1390e4da3b00d59b9785dabb73f','8cb533200826182d4665a4598d463701','56456d80-71bc-4af0-8168-ce5f1e741cbf','9d1ce770bef45e08b854a8960ffe05c6','49e59c658b1505d9cfa48ca361bd8a99'),
('5a552ee7-ea42-48a3-b2d2-eb6a1de982e5','3d5940d8-a2bb-4c8e-8e1f-4d4a9d8802e9',33776150,'603c622fd29ecb6b11f25f0395432b28e9971484543c540d6bdd0b3e38a17606','64385631dfc40851910823fd490a351f','11ba04dbee07adba31cf88ecf057cd72','b29daa6c9d0b7fe7b175afd9680c1541','0a9a3882-ea65-4e8c-a7a4-e03e227267e9','71bb7d6be373f47307649bca7f036e75','8778f39c1327a0b4ab73ba7cf0ff2c50'),
('e55544ff-34b5-43eb-8928-de442f2f69ca','10a5d280-73a2-424a-9e40-c242e1ddc0e7',33776339,'2f10fa94d4265cf796308934e532653999666ba9f41f78ca3a5e61155a09e7bc','09b75724ce33ccaf5f504177d63a4024','6a0cac459eabd0bdd6b569b92389751c','7523f0edf1d245d6314782f9a06f2fe9','ca18f439-9847-4c49-84d0-a98267afa591','a17d1bad8ed83b79205337fc55754560','8f094078e36f8cf72bff254e1ea3110e'),
('36e067bf-e7bb-4905-9d4b-afa7f330ca83','f7c12144-b30c-4928-89e7-0e316f501110',33776328,'7cf9e4111d40363e1ab303f8806952d75fb999ae2bc56d6f4d9ebe17ff3567f1','8bc22aaf218381231aea058f9e141e76','dbc24a78b2218ff82b098459bd42ce92','9aae6d49f5e801964aadc3f2cb9ee3c7','178f89e2-f6ec-4769-8c8c-281fcc21c12d','6dfa8431ea5419517f3613857bf0a39c','a27e1714fe6c1b44f63102ca87ed3c4d'),
('b739b7a7-75e3-4f96-a363-e6434bb7365b','513b7b63-357d-43e0-9591-fe090d6bc5c5',33776324,'386dd488311c622a4c396dd43a4e57cfce78bad418f11d35ef3da3cd6c96b0bc','79d8f27f6ba4d89108ee85606857b72b','88d6619cb0224b1a70382f999a047935','1fa6a4a2ff56588f0f8ee6c518e8fea5','15eeef98-5462-4e10-9a98-07813952057c','488d01d0e6eeada5103d78d3087ef5a6','fb1a67c206cc6d45649b8d8fa55cf360'),
('22e74d55-5176-40fe-9feb-4f58f5397e3c','fdea37f9-7e94-4957-9594-50c2e8560cc4',33776331,'8102e0da5319dde9fe8099b2d4b191c430f299cd993cf610771666ae12dc647c','ed4ec68a84b89453c93583ff29287552','d358b917f852c5c4492505f80b7e726a','fd1834ee674f31d4859c5694f813bc78','61ce0dc9-a7ea-4d13-8064-6d65fa3d48ea','ff03d61c5c911bcaf198beeb0ccafba0','9ad895128e86da1e3b44747fc863735f'),
('81213af3-d6d9-4772-966d-47bc7fe4b220','ce7a06b8-3c05-4c0f-89e6-d539698637a1',33776326,'1f9780027dc663658d642f9ea86ccb64ded3ae99ff7fdcfd89ce7b4afba0e27e','120a32b1c4e7af6061956ef0ddc38a4b','c596f321a3428b81948678594588d64d','01246b00404a04616d9338fe276fc295','7504ca26-7bad-48d0-9b4b-40bac1a52c8c','df80c78cb2af6da6e9de5918590848b9','a82a7b01c50c1f9a75caa8d404d4e532')
 )v(submission_id,table_id,hand_number,request_hash,request_md5,handoff_md5,result_md5,permit_id,permit_md5,snapshot_md5) WHERE submission_id=e;
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO s FROM smarter_private.hand_submissions WHERE submission_id=e;
 SELECT * INTO h FROM smarter_private.hand_submission_handoffs WHERE submission_id=e;
 SELECT * INTO z FROM smarter_private.hand_submission_handoff_results WHERE submission_id=e;
 SELECT * INTO p FROM smarter_private.f06_hand_permits WHERE permit_id=x.permit_id;
 stack_hand:=md5('ca-hand:'||s.table_id::text||':'||s.hand_number::text||CASE WHEN coalesce(s.request->>'p_ref','')='' THEN '' ELSE ':'||(s.request->>'p_ref') END)::uuid;
 IF smarter_private.original_hand_correction_sources_match() IS DISTINCT FROM true
 OR s.submission_id IS NULL OR h.submission_id IS NULL OR z.submission_id IS NULL OR p.permit_id IS NULL
 OR s.table_id IS DISTINCT FROM x.table_id OR s.hand_number IS DISTINCT FROM x.hand_number
 OR s.request_hash IS DISTINCT FROM x.request_hash OR md5(s.request::text) IS DISTINCT FROM x.request_md5
 OR md5(to_jsonb(h)::text) IS DISTINCT FROM x.handoff_md5 OR md5(to_jsonb(z)::text) IS DISTINCT FROM x.result_md5
 OR z.result->>'reason' IS DISTINCT FROM 'successor_authority_refused'
 OR s.request#>>'{p_hand_row,_accepted_post_commit_facts,diamond_jackpot,kind}' IS DISTINCT FROM 'none'
 OR s.request#>>'{p_hand_row,_accepted_post_commit_facts,diamond_jackpot,version}' IS DISTINCT FROM '1'
 OR (s.request#>>'{p_hand_row,tournament_id}')::uuid IS DISTINCT FROM p.tournament_id
 OR z.result->>'error' IS DISTINCT FROM 'diamond_jackpot_wrong_hand_scope'
 OR z.result->>'sqlstate' IS DISTINCT FROM 'P0001' OR z.result->'success' IS DISTINCT FROM 'false'::jsonb
 OR z.result->'atomic_hand_commit' IS DISTINCT FROM 'false'::jsonb
 OR p.table_id IS DISTINCT FROM s.table_id OR p.hand_number IS DISTINCT FROM s.hand_number
 OR p.generation IS DISTINCT FROM s.lease_generation OR p.state IS DISTINCT FROM 'reserved'
 OR md5(to_jsonb(p)::text) IS DISTINCT FROM x.permit_md5
 OR (SELECT count(*) FROM public.hand_state_snapshots a WHERE a.table_id=s.table_id AND a.hand_number=s.hand_number AND NOT a.is_complete) IS DISTINCT FROM 1::bigint
 OR NOT EXISTS(SELECT FROM public.hand_state_snapshots a WHERE a.table_id=s.table_id AND a.hand_number=s.hand_number AND NOT a.is_complete AND md5(to_jsonb(a)::text)=x.snapshot_md5)
 OR jsonb_typeof(s.request->'p_stacks') IS DISTINCT FROM 'array'
 OR jsonb_array_length(s.request->'p_stacks')=0
 OR EXISTS(SELECT FROM jsonb_array_elements(s.request->'p_stacks') original_stack(value) WHERE NOT EXISTS(
  SELECT FROM public.table_seats t WHERE t.table_id=s.table_id AND t.id=(original_stack.value->>'seat_id')::uuid
   AND t.user_id=(original_stack.value->>'user_id')::uuid AND t.joined_at=(original_stack.value->>'seat_joined_at')::timestamptz
   AND t.left_at IS NULL AND t.stack=(original_stack.value->>'stack_before')::numeric))
 OR EXISTS(SELECT FROM public.hand_projection_outbox a WHERE a.hand_id=s.submission_id)
 OR EXISTS(SELECT FROM public.poker_diamond_jackpot_hits a WHERE a.table_id=s.table_id AND a.hand_number=s.hand_number)
 OR NOT EXISTS(SELECT FROM pg_proc jackpot_source WHERE jackpot_source.oid='public.fn_poker_diamond_jackpot_accept_hand()'::regprocedure AND md5(pg_get_functiondef(jackpot_source.oid))='0db3d6146f5e1118c570ded9bfb5261f' AND pg_get_userbyid(jackpot_source.proowner)='postgres' AND jackpot_source.prosecdef AND jackpot_source.proacl::text='{postgres=X/postgres}' AND to_jsonb(jackpot_source.proconfig)='["search_path=public, pg_temp"]'::jsonb)
 OR (SELECT count(*)=1 AND bool_and((t.tgenabled='O' AND md5(pg_get_triggerdef(t.oid))='d520254027350e60b03aad1f1a73747a') IS TRUE) FROM pg_trigger t WHERE t.tgfoid='public.fn_poker_diamond_jackpot_accept_hand()'::regprocedure AND NOT t.tgisinternal) IS DISTINCT FROM true
 OR EXISTS(SELECT FROM public.settlement_idempotency_keys c WHERE c.table_id=s.table_id AND c.hand_id=stack_hand)
 OR EXISTS(SELECT FROM public.ca_settlements c WHERE c.settlement_type='hand_stacks' AND c.external_ref=s.table_id::text||':'||stack_hand::text)
 OR EXISTS(SELECT FROM public.hand_atomic_commits c WHERE c.table_id=s.table_id AND c.hand_number>=s.hand_number)
 OR EXISTS(SELECT FROM public.hand_history c WHERE c.table_id=s.table_id AND c.hand_number>=s.hand_number)
 OR EXISTS(SELECT FROM smarter_private.f06_hand_permits c WHERE c.table_id=s.table_id AND c.hand_number>s.hand_number)
 THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('submission_id',e,'table_id',s.table_id,'hand_number',s.hand_number,
 'request_hash',s.request_hash,'request_md5',x.request_md5,'handoff_md5',x.handoff_md5,'result_md5',x.result_md5,
 'original_generation',s.lease_generation,'permit_id',p.permit_id,'fixed_source_md5','0db3d6146f5e1118c570ded9bfb5261f');
END $body$;

CREATE FUNCTION smarter_private.hand_source_correction_certificate_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,smarter_private AS $body$
DECLARE proof jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'HAND_SOURCE_CORRECTION_IMMUTABLE' USING ERRCODE='55000';END IF;
 proof:=smarter_private.original_hand_source_correction_proof(NEW.submission_id);
 IF proof IS NULL OR NEW.proof IS DISTINCT FROM proof THEN RAISE EXCEPTION 'HAND_SOURCE_CORRECTION_PROOF_REFUSED' USING ERRCODE='55000';END IF;
 RETURN NEW;
END $body$;
CREATE FUNCTION smarter_private.certify_original_hand_source_correction(e uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,smarter_private AS $body$
DECLARE proof jsonb;
BEGIN
 IF current_user IS DISTINCT FROM 'postgres' OR session_user IS DISTINCT FROM 'postgres'
 OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL THEN RAISE EXCEPTION 'HAND_SOURCE_CORRECTION_OPERATOR_ONLY' USING ERRCODE='42501';END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RAISE EXCEPTION 'HAND_SOURCE_CORRECTION_FROZEN' USING ERRCODE='55000';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('hand:submission:'||(SELECT table_id FROM smarter_private.hand_submissions WHERE submission_id=e)::text||':'||(SELECT hand_number FROM smarter_private.hand_submissions WHERE submission_id=e)::text,0));
 proof:=smarter_private.original_hand_source_correction_proof(e);
 IF proof IS NULL THEN RAISE EXCEPTION 'HAND_SOURCE_CORRECTION_PROOF_REFUSED' USING ERRCODE='55000';END IF;
 INSERT INTO smarter_private.hand_submission_source_corrections(submission_id,proof) VALUES(e,proof);
 RETURN jsonb_build_object('certified',true,'submission_id',e,'proof',proof,'financial_payment',false);
END $body$;
CREATE TRIGGER hand_source_correction_insert BEFORE INSERT ON smarter_private.hand_submission_source_corrections FOR EACH ROW EXECUTE FUNCTION smarter_private.hand_source_correction_certificate_guard();

CREATE FUNCTION smarter_private.hand_source_correction_claim_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,smarter_private AS $body$
DECLARE s smarter_private.hand_submissions;c smarter_private.hand_submission_source_corrections;proof jsonb;tour uuid;
BEGIN
 SELECT * INTO s FROM smarter_private.hand_submissions WHERE submission_id=NEW.submission_id;
 SELECT * INTO c FROM smarter_private.hand_submission_source_corrections WHERE submission_id=NEW.submission_id;
 proof:=smarter_private.original_hand_source_correction_proof(NEW.submission_id);
 IF auth.role() IS DISTINCT FROM 'service_role' OR proof IS NULL OR c.submission_id IS NULL OR c.proof IS DISTINCT FROM proof
 OR NEW.request_hash IS DISTINCT FROM s.request_hash OR NEW.transaction_id IS DISTINCT FROM txid_current()
 OR NEW.lease_generation IS NOT DISTINCT FROM s.lease_generation OR public.fn_platform_frozen() IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'HAND_SOURCE_CORRECTION_CLAIM_REFUSED' USING ERRCODE='55000';END IF;
 SELECT tournament_id INTO tour FROM public.tables WHERE id=s.table_id;
 IF tour IS DISTINCT FROM (s.request#>>'{p_hand_row,tournament_id}')::uuid
 OR NOT EXISTS(SELECT FROM public.engine_tournament_leases l WHERE tournament_id=tour AND instance_id=NEW.instance_id AND lease_generation=NEW.lease_generation AND protocol_version=2 AND heartbeat_at>=clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds()))
 THEN RAISE EXCEPTION 'HAND_SOURCE_CORRECTION_LEASE_REFUSED' USING ERRCODE='55000';END IF;
 RETURN NEW;
END $body$;
CREATE FUNCTION smarter_private.hand_source_correction_result_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,smarter_private AS $body$
DECLARE s smarter_private.hand_submissions;c smarter_private.hand_submission_correction_claims;a public.hand_atomic_commits;
BEGIN
 SELECT * INTO s FROM smarter_private.hand_submissions WHERE submission_id=NEW.submission_id;
 SELECT * INTO c FROM smarter_private.hand_submission_correction_claims WHERE submission_id=NEW.submission_id;
 IF s.submission_id IS NULL OR c.submission_id IS NULL OR c.request_hash IS DISTINCT FROM s.request_hash OR c.transaction_id IS DISTINCT FROM txid_current() OR NEW.result->'source_correction' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'HAND_SOURCE_CORRECTION_RESULT_REFUSED' USING ERRCODE='55000';END IF;
 SELECT * INTO a FROM public.hand_atomic_commits WHERE table_id=s.table_id AND hand_number=s.hand_number;
 IF NEW.result->'success'='true'::jsonb THEN
  IF a.hand_id IS NULL OR a.payload_hash IS NULL OR NEW.result->'atomic_hand_commit' IS DISTINCT FROM 'true'::jsonb OR a.hand_id IS DISTINCT FROM s.submission_id OR NEW.result->>'commit_hash' IS DISTINCT FROM a.payload_hash THEN RAISE EXCEPTION 'HAND_SOURCE_CORRECTION_ACCEPTANCE_UNPROVEN' USING ERRCODE='55000';END IF;
 ELSE
  IF NEW.result->'success' IS DISTINCT FROM 'false'::jsonb OR NEW.result->'atomic_hand_commit' IS DISTINCT FROM 'false'::jsonb OR a.hand_id IS NOT NULL OR NEW.result->>'reason' NOT IN ('successor_authority_refused','atomic_hand_rolled_back') OR NEW.result->>'reason' IS NULL THEN RAISE EXCEPTION 'HAND_SOURCE_CORRECTION_REFUSAL_UNPROVEN: reason% success% atomic% error%',NEW.result->>'reason',NEW.result->>'success',NEW.result->>'atomic_hand_commit',NEW.result->>'error' USING ERRCODE='55000';END IF;
 END IF;
 RETURN NEW;
END $body$;
CREATE FUNCTION smarter_private.hand_source_correction_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
BEGIN RAISE EXCEPTION 'HAND_SOURCE_CORRECTION_IMMUTABLE' USING ERRCODE='55000';END $body$;
CREATE TRIGGER hand_source_correction_claim_insert BEFORE INSERT ON smarter_private.hand_submission_correction_claims FOR EACH ROW EXECUTE FUNCTION smarter_private.hand_source_correction_claim_guard();
CREATE TRIGGER hand_source_correction_result_insert BEFORE INSERT ON smarter_private.hand_submission_correction_results FOR EACH ROW EXECUTE FUNCTION smarter_private.hand_source_correction_result_guard();
ALTER TABLE smarter_private.hand_submission_source_corrections OWNER TO postgres; ALTER TABLE smarter_private.hand_submission_source_corrections ENABLE ROW LEVEL SECURITY; REVOKE ALL ON smarter_private.hand_submission_source_corrections FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER hand_submission_source_corrections_immutable BEFORE UPDATE OR DELETE ON smarter_private.hand_submission_source_corrections FOR EACH ROW EXECUTE FUNCTION smarter_private.hand_source_correction_immutable();
CREATE TRIGGER hand_submission_source_corrections_no_truncate BEFORE TRUNCATE ON smarter_private.hand_submission_source_corrections FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.hand_source_correction_immutable();
ALTER TABLE smarter_private.hand_submission_correction_claims OWNER TO postgres; ALTER TABLE smarter_private.hand_submission_correction_claims ENABLE ROW LEVEL SECURITY; REVOKE ALL ON smarter_private.hand_submission_correction_claims FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER hand_submission_correction_claims_immutable BEFORE UPDATE OR DELETE ON smarter_private.hand_submission_correction_claims FOR EACH ROW EXECUTE FUNCTION smarter_private.hand_source_correction_immutable();
CREATE TRIGGER hand_submission_correction_claims_no_truncate BEFORE TRUNCATE ON smarter_private.hand_submission_correction_claims FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.hand_source_correction_immutable();
ALTER TABLE smarter_private.hand_submission_correction_results OWNER TO postgres; ALTER TABLE smarter_private.hand_submission_correction_results ENABLE ROW LEVEL SECURITY; REVOKE ALL ON smarter_private.hand_submission_correction_results FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER hand_submission_correction_results_immutable BEFORE UPDATE OR DELETE ON smarter_private.hand_submission_correction_results FOR EACH ROW EXECUTE FUNCTION smarter_private.hand_source_correction_immutable();
CREATE TRIGGER hand_submission_correction_results_no_truncate BEFORE TRUNCATE ON smarter_private.hand_submission_correction_results FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.hand_source_correction_immutable();
ALTER FUNCTION smarter_private.original_hand_source_correction_proof(uuid) OWNER TO postgres; REVOKE ALL ON FUNCTION smarter_private.original_hand_source_correction_proof(uuid) FROM PUBLIC,anon,authenticated,service_role;
ALTER FUNCTION smarter_private.hand_source_correction_certificate_guard() OWNER TO postgres; REVOKE ALL ON FUNCTION smarter_private.hand_source_correction_certificate_guard() FROM PUBLIC,anon,authenticated,service_role;
ALTER FUNCTION smarter_private.certify_original_hand_source_correction(uuid) OWNER TO postgres; REVOKE ALL ON FUNCTION smarter_private.certify_original_hand_source_correction(uuid) FROM PUBLIC,anon,authenticated,service_role;
ALTER FUNCTION smarter_private.hand_source_correction_claim_guard() OWNER TO postgres; REVOKE ALL ON FUNCTION smarter_private.hand_source_correction_claim_guard() FROM PUBLIC,anon,authenticated,service_role;
ALTER FUNCTION smarter_private.hand_source_correction_result_guard() OWNER TO postgres; REVOKE ALL ON FUNCTION smarter_private.hand_source_correction_result_guard() FROM PUBLIC,anon,authenticated,service_role;
ALTER FUNCTION smarter_private.hand_source_correction_immutable() OWNER TO postgres; REVOKE ALL ON FUNCTION smarter_private.hand_source_correction_immutable() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_resume_hand_submission(p_table_id uuid, p_instance_id text, p_lease_generation uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE s smarter_private.hand_submissions; h smarter_private.f06_hand_permits;
 a public.hand_atomic_commits; q jsonb; r jsonb; post jsonb; finished jsonb;
 tour uuid; locked_tour uuid; holder text; generation uuid; protocol integer; beat timestamptz;
 users uuid[]; code text; message text; claimed boolean:=false; evidence text;
 mark bigint; lo bigint; hi bigint; window_rows integer; windows integer:=0;
 retirement_restored boolean:=false;
 retired_cash_restored boolean:=false;
 source_corrected boolean:=false; source_proof jsonb;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'HAND_SUBMISSION_ENGINE_ONLY' USING ERRCODE='42501'; END IF;
 -- THE READ STARTS AT THE TABLE'S SETTLED MARK, A BOUNDED WINDOW AT A TIME
 -- (2026-10-02). This read walked EVERY submission the table ever retained
 -- (23,405 rows on one cash table, a heap fetch each in a 33 GB relation) to
 -- answer "nothing unfinished": 1.8 s warm, past the 8 s statement timeout
 -- cold, 15,085 timeouts in 12 hours, and each one refused the table's start.
 -- A finished submission stays finished (disposals and submissions are
 -- immutable; a completed post-commit is never reopened; a permit is
 -- reserved only for a new, higher hand), and only the current lease
 -- generation can retain, after this start, a higher hand number. So every
 -- hand at or below the mark is settled for ever, and the walk resumes above
 -- it. Windows of 200 hands are read until two seconds of this statement
 -- have passed (a cold hand costs ~2 random reads: 2,500 timed out at 5 s on
 -- 2026-10-02 09:25 and a 500 window started late still passed 8 s at 10:20);
 -- a table with more unread history keeps its progress and answers pending,
 -- which every caller already retries.
 SELECT m.settled_through INTO mark FROM smarter_private.hand_submission_resume_marks m
  WHERE m.table_id=p_table_id;
 lo:=COALESCE(mark,-1);
 LOOP
  SELECT max(w.hand_number),count(*) INTO hi,window_rows FROM (SELECT j.hand_number
    FROM smarter_private.hand_submissions j WHERE j.table_id=p_table_id AND j.hand_number>lo
    ORDER BY j.hand_number LIMIT 200) w;
  s:=NULL;
  EXIT WHEN window_rows=0;
  SELECT j.* INTO s FROM smarter_private.hand_submissions j
  LEFT JOIN public.hand_atomic_commits c ON c.table_id=j.table_id AND c.hand_number=j.hand_number
  LEFT JOIN smarter_private.f06_hand_permits p ON p.table_id=j.table_id AND p.hand_number=j.hand_number
  WHERE j.table_id=p_table_id AND j.hand_number>lo AND j.hand_number<=hi
  AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_disposals dd
    WHERE dd.table_id=j.table_id AND dd.hand_number=j.hand_number)
  AND (c.hand_id IS DISTINCT FROM j.submission_id OR c.post_commit_completed_at IS NULL
    OR c.post_commit_result->>'ok' IS DISTINCT FROM 'true' OR p.state='reserved')
  ORDER BY j.hand_number LIMIT 1;
  EXIT WHEN FOUND;
  lo:=hi; windows:=windows+1;
  EXIT WHEN window_rows<200;
  IF clock_timestamp()-statement_timestamp()>interval '2 seconds' THEN
   INSERT INTO smarter_private.hand_submission_resume_marks(table_id,settled_through,marked_at)
    VALUES(p_table_id,lo,clock_timestamp())
   ON CONFLICT(table_id) DO UPDATE SET settled_through=greatest(hand_submission_resume_marks.settled_through,EXCLUDED.settled_through),marked_at=EXCLUDED.marked_at;
   RETURN jsonb_build_object('found',true,'completed',false,'reason','resume_scan_continues','settled_through',lo::text);
  END IF;
 END LOOP;
 IF lo>COALESCE(mark,-1) THEN
  INSERT INTO smarter_private.hand_submission_resume_marks(table_id,settled_through,marked_at)
   VALUES(p_table_id,lo,clock_timestamp())
  ON CONFLICT(table_id) DO UPDATE SET settled_through=greatest(hand_submission_resume_marks.settled_through,EXCLUDED.settled_through),marked_at=EXCLUDED.marked_at;
 END IF;
 IF s.submission_id IS NULL THEN RETURN jsonb_build_object('found',false); END IF;
 -- This is startup continuation, not an in-flight original settlement. Keep
 -- both financial handoff and accepted postcommit behind the existing freeze
 -- boundary, before any lease or lifecycle lane. Refusal spends no claim.
 IF NOT pg_try_advisory_xact_lock_shared(530090,1) THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_MAINTENANCE_BUSY' USING ERRCODE='55P03'; END IF;
 IF public.fn_platform_frozen() THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_PLATFORM_FROZEN' USING ERRCODE='55000'; END IF;
 SELECT tournament_id INTO tour FROM public.tables WHERE id=p_table_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'HAND_SUBMISSION_TABLE_MISSING' USING ERRCODE='55000'; END IF;
 IF tour IS NOT NULL THEN
  IF EXISTS(SELECT 1 FROM smarter_private.retirement_original_hand_qualification c WHERE c.submission_id=s.submission_id) THEN
   PERFORM public.fn_ca_lock_settlement_lane_for_tournament(tour,p_table_id);
  END IF;
  SELECT array_agg((x->>'user_id')::uuid ORDER BY x->>'user_id') INTO users FROM jsonb_array_elements(s.request->'p_stacks') x;
  PERFORM smarter_private.f06_prefix(tour,p_lease_generation,users,ARRAY[p_table_id]);
  SELECT instance_id,lease_generation,protocol_version,heartbeat_at INTO holder,generation,protocol,beat
   FROM public.engine_tournament_leases WHERE tournament_id=tour FOR KEY SHARE;
 ELSE
  SELECT instance_id,lease_generation,protocol_version,heartbeat_at INTO holder,generation,protocol,beat
   FROM public.engine_table_leases WHERE table_id=p_table_id FOR KEY SHARE;
  PERFORM public.fn_ca_share_settlement_lane_for_table(p_table_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('hand:submission:'||s.table_id::text||':'||s.hand_number::text,0));
  PERFORM 1 FROM public.tables WHERE id=p_table_id FOR UPDATE;
  PERFORM 1 FROM public.table_seats WHERE table_id=p_table_id ORDER BY id FOR UPDATE;
 END IF;
 IF holder IS DISTINCT FROM p_instance_id OR generation IS DISTINCT FROM p_lease_generation OR protocol IS DISTINCT FROM 2
 OR beat IS NULL OR beat<clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds()) THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_LEASE_UNPROVEN' USING ERRCODE='55000'; END IF;
 SELECT tournament_id INTO locked_tour FROM public.tables WHERE id=p_table_id;
 IF locked_tour IS DISTINCT FROM tour THEN RAISE EXCEPTION 'HAND_SUBMISSION_SCOPE_CHANGED' USING ERRCODE='55000'; END IF;
 -- A HAND THIS CASH TABLE HAS ALREADY DEALT PAST IS DISPOSED AT ITS DOOR
 -- (2026-09-29). A later committed hand consumed the before-stacks this
 -- request names, so nobody can ever apply it; the receipted, zero-credit
 -- disposal is written here, under this caller's proven lease and the
 -- table's locks, and the next unfinished request is read. A tournament
 -- table's dead hands stay with the F06 abort doors.
 -- A REFUSED HAND WHOSE CHAIRS HAVE ALL CLOSED IS DISPOSED HERE TOO
 -- (2026-10-09): rolled back, never durable, and no chair left to apply it to.
 IF tour IS NULL AND ((EXISTS(SELECT 1 FROM public.hand_atomic_commits
   WHERE table_id=p_table_id AND hand_number>s.hand_number)
  AND smarter_private.hand_submission_dispose_dealt_past(p_table_id,s.hand_number)>0)
  OR smarter_private.hand_submission_dispose_refused_vacated(p_table_id,s.submission_id)>0) THEN
  -- The next unfinished request, read above the hands just disposed and
  -- inside the window already proven: everything at or below lo is settled.
  SELECT j.* INTO s FROM smarter_private.hand_submissions j
  LEFT JOIN public.hand_atomic_commits c ON c.table_id=j.table_id AND c.hand_number=j.hand_number
  LEFT JOIN smarter_private.f06_hand_permits p ON p.table_id=j.table_id AND p.hand_number=j.hand_number
  WHERE j.table_id=p_table_id AND j.hand_number>lo AND j.hand_number<=hi
  AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_disposals dd
    WHERE dd.table_id=j.table_id AND dd.hand_number=j.hand_number)
  AND (c.hand_id IS DISTINCT FROM j.submission_id OR c.post_commit_completed_at IS NULL
    OR c.post_commit_result->>'ok' IS DISTINCT FROM 'true' OR p.state='reserved')
  ORDER BY j.hand_number LIMIT 1;
  IF NOT FOUND AND window_rows>=200 THEN
   RETURN jsonb_build_object('found',true,'completed',false,'reason','resume_scan_continues','settled_through',lo::text); END IF;
  IF NOT FOUND THEN RETURN jsonb_build_object('found',false); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hand:submission:'||s.table_id::text||':'||s.hand_number::text,0));
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('hand:submission:'||s.table_id::text||':'||s.hand_number::text,0));
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE table_id=s.table_id AND hand_number=s.hand_number;
 IF tour IS NOT NULL THEN
  IF h.permit_id IS NULL OR h.tournament_id IS DISTINCT FROM tour OR h.generation IS DISTINCT FROM s.lease_generation
   OR h.state NOT IN('reserved','accepted') THEN RAISE EXCEPTION 'HAND_SUBMISSION_ORIGINAL_PERMIT_REQUIRED' USING ERRCODE='55000'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('f06:hand:'||h.permit_id::text,0)) THEN
   RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE='55P03'; END IF;
 END IF;
 SELECT * INTO a FROM public.hand_atomic_commits WHERE table_id=s.table_id AND hand_number=s.hand_number;
 IF FOUND THEN
  IF a.hand_id IS DISTINCT FROM s.submission_id OR a.post_commit_payload IS NULL THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_ACCEPTANCE_UNPROVEN' USING ERRCODE='55000'; END IF;
  r:=a.stack_result||jsonb_build_object('success',true,'atomic_hand_commit',true,'history_id',a.hand_id,
    'commit_hash',a.payload_hash,'post_commit_obligations',true,'post_commit_payload_hash',a.post_commit_payload_hash);
 ELSE
  IF EXISTS(SELECT 1 FROM smarter_private.hand_submission_handoffs WHERE submission_id=s.submission_id) THEN
   source_proof:=smarter_private.original_hand_source_correction_proof(s.submission_id);
   IF source_proof IS NULL OR NOT EXISTS(SELECT FROM smarter_private.hand_submission_source_corrections c WHERE c.submission_id=s.submission_id AND c.proof=source_proof)
    OR EXISTS(SELECT FROM smarter_private.hand_submission_correction_claims c WHERE c.submission_id=s.submission_id) THEN
    RETURN jsonb_build_object('found',true,'completed',false,'submission_id',s.submission_id,'reason','successor_financial_claim_spent');END IF;
   source_corrected:=true;
  END IF;
  -- The original generation owns its own door; it is never its own successor.
  IF s.lease_generation=p_lease_generation THEN
   RETURN jsonb_build_object('found',true,'completed',false,'submission_id',s.submission_id,'reason','original_failure_or_handoff_unproven'); END IF;
  -- A canonical failure row is one proof that the original cannot settle this
  -- hand. The other is read here: the scope lease holds this caller's
  -- generation, not the original's, and this transaction has held that row
  -- FOR KEY SHARE since it was verified, so no takeover or release can move
  -- it until this transaction ends. Every settlement of this hand holds this
  -- hand's submission lock (taken above) from before its own lease check to
  -- its end, and the atomic receipt read under that lock found nothing. So the
  -- original never settled this hand, cannot settle it while its generation is
  -- not the lease, and if it ever holds the lease again it can only replay the
  -- payload-identical receipt this one handoff writes.
  IF generation IS DISTINCT FROM p_lease_generation OR generation IS NOT DISTINCT FROM s.lease_generation THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_LEASE_UNPROVEN' USING ERRCODE='55000'; END IF;
  evidence:=CASE WHEN EXISTS(SELECT 1 FROM smarter_private.hand_submission_failures f
   WHERE f.submission_id=s.submission_id AND f.request_hash=s.request_hash)
   THEN 'canonical_failure' ELSE 'superseded_generation' END;
  -- The original exact generations and before-stacks must still occupy the
  -- table. No later hand/permit may have consumed this starting state.
  -- A chair taken AFTER this hand was dealt is not part of it: it was not
  -- dealt in, the hand cannot move its chips, and the committed stacks name
  -- only the hand's own seats. Such a chair must not hold the finished hand
  -- hostage (2026-09-26, 8ec7e81d: a late registrant seated 30 s after the
  -- hand ended froze its table for eight days). A chair that was present at
  -- the deal and is missing from the submission is admitted only when the
  -- hand declares no inflow, the hand's own record never names its player,
  -- and every player the record names is in the submission (2026-09-29,
  -- 6c9ee4b6: two horses seated 43 s and 18 s before the deal, not dealt in,
  -- froze the table for six days). The settlement still refuses any
  -- non-conserving stack set, so a dealt player left out of the stacks can
  -- never settle. A hand player seated twice still refuses; an undated deal
  -- refuses.
  q:=s.request;
  retirement_restored:=smarter_private.restore_retired_original_tournament_hand(s.submission_id,p_instance_id,p_lease_generation);
  retired_cash_restored:=smarter_private.adopt_retired_cash_original_hand(s.submission_id,p_instance_id,p_lease_generation);
  IF NOT EXISTS(SELECT 1 FROM public.tables WHERE id=s.table_id
      AND NOT COALESCE(is_deleted,false) AND lower(status) IN ('waiting','running')
      -- Cash tables are 'live', or 'breaking' while the table is being closed
      -- (2026-09-29, 499aa67a): the original commit never refused a breaking
      -- cash table, so its successor must not either. A tournament table keeps
      -- NULL until it closes; 'closed' still refuses everywhere.
      AND (lifecycle='live' OR (tour IS NULL AND lifecycle='breaking') OR (tour IS NOT NULL AND lifecycle IS NULL)))
   OR (tour IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id=tour AND upper(status)='RUNNING')) THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_TABLE_NOT_ADMITTED' USING ERRCODE='55000'; END IF;
  IF jsonb_array_length(q->'p_stacks')=0 OR
   (q->'p_hand_row'->>'started_at') IS NULL
   OR EXISTS(SELECT 1 FROM public.table_seats late WHERE late.table_id=s.table_id AND late.left_at IS NULL
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q->'p_stacks') x WHERE (x->>'seat_id')::uuid=late.id)
     AND ((late.joined_at<=(q->'p_hand_row'->>'started_at')::timestamptz
         AND (strpos((q->'p_hand_row')::text,late.user_id::text)>0
           OR COALESCE((q->>'p_inflow')::numeric,0)<>0
           OR jsonb_typeof(q->'p_hand_row'->'players') IS DISTINCT FROM 'array'
           OR EXISTS(SELECT 1 FROM jsonb_array_elements(q->'p_hand_row'->'players') hp
             WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q->'p_stacks') x WHERE x->>'user_id'=hp->>'userId'))))
       OR late.user_id IN (SELECT (x->>'user_id')::uuid FROM jsonb_array_elements(q->'p_stacks') x)))
   OR (SELECT count(DISTINCT x->>'seat_id') FROM jsonb_array_elements(q->'p_stacks') x)<>jsonb_array_length(q->'p_stacks')
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(q->'p_stacks') x WHERE NOT EXISTS(
     SELECT 1 FROM smarter_private.retired_cash_hand_custody r
      WHERE r.submission_id=s.submission_id AND r.request_hash=s.request_hash AND r.state='held'
       AND r.transaction_id=txid_current() AND r.user_id=(x->>'user_id')::uuid
       AND r.seat_id=(x->>'seat_id')::uuid AND r.occupancy_id=(x->>'occupancy_id')::uuid
       AND r.seat_joined_at=(x->>'seat_joined_at')::timestamptz
       AND r.stack_before=(x->>'stack_before')::numeric AND r.stack_after=(x->>'stack')::numeric)
    AND NOT EXISTS(
     SELECT 1 FROM public.table_seats seat WHERE seat.table_id=s.table_id AND seat.id=(x->>'seat_id')::uuid
       AND seat.user_id=(x->>'user_id')::uuid AND seat.joined_at=(x->>'seat_joined_at')::timestamptz
       AND seat.left_at IS NULL AND (seat.stack=(x->>'stack_before')::numeric
       -- AN ADD-ON CREDITED WHILE THE HAND WAITED (2026-10-02). A tournament
       -- chair may hold exactly the event's addon_chips more than the hand
       -- dealt from, only when its registration bought the add-on. The
       -- settlement runs in delta mode (every element carries stack_before),
       -- so that credit is preserved, not overwritten.
       OR (tour IS NOT NULL AND EXISTS(SELECT 1 FROM public.tournament_players tp
         JOIN public.tournaments ev ON ev.id=tp.tournament_id
         WHERE tp.tournament_id=tour AND tp.user_id=seat.user_id AND tp.add_on IS TRUE
           AND COALESCE(ev.addon_chips,0)>0
           AND seat.stack=(x->>'stack_before')::numeric+ev.addon_chips)))))
   OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=s.table_id AND hand_number>=s.hand_number)
   OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=s.table_id AND hand_number>=s.hand_number)
   OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=s.table_id AND hand_number>s.hand_number) THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_HANDOFF_STATE_CHANGED' USING ERRCODE='55000'; END IF;
  -- A wait for another lane may outlast the heartbeat or cross the existing
  -- announced freeze clock. Recheck immediately before the irreversible claim.
  IF public.fn_platform_frozen() THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_PLATFORM_FROZEN' USING ERRCODE='55000'; END IF;
  IF tour IS NULL THEN
   SELECT heartbeat_at INTO beat FROM public.engine_table_leases WHERE table_id=s.table_id;
  ELSE
   SELECT heartbeat_at INTO beat FROM public.engine_tournament_leases WHERE tournament_id=tour;
  END IF;
  IF beat IS NULL OR beat<clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds()) THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_LEASE_UNPROVEN' USING ERRCODE='55000'; END IF;
  IF source_corrected THEN
   -- Reprove under original lifecycle/lease/hand locks, immediately before this additive one-time claim.
   IF smarter_private.original_hand_source_correction_proof(s.submission_id) IS DISTINCT FROM source_proof THEN RAISE EXCEPTION 'HAND_SOURCE_CORRECTION_ADMISSION_CHANGED' USING ERRCODE='55000';END IF;
   INSERT INTO smarter_private.hand_submission_correction_claims(submission_id,request_hash,instance_id,lease_generation,transaction_id) VALUES(s.submission_id,s.request_hash,p_instance_id,p_lease_generation,txid_current());
  ELSE
  INSERT INTO smarter_private.hand_submission_handoffs(submission_id,original_generation,instance_id,lease_generation,request_hash,transaction_id)
   VALUES(s.submission_id,s.lease_generation,p_instance_id,p_lease_generation,s.request_hash,txid_current());
  END IF;
  claimed:=true;
  BEGIN
   INSERT INTO smarter_private.hand_submission_dispatch VALUES(txid_current(),s.submission_id,s.request_hash,p_instance_id,p_lease_generation);
   r:=public.fn_ca_commit_hand_settlement(s.table_id,s.hand_number,q->'p_stacks',
    (q->>'p_rake')::numeric,(q->>'p_bbj')::numeric,q->>'p_ref',(q->>'p_inflow')::numeric,
    q->'p_hand_row',q->'p_units',p_instance_id,p_lease_generation,q->'p_post_commit_obligations');
  EXCEPTION WHEN OTHERS THEN
   GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE,message=MESSAGE_TEXT;
   r:=jsonb_build_object('success',false,'atomic_hand_commit',false,'reason','successor_authority_refused','sqlstate',code,'error',message);
  END;
  -- Metadata restoration is valid only if the SAME original hand commits.
  -- A returned or thrown financial refusal rolls back the entire call,
  -- including every restored row, receipt and handoff claim.
  IF (retirement_restored OR retired_cash_restored) AND (r->>'success' IS DISTINCT FROM 'true' OR r->>'atomic_hand_commit' IS DISTINCT FROM 'true') THEN
   RAISE EXCEPTION 'RETIREMENT_ORIGINAL_HAND_NOT_COMMITTED: %',r USING ERRCODE='P0404';
  END IF;
  -- A lock/freeze/lease admission refusal is not the one financial attempt.
  -- Raise outside the caught subtransaction so its claim also rolls back.
  IF r->>'success' IS DISTINCT FROM 'true' AND (
    r->>'sqlstate' IN ('55P03','40001','40P01')
    OR r->>'reason' IN ('hand_lease_lost','hand_lease_stale','hand_lease_scope_changed','invalid_hand_lease_authority')
    OR (r->>'sqlstate'='42501' AND r->>'error'='F06_LEASE_FENCED')
    OR public.fn_platform_frozen()) THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_ADMISSION_CHANGED: %',r USING ERRCODE='55P03';
  END IF;
  DELETE FROM smarter_private.hand_submission_dispatch WHERE transaction_id=txid_current() AND submission_id=s.submission_id;
  IF source_corrected THEN
   INSERT INTO smarter_private.hand_submission_correction_results(submission_id,result) VALUES(s.submission_id,r||jsonb_build_object('source_correction',true));
  ELSE
  INSERT INTO smarter_private.hand_submission_handoff_results VALUES(s.submission_id,r||jsonb_build_object('handoff_evidence',evidence));
  END IF;
  IF r->>'success' IS DISTINCT FROM 'true' OR r->>'atomic_hand_commit' IS DISTINCT FROM 'true' THEN
   RETURN jsonb_build_object('found',true,'completed',false,'submission_id',s.submission_id,'reason','successor_financial_refused','outcome',r); END IF;
 END IF;
 r:=smarter_private.acknowledge_hand_submission(s.submission_id,r);
 -- A later current owner may replay this branch after acknowledgment loss.
 -- It never spends or recreates the one-time financial claim.
 BEGIN
  post:=public.fn_ca_process_hand_post_commit_obligations(s.submission_id);
  IF post->>'ok' IS DISTINCT FROM 'true' OR NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits
    WHERE table_id=s.table_id AND hand_number=s.hand_number AND hand_id=s.submission_id
    AND post_commit_completed_at IS NOT NULL AND post_commit_result->>'ok'='true') THEN
   IF retired_cash_restored THEN
    RAISE EXCEPTION 'RETIRED_CASH_ORIGINAL_POSTCOMMIT_NOT_COMPLETED' USING ERRCODE='P0404';
   END IF;
   RETURN r||jsonb_build_object('found',true,'completed',false,'reason','accepted_postcommit_pending'); END IF;
  IF tour IS NOT NULL THEN
   finished:=public.fn_f06_finish_hand(tour,p_lease_generation,h.permit_id,'accepted',s.submission_id);
   IF finished->>'ok' IS DISTINCT FROM 'true' OR finished->>'state' IS DISTINCT FROM 'accepted'
    OR finished->>'evidence_id' IS DISTINCT FROM s.submission_id::text THEN
    RAISE EXCEPTION 'HAND_SUBMISSION_PERMIT_COMPLETION_UNPROVEN' USING ERRCODE='55000'; END IF;
  END IF;
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE,message=MESSAGE_TEXT;
  IF retired_cash_restored THEN
   RAISE EXCEPTION 'RETIRED_CASH_ORIGINAL_POSTCOMMIT_REFUSED: % %',code,message USING ERRCODE='P0404';
  END IF;
  RETURN r||jsonb_build_object('found',true,'completed',false,'reason','accepted_postcommit_pending','sqlstate',code,'error',message);
 END;
 IF retired_cash_restored AND EXISTS(SELECT 1 FROM smarter_private.retired_cash_hand_custody c
  WHERE c.submission_id=s.submission_id AND (c.state IS DISTINCT FROM 'consumed'
   OR c.accepted_time_bank IS DISTINCT FROM c.original_time_bank OR c.settlement_id IS NULL)) THEN
  RAISE EXCEPTION 'RETIRED_CASH_ORIGINAL_CUSTODY_NOT_CONSUMED' USING ERRCODE='P0404';
 END IF;
 RETURN r||jsonb_build_object('found',true,'completed',true,'hand_number',s.hand_number::text,
   'financial_handoff',claimed,'permit_id',h.permit_id,'post_commit_completed',true);
END $function$;

REVOKE ALL ON FUNCTION public.fn_ca_resume_hand_submission(uuid,text,uuid) FROM PUBLIC,anon,authenticated;

DO $post$
BEGIN
 IF (SELECT count(*)=8 AND bool_and((p.oid IS NOT NULL AND md5(p.prosrc)=x.body_md5 AND pg_get_userbyid(p.proowner)='postgres') IS TRUE) FROM (VALUES ('smarter_private.original_hand_correction_sources_match()','00b1b2915e62b6c972ab8a7ef9e7f72a'),('smarter_private.original_hand_source_correction_proof(uuid)','54d4af30285d053b43ce23118a7e2d94'),('smarter_private.hand_source_correction_certificate_guard()','c729452e457fc5da2442ae42b3262fb1'),('smarter_private.certify_original_hand_source_correction(uuid)','662e18269d2375cd43edf14880afc661'),('smarter_private.hand_source_correction_claim_guard()','ef21544eff700fb3d8e21ba9694c4d9b'),('smarter_private.hand_source_correction_result_guard()','43cef74476145b289e98153678b0e073'),('smarter_private.hand_source_correction_immutable()','d0e33f97eba0467bb7076b491262fdcb'),('public.fn_ca_resume_hand_submission(uuid,text,uuid)','48040fd6774684226422466861eb1439')) x(signature,body_md5) LEFT JOIN pg_proc p ON p.oid=to_regprocedure(x.signature)) IS DISTINCT FROM true THEN RAISE EXCEPTION 'ORIGINAL30_POSTIMAGES_REQUIRED' USING ERRCODE='55000';END IF;
 IF smarter_private.original_hand_correction_sources_match() IS DISTINCT FROM true THEN RAISE EXCEPTION 'ORIGINAL30_DEPENDENCIES_CHANGED' USING ERRCODE='55000';END IF;
 IF (SELECT count(*)=7 AND bool_and((NOT p.prosecdef AND p.proacl::text='{postgres=X/postgres}' AND to_jsonb(p.proconfig)=CASE WHEN p.proname='hand_source_correction_immutable' THEN '["search_path=pg_catalog"]'::jsonb ELSE '["search_path=pg_catalog, public, smarter_private"]'::jsonb END) IS TRUE) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='smarter_private' AND p.proname IN('original_hand_correction_sources_match','original_hand_source_correction_proof','hand_source_correction_certificate_guard','certify_original_hand_source_correction','hand_source_correction_claim_guard','hand_source_correction_result_guard','hand_source_correction_immutable')) IS DISTINCT FROM true THEN RAISE EXCEPTION 'ORIGINAL30_PRIVATE_FUNCTION_SECURITY' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p WHERE p.oid='public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=pg_catalog, public"]'::jsonb) THEN RAISE EXCEPTION 'ORIGINAL30_ENGINE_FUNCTION_SECURITY' USING ERRCODE='55000';END IF;
 IF EXISTS(SELECT FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid IN('smarter_private.hand_submission_source_corrections'::regclass,'smarter_private.hand_submission_correction_claims'::regclass,'smarter_private.hand_submission_correction_results'::regclass) AND a.grantee<>c.relowner) THEN RAISE EXCEPTION 'ORIGINAL30_PRIVATE_TABLE_UNEXPECTED_GRANTEE' USING ERRCODE='55000';END IF;

 IF (SELECT count(*) FROM smarter_private.hand_submission_source_corrections)<>0 OR (SELECT count(*) FROM smarter_private.hand_submission_correction_claims)<>0 OR (SELECT count(*) FROM smarter_private.hand_submission_correction_results)<>0 THEN RAISE EXCEPTION 'ORIGINAL30_INSTALLATION_MUST_NOT_ADMIT' USING ERRCODE='55000';END IF;
 IF (SELECT count(*)=3 AND bool_and((c.relpersistence='p' AND c.relrowsecurity AND pg_get_userbyid(c.relowner)='postgres' AND NOT has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AND NOT has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AND NOT has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')) IS TRUE) FROM pg_class c WHERE c.oid IN('smarter_private.hand_submission_source_corrections'::regclass,'smarter_private.hand_submission_correction_claims'::regclass,'smarter_private.hand_submission_correction_results'::regclass)) IS DISTINCT FROM true THEN RAISE EXCEPTION 'ORIGINAL30_PRIVATE_RELATION_SECURITY' USING ERRCODE='55000';END IF;
 IF EXISTS(SELECT FROM pg_policy WHERE polrelid IN('smarter_private.hand_submission_source_corrections'::regclass,'smarter_private.hand_submission_correction_claims'::regclass,'smarter_private.hand_submission_correction_results'::regclass)) THEN RAISE EXCEPTION 'ORIGINAL30_UNEXPECTED_PRIVATE_POLICY' USING ERRCODE='55000';END IF;
 IF (SELECT count(*)=9 AND bool_and((t.oid IS NOT NULL AND t.tgenabled='O' AND t.tgfoid=to_regprocedure(x.function_name) AND t.tgtype=x.event_bits AND md5(pg_get_triggerdef(t.oid))=x.definition_md5) IS TRUE) FROM (VALUES ('smarter_private.hand_submission_correction_claims','hand_source_correction_claim_insert','smarter_private.hand_source_correction_claim_guard()','aaaa4ca6fd83d22643184b17634d9718',7),('smarter_private.hand_submission_correction_claims','hand_submission_correction_claims_immutable','smarter_private.hand_source_correction_immutable()','6279cc2604256c9fd1c9e24c34a54042',27),('smarter_private.hand_submission_correction_claims','hand_submission_correction_claims_no_truncate','smarter_private.hand_source_correction_immutable()','1a0639de8dffe7f59abcb890b2f8a36c',34),('smarter_private.hand_submission_correction_results','hand_source_correction_result_insert','smarter_private.hand_source_correction_result_guard()','6ec1c60cad8d00434f1dfecd3ec2553f',7),('smarter_private.hand_submission_correction_results','hand_submission_correction_results_immutable','smarter_private.hand_source_correction_immutable()','e82bd0c60ee20689a6b39a812be91fca',27),('smarter_private.hand_submission_correction_results','hand_submission_correction_results_no_truncate','smarter_private.hand_source_correction_immutable()','4bbbbea874251c7e8244c2faaaa4bc47',34),('smarter_private.hand_submission_source_corrections','hand_source_correction_insert','smarter_private.hand_source_correction_certificate_guard()','8705bcc5b0ac6eb40188d0fe6083e0c4',7),('smarter_private.hand_submission_source_corrections','hand_submission_source_corrections_immutable','smarter_private.hand_source_correction_immutable()','e0f152929978b66b613927561ded6fb2',27),('smarter_private.hand_submission_source_corrections','hand_submission_source_corrections_no_truncate','smarter_private.hand_source_correction_immutable()','76721f39a41d9427734a57a74591dbbf',34)) x(table_name,trigger_name,function_name,definition_md5,event_bits) LEFT JOIN pg_trigger t ON t.tgrelid=to_regclass(x.table_name) AND t.tgname=x.trigger_name AND NOT tgisinternal) IS DISTINCT FROM true OR (SELECT count(*) FROM pg_trigger WHERE tgrelid IN('smarter_private.hand_submission_source_corrections'::regclass,'smarter_private.hand_submission_correction_claims'::regclass,'smarter_private.hand_submission_correction_results'::regclass) AND NOT tgisinternal)<>9 THEN RAISE EXCEPTION 'ORIGINAL30_IMMUTABLE_TRIGGER_WIRING' USING ERRCODE='55000';END IF;
END $post$;
COMMIT;
