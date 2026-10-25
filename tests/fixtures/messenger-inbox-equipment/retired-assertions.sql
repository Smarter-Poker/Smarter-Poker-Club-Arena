SET test.actor='10000000-0000-4000-8000-000000000001';
DO $$ DECLARE ids uuid[];
BEGIN
 IF EXISTS(SELECT 1 FROM fn_get_user_conversations('10000000-0000-4000-8000-000000000001',NULL) i
           JOIN auth.users u ON u.id=i.other_user_id WHERE NOT i.is_group AND u.deleted_at IS NOT NULL) THEN
  RAISE EXCEPTION 'Retired counterpart remains visible';
 END IF;
 SELECT array_agg(conversation_id) INTO ids
 FROM fn_get_user_conversations('10000000-0000-4000-8000-000000000001',NULL) WHERE NOT is_group;
 IF ids<>ARRAY['20000000-0000-4000-8000-000000000012'::uuid,'20000000-0000-4000-8000-000000000003'::uuid,'20000000-0000-4000-8000-000000000002'::uuid] THEN
  RAISE EXCEPTION 'Active conversations or unread ordering changed: %',ids;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM fn_get_user_conversations('10000000-0000-4000-8000-000000000001',NULL)
               WHERE other_user_username='PostDeployActiveReal') THEN
  RAISE EXCEPTION 'A genuine active name was filtered by its spelling';
 END IF;
 IF (SELECT count(*) FROM fn_get_user_conversations('10000000-0000-4000-8000-000000000001',NULL) WHERE is_group)<>1 THEN
  RAISE EXCEPTION 'A group was hidden because one member retired';
 END IF;
 BEGIN
  PERFORM * FROM fn_get_user_conversations('10000000-0000-4000-8000-000000000002',NULL);
  RAISE EXCEPTION 'Forged actor accepted';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM NOT LIKE '%not authorized%' THEN RAISE; END IF;
 END;
END $$;
