-- Owner-authorized basis, installed. Every refusal leaves the whole public and
-- private catalog byte-identical; the one operation resolves the exact fee.
CREATE FUNCTION held_fee_fixture.events(p_amount numeric DEFAULT 2.70) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_array(jsonb_build_object('tournament_id',held_fee_fixture.event(),'amount',p_amount)) $$;
BEGIN;
DO $$ DECLARE state jsonb;message text;code text;BEGIN
 state:=held_fee_fixture.snapshot();
 PERFORM set_config('request.jwt.claims','{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000a001"}',true);
 BEGIN PERFORM public.fn_ca_recognize_held_tournament_fees_by_owner_basis(held_fee_fixture.operation(),held_fee_fixture.events());
 EXCEPTION WHEN OTHERS THEN message:=SQLERRM;code:=SQLSTATE; END;
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 PERFORM held_fee_fixture.assert(code IN('42501') AND state=held_fee_fixture.snapshot(),'A browser identity cannot run the owner operation: '||COALESCE(message,'<none>'));
 BEGIN PERFORM public.fn_settle_tournament_rake(held_fee_fixture.event(),'held-fee-direct');
 EXCEPTION WHEN OTHERS THEN message:=SQLERRM;code:=SQLSTATE; END;
 PERFORM held_fee_fixture.assert(message IN('cash_commission_earning_club_not_observed','accounting_terms_not_observed') AND state=held_fee_fixture.snapshot(),
  'Without a recorded owner basis the installed capture still refuses at the charge-time contract');
 message:=NULL;
 BEGIN PERFORM public.fn_ca_recognize_held_tournament_fees_by_owner_basis(held_fee_fixture.operation(),held_fee_fixture.events(2.69));
 EXCEPTION WHEN OTHERS THEN message:=SQLERRM;code:=SQLSTATE; END;
 PERFORM held_fee_fixture.assert(message LIKE 'owner_fee_event_is_not_exactly_held%' AND code='P0404' AND state=held_fee_fixture.snapshot(),
  'A listed amount that differs from the held fee refuses with nothing recorded');
 message:=NULL;
 BEGIN PERFORM public.fn_ca_recognize_held_tournament_fees_by_owner_basis(held_fee_fixture.operation(),'[]'::jsonb);
 EXCEPTION WHEN OTHERS THEN message:=SQLERRM;code:=SQLSTATE; END;
 PERFORM held_fee_fixture.assert(message='owner_fee_operation_invalid' AND state=held_fee_fixture.snapshot(),'An empty operation refuses');
END $$;
-- A contributor club with no agreement at completion either: nothing is
-- guessed, the whole operation refuses and the fee stays held.
SAVEPOINT missing_completion_terms;
SET LOCAL session_replication_role=replica;
DELETE FROM public.accounting_agreement_history WHERE entity_type='union_clubs'
 AND club_id=(SELECT max(club_id::text)::uuid FROM held_fee_fixture.contributors);
SET LOCAL session_replication_role=origin;
DO $$ DECLARE state jsonb;message text;BEGIN
 state:=held_fee_fixture.snapshot();
 BEGIN PERFORM public.fn_ca_recognize_held_tournament_fees_by_owner_basis(held_fee_fixture.operation(),held_fee_fixture.events());
 EXCEPTION WHEN OTHERS THEN message:=SQLERRM; END;
 PERFORM held_fee_fixture.assert(message='cash_commission_earning_club_not_observed' AND state=held_fee_fixture.snapshot(),
  'Missing completion-time agreement refuses the whole operation with every write rolled back');
END $$;
ROLLBACK TO missing_completion_terms;
COMMIT;
-- A basis recorded by another (committed) transaction authorizes nothing later.
BEGIN;
SET LOCAL session_replication_role=replica;
INSERT INTO public.accounting_tournament_fee_owner_operations(operation_id,basis_kind,reason,owner_instruction,authorized_on,events,event_count,amount)
 VALUES('e1d0f00d-0000-4000-8000-00000000dead','owner_authorized_host_club_fee','stale','stale','2026-09-27',held_fee_fixture.events(),1,2.70);
INSERT INTO public.accounting_tournament_fee_owner_bases(tournament_id,operation_id,basis_kind,hosting_club_id,union_id,completed_at,amount,obligation_id,source_fingerprint,reason,owner_instruction,authorized_on)
 SELECT held_fee_fixture.event(),'e1d0f00d-0000-4000-8000-00000000dead','owner_authorized_host_club_fee',t.club_id,t.union_id,h.completed_at,2.70,o.id,o.source_fingerprint,'stale','stale','2026-09-27'
 FROM public.tournaments t,public.tournament_terminal_settlements h,public.accounting_tournament_fee_custody_obligations o
 WHERE t.id=held_fee_fixture.event() AND h.tournament_id=t.id AND o.tournament_id=t.id;
