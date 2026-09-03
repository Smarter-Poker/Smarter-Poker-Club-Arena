-- ═══════════════════════════════════════════════════════════════════════════
--  AVATAR COSMETICS — OWNERSHIP GUARD
--  2026-08-25
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS DOES
--   Refuses any write to `profiles.equipped_frame`, `profiles.equipped_aura`,
--   `user_avatars.equipped_frame` or `user_avatars.equipped_aura` that names a
--   cosmetic the player does not own, or a cosmetic that does not exist.
--
-- WHY IT IS IN THE DATABASE AND NOT IN THE PICKER
--   Both columns are directly writable by the player who owns the row:
--     profiles_update            USING/WITH CHECK (auth.uid() = id)
--     GRANT UPDATE(equipped_frame, equipped_aura) ... TO authenticated
--                                (20260822150000_profiles_restore_client_read_grants.sql)
--     "Users can update their own avatars" on user_avatars
--   so anyone with a browser console can equip `frame-hellfire` today. A picker
--   that greys out an unowned tile is a locked door in a building with no
--   walls. The rule has to sit where the write lands.
--
--   And a second reason the picker cannot be the guard: the World Hub writes
--   these same two columns from `AvatarContext.setAvatarCosmetics`. Two apps,
--   one rule. One place to put it.
--
-- WHAT COUNTS AS OWNED
--   1. The token is one of the six the two apps agree on. Anything else is
--      refused outright, so the column cannot accumulate junk that then renders
--      as `class="cosmetic-frame frame-<whatever>"` on some future surface.
--   2. profiles.is_vip is true. VIPBenefitsGrid.tsx has promised paying members
--      "Exclusive avatar frames & badges" since long before anything could draw
--      one; this is what makes that sentence true.
--   3. OR an `avatar_unlocks` row exists for the player whose avatar_id
--      normalises to the cosmetic's token (`frame_gold`, `aura_fire`, ...).
--      Same ledger the avatars use, namespaced so a cosmetic can never collide
--      with an avatar slug.
--
--   Clearing to NULL is ALWAYS allowed. A player must be able to take a
--   cosmetic off even after an entitlement lapses, and an ops cleanup must not
--   need a grant to unequip.
--
-- SERVICE ROLE IS NOT EXEMPT. Deliberately. An exemption would mean the guard
-- could never be tested against production, and every real writer (both apps'
-- clients) is `authenticated` anyway. Ops that genuinely needs to force a
-- cosmetic writes the `avatar_unlocks` row first, which is the audit trail we
-- would have wanted regardless.
--
-- TIER: 2 (new function + new triggers, no data rewritten, no column dropped).
-- Verified before writing: 0 rows in profiles or user_avatars hold a non-null
-- equipped_frame or equipped_aura, so this trigger cannot invalidate existing
-- data and no backfill is required.
--
-- ───────────────────────────────────────────────────────────────────────────
--  ROLLBACK
-- ───────────────────────────────────────────────────────────────────────────
--   DROP TRIGGER IF EXISTS trg_profiles_cosmetics_ownership ON public.profiles;
--   DROP TRIGGER IF EXISTS trg_user_avatars_cosmetics_ownership ON public.user_avatars;
--   DROP FUNCTION IF EXISTS public.sp_guard_avatar_cosmetics();
--   DROP FUNCTION IF EXISTS public.sp_cosmetic_is_owned(uuid, text, text);
--   DROP FUNCTION IF EXISTS public.sp_normalize_cosmetic_token(text);
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Token normalisation ────────────────────────────────────────────────
-- Mirrors normalizeCosmeticToken() in src/cosmetics/avatarCosmetics.ts and
-- normalizeUnlockToken() in src/services/AvatarService.ts. `frame-gold`,
-- `frame_gold` and `FRAME GOLD` are one identity, because three different
-- producers write this ledger and none of them agreed on a separator.
CREATE OR REPLACE FUNCTION public.sp_normalize_cosmetic_token(p_raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT regexp_replace(lower(btrim(coalesce(p_raw, ''))), '[[:space:]-]+', '_', 'g');
$$;

-- ── 2. Ownership ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sp_cosmetic_is_owned(
  p_user  uuid,
  p_token text,
  p_kind  text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_token    text := public.sp_normalize_cosmetic_token(p_token);
  v_is_vip   boolean;
  v_catalog  text[] := ARRAY[
    'frame_gold', 'frame_diamond', 'frame_cyber', 'frame_hellfire',
    'aura_fire',  'aura_glitch'
  ];
BEGIN
  -- Unequipping is always allowed.
  IF v_token = '' THEN
    RETURN true;
  END IF;

  -- Not a cosmetic this platform has ever defined.
  IF NOT (v_token = ANY (v_catalog)) THEN
    RETURN false;
  END IF;

  -- A frame may not be equipped into the aura column and vice versa. Without
  -- this the two columns are interchangeable and `equipped_aura = 'frame-gold'`
  -- would pass, then render as nothing and look like a broken purchase.
  IF p_kind IS NOT NULL AND v_token NOT LIKE (p_kind || '\_%') THEN
    RETURN false;
  END IF;

  IF p_user IS NULL THEN
    RETURN false;
  END IF;

  SELECT p.is_vip INTO v_is_vip FROM public.profiles p WHERE p.id = p_user;
  IF coalesce(v_is_vip, false) THEN
    RETURN true;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.avatar_unlocks au
    WHERE au.user_id = p_user
      AND public.sp_normalize_cosmetic_token(au.avatar_id) = v_token
  );
END;
$$;

-- ── 3. The trigger ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sp_guard_avatar_cosmetics()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_owner uuid;
BEGIN
  -- profiles keys on `id`; user_avatars keys on `user_id`.
  IF TG_TABLE_NAME = 'profiles' THEN
    v_owner := NEW.id;
  ELSE
    v_owner := NEW.user_id;
  END IF;

  -- Only inspect a value that is actually being set to something new. An
  -- UPDATE that touches an unrelated column must not be re-validated: a
  -- player whose VIP lapsed still gets to change their stack size.
  IF NEW.equipped_frame IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.equipped_frame ELSE NULL END)
     AND NEW.equipped_frame IS NOT NULL THEN
    IF NOT public.sp_cosmetic_is_owned(v_owner, NEW.equipped_frame, 'frame') THEN
      RAISE EXCEPTION
        'equipped_frame % is not owned by % (or is not a known frame)',
        NEW.equipped_frame, v_owner
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.equipped_aura IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.equipped_aura ELSE NULL END)
     AND NEW.equipped_aura IS NOT NULL THEN
    IF NOT public.sp_cosmetic_is_owned(v_owner, NEW.equipped_aura, 'aura') THEN
      RAISE EXCEPTION
        'equipped_aura % is not owned by % (or is not a known aura)',
        NEW.equipped_aura, v_owner
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_cosmetics_ownership ON public.profiles;
CREATE TRIGGER trg_profiles_cosmetics_ownership
  BEFORE INSERT OR UPDATE OF equipped_frame, equipped_aura ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.sp_guard_avatar_cosmetics();

