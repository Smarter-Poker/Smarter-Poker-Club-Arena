-- THE PHANTOM PROMO POOL IS RETIRED, AND ITS DOORS ARE SHUT.
--
-- 2026-09-03, Dan: "FIX ALL OF THESE FULLY SO WE CAN MOVE ON, YOU DECIDE HOW
-- THEY NEED TO BE BUILT AND FIXED." And the standard behind it: "WE SHOULDN'T
-- NEED THOSE DETECTORS OR WATCH DOGS IF YOU FIX THIS ALL AND MAKE IT SO ITS
-- IMPOSSIBLE TO EVER LOSE A CHIP... WE MUST BE PERFECT."
--
-- wallets(wallet_type='PROMO') holds 10,700.00 across 107 holders in 447 rows.
-- It is a phantom in the strict sense: no function in the database reads it,
-- fn_ca_supply_snapshot has never counted it, and so those chips have never
-- existed inside the measured supply. They came from create_user_wallets, a
-- signup trigger function that handed every new account a 100-chip "welcome
-- bonus" into that pool. Its trigger was detached at some point - the function
-- is orphaned, which is why the last row was written 2026-01-24 - but the
-- function survives, ready to seed phantoms again if anything re-attaches it.
--
-- HOW THIS IS RETIRED, AND WHY NOT AS A BURN. A burn row would tell the chip
-- meter that 10,700 real chips left circulation. They never entered it. The
-- honest record is a write-off of a number that was never money: the balances
-- go to zero, an audit row says so, and chip_ledger is not touched. Journalling
-- a burn would have invented 10,700 of apparent issuance error in the very
-- accounts this programme exists to make exact.
--
-- WHY THE ROWS STAY. A first attempt deleted them and was refused by
-- chip_escrow_holds_wallet_id_fkey: 40 legacy escrow holds from 2026-08-15/16,
-- 715,000 chips of them, still point at PROMO wallet rows. chip_escrow_holds is
-- already on the Phase 3 retirement list and is not this migration's business,
-- so the balances are zeroed and the row skeletons left in place.
--
-- WHY THE GUARD IS OPENED BY NAME. A second attempt was refused by
-- guard_wallet_balance_write, which forbids direct balance mutation on wallets
-- and names its own override. That guard is right: this is precisely the kind
-- of write it exists to stop, and the only reason it is legitimate here is that
-- the balance being cleared is not money. So the override is set explicitly,
-- for one statement, and cleared immediately - the same discipline as the
-- append-only maintenance door used for the certification fixtures.
--
-- THE DOORS. Four functions still write or pretend to write promo, all against
-- Dan's rulings and none of them funded:
--
--   add_to_promo_wallet         the only writer of the phantom pool. Called by
--                               PromotionService (deposit bonus, referral bonus)
--                               and AchievementService (chip rewards) - three
--                               product features paying into a pool nobody can
--                               spend from.
--   distribute_promo_chips      reads agents.promo_balance, a column no sweep
--                               maintains (0.00 estate-wide); the sweep fills
--                               promo_wallet_balance instead.
--   transfer_promo_club_to_agent  credits a member's locked promo bucket, which
--                               ruling 4B says is not a thing.
--   create_user_wallets         the orphaned phantom seeder above.
--
-- Each now refuses and names the sanctioned path. That is deliberate rather
-- than a rewrite: a deposit bonus, a referral bonus and an achievement reward
-- are real product promises, but none has a funded source, and inventing one
-- here would be the unfunded mint this programme has spent two phases removing.
-- They pay nothing today - the pool is unspendable - so refusing changes no
-- player's position and stops the pretence. When those programmes are designed
-- and funded, fn_promo_disburse is the door.

DO $retire$
DECLARE
  v_rows    integer;
  v_total   numeric;
  v_holders integer;
BEGIN
  SELECT count(*), round(COALESCE(sum(balance), 0), 2),
         count(DISTINCT user_id) FILTER (WHERE balance > 0)
    INTO v_rows, v_total, v_holders
    FROM public.wallets WHERE wallet_type = 'PROMO';

  IF COALESCE(v_total, 0) = 0 THEN
    RAISE NOTICE 'PHANTOM_PROMO: nothing to retire';
    RETURN;
  END IF;

  /* Refuse to run if anything ever started reading this pool: a phantom with a
     reader is not a phantom, and retiring it would then be a real loss. */
  IF EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.prosrc ~ 'wallet_type\s*=\s*''PROMO'''
       AND p.proname <> 'add_to_promo_wallet') THEN
    RAISE EXCEPTION 'PHANTOM_PROMO: something now reads wallets(PROMO); this retirement is no longer safe';
  END IF;

  INSERT INTO public.financial_alerts (severity, source, message, context)
  VALUES ('warning', 'phantom_promo_retirement',
    format('Retired the phantom promo pool: %s rows, %s chips across %s holders, written by the '
           || 'orphaned create_user_wallets welcome bonus and never inside the measured supply. '
           || 'Balances zeroed under an explicit, one-statement wallet-guard override; rows kept '
           || 'because 40 legacy chip_escrow_holds still reference them. Not journalled as a '
           || 'burn: these chips never entered circulation, and a burn row would have invented '
           || 'the same figure as issuance error.',
           v_rows, v_total, v_holders),
    jsonb_build_object('rows', v_rows, 'total', v_total, 'holders', v_holders,
                       'ruling', 'Dan 2026-09-03: promo owes nobody anything ever',
                       'ledger_touched', false, 'rows_deleted', false,
                       'guard_override', 'app.bypass_wallet_guard, one statement'));

  PERFORM set_config('app.bypass_wallet_guard', 'on', true);
  UPDATE public.wallets
     SET balance = 0, locked_balance = 0, updated_at = now()
   WHERE wallet_type = 'PROMO'
     AND (COALESCE(balance, 0) <> 0 OR COALESCE(locked_balance, 0) <> 0);
  PERFORM set_config('app.bypass_wallet_guard', '', true);

  RAISE NOTICE 'PHANTOM_PROMO_RETIRED: % rows, % chips, % holders', v_rows, v_total, v_holders;
