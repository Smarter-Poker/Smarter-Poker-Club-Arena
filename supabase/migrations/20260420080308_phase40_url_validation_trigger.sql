-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420080308 "phase40_url_validation_trigger"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ca61159c1291b7a7a8a6e72370bc7164 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- phase40_url_validation_trigger
--
-- SSRF / XSS hardening: reject dangerous URL values at write time on every
-- user-supplied URL column under home-games + profiles. Forward-only — does
-- not touch existing rows. Existing bad rows stay as-is but cannot be
-- re-set to another bad value (only fired when the column actually changes).
--
-- Blocked URL shapes:
--   • Schemes other than http:// or https:// (javascript:, data:, file:,
--     about:, vbscript:, jar:, blob:, gopher:, ftp://, telnet://, etc.)
--   • Hostnames that are literal private IPs (SSRF vector — an attacker
--     could get the platform to fetch internal services):
--       – IPv4: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
--              169.254.0.0/16 (link-local), 0.0.0.0
--       – hostnames: 'localhost', any host containing no dot
--       – IPv6: [::1], [::], [fc00::/7] (private), [fe80::/10] (link-local)
--   • URLs containing NUL bytes or other control chars (1-31, 127)
--   • URLs longer than 2048 chars
--
-- Columns covered (11 total):
--   commander_home_games.cover_photo_url
--   commander_home_game_photos.photo_url
--   commander_home_groups.cover_photo_url
--   commander_home_groups.profile_photo_url
--   commander_home_groups.qr_code_url
--   commander_home_posts.image_urls         (text[] — validated per-element)
--   commander_home_posts.video_url
--   profiles.avatar_url
--   profiles.cover_photo_url
--   profiles.hendon_url
--
-- Service role bypass: service_role inserts/updates skip the validator so
-- ops / backfill scripts can still fix bad data.
-- ═══════════════════════════════════════════════════════════════════════════

