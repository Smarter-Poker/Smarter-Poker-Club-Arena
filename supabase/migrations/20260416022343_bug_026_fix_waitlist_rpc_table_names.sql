-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260416022343 "bug_026_fix_waitlist_rpc_table_names"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 c47d5104677f7d83132bb9087df43193 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG 026: join_waitlist + get_waitlist_position RPCs reference a non-existent
-- `waitlist` table. The real table is `table_waitlist`. Also column name
-- mismatch: RPCs use `joined_at` but real column is `created_at`.

DROP FUNCTION IF EXISTS public.join_waitlist(uuid, uuid);
CREATE OR REPLACE FUNCTION public.join_waitlist(
  p_table_id uuid,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_existing uuid;
  v_pos integer;
  v_new_id uuid;
BEGIN
  -- Idempotent: check for active entry
  SELECT id INTO v_existing FROM table_waitlist
  WHERE table_id = p_table_id AND user_id = p_user_id
    AND status IN ('waiting', 'notified');
  IF v_existing IS NOT NULL THEN
    SELECT COALESCE(position, 0) INTO v_pos FROM table_waitlist WHERE id = v_existing;
    RETURN jsonb_build_object('success', true, 'already_on_waitlist', true, 'position', v_pos);
  END IF;

  -- Calculate next position
  SELECT COALESCE(MAX(position), 0) + 1 INTO v_pos
  FROM table_waitlist
  WHERE table_id = p_table_id AND status IN ('waiting', 'notified');

  INSERT INTO table_waitlist (id, table_id, user_id, position, status, created_at)
  VALUES (gen_random_uuid(), p_table_id, p_user_id, v_pos, 'waiting', NOW())
  RETURNING id INTO v_new_id;

  RETURN jsonb_build_object('success', true, 'position', v_pos, 'entry_id', v_new_id);
END;
$function$;
GRANT EXECUTE ON FUNCTION public.join_waitlist(uuid, uuid) TO authenticated, service_role;


DROP FUNCTION IF EXISTS public.get_waitlist_position(uuid, uuid);
CREATE OR REPLACE FUNCTION public.get_waitlist_position(
  p_table_id uuid,
  p_user_id uuid
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_pos integer;
BEGIN
  SELECT position INTO v_pos
  FROM table_waitlist
  WHERE table_id = p_table_id AND user_id = p_user_id
    AND status IN ('waiting', 'notified')
  LIMIT 1;
  RETURN COALESCE(v_pos, 0);
END;
$function$;
GRANT EXECUTE ON FUNCTION public.get_waitlist_position(uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.join_waitlist IS 'BUG 026: fixed table name from non-existent `waitlist` to real `table_waitlist`. Now idempotent, assigns position, returns jsonb.';
COMMENT ON FUNCTION public.get_waitlist_position IS 'BUG 026: fixed table name from non-existent `waitlist` to real `table_waitlist`.';

