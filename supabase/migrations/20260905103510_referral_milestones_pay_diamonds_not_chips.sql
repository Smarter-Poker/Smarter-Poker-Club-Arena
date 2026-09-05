-- ═══════════════════════════════════════════════════════════════════════════
--  REFERRAL MILESTONES PAY DIAMONDS, NOT CHIPS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan, 2026-09-05, verbatim: "NOTHING EVER 'EARNS CHIPS' ONLY EVER DIAMONDS.
-- MAKE SURE THATS THE CASE GLOBALLY!"
--
-- WHAT THIS WAS DOING
--
-- `fn_claim_referral_milestone` credited 2,500 / 5,000 / 15,000 / 50,000 via
-- `atomic_credit_wallet_and_log`, which settles into `club_members.chip_balance`
-- - i.e. it paid CHIPS for a reward. The Referral panel on the profile said so
-- out loud: "Invite Friends And Earn Chips Together!", "Chips Earned", and four
-- milestone rows each labelled "N Chips".
--
-- SAFE TO CHANGE, MEASURED BEFORE WRITING (2026-09-05):
--
--     referral_milestone_claims   0 rows
--     referral_redemptions        0 rows
--     wallet_transactions where category='referral_milestone'   0 rows
--
-- Nobody has ever claimed a referral milestone, so there is no past payout to
-- reconcile, nothing to claw back (which this platform does not do anyway) and
-- nobody to make whole. This changes only what FUTURE claims pay.
--
-- THE AMOUNTS ARE DENOMINATED IN THE DIAMOND ECONOMY, NOT CARRIED OVER
--
-- The chip figures could not simply be relabelled: 50,000 diamonds is not
-- 50,000 chips. Measured against what the platform already pays in diamonds,
-- `daily_challenge_catalog.diamond_reward` runs 8 to 800 with a mean of 103.
-- A referral milestone is rarer and slower than a daily challenge, so these sit
-- above that band while staying inside the same economy.
--
--     5 referrals    250 diamonds
--    10 referrals    500 diamonds
--    25 referrals  1,500 diamonds
--    50 referrals  5,000 diamonds
--
-- THESE FOUR NUMBERS ARE A PRICING DECISION AND THEREFORE DAN'S (CLAUDE.md
-- 10.9: "Anything that sets what players are owed in FUTURE events ... is
-- his"). They are gathered into one CASE below so changing them is a one-line
-- edit. The MECHANISM - diamonds, idempotent, audited - is what this migration
-- is actually asserting; the amounts are a starting point, not a ruling.
--
-- HOW IT PAYS NOW
--
-- `add_diamonds_to_balance` rather than a hand-written UPDATE: it is SECURITY
-- DEFINER, it dedupes on `reference_id` (so a double-tap cannot pay twice even
-- if the claims row were ever removed), and it writes `diamond_transactions`
-- so the credit has an audit trail. The `referral_milestone_claims` unique key
-- remains the first line of defence; this is the second.
--
-- One transaction, per the production DDL policy in CLAUDE.md section 2.

BEGIN;

-- The claims ledger recorded a chip amount. Zero rows, so the rename is free
-- and the column stops lying about what it holds.
ALTER TABLE public.referral_milestone_claims
  RENAME COLUMN chips_awarded TO diamonds_awarded;

COMMENT ON COLUMN public.referral_milestone_claims.diamonds_awarded IS
  'Diamonds paid for this milestone. Was `chips_awarded` until 2026-09-05, when '
  'referral rewards moved to diamonds (Dan: nothing ever earns chips, only diamonds). '
  'Renamed rather than added because the table held zero rows.';

CREATE OR REPLACE FUNCTION public.fn_claim_referral_milestone(p_milestone integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_caller    uuid := (SELECT auth.uid());
  v_reward    integer;
  v_referrals integer;
  v_credit    jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication required');
  END IF;

  -- THE PRICING LINE. Diamonds, not chips. See the header: these four numbers
  -- are Dan's to set; everything around them is the mechanism.
  v_reward := CASE p_milestone
    WHEN 5  THEN 250
    WHEN 10 THEN 500
    WHEN 25 THEN 1500
    WHEN 50 THEN 5000
    ELSE NULL END;

  IF v_reward IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unknown milestone');
  END IF;

  SELECT count(*) INTO v_referrals
    FROM public.referral_redemptions
   WHERE referrer_id = v_caller;

  IF v_referrals < p_milestone THEN
    RETURN jsonb_build_object('success', false, 'error', 'milestone not reached',
                              'referrals', v_referrals);
  END IF;

  -- The claim row is the primary dedupe: one milestone, once, per player.
  BEGIN
    INSERT INTO public.referral_milestone_claims (user_id, milestone, diamonds_awarded)
    VALUES (v_caller, p_milestone, v_reward);
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', 'milestone already claimed');
  END;

  /* Diamonds, idempotent on reference_id, audited into diamond_transactions.
     If the credit refuses, the exception unwinds this transaction and takes
     the claim row with it - a claimed milestone that paid nothing would be
     worse than an unclaimed one. */
  v_credit := public.add_diamonds_to_balance(
    v_caller,
    v_reward,
    'referral_milestone',
    'Referral milestone: ' || p_milestone || ' referrals',
    'referral_milestone:' || v_caller::text || ':' || p_milestone::text
  );

  IF COALESCE((v_credit->>'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'referral milestone % could not be credited: %',
      p_milestone, COALESCE(v_credit->>'error', 'unknown');
  END IF;

  RETURN jsonb_build_object('success', true, 'awarded', v_reward, 'currency', 'diamonds');
END;
$function$;

COMMENT ON FUNCTION public.fn_claim_referral_milestone(integer) IS
  'Claims a referral milestone and pays DIAMONDS (never chips - Dan 2026-09-05). '
  'Deduped by referral_milestone_claims, and again by add_diamonds_to_balance '
  'reference_id. Rolls the claim back if the credit fails.';

COMMIT;
