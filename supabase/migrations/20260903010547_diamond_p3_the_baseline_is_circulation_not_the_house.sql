-- PHASE 3 CONFLICT FIX (2026-09-03): the acknowledged baseline is circulation, not the house.
-- Lane B booked the pre-standard circulation (1,030,092 diamonds, all in player wallets) as a
-- ca_mint_ledger mint with holder_type = 'house' because 'house' was the only non-player holder
-- the CHECK allowed. Lane G's fn_ca_diamond_trial_balance then read it as a house issuance and
-- filed DR11:trial_balance_break (house balance 0 vs mint_net 1,030,092). Neither lane was wrong
-- about its own object; the register lacked a holder for "already in players' hands".
-- Correction by reversal and re-post (S4, never UPDATE a register row):
--   1. holder_type gains 'circulation';
--   2. a burn from 'house' reverses the misbooked mint (op baseline:diamonds:2026-09-03:reversal);
--   3. a mint to 'circulation' re-posts it (op baseline:diamonds:2026-09-03:v2).
-- fn_ca_mint_supply('diamonds') is unchanged by construction: +1,030,092 - 1,030,092 + 1,030,092.
-- No balance moves. One transaction, applied once.

BEGIN;
SET LOCAL lock_timeout = '4s';

ALTER TABLE public.ca_mint_ledger DROP CONSTRAINT IF EXISTS ca_mint_ledger_holder_type_check;
ALTER TABLE public.ca_mint_ledger ADD CONSTRAINT ca_mint_ledger_holder_type_check
  CHECK (holder_type IN ('club', 'union', 'player', 'house', 'circulation'));
COMMENT ON COLUMN public.ca_mint_ledger.holder_type IS
  'club | union | player | house | circulation. circulation = supply acknowledged as already held by players at a baseline (a bookkeeping holder, never a balance).';

DO $body$
DECLARE
  v_base   public.ca_mint_ledger%ROWTYPE;
  v_supply numeric;
BEGIN
  SELECT * INTO v_base FROM public.ca_mint_ledger
   WHERE asset = 'diamonds' AND op_id = 'baseline:diamonds:2026-09-03' AND holder_type = 'house';
  IF NOT FOUND THEN
    RAISE NOTICE 'baseline row already corrected or absent; nothing to reverse';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_mint_ledger WHERE op_id = 'baseline:diamonds:2026-09-03:reversal') THEN
    RAISE NOTICE 'reversal already posted';
    RETURN;
  END IF;

  v_supply := public.fn_ca_mint_supply('diamonds');

  INSERT INTO public.ca_mint_ledger
    (op_id, action, asset, holder_type, holder_id, holder_label, amount, balance_before, balance_after,
     supply_after, reason, performed_by, performed_by_label)
  VALUES
    ('baseline:diamonds:2026-09-03:reversal', 'burn', 'diamonds', 'house', v_base.holder_id,
     'reversal of the baseline misbooked to the house (phase 3 conflict fix)', v_base.amount,
     v_base.amount, 0, v_supply - v_base.amount,
     'reverses baseline:diamonds:2026-09-03: the pre-standard circulation was never held by the house (docs/audits/2026-09-02-diamond-economy/phase3-conflicts.md)',
     NULL, 'migration diamond_p3_the_baseline_is_circulation_not_the_house');

  INSERT INTO public.ca_mint_ledger
    (op_id, action, asset, holder_type, holder_id, holder_label, amount, balance_before, balance_after,
     supply_after, reason, performed_by, performed_by_label)
  VALUES
    ('baseline:diamonds:2026-09-03:v2', 'mint', 'diamonds', 'circulation', v_base.holder_id,
     'all player wallets (pre-standard circulation acknowledged as baseline)', v_base.amount,
     0, v_base.amount, v_supply,
     'pre-standard diamond circulation acknowledged as baseline 2026-09-03, re-posted to the circulation holder (docs/DIAMOND-ACCOUNTING-STANDARD.md)',
     NULL, 'migration diamond_p3_the_baseline_is_circulation_not_the_house');
END $body$;

DO $assert$
DECLARE v_supply numeric; v_players numeric; v_house_net numeric;
BEGIN
  v_supply  := public.fn_ca_mint_supply('diamonds');
  SELECT COALESCE(SUM(diamonds), 0) INTO v_players FROM public.profiles;
  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) INTO v_house_net
    FROM public.ca_mint_ledger WHERE asset = 'diamonds' AND holder_type = 'house';
  IF v_supply <> v_players THEN
    RAISE EXCEPTION 'assert: mint supply % <> players %', v_supply, v_players;
  END IF;
  IF v_house_net <> 0 THEN
    RAISE EXCEPTION 'assert: house mint net % <> 0', v_house_net;
  END IF;
END $assert$;

COMMIT;
