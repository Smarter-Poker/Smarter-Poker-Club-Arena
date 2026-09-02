-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831192912; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- check_upcoming_tournament_pushes repair (2026-08-31).
-- The function referenced public.user_presence, which no longer exists - the
-- pg_cron job sp_upcoming_tournament_pushes (every minute) has been failing
-- with 42P01 for hours, so NO tournament reminder pushes were being sent.
-- user_presence's job here was "skip the push for players already in a game".
-- Presence now lives on profiles (fn_update_presence), but the truthful
-- "currently playing" signal is an occupied seat: table_seats.left_at IS NULL
-- (the same definition get_club_home uses for players_playing). Same
-- semantics, live data source, no dead table.
CREATE OR REPLACE FUNCTION public.check_upcoming_tournament_pushes()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    -- 15 Minute Push
    WITH candidates_15m AS (
        SELECT
            t.id AS tournament_id,
            t.name AS tournament_name,
            tp.user_id
        FROM public.tournaments t
        JOIN public.tournament_players tp ON t.id = tp.tournament_id
        WHERE t.status IN ('ANNOUNCED', 'REGISTERING')
          AND t.start_time IS NOT NULL
          AND t.game_type != 'spin'
          AND tp.push_15m_sent = false
          AND t.start_time <= now() + interval '15 minutes'
          AND t.start_time > now() + interval '2 minutes'
          AND NOT EXISTS (
            SELECT 1 FROM public.table_seats ts
            WHERE ts.user_id = tp.user_id AND ts.left_at IS NULL
          )
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

    -- Players already in a seat: mark as sent so we do not push later when
    -- they stand up (mirrors the old user_presence 'playing' branch).
    UPDATE public.tournament_players tp
    SET push_15m_sent = true
    FROM public.tournaments t
    WHERE t.id = tp.tournament_id
      AND t.status IN ('ANNOUNCED', 'REGISTERING')
      AND t.start_time <= now() + interval '15 minutes'
      AND tp.push_15m_sent = false
      AND EXISTS (
        SELECT 1 FROM public.table_seats ts
        WHERE ts.user_id = tp.user_id AND ts.left_at IS NULL
      );

    -- 2 Minute Push
    WITH candidates_2m AS (
        SELECT
            t.id AS tournament_id,
            t.name AS tournament_name,
            tp.user_id
        FROM public.tournaments t
        JOIN public.tournament_players tp ON t.id = tp.tournament_id
        WHERE t.status IN ('ANNOUNCED', 'REGISTERING')
          AND t.start_time IS NOT NULL
          AND t.game_type != 'spin'
          AND tp.push_2m_sent = false
          AND t.start_time <= now() + interval '2 minutes'
          AND t.start_time > now()
          AND NOT EXISTS (
            SELECT 1 FROM public.table_seats ts
            WHERE ts.user_id = tp.user_id AND ts.left_at IS NULL
          )
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

    UPDATE public.tournament_players tp
    SET push_2m_sent = true
    FROM public.tournaments t
    WHERE t.id = tp.tournament_id
      AND t.status IN ('ANNOUNCED', 'REGISTERING')
      AND t.start_time <= now() + interval '2 minutes'
      AND tp.push_2m_sent = false
      AND EXISTS (
        SELECT 1 FROM public.table_seats ts
        WHERE ts.user_id = tp.user_id AND ts.left_at IS NULL
      );
END;
$$;

REVOKE ALL ON FUNCTION public.check_upcoming_tournament_pushes() FROM PUBLIC, anon, authenticated;
