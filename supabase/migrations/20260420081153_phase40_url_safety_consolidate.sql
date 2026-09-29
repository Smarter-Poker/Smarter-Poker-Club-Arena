-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420081153 "phase40_url_safety_consolidate"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f6d94adba195d93049597350f1a9fc8c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- phase40_url_safety_consolidate
--
-- Context: session N+1 already added a comprehensive URL validation layer
-- via fn_is_unsafe_url() + trg_validate_home_url_fields(). Session N+2 added
-- a second parallel layer (fn_is_safe_url + 4 per-table trigger functions)
-- before inspecting the first. This migration RESOLVES THE OVERLAP by:
--
--   1. Dropping the 4 duplicate triggers and functions created in N+2
--   2. Patching the authoritative fn_is_unsafe_url to also treat relative
--      /paths (e.g. "/smarter-poker-logo.png") as SAFE, since the app uses
--      these as default-avatar placeholders.
--   3. Keeping fn_is_safe_url (N+2's validator) as a library function —
--      still useful for one-off checks, but no longer attached to tables.
--
-- After this migration: ONE trigger per table (trg_validate_home_url_fields)
-- delegating to ONE validator (fn_is_unsafe_url).
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Drop the 4 N+2 triggers + their per-table trigger functions.
DROP TRIGGER IF EXISTS trg_validate_home_post_urls  ON public.commander_home_posts;
DROP TRIGGER IF EXISTS trg_validate_home_group_urls ON public.commander_home_groups;
DROP TRIGGER IF EXISTS trg_validate_home_game_urls  ON public.commander_home_games;
DROP TRIGGER IF EXISTS trg_validate_profile_urls    ON public.profiles;

DROP FUNCTION IF EXISTS public.trg_validate_home_post_urls();
DROP FUNCTION IF EXISTS public.trg_validate_home_group_urls();
DROP FUNCTION IF EXISTS public.trg_validate_home_game_urls();
DROP FUNCTION IF EXISTS public.trg_validate_profile_urls();
DROP FUNCTION IF EXISTS public.fn_validate_url_field(text, text);

-- 2. Patch fn_is_unsafe_url to allow relative /paths.
--    Rationale: the app renders /smarter-poker-logo.png (and possibly others)
--    as a default avatar. A relative absolute path cannot be exploited for
--    SSRF (Postgres would never fetch it) and if rendered in <img src=...>
--    the browser resolves it relative to the current origin — same-origin only.
CREATE OR REPLACE FUNCTION public.fn_is_unsafe_url(p_url text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
    v_host text;
BEGIN
    -- NULL / empty → safe (means no image set)
    IF p_url IS NULL OR length(btrim(p_url)) = 0 THEN
        RETURN false;
    END IF;

    -- 2 KiB cap to keep logs/queries sane
    IF length(p_url) > 2048 THEN
        RETURN true;
    END IF;

    -- Reject NULs + control chars (incl. \r \n \t \b etc)
    IF p_url ~ '[\x00-\x1F\x7F]' THEN
        RETURN true;
    END IF;

    -- Protocol-relative //host/... is ambiguous outside HTML and not needed.
    -- Reject before the relative-path check below.
    IF p_url ~ '^//' THEN
        RETURN true;
    END IF;

    -- Relative absolute path (e.g. "/smarter-poker-logo.png") is SAFE.
    -- Cannot cause SSRF (not a fetchable URL) and resolves same-origin in <img>.
    IF p_url ~ '^/[^/]' THEN
        RETURN false;
    END IF;

    -- Require http:// or https:// explicitly
    IF NOT (p_url ~* '^https?://') THEN
        RETURN true;
    END IF;

    -- Extract hostname; strip userinfo (user:pass@) if present
    v_host := lower(regexp_replace(p_url, '^https?://(?:[^@/]+@)?([^/?#:]+).*$', '\1', 'i'));

    -- localhost + no-dot hostnames (covers 'localhost', 'admin', 'intranet', etc.)
    IF v_host = 'localhost' OR v_host NOT LIKE '%.%' THEN
        RETURN true;
    END IF;

    -- IPv4 private / reserved ranges
    IF v_host ~ '^(127\.|10\.|0\.|169\.254\.|192\.168\.)' THEN
        RETURN true;
    END IF;
    IF v_host ~ '^172\.(1[6-9]|2[0-9]|3[0-1])\.' THEN
        RETURN true;
    END IF;

    -- IPv6 loopback / unique-local / link-local
    IF v_host ~ '^\[?(::1|::|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:|fe[89ab][0-9a-f]:)' THEN
        RETURN true;
    END IF;

    -- Clean
    RETURN false;
END;
$function$;

COMMENT ON FUNCTION public.fn_is_unsafe_url(text) IS
  'phase40: URL safety validator used by trg_validate_home_url_fields triggers on profiles + commander_home_* tables. Returns true if URL is unsafe. Rejects: >2KB, control chars, schemes other than http(s):, protocol-relative, localhost, single-label hosts, private/reserved IPv4, IPv6 loopback/ULA/link-local. Allows: NULL/empty, relative /paths, public http(s) hosts.';

-- fn_is_safe_url stays as a library function (not attached to any table).
-- It can still be called from app code or future migrations.
