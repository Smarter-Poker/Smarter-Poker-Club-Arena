-- Included by build-versioned-final-deal-probe.py inside one rollback-only
-- transaction with the real source-matched cash authority. No terminal/M5 stand-in.
CREATE FUNCTION pg_temp.deal_assert(p_ok boolean,p_label text)
RETURNS void LANGUAGE plpgsql AS $assert$
BEGIN
  IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'FAIL %',p_label; END IF;
  RAISE NOTICE 'PASS %',p_label;
END;
$assert$;

CREATE FUNCTION pg_temp.exact_deal_money_state()
RETURNS jsonb LANGUAGE sql AS $state$
  SELECT jsonb_build_object(
    'tournament',(SELECT to_jsonb(t) FROM public.tournaments t WHERE id='87000000-0000-0000-0000-000000000001'),
    'players',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.tournament_players t WHERE tournament_id='87000000-0000-0000-0000-000000000001'),
    'seats',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.table_seats t WHERE table_id='87200000-0000-0000-0000-000000000001'),
    'tables',(SELECT to_jsonb(t) FROM public.tables t WHERE id='87200000-0000-0000-0000-000000000001'),
    'payouts',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.tournament_payouts t WHERE tournament_id='87000000-0000-0000-0000-000000000001'),
    'obligations',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.tournament_obligations t WHERE tournament_id='87000000-0000-0000-0000-000000000001'),
    'wallets',(SELECT jsonb_agg(to_jsonb(t) ORDER BY user_id,club_id) FROM public.club_members t WHERE user_id IN (SELECT user_id FROM public.tournament_players WHERE tournament_id='87000000-0000-0000-0000-000000000001')),
    'ledger',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.wallet_transactions t WHERE related_entity_id='87000000-0000-0000-0000-000000000001'),
    'keys',(SELECT jsonb_agg(to_jsonb(t) ORDER BY key) FROM public.wallet_credit_idempotency t WHERE user_id IN (SELECT user_id FROM public.tournament_players WHERE tournament_id='87000000-0000-0000-0000-000000000001')),
    'escrow',(SELECT to_jsonb(t) FROM public.tournament_escrow t WHERE tournament_id='87000000-0000-0000-0000-000000000001'));
$state$;

