-- Mirror the provider's real join probe, not an already published private row.
GRANT USAGE ON SCHEMA realtime,auth TO authenticated;
GRANT SELECT ON realtime.messages TO authenticated;
INSERT INTO realtime.messages(extension,topic) VALUES
 ('broadcast','member-record:00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000002');
SET test.viewer='00000000-0000-0000-0000-000000000009';
SET realtime.topic='member-record:00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000002';
SET ROLE authenticated;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM realtime.messages) THEN RAISE EXCEPTION 'Baseline unexpectedly authorizes provider probe'; END IF;
 RAISE NOTICE 'REPRODUCED: authorized member rejected because provider probe private is NULL';
END $$;
RESET ROLE;
