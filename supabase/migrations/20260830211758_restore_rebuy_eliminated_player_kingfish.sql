-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830211758; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- A paid rebuy (21:13:57.405) was overrun by the bust sweep (21:13:57.911),
-- which eliminated the player off the pre-rebuy zero-stack snapshot and freed
-- the seat. The 200 was charged and the 30,000 chips stand on the row.
-- Restore the entrant; the engine's late-reg seating sweep re-seats anyone
-- 'registered'/'playing' without a seat within its next pass.
DO $$
BEGIN
  IF (SELECT status FROM public.tournaments WHERE id='dfae9288-40e2-485d-8c97-a13dd53ab483') <> 'RUNNING' THEN
    RAISE EXCEPTION 'tournament no longer RUNNING — do not restore into a settled event';
  END IF;
  UPDATE public.tournament_players
     SET status='playing', position=NULL, eliminated_at=NULL
   WHERE id='c9866293-0af7-48a0-804a-468187374093'
     AND status='eliminated' AND chips=30000 AND prize=0;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'row moved since review — re-audit before restoring';
  END IF;
END $$;

