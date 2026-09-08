-- ===========================================================================
--  A DAILY BONUS PAYS NOTHING IN CHIPS
-- ===========================================================================
--
-- Dan, 2026-09-05, verbatim: "NOTHING EVER 'EARNS CHIPS' ONLY EVER DIAMONDS.
-- MAKE SURE THATS THAT CASE GLOBALLY!" The referral paths were corrected that
-- day (20260905103510 / 20260905103839) and Daily Missions the same afternoon
-- (20260905114421). This is the third and last reward surface that still
-- credited chips, found while planning the Daily Club Arena Bonus (2026-09-07),
-- which replaces it.
--
-- WHAT WAS SITTING THERE
--
--   fn_claim_daily_bonus()            SECURITY DEFINER, granted to authenticated.
--                                     A 7-day ladder read from daily_bonus_rewards:
--                                     100, 150, 200, 300, 500 chips, 200 VIP
--                                     points, 1,000 chips - credited through
--                                     atomic_credit_wallet_and_log. Reachable
--                                     from the Promotions page wheel and the
--                                     Bonus page in the live bundle.
--   fn_daily_bonus_status()           Its read side.
--   claim_daily_bonus(uuid, numeric)  The older shape it replaced: takes the
--                                     AMOUNT as a parameter. service_role only,
--                                     kept "until nothing calls it" (M18).
--   fn_grant_daily_reward(uuid, num)  A wrapper that calls claim_daily_bonus.
--   fn_claim_special_bonus(uuid)      SECURITY DEFINER, granted to authenticated.
--                                     Credits special_bonuses.reward in chips.
--                                     No function or trigger has ever written a
--                                     special_bonuses row; the table is empty.
--   claim_lucky_wheel_spin(uuid)      Granted to authenticated. A free daily
--                                     spin whose segments include chips. The
--                                     component that would call it is imported
--                                     by no file. 0 spins ever.
--
-- MEASURED ON PRODUCTION 2026-09-07 (the guard below re-asserts every zero):
--
--   user_bonuses                                    0 rows
--   wallet_transactions "Daily login bonus"         0 rows, 0 chips
--   special_bonuses                                 0 rows, 0 claimed
--   wallet_transactions "Special bonus"             0 rows
--   user_lucky_wheel_spins                          0 rows
--
-- NOTHING HAS EVER BEEN PAID ON ANY OF THESE, so there is no restitution, no
-- clawback and no player who ever held a chip from them. That is why this is a
-- correction rather than an escalation (CLAUDE.md 10.9): the faucets are
-- closed before the first player finds them.
--
-- WHAT THIS DOES
--
--   1. Drops the daily ladder outright: both functions, both wrappers, the
--      payout table and the streak table. The Daily Club Arena Bonus (phase 1,
--      same programme) brings its own tables and RPCs, pays diamonds through
--      award_diamonds_v2, and grants throwables, rabbit hunts and time bank as
--      feature_purchases credits. Nothing of this shape is reused.
--   2. Drops fn_claim_special_bonus. special_bonuses stays (empty, SELECT-own
--      via RLS) but loses the write grants nothing should have had; there is no
--      longer any path that turns one of its rows into chips.
--   3. Closes the browser grant on claim_lucky_wheel_spin. The function itself
--      is left for the Diamond Wheel programme to replace or drop; a free spin
--      that pays chips must not be one PostgREST call away meanwhile.
--   4. Removes the dropped names from ca_money_rpc_registry so the drift scan
--      does not report ghosts.
--   5. Writes the record to financial_alerts, resolved, at info severity so
--      the incident layer files it and pushes nobody (info never pushes).
--
-- REVERSIBILITY: the ladder amounts are recorded above and in this file's
-- history; the tables held no player data. Nothing else is destroyed.
--
-- One transaction, per the production DDL policy in CLAUDE.md section 2.

BEGIN;

-- 0. The probe's world, asserted.
DO $guard$
DECLARE
  v_user_bonuses   bigint;
  v_daily_chip_tx  bigint;
  v_special_rows   bigint;
  v_special_tx     bigint;
  v_wheel_spins    bigint;
