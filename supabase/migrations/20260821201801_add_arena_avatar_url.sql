-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821201801 "add_arena_avatar_url"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ee799dafcd546ff59f889993e83e7c4b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
--  profiles.arena_avatar_url — the Club Arena avatar, separate from the photo
--
--  Dan 2026-08-21: "you assign an avatar to every horse, and they use that in
--  the club arena, and their photo for the social media page."
--
--  THE WHOLE PROBLEM WAS ONE COLUMN DOING TWO JOBS.
--  profiles.avatar_url is read by BOTH surfaces, so every attempt to give the
--  Arena an avatar also changed somebody's social media picture - which is
--  exactly the mistake made earlier today and then rolled back.
--
--  Two jobs, two columns:
--    profiles.avatar_url        SOCIAL MEDIA photo. Untouched by this migration
--                               and by anything Arena-side, ever.
--    profiles.arena_avatar_url  CLUB ARENA avatar. Library art only.
--
--  Nothing is destroyed here and nothing is reassigned: this only ADDS a column
--  and fills it. The photo column is not written by this migration at all.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS arena_avatar_url text;

COMMENT ON COLUMN public.profiles.arena_avatar_url IS
  'Club Arena avatar - library art only, never a photograph. Separate from '
  'avatar_url, which is the social media profile picture. Club Arena reads '
  'this column; the social media surfaces read avatar_url. Added 2026-08-21.';

-- ─── Assign one to every horse, and to every player ─────────────────────────
-- md5(id)-seeded so it is random-looking but STABLE: re-running cannot reshuffle
-- anybody, and a horse keeps the same face across restarts.
--
-- A player who has already chosen library art keeps that exact choice. Only
-- accounts with nothing usable get a pick.
--
-- Horses draw from the full 98-piece set (free + VIP). Players draw from the
-- 24 free pieces, because VIP art on a non-VIP human reads as a granted paid
-- asset - a horse has nothing to grant to, and 24 faces across 584 horses would
-- seat the same one twice at most 9-max tables.

CREATE OR REPLACE FUNCTION public.fn_arena_avatar_pick(p_id uuid, p_vip boolean)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  WITH pool AS (
    SELECT unnest(
      CASE WHEN p_vip THEN ARRAY[
        'free_android','free_aztec','free_business','free_chef','free_cowboy',
        'free_cyborg','free_detective','free_fox','free_geisha','free_knight',
        'free_lion','free_musician','free_ninja','free_owl','free_penguin',
        'free_pirate','free_rockstar','free_samurai','free_shark','free_shiba',
        'free_space_commander','free_teacher','free_viking','free_wizard',
        'vip_alien','vip_alien_overlord','vip_angel','vip_arctic_explorer',
        'vip_artist','vip_astronaut','vip_aztec_warrior','vip_badger',
        'vip_basketball','vip_bear','vip_bounty_hunter','vip_boxer','vip_bull',
        'vip_business_cat','vip_casino_dealer','vip_country','vip_cyber_assassin',
        'vip_cyber_punk','vip_dancer','vip_director','vip_dj','vip_dragon',
        'vip_eagle','vip_elite_cyborg','vip_fire_demon','vip_football',
        'vip_geisha_master','vip_gladiator','vip_gorilla','vip_grumpy_cat',
        'vip_hollywood','vip_ice_queen','vip_jazz','vip_liberty','vip_luchador',
        'vip_mad_scientist','vip_mecha_pilot','vip_mobster','vip_monarch',
        'vip_mummy','vip_neon_ninja','vip_panther','vip_phantom','vip_pharaoh',
        'vip_phoenix','vip_physicist','vip_plague_doctor','vip_politician',
        'vip_pug','vip_rapper','vip_rock_legend','vip_royal_guard',
        'vip_samurai_cyborg','vip_secret_agent','vip_silent_actor','vip_soccer',
        'vip_sorceress','vip_space_pioneer','vip_space_pirate','vip_space_ranger',
        'vip_spartan','vip_steampunk_inventor','vip_street_racer',
        'vip_tech_mogul','vip_tiger_boss','vip_unicorn','vip_vampire',
        'vip_vampire_hunter','vip_vigilante','vip_viking_warrior',
        'vip_voodoo_priest','vip_wolf','vip_wrestler','vip_yakuza'
      ] ELSE ARRAY[
        'free_android','free_aztec','free_business','free_chef','free_cowboy',
        'free_cyborg','free_detective','free_fox','free_geisha','free_knight',
        'free_lion','free_musician','free_ninja','free_owl','free_penguin',
        'free_pirate','free_rockstar','free_samurai','free_shark','free_shiba',
        'free_space_commander','free_teacher','free_viking','free_wizard'
      ] END
    ) AS slug
  ), n AS (SELECT count(*) AS c FROM pool)
  SELECT '/avatars/table/' || slug || '@2x.webp'
  FROM (SELECT slug, row_number() OVER (ORDER BY slug) - 1 AS i FROM pool) x, n
  WHERE x.i = (('x' || substr(md5(p_id::text), 1, 8))::bit(32)::bigint % n.c)
$$;

COMMENT ON FUNCTION public.fn_arena_avatar_pick(uuid, boolean) IS
  'Stable Club Arena avatar for an id. md5-seeded, so the same id always gets '
  'the same face and a re-run cannot reshuffle anyone. Second argument widens '
  'the pool from the 24 free pieces to all 98 (used for horses).';

UPDATE public.profiles p
SET arena_avatar_url = CASE
      -- Already chose library art: keep that exact choice.
      WHEN p.avatar_url LIKE '/avatars/%' THEN p.avatar_url
      ELSE public.fn_arena_avatar_pick(p.id, COALESCE(p.is_horse, false))
    END
WHERE p.arena_avatar_url IS NULL;

-- ─── Assert ─────────────────────────────────────────────────────────────────
DO $$
DECLARE
  no_arena   integer;
  not_lib    integer;
  photo_hits integer;
BEGIN
  SELECT count(*) INTO no_arena FROM public.profiles WHERE arena_avatar_url IS NULL;
  IF no_arena > 0 THEN
    RAISE EXCEPTION 'Incomplete: % profiles have no Arena avatar.', no_arena;
  END IF;

  -- The Arena column must never hold a photograph. That is its entire point.
  SELECT count(*) INTO not_lib
  FROM public.profiles WHERE arena_avatar_url NOT LIKE '/avatars/%';
  IF not_lib > 0 THEN
    RAISE EXCEPTION 'Refusing: % Arena avatars are not library art.', not_lib;
  END IF;

  -- And the social media photo must be exactly as we found it. The horse
  -- portraits and every human photo are still in avatar_url, untouched.
  SELECT count(*) INTO photo_hits
  FROM public.profiles WHERE avatar_url LIKE '%horse_avatar_%';
  RAISE NOTICE 'Arena avatars assigned to % profiles. % horse portraits still intact in the social photo column.',
    (SELECT count(*) FROM public.profiles), photo_hits;
END $$;