END
$retire$;

-- ── the doors ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.add_to_promo_wallet(p_user_id uuid, p_amount numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  RAISE EXCEPTION
    'add_to_promo_wallet is retired: it wrote wallets(PROMO), a pool nothing reads and the chip '
    'supply never counted. A deposit bonus, referral bonus or achievement reward needs a funded '
    'source before it can pay; promo is disbursed by owners through fn_promo_disburse, and '
    'leaderboards are the only automatic promo payout. (Dan, 2026-09-03.)'
    USING ERRCODE = 'raise_exception';
END;
$function$;

CREATE OR REPLACE FUNCTION public.distribute_promo_chips(
  p_agent_id uuid, p_player_id uuid, p_amount numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  RAISE EXCEPTION
    'distribute_promo_chips is retired: it debited agents.promo_balance, a column no sweep '
    'maintains and which is 0.00 estate-wide. Promo is disbursed by the union owner, or by an '
    'unaffiliated club owner, through fn_promo_disburse. (Dan, 2026-09-03.)'
    USING ERRCODE = 'raise_exception';
END;
$function$;

CREATE OR REPLACE FUNCTION public.transfer_promo_club_to_agent(
  p_club_id uuid, p_agent_user_id uuid, p_amount numeric, p_note text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  RETURN jsonb_build_object(
    'success', false,
    'error', 'retired',
    'detail', 'This credited a member''s locked promo bucket. Promo chips are ordinary chips '
              || '(Dan, 2026-09-03, ruling 4B); an owner disburses them with fn_promo_disburse.');
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_user_wallets()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  /* Orphaned long before this migration - no trigger has pointed here for
     months - but it seeded every new account with a 100-chip phantom promo
     balance and 1,000 phantom player chips in wallets, a table outside the chip
     supply. Left inert rather than dropped so that re-attaching it is a no-op
     instead of a fresh phantom. A new account's chips come from its club, and a
     club's chips come from the Mint. */
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.add_to_promo_wallet(uuid, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.distribute_promo_chips(uuid, uuid, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.transfer_promo_club_to_agent(uuid, uuid, numeric, text) FROM PUBLIC, anon, authenticated;

-- Self-check: the pool is at zero, the guard is closed again, and each door refuses.
DO $selfcheck$
DECLARE
  v_left numeric;
  v_ok   boolean;
BEGIN
  SELECT round(COALESCE(sum(balance), 0) + COALESCE(sum(locked_balance), 0), 2) INTO v_left
    FROM public.wallets WHERE wallet_type = 'PROMO';
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'PHANTOM_PROMO_SELFCHECK: % chips survived', v_left;
  END IF;

  IF COALESCE(current_setting('app.bypass_wallet_guard', true), '') = 'on' THEN
    RAISE EXCEPTION 'PHANTOM_PROMO_SELFCHECK: the wallet guard was left open';
  END IF;

  BEGIN
    PERFORM public.add_to_promo_wallet('00000000-0000-0000-0000-000000000000'::uuid, 1);
    RAISE EXCEPTION 'PHANTOM_PROMO_SELFCHECK: add_to_promo_wallet did not refuse';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'PHANTOM_PROMO_SELFCHECK%' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.distribute_promo_chips('00000000-0000-0000-0000-000000000000'::uuid,
                                          '00000000-0000-0000-0000-000000000000'::uuid, 1);
    RAISE EXCEPTION 'PHANTOM_PROMO_SELFCHECK: distribute_promo_chips did not refuse';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'PHANTOM_PROMO_SELFCHECK%' THEN RAISE; END IF;
  END;

  SELECT COALESCE((public.transfer_promo_club_to_agent(
            '00000000-0000-0000-0000-000000000000'::uuid,
            '00000000-0000-0000-0000-000000000000'::uuid, 1, 'self-check') ->> 'success')::boolean, true)
    INTO v_ok;
  IF v_ok THEN
    RAISE EXCEPTION 'PHANTOM_PROMO_SELFCHECK: transfer_promo_club_to_agent did not refuse';
  END IF;

  RAISE NOTICE 'PHANTOM_PROMO_SELFCHECK_OK: the pool is retired and every door refuses';
END
$selfcheck$;