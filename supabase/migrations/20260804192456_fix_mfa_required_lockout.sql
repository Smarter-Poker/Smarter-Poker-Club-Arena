-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260804192456 "fix_mfa_required_lockout"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 cf2c645f4f0671f12bbda7229af9806c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- FIX: 525 users locked out of login by mfa_required=true with NO enrolled factor
-- ─────────────────────────────────────────────────────────────────────────────
-- fn_sync_mfa_required_on_role_change force-set mfa_required=TRUE on any
-- profile UPDATE where role='admin' OR is_vip=TRUE. The login client redirects
-- mfa_required users to /auth/mfa, but zero users platform-wide have an
-- enrolled TOTP factor (user_mfa_factors), so the challenge is unpassable:
-- login succeeds at Supabase, then dead-ends. Silent lockout.
--
-- 1. Trigger fn now only enforces the challenge flag when the user actually
--    has an enabled factor (challenge-enforcement, not enrollment-enforcement).
-- 2. Data fix: clear mfa_required for every user with no enabled factor.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_sync_mfa_required_on_role_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF (NEW.role = 'admin' OR NEW.is_vip = TRUE) AND NOT NEW.mfa_required THEN
        -- Only force the login challenge if the user can actually pass it.
        IF EXISTS (
            SELECT 1 FROM public.user_mfa_factors
            WHERE user_id = NEW.id AND enabled = TRUE
        ) THEN
            NEW.mfa_required := TRUE;
        END IF;
    END IF;
    RETURN NEW;
END;
$function$;

-- Unlock every account flagged mfa_required that has no enabled factor.
UPDATE public.profiles p
SET mfa_required = FALSE
WHERE p.mfa_required = TRUE
  AND NOT EXISTS (
      SELECT 1 FROM public.user_mfa_factors f
      WHERE f.user_id = p.id AND f.enabled = TRUE
  );
