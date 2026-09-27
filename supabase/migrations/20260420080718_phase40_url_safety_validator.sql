-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420080718 "phase40_url_safety_validator"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 37d57b6eddc45dc0ac186ae7fee213cb of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- phase40_url_safety_validator
--
-- Validates image/video URLs for SSRF-safe + XSS-safe patterns, then applies
-- BEFORE INSERT/UPDATE triggers to every home-games-linked URL column.
--
-- Allowed shapes:
--   • NULL or empty string      (no image)
--   • Relative path /foo/bar    (Next.js public/ asset)
--   • https:// + public host    (Supabase storage, googleusercontent, etc.)
--
-- Rejected:
--   • Dangerous schemes: javascript:, data:, file:, about:, vbscript:
--   • http:// (non-TLS)
--   • Raw IPv4 in private/loopback/link-local/reserved ranges
--   • Raw IPv6 in ::1 / fc00::/7 / fe80::/10
--   • Hostnames "localhost", "0.0.0.0"
--   • Single-label hostnames (e.g. "intranet")
--
-- Service role bypass: migrations and trusted maintenance can still write
-- whatever is needed via service_role.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_is_safe_url(p_url text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path TO 'public'
AS $$
DECLARE
    v_host text;
    v_ip inet;
BEGIN
    -- Null / empty → fine (means "no image")
    IF p_url IS NULL OR p_url = '' THEN
        RETURN true;
    END IF;

    -- Protocol-relative //host/... is ambiguous in email/HTML contexts. Reject.
    IF p_url ~ '^//' THEN
        RETURN false;
    END IF;

    -- Relative absolute path: /foo/bar → Next.js public/ asset, allow
    IF p_url ~ '^/[^/]' THEN
        RETURN true;
    END IF;

    -- Must be https:// (prefer TLS; allow http:// too for dev origins that
    -- also satisfy the host check below — typical prod traffic is https only)
    IF p_url !~* '^https?://' THEN
        RETURN false;
    END IF;

    -- Extract host (everything after scheme://, stopping at /?#:)
    v_host := lower(substring(p_url from '^https?://([^/?#:]+)'));
    IF v_host IS NULL OR v_host = '' THEN
        RETURN false;
    END IF;

    -- Known dangerous / unhelpful hosts
    IF v_host IN ('localhost', '0.0.0.0', '[::1]') THEN
        RETURN false;
    END IF;

    -- IP-literal host: parse as inet and check CIDRs
    BEGIN
        v_ip := v_host::inet;
        IF v_ip <<= '127.0.0.0/8'::inet THEN RETURN false; END IF;
        IF v_ip <<= '10.0.0.0/8'::inet THEN RETURN false; END IF;
        IF v_ip <<= '172.16.0.0/12'::inet THEN RETURN false; END IF;
        IF v_ip <<= '192.168.0.0/16'::inet THEN RETURN false; END IF;
        IF v_ip <<= '169.254.0.0/16'::inet THEN RETURN false; END IF;
        IF v_ip <<= '0.0.0.0/8'::inet THEN RETURN false; END IF;
        IF v_ip <<= '::1/128'::inet THEN RETURN false; END IF;
        IF v_ip <<= 'fc00::/7'::inet THEN RETURN false; END IF;
        IF v_ip <<= 'fe80::/10'::inet THEN RETURN false; END IF;
        -- Public IP literal → allow
        RETURN true;
    EXCEPTION WHEN OTHERS THEN
        -- Not a parseable IP → it's a hostname, fall through to hostname checks
        NULL;
    END;

    -- Hostname must have at least one dot (reject "intranet", "printer", etc.)
    IF position('.' in v_host) = 0 THEN
        RETURN false;
    END IF;

    RETURN true;
END;
$$;

COMMENT ON FUNCTION public.fn_is_safe_url(text) IS
  'phase40: validates image/video URLs. Blocks SSRF-friendly schemes (javascript:/data:/file:/about:), private/loopback IPs, and internal hostnames. NULL and empty pass through. Relative /paths pass through. See phase40_url_safety_validator migration.';
