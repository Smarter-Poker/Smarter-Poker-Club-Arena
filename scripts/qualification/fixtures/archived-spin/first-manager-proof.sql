BEGIN READ ONLY;
DO $$ BEGIN
 IF session_user<>'fixture_bootstrap' OR current_database() !~ '^qual_spin_expiry_[0-9a-f]{32}$'
 OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>''
 THEN RAISE EXCEPTION 'ARCHIVE_MANAGER_PROOF_BOUNDARY'; END IF;
 IF smarter_private.f06_retired_origin_cohort('2aa4cba1-506f-426b-a1ba-d8e22e018533') IS NOT NULL
 OR EXISTS(SELECT 1 FROM smarter_private.f06_retired_manager_origins WHERE tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533')
 OR EXISTS(SELECT 1 FROM smarter_private.f06_manager_custody_transfers WHERE tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533')
 OR EXISTS(SELECT 1 FROM smarter_private.f06_manager_custody_admissions WHERE tournament_id='2aa4cba1-506f-426b-a1ba-d8e22e018533')
 THEN RAISE EXCEPTION 'ARCHIVE_ORIGINAL_MANAGER_CUSTODY_CHANGED'; END IF;
END $$;
ROLLBACK;
