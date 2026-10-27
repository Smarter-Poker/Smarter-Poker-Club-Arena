-- Reserved by scripts/new-migration.mjs.
-- Sunday Funday Mystery d5d373cb paid 21 places but activated at 20 survivors,
-- generating 19 chests instead of 20. kim knocked out fat_flannel in 21st
-- (hand 5da45ebd, 04:33:40.694Z), before activation at 04:34:00.405358Z.
-- The full 4,525 pool was already paid in 19 awards. No actual random draw
-- exists for the missing knockout, so its hypothetical amount is unknowable.
-- Decision under CLAUDE.md 10.9: the house pays kim 1,191 chips, the largest
-- chest actually present in this event, covering every possible outcome in
-- that inventory. This is a disclosed house make-good, NOT a fabricated draw.
-- Existing awards, prizes, sealed tournament books and every other player's
-- money stay intact. No horse/human distinction. No scheduled repair.
-- Uses the established audited house-settlement door of 20261004151352:
-- manual adjustment + union bank debit + idempotent credit + one journal leg.
-- The engine fix in this same change owns future activation correctness.
-- Probe: one call, SET LOCAL ca.mystery_boundary_probe='on', entire DO block;
-- the final exception MUST abort it. Apply only the protected-main bytes.
-- @live-proof: (SELECT count(*) FROM public.ca_manual_adjustments WHERE decision_note = 'migration 20261026172816_the_house_settles_the_missed_sunday_mystery_chest' AND status = 'settled' AND amount = 1191) = 1
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';
DO $settle$
DECLARE
  c_mig constant text := '20261026172816_the_house_settles_the_missed_sunday_mystery_chest';
  c_event constant uuid := 'd5d373cb-6d10-4ab1-bf01-1c01392c1598';
  c_user constant uuid := '869b7283-6da3-4b6b-9c19-34d35921f3b0';
  c_loser constant uuid := 'a6951550-6ec2-4359-a0bc-8c2f66fc5078';
  c_hand constant uuid := '5da45ebd-cad0-439b-bba7-b76785f0afae';
  c_club constant uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  c_union constant uuid := 'fade0000-0000-0000-0000-000000000001';
  c_key constant text := 'mystery-boundary-make-good:d5d373cb-6d10-4ab1-bf01-1c01392c1598:869b7283-6da3-4b6b-9c19-34d35921f3b0';
  c_amount constant numeric := 1191;
  v_bank numeric; v_wallet numeric; v_after numeric; v_adj uuid;
  v_leg uuid; v_tx uuid; v_reason text; v_replay boolean := false;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended(c_key,0)) THEN
    RAISE EXCEPTION 'missed mystery settlement is already owned';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id=c_event
      AND status='COMPLETED' AND bounty_pool=4525 AND bounty_pool_paid=4525
      AND mystery_bounty_activated_players=20 AND union_id=c_union)
    OR NOT EXISTS(SELECT 1 FROM public.tournament_entry_close_receipts
      WHERE tournament_id=c_event AND jsonb_array_length(payout_structure_snapshot)=21)
    OR NOT EXISTS(SELECT 1 FROM public.tournament_mystery_activation_receipts
      WHERE tournament_id=c_event AND chest_count=19 AND pool_cents=452500)
    OR (SELECT count(*) FROM public.tournament_bounty_awards WHERE tournament_id=c_event)<>19
    OR (SELECT sum(amount_cents) FROM public.tournament_bounty_awards WHERE tournament_id=c_event)<>452500
    OR (SELECT max(amount_cents) FROM public.tournament_bounty_chests WHERE tournament_id=c_event)<>119100
    OR NOT EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=c_event
      AND user_id=c_loser AND position=21 AND prize=91.5)
    OR EXISTS(SELECT 1 FROM public.tournament_bounty_awards WHERE tournament_id=c_event AND eliminated_user_id=c_loser)
    OR EXISTS(SELECT 1 FROM public.tournament_bounty_obligations WHERE tournament_id=c_event AND eliminated_user_id=c_loser)
    OR NOT EXISTS(SELECT 1 FROM public.hand_history h WHERE h.id=c_hand
      AND h.started_at='2026-10-26 04:33:11.386+00' AND h.ended_at='2026-10-26 04:33:40.694+00'
      AND jsonb_array_length(h.winners)=1 AND h.winners->0->>'userId'=c_user::text
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(h.players)p
        WHERE p->>'userId'=c_loser::text AND (p->>'stack')::numeric=0)) THEN
    RAISE EXCEPTION 'missed mystery settlement incident witness changed';
  END IF;
  IF public.fn_player_home_club(c_user,NULL) IS DISTINCT FROM c_club THEN
    RAISE EXCEPTION 'kim wallet routing changed';
  END IF;
  SELECT chip_balance INTO v_wallet FROM public.club_members
    WHERE user_id=c_user AND club_id=c_club FOR NO KEY UPDATE;
  SELECT chip_balance INTO v_bank FROM public.union_wallets WHERE union_id=c_union FOR UPDATE;
  IF v_wallet IS NULL OR v_bank IS NULL THEN RAISE EXCEPTION 'settlement wallet missing'; END IF;

  IF EXISTS(SELECT 1 FROM public.wallet_credit_idempotency WHERE key=c_key) THEN
    IF NOT EXISTS(SELECT 1 FROM public.wallet_credit_idempotency WHERE key=c_key AND user_id=c_user AND amount=c_amount)
      OR (SELECT count(*) FROM public.ca_manual_adjustments WHERE tournament_id=c_event
        AND target_id=c_user AND decision_note='migration '||c_mig AND amount=c_amount AND status='settled')<>1
      OR (SELECT count(*) FROM public.chip_ledger WHERE idempotency_key=c_key AND amount=c_amount
        AND from_type='union_bank' AND from_entity_id=c_union AND to_type='player_wallet'
        AND to_entity_id=c_user AND club_id=c_club AND tournament_id IS NULL)<>1 THEN
      RAISE EXCEPTION 'existing missed mystery credit lacks exact settled receipts';
    END IF;
    v_replay := true;
  ELSE
    IF EXISTS(SELECT 1 FROM public.ca_manual_adjustments WHERE tournament_id=c_event
      AND target_id=c_user AND amount>0) THEN
      RAISE EXCEPTION 'another kim adjustment requires inspection before payment';
    END IF;
    IF v_bank<c_amount THEN RAISE EXCEPTION 'union bank cannot fund the make-good'; END IF;
    v_reason := 'kim (869b7283-6da3-4b6b-9c19-34d35921f3b0) knocked out fat_flannel in 21st place in Sunday Funday Mystery d5d373cb. '
      ||'The final ladder paid 21 places, but mystery activation occurred after that paid-place knockout and generated 19 chests instead of 20. '
      ||'All 4525 chips were paid to the existing 19 awards. No actual draw exists for this missed knockout, so its hypothetical amount cannot be recovered. '
      ||'Under CLAUDE.md 10.9, Midway Union funds a disclosed 1191-chip make-good, equal to the largest chest actually in the event, covering every outcome in that inventory. '
      ||'This is a house settlement, not a reconstructed random draw. kim receives the chips in Deep Stack Society, the verified entry/home club. '
      ||'fat_flannel retains the 91.50 prize. Every other player retains every existing prize and bounty. No sealed tournament money or award is rewritten. '
      ||'The connected engine repair makes the mystery activation own the between-hands boundary through its authoritative result. Migration '||c_mig;
    v_adj := public.fn_ca_adjustment_under_10_9(c_event,c_user,c_amount,v_reason,c_mig,
      'Codex under CLAUDE.md 10.9: missed Sunday mystery boundary');
    PERFORM public.fn_ca_declare_ledger('settlement','union_bank',c_union,NULL,c_key,ARRAY['union_wallets']);
    PERFORM set_config('app.ledger_correlation',v_adj::text,true);
    UPDATE public.union_wallets SET chip_balance=chip_balance-c_amount,updated_at=now()
      WHERE union_id=c_union AND chip_balance>=c_amount;
    IF NOT FOUND THEN RAISE EXCEPTION 'union bank refused settlement'; END IF;
    IF public.fn_credit_and_log(c_user,c_amount,c_key,'settlement',
      'House Make-Good For The Missed Sunday Funday Mystery Knockout',NULL) IS NOT TRUE THEN
      RAISE EXCEPTION 'credit door did not pay the new settlement';
    END IF;
    PERFORM set_config('app.ledger_autoskip_union_wallets','',true);
    PERFORM set_config('app.ledger_counterparty','',true);
    PERFORM set_config('app.ledger_counterparty_entity','',true);
    PERFORM set_config('app.ledger_category','',true);
    PERFORM set_config('app.ledger_idempotency_key','',true);
    PERFORM set_config('app.ledger_correlation','',true);
    SELECT chip_balance INTO v_after FROM public.club_members WHERE user_id=c_user AND club_id=c_club;
    IF v_after-v_wallet<>c_amount OR
      (SELECT chip_balance FROM public.union_wallets WHERE union_id=c_union)<>v_bank-c_amount THEN
      RAISE EXCEPTION 'make-good wallet/bank conservation failed';
    END IF;
    SELECT id INTO STRICT v_leg FROM public.chip_ledger WHERE idempotency_key=c_key
      AND amount=c_amount AND from_type='union_bank' AND from_entity_id=c_union
      AND to_type='player_wallet' AND to_entity_id=c_user AND club_id=c_club AND tournament_id IS NULL;
    SELECT id INTO STRICT v_tx FROM public.wallet_transactions WHERE user_id=c_user
      AND created_at=now() AND amount=c_amount AND type='credit' AND category='settlement'
      AND description='House Make-Good For The Missed Sunday Funday Mystery Knockout' AND related_entity_id IS NULL;
    IF (SELECT count(*) FROM public.chip_ledger WHERE idempotency_key=c_key)<>1 THEN
      RAISE EXCEPTION 'make-good wrote duplicate journal legs';
    END IF;
    UPDATE public.ca_manual_adjustments SET status='settled' WHERE id=v_adj AND status='approved';
    IF NOT FOUND THEN RAISE EXCEPTION 'adjustment did not settle'; END IF;
    INSERT INTO public.financial_alerts(severity,source,message,context,resolved,resolved_at,resolution)
    VALUES('warning','mystery_paid_boundary','Missed Paid-Place Mystery Knockout Settled By The House',
      jsonb_build_object('tournament_id',c_event,'user_id',c_user,'eliminated_user_id',c_loser,
        'hand_id',c_hand,'amount',c_amount,'adjustment_id',v_adj,'ledger_id',v_leg,
        'wallet_transaction_id',v_tx,'idempotency_key',c_key,'migration',c_mig,
        'basis','largest_observed_chest_house_make_good_not_an_actual_draw'),true,now(),v_reason);
  END IF;
  IF current_setting('ca.mystery_boundary_probe',true)='on' THEN
    RAISE EXCEPTION 'PROBE OK rolled back: replay %, bank %, wallet %, credit %, adjustment %, ledger %, wallet receipt %',
      v_replay,v_bank,v_wallet,c_amount,v_adj,v_leg,v_tx;
  END IF;
END $settle$;
COMMIT;
