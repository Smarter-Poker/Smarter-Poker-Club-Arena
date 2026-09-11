-- AFTER the migration: same event shape, new tournament.
DO $$
DECLARE
  t uuid; t2 uuid; t3 uuid; r jsonb; o record; v_act timestamptz; v_created timestamptz; v_bust timestamptz;
  A uuid:='b0000000-0000-4000-8000-00000000000a'; B uuid:='b0000000-0000-4000-8000-00000000000b';
  C uuid:='b0000000-0000-4000-8000-00000000000c'; D uuid:='b0000000-0000-4000-8000-00000000000d';
  E uuid:='b0000000-0000-4000-8000-00000000000e'; F uuid:='b0000000-0000-4000-8000-00000000000f';
  G uuid:='b0000000-0000-4000-8000-000000000001'; H uuid:='b0000000-0000-4000-8000-000000000002';
  X uuid:='b0000000-0000-4000-8000-000000000003'; Y uuid:='b0000000-0000-4000-8000-000000000004';
BEGIN
  t := public.fixture_event('after', ARRAY[A,B,C,D,E,F,G,H]::text[], 5.00);
  PERFORM public.fixture_paid_head(t,A,H,8); PERFORM public.fixture_paid_head(t,B,H,7);
  PERFORM public.fixture_paid_head(t,C,H,6); PERFORM public.fixture_paid_head(t,D,H,5);
  v_bust := clock_timestamp()-interval '10 minutes';
  PERFORM public.fixture_bust(t,E,F,3000001,v_bust);

  PERFORM public.fixture_assert(public.fn_mystery_bounty_unrecorded_head_cents(t)=500,
    'after: the unrecorded pre-activation head is measured (500c)');
  -- 1. an engine still building from pool-paid is refused, and told why
  r := public.fn_mystery_bounty_seed(t,3,public.fixture_chests(ARRAY[1200,800]::bigint[]));
  PERFORM public.fixture_assert(NOT (r->>'ok')::boolean AND r->>'reason'='inventory_mismatch'
      AND (r->>'pool_cents')::bigint=1500 AND (r->>'unrecorded_head_cents')::bigint=500,
    'after: seed refuses to seal the unrecorded head into the chests: '||r::text);
  -- 2. the reserved pool seals, lane-ordered and clock-stamped
  r := public.fn_mystery_bounty_seed(t,3,public.fixture_chests(ARRAY[900,600]::bigint[]));
  PERFORM public.fixture_assert((r->>'ok')::boolean AND (r->>'pool_cents')::bigint=1500,
    'after: seed seals 1500c = min(2000, 4000-2000-500): '||r::text);
  SELECT activated_at, created_at INTO v_act, v_created FROM public.tournament_mystery_activation_receipts
   WHERE tournament_id=t AND activation_generation=1;
  PERFORM public.fixture_assert(v_act > v_created AND v_act > v_bust,
    'after: activated_at is clock_timestamp() after the locks (> txn start '||v_created||'): '||v_act);
  -- 3. E's bust hand precedes activation: mystery_pre, generation 0
  r := public.fixture_claim(t,E,F,4);
  SELECT * INTO o FROM public.tournament_bounty_obligations WHERE tournament_id=t AND eliminated_user_id=E;
  PERFORM public.fixture_assert((r->>'ok')::boolean AND o.mode='mystery_pre' AND o.activation_generation=0
      AND o.state='pending' AND o.head_amount=5.00,
    'after: late-recorded pre-activation bust is mystery_pre: '||r::text);
  -- 4. and it is collectable while the chests are open, from the reserve
  r := public.fn_collect_bounty_obligation(o.id);
  PERFORM public.fixture_assert((r->>'ok')::boolean AND (r->>'paid_cash')::numeric=5.00
      AND (SELECT state FROM public.tournament_bounty_obligations WHERE id=o.id)='settled'
      AND (SELECT sum(amount) FROM public.wallet_transactions WHERE related_entity_id=t AND category='bounty')=25.00,
    'after: mystery_pre head paid during the active phase; ledger 25.00, chest pool 15.00 still funded: '||r::text);
  PERFORM public.fixture_assert(public.fn_mystery_bounty_unrecorded_head_cents(t)=0,
    'after: nothing left unrecorded');
  -- 5. F busts after activation: a chest
  PERFORM public.fixture_bust(t,F,H,3000002,clock_timestamp());
  r := public.fixture_claim(t,F,H,3);
  SELECT * INTO o FROM public.tournament_bounty_obligations WHERE tournament_id=t AND eliminated_user_id=F;
  PERFORM public.fixture_assert(o.mode='mystery_chest' AND o.activation_generation=1,
    'after: post-activation bust is mystery_chest (generation 1): '||r::text);
  -- 6. the collect gate still refuses anything but mystery_pre while active
  INSERT INTO public.tournament_bounty_obligations(tournament_id,eliminated_user_id,table_id,hand_id,hand_number,
     settlement_completed_at,seat_joined_at,position,prize,bubble_refund,mode,activation_generation,head_amount,
     knocker_user_id,claimants)
  SELECT t,G,o.table_id,gen_random_uuid(),3999999,now(),'2026-09-10 00:00:00+00',2,0,0,'regular',0,5.00,H,
         jsonb_build_array(jsonb_build_object('user_id',H,'weight',1))
    RETURNING * INTO o;
  r := public.fn_collect_bounty_obligation(o.id);
  PERFORM public.fixture_assert(r->>'reason'='mystery_phase_active',
    'after: a non-mystery_pre obligation is still refused while active: '||r::text);
  DELETE FROM public.tournament_bounty_obligations WHERE id=o.id;
  -- 7. fail closed: a bust whose order against activation cannot be proven
  PERFORM public.fixture_bust(t,G,H,3000003,v_act);
  r := public.fixture_claim(t,G,H,2);
  PERFORM public.fixture_assert((r->>'ok')::boolean AND r->>'bounty_blocked'='mystery_phase_of_bust_not_proven'
      AND NOT EXISTS (SELECT 1 FROM public.tournament_bounty_obligations WHERE tournament_id=t AND eliminated_user_id=G)
      AND (SELECT status FROM public.tournament_players WHERE tournament_id=t AND user_id=G)='eliminated'
      AND EXISTS (SELECT 1 FROM public.financial_alerts WHERE context->>'eliminated_user_id'=G::text
                    AND context->>'reason'='mystery_phase_of_bust_not_proven'),
    'after: unprovable phase -> placed, no obligation, alert: '||r::text);
  -- 8. an active stage with no sealed receipt is refused (unchanged)
  t2 := public.fixture_event('no-receipt', ARRAY[X,Y]::text[], 5.00, 'active', 1);
  PERFORM public.fixture_bust(t2,X,Y,3000004,clock_timestamp());
  r := public.fixture_claim(t2,X,Y,2);
  PERFORM public.fixture_assert(r->>'reason'='mystery_activation_evidence_missing',
    'after: no receipt -> refused: '||r::text);
  -- 9. a pending stage is mystery_pre (unchanged)
  t3 := public.fixture_event('pending', ARRAY['c0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000002']::text[], 5.00);
  PERFORM public.fixture_bust(t3,'c0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000002',3000005,clock_timestamp());
  r := public.fixture_claim(t3,'c0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000002',2);
  PERFORM public.fixture_assert(r->>'mode'='mystery_pre',
    'after: pending stage -> mystery_pre: '||r::text);
END $$;
