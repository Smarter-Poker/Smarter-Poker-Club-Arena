-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902040849; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- WHY: 1,259,900 non-cert diamonds left profiles.diamonds between 00:10 and
-- 01:10 on 2026-09-02 with zero diamond_transactions rows, and I could not
-- name the writer. Not because the evidence was ambiguous - because there was
-- none. profiles.diamonds had no audit trail of any kind, no updated_at
-- trigger, and seven RPCs that move it without journalling.
--
-- Ruled out on evidence, so the next agent does not re-walk it:
--   * mass profile deletion - 1,308 profiles against 1,311 auth users; a
--     deletion of the ~500 accounts needed would have left ~500 auth rows
--     without a profile, and there are 3;
--   * cert re-tagging - cert_diamonds held at exactly 234,480 across the
--     boundary, and the snapshot's basis-change guard did not fire;
--   * a scheduled job - nothing in cron ran in the window except the
--     snapshot itself and unrelated pruners;
--   * a diamond_balance-only write - the two columns are in exact agreement
--     (1,029,977 each), so whatever moved one moved both in lockstep.
--
-- This migration does not guess. It makes the next one attributable and stops
-- the seven known writers from moving diamonds silently.
--
-- Same shape as ca_seat_stack_exits for chips (CLAUDE.md 11.5): the trigger
-- NEVER blocks. A guard that can refuse a diamond write can strand a player
-- mid-purchase, and this is an evidence problem, not an authorization one.

BEGIN;

CREATE TABLE IF NOT EXISTS public.ca_diamond_balance_audit (
  id           bigserial PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  user_id      uuid NOT NULL,
  old_diamonds integer,
  new_diamonds integer,
  delta        integer,
  is_cert      boolean,
  db_role      text,
  app_name     text,
  journaled    boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS ca_diamond_balance_audit_at_idx
  ON public.ca_diamond_balance_audit (occurred_at DESC);
CREATE INDEX IF NOT EXISTS ca_diamond_balance_audit_user_idx
  ON public.ca_diamond_balance_audit (user_id, occurred_at DESC);

ALTER TABLE public.ca_diamond_balance_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_diamond_balance_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.ca_diamond_balance_audit TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.ca_diamond_balance_audit_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_audit_diamond_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  BEGIN
    INSERT INTO public.ca_diamond_balance_audit
      (user_id, old_diamonds, new_diamonds, delta, is_cert, db_role, app_name)
    VALUES
      (NEW.id, OLD.diamonds, NEW.diamonds,
       COALESCE(NEW.diamonds,0) - COALESCE(OLD.diamonds,0),
       public.fn_ca_is_cert_account(NEW.id),
       current_user,
       COALESCE(current_setting('application_name', true), ''));
  EXCEPTION WHEN OTHERS THEN
    -- Never block a diamond write to record one. But never swallow it in
    -- silence either: that is how the overlay moved unjournalled earlier
    -- tonight.
    BEGIN
      INSERT INTO public.ca_ledger_write_failures (user_id, delta, sqlstate, message)
      VALUES (NEW.id, COALESCE(NEW.diamonds,0) - COALESCE(OLD.diamonds,0),
              SQLSTATE, 'diamond audit insert failed: ' || SQLERRM);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS zz_ca_audit_diamond_change ON public.profiles;
CREATE TRIGGER zz_ca_audit_diamond_change
  AFTER UPDATE OF diamonds ON public.profiles
  FOR EACH ROW
  WHEN (NEW.diamonds IS DISTINCT FROM OLD.diamonds)
  EXECUTE FUNCTION public.fn_ca_audit_diamond_change();

COMMIT;

