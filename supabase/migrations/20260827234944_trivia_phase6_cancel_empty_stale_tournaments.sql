-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827234944; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Retire abandoned empty tournament shells without touching any tournament
-- that accepted an entry, collected a fee, or built a prize pool.
BEGIN;

UPDATE public.trivia_tournaments t
   SET status = 'cancelled',
       completed_at = COALESCE(completed_at, now())
 WHERE status = 'active'
   AND COALESCE(ends_at,end_time) < now() - interval '7 days'
   AND COALESCE(current_players,0) = 0
   AND COALESCE(prize_pool,0) = 0
   AND NOT EXISTS (
       SELECT 1 FROM public.trivia_tournament_entries e
        WHERE e.tournament_id = t.id
   );

COMMIT;

