-- Mirror realtime.authorize: authorization probes omit private and payload.
-- Its private default is false; the channel itself still uses private:true.
BEGIN;
INSERT INTO realtime.messages(id,topic,extension)
VALUES ('50000000-0000-4000-8000-000000000001','player-history:10000000-0000-4000-8000-000000000001','broadcast');
INSERT INTO club_members VALUES('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000004','admin','active');
SET LOCAL ROLE authenticated;
SELECT set_config('realtime.topic','player-history:10000000-0000-4000-8000-000000000001',true);
SELECT set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000001',true);
DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM realtime.messages WHERE id='50000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'staff join probe denied'; END IF; END$$;
SELECT set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000002',true);
DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM realtime.messages WHERE id='50000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'union join probe denied'; END IF; END$$;
SELECT set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',true);
DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM realtime.messages WHERE id='50000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'platform join probe denied'; END IF; END$$;
SELECT set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000004',true);
DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM realtime.messages WHERE id='50000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'active admin join probe denied'; END IF;
 BEGIN INSERT INTO realtime.messages(topic,extension)VALUES(realtime.topic(),'broadcast'); RAISE EXCEPTION 'client publish allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END$$;
RESET ROLE;
UPDATE club_members SET status='suspended' WHERE user_id='30000000-0000-4000-8000-000000000004';
SET LOCAL ROLE authenticated;
DO $$BEGIN IF EXISTS(SELECT 1 FROM realtime.messages WHERE id='50000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'revoked join allowed'; END IF; END$$;
SELECT set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',true);
SELECT set_config('realtime.topic','player-history:10000000-0000-4000-8000-000000000002',true);
DO $$BEGIN IF EXISTS(SELECT 1 FROM realtime.messages WHERE id='50000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'wrong topic allowed'; END IF; END$$;
SELECT set_config('realtime.topic','player-history:invalid',true);
DO $$BEGIN IF EXISTS(SELECT 1 FROM realtime.messages WHERE id='50000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'malformed topic allowed'; END IF; END$$;
RESET ROLE;
UPDATE realtime.messages SET extension='presence' WHERE id='50000000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT set_config('realtime.topic','player-history:10000000-0000-4000-8000-000000000001',true);
DO $$BEGIN IF EXISTS(SELECT 1 FROM realtime.messages WHERE id='50000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'presence allowed'; END IF; END$$;
RESET ROLE;
UPDATE realtime.messages SET extension='broadcast' WHERE id='50000000-0000-4000-8000-000000000001';
DELETE FROM clubs WHERE is_union;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000002',true);
DO $$BEGIN IF EXISTS(SELECT 1 FROM realtime.messages WHERE id='50000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'agent join allowed'; END IF; END$$;
SET LOCAL ROLE anon;
DO $$BEGIN IF EXISTS(SELECT 1 FROM realtime.messages WHERE id='50000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'anonymous join allowed'; END IF; END$$;
ROLLBACK;
SELECT 'PASS actual Realtime join probe, staff/union/platform/admin, revocation, topic/extension boundaries and publish denial';
