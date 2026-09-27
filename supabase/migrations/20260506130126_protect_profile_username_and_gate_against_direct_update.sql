-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260506130126 "protect_profile_username_and_gate_against_direct_update"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 808bbb8e8762466731a2219f2d12dd93 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- ADVERSARIAL HOLE PATCH — Pass 3 finding
-- ─────────────────────────────────────────────────────────────────────────
-- Without this trigger, a malicious authenticated user can call:
--   supabase.from('profiles').update({
--     social_profile_completed: true,
--     username: 'admin'
--   }).eq('id', myId)
-- ...directly from the browser console. RLS allows it (qual auth.uid()=id,
-- no with_check). This bypasses claim_social_profile entirely:
--   • Skips the gate (no name/phone needed)
--   • Skips reserved-word block (grabs @admin/@smarterpoker/etc.)
--   • Skips username format regex
--
-- Fix: BEFORE UPDATE trigger that validates ON THE USER'S PATH ONLY. Trusted
-- callers (postgres SECURITY DEFINER functions, service_role server APIs,
-- supabase_admin) bypass — they've already done their own validation.
--
-- Trigger function MUST be SECURITY INVOKER (not DEFINER) so current_user
-- reflects the actual caller — per the architectural lesson Dan documented
-- in Phase 40. A DEFINER trigger would always see itself as 'postgres' and
-- bypass for everyone, which is exactly the bug we're fixing.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_protect_profile_username_and_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  -- Trusted callers bypass entirely. They reach this trigger via:
  --   • postgres            → SECURITY DEFINER funcs (claim_social_profile, handle_new_user)
  --   • service_role        → server APIs using SUPABASE_SERVICE_ROLE_KEY
  --   • supabase_admin      → migrations + admin tooling
  --   • supabase_auth_admin → Supabase Auth internal updates
  IF current_user IN ('postgres','service_role','supabase_admin','supabase_auth_admin') THEN
    RETURN NEW;
  END IF;

  -- ── Username validation: only fires when username actually changed ──
  -- Validates the lowercase form so case-mixed inputs (KingFish → kingfish)
  -- are checked properly. Reserved-word check uses central is_reserved_username.
  IF NEW.username IS DISTINCT FROM OLD.username THEN
    IF NEW.username IS NOT NULL AND btrim(NEW.username) <> '' THEN
      IF lower(NEW.username) !~ '^[a-z0-9][a-z0-9_.]{2,19}$' THEN
        RAISE EXCEPTION 'Username must be 3–20 characters using letters, numbers, underscores, or periods (no spaces or special characters).'
          USING ERRCODE = '22023';
      END IF;
      IF public.is_reserved_username(NEW.username) THEN
        RAISE EXCEPTION 'That username is reserved. Pick a different one.'
          USING ERRCODE = '22023';
      END IF;
    END IF;
  END IF;

  -- ── Gate transition guard: false→true requires name + username + valid phone ──
  -- Prevents flipping social_profile_completed=true via a direct UPDATE that
  -- skips the modal. Other transitions (true→false, true→true, false→false)
  -- are allowed.
  IF NEW.social_profile_completed = true 
     AND coalesce(OLD.social_profile_completed, false) = false THEN
    IF coalesce(btrim(NEW.full_name), '') = '' THEN
      RAISE EXCEPTION 'Cannot mark profile complete without a full name.'
        USING ERRCODE = '22023';
    END IF;
    IF coalesce(btrim(NEW.username), '') = '' THEN
      RAISE EXCEPTION 'Cannot mark profile complete without a username.'
        USING ERRCODE = '22023';
    END IF;
    IF length(regexp_replace(coalesce(NEW.phone, ''), '[^0-9]', '', 'g')) NOT BETWEEN 7 AND 15 THEN
      RAISE EXCEPTION 'Cannot mark profile complete without a valid phone number (7–15 digits).'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_profile_username_and_gate ON public.profiles;
CREATE TRIGGER trg_protect_profile_username_and_gate
BEFORE UPDATE ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.fn_protect_profile_username_and_gate();

COMMENT ON FUNCTION public.fn_protect_profile_username_and_gate() IS
  'Closes a gate-bypass hole: without this, an authenticated user could call PostgREST UPDATE directly to set social_profile_completed=true with a reserved or malformed username, skipping claim_social_profile validation. SECURITY INVOKER (NOT DEFINER) so current_user correctly identifies the caller.';
