-- Same backend LISTEN observes actual Postgres commit notifications, not a mock.
LISTEN ca_private_record_changes;
DO $$ BEGIN
 IF NOT fn_private_record_transport_ready() OR NOT (SELECT supabase_enabled FROM ca_private_record_transport_state) THEN RAISE EXCEPTION 'Dual delivery not ready/default paid disabled'; END IF;
 IF has_function_privilege('authenticated','fn_private_record_transport_ready()','EXECUTE') OR has_table_privilege('service_role','ca_private_record_transport_state','UPDATE') OR has_function_privilege('service_role','fn_dispatch_private_record_signal(text,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'Transport ACL widened'; END IF;
END $$;
TRUNCATE signals;
BEGIN;
SELECT fn_publish_member_record_topic('member-record:71000000-0000-0000-0000-000000000001:71000000-0000-0000-0000-000000000002','{}');
SELECT fn_publish_member_record_topic('member-record:71000000-0000-0000-0000-000000000001:71000000-0000-0000-0000-000000000002','{}');
SELECT fn_publish_club_roster('71000000-0000-0000-0000-000000000001');
DO $$ BEGIN IF (SELECT count(*) FROM signals)<>2 OR EXISTS(SELECT 1 FROM signals WHERE private IS NOT TRUE OR event<>'record_changed') THEN RAISE EXCEPTION 'Dual delivery/dedup contract changed'; END IF; END $$;
COMMIT;
TRUNCATE signals;
BEGIN;
SELECT fn_publish_member_record_topic('member-record:72000000-0000-0000-0000-000000000001:72000000-0000-0000-0000-000000000002','{}');
ROLLBACK;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM signals) THEN RAISE EXCEPTION 'Rollback emitted paid signal'; END IF; END $$;
-- Owner-only explicit switch; engine notification remains, paid messages stop.
UPDATE ca_private_record_transport_state SET supabase_enabled=false WHERE singleton;
BEGIN;
SELECT fn_publish_member_record_topic('member-record:73000000-0000-0000-0000-000000000001:73000000-0000-0000-0000-000000000002','{}');
SELECT fn_publish_club_roster('73000000-0000-0000-0000-000000000001');
COMMIT;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM signals) OR NOT fn_private_record_transport_ready() THEN RAISE EXCEPTION 'Explicit engine transport cutover failed'; END IF; END $$;
UPDATE ca_private_record_transport_state SET supabase_enabled=true WHERE singleton;
BEGIN;
SELECT fn_publish_member_record_topic('member-record:74000000-0000-0000-0000-000000000001:74000000-0000-0000-0000-000000000002','{}');
COMMIT;
DO $$ BEGIN IF (SELECT count(*) FROM signals)<>1 THEN RAISE EXCEPTION 'Explicit paid rollback unavailable'; END IF; END $$;
-- Any connected source drift makes capability false, preserving fail-closed join.
BEGIN;
UPDATE ca_private_record_transport_state SET source_fingerprints=jsonb_set(source_fingerprints,'{public.fn_publish_club_roster(uuid)}','"changed"') WHERE singleton;
DO $$ BEGIN IF fn_private_record_transport_ready() THEN RAISE EXCEPTION 'Source drift reported ready'; END IF; END $$;
ROLLBACK;
DO $$ BEGIN IF NOT fn_private_record_transport_ready() THEN RAISE EXCEPTION 'Source fingerprint restoration failed'; END IF; END $$;
UNLISTEN ca_private_record_changes;
\echo PRIVATE_RECORD_NOTIFY PASS: actual commit delivery, exact two topic families, transaction dedup/rollback, paid default on, explicit cutover and reversal, private configuration and source-bound readiness
