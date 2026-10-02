-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420000634 "phase40_polish_owner_protection_error_wording"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 42efbbff867570c85381e2bd2fbadf20 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Phase 40 polish: the owner-protection trigger's error messages said "the
-- group creator". Post-ownership-transfer, the protected user is the CURRENT
-- owner, not the original creator. Tighten wording to "current owner" and
-- route users toward transfer_home_group_ownership.
CREATE OR REPLACE FUNCTION public.protect_home_group_owner_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_owner_id uuid;
  v_row      commander_home_members%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row := OLD;
  ELSE
    v_row := NEW;
  END IF;

  SELECT owner_id INTO v_owner_id
  FROM commander_home_groups WHERE id = v_row.group_id;

  IF v_owner_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF v_row.user_id IS DISTINCT FROM v_owner_id THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Cannot remove the current owner from their home group. '
      'Transfer ownership first (transfer_home_group_ownership RPC).'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.role IS DISTINCT FROM OLD.role THEN
    IF NEW.role <> 'owner' THEN
      RAISE EXCEPTION 'Cannot change role of the current group owner. '
        'Transfer ownership first (transfer_home_group_ownership RPC).'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status <> 'approved' THEN
      RAISE EXCEPTION 'Cannot change status of the current group owner to %. '
        'The owner is always an approved member.', NEW.status
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
