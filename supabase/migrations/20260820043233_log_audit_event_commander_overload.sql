-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260820043233 as "log_audit_event_commander_overload"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
-- ============================================================================
-- log_audit_event: commander overload (2026-08-20)
-- ----------------------------------------------------------------------------
-- WHY: the shared commander audit helper (vendor/commander-shared
-- lib/commander/audit.js logAudit) calls
--   rpc('log_audit_event', { p_venue_id, p_user_id, p_staff_id, p_actor_type,
--     p_action, p_action_category, p_target_type, p_target_id, p_changes,
--     p_metadata })
-- but the only deployed log_audit_event had the signature
--   (p_user_id uuid, p_action text, p_details jsonb, p_ip_address text)
-- so EVERY commander audit write (21 API routes: pin verify, waitlist,
-- games, tables, venue switches, ...) has silently no-opped since the
-- helper shipped. The target table commander_audit_logs already exists
-- with exactly the columns the helper expects.
--
-- WHAT: add the 10-argument overload the helper actually calls, inserting
-- into commander_audit_logs. The existing 4-argument overload is left
-- untouched (other callers use it). PostgREST disambiguates overloads by
-- the named-argument set, and the two sets differ (p_details/p_ip_address
-- vs p_venue_id/p_metadata/...), so no ambiguity is introduced.
--
-- SAFETY: additive only - no DROP, no ALTER, no data change.
-- ============================================================================

-- Pre-flight: the target table must exist with the expected columns
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'commander_audit_logs'
      AND column_name = 'action_category'
  ) THEN
    RAISE EXCEPTION 'commander_audit_logs.action_category missing - table shape changed, aborting';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.log_audit_event(
  p_venue_id        integer,
  p_user_id         uuid,
  p_staff_id        uuid,
  p_actor_type      text,
  p_action          text,
  p_action_category text,
  p_target_type     text,
  p_target_id       text,
  p_changes         jsonb,
  p_metadata        jsonb
) RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid;
  v_ip inet;
BEGIN
  -- ip arrives inside metadata (helper packs it there); tolerate garbage
  BEGIN
    v_ip := NULLIF(p_metadata->>'ip_address', '')::inet;
  EXCEPTION WHEN OTHERS THEN
    v_ip := NULL;
  END;

  INSERT INTO public.commander_audit_logs (
    venue_id, user_id, staff_id, actor_type, action, action_category,
    target_type, target_id, changes, metadata,
    ip_address, user_agent, request_id, status, created_at
  ) VALUES (
    p_venue_id, p_user_id, p_staff_id, COALESCE(p_actor_type, 'user'),
    p_action, COALESCE(p_action_category, 'general'),
    p_target_type, p_target_id, p_changes,
    (COALESCE(p_metadata, '{}'::jsonb)) - 'ip_address' - 'user_agent' - 'request_id',
    v_ip,
    p_metadata->>'user_agent',
    p_metadata->>'request_id',
    'success',
    now()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- Post-apply assertion: both overloads must now exist
DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'log_audit_event';
  IF v_count < 2 THEN
    RAISE EXCEPTION 'expected 2 log_audit_event overloads, found %', v_count;
  END IF;
END $$;
