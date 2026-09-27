-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260503082230 "phase_42_secdef_search_path_lockdown_and_fk_indexes"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3c4b194bf4103ca4a852b7043cdb1885 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════
-- Phase 42 — security/perf advisor cleanup
--
-- (1) SECURITY DEFINER search_path lockdown:
--     - fn_get_social_feed_v2 + update_live_peak_viewers: pin search_path
--       to '' so they can't be hijacked by callers who CREATE a same-named
--       table in their own schema and let it shadow public.
--     - Skipping postgis-supplied st_estimatedextent overloads (extension-
--       owned, not ours to modify).
--
-- (2) FK columns without indexes (perf — DELETE on parent table requires
--     a sequential scan to find children):
--     - club_wallet_transactions.club_id
--     - video_transcode_jobs.{post_id, reel_id, user_id}
--     - live_reactions.sender_id
--     CREATE INDEX CONCURRENTLY would be ideal but apply_migration
--     wraps in a transaction; using non-concurrent CREATE INDEX with
--     IF NOT EXISTS for idempotency.
-- ═══════════════════════════════════════════════════════════════════════

-- ─── 1. Pin search_path on owned SECURITY DEFINER functions ──────────
ALTER FUNCTION public.fn_get_social_feed_v2(uuid, integer, integer, text)
    SET search_path = '';

ALTER FUNCTION public.update_live_peak_viewers(uuid, integer)
    SET search_path = '';

-- ─── 2. FK indexes ─────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_club_wallet_tx_club_id_fk
    ON public.club_wallet_transactions(club_id);

CREATE INDEX IF NOT EXISTS idx_video_transcode_jobs_post_id_fk
    ON public.video_transcode_jobs(post_id);

CREATE INDEX IF NOT EXISTS idx_video_transcode_jobs_reel_id_fk
    ON public.video_transcode_jobs(reel_id);

CREATE INDEX IF NOT EXISTS idx_video_transcode_jobs_user_id_fk
    ON public.video_transcode_jobs(user_id);

CREATE INDEX IF NOT EXISTS idx_live_reactions_sender_id_fk
    ON public.live_reactions(sender_id);

-- ─── Verification ─────────────────────────────────────────────────────
DO $$
DECLARE
    v_secdef_no_path integer;
    v_fk_no_idx integer;
BEGIN
    -- Owned SECDEF without search_path (excludes extension-owned PostGIS funcs)
    SELECT COUNT(*) INTO v_secdef_no_path
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.prosecdef=true
      AND p.proname IN ('fn_get_social_feed_v2', 'update_live_peak_viewers')
      AND (p.proconfig IS NULL OR NOT (array_to_string(p.proconfig, ',') LIKE '%search_path=%'));
    IF v_secdef_no_path <> 0 THEN
        RAISE EXCEPTION 'Post-apply: % owned SECDEF funcs still missing search_path', v_secdef_no_path;
    END IF;

    SELECT COUNT(*) INTO v_fk_no_idx
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND c.conrelid::regclass::text || '.' || a.attname IN (
          'club_wallet_transactions.club_id',
          'video_transcode_jobs.post_id',
          'video_transcode_jobs.reel_id',
          'video_transcode_jobs.user_id',
          'live_reactions.sender_id'
      )
      AND NOT EXISTS (
          SELECT 1 FROM pg_index i
          WHERE i.indrelid = c.conrelid AND a.attnum = ANY(i.indkey)
      );
    IF v_fk_no_idx <> 0 THEN
        RAISE EXCEPTION 'Post-apply: % targeted FK columns still missing indexes', v_fk_no_idx;
    END IF;

    RAISE NOTICE 'Post-apply: 2 SECDEF funcs locked, 5 FK indexes added';
END $$;
