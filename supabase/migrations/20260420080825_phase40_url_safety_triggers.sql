-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420080825 "phase40_url_safety_triggers"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 26caae2fa050acd84a39d1ec7ef41e49 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- phase40_url_safety_triggers
--
-- Applies BEFORE INSERT/UPDATE field validators that call fn_is_safe_url()
-- on every URL column in home-games and profiles. Rejects SSRF/XSS-friendly
-- values with a clean SQLSTATE 42501 (insufficient privilege) error.
-- 
-- Service-role writes are exempt — they're the maintenance / migration path.
-- RLS and authenticated app writes ALL go through these.
-- ═══════════════════════════════════════════════════════════════════════════

-- Scalar-column validator (one column per table for now — could be generalized
-- but current scope is the explicit list).
CREATE OR REPLACE FUNCTION public.fn_validate_url_field(p_field_name text, p_value text)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $$
BEGIN
    IF NOT public.fn_is_safe_url(p_value) THEN
        RAISE EXCEPTION 'Invalid URL for %: blocked for safety (SSRF/XSS scheme or private IP)', p_field_name
          USING ERRCODE = '42501',
                HINT   = 'use an https:// URL pointing at a public host, or a /relative path';
    END IF;
END;
$$;

-- Trigger function: commander_home_posts (image_urls[] + video_url)
CREATE OR REPLACE FUNCTION public.trg_validate_home_post_urls()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
    v_url text;
BEGIN
    -- service_role bypass
    IF auth.role() = 'service_role' THEN
        RETURN NEW;
    END IF;

    -- image_urls array
    IF NEW.image_urls IS NOT NULL THEN
        FOREACH v_url IN ARRAY NEW.image_urls LOOP
            PERFORM public.fn_validate_url_field('commander_home_posts.image_urls[]', v_url);
        END LOOP;
    END IF;

    -- video_url
    PERFORM public.fn_validate_url_field('commander_home_posts.video_url', NEW.video_url);

    RETURN NEW;
END;
$$;

-- Trigger function: commander_home_groups (cover_photo_url + profile_photo_url)
CREATE OR REPLACE FUNCTION public.trg_validate_home_group_urls()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
    IF auth.role() = 'service_role' THEN RETURN NEW; END IF;
    PERFORM public.fn_validate_url_field('commander_home_groups.cover_photo_url',   NEW.cover_photo_url);
    PERFORM public.fn_validate_url_field('commander_home_groups.profile_photo_url', NEW.profile_photo_url);
    RETURN NEW;
END;
$$;

-- Trigger function: commander_home_games (cover_photo_url)
CREATE OR REPLACE FUNCTION public.trg_validate_home_game_urls()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
    IF auth.role() = 'service_role' THEN RETURN NEW; END IF;
    PERFORM public.fn_validate_url_field('commander_home_games.cover_photo_url', NEW.cover_photo_url);
    RETURN NEW;
END;
$$;

-- Trigger function: profiles (avatar_url)
CREATE OR REPLACE FUNCTION public.trg_validate_profile_urls()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
    IF auth.role() = 'service_role' THEN RETURN NEW; END IF;
    PERFORM public.fn_validate_url_field('profiles.avatar_url', NEW.avatar_url);
    RETURN NEW;
END;
$$;

-- Attach the triggers
DROP TRIGGER IF EXISTS trg_validate_home_post_urls   ON public.commander_home_posts;
CREATE TRIGGER trg_validate_home_post_urls
  BEFORE INSERT OR UPDATE OF image_urls, video_url
  ON public.commander_home_posts
  FOR EACH ROW EXECUTE FUNCTION public.trg_validate_home_post_urls();

DROP TRIGGER IF EXISTS trg_validate_home_group_urls  ON public.commander_home_groups;
CREATE TRIGGER trg_validate_home_group_urls
  BEFORE INSERT OR UPDATE OF cover_photo_url, profile_photo_url
  ON public.commander_home_groups
  FOR EACH ROW EXECUTE FUNCTION public.trg_validate_home_group_urls();

DROP TRIGGER IF EXISTS trg_validate_home_game_urls   ON public.commander_home_games;
CREATE TRIGGER trg_validate_home_game_urls
  BEFORE INSERT OR UPDATE OF cover_photo_url
  ON public.commander_home_games
  FOR EACH ROW EXECUTE FUNCTION public.trg_validate_home_game_urls();

DROP TRIGGER IF EXISTS trg_validate_profile_urls     ON public.profiles;
CREATE TRIGGER trg_validate_profile_urls
  BEFORE INSERT OR UPDATE OF avatar_url
  ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.trg_validate_profile_urls();
