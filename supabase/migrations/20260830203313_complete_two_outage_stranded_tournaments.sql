-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830203313; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- ═══════════════════════════════════════════════════════════════════════════
-- COMPLETE THE TWO TOURNAMENTS THE 2026-08-30 OUTAGE STRANDED IN COMPLETING
-- (Claude/Cowork audit — the position-collision review the watchdog asked for)
--
-- recoverStuckCompletingTournaments correctly refused both: survivors would
-- take places already held. Reviewed against the actual rosters:
--
-- 1. 0dc034bc "20 Chip Spin NLH" (pool 40, winner-take-all): the winner
--    (df9b5404…, place 1) is already paid 40. The lone survivor
--    (2a66bcd6…) finished 2nd; place 2 pays 0. No money moves.
--
-- 2. 56385309 "$100 Freeroll 6:00 AM" (pool 261): places 2..362 assigned
--    except 350; places 2-9 paid 182.70 total. Survivors: c0129701…
--    (3,994,298 chips, chip leader) takes place 1, owed 30% = 78.30 —
--    which completes the pool EXACTLY (182.70 + 78.30 = 261.00);
--    eaf09a18… (5,000 chips) takes the one open place, 350, which pays 0.
--
-- The place-1 credit uses the recovery watchdog's own idempotency key
-- (tourney:{id}:prize:place:1), so this cannot double-pay against any past
-- or future pass of that watchdog.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_moved boolean;
BEGIN
  IF (SELECT status FROM public.tournaments WHERE id='0dc034bc-5b71-4ef8-92a0-612a26a6d452') <> 'COMPLETING'
     OR (SELECT status FROM public.tournaments WHERE id='56385309-39ba-4b18-a1e3-8f714b6b6118') <> 'COMPLETING' THEN
    RAISE EXCEPTION 'state moved since review — re-audit before completing';
  END IF;
  IF (SELECT count(*) FROM public.tournament_players WHERE tournament_id='0dc034bc-5b71-4ef8-92a0-612a26a6d452' AND status='playing') <> 1
     OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id='56385309-39ba-4b18-a1e3-8f714b6b6118' AND status='playing') <> 2 THEN
    RAISE EXCEPTION 'survivor set moved since review — re-audit';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_players WHERE tournament_id='56385309-39ba-4b18-a1e3-8f714b6b6118' AND position IN (1,350)) THEN
    RAISE EXCEPTION 'places 1/350 no longer free — re-audit';
  END IF;

  -- 1. Spin survivor -> place 2 (pays 0), event complete.
  UPDATE public.tournament_players
     SET status='eliminated', position=2, prize=0, eliminated_at=now()
   WHERE id='f55707bd-5437-4cb7-b543-a6b58908be58' AND status='playing';

  -- 2a. Freeroll chip leader -> place 1, paid 78.30.
  v_moved := public.fn_credit_and_log(
    'c0129701-3117-4d31-a342-59bf5d2d31e2'::uuid, 78.30,
    'tourney:56385309-39ba-4b18-a1e3-8f714b6b6118:prize:place:1',
    'prize',
    'Tournament prize (recovery): position 1 — $100 Freeroll • 6:00 AM',
    '56385309-39ba-4b18-a1e3-8f714b6b6118'::uuid);
  IF NOT v_moved THEN
    RAISE EXCEPTION 'place-1 credit deduped — someone already paid this key; re-audit';
  END IF;
  UPDATE public.tournament_players
     SET status='winner', position=1, prize=78.30
   WHERE id='ddfff475-3a18-4a5e-a11b-d73f9a4d2187' AND status='playing';

  -- 2b. Freeroll short stack -> the one open place, 350 (pays 0).
  UPDATE public.tournament_players
     SET status='eliminated', position=350, prize=0, eliminated_at=now()
   WHERE id='95c56a3d-15c7-4eb1-8e71-41aef73df6cd' AND status='playing';

  -- Both events complete.
  UPDATE public.tournaments
     SET status='COMPLETED', ended_at=COALESCE(ended_at, now()), on_break=false, break_ends_at=NULL
   WHERE id IN ('0dc034bc-5b71-4ef8-92a0-612a26a6d452','56385309-39ba-4b18-a1e3-8f714b6b6118');

  -- Close any table still open under them.
  UPDATE public.tables SET status='closed'
   WHERE tournament_id IN ('0dc034bc-5b71-4ef8-92a0-612a26a6d452','56385309-39ba-4b18-a1e3-8f714b6b6118')
     AND status <> 'closed';

  -- Assertions: no survivors left, no missing places 1/350, pool fully paid.
  IF EXISTS (SELECT 1 FROM public.tournament_players
              WHERE tournament_id IN ('0dc034bc-5b71-4ef8-92a0-612a26a6d452','56385309-39ba-4b18-a1e3-8f714b6b6118')
                AND status IN ('playing','registered')) THEN
    RAISE EXCEPTION 'assertion failed: survivors remain';
  END IF;
  IF (SELECT coalesce(sum(prize),0) FROM public.tournament_players
       WHERE tournament_id='56385309-39ba-4b18-a1e3-8f714b6b6118') <> 261.00 THEN
    RAISE EXCEPTION 'assertion failed: freeroll prizes do not sum to the 261 pool';
  END IF;
END $$;

