SET test.actor='10000000-0000-4000-8000-000000000001';
DO $$ DECLARE ids uuid[]; names text[]; BEGIN
 SELECT array_agg(conversation_id),array_agg(other_user_username) INTO ids,names FROM fn_get_user_conversations('10000000-0000-4000-8000-000000000001',null);
 IF ids<>ARRAY['20000000-0000-4000-8000-000000000003'::uuid,'20000000-0000-4000-8000-000000000002'::uuid] THEN RAISE EXCEPTION 'Unread first and certification isolation failed: %',ids; END IF;
 IF names<>ARRAY['PostDeployChosenByRealPlayer','Actual Player'] THEN RAISE EXCEPTION 'Real names changed: %',names; END IF;
 BEGIN
 PERFORM * FROM fn_get_user_conversations('10000000-0000-4000-8000-000000000002',null);
 RAISE EXCEPTION 'forged actor accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE '%not authorized%' THEN RAISE; END IF; END;
END $$;
SET test.actor='10000000-0000-4000-8000-000000000002';
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM fn_get_user_conversations('10000000-0000-4000-8000-000000000002',null)) THEN RAISE EXCEPTION 'certification lost its real inbox'; END IF; END $$;

