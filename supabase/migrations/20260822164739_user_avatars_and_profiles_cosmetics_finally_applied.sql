-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260822164739 "user_avatars_and_profiles_cosmetics_finally_applied"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e1052cde27c0e7e6b0ec8957b84edc46 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Two migrations sat in supabase/migrations/ since 2026-08-21 and were never
-- applied: 20260821210000_user_avatars_cosmetics.sql and
-- 20260821210001_profiles_cosmetics.sql. The avatar frames-and-auras feature
-- is fully built around them - AvatarGallery renders frame/aura, avatar-service
-- maps them, AvatarContext.setAvatarCosmetics writes them - and every write has
-- been failing with 42703 into a catch block since it shipped. CHECK 13
-- (phantom columns) is what finally said so out loud.
--
-- Applied here as one migration so the column and its consumer land together.

DO $add$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name='user_avatars' AND column_name='equipped_frame') THEN
        ALTER TABLE public.user_avatars ADD COLUMN equipped_frame text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name='user_avatars' AND column_name='equipped_aura') THEN
        ALTER TABLE public.user_avatars ADD COLUMN equipped_aura text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name='profiles' AND column_name='equipped_frame') THEN
        ALTER TABLE public.profiles ADD COLUMN equipped_frame text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name='profiles' AND column_name='equipped_aura') THEN
        ALTER TABLE public.profiles ADD COLUMN equipped_aura text;
    END IF;
END
$add$;

COMMENT ON COLUMN public.user_avatars.equipped_frame IS 'CSS key for the cosmetic frame overlay (e.g. frame-diamond, frame-cyber)';
COMMENT ON COLUMN public.user_avatars.equipped_aura  IS 'CSS key for the cosmetic particle aura (e.g. aura-fire, aura-glitch)';
COMMENT ON COLUMN public.profiles.equipped_frame     IS 'Denormalised from user_avatars so the game engine can read cosmetics without a join';
COMMENT ON COLUMN public.profiles.equipped_aura      IS 'Denormalised from user_avatars so the game engine can read cosmetics without a join';

DO $postcheck$
DECLARE v_missing text;
BEGIN
    SELECT string_agg(x.t || '.' || x.c, ', ')
      INTO v_missing
      FROM (VALUES ('user_avatars','equipped_frame'),('user_avatars','equipped_aura'),
                   ('profiles','equipped_frame'),('profiles','equipped_aura')) AS x(t,c)
     WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema='public' AND table_name=x.t AND column_name=x.c);
    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'post-apply failed: still missing %', v_missing;
    END IF;

    -- The whole point is that a client can WRITE these. profiles has a trigger
    -- guarding privileged columns; cosmetics are not privileged, so assert the
    -- authenticated role can update them rather than discovering otherwise in
    -- a catch block for another three weeks.
    IF NOT has_column_privilege('authenticated', 'public.user_avatars', 'equipped_frame', 'UPDATE') THEN
        RAISE EXCEPTION 'post-apply failed: authenticated cannot UPDATE user_avatars.equipped_frame';
    END IF;
END
$postcheck$;

NOTIFY pgrst, 'reload schema';
