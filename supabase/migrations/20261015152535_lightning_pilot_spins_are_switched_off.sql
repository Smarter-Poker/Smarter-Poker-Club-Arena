-- RULING. Dan, 2026-10-15 10:23 Central, in his own words: "turn off Spins in
-- the pilot club" (with the cash roster swap and Stage 1/2 in the same approval).
--
-- WHY. The Lightning Internal Pilot opened with Spins enabled by default
-- (fn_create_club_atomic), so once its horses were admitted the recurring board
-- ran 1-chip Spins inside the pilot: about 400 by 09:30 UTC and 41 live at 15:25
-- UTC. Spins seats count toward each horse's four-game limit, so the pilot's
-- "both"-lane horses were absorbed by Spins and could not fill the cash games
-- Phase 3 needs at 18 / 27 live.
--
-- CHANGE. The maintained door fn_spin_deactivate(pilot, owner): the pilot's
-- spin_bonus_pools row goes inactive (the recurring board stops creating pilot
-- Spins), clubs.spins_enabled goes false, and the outstanding seed returns to the
-- pilot treasury only once every live pilot Spin has settled, through the door's
-- own declared ledger leg. Live Spins finish and pay normally. No other club, no
-- game, no Lightning control changes.
-- @live-proof: (SELECT NOT is_active FROM public.spin_bonus_pools WHERE club_id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d') AND (SELECT NOT spins_enabled FROM public.clubs WHERE id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d')

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $spins$
DECLARE v jsonb; v_other_active int;
BEGIN
  SELECT count(*) INTO v_other_active FROM public.spin_bonus_pools
   WHERE is_active AND club_id <> 'e14bc9f7-736d-425f-8f2c-e78305ebac1d';

  v := public.fn_spin_deactivate('e14bc9f7-736d-425f-8f2c-e78305ebac1d'::uuid,
                                 '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);
  IF coalesce(v->>'ok', '') <> 'true' THEN
    RAISE EXCEPTION 'pilot Spins deactivation refused: %', v;
  END IF;
  IF (SELECT is_active FROM public.spin_bonus_pools WHERE club_id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d') THEN
    RAISE EXCEPTION 'the pilot Spin pool is still active';
  END IF;
  IF (SELECT spins_enabled FROM public.clubs WHERE id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d') THEN
    RAISE EXCEPTION 'the pilot club still has Spins enabled';
  END IF;
  IF (SELECT count(*) FROM public.spin_bonus_pools
       WHERE is_active AND club_id <> 'e14bc9f7-736d-425f-8f2c-e78305ebac1d') <> v_other_active THEN
    RAISE EXCEPTION 'another club''s Spin pool changed state';
  END IF;
END $spins$;

COMMIT;