DO $proposal$
DECLARE
  tid uuid:='87000000-0000-0000-0000-000000000001';
  p jsonb; r jsonb; s jsonb; old_revision text; i integer; review jsonb; begun jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub',md5('atomic-deal-user:1')::uuid::text,true);
  s:=pg_temp.exact_deal_money_state();
  r:=public.fn_get_tournament_deal_review(tid);
  PERFORM pg_temp.deal_assert(r->>'state'='none' AND (SELECT count(*) FROM public.tournament_deal_reviews)=0,
    'reading review state never starts a pause');
  r:=public.fn_request_tournament_deal_review(tid,md5('atomic-deal-user:2')::uuid);
  PERFORM pg_temp.deal_assert(r->>'reason'='actor_mismatch' AND (SELECT count(*) FROM public.tournament_deal_reviews)=0,
    'account switch cannot create a review for the unintended actor');
  r:=public.fn_request_tournament_deal_review(tid,NULL);
  PERFORM pg_temp.deal_assert(r->>'reason'='actor_mismatch' AND (SELECT count(*) FROM public.tournament_deal_reviews)=0,
    'null expected actor cannot create review');
  review:=public.fn_request_tournament_deal_review(tid,auth.uid());
  PERFORM pg_temp.deal_assert(review->>'state'='requested' AND review->>'proposal_id' IS NULL
    AND pg_temp.exact_deal_money_state()=s,'explicit request creates bounded no-money intent');
  r:=public.fn_request_tournament_deal_review(tid,auth.uid());
  PERFORM pg_temp.deal_assert(r=review,'request replay preserves review identity and deadline');
  r:=public.fn_get_tournament_deal_proposal(tid);
  PERFORM pg_temp.deal_assert(r->>'reason'='review_not_ready','proposal is unavailable before physical park activation');
  BEGIN
    PERFORM public.fn_begin_tournament_deal_review(tid,(review->>'review_id')::uuid);
    RAISE EXCEPTION 'unfenced manager began review';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM pg_temp.deal_assert(true,'begin rejects absent manager scope');
  PERFORM set_config('app.smarter_data_actor','tournament-manager',true);
  PERFORM set_config('app.smarter_manager_request_fenced','protocol-2',true);
  PERFORM set_config('app.smarter_tournament_id',tid::text,true);
  PERFORM set_config('app.smarter_tournament_lease_generation','87900000-0000-0000-0000-000000000001',true);
  BEGIN
    UPDATE public.tournament_players SET status='eliminated',position=5,chips=0,eliminated_at=clock_timestamp()
      WHERE tournament_id=tid AND user_id=md5('atomic-deal-user:1')::uuid;
    UPDATE public.table_seats SET left_at=clock_timestamp() WHERE id=md5('atomic-deal-seat:1')::uuid;
    r:=public.fn_begin_tournament_deal_review(tid,(review->>'review_id')::uuid);
    PERFORM pg_temp.deal_assert(r->>'review_state'='cancelled' AND r->>'proposal_id' IS NULL,
      'requester eliminated during drain cannot activate a review for the changed roster');
    RAISE EXCEPTION 'restore requester' USING ERRCODE='P7715';
  EXCEPTION WHEN SQLSTATE 'P7715' THEN NULL; END;
  BEGIN
    INSERT INTO public.hand_atomic_commits(table_id,hand_number,hand_id,payload_hash,stack_result)
      VALUES('87200000-0000-0000-0000-000000000001',1000000,'87700000-0000-0000-0000-000000000002',repeat('b',64),'{}'::jsonb);
    r:=public.fn_begin_tournament_deal_review(tid,(review->>'review_id')::uuid);
    PERFORM pg_temp.deal_assert(r->>'review_state'='reviewing','hand completing during park admits one post-hand proposal');
    r:=public.fn_cancel_tournament_deal_review(tid,(review->>'review_id')::uuid,auth.uid());
    r:=public.fn_request_tournament_deal_review(tid,auth.uid());
    PERFORM pg_temp.deal_assert(r->>'reason'='review_wait_for_next_hand','post-park consumed hand prevents immediate second pause after cancel');
    RAISE EXCEPTION 'restore parked witness' USING ERRCODE='P7716';
  EXCEPTION WHEN SQLSTATE 'P7716' THEN NULL; END;
  begun:=public.fn_begin_tournament_deal_review(tid,(review->>'review_id')::uuid);
  PERFORM pg_temp.deal_assert(begun->>'review_state'='reviewing' AND begun->>'proposal_id' IS NOT NULL
    AND (begun->>'review_expires_at')::timestamptz>clock_timestamp(),'manager activation creates post-hand proposal and server deadline');
  r:=public.fn_begin_tournament_deal_review(tid,(review->>'review_id')::uuid);
  PERFORM pg_temp.deal_assert(r=begun,'begin retry keeps exact proposal and cannot extend deadline');
  p:=public.fn_get_tournament_deal_proposal(tid);
  PERFORM pg_temp.deal_assert((p->>'ok')::boolean AND p->>'actor_id'=md5('atomic-deal-user:1')::uuid::text
    AND p->>'revision' ~ '^[0-9a-f]{64}$' AND p->>'pool_cents'='10000' AND p->>'deal_cents'='9500'
    AND p->'shares'->0->>'amount_cents'='3168' AND p->'shares'->4->>'amount_cents'='633'
    AND (SELECT sum((x->>'amount_cents')::bigint) FROM jsonb_array_elements(p->'shares')x)=9500,
    'proposal retains native amounts and exact cents');
  r:=public.fn_get_tournament_deal_proposal(tid);
  PERFORM pg_temp.deal_assert(r=p AND pg_temp.exact_deal_money_state()=s,
    'identical preview retains proposal and makes no money or standing mutation');
  r:=public.fn_get_tournament_deal_consensus(tid);
  PERFORM pg_temp.deal_assert((r->>'ready')::boolean=false AND r->'voter_ids'='[]'::jsonb
    AND (r->>'required')::integer=5,'legacy generic votes confer no exact consent');
  PERFORM set_config('request.jwt.claim.sub','',true);
  BEGIN
    PERFORM public.fn_get_tournament_deal_proposal(tid);
    RAISE EXCEPTION 'anonymous getter unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM pg_temp.deal_assert(true,'anonymous getter refused');
  PERFORM set_config('request.jwt.claim.sub',md5('atomic-deal-user:6')::uuid::text,true);
  r:=public.fn_cast_tournament_deal_vote(tid,(p->>'proposal_id')::uuid,auth.uid());
  PERFORM pg_temp.deal_assert(r->>'reason'='voter_not_alive','eliminated actor cannot consent');
  PERFORM set_config('request.jwt.claim.sub',md5('atomic-deal-user:1')::uuid::text,true);
  r:=public.fn_cast_tournament_deal_vote(tid,(p->>'proposal_id')::uuid,md5('atomic-deal-user:2')::uuid);
  PERFORM pg_temp.deal_assert(r->>'reason'='actor_mismatch' AND (SELECT count(*) FROM public.tournament_deal_proposal_consents)=0,
    'account switch cannot record unintended consent');
  r:=public.fn_cancel_tournament_deal_review(tid,(review->>'review_id')::uuid,md5('atomic-deal-user:2')::uuid);
  PERFORM pg_temp.deal_assert(r->>'reason'='actor_mismatch' AND (SELECT state FROM public.tournament_deal_reviews WHERE id=(review->>'review_id')::uuid)='reviewing',
    'account switch cannot cancel another displayed actor review');
  r:=public.fn_cast_tournament_deal_vote(tid,(p->>'proposal_id')::uuid,NULL);
  PERFORM pg_temp.deal_assert(r->>'reason'='actor_mismatch' AND (SELECT count(*) FROM public.tournament_deal_proposal_consents)=0,
    'null expected actor cannot create consent');
  r:=public.fn_cancel_tournament_deal_review(tid,(review->>'review_id')::uuid,NULL);
  PERFORM pg_temp.deal_assert(r->>'reason'='actor_mismatch' AND (SELECT state FROM public.tournament_deal_reviews WHERE id=(review->>'review_id')::uuid)='reviewing',
    'null expected actor cannot cancel review');
  r:=public.fn_cast_tournament_deal_vote(tid,gen_random_uuid(),auth.uid());
  PERFORM pg_temp.deal_assert(r->>'reason'='proposal_not_found','unknown proposal refused');
  r:=public.fn_cast_tournament_deal_vote(tid,(p->>'proposal_id')::uuid,auth.uid());
  PERFORM pg_temp.deal_assert((r->>'ok')::boolean AND (r->>'already')::boolean=false
    AND r->>'actor_id'=p->>'actor_id' AND r->>'revision'=p->>'revision','vote binds exact actor and revision');
  r:=public.fn_cast_tournament_deal_vote(tid,(p->>'proposal_id')::uuid,auth.uid());
  PERFORM pg_temp.deal_assert((r->>'already')::boolean AND
    (SELECT count(*) FROM public.tournament_deal_proposal_consents WHERE proposal_id=(p->>'proposal_id')::uuid)=1,
    'identical vote retry has one durable consent');
  PERFORM set_config('app.tournament_deal_proposal_id',p->>'proposal_id',true);
  PERFORM set_config('app.tournament_deal_proposal_revision',p->>'revision',true);
  BEGIN
    PERFORM public.fn_settle_tournament_final_table_deal(tid);
    RAISE EXCEPTION 'partial consensus unexpectedly paid';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%unanimous exact consent%' THEN RAISE; END IF;
  END;
  PERFORM pg_temp.deal_assert(pg_temp.exact_deal_money_state()=s,'partial consent refuses real cash with complete rollback');
  FOR i IN 2..5 LOOP
    PERFORM set_config('request.jwt.claim.sub',md5('atomic-deal-user:'||i)::uuid::text,true);
    r:=public.fn_cast_tournament_deal_vote(tid,(p->>'proposal_id')::uuid,auth.uid());
    PERFORM pg_temp.deal_assert((r->>'ok')::boolean,'participant '||i||' exact consent accepted');
  END LOOP;
  r:=public.fn_get_tournament_deal_consensus(tid);
  PERFORM pg_temp.deal_assert((r->>'ready')::boolean AND r->>'proposal_id'=p->>'proposal_id'
    AND r->>'revision'=p->>'revision' AND jsonb_array_length(r->'voter_ids')=5,
    'all current participants produce exact unanimous consensus');
  -- Session mutations below are nested synthetic transactions, restored before
  -- the real native cash proof. Existing payers/receipts are never replaced.
  BEGIN
    r:=public.fn_close_tournament_deal_review(tid,(review->>'review_id')::uuid,'expired');
    PERFORM pg_temp.deal_assert(r->>'reason'='review_not_expired','manager cannot invent early expiry');
    PERFORM set_config('request.jwt.claim.sub',md5('atomic-deal-user:6')::uuid::text,true);
    r:=public.fn_cancel_tournament_deal_review(tid,(review->>'review_id')::uuid,auth.uid());
    PERFORM pg_temp.deal_assert(r->>'reason'='voter_not_alive','eliminated participant cannot cancel active review');
    RAISE EXCEPTION 'restore actor' USING ERRCODE='P7710';
  EXCEPTION WHEN SQLSTATE 'P7710' THEN NULL; END;
  BEGIN
    PERFORM set_config('app.smarter_tournament_lease_generation','87900000-0000-0000-0000-000000000002',true);
    BEGIN
      PERFORM public.fn_complete_tournament_terminal_proposal(tid,NULL,'final_table_deal',(p->>'proposal_id')::uuid,p->>'revision');
      RAISE EXCEPTION 'unclaimed manager generation reached terminal';
    EXCEPTION WHEN check_violation THEN
      IF SQLERRM NOT LIKE '%active review and manager generation%' THEN RAISE; END IF;
    END;
    PERFORM pg_temp.deal_assert(pg_temp.exact_deal_money_state()=s,'unclaimed manager generation refuses before native terminal call');
    r:=public.fn_begin_tournament_deal_review(tid,(review->>'review_id')::uuid);
    PERFORM pg_temp.deal_assert(r->>'proposal_id'=p->>'proposal_id' AND r->>'revision'=p->>'revision'
      AND r->>'review_expires_at'=begun->>'review_expires_at'
      AND (SELECT manager_lease_generation::text FROM public.tournament_deal_reviews WHERE id=(review->>'review_id')::uuid)
        ='87900000-0000-0000-0000-000000000002','fenced manager recovery keeps exact reviewed plan and deadline');
    RAISE EXCEPTION 'restore manager generation' USING ERRCODE='P7711';
  EXCEPTION WHEN SQLSTATE 'P7711' THEN NULL; END;
  FOR i IN 1..3 LOOP
    BEGIN
      IF i=1 THEN UPDATE public.tournaments SET is_private=NOT COALESCE(is_private,false) WHERE id=tid;
      ELSIF i=2 THEN UPDATE public.tournaments SET union_id='87800000-0000-0000-0000-000000000001' WHERE id=tid;
      ELSE UPDATE public.tournaments SET club_id=NULL WHERE id=tid; END IF;
      r:=public.fn_cast_tournament_deal_vote(tid,(p->>'proposal_id')::uuid,auth.uid());
      PERFORM pg_temp.deal_assert(r->>'reason'='proposal_stale','financial scope field '||i||' invalidates exact consent');
      r:=public.fn_get_tournament_deal_consensus(tid);
      PERFORM pg_temp.deal_assert(r->>'review_id'=review->>'review_id' AND r->>'reason'='review_stale'
        AND (r->>'ready')::boolean=false,'changed financial scope retains review identity but cannot settle '||i);
      RAISE EXCEPTION 'restore scope' USING ERRCODE='P7712';
    EXCEPTION WHEN SQLSTATE 'P7712' THEN NULL;
      WHEN raise_exception OR check_violation THEN
        IF SQLERRM NOT IN ('This tournament cannot be modified after a player has registered','Game Asset Is Immutable') THEN RAISE; END IF;
        PERFORM pg_temp.deal_assert(pg_temp.exact_deal_money_state()=s,'financial scope field '||i||' is immutable after registration under existing native guard');
    END;
  END LOOP;
  BEGIN
    UPDATE public.tournament_deal_reviews SET expires_at=clock_timestamp()-interval '1 second'
      WHERE id=(review->>'review_id')::uuid;
    r:=public.fn_get_tournament_deal_consensus(tid);
    PERFORM pg_temp.deal_assert(r->>'review_state'='expired' AND r->>'review_id'=review->>'review_id'
      AND r->>'proposal_id' IS NULL AND (r->>'ready')::boolean=false,'expired consensus retains exact session without ready identity');
    r:=public.fn_cast_tournament_deal_vote(tid,(p->>'proposal_id')::uuid,auth.uid());
    PERFORM pg_temp.deal_assert(r->>'reason'='review_not_ready','expired review cannot accept another vote');
    r:=public.fn_close_tournament_deal_review(tid,(review->>'review_id')::uuid,'expired');
    PERFORM pg_temp.deal_assert(r->>'review_state'='expired' AND r->>'review_id'=review->>'review_id'
      AND pg_temp.exact_deal_money_state()=s,'expiry closes only exact review and makes no money mutation');
    r:=public.fn_begin_tournament_deal_review(tid,(review->>'review_id')::uuid);
    PERFORM pg_temp.deal_assert(r->>'review_state'='expired' AND r->>'review_id'=review->>'review_id',
      'late begin cannot reactivate expired review');
    RAISE EXCEPTION 'restore deadline' USING ERRCODE='P7713';
  EXCEPTION WHEN SQLSTATE 'P7713' THEN NULL; END;
  BEGIN
    r:=public.fn_cancel_tournament_deal_review(tid,(review->>'review_id')::uuid,auth.uid());
    PERFORM pg_temp.deal_assert(r->>'state'='cancelled' AND r->>'review_id'=review->>'review_id'
      AND r->>'proposal_id' IS NULL,'remaining participant cancels exact review without erasing historical consent');
    r:=public.fn_request_tournament_deal_review(tid,auth.uid());
    PERFORM pg_temp.deal_assert(r->>'reason'='review_wait_for_next_hand','same hand cannot be paused repeatedly by request cancel spam');
    -- A synthetic durable committed-hand row advances the admission witness.
    -- Actual hand commit/lease production is separately covered by its native
    -- producer suite; this verifies the review consumer against that catalog.
    INSERT INTO public.hand_atomic_commits(table_id,hand_number,hand_id,payload_hash,stack_result)
      VALUES('87200000-0000-0000-0000-000000000001',1000000,'87700000-0000-0000-0000-000000000001',repeat('a',64),'{}'::jsonb);
    r:=public.fn_request_tournament_deal_review(tid,auth.uid());
    PERFORM pg_temp.deal_assert(r->>'state'='requested' AND r->>'review_id'<>review->>'review_id',
      'new committed hand admits a new distinct review epoch');
    r:=public.fn_begin_tournament_deal_review(tid,(r->>'review_id')::uuid);
    PERFORM pg_temp.deal_assert(r->>'review_state'='reviewing' AND r->>'proposal_id'<>p->>'proposal_id'
      AND r->>'revision'<>p->>'revision' AND r->'voter_ids'='[]'::jsonb AND (r->>'ready')::boolean=false,
      'new review epoch cannot resurrect prior proposal or unanimous consents');
    old_revision:=r->>'review_id';
    r:=public.fn_begin_tournament_deal_review(tid,(review->>'review_id')::uuid);
    PERFORM pg_temp.deal_assert(r->>'review_state'='cancelled' AND r->>'review_id'=review->>'review_id'
      AND r->>'proposal_id' IS NULL,'old begin replay reports old closed review rather than newer epoch');
    r:=public.fn_cancel_tournament_deal_review(tid,(review->>'review_id')::uuid,auth.uid());
    PERFORM pg_temp.deal_assert(r->>'state'='cancelled' AND r->>'review_id'=review->>'review_id'
      AND (SELECT state FROM public.tournament_deal_reviews WHERE id=old_revision::uuid)='reviewing',
      'old cancellation replay cannot close newer active review');
    BEGIN
      PERFORM public.fn_complete_tournament_terminal_proposal(tid,NULL,'final_table_deal',(p->>'proposal_id')::uuid,p->>'revision');
      RAISE EXCEPTION 'cancelled epoch reached terminal';
    EXCEPTION WHEN check_violation THEN
      IF SQLERRM NOT LIKE '%active review and manager generation%' THEN RAISE; END IF;
    END;
    PERFORM pg_temp.deal_assert(pg_temp.exact_deal_money_state()=s,'cancelled epoch cannot enter money authority after new request');
    RAISE EXCEPTION 'restore original review and hand witness' USING ERRCODE='P7714';
  EXCEPTION WHEN SQLSTATE 'P7714' THEN NULL; END;

  -- The nested transaction restores the genuine joined_at generation. No
  -- payer, ledger or guard is replaced to simulate this hostile change.
  BEGIN
    UPDATE public.table_seats SET joined_at=joined_at+interval '1 second'
      WHERE id=md5('atomic-deal-seat:1')::uuid;
    r:=public.fn_cast_tournament_deal_vote(tid,(p->>'proposal_id')::uuid,auth.uid());
    PERFORM pg_temp.deal_assert(r->>'reason'='proposal_stale','seat generation invalidates reviewed vote');
    r:=public.fn_get_tournament_deal_consensus(tid);
    PERFORM pg_temp.deal_assert((r->>'ready')::boolean=false,'stale unanimous plan cannot satisfy parked consensus');
    BEGIN
      PERFORM public.fn_settle_tournament_final_table_deal(tid);
      RAISE EXCEPTION 'stale reviewed plan unexpectedly paid';
    EXCEPTION WHEN check_violation THEN
      IF SQLERRM NOT LIKE '%proposal is stale%' THEN RAISE; END IF;
    END;
    PERFORM pg_temp.deal_assert(NOT EXISTS(SELECT 1 FROM public.tournament_payouts WHERE tournament_id=tid AND source='final_table_deal'),
      'change after consent refuses real cash before first credit');
    RAISE EXCEPTION 'restore hostile seat generation' USING ERRCODE='P7701';
  EXCEPTION WHEN SQLSTATE 'P7701' THEN NULL; END;
  PERFORM pg_temp.deal_assert(pg_temp.exact_deal_money_state()=s,'stale-plan refusal leaves original money state intact');
  PERFORM set_config('app.tournament_deal_proposal_revision',repeat('0',64),true);
  BEGIN
    PERFORM public.fn_settle_tournament_final_table_deal(tid);
    RAISE EXCEPTION 'changed revision unexpectedly paid';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%identity mismatch%' THEN RAISE; END IF;
  END;
  PERFORM pg_temp.deal_assert(pg_temp.exact_deal_money_state()=s,'changed terminal revision rolls back money');
  PERFORM set_config('app.tournament_deal_proposal_revision',p->>'revision',true);
  PERFORM set_config('app.tournament_deal_proposal_id','',true);
  BEGIN
    PERFORM public.fn_settle_tournament_final_table_deal(tid);
    RAISE EXCEPTION 'unbound legacy request unexpectedly paid';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE '%proposal context required%' THEN RAISE; END IF;
  END;
  PERFORM pg_temp.deal_assert(pg_temp.exact_deal_money_state()=s,'unbound legacy cash request rolls back');
  PERFORM set_config('app.tournament_deal_proposal_id',p->>'proposal_id',true);
  BEGIN
    INSERT INTO public.tournament_obligations(tournament_id,kind,user_id,amount_owed,amount_paid,source)
      VALUES(tid,'final_table_deal',md5('atomic-deal-user:1')::uuid,6.34,0,'final_table_deal');
    RAISE EXCEPTION 'altered amount unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%approved recipient or amount%' THEN RAISE; END IF;
  END;
  PERFORM pg_temp.deal_assert(pg_temp.exact_deal_money_state()=s,'one-cent changed obligation refused');
  BEGIN
    UPDATE public.tournament_deal_proposals SET snapshot='{}'::jsonb WHERE id=(p->>'proposal_id')::uuid;
    RAISE EXCEPTION 'proposal evidence unexpectedly changed';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%append-only%' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM public.tournament_deal_proposal_consents WHERE proposal_id=(p->>'proposal_id')::uuid;
    RAISE EXCEPTION 'consent evidence unexpectedly removed';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%append-only%' THEN RAISE; END IF;
  END;
  PERFORM pg_temp.deal_assert(true,'proposal and consent evidence are append-only');
