-- Keep the chip journal lock in its own short transaction, as the existing
-- Plinko/Crash category migration does. Preserve every current category.
-- New game prizes must not be mistaken for a generic promo distribution.
BEGIN;
SET LOCAL lock_timeout = '2s';
DO $do$
DECLARE v_def text;
BEGIN
 SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
 WHERE conrelid='public.chip_ledger'::regclass AND conname='chip_ledger_category_check';
 IF md5(v_def) <> 'dcae493d9794906acb354e86ebbb344a' THEN RAISE EXCEPTION 'Chip journal categories changed; review before extending'; END IF;
END $do$;
ALTER TABLE public.chip_ledger DROP CONSTRAINT chip_ledger_category_check;
ALTER TABLE public.chip_ledger ADD CONSTRAINT chip_ledger_category_check
CHECK ((category = ANY (ARRAY['buyin'::text, 'cashout'::text, 'rake'::text, 'commission'::text, 'transfer'::text, 'player_funding'::text, 'agent_funding'::text, 'mint'::text, 'burn'::text, 'legacy_seed_reconcile'::text, 'rakeback'::text, 'settlement'::text, 'tournament_buyin'::text, 'tournament_prize'::text, 'bounty'::text, 'adjustment'::text, 'refund'::text, 'addon'::text, 'rebuy'::text, 'table_cashout'::text, 'tournament_refund'::text, 'bbj_contribution'::text, 'bbj_payout'::text, 'promo'::text, 'promo_release'::text, 'promo_send'::text, 'credit_draw'::text, 'credit_repayment'::text, 'insurance'::text, 'spin_entry'::text, 'spin_prize'::text, 'overlay'::text, 'correction'::text, 'reversal'::text, 'escrow_hold'::text, 'escrow_release'::text, 'treasury_transfer'::text, 'horse_funding'::text, 'fee'::text, 'eco'::text, 'pnl_settlement'::text, 'union_send'::text, 'cashier_send'::text, 'cashier_claim_back'::text, 'ticket_issue'::text, 'ticket_redeem'::text, 'club_opening_allocation'::text, 'leaderboard_payout'::text, 'club_bank_send'::text, 'club_bank_claim'::text, 'agent_send'::text, 'agent_claim'::text, 'union_settlement'::text, 'wheel_prize'::text, 'plinko_prize'::text, 'crash_prize'::text, 'crossing_prize'::text, 'mines_prize'::text]))) NOT VALID;
COMMIT;
