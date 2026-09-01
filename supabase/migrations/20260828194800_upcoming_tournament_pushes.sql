-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828194800; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATION: Upcoming Tournament Push Notifications
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.tournament_players 
ADD COLUMN IF NOT EXISTS push_15m_sent BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS push_2m_sent BOOLEAN DEFAULT false;

CREATE OR REPLACE FUNCTION public.check_upcoming_tournament_pushes()
RETURNS void AS $$
BEGIN
    -- 15 Minute Push
    WITH candidates_15m AS (
        SELECT 
            t.id AS tournament_id, 
            t.name AS tournament_name, 
            tp.user_id
        FROM public.tournaments t
        JOIN public.tournament_players tp ON t.id = tp.tournament_id
        LEFT JOIN public.user_presence up ON tp.user_id = up.user_id
        WHERE t.status IN ('ANNOUNCED', 'REGISTERING')
          AND t.start_time IS NOT NULL
          AND t.game_type != 'spin'
          AND tp.push_15m_sent = false
          AND t.start_time <= now() + interval '15 minutes'
          AND t.start_time > now() + interval '2 minutes'
          AND (up.status IS NULL OR up.status != 'playing')
    ),
    inserted_15m AS (
        INSERT INTO public.push_outbox (recipient_user_id, title, body, url, event)
        SELECT 
            user_id, 
            'Tournament Starting Soon', 
            'Your tournament "' || tournament_name || '" starts in 15 minutes!', 
            '/tournaments/' || tournament_id, 
            'tournament_reminder_15m'
        FROM candidates_15m
    )
    UPDATE public.tournament_players tp
    SET push_15m_sent = true
    FROM candidates_15m c
    WHERE tp.tournament_id = c.tournament_id AND tp.user_id = c.user_id;

    -- Also mark as sent for players who ARE playing, so we don't try to send it later if they log off
    UPDATE public.tournament_players tp
    SET push_15m_sent = true
    FROM public.tournaments t, public.user_presence up
    WHERE t.id = tp.tournament_id
      AND up.user_id = tp.user_id
      AND t.status IN ('ANNOUNCED', 'REGISTERING')
      AND t.start_time <= now() + interval '15 minutes'
      AND tp.push_15m_sent = false
      AND up.status = 'playing';

    -- 2 Minute Push
    WITH candidates_2m AS (
        SELECT 
            t.id AS tournament_id, 
            t.name AS tournament_name, 
            tp.user_id
        FROM public.tournaments t
        JOIN public.tournament_players tp ON t.id = tp.tournament_id
        LEFT JOIN public.user_presence up ON tp.user_id = up.user_id
        WHERE t.status IN ('ANNOUNCED', 'REGISTERING')
          AND t.start_time IS NOT NULL
          AND t.game_type != 'spin'
          AND tp.push_2m_sent = false
          AND t.start_time <= now() + interval '2 minutes'
          AND t.start_time > now()
          AND (up.status IS NULL OR up.status != 'playing')
    ),
    inserted_2m AS (
        INSERT INTO public.push_outbox (recipient_user_id, title, body, url, event)
        SELECT 
            user_id, 
            'Tournament Starting Soon', 
            'Get ready! "' || tournament_name || '" starts in 2 minutes!', 
            '/tournaments/' || tournament_id, 
            'tournament_reminder_2m'
        FROM candidates_2m
    )
    UPDATE public.tournament_players tp
    SET push_2m_sent = true
    FROM candidates_2m c
    WHERE tp.tournament_id = c.tournament_id AND tp.user_id = c.user_id;

    -- Also mark as sent for players who ARE playing
    UPDATE public.tournament_players tp
    SET push_2m_sent = true
    FROM public.tournaments t, public.user_presence up
    WHERE t.id = tp.tournament_id
      AND up.user_id = tp.user_id
      AND t.status IN ('ANNOUNCED', 'REGISTERING')
      AND t.start_time <= now() + interval '2 minutes'
      AND tp.push_2m_sent = false
      AND up.status = 'playing';

END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Remove any existing job if it exists (safe check)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sp_upcoming_tournament_pushes') THEN
        PERFORM cron.unschedule('sp_upcoming_tournament_pushes');
    END IF;
END $$;

-- Schedule it in pg_cron (runs every minute)
SELECT cron.schedule(
    'sp_upcoming_tournament_pushes',
    '* * * * *',
    $$SELECT public.check_upcoming_tournament_pushes();$$
);
