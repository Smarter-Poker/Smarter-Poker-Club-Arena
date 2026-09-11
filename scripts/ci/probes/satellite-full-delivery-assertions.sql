-- Replaces only the seat-case money assertions. Original full public RPC,
-- seven guards, actual funding, source closeout, late fault, replay and deferred
-- proof remain in the parameterized runner. Delivery is selected by actual
-- target capacity and canonical game occupancy, never a payout/issue stub.
CREATE FUNCTION pg_temp.assert_satellite_full_money_closed() RETURNS void LANGUAGE plpgsql AS $money$
DECLARE src constant uuid:='d3000000-0000-4000-8000-000000000001';
 target constant uuid:='d3000000-0000-4000-8000-000000000002';
 winner constant uuid:='d1000000-0000-4000-8000-000000000002';
 mode text:=current_setting('app.native_satellite_delivery');
BEGIN
 PERFORM pg_temp.satellite_full_assert(EXISTS(SELECT 1 FROM public.tournaments
  WHERE id=src AND status='COMPLETED' AND ended_at IS NOT NULL AND current_players=0),
  'source reaches real COMPLETED lifecycle');
 PERFORM pg_temp.satellite_full_assert(EXISTS(SELECT 1 FROM public.tournament_escrow
  WHERE tournament_id=src AND prize_balance=0 AND bounty_balance=0 AND fee_balance=0
   AND prize_out=100 AND closed_at IS NOT NULL
   AND close_note='atomic satellite terminal receipt: exact zero'),
  'source escrow closes exact zero after the real cash or ticket delivery');
 PERFORM pg_temp.satellite_full_assert(EXISTS(SELECT 1 FROM public.tournament_escrow
  WHERE tournament_id=target AND prize_balance=CASE WHEN mode='cash' THEN 270 ELSE 90 END
    AND bounty_balance=0 AND fee_balance=CASE WHEN mode='cash' THEN 30 ELSE 10 END)
  AND EXISTS(SELECT 1 FROM public.tournaments WHERE id=target AND current_players=CASE WHEN mode='cash' THEN 3 ELSE 1 END
    AND prize_pool=CASE WHEN mode='cash' THEN 270 ELSE 90 END AND total_rake=CASE WHEN mode='cash' THEN 30 ELSE 10 END)
  AND NOT EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=target AND user_id=winner)
  AND NOT EXISTS(SELECT 1 FROM public.tournament_refund_entitlements WHERE tournament_id=target AND user_id=winner),
  'cash or ticket delivery preserves every actual funded target entry and creates no unearned target seat');
 IF mode='cash' THEN
  PERFORM pg_temp.satellite_full_assert((SELECT count(*)=1 FROM public.tournament_satellite_awards a
    JOIN public.tournament_payouts p ON p.id=a.payout_id JOIN public.tournament_obligations o ON o.id=a.obligation_id
    WHERE a.tournament_id=src AND a.user_id=winner AND a.delivery_kind='cash' AND a.amount=100
      AND a.place=1 AND a.payout_source='satellite_ticket' AND a.ticket_id IS NULL AND a.registration_id IS NULL
      AND p.tournament_id=src AND p.user_id=winner AND p.amount=100 AND p.source='satellite_ticket'
      AND o.tournament_id=src AND o.user_id=winner AND o.kind='seat' AND o.place=1
      AND o.amount_owed=100 AND o.amount_paid=100 AND o.settled_at IS NOT NULL)
    AND (SELECT count(*)=1 FROM public.wallet_transactions WHERE related_entity_id=src AND user_id=winner
      AND type='credit' AND category='prize' AND amount=100)
    AND (SELECT count(*)=1 FROM public.chip_ledger WHERE tournament_id=src AND from_type='prize_liability'
      AND from_entity_id=src AND to_type='player_wallet' AND to_entity_id=winner AND amount=100)
    AND NOT EXISTS(SELECT 1 FROM public.tournament_tickets WHERE source_satellite_id=src),
    'full target classification delivers one actual100 cash payout with its closed debt, wallet receipt and funded ledger');
  PERFORM pg_temp.satellite_full_assert((SELECT chip_balance=300 FROM public.club_members
    WHERE club_id='d2000000-0000-4000-8000-000000000002' AND user_id=winner),
    'the winner receives exactly100 cash after the original100 source debit');
 ELSIF mode='ticket' THEN
  PERFORM pg_temp.satellite_full_assert((SELECT count(*)=1 FROM public.tournament_satellite_awards a
    JOIN public.tournament_payouts p ON p.id=a.payout_id JOIN public.tournament_tickets tk ON tk.id=a.ticket_id
    JOIN public.chip_ledger l ON l.to_entity_id=tk.id AND l.to_type='escrow' AND l.category='ticket_issue'
    JOIN public.chip_transactions tr ON tr.transaction_type='tournament_ticket_issue'
      AND tr.metadata->>'ticket_id'=tk.id::text AND tr.metadata->>'ledger_id'=l.id::text
    WHERE a.tournament_id=src AND a.user_id=winner AND a.delivery_kind='ticket' AND a.amount=100
      AND a.place=1 AND a.payout_source='satellite_ticket' AND a.registration_id IS NULL AND a.obligation_id IS NULL
      AND p.tournament_id=src AND p.user_id=winner AND p.amount=100 AND p.source='satellite_ticket'
      AND tk.holder_id=winner AND tk.value=100 AND tk.status='issued' AND tk.redemption_mode='tournament_entry_only'
      AND tk.source_tournament_id=target AND tk.source_satellite_id=src AND tk.source_satellite_award_place=1
      AND tk.source_refund_entitlement_id IS NULL AND tk.entry_prize=90 AND tk.entry_bounty=0 AND tk.entry_fee=10
      AND tk.club_id='d2000000-0000-4000-8000-000000000002'
      AND l.from_type='prize_liability' AND l.from_entity_id=src AND l.amount=100
      AND l.pre_from_balance=100 AND l.post_from_balance=0 AND l.pre_to_balance=0 AND l.post_to_balance=100
      AND tr.amount=100 AND tr.metadata->>'payout_id'=p.id::text)
    AND NOT EXISTS(SELECT 1 FROM public.wallet_transactions WHERE related_entity_id=src AND type='credit'),
    'actual four-game classification mints one100 noncash ticket with exact90/10 entry rights and source-funded issue journals');
  PERFORM pg_temp.satellite_full_assert((SELECT chip_balance=200 FROM public.club_members
    WHERE club_id='d2000000-0000-4000-8000-000000000002' AND user_id=winner),
    'the funded ticket does not make a second wallet debit or any cash credit');
 ELSE RAISE EXCEPTION 'unrecognized native delivery mode'; END IF;
END $money$;
