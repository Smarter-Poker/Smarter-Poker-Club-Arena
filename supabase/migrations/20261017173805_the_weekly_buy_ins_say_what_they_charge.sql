-- 20261017173805_the_weekly_buy_ins_say_what_they_charge.sql
--
-- THE WEEKLY BUY-INS SAY WHAT THEY CHARGE (2026-10-17).
--
-- The scheduler never charges a weekly event's configured buyIn as written.
-- ScheduledTournamentService passes it through buyInFor -> snapToWholeBuyIn,
-- so a figure that is not a BUY_IN_LADDER rung is repriced to the nearest one:
-- the 1.1x figures these rows carry (5.5, 8.8, 11, 16.5, 22, 33, 44, 55, 77,
-- 109, 3.3) are charged as 5, 10, 10, 15, 20, 30, 50, 50, 75, 100 and 3.
--
-- That mattered twice on 2026-10-17:
--   1. The Nightly 10K, which Dan priced at 35 ("A DAILY 7PM TOURNAMENT THAT
--      IS A 35 REBUY ADD ON WITH A 10K GUARANTEE"), would have been charged
--      30, because 35 was not a rung. 35 is a rung now (server/src/config/
--      buyIn.ts and src/utils/buyIn.ts, in the same change).
--   2. With 35 on the ladder, every 33 would have snapped UP to 35 instead of
--      30, repricing eighteen events in each club that nobody asked to move.
--
-- So every active weekly row in the Midway Union and the Diamond Arena now
-- carries the price it is actually charged, computed against the ladder as it
-- stood before 35 was added. Nothing a player pays changes except the Nightly
-- 10K, which goes from 30 to the 35 Dan set. The Diamond Arena's rows are the
-- same chip figures; the arena prices them at ten Diamonds a chip in the
-- engine (diamondScheduledSpawn.ts, DIAMOND_ARENA_DIAMONDS_PER_CHIP).
--
-- Rebuy and add-on costs are left alone: they are charged whole, not snapped.
-- Occurrences already spawned keep the price they were created with.
--
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.tournament_schedules s WHERE s.active AND s.club_id IN ('fade0000-0000-0000-0000-000000000001', '002c2d27-9584-4e52-835a-bb2be148fc81') AND COALESCE(s.config->>'type', '') <> 'fixed_board' AND s.config ? 'buyIn' AND NOT ((s.config->>'buyIn')::numeric = ANY (ARRAY[0, 1, 2, 3, 5, 10, 15, 20, 25, 30, 35, 50, 75, 100, 150, 200, 250, 300, 500, 750, 1000, 1500, 2000, 5000]::numeric[]))) AND (SELECT count(*) FROM public.tournament_schedules s WHERE s.active AND s.name = 'Nightly 10K (NLH)' AND (s.config->>'buyIn')::numeric = 35) = 2)
--
-- No DDL. One transaction.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  c_midway CONSTANT uuid := 'fade0000-0000-0000-0000-000000000001';
  c_arena  CONSTANT uuid := '002c2d27-9584-4e52-835a-bb2be148fc81';
  v_n integer;
  v_left text;
BEGIN
  WITH charged(was, now) AS (VALUES
    (3.3::numeric, 3::numeric), (5.5, 5), (8.8, 10), (11, 10), (16.5, 15), (22, 20),
    (33, 30), (44, 50), (55, 50), (77, 75), (109, 100))
  UPDATE public.tournament_schedules s
     SET config = jsonb_set(s.config, '{buyIn}', to_jsonb(c.now)), updated_at = now()
    FROM charged c
   WHERE s.active
     AND s.club_id IN (c_midway, c_arena)
     AND COALESCE(s.config->>'type', '') <> 'fixed_board'
     AND (s.config->>'buyIn')::numeric = c.was;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 140 THEN
    RAISE EXCEPTION 'expected to restate 140 weekly buy-ins (70 in each club), restated %', v_n;
  END IF;

  -- Every active weekly buy-in is now a rung, and the Nightly 10K is 35 in both clubs.
  SELECT string_agg(s.name || ' ' || (s.config->>'buyIn'), ', ') INTO v_left
    FROM public.tournament_schedules s
   WHERE s.active AND s.club_id IN (c_midway, c_arena)
     AND COALESCE(s.config->>'type', '') <> 'fixed_board'
     AND s.config ? 'buyIn'
     AND NOT ((s.config->>'buyIn')::numeric = ANY (ARRAY[0, 1, 2, 3, 5, 10, 15, 20, 25, 30, 35,
       50, 75, 100, 150, 200, 250, 300, 500, 750, 1000, 1500, 2000, 5000]::numeric[]));
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'weekly buy-ins still off the ladder: %', v_left;
  END IF;
  SELECT count(*) INTO v_n FROM public.tournament_schedules s
   WHERE s.active AND s.club_id IN (c_midway, c_arena)
     AND s.name = 'Nightly 10K (NLH)' AND (s.config->>'buyIn')::numeric = 35;
  IF v_n <> 2 THEN RAISE EXCEPTION 'expected the Nightly 10K at 35 in both clubs, found %', v_n; END IF;
END $$;

COMMIT;
