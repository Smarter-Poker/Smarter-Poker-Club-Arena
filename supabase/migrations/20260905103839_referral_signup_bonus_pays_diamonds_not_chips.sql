-- ═══════════════════════════════════════════════════════════════════════════
--  THE REFERRAL SIGNUP BONUS PAYS DIAMONDS, NOT CHIPS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan, 2026-09-05, verbatim: "NOTHING EVER 'EARNS CHIPS' ONLY EVER DIAMONDS.
-- MAKE SURE THATS THE CASE GLOBALLY!"
--
-- The milestone half moved in 20260905103510. This is the OTHER referral
-- payout, and it was the one the share text advertised ("get 250 bonus
-- chips!"): `redeem_referral_code` credited 250 CHIPS to BOTH sides through
-- `atomic_credit_wallet_and_log`, which settles into
-- `club_members.chip_balance`.
--
-- SAFE TO CHANGE, MEASURED BEFORE WRITING (2026-09-05):
--     referral_redemptions   0 rows
-- Nothing has ever been redeemed, so no past payout to reconcile and nobody
-- to make whole. Both award columns are renamed rather than added for the
-- same reason - an empty table can be corrected instead of accreted.
--
-- 250 chips -> 100 diamonds per side. Denominated in the economy the platform
-- already pays from: daily_challenge_catalog.diamond_reward runs 8-800, mean
-- 103. THE NUMBER IS A PRICING DECISION AND THEREFORE DAN'S (CLAUDE.md 10.9);
-- it is one line here and one line in ReferralService.
--
-- Both credits go through `add_diamonds_to_balance`: SECURITY DEFINER, deduped
-- on `reference_id`, and audited into `diamond_transactions`. A refused credit
-- raises, which unwinds the redemption row rather than recording a payout that
-- never happened.
--
-- Applied to production 2026-09-05. One transaction, per CLAUDE.md section 2.

BEGIN;

ALTER TABLE public.referral_redemptions
  RENAME COLUMN chips_awarded_referrer TO diamonds_awarded_referrer;
ALTER TABLE public.referral_redemptions
  RENAME COLUMN chips_awarded_referee TO diamonds_awarded_referee;

CREATE OR REPLACE FUNCTION public.redeem_referral_code(p_referee_id uuid, p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_caller uuid := (SELECT auth.uid());
  v_code record;
  -- DIAMONDS. Dan's to set; the mechanism around them is what this asserts.
  v_award_referrer integer := 100;
  v_award_referee  integer := 100;
  v_credit jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication required');
  END IF;
  IF p_referee_id IS DISTINCT FROM v_caller THEN
    RETURN jsonb_build_object('success', false, 'error', 'can only redeem for your own account');
  END IF;

  SELECT * INTO v_code FROM referral_codes WHERE upper(code) = upper(trim(p_code));
  IF v_code.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid referral code');
  END IF;
  IF v_code.user_id = p_referee_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'cannot redeem your own code');
  END IF;
  IF v_code.max_uses IS NOT NULL AND v_code.uses >= v_code.max_uses THEN
    RETURN jsonb_build_object('success', false, 'error', 'code has reached its maximum uses');
  END IF;
  IF EXISTS (SELECT 1 FROM referral_redemptions WHERE referee_id = p_referee_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'referral already redeemed for this account');
  END IF;

  INSERT INTO referral_redemptions
    (code_id, referrer_id, referee_id, diamonds_awarded_referrer, diamonds_awarded_referee)
  VALUES (v_code.id, v_code.user_id, p_referee_id, v_award_referrer, v_award_referee);

  UPDATE referral_codes SET uses = uses + 1 WHERE id = v_code.id;

  v_credit := public.add_diamonds_to_balance(
    p_referee_id, v_award_referee, 'referral_bonus',
    'Referral signup bonus (code ' || v_code.code || ')',
    'referral_signup:' || p_referee_id::text);
  IF COALESCE((v_credit->>'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'referral signup bonus could not be credited: %',
      COALESCE(v_credit->>'error', 'unknown');
  END IF;

  v_credit := public.add_diamonds_to_balance(
    v_code.user_id, v_award_referrer, 'referral_bonus',
    'Referral reward (code ' || v_code.code || ')',
    'referral_reward:' || v_code.id::text || ':' || p_referee_id::text);
  IF COALESCE((v_credit->>'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'referral reward could not be credited: %',
      COALESCE(v_credit->>'error', 'unknown');
  END IF;

  RETURN jsonb_build_object('success', true, 'awarded', v_award_referee, 'currency', 'diamonds');
END;
$function$;

COMMENT ON FUNCTION public.redeem_referral_code(uuid, text) IS
  'Redeems a referral code and pays DIAMONDS to both sides (never chips - Dan 2026-09-05). Idempotent per side via add_diamonds_to_balance reference_id; a failed credit rolls back the redemption.';

COMMIT;
