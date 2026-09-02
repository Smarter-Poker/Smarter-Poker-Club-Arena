-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827163553; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Dan 2026-08-27 ruled that every customizable feature gets three free
-- options. Frames and auras had ZERO — all six were VIP — so rather than
-- demote paid cosmetics, three new free frames and three new free auras were
-- authored (avatarCosmetics.ts + AvatarCosmetics.css + the World Hub's
-- AvatarGallery.jsx, which must stay byte-identical).
--
-- THIS GUARD WOULD HAVE REFUSED THEM. sp_cosmetic_is_owned holds its own
-- hardcoded catalog and answers `false` for any token not in it, so the six
-- new FREE cosmetics would have been offered by the picker and rejected by
-- the trigger — a free tile that silently never applies. Caught by
-- tests/unit/avatarCosmetics.test.ts ("matches the database guard catalog
-- exactly"), which exists precisely for this.
--
-- The catalog gains the six, and a free tier that needs no ledger row and no
-- VIP: free means free for everyone, including a signed-out-then-back-in
-- account with no unlock history at all.
CREATE OR REPLACE FUNCTION public.sp_cosmetic_is_owned(p_user uuid, p_token text, p_kind text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_token    text := public.sp_normalize_cosmetic_token(p_token);
  v_is_vip   boolean;
  v_free     text[] := ARRAY[
    'frame_slate', 'frame_ivory', 'frame_copper',
    'aura_mist',   'aura_dusk',   'aura_moss'
  ];
  v_catalog  text[] := ARRAY[
    'frame_gold', 'frame_diamond', 'frame_cyber', 'frame_hellfire',
    'aura_fire',  'aura_glitch',
    'frame_slate', 'frame_ivory', 'frame_copper',
    'aura_mist',   'aura_dusk',   'aura_moss'
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

  -- FREE TIER: no user, no VIP, no ledger row required.
  IF v_token = ANY (v_free) THEN
    RETURN true;
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
$function$;

DO $$
BEGIN
  IF NOT public.sp_cosmetic_is_owned(NULL, 'frame-slate', 'frame') THEN
    RAISE EXCEPTION 'free frame refused by the guard';
  END IF;
  IF NOT public.sp_cosmetic_is_owned(NULL, 'aura_moss', 'aura') THEN
    RAISE EXCEPTION 'free aura refused by the guard';
  END IF;
  IF public.sp_cosmetic_is_owned(NULL, 'frame_gold', 'frame') THEN
    RAISE EXCEPTION 'VIP frame granted to a null user - the paid tier leaked';
  END IF;
  IF public.sp_cosmetic_is_owned(NULL, 'frame_invented', 'frame') THEN
    RAISE EXCEPTION 'unknown token accepted - the catalog stopped failing closed';
  END IF;
END $$;
