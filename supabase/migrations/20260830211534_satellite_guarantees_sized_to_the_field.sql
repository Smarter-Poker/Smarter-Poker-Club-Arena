-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830211534; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- ═══════════════════════════════════════════════════════════════════════════
-- SATELLITE GUARANTEES SIZED TO THE FIELD (2026-08-30 audit, phase 2)
--
-- The Sunday Deep Stack satellite templates promised seats their real fields
-- never fund: the $25 promised 5 seats (1,000 chips) against typical 540
-- pools (overlay 460/event, daily), the $10 promised 2 (400) against 216
-- (overlay 184/event). The $5 was already right-sized at 1.
--
-- Templates change; PROMISES DO NOT: already-spawned open events keep the
-- seat counts their lobby copy advertised. Only future spawns pick this up.
-- Alongside this, satelliteAwardPlan.ts makes the guarantee a FLOOR rather
-- than a cap, so a big field funds extra seats beyond the guarantee instead
-- of dumping the surplus as cash.
--
--   $25: 5 -> 3 seats  (typical 540 pool funds 2.7; house tops to 3)
--   $10: 2 -> 1 seat   (typical 216 pool funds 1.08)
-- ═══════════════════════════════════════════════════════════════════════════
UPDATE public.tournament_schedules
   SET config = config
       || jsonb_build_object('satelliteSeats', 3,
            'shortDescription', 'Win A Seat In The Sunday $200 Deep Stack. 3 Seats Guaranteed.'),
       description = 'Shortest road in. A typical field funds three seats; bigger fields fund more.',
       updated_at = now()
 WHERE id = 'b0b18d55-26de-428c-a016-6963e67433fe';

UPDATE public.tournament_schedules
   SET config = config
       || jsonb_build_object('satelliteSeats', 1,
            'shortDescription', 'Win A Seat In The Sunday $200 Deep Stack. 1 Seat Guaranteed.'),
       updated_at = now()
 WHERE id = 'e7ffa8ec-1748-4c3b-9a83-f4cc2de40ea4';

DO $$
BEGIN
  IF (SELECT config->>'satelliteSeats' FROM public.tournament_schedules WHERE id='b0b18d55-26de-428c-a016-6963e67433fe') <> '3'
     OR (SELECT config->>'satelliteSeats' FROM public.tournament_schedules WHERE id='e7ffa8ec-1748-4c3b-9a83-f4cc2de40ea4') <> '1' THEN
    RAISE EXCEPTION 'template update did not land';
  END IF;
  -- Open events keep their advertised guarantees — assert untouched.
  IF EXISTS (SELECT 1 FROM public.tournaments
              WHERE schedule_id='b0b18d55-26de-428c-a016-6963e67433fe'
                AND status IN ('REGISTERING','ANNOUNCED','RUNNING')
                AND satellite_seats <> 5) THEN
    RAISE EXCEPTION 'an open $25 satellite lost its advertised guarantee';
  END IF;
END $$;