-- Immutable classifier: true if the URL is unsafe, false if it's accepted.
-- Null / empty string are always allowed (NULL = absent).
CREATE OR REPLACE FUNCTION public.fn_is_unsafe_url(p_url text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
    v_host text;
BEGIN
    IF p_url IS NULL OR length(btrim(p_url)) = 0 THEN
        RETURN false;
    END IF;

    -- Length cap
    IF length(p_url) > 2048 THEN
        RETURN true;
    END IF;

    -- Reject NULs + control chars (incl. \r \n \t \b etc)
    IF p_url ~ '[\x00-\x1F\x7F]' THEN
        RETURN true;
    END IF;

    -- Require http:// or https:// explicitly (case-insensitive)
    IF NOT (p_url ~* '^https?://') THEN
        RETURN true;
    END IF;

    -- Extract hostname between '://' and the next '/', '?', '#', or end.
    -- Also strip userinfo (user:pass@) if present.
    v_host := lower(regexp_replace(p_url, '^https?://(?:[^@/]+@)?([^/?#:]+).*$', '\1', 'i'));

    -- localhost + no-dot hostnames (covers 'localhost', 'admin', 'intranet', etc.)
    IF v_host = 'localhost' OR v_host NOT LIKE '%.%' THEN
        RETURN true;
    END IF;

    -- IPv4 private ranges
    IF v_host ~ '^(127\.|10\.|0\.|169\.254\.|192\.168\.)' THEN
        RETURN true;
    END IF;
    IF v_host ~ '^172\.(1[6-9]|2[0-9]|3[0-1])\.' THEN
        RETURN true;
    END IF;

    -- IPv6 loopback / private / link-local (host forms as '[::1]' etc. after url-parse)
    IF v_host ~ '^\[?(::1|::|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:|fe[89ab][0-9a-f]:)' THEN
        RETURN true;
    END IF;

    -- Clean
    RETURN false;
END;
$function$;

COMMENT ON FUNCTION public.fn_is_unsafe_url(text) IS
  'phase40: returns true if a URL should be rejected (bad scheme, private IP, '
  'control chars, or too long). Null/empty allowed.';

-- Trigger function: validates url fields on writes. Skips if caller is
-- service_role (ops path) or if the relevant column didn't change on UPDATE.
CREATE OR REPLACE FUNCTION public.fn_validate_home_url_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
    v_arr_element text;
BEGIN
    -- Service role bypass
    IF auth.role() = 'service_role' THEN
        RETURN NEW;
    END IF;

    -- Route by table
    IF TG_TABLE_NAME = 'commander_home_games' THEN
        IF TG_OP = 'INSERT'
           OR NEW.cover_photo_url IS DISTINCT FROM OLD.cover_photo_url THEN
            IF public.fn_is_unsafe_url(NEW.cover_photo_url) THEN
                RAISE EXCEPTION 'unsafe cover_photo_url rejected: %', NEW.cover_photo_url
                      USING ERRCODE = '22023';
            END IF;
        END IF;

    ELSIF TG_TABLE_NAME = 'commander_home_game_photos' THEN
        IF TG_OP = 'INSERT'
           OR NEW.photo_url IS DISTINCT FROM OLD.photo_url THEN
            IF public.fn_is_unsafe_url(NEW.photo_url) THEN
                RAISE EXCEPTION 'unsafe photo_url rejected: %', NEW.photo_url
                      USING ERRCODE = '22023';
            END IF;
        END IF;

    ELSIF TG_TABLE_NAME = 'commander_home_groups' THEN
        IF TG_OP = 'INSERT'
           OR NEW.cover_photo_url IS DISTINCT FROM OLD.cover_photo_url THEN
            IF public.fn_is_unsafe_url(NEW.cover_photo_url) THEN
                RAISE EXCEPTION 'unsafe cover_photo_url rejected'
                      USING ERRCODE = '22023';
            END IF;
        END IF;
        IF TG_OP = 'INSERT'
           OR NEW.profile_photo_url IS DISTINCT FROM OLD.profile_photo_url THEN
            IF public.fn_is_unsafe_url(NEW.profile_photo_url) THEN
                RAISE EXCEPTION 'unsafe profile_photo_url rejected'
                      USING ERRCODE = '22023';
            END IF;
        END IF;
        IF TG_OP = 'INSERT'
           OR NEW.qr_code_url IS DISTINCT FROM OLD.qr_code_url THEN
            IF public.fn_is_unsafe_url(NEW.qr_code_url) THEN
                RAISE EXCEPTION 'unsafe qr_code_url rejected'
                      USING ERRCODE = '22023';
            END IF;
        END IF;

    ELSIF TG_TABLE_NAME = 'commander_home_posts' THEN
        IF TG_OP = 'INSERT'
           OR NEW.video_url IS DISTINCT FROM OLD.video_url THEN
            IF public.fn_is_unsafe_url(NEW.video_url) THEN
                RAISE EXCEPTION 'unsafe video_url rejected'
                      USING ERRCODE = '22023';
            END IF;
        END IF;
        -- image_urls is text[] — iterate on change.
        IF TG_OP = 'INSERT'
           OR NEW.image_urls IS DISTINCT FROM OLD.image_urls THEN
            IF NEW.image_urls IS NOT NULL THEN
                IF array_length(NEW.image_urls, 1) > 20 THEN
                    RAISE EXCEPTION 'too many image_urls (max 20)'
                          USING ERRCODE = '22023';
                END IF;
                FOREACH v_arr_element IN ARRAY NEW.image_urls LOOP
                    IF public.fn_is_unsafe_url(v_arr_element) THEN
                        RAISE EXCEPTION 'unsafe image_urls element rejected'
                              USING ERRCODE = '22023';
                    END IF;
                END LOOP;
            END IF;
        END IF;

    ELSIF TG_TABLE_NAME = 'profiles' THEN
        IF TG_OP = 'INSERT'
           OR NEW.avatar_url IS DISTINCT FROM OLD.avatar_url THEN
            IF public.fn_is_unsafe_url(NEW.avatar_url) THEN
                RAISE EXCEPTION 'unsafe avatar_url rejected'
                      USING ERRCODE = '22023';
            END IF;
        END IF;
        IF TG_OP = 'INSERT'
           OR NEW.cover_photo_url IS DISTINCT FROM OLD.cover_photo_url THEN
            IF public.fn_is_unsafe_url(NEW.cover_photo_url) THEN
                RAISE EXCEPTION 'unsafe cover_photo_url rejected'
                      USING ERRCODE = '22023';
            END IF;
        END IF;
        IF TG_OP = 'INSERT'
           OR NEW.hendon_url IS DISTINCT FROM OLD.hendon_url THEN
            IF public.fn_is_unsafe_url(NEW.hendon_url) THEN
                RAISE EXCEPTION 'unsafe hendon_url rejected'
                      USING ERRCODE = '22023';
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$function$;

-- Attach to each table. One trigger per table, fires BEFORE INSERT OR UPDATE.
DO $$
DECLARE
    t text;
    tables text[] := ARRAY[
        'commander_home_games',
        'commander_home_game_photos',
        'commander_home_groups',
        'commander_home_posts',
        'profiles'
    ];
BEGIN
    FOREACH t IN ARRAY tables LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS trg_validate_home_url_fields ON public.%I', t
        );
        EXECUTE format(
            'CREATE TRIGGER trg_validate_home_url_fields '
            'BEFORE INSERT OR UPDATE ON public.%I '
            'FOR EACH ROW EXECUTE FUNCTION public.fn_validate_home_url_fields()', t
        );
    END LOOP;
END $$;
