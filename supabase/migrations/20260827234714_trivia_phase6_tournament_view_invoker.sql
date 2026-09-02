-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827234714; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- The public tournament catalogue never needs the question roster. Make the
-- projection SECURITY INVOKER and grant only its non-secret source columns so
-- the view cannot bypass base-table RLS or expose embedded legacy answer keys.
BEGIN;

CREATE OR REPLACE VIEW public.trivia_tournaments_public
WITH (security_invoker = true)
AS
SELECT
    id,
    name,
    description,
    start_time,
    end_time,
    starts_at,
    ends_at,
    entry_fee,
    prize_pool,
    status,
    created_at,
    tournament_type,
    current_round,
    total_rounds,
    round_deadline,
    winners,
    completed_at,
    max_players,
    current_players,
    '[]'::jsonb AS questions,
    0::integer AS question_count
FROM public.trivia_tournaments;

REVOKE ALL PRIVILEGES ON public.trivia_tournaments FROM anon, authenticated;
GRANT SELECT (
    id,name,description,start_time,end_time,starts_at,ends_at,entry_fee,
    prize_pool,status,created_at,tournament_type,current_round,total_rounds,
    round_deadline,winners,completed_at,max_players,current_players
) ON public.trivia_tournaments TO anon, authenticated;

REVOKE ALL PRIVILEGES ON public.trivia_tournaments_public FROM PUBLIC;
GRANT SELECT ON public.trivia_tournaments_public TO anon, authenticated, service_role;

DO $$
BEGIN
    IF has_column_privilege('anon','public.trivia_tournaments','questions','SELECT')
       OR has_column_privilege('authenticated','public.trivia_tournaments','questions','SELECT') THEN
        RAISE EXCEPTION 'post-apply failed: tournament question roster remains browser-readable';
    END IF;
END $$;

COMMIT;

