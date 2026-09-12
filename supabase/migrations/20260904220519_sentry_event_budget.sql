-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260904220519; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260904220519   (the stamp IS the apply time, UTC: 2026-09-04 22:05:19)
--   name        sentry_event_budget
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 5449 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260904220519 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_sentry_budget_take
--     TABLE          public.sentry_event_budget, public.sentry_event_fingerprints
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- 20260904235000_sentry_event_budget.sql (World Hub repo, supabase/migrations/)
-- Sentry free-tier daily token bucket (60/day) + per-fingerprint cap (3/day)
-- for the World Hub server runtime. See docs/SENTRY-FREE-TIER-POLICY.md.
BEGIN;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'sentry_event_budget'
    ) THEN
        RAISE EXCEPTION 'pre-flight failed: public.sentry_event_budget already exists';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'fn_sentry_budget_take'
    ) THEN
        RAISE EXCEPTION 'pre-flight failed: public.fn_sentry_budget_take already exists';
    END IF;
END $$;

CREATE TABLE public.sentry_event_budget (
    day   date    NOT NULL PRIMARY KEY,
    sent  integer NOT NULL DEFAULT 0 CHECK (sent >= 0)
);
COMMENT ON TABLE public.sentry_event_budget IS
    'Sentry free-tier daily token bucket for the World Hub server runtime. One row per UTC day. Read/written only by fn_sentry_budget_take() from sentry.server.config.js beforeSend. See docs/SENTRY-FREE-TIER-POLICY.md.';

CREATE TABLE public.sentry_event_fingerprints (
    day         date    NOT NULL,
    fingerprint text    NOT NULL,
    sent        integer NOT NULL DEFAULT 0 CHECK (sent >= 0),
    PRIMARY KEY (day, fingerprint)
);
COMMENT ON TABLE public.sentry_event_fingerprints IS
    'Sentry free-tier per-fingerprint daily cap (3/day) for the World Hub server runtime. Companion to sentry_event_budget.';

CREATE FUNCTION public.fn_sentry_budget_take(
    p_fingerprint       text,
    p_daily_limit       integer DEFAULT 60,
    p_fingerprint_limit integer DEFAULT 3
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_day      date := (now() AT TIME ZONE 'utc')::date;
    v_fp       text := COALESCE(NULLIF(left(p_fingerprint, 200), ''), 'unknown');
    v_fp_sent  integer;
    v_sent     integer;
BEGIN
    DELETE FROM public.sentry_event_budget       WHERE day < v_day - 14;
    DELETE FROM public.sentry_event_fingerprints WHERE day < v_day - 14;

    INSERT INTO public.sentry_event_budget (day, sent)
        VALUES (v_day, 0) ON CONFLICT (day) DO NOTHING;
    INSERT INTO public.sentry_event_fingerprints (day, fingerprint, sent)
        VALUES (v_day, v_fp, 0) ON CONFLICT (day, fingerprint) DO NOTHING;

    UPDATE public.sentry_event_fingerprints
       SET sent = sent + 1
     WHERE day = v_day AND fingerprint = v_fp AND sent < p_fingerprint_limit
    RETURNING sent INTO v_fp_sent;

    IF v_fp_sent IS NULL THEN
        SELECT sent INTO v_fp_sent FROM public.sentry_event_fingerprints
         WHERE day = v_day AND fingerprint = v_fp;
        SELECT sent INTO v_sent FROM public.sentry_event_budget WHERE day = v_day;
        RETURN jsonb_build_object(
            'allowed', false, 'reason', 'fingerprint_cap',
            'sent', COALESCE(v_sent, 0), 'fingerprint_sent', COALESCE(v_fp_sent, 0));
    END IF;

    UPDATE public.sentry_event_budget
       SET sent = sent + 1
     WHERE day = v_day AND sent < p_daily_limit
    RETURNING sent INTO v_sent;

    IF v_sent IS NULL THEN
        UPDATE public.sentry_event_fingerprints
           SET sent = GREATEST(sent - 1, 0)
         WHERE day = v_day AND fingerprint = v_fp;
        SELECT sent INTO v_sent FROM public.sentry_event_budget WHERE day = v_day;
        RETURN jsonb_build_object(
            'allowed', false, 'reason', 'daily_budget',
            'sent', COALESCE(v_sent, 0), 'fingerprint_sent', GREATEST(v_fp_sent - 1, 0));
    END IF;

    RETURN jsonb_build_object(
        'allowed', true, 'reason', 'ok',
        'sent', v_sent, 'fingerprint_sent', v_fp_sent);
END;
$$;

COMMENT ON FUNCTION public.fn_sentry_budget_take(text, integer, integer) IS
    'Take one Sentry event token for today (UTC). Per-fingerprint cap checked first, then the global daily bucket. Returns {allowed, reason, sent, fingerprint_sent}. service_role only.';

REVOKE ALL ON TABLE public.sentry_event_budget       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.sentry_event_fingerprints FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_sentry_budget_take(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sentry_event_budget       TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sentry_event_fingerprints TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_sentry_budget_take(text, integer, integer) TO service_role;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'sentry_event_budget'
    ) THEN
        RAISE EXCEPTION 'post-apply failed: sentry_event_budget missing';
    END IF;
    IF has_table_privilege('anon', 'public.sentry_event_budget', 'SELECT')
       OR has_table_privilege('authenticated', 'public.sentry_event_budget', 'SELECT')
       OR has_function_privilege('anon', 'public.fn_sentry_budget_take(text, integer, integer)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.fn_sentry_budget_take(text, integer, integer)', 'EXECUTE')
    THEN
        RAISE EXCEPTION 'post-apply failed: anon/authenticated still have access to the Sentry budget';
    END IF;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