END;
$proposal$;

-- This refusal trigger observes an actual earlier credit, then forces the
-- actual payer transaction to abort. It cannot report settlement success.
CREATE FUNCTION pg_temp.refuse_second_real_deal_credit()
RETURNS trigger LANGUAGE plpgsql AS $fail$
DECLARE v_prior integer;
BEGIN
  IF NEW.related_entity_id='87000000-0000-0000-0000-000000000001'::uuid THEN
    SELECT count(*) INTO v_prior FROM public.wallet_transactions
      WHERE related_entity_id=NEW.related_entity_id AND user_id<>md5('atomic-deal-user:6')::uuid;
    IF v_prior=1 THEN
      RAISE EXCEPTION 'refused after observing one real prior credit' USING ERRCODE='P7702';
    END IF;
  END IF;
  RETURN NEW;
END;
$fail$;
CREATE TRIGGER probe_refuse_second_real_deal_credit BEFORE INSERT ON public.wallet_transactions
FOR EACH ROW EXECUTE FUNCTION pg_temp.refuse_second_real_deal_credit();
DO $rollback$
DECLARE s jsonb:=pg_temp.exact_deal_money_state();
BEGIN
  BEGIN
    PERFORM public.fn_settle_tournament_final_table_deal('87000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'downstream refusal unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P7702' THEN NULL; END;
  PERFORM pg_temp.deal_assert(pg_temp.exact_deal_money_state()=s,'downstream refusal rolls back earlier native cash credit and every liability');
END;
$rollback$;
DROP TRIGGER probe_refuse_second_real_deal_credit ON public.wallet_transactions;

DO $cash$
DECLARE tid uuid:='87000000-0000-0000-0000-000000000001'; first_receipt jsonb; second_receipt jsonb; s jsonb; r jsonb; rid uuid;
BEGIN
  first_receipt:=public.fn_settle_tournament_final_table_deal(tid);
  PERFORM pg_temp.deal_assert((first_receipt->>'ok')::boolean AND
    (SELECT sum(amount) FROM public.tournament_payouts WHERE tournament_id=tid)=100 AND
    (SELECT count(*) FROM public.tournament_payouts WHERE tournament_id=tid AND source='final_table_deal')=5 AND
    (SELECT sum(amount) FROM public.tournament_payouts WHERE tournament_id=tid AND source='final_table_deal')=95 AND
    (SELECT prize_balance FROM public.tournament_escrow WHERE tournament_id=tid)=0 AND
    NOT EXISTS(SELECT 1 FROM public.tournament_obligations WHERE tournament_id=tid AND amount_owed<>amount_paid),
    'real native authority pays exact full fixed plus deal pool and closes every cash debt');
  PERFORM pg_temp.deal_assert(NOT EXISTS(
    SELECT 1 FROM public.tournament_payouts paid JOIN public.tournament_deal_proposals p ON p.tournament_id=paid.tournament_id
      CROSS JOIN LATERAL jsonb_array_elements(p.snapshot->'shares')approved_share
      WHERE paid.tournament_id=tid AND paid.source='final_table_deal' AND approved_share->>'user_id'=paid.user_id::text
        AND paid.amount*100<>(approved_share->>'amount_cents')::numeric),
    'every native payout matches immutable approved cents');
  PERFORM pg_temp.deal_assert((SELECT sum(chip_balance) FROM public.club_members WHERE user_id IN
    (SELECT user_id FROM public.tournament_players WHERE tournament_id=tid))=100,
    'wallet balances retain exact full pool after every fixed-tail starting state');
  PERFORM pg_temp.deal_assert((SELECT sum(amount) FROM public.wallet_transactions WHERE related_entity_id=tid)=100,
    'native wallet journal retains exactly the full funded cash pool');
  SELECT id INTO rid FROM public.tournament_deal_reviews WHERE tournament_id=tid;
  r:=public.fn_close_tournament_deal_review(tid,rid,'stale');
  PERFORM pg_temp.deal_assert(r->>'reason'='terminal_outcome_pending','cash already completing cannot yield dealer-release proof without whole-terminal result');
  r:=public.fn_begin_tournament_deal_review(tid,rid);
  PERFORM pg_temp.deal_assert(r->>'reason'='terminal_outcome_pending','begin cannot expire or reactivate review over a completing cash outcome');
  s:=pg_temp.exact_deal_money_state();
  second_receipt:=public.fn_settle_tournament_final_table_deal(tid);
  PERFORM pg_temp.deal_assert(pg_temp.exact_deal_money_state()=s,'native cash replay makes no second credit or state mutation');
END;
$cash$;

DO $acl$
BEGIN
  PERFORM pg_temp.deal_assert(has_function_privilege('authenticated','public.fn_get_tournament_deal_proposal(uuid)','EXECUTE')
    AND has_function_privilege('authenticated','public.fn_cast_tournament_deal_vote(uuid,uuid,uuid)','EXECUTE')
    AND NOT has_function_privilege('anon','public.fn_get_tournament_deal_proposal(uuid)','EXECUTE')
    AND NOT has_function_privilege('authenticated','public.fn_ca_tournament_deal_snapshot(uuid)','EXECUTE')
    AND NOT has_function_privilege('service_role','public.fn_ca_tournament_deal_snapshot(uuid)','EXECUTE'),
    'actor RPC grants and owner-only snapshot match intended boundary');
  PERFORM pg_temp.deal_assert(has_function_privilege('service_role','public.fn_get_tournament_deal_consensus(uuid)','EXECUTE')
    AND has_function_privilege('service_role','public.fn_complete_tournament_terminal_proposal(uuid,uuid,text,uuid,text)','EXECUTE')
    AND has_function_privilege('service_role','public.fn_resolve_tournament_terminal_proposal_outcome(uuid,uuid,text,uuid,text)','EXECUTE')
    AND NOT has_function_privilege('authenticated','public.fn_complete_tournament_terminal_proposal(uuid,uuid,text,uuid,text)','EXECUTE')
    AND NOT has_table_privilege('authenticated','public.tournament_deal_proposal_consents','INSERT')
    AND NOT has_table_privilege('service_role','public.tournament_deal_proposal_executions','UPDATE'),
    'service RPC boundary and direct evidence write refusals are exact');
  PERFORM pg_temp.deal_assert(has_function_privilege('authenticated','public.fn_request_tournament_deal_review(uuid,uuid)','EXECUTE')
    AND has_function_privilege('authenticated','public.fn_cancel_tournament_deal_review(uuid,uuid,uuid)','EXECUTE')
    AND NOT has_function_privilege('anon','public.fn_request_tournament_deal_review(uuid,uuid)','EXECUTE')
    AND NOT has_function_privilege('authenticated','public.fn_begin_tournament_deal_review(uuid,uuid)','EXECUTE')
    AND NOT has_table_privilege('authenticated','public.tournament_deal_reviews','UPDATE')
    AND NOT has_table_privilege('service_role','public.tournament_deal_review_policy','UPDATE'),
    'review actor and manager RPC permissions protect direct session and policy writes');
  PERFORM pg_temp.deal_assert(to_regprocedure('public.fn_request_tournament_deal_review(uuid)') IS NULL
    AND to_regprocedure('public.fn_cancel_tournament_deal_review(uuid,uuid)') IS NULL
    AND to_regprocedure('public.fn_cast_tournament_deal_vote(uuid,uuid)') IS NULL,
    'no actor-unbound prepared mutation overload remains');

END;
$acl$;
ROLLBACK;