BEGIN
  SELECT count(*) INTO v_user_bonuses FROM public.user_bonuses;
  SELECT count(*) INTO v_daily_chip_tx
    FROM public.wallet_transactions WHERE description ILIKE 'Daily login bonus%';
  SELECT count(*) INTO v_special_rows FROM public.special_bonuses;
  SELECT count(*) INTO v_special_tx
    FROM public.wallet_transactions WHERE description ILIKE 'Special bonus%';
  SELECT count(*) INTO v_wheel_spins FROM public.user_lucky_wheel_spins;

  IF v_user_bonuses <> 0 OR v_daily_chip_tx <> 0 OR v_special_rows <> 0
     OR v_special_tx <> 0 OR v_wheel_spins <> 0 THEN
    RAISE EXCEPTION
      'ABORTING: a bonus surface has been used since this was measured '
      '(user_bonuses=%, daily_chip_tx=%, special_rows=%, special_tx=%, wheel_spins=%). '
      'Chips may now have reached a player. Re-read the surface and settle before '
      'dropping it.',
      v_user_bonuses, v_daily_chip_tx, v_special_rows, v_special_tx, v_wheel_spins;
  END IF;
END;
$guard$;

-- 1. The daily ladder goes, whole.
DROP FUNCTION IF EXISTS public.fn_claim_daily_bonus();
DROP FUNCTION IF EXISTS public.fn_daily_bonus_status();
DROP FUNCTION IF EXISTS public.fn_grant_daily_reward(uuid, numeric);
DROP FUNCTION IF EXISTS public.claim_daily_bonus(uuid, numeric);
DROP TABLE IF EXISTS public.daily_bonus_rewards;
DROP TABLE IF EXISTS public.user_bonuses;

-- 2. Special bonuses lose their chip path and their stray write grants.
DROP FUNCTION IF EXISTS public.fn_claim_special_bonus(uuid);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.special_bonuses FROM anon, authenticated;

COMMENT ON TABLE public.special_bonuses IS
  'Dormant. No function or trigger writes it and fn_claim_special_bonus was '
  'dropped on 2026-09-07 because it credited chips (Dan 2026-09-05: nothing ever '
  'earns chips, only diamonds). Player-visible reward surfaces are Daily Missions '
  'and the Daily Club Arena Bonus, both paid in diamonds through award_diamonds_v2.';

-- 3. The free wheel spin is not one browser call away from minting chips.
REVOKE EXECUTE ON FUNCTION public.claim_lucky_wheel_spin(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_lucky_wheel_spin(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.claim_lucky_wheel_spin(uuid) FROM authenticated;

COMMENT ON FUNCTION public.claim_lucky_wheel_spin(uuid) IS
  'service_role only since 2026-09-07: its segments pay chips and nothing ever '
  'earns chips (Dan 2026-09-05). Never spun (user_lucky_wheel_spins was empty) '
  'and rendered by no file. The Diamond Wheel programme replaces it.';

-- 4. No ghosts in the drift scan.
DELETE FROM public.ca_money_rpc_registry
 WHERE proname IN ('fn_claim_daily_bonus', 'fn_daily_bonus_status',
                   'fn_grant_daily_reward', 'claim_daily_bonus',
                   'fn_claim_special_bonus');

-- 5. The written record.
INSERT INTO public.financial_alerts (severity, source, message, context, resolved, resolved_at, resolution)
VALUES (
  'info',
  'daily_bonus_chip_ladder',
  'Three reward paths still credited chips after the 2026-09-05 diamonds-only '
  'ruling: the 7-day daily login ladder (2,250 chips and 200 VIP points per '
  'cycle, browser-callable from Promotions and Bonuses), the special bonus '
  'claim, and the free lucky wheel spin. None had ever paid.',
  jsonb_build_object(
    'measured_on', '2026-09-07',
    'ladder_chips_per_cycle', 2250,
    'ladder_vip_points_per_cycle', 200,
    'daily_claims_ever', 0,
    'special_bonus_rows_ever', 0,
    'wheel_spins_ever', 0,
    'dropped', jsonb_build_array(
      'fn_claim_daily_bonus', 'fn_daily_bonus_status', 'fn_grant_daily_reward',
      'claim_daily_bonus', 'fn_claim_special_bonus',
      'daily_bonus_rewards', 'user_bonuses'),
    'closed', jsonb_build_array('claim_lucky_wheel_spin'),
    'migration', 'a_daily_bonus_pays_nothing_in_chips'
  ),
  true,
  now(),
  'Resolved by this migration. The daily ladder is dropped and replaced by the '
  'Daily Club Arena Bonus, which pays diamonds and consumable credits only.'
);

COMMIT;
