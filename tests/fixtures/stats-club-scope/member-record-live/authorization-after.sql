SET ROLE authenticated;
DO $$ BEGIN
 IF (SELECT count(*) FROM realtime.messages)<>1 THEN RAISE EXCEPTION 'Authorized provider probe still rejected'; END IF;
 PERFORM set_config('test.access','none',false);
 IF EXISTS(SELECT 1 FROM realtime.messages) THEN RAISE EXCEPTION 'Unrelated viewer authorized'; END IF;
 PERFORM set_config('test.access','staff',false);
 PERFORM set_config('realtime.topic','member-record:00000000-0000-0000-0000-000000000007:00000000-0000-0000-0000-000000000002',false);
 IF EXISTS(SELECT 1 FROM realtime.messages) THEN RAISE EXCEPTION 'Wrong topic visible'; END IF;
END $$;
RESET ROLE;
TRUNCATE realtime.messages;
