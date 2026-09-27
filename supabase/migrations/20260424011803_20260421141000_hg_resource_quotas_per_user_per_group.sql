-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424011803 "20260421141000_hg_resource_quotas_per_user_per_group"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 1a490103f36f51f3ca0262446fb030db of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Commercial-grade per-user / per-group quotas. Prevents slow-drip
-- accumulation abuse that rate limiting alone can't stop (rate limits
-- only throttle rate, not lifetime count).
--
--   commander_home_groups        → 20 active per owner_id
--   commander_home_invite_tokens → 50 active unexpired per group_id
--   commander_home_games         → 100 future-scheduled per group_id
--
-- Service-role writes and admin-on-behalf writes bypass. Caps are
-- generous vs. normal usage but block 10k-group spam.

CREATE OR REPLACE FUNCTION public.fn_hg_enforce_quotas_on_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE v_uid uuid; v_count int;
BEGIN
  -- Bypass service_role / no-auth contexts
  v_uid := auth.uid();
  BEGIN
    IF v_uid IS NULL OR auth.role() = 'service_role' THEN RETURN NEW; END IF;
  EXCEPTION WHEN OTHERS THEN RETURN NEW;
  END;

  IF TG_TABLE_NAME = 'commander_home_groups' THEN
    -- Only enforce when caller is actually creating for themselves
    IF NEW.owner_id = v_uid THEN
      SELECT COUNT(*) INTO v_count FROM public.commander_home_groups
       WHERE owner_id = v_uid AND is_active = true;
      IF v_count >= 20 THEN
        RAISE EXCEPTION 'GROUP_QUOTA_EXCEEDED'
              USING HINT = 'max 20 active groups per user';
      END IF;
    END IF;

  ELSIF TG_TABLE_NAME = 'commander_home_invite_tokens' THEN
    IF NEW.created_by = v_uid THEN
      SELECT COUNT(*) INTO v_count FROM public.commander_home_invite_tokens
       WHERE group_id = NEW.group_id
         AND is_active = true
         AND (expires_at IS NULL OR expires_at > NOW());
      IF v_count >= 50 THEN
        RAISE EXCEPTION 'TOKEN_QUOTA_EXCEEDED'
              USING HINT = 'max 50 active unexpired tokens per group';
      END IF;
    END IF;

  ELSIF TG_TABLE_NAME = 'commander_home_games' THEN
    IF NEW.host_id = v_uid THEN
      SELECT COUNT(*) INTO v_count FROM public.commander_home_games
       WHERE group_id = NEW.group_id
         AND status = 'scheduled'
         AND scheduled_date >= CURRENT_DATE;
      IF v_count >= 100 THEN
        RAISE EXCEPTION 'SCHEDULED_GAMES_QUOTA_EXCEEDED'
              USING HINT = 'max 100 future-scheduled games per group';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;

-- Register trigger on the 3 target tables
DO $do$
DECLARE v_tbl text; v_tables text[] := ARRAY[
  'commander_home_groups',
  'commander_home_invite_tokens',
  'commander_home_games'
];
BEGIN
  FOREACH v_tbl IN ARRAY v_tables LOOP
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                WHERE n.nspname='public' AND c.relname=v_tbl) THEN
      EXECUTE format(
        'DROP TRIGGER IF EXISTS trg_hg_enforce_quotas ON public.%I;
         CREATE TRIGGER trg_hg_enforce_quotas
           BEFORE INSERT ON public.%I
           FOR EACH ROW EXECUTE FUNCTION public.fn_hg_enforce_quotas_on_write();',
        v_tbl, v_tbl);
    END IF;
  END LOOP;
END $do$;
