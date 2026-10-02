-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419224421 "phase37_rate_limit_public_trackers"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 cbf3aae9bf46bcde2b5ad24259475657 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- M2. Rate-limit public analytics trackers.
-- ============================================================================
-- track_home_group_view + track_home_group_share_click are intentionally
-- anon-callable for public discovery analytics. Without dedupe, a scraper
-- can hammer them and arbitrarily inflate view_count / share_click_count,
-- breaking vitality scoring and polluting trending signals.
--
-- Strategy: insert-first dedupe log + counter bump only on successful insert.
--   Authenticated: dedupe 1 view per (group, user) per hour
--   Anonymous:     global cap of 60 views per group per hour
--   Shares:        dedupe 1 click per (group, token, user) per hour
--                  anon cap of 100 clicks per group per hour
-- Log pruned by daily cron (7-day retention).
-- ============================================================================

-- Dedupe/log table for views
CREATE TABLE IF NOT EXISTS public.commander_home_group_view_log (
    id          bigserial PRIMARY KEY,
    group_id    uuid NOT NULL REFERENCES public.commander_home_groups(id) ON DELETE CASCADE,
    caller_uid  uuid,  -- NULL = anonymous caller
    inserted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_home_view_log_recent
    ON public.commander_home_group_view_log (group_id, inserted_at DESC);

CREATE INDEX IF NOT EXISTS idx_home_view_log_caller
    ON public.commander_home_group_view_log (group_id, caller_uid, inserted_at DESC)
    WHERE caller_uid IS NOT NULL;

-- Lock it down: only service_role can read/write (accessed only via the trackers)
ALTER TABLE public.commander_home_group_view_log ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies — nothing but service_role bypass can reach it

COMMENT ON TABLE public.commander_home_group_view_log IS
    'Phase 37 rate-limit state for track_home_group_view / track_home_group_share_click. '
    'Pruned daily by home-view-log-prune cron. Not user-facing.';

-- Dedupe/log table for share clicks (tracks per-token + per-user)
CREATE TABLE IF NOT EXISTS public.commander_home_group_share_log (
    id          bigserial PRIMARY KEY,
    group_id    uuid NOT NULL REFERENCES public.commander_home_groups(id) ON DELETE CASCADE,
    token_id    uuid,  -- May be NULL when not a tokenized share
    caller_uid  uuid,  -- NULL = anonymous caller
    inserted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_home_share_log_recent
    ON public.commander_home_group_share_log (group_id, inserted_at DESC);

CREATE INDEX IF NOT EXISTS idx_home_share_log_caller
    ON public.commander_home_group_share_log (group_id, caller_uid, token_id, inserted_at DESC)
    WHERE caller_uid IS NOT NULL;

ALTER TABLE public.commander_home_group_share_log ENABLE ROW LEVEL SECURITY;

-- ───────────────────────────────────────────────────────────────────────
-- Rewrite track_home_group_view with per-caller dedupe + global anon cap
-- ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.track_home_group_view(p_group_id uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
    v_uid uuid := auth.uid();
    v_anon_recent int;
BEGIN
    -- Validate group exists (no-op silently if not — don't leak existence to anon)
    IF NOT EXISTS (SELECT 1 FROM commander_home_groups WHERE id = p_group_id) THEN
        RETURN;
    END IF;

    IF v_uid IS NOT NULL THEN
        -- Authenticated: 1 bump per (group, user) per hour
        IF EXISTS (
            SELECT 1 FROM commander_home_group_view_log
             WHERE group_id   = p_group_id
               AND caller_uid = v_uid
               AND inserted_at > NOW() - INTERVAL '1 hour'
        ) THEN
            RETURN;
        END IF;
    ELSE
        -- Anonymous: global cap of 60 bumps per group per hour
        SELECT COUNT(*) INTO v_anon_recent
          FROM commander_home_group_view_log
         WHERE group_id   = p_group_id
           AND caller_uid IS NULL
           AND inserted_at > NOW() - INTERVAL '1 hour';
        IF v_anon_recent >= 60 THEN
            RETURN;
        END IF;
    END IF;

    INSERT INTO commander_home_group_view_log (group_id, caller_uid)
         VALUES (p_group_id, v_uid);

    UPDATE commander_home_groups
       SET view_count = COALESCE(view_count, 0) + 1
     WHERE id = p_group_id;
END;
$function$;

-- ───────────────────────────────────────────────────────────────────────
-- Rewrite track_home_group_share_click with per-caller dedupe + anon cap
-- ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.track_home_group_share_click(
    p_group_id uuid, p_token_id uuid DEFAULT NULL::uuid
)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
    v_uid uuid := auth.uid();
    v_anon_recent int;
BEGIN
    -- Validate group exists
    IF NOT EXISTS (SELECT 1 FROM commander_home_groups WHERE id = p_group_id) THEN
        RETURN;
    END IF;

    IF v_uid IS NOT NULL THEN
        -- Authenticated: 1 bump per (group, token, user) per hour
        IF EXISTS (
            SELECT 1 FROM commander_home_group_share_log
             WHERE group_id   = p_group_id
               AND caller_uid = v_uid
               AND COALESCE(token_id::text, '') = COALESCE(p_token_id::text, '')
               AND inserted_at > NOW() - INTERVAL '1 hour'
        ) THEN
            RETURN;
        END IF;
    ELSE
        -- Anonymous: global cap of 100 per group per hour
        SELECT COUNT(*) INTO v_anon_recent
          FROM commander_home_group_share_log
         WHERE group_id   = p_group_id
           AND caller_uid IS NULL
           AND inserted_at > NOW() - INTERVAL '1 hour';
        IF v_anon_recent >= 100 THEN
            RETURN;
        END IF;
    END IF;

    INSERT INTO commander_home_group_share_log (group_id, token_id, caller_uid)
         VALUES (p_group_id, p_token_id, v_uid);

    UPDATE commander_home_groups
       SET share_click_count = COALESCE(share_click_count, 0) + 1
     WHERE id = p_group_id;

    IF p_token_id IS NOT NULL THEN
        UPDATE commander_home_invite_tokens
           SET click_count = COALESCE(click_count, 0) + 1
         WHERE id = p_token_id AND group_id = p_group_id;
    END IF;
END;
$function$;

-- Preserve the existing grant policy: anon + authenticated + service_role all
-- must be able to call these (they're public analytics trackers)
GRANT EXECUTE ON FUNCTION public.track_home_group_view(uuid)
   TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.track_home_group_share_click(uuid, uuid)
   TO anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────
-- Retention: prune log entries older than 7 days, daily at 03:00 UTC
-- ───────────────────────────────────────────────────────────────────────
SELECT cron.schedule(
    'home-view-log-prune',
    '0 3 * * *',
    $$DELETE FROM public.commander_home_group_view_log WHERE inserted_at < NOW() - INTERVAL '7 days';
      DELETE FROM public.commander_home_group_share_log WHERE inserted_at < NOW() - INTERVAL '7 days';$$
);
