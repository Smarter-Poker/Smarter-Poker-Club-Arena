-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825230055; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.sp_normalize_cosmetic_token(p_raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT regexp_replace(lower(btrim(coalesce(p_raw, ''))), '[[:space:]-]+', '_', 'g');
$$;

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
  IF v_token = '' THEN
    RETURN true;
  END IF;

  IF NOT (v_token = ANY (v_catalog)) THEN
    RETURN false;
  END IF;

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

CREATE OR REPLACE FUNCTION public.sp_guard_avatar_cosmetics()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_owner uuid;
BEGIN
  IF TG_TABLE_NAME = 'profiles' THEN
    v_owner := NEW.id;
  ELSE
    v_owner := NEW.user_id;
  END IF;

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