SET LOCAL session_replication_role=origin;
COMMIT;
BEGIN;
SET LOCAL request.jwt.claims='{"role":"service_role"}';
DO $$ DECLARE state jsonb;message text;BEGIN
 state:=held_fee_fixture.snapshot();
 BEGIN PERFORM public.fn_settle_tournament_rake(held_fee_fixture.event(),'held-fee-stale-basis');
 EXCEPTION WHEN OTHERS THEN message:=SQLERRM; END;
 PERFORM held_fee_fixture.assert(message IN('cash_commission_earning_club_not_observed','accounting_terms_not_observed') AND state=held_fee_fixture.snapshot(),
  'A basis committed by another transaction cannot authorize a later capture');
 BEGIN PERFORM public.fn_ca_recognize_held_tournament_fees_by_owner_basis(held_fee_fixture.operation(),held_fee_fixture.events());
 EXCEPTION WHEN OTHERS THEN message:=SQLERRM; END;
 PERFORM held_fee_fixture.assert(message LIKE 'duplicate key value violates unique constraint%' AND state=held_fee_fixture.snapshot(),
  'An event can carry only one owner basis');
END $$;
ROLLBACK;
BEGIN;
SET LOCAL session_replication_role=replica;
DELETE FROM public.accounting_tournament_fee_owner_bases WHERE operation_id='e1d0f00d-0000-4000-8000-00000000dead';
DELETE FROM public.accounting_tournament_fee_owner_operations WHERE operation_id='e1d0f00d-0000-4000-8000-00000000dead';
SET LOCAL session_replication_role=origin;
COMMIT;
BEGIN;
SET LOCAL request.jwt.claims='{"role":"service_role"}';
DO $$ BEGIN
 PERFORM held_fee_fixture.assert(NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_owner_bases) AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_owner_operations),
  'Fixture-only stale basis removed before the real operation');
END $$;
COMMIT;
-- The operation.
BEGIN;
SET LOCAL request.jwt.claims='{"role":"service_role"}';
CREATE TEMP TABLE held_fee_before AS SELECT held_fee_fixture.snapshot() AS state,
 (SELECT to_jsonb(h) FROM public.tournament_terminal_settlements h WHERE tournament_id=held_fee_fixture.event()) AS header,
 (SELECT COALESCE(round(sum(CASE WHEN to_type='settlement_suspense' THEN amount ELSE -amount END),2),0) FROM public.chip_ledger WHERE from_type='settlement_suspense' OR to_type='settlement_suspense') AS suspense;
