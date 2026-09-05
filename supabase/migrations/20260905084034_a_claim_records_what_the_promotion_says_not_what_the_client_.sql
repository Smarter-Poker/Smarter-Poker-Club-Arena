-- ═══════════════════════════════════════════════════════════════════════════
--  A CLAIM RECORDS WHAT THE PROMOTION SAYS, NOT WHAT THE CLIENT SENDS
--  Club Operations upgrade, phase 8 of 8. Club control.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The Claim button on the offer feed inserts a `promotion_claims` row from the
-- browser, and the browser decides what the row says:
--
--     bonus_amount: promo.prizePool
--       ? Math.trunc((promo.prizePool * 100) / (promo.maxClaims || 100)) / 100
--       : 0,
--     status: promo.wagerRequirement ? 'active' : 'completed',
--     wager_required: promo.wagerRequirement || 0,
--
-- The only INSERT policy on that table is `user_id = auth.uid()`. It checks WHO
-- is claiming and nothing about WHAT they claim, so any signed-in caller can
-- post a claim carrying any `bonus_amount`, any `wager_required` and a status
-- of `completed`. Nothing pays out from it today - which is the other half of
-- this defect, below - but it is a number sitting in a money column waiting for
-- something to trust it.
--
-- **NOBODY HAS CLAIMED ANYTHING YET.** `promotion_claims` holds zero rows, so
-- there is nothing to restate and nobody to repay.
--
-- ─── WHAT THIS FIXES, AND WHAT IT DELIBERATELY DOES NOT ────────────────────
--
-- FIXED: the three columns become the server's to decide. A BEFORE INSERT
-- trigger overwrites `bonus_amount`, `wager_required` and `status` from the
-- `promotions` row every time, whatever the client sent. The client can still
-- choose WHICH promotion to claim - that is the whole action - but not what
-- claiming it is worth.
--
-- NOT FIXED HERE, ON PURPOSE: the claim still credits no wallet. The generic
-- Claim path writes a row and increments a counter; only the deposit-match
-- path (`add_to_promo_wallet`) ever moves anything. Making a claim PAY means
-- deciding what each promotion type owes a player, and CLAUDE.md 10.9 reserves
-- "anything that sets what players are owed in future events" to Dan. So this
-- migration makes the recorded figure trustworthy and leaves the paying to
-- him; the client stops saying the balance changed, because it did not.
--
-- The formula the trigger uses is the one the client was already using, moved
-- rather than invented: an even split of the prize pool across the maximum
-- number of claims. Where a promotion names no pool it is zero, exactly as
-- before.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

SET LOCAL lock_timeout = '20s';

CREATE OR REPLACE FUNCTION public.fn_promotion_claim_takes_the_promotions_word()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_promo record;
BEGIN
  SELECT p.prize_pool, p.max_claims, p.wager_requirement, p.status,
         p.start_date, p.end_date
    INTO v_promo
    FROM public.promotions p
   WHERE p.id = NEW.promotion_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such promotion' USING ERRCODE = 'P0002';
  END IF;

  -- A claim on a promotion that is not running is refused here, not merely in
  -- the client that decided to send it.
  IF coalesce(v_promo.status, '') <> 'active'
     OR (v_promo.start_date IS NOT NULL AND v_promo.start_date > now())
     OR (v_promo.end_date IS NOT NULL AND v_promo.end_date < now()) THEN
    RAISE EXCEPTION 'that promotion is not running' USING ERRCODE = '22023';
  END IF;

  -- The client's numbers are discarded. Same formula it used, decided here.
  NEW.bonus_amount := CASE
    WHEN coalesce(v_promo.prize_pool, 0) > 0
      THEN trunc((v_promo.prize_pool * 100) / GREATEST(coalesce(v_promo.max_claims, 100), 1)) / 100
    ELSE 0
  END;
  NEW.wager_required := coalesce(v_promo.wager_requirement, 0);
  NEW.status := CASE WHEN coalesce(v_promo.wager_requirement, 0) > 0
                     THEN 'active' ELSE 'completed' END;
  NEW.wager_progress := 0;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_promotion_claim_takes_the_promotions_word()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_promotion_claim_takes_the_promotions_word() TO service_role;

DROP TRIGGER IF EXISTS zz_promotion_claim_server_decides ON public.promotion_claims;
CREATE TRIGGER zz_promotion_claim_server_decides
  BEFORE INSERT ON public.promotion_claims
  FOR EACH ROW EXECUTE FUNCTION public.fn_promotion_claim_takes_the_promotions_word();

COMMENT ON TRIGGER zz_promotion_claim_server_decides ON public.promotion_claims IS
  'The claim row says what the promotion says. The only INSERT policy checks who is claiming, never what, so bonus_amount, wager_required and status arrived from the browser until 2026-09-05.';

DO $$
DECLARE v_bonus numeric; v_promo uuid; v_user uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'promotion_claims'
                    AND t.tgname = 'zz_promotion_claim_server_decides') THEN
    RAISE EXCEPTION 'the claim still takes the client at its word';
  END IF;

  -- Prove the overwrite on a real promotion, then undo it. A claim is not
  -- money today, but it is a money-shaped row and 11.5 applies to the shape.
  SELECT p.id INTO v_promo FROM public.promotions p
   WHERE p.status = 'active'
     AND (p.start_date IS NULL OR p.start_date <= now())
     AND (p.end_date IS NULL OR p.end_date >= now())
   LIMIT 1;

  IF v_promo IS NOT NULL THEN
    SELECT id INTO v_user FROM public.profiles LIMIT 1;
    INSERT INTO public.promotion_claims
      (promotion_id, user_id, status, bonus_amount, wager_progress, wager_required)
    VALUES (v_promo, v_user, 'completed', 999999.99, 0, 0)
    RETURNING bonus_amount INTO v_bonus;

    IF v_bonus = 999999.99 THEN
      RAISE EXCEPTION 'the client-supplied bonus survived the trigger';
    END IF;
    RAISE NOTICE 'a claim asking for 999999.99 was recorded as %', v_bonus;

    DELETE FROM public.promotion_claims
     WHERE promotion_id = v_promo AND user_id = v_user;
  END IF;
END $$;

COMMIT;
