-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260829234000; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════
-- 20260829234000_training_study_group_atomic_writes.sql
-- ═══════════════════════════════════════════════════════════════════════
-- TIER:        2
-- AUTHOR:      Codex
-- AFFECTS:     training study group grants; create/join RPCs
-- IRREVERSIBLE: no
--
-- WHY:
--   Group creation previously required two independent writes and joining
--   checked capacity before inserting, allowing partial owner records and
--   concurrent joins above the configured limit. Direct authenticated table
--   grants also allowed clients to bypass the API capacity check.
--
-- HOW (high level):
--   - Performs group+owner creation and capacity-checked joins atomically.
--   - Locks the group row while joining and exposes both RPCs only to the
--     service role used by the authenticated API handlers.
--   - Removes direct authenticated write privileges from the three tables.
-- ═══════════════════════════════════════════════════════════════════════

BEGIN
DO $$
BEGIN
  IF to_regclass('public.training_study_groups') IS NULL
    OR to_regclass('public.training_study_group_members') IS NULL
    OR to_regclass('public.training_study_group_messages') IS NULL
  THEN
    RAISE EXCEPTION 'pre-flight failed: training study group tables not found';
  END IF;
END $$
CREATE OR REPLACE FUNCTION public.create_training_study_group(
  p_owner_id uuid,
  p_name text,
  p_format text,
  p_stakes text,
  p_timezone text,
  p_focus text,
  p_schedule text,
  p_level text,
  p_max_members integer
)
RETURNS public.training_study_groups
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $$
DECLARE
  v_group public.training_study_groups;
BEGIN
  INSERT INTO public.training_study_groups (
    owner_id, name, format, stakes, timezone, focus, schedule, level, max_members
  ) VALUES (
    p_owner_id, p_name, p_format, p_stakes, p_timezone, p_focus, p_schedule, p_level, p_max_members
  )
  RETURNING * INTO v_group;

  INSERT INTO public.training_study_group_members (group_id, user_id, role)
  VALUES (v_group.id, p_owner_id, 'owner');

  RETURN v_group;
END;
$$
CREATE OR REPLACE FUNCTION public.join_training_study_group(
  p_group_id uuid,
  p_user_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $$
DECLARE
  v_owner_id uuid;
  v_max_members integer;
  v_member_count integer;
BEGIN
  SELECT owner_id, max_members
  INTO v_owner_id, v_max_members
  FROM public.training_study_groups
  WHERE id = p_group_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.training_study_group_members
    WHERE group_id = p_group_id AND user_id = p_user_id
  ) THEN
    RETURN 'joined';
  END IF;

  SELECT count(*)::integer
  INTO v_member_count
  FROM public.training_study_group_members
  WHERE group_id = p_group_id;

  IF v_member_count >= v_max_members THEN
    RETURN 'full';
  END IF;

  INSERT INTO public.training_study_group_members (group_id, user_id, role)
  VALUES (
    p_group_id,
    p_user_id,
    CASE WHEN p_user_id = v_owner_id THEN 'owner' ELSE 'member' END
  );

  RETURN 'joined';
END;
$$
REVOKE ALL ON FUNCTION public.create_training_study_group(
  uuid, text, text, text, text, text, text, text, integer
) FROM PUBLIC, anon, authenticated
REVOKE ALL ON FUNCTION public.join_training_study_group(uuid, uuid)
  FROM PUBLIC, anon, authenticated
GRANT EXECUTE ON FUNCTION public.create_training_study_group(
  uuid, text, text, text, text, text, text, text, integer
) TO service_role
GRANT EXECUTE ON FUNCTION public.join_training_study_group(uuid, uuid)
  TO service_role
REVOKE INSERT, UPDATE, DELETE ON public.training_study_groups FROM authenticated
REVOKE INSERT, UPDATE, DELETE ON public.training_study_group_members FROM authenticated
REVOKE INSERT, UPDATE, DELETE ON public.training_study_group_messages FROM authenticated
DO $$
BEGIN
  IF to_regprocedure(
    'public.create_training_study_group(uuid,text,text,text,text,text,text,text,integer)'
  ) IS NULL THEN
    RAISE EXCEPTION 'post-apply failed: create_training_study_group not found';
  END IF;
  IF to_regprocedure('public.join_training_study_group(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'post-apply failed: join_training_study_group not found';
  END IF;
  IF has_function_privilege(
    'authenticated',
    'public.join_training_study_group(uuid,uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'post-apply failed: authenticated can execute server-only join RPC';
  END IF;
  IF NOT has_function_privilege(
    'service_role',
    'public.join_training_study_group(uuid,uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'post-apply failed: service_role cannot execute join RPC';
  END IF;
  IF has_table_privilege(
    'authenticated',
    'public.training_study_group_members',
    'INSERT'
  ) THEN
    RAISE EXCEPTION 'post-apply failed: direct authenticated member inserts remain enabled';
  END IF;
END $$
NOTIFY pgrst, 'reload schema'
COMMIT
