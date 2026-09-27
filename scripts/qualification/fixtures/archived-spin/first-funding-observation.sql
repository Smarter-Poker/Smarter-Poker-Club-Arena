\set ON_ERROR_STOP on
-- Read only original funding proof before the candidate; retain exact values
-- when a later strict candidate comparison refuses. No financial writer call.
BEGIN READ ONLY;
SET LOCAL timezone='UTC';
SELECT set_config('archive_qualification.execution_uuid', :'execution_uuid', true);
DO $$ BEGIN
 IF session_user<>'fixture_bootstrap' OR current_database()<>'qual_spin_expiry_'||replace(current_setting('archive_qualification.execution_uuid'),'-','') THEN
 RAISE EXCEPTION 'ARCHIVE_FUNDING_OBSERVER_BOUNDARY'; END IF;
 IF inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>''
 OR current_setting('session_replication_role')<>'origin'
 OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
 THEN RAISE EXCEPTION 'ARCHIVE_FUNDING_OBSERVER_BOUNDARY'; END IF;
END $$;
SELECT jsonb_build_object('stage','first_original_funding_observation','execution',:'execution_uuid',
 'event','2aa4cba1-506f-426b-a1ba-d8e22e018533',
 'actual',public.fn_ca_legacy_spin_original_fee_proof('2aa4cba1-506f-426b-a1ba-d8e22e018533'),
 'expected',smarter_private.spin_archived_first_manifest()->'reviewed_fee_proof',
 'financial_qualified',false,'production_qualified',false);
ROLLBACK;