CREATE TEMP TABLE held_fee_result AS SELECT public.fn_ca_recognize_held_tournament_fees_by_owner_basis(held_fee_fixture.operation(),held_fee_fixture.events()) AS result;
DO $$ DECLARE r jsonb;q record;k record;receipt jsonb;winner uuid;BEGIN
 SELECT result INTO r FROM held_fee_result;
 RAISE NOTICE 'OWNER_OPERATION_RESULT %',r;
 PERFORM held_fee_fixture.assert(r->>'ok'='true' AND r->>'replayed'='false' AND (r->>'event_count')::int=1 AND (r->>'amount')::numeric=2.70
  AND (r->>'escrow_out')::numeric=2.70 AND (r->>'bank_in')::numeric=2.70 AND (r->>'recognized_credit')::numeric=2.70
  AND r->>'prizes_unchanged'='true' AND (r->>'settlement_suspense_net')::numeric=(SELECT suspense FROM held_fee_before),
  'One operation moves exactly 2.70: escrow out = bank in = recognized credit, suspense unchanged');
 SELECT * INTO q FROM public.accounting_tournament_fee_recognitions WHERE tournament_id=held_fee_fixture.event();
 SELECT user_id INTO winner FROM public.tournament_players WHERE tournament_id=held_fee_fixture.event() AND position=1;
 receipt:=public.fn_ca_tournament_terminal_receipt(held_fee_fixture.event(),winner);
 PERFORM held_fee_fixture.assert(q.status='recognized' AND q.net_rake=2.70 AND q.union_id=held_fee_fixture.union_id()
  AND q.bank_club_id=(SELECT club_id FROM public.tournaments WHERE id=held_fee_fixture.event())
  AND receipt->>'accounting_state'='recognized' AND receipt->>'accounting_complete'='true' AND receipt->>'fully_settled'='true'
  AND receipt->>'player_result'='final',
  'The canonical terminal receipt reports the fee recognized and the event fully settled');
 PERFORM held_fee_fixture.assert((SELECT fee_balance=0 AND fee_out=2.70 AND prize_balance=0 AND bounty_balance=0 AND closed_at IS NULL FROM public.tournament_escrow WHERE tournament_id=held_fee_fixture.event())
  AND (SELECT count(*)=1 AND sum(amount)=2.70 FROM public.union_wallet_transactions u WHERE u.id=q.union_wallet_transaction_id
   AND u.union_id=held_fee_fixture.union_id() AND u.club_id=q.bank_club_id AND u.wallet='rake_wallet' AND u.direction='credit' AND u.tx_type='rake'
   AND u.created_at=q.recognized_at AND position('[tournament '||held_fee_fixture.event()::text||']' IN u.notes)>0)
  AND (SELECT count(*)=1 FROM public.accounting_tournament_fee_custody_resolutions WHERE tournament_id=held_fee_fixture.event() AND amount=2.70 AND resolved_at=q.recognized_at),
  'Escrow fee leaves once into the hosting club''s union rake bank with its exact receipt');
 PERFORM held_fee_fixture.assert((SELECT count(*)=27 AND sum(rake_credit)=2.70 FROM public.accounting_tournament_fee_sources WHERE tournament_id=held_fee_fixture.event())
  AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources s JOIN held_fee_fixture.contributors c ON c.rake_record_id=s.rake_record_id
   WHERE s.club_id IS DISTINCT FROM c.club_id OR s.player_id IS DISTINCT FROM c.user_id OR s.charged_at IS DISTINCT FROM c.charged_at
    OR s.contract->'owner_basis'->>'operation_id' IS DISTINCT FROM held_fee_fixture.operation()::text
    OR (s.contract->>'terms_at')::timestamptz IS DISTINCT FROM (SELECT completed_at FROM public.tournament_terminal_settlements WHERE tournament_id=held_fee_fixture.event())
    OR (s.contract->'owner_basis'->>'original_terms_at')::timestamptz IS DISTINCT FROM c.charged_at
    OR s.contract->'owner_basis'->>'original_refusal' NOT IN('cash_commission_earning_club_not_observed','accounting_terms_not_observed')
    OR s.contract->'union_agreement'->'terms'->>'club_id' IS DISTINCT FROM c.club_id::text
    OR s.contract->'membership'->>'history_id' IS NULL)
  AND (SELECT sum(rake_credit)=2.70 FROM public.accounting_tournament_recognized_sources WHERE tournament_id=held_fee_fixture.event() AND disposition='earned'),
  'Every contributor is priced by the agreement recorded at completion and names the owner basis');
 PERFORM held_fee_fixture.assert((SELECT count(*)>0 AND bool_and(ac.amount=round(s.rake_credit*0.3,2) AND ac.commission_rate=0.3 AND ac.created_at=q.recognized_at
   AND ac.user_id=(SELECT user_id FROM held_fee_fixture.agent) AND ac.club_id=s.club_id)
   FROM public.agent_commissions ac JOIN public.accounting_tournament_fee_sources s ON s.id=ac.source_id
   WHERE ac.source_type='tournament_fee_accrual' AND s.tournament_id=held_fee_fixture.event())
  AND NOT EXISTS(SELECT 1 FROM public.agent_commissions ac JOIN public.accounting_tournament_fee_sources s ON s.id=ac.source_id
   WHERE ac.source_type='tournament_fee_accrual' AND s.tournament_id=held_fee_fixture.event()
    AND s.player_id NOT IN((SELECT agent_member FROM held_fee_fixture.agent),(SELECT user_id FROM held_fee_fixture.agent)))
  AND (SELECT count(DISTINCT s.player_id)=2 FROM public.agent_commissions ac JOIN public.accounting_tournament_fee_sources s ON s.id=ac.source_id
   WHERE ac.source_type='tournament_fee_accrual' AND s.tournament_id=held_fee_fixture.event()),
  'Only the recorded hierarchy at completion earns commission (the agent''s own play and its member); no rate is invented for anyone else');
 PERFORM held_fee_fixture.assert((SELECT count(*)=1 FROM public.accounting_tournament_fee_owner_bases b JOIN public.tournament_terminal_settlements h USING(tournament_id)
   WHERE b.operation_id=held_fee_fixture.operation() AND b.completed_at=h.completed_at AND b.amount=2.70 AND b.authorized_on='2026-09-27'
    AND b.hosting_club_id=(SELECT club_id FROM public.tournaments WHERE id=held_fee_fixture.event()) AND b.union_id=held_fee_fixture.union_id()
    AND b.basis_kind='owner_authorized_host_club_fee' AND b.reason LIKE 'Owner-authorized recognition basis:%' AND b.owner_instruction LIKE 'Dan, 2026-09-27:%')
  AND (SELECT to_jsonb(h) FROM public.tournament_terminal_settlements h WHERE tournament_id=held_fee_fixture.event())=(SELECT header FROM held_fee_before),
  'The basis records reason, owner instruction, date and operation; the immutable player terminal header is untouched');
 -- The normal weekly accounting of the recognition week reads these sources.
 FOR k IN SELECT DISTINCT club_id FROM held_fee_fixture.contributors UNION SELECT club_id FROM public.tournaments WHERE id=held_fee_fixture.event() LOOP
  PERFORM held_fee_fixture.assert(public.fn_accounting_tournament_week_quality(k.club_id,q.recognized_at-interval '1 hour',q.recognized_at+interval '1 hour')->>'status'='ready',
   'Weekly tournament quality gate is ready with the owner-basis sources for club '||k.club_id);
 END LOOP;
 PERFORM held_fee_fixture.assert((SELECT count(*)=2 FROM public.accounting_period_recompute_requests WHERE status='pending'
   AND period_start=(public.fn_union_week_start(q.recognized_at) AT TIME ZONE 'America/Los_Angeles')::date
   AND club_id IN(SELECT club_id FROM held_fee_fixture.contributors)),
  'Recognition requests the normal recompute of its own week for each contributor club');
 r:=public.fn_accounting_union_earned_plan(held_fee_fixture.union_id(),(SELECT starts_at FROM public.accounting_cash_accrual_cutover WHERE singleton),q.recognized_at+interval '1 hour');
 RAISE NOTICE 'UNION_EARNED_PLAN %',r;
 PERFORM held_fee_fixture.assert((r->>'earned_rake')::numeric=(r->>'period_rake')::numeric AND (r->>'earned_rake')::numeric>=2.70
  AND (SELECT sum(s.rake_credit)=2.70 FROM public.accounting_payable_earning_sources s WHERE s.tournament_id=held_fee_fixture.event() AND s.earned_at=q.recognized_at),
  'Union earned plan verifies every owner-basis agreement and conserves the bank');