DROP TRIGGER IF EXISTS trg_user_avatars_cosmetics_ownership ON public.user_avatars;
CREATE TRIGGER trg_user_avatars_cosmetics_ownership
  BEFORE INSERT OR UPDATE OF equipped_frame, equipped_aura ON public.user_avatars
  FOR EACH ROW
  EXECUTE FUNCTION public.sp_guard_avatar_cosmetics();

-- ── 4. Assertions — the migration aborts if its own premises are false ─────
DO $$
DECLARE
  v_dirty integer;
BEGIN
  IF to_regclass('public.avatar_unlocks') IS NULL THEN
    RAISE EXCEPTION 'avatar_unlocks is missing; the ownership ledger this guard reads does not exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'is_vip'
  ) THEN
    RAISE EXCEPTION 'profiles.is_vip is missing; the VIP entitlement branch would silently deny everyone';
  END IF;

  SELECT count(*) INTO v_dirty
  FROM public.profiles
  WHERE (equipped_frame IS NOT NULL AND NOT public.sp_cosmetic_is_owned(id, equipped_frame, 'frame'))
     OR (equipped_aura  IS NOT NULL AND NOT public.sp_cosmetic_is_owned(id, equipped_aura,  'aura'));
  IF v_dirty > 0 THEN
    RAISE EXCEPTION
      '% profiles rows already hold a cosmetic that this guard would refuse. Reconcile them before arming the trigger.',
      v_dirty;
  END IF;

  SELECT count(*) INTO v_dirty
  FROM public.user_avatars
  WHERE (equipped_frame IS NOT NULL AND NOT public.sp_cosmetic_is_owned(user_id, equipped_frame, 'frame'))
     OR (equipped_aura  IS NOT NULL AND NOT public.sp_cosmetic_is_owned(user_id, equipped_aura,  'aura'));
  IF v_dirty > 0 THEN
    RAISE EXCEPTION
      '% user_avatars rows already hold a cosmetic that this guard would refuse. Reconcile them before arming the trigger.',
      v_dirty;
  END IF;
END $$;

COMMENT ON FUNCTION public.sp_cosmetic_is_owned(uuid, text, text) IS
  'Avatar cosmetics ownership. Catalog mirrors src/cosmetics/avatarCosmetics.ts; keep the six tokens in sync with both apps.';
