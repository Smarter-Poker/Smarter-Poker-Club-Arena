-- 20261015053941_lightning_pilot_horses_are_funded_to_the_fleet_bankroll_floor.sql
--
-- Within Dan's 2026-10-14 ruling ("admit 72 horses, and fund them from its
-- treasury"). 20261015032740 funded the 72 pilot horses to 40 chips each, and
-- that was too little to sit: after it installed (05:32 UTC) the fleet seated
-- nobody, and the 05:38:11 heartbeat recorded 531 seat_refused_underrolled.
--
-- Cause, read from the code: the fleet sits a horse only when its club roll is
-- at least buyInsToSit reference buy-ins (HorseBankroll.ts canSit): nit 40,
-- standard 25, gambler 12. The reference buy-in is 2.00 at the 6-max
-- (0.01/0.02) and 4.00 at the 9-max (0.02/0.04), so a nit needs 160 chips for
-- the 9-max and NO horse could ever sit there with 40.
--
-- Change: top every pilot horse up to 200 chips through fn_seed_horses_to_floor
-- from the pilot's own treasury, the same declared horse_funding leg. 200
-- covers every temperament at both sizes, and for a horse with no live seat
-- elsewhere the aggregate exposure ceiling (roll x fraction x 4: nit 24.0) is
-- above any pilot buy-in. Measured in a rolled-back probe at 05:39 UTC: 72
-- horses, 11,534.00 chips, treasury 96,820.00 -> 85,286.00. The apply asserts
-- conservation and the per-horse result rather than that constant, because a
-- seated horse's balance can move between the probe and the apply.
--
-- Horses are players (CLAUDE.md 10.5): this is the same bankroll rule a horse
-- meets in every house club. No game, policy or Lightning state changes.

-- @live-proof: EXISTS (SELECT 1 FROM public.chip_transactions WHERE club_id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d' AND transaction_type = 'horse_treasury_funding' AND balance_after = 200)

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $fund$
DECLARE r record; v_before numeric; v_after numeric; v_short int; v_others int;
BEGIN
  SELECT chip_treasury INTO v_before FROM public.clubs WHERE id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d';
  SELECT count(*) INTO v_others
    FROM public.club_members m LEFT JOIN public.profiles p ON p.id = m.user_id
   WHERE m.club_id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d'
     AND NOT COALESCE(p.is_horse, false)
     AND m.user_id <> '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
  IF v_others <> 0 THEN
    RAISE EXCEPTION 'the pilot holds % non-owner humans; refusing to fund', v_others;
  END IF;

  SELECT * INTO r FROM public.fn_seed_horses_to_floor('e14bc9f7-736d-425f-8f2c-e78305ebac1d', 200);
  SELECT chip_treasury INTO v_after FROM public.clubs WHERE id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d';

  IF r.horses_funded > 72 OR r.chips_moved > 72 * 200 OR r.chips_moved <= 0 THEN
    RAISE EXCEPTION 'pilot top-up out of bounds: % horses, % chips', r.horses_funded, r.chips_moved;
  END IF;
  IF v_before - v_after <> r.chips_moved OR r.treasury_after <> v_after THEN
    RAISE EXCEPTION 'conservation broken: treasury % -> %, moved %', v_before, v_after, r.chips_moved;
  END IF;
  SELECT count(*) INTO v_short
    FROM public.club_members m JOIN public.profiles p ON p.id = m.user_id
   WHERE m.club_id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d' AND p.is_horse AND m.chip_balance < 200;
  IF v_short <> 0 THEN
    RAISE EXCEPTION '% pilot horses remain under the 200 floor', v_short;
  END IF;
  IF (SELECT count(*) FROM public.club_members m JOIN public.profiles p ON p.id = m.user_id
       WHERE m.club_id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d' AND p.is_horse) <> 72 THEN
    RAISE EXCEPTION 'the pilot no longer holds exactly 72 horses';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cash_games
              WHERE club_id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d'
                AND name LIKE 'Lightning Pilot%'
                AND (lightning_enabled OR cluster_mode <> 'must_move')) THEN
    RAISE EXCEPTION 'a pilot game changed Lightning state; this migration must not activate anything';
  END IF;
END $fund$;

COMMIT;