END $$;
COMMIT;
-- Rakeback period reader: the calculator joins each source's recorded
-- membership and direct-agent history at its agreement instant, which for an
-- owner-basis source is the recorded completion. Evaluate that exact join for
-- every owner-basis source (the calculator itself refuses a week before the
-- fixture's cash cutover, so its own verdict here would say nothing).
BEGIN;
DO $$ BEGIN
 PERFORM held_fee_fixture.assert(NOT EXISTS(
  SELECT 1 FROM public.accounting_payable_earning_sources s
   JOIN public.accounting_tournament_fee_sources fee ON fee.id=s.source_id
   LEFT JOIN public.accounting_agreement_history mh ON mh.id=(s.contract->'membership'->>'history_id')::bigint
    AND mh.entity_type='club_members' AND mh.entity_key=s.club_id::text||':'||s.player_id::text
    AND mh.observed_at<=public.fn_accounting_tournament_source_terms_at(fee.tournament_id,fee.charged_at,fee.contract)
   LEFT JOIN public.accounting_agreement_history ah ON ah.id=(s.contract->'tiers'->0->'agreement'->>'history_id')::bigint
    AND ah.entity_type='agents' AND ah.observed_at<=public.fn_accounting_tournament_source_terms_at(fee.tournament_id,fee.charged_at,fee.contract)
  WHERE s.source_type='tournament_fee_accrual' AND s.tournament_id=held_fee_fixture.event()
   AND (mh.id IS NULL OR s.contract->'membership'->'terms' IS DISTINCT FROM mh.after_terms
    OR (NULLIF(s.contract->'membership'->'terms'->>'agent_id','') IS NOT NULL AND (ah.id IS NULL OR s.contract->'tiers'->0->'agreement'->'terms' IS DISTINCT FROM ah.after_terms))))
  AND (SELECT count(*)=27 FROM public.accounting_payable_earning_sources s WHERE s.source_type='tournament_fee_accrual' AND s.tournament_id=held_fee_fixture.event()),
  'Rakeback period membership and agent joins verify at the owner-basis agreement instant for all27 sources');
 PERFORM held_fee_fixture.assert(EXISTS(
  SELECT 1 FROM public.accounting_tournament_fee_sources fee
   JOIN public.accounting_agreement_history mh ON mh.id=(fee.contract->'membership'->>'history_id')::bigint
  WHERE fee.tournament_id=held_fee_fixture.event() AND mh.observed_at>fee.charged_at),
  'The same joins at the original charge instant would have found no membership, which is the defect');
END $$;
ROLLBACK;
-- The weekly readers call the agreement-instant rule once per source row; it
-- must inline into their plans rather than run as an opaque function call.
DO $$ DECLARE plan json;BEGIN
 EXECUTE 'EXPLAIN (VERBOSE, FORMAT JSON) SELECT public.fn_accounting_tournament_source_terms_at(s.tournament_id,s.charged_at,s.contract) FROM public.accounting_tournament_fee_sources s' INTO plan;
 PERFORM held_fee_fixture.assert(plan::text NOT LIKE '%fn_accounting_tournament_source_terms_at%' AND plan::text LIKE '%owner_basis%',
  'The agreement-instant rule inlines into reader plans as a keyed CASE');
END $$;
-- Replays.
BEGIN;
SET LOCAL request.jwt.claims='{"role":"service_role"}';
DO $$ DECLARE state jsonb;r jsonb;message text;code text;BEGIN
 state:=held_fee_fixture.snapshot();
 r:=public.fn_ca_recognize_held_tournament_fees_by_owner_basis(held_fee_fixture.operation(),held_fee_fixture.events());
 PERFORM held_fee_fixture.assert(r->>'replayed'='true' AND (r->>'amount')::numeric=2.70 AND state=held_fee_fixture.snapshot(),
  'Replaying the same operation returns its record and moves nothing');
 BEGIN PERFORM public.fn_ca_recognize_held_tournament_fees_by_owner_basis(held_fee_fixture.operation(),held_fee_fixture.events(2.71));
 EXCEPTION WHEN OTHERS THEN message:=SQLERRM;code:=SQLSTATE; END;
 PERFORM held_fee_fixture.assert(code='40001' AND state=held_fee_fixture.snapshot(),'The operation id cannot be reused for different events');
 message:=NULL;
 BEGIN PERFORM public.fn_ca_recognize_held_tournament_fees_by_owner_basis('e1d0f00d-0000-4000-8000-000000000928',held_fee_fixture.events());
 EXCEPTION WHEN OTHERS THEN message:=SQLERRM;code:=SQLSTATE; END;
 PERFORM held_fee_fixture.assert(message LIKE 'owner_fee_event_is_not_exactly_held%' AND state=held_fee_fixture.snapshot(),
  'A second operation cannot pay a resolved fee again');
 message:=NULL;
 BEGIN UPDATE public.accounting_tournament_fee_owner_bases SET reason='rewritten' WHERE tournament_id=held_fee_fixture.event();
 EXCEPTION WHEN OTHERS THEN message:=SQLERRM; END;
 PERFORM held_fee_fixture.assert(message='owner-authorized tournament fee basis is append-only' AND state=held_fee_fixture.snapshot(),'The recorded basis is append-only');
 message:=NULL;
 BEGIN DELETE FROM public.accounting_tournament_fee_owner_operations WHERE operation_id=held_fee_fixture.operation();
 EXCEPTION WHEN OTHERS THEN message:=SQLERRM; END;
 PERFORM held_fee_fixture.assert(message='owner-authorized tournament fee basis is append-only' AND state=held_fee_fixture.snapshot(),'The recorded operation is append-only');
 message:=NULL;r:=NULL;
 BEGIN r:=public.fn_settle_tournament_rake(held_fee_fixture.event(),'held-fee-replay');
 EXCEPTION WHEN OTHERS THEN message:=SQLERRM; END;
 PERFORM held_fee_fixture.assert(((r->>'ok'='true' AND r->>'already_settled'='true') OR message LIKE 'terminal tournament % has immutable tournament_rake_settlements evidence')
  AND state=held_fee_fixture.snapshot(),
  'The ordinary settlement door cannot settle the resolved fee again and moves nothing');
END $$;
COMMIT;
SELECT 'HELD_FEE_NATIVE_RECEIPT='||public.fn_ca_tournament_fee_custody_receipt(held_fee_fixture.event())::text;
