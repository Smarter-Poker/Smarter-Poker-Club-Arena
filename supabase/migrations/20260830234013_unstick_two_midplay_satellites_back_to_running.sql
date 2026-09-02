-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830234013; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- Two satellites sat in COMPLETING with live fields (a22d18f3: 3 playing,
-- ccb686f8: all 24 playing, zero hands) — flipped there without a decision,
-- and the recovery watchdog rightly refuses to pay structure cash on a
-- satellite, so they looped forever with no manager and no hands. A satellite
-- that is not decided is not completing: back to RUNNING, where discovery
-- resumes a manager and play finishes properly (awards then run through the
-- normal finish, conserved).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id, name FROM public.tournaments
            WHERE id IN ('a22d18f3-ec67-4a77-973b-ab729a8ea34f',
                         'ccb686f8-79f5-462f-a855-390e4c42c793')
              AND status = 'COMPLETING'
  LOOP
    IF (SELECT count(*) FROM public.tournament_players
         WHERE tournament_id = r.id AND status IN ('playing','registered')) < 2 THEN
      RAISE EXCEPTION '% is actually decided — do not revive it', r.id;
    END IF;
    IF EXISTS (SELECT 1 FROM public.wallet_transactions
                WHERE related_entity_id = r.id AND category = 'prize') THEN
      RAISE EXCEPTION '% already paid prizes — do not revive it', r.id;
    END IF;
    UPDATE public.tournaments SET status = 'RUNNING' WHERE id = r.id;
  END LOOP;
  IF (SELECT count(*) FROM public.tournaments WHERE status='COMPLETING'
       AND id IN ('a22d18f3-ec67-4a77-973b-ab729a8ea34f','ccb686f8-79f5-462f-a855-390e4c42c793')) > 0 THEN
    RAISE EXCEPTION 'revive did not land';
  END IF;
END $$;

