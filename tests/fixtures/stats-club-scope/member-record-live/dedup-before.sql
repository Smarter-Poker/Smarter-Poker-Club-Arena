-- Reproduce repeated private sends from the actual installed source publishers.
BEGIN;
TRUNCATE signals;
SELECT fn_publish_member_record_user('30000000-0000-0000-0000-000000000003');
SELECT fn_publish_member_record_user('30000000-0000-0000-0000-000000000003');
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM signals WHERE topic LIKE 'member-record:%' GROUP BY topic HAVING count(*)>1) THEN
   RAISE EXCEPTION 'Repeated member signal baseline no longer reproduces';
 END IF;
 RAISE NOTICE 'REPRODUCED: repeated private topic in one source transaction';
END $$;
ROLLBACK;
