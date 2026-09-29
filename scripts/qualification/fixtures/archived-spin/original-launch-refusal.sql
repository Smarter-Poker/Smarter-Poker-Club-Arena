BEGIN;
DO $$ DECLARE result jsonb;
BEGIN
 result:=public.fn_prove_played_launch_recovery('2aa4cba1-506f-426b-a1ba-d8e22e018533','2026-09-08T14:48:56.020255+00:00');
 IF result IS DISTINCT FROM '{"ok":false,"reason":"no_hand_was_dealt"}'::jsonb THEN
  RAISE EXCEPTION 'ORIGINAL_ARCHIVED_LAUNCH_REFUSAL_CHANGED: %',result; END IF;
END $$;
SELECT jsonb_build_object('stage','original_launch_refusal','reason','no_hand_was_dealt','history_restored',false,'financial_qualified',false);
ROLLBACK;
