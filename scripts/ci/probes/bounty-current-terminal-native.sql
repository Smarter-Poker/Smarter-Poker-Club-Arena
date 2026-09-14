-- Rollback-only companion to bounty-rebuy-generation-atomicity.sql.
-- Split at the explicit markers. Inject FIXTURE before that probe's first
-- SET LOCAL session_replication_role=origin; append EXERCISE after its five
-- cases and before its final evidence/rollback. No block runs independently.
-- Opening custody, inventory, and accepted-hand chains are synthetic fixtures.
-- Rebuy, elimination claim, bounty payment, terminal payment, finish receipt,
-- seat capabilities, replay, and rollback execute the real current authorities.
-- This probe does not claim engine execution of either synthetic hand.

-- BEGIN BOUNTY TERMINAL FIXTURE
DO $terminal_fixture_role$
BEGIN
 IF current_setting('session_replication_role')<>'replica' THEN
  RAISE EXCEPTION 'bounty terminal opening fixture belongs before native triggers resume';
 END IF;
END $terminal_fixture_role$;
UPDATE public.tournaments
 SET payout_structure='[{"place":1,"percentage":100}]',bubble_protection=false,
     guaranteed_prize=0,synchronized_breaks=false,on_break=false,
     mystery_bounty_pool_cents=CASE WHEN is_mystery_bounty THEN 1000 ELSE 0 END
 WHERE id IN ('b7200000-0000-4000-8000-000000000001',
              'b7200000-0000-4000-8000-000000000002',
              'b7200000-0000-4000-8000-000000000003');
UPDATE public.tournament_mystery_activation_receipts
 SET chest_count=3,pool_cents=1000
 WHERE tournament_id='b7200000-0000-4000-8000-000000000003'
   AND activation_generation=1;
INSERT INTO public.tournament_bounty_chests(id,tournament_id,seq,tier,amount_cents,status)
VALUES ('b7900000-0000-4000-8000-000000000013',
        'b7200000-0000-4000-8000-000000000003',2,'base',250,'available'),
       ('b7900000-0000-4000-8000-000000000023',
        'b7200000-0000-4000-8000-000000000003',3,'base',250,'available');
-- END BOUNTY TERMINAL FIXTURE

-- BEGIN BOUNTY TERMINAL EXERCISE
-- The imported five-case probe flushes SET CONSTRAINTS ALL IMMEDIATE before
-- handing control here. A real subsequent RPC starts a new transaction with
-- every INITIALLY DEFERRED constraint deferred, including roster/seat and
-- mystery award/recipient commit checks. Restore only those catalog-declared
-- defaults; initially immediate constraints retain their normal timing.
CREATE FUNCTION pg_temp.bounty_initial_constraint_mode(p_deferred boolean)
RETURNS void LANGUAGE plpgsql AS $constraint_mode$
DECLARE c record; checked integer:=0;
BEGIN
 FOR c IN SELECT conname,condeferrable,condeferred FROM pg_constraint
  WHERE connamespace='public'::regnamespace AND condeferrable AND condeferred
  ORDER BY conname
 LOOP
  IF NOT c.condeferrable OR NOT c.condeferred THEN
   RAISE EXCEPTION 'reviewed initially deferred constraint differs: %',c.conname;
  END IF;
  EXECUTE format('SET CONSTRAINTS public.%I %s',c.conname,
   CASE WHEN p_deferred THEN 'DEFERRED' ELSE 'IMMEDIATE' END);
  checked:=checked+1;
 END LOOP;
 IF checked<3 THEN
  RAISE EXCEPTION 'requires the retained initially deferred financial and roster constraints, found %',checked;
 END IF;
END $constraint_mode$;
SELECT pg_temp.bounty_initial_constraint_mode(true);
CREATE TEMP TABLE native_bounty_house_before ON COMMIT DROP AS
 SELECT chip_treasury FROM public.clubs
 WHERE id='20000000-0000-0000-0000-000000000001';
CREATE TEMP TABLE native_bounty_terminal_cases(
 n integer PRIMARY KEY,tournament_id uuid NOT NULL,loser_id uuid NOT NULL,
 winner_id uuid NOT NULL,table_id uuid NOT NULL,seat_id uuid NOT NULL,
 history_hand_id uuid NOT NULL,settlement_hand_id uuid NOT NULL,
 candidate_id uuid NOT NULL,hand_number bigint NOT NULL,
 expected_cash_before_terminal numeric NOT NULL,
 expected_residual numeric NOT NULL
) ON COMMIT DROP;
INSERT INTO native_bounty_terminal_cases
SELECT n,('b7200000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 ('b7100000-0000-4000-8000-'||lpad((n*2-1)::text,12,'0'))::uuid,
 ('b7100000-0000-4000-8000-'||lpad((n*2)::text,12,'0'))::uuid,
 ('b7300000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 ('b7400000-0000-4000-8000-'||lpad((n*2-1)::text,12,'0'))::uuid,
 ('b7600000-0000-4000-8000-'||lpad((n+10)::text,12,'0'))::uuid,
 ('b7700000-0000-4000-8000-'||lpad((n+10)::text,12,'0'))::uuid,
 ('b7800000-0000-4000-8000-'||lpad((n+10)::text,12,'0'))::uuid,
 9720010+n,CASE n WHEN 1 THEN 10 WHEN 2 THEN 5 ELSE 7.5 END,
 CASE n WHEN 1 THEN 5 WHEN 2 THEN 10 ELSE 5 END
FROM generate_series(1,3) AS g(n);
CREATE TEMP TABLE native_bounty_terminal_checks(
 id integer GENERATED ALWAYS AS IDENTITY,label text NOT NULL
) ON COMMIT DROP;
CREATE TEMP TABLE native_bounty_terminal_results(
 tournament_id uuid PRIMARY KEY,receipt jsonb NOT NULL
) ON COMMIT DROP;
CREATE FUNCTION pg_temp.bounty_terminal_assert(p_ok boolean,p_label text)
RETURNS void LANGUAGE plpgsql AS $assert$
BEGIN
 IF p_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',p_label; END IF;
 INSERT INTO native_bounty_terminal_checks(label) VALUES(p_label);
 RAISE NOTICE 'PASS bounty_terminal %',p_label;
END $assert$;

-- Advance only the synthetic hand fixture. No financial balance, receipt,
-- payout, roster status, finishing rank, or seat departure is fabricated here.
-- A new entry has a new joined_at; the new candidate captures that exact
-- generation after the already-tested real rebuy has assigned it.
SET LOCAL session_replication_role=replica;
UPDATE public.tournaments t SET current_level=6
 FROM native_bounty_terminal_cases c WHERE t.id=c.tournament_id;
UPDATE public.tournament_players tp
 SET chips=CASE WHEN tp.user_id=c.loser_id THEN 0 ELSE 200 END,
     rebuy_prompt_until=NULL
 FROM native_bounty_terminal_cases c
 WHERE tp.tournament_id=c.tournament_id;
UPDATE public.table_seats s
 SET stack=CASE WHEN s.user_id=c.loser_id THEN 0 ELSE 200 END
 FROM native_bounty_terminal_cases c
 WHERE s.table_id=c.table_id AND s.left_at IS NULL;
INSERT INTO public.settlement_idempotency_keys(table_id,hand_id,status,result,completed_at)
SELECT c.table_id,c.settlement_hand_id,'succeeded',
 jsonb_build_object('success',true,'hand_id',c.settlement_hand_id,
 'hand_number',c.hand_number,'table_id',c.table_id,
 'written',jsonb_build_object(c.loser_id::text,0,c.winner_id::text,200)),clock_timestamp()
FROM native_bounty_terminal_cases c;
INSERT INTO public.hand_atomic_commits(table_id,hand_number,hand_id,payload_hash,stack_result,committed_at)
SELECT c.table_id,c.hand_number,c.history_hand_id,repeat('f',64),
 jsonb_build_object('success',true,'hand_id',c.settlement_hand_id,
 'hand_number',c.hand_number,'table_id',c.table_id,
 'written',jsonb_build_object(c.loser_id::text,0,c.winner_id::text,200)),clock_timestamp()
FROM native_bounty_terminal_cases c;
INSERT INTO public.hand_history(id,table_id,tournament_id,hand_number,created_at,players,pots,winners)
SELECT c.history_hand_id,c.table_id,c.tournament_id,c.hand_number,clock_timestamp(),
 jsonb_build_array(jsonb_build_object('userId',c.loser_id,'stack',0),
                   jsonb_build_object('userId',c.winner_id,'stack',200)),
 jsonb_build_array(jsonb_build_object('index',0,'amount',200,
   'eligible',jsonb_build_array(c.loser_id,c.winner_id))),
 jsonb_build_array(jsonb_build_object('userId',c.winner_id,'potIndex',0,'amount',200))
FROM native_bounty_terminal_cases c;
INSERT INTO public.tournament_knockout_candidates(
 id,tournament_id,eliminated_user_id,table_id,seat_id,seat_joined_at,
 hand_id,hand_number,stack_before,stack_after,state,rebuy_prompt_until)
SELECT c.candidate_id,c.tournament_id,c.loser_id,c.table_id,c.seat_id,s.joined_at,
 c.history_hand_id,c.hand_number,100,0,'pending',clock_timestamp()-interval '1 second'
FROM native_bounty_terminal_cases c JOIN public.table_seats s ON s.id=c.seat_id;
SET LOCAL session_replication_role=origin;
SET LOCAL request.jwt.claim.role='service_role';
SET LOCAL request.jwt.claims='{"role":"service_role"}';

CREATE FUNCTION pg_temp.bounty_terminal_state(p_tournament_id uuid)
RETURNS jsonb LANGUAGE plpgsql AS $state$
DECLARE result jsonb; relation_name text; rows jsonb;
BEGIN
 result:=jsonb_build_object('generation',pg_temp.bounty_rebuy_state(p_tournament_id,
  (SELECT ARRAY[loser_id,winner_id] FROM native_bounty_terminal_cases WHERE tournament_id=p_tournament_id)));
 FOREACH relation_name IN ARRAY ARRAY[
  'tournament_payouts','tournament_place_settlement_batches',
  'tournament_finish_receipts','tournament_terminal_settlements',
  'tournament_bounty_completion_receipts','tournament_bounty_chests',
  'tournament_bounty_awards','tournament_mystery_activation_receipts',
  'tournament_rake_settlements','tournament_guarantee_overlays'
 ] LOOP
  IF to_regclass('public.'||relation_name) IS NULL THEN
   RAISE EXCEPTION 'terminal proof table missing: %',relation_name;
  END IF;
  EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),''[]''::jsonb) FROM public.%I t WHERE to_jsonb(t)->>''tournament_id''=$1',relation_name)
   INTO rows USING p_tournament_id::text;
  result:=result||jsonb_build_object(relation_name,rows);
 END LOOP;
 RETURN result||jsonb_build_object(
  'award_recipients',(SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb)
   FROM public.tournament_bounty_award_recipients r JOIN public.tournament_bounty_awards a ON a.id=r.award_id
   WHERE a.tournament_id=p_tournament_id),
  'club_wallets',(SELECT jsonb_agg(to_jsonb(w) ORDER BY to_jsonb(w)::text) FROM public.club_wallets w),
  'union_wallets',(SELECT jsonb_agg(to_jsonb(w) ORDER BY to_jsonb(w)::text) FROM public.union_wallets w),
  'clubs',(SELECT jsonb_agg(to_jsonb(w) ORDER BY to_jsonb(w)::text) FROM public.clubs w),
  'unions',(SELECT jsonb_agg(to_jsonb(w) ORDER BY to_jsonb(w)::text) FROM public.unions w));
END $state$;

DO $bounty_second_generation$
DECLARE c record;r jsonb;swept jsonb;before_replay jsonb;
BEGIN
 PERFORM pg_temp.bounty_terminal_assert(current_setting('session_replication_role')='origin',
  'native guards active before second-generation claim and all money effects');
 FOR c IN SELECT * FROM native_bounty_terminal_cases ORDER BY n LOOP
  r:=public.fn_claim_tournament_bounty_elimination(c.tournament_id,c.loser_id,2,0,
   c.table_id,c.history_hand_id,c.hand_number,
   (SELECT joined_at FROM public.table_seats WHERE id=c.seat_id),c.winner_id,NULL,0,false);
  PERFORM pg_temp.bounty_terminal_assert(r->>'ok'='true' AND r->>'claimed'='true'
   AND EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=c.tournament_id
    AND user_id=c.loser_id AND status='eliminated' AND position=2 AND chips=0
    AND elimination_sequence IS NOT NULL AND eliminated_at IS NOT NULL)
   AND EXISTS(SELECT 1 FROM public.tournament_knockout_candidates WHERE id=c.candidate_id AND state='eliminated')
   AND EXISTS(SELECT 1 FROM public.table_seats WHERE id=c.seat_id AND left_at IS NOT NULL),
   c.n||': real elimination claims the second exact entry generation and closes its seat');
  IF c.n=3 THEN
   before_replay:=pg_temp.bounty_terminal_state(c.tournament_id);
   swept:=public.fn_sweep_pending_tournament_bounties(c.tournament_id,20);
   PERFORM pg_temp.bounty_terminal_assert(swept->>'ok'='true'
    AND swept->>'processed'='0' AND swept->>'failed'='0' AND swept->>'pending'='1'
    AND EXISTS(SELECT 1 FROM public.tournament_bounty_obligations
      WHERE id=(r->>'obligation_id')::uuid AND state='pending'
       AND next_attempt_at=transaction_timestamp()+interval '30 seconds')
    AND pg_temp.bounty_terminal_state(c.tournament_id)=before_replay,
    'mystery recovery preserves the real 30-second reveal grace without moving money');
   -- A later real RPC starts a new transaction after this deadline. now() is
   -- frozen in our one outer rollback transaction, so model that clock edge
   -- by aging only the synthetic pending obligation's scheduling field.
   -- No award, claimant, generation, payout, or custody value is changed.
   UPDATE public.tournament_bounty_obligations SET next_attempt_at=transaction_timestamp()
    WHERE id=(r->>'obligation_id')::uuid AND state='pending';
  END IF;
  swept:=public.fn_sweep_pending_tournament_bounties(c.tournament_id,20);
  RAISE NOTICE 'BOUNTY_RECOVERY_DIAGNOSTIC=%',jsonb_build_object(
   'case',c.n,'sweep',swept,
   'bounty_credit_total',(SELECT sum(amount) FROM public.wallet_transactions
     WHERE related_entity_id=c.tournament_id AND category='bounty'),
   'obligations',(SELECT jsonb_agg(jsonb_build_object('id',id,'state',state,
     'mode',mode,'last_error',last_error,'marker_complete',public.fn_bounty_obligation_has_complete_marker(id)) ORDER BY id)
     FROM public.tournament_bounty_obligations WHERE tournament_id=c.tournament_id),
   'awards',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id)
     FROM public.tournament_bounty_awards a WHERE a.tournament_id=c.tournament_id));
  PERFORM pg_temp.bounty_terminal_assert(swept->>'ok'='true' AND swept->>'settled'='1'
   AND swept->>'failed'='0' AND swept->>'pending'='0'
   AND (SELECT count(*) FROM public.tournament_bounty_obligations WHERE tournament_id=c.tournament_id
    AND state='settled' AND public.fn_bounty_obligation_has_complete_marker(id))=2
   AND (SELECT sum(amount) FROM public.wallet_transactions
    WHERE related_entity_id=c.tournament_id AND category='bounty')=c.expected_cash_before_terminal,
   c.n||': real current recovery settles exactly the second bounty generation');
  before_replay:=pg_temp.bounty_terminal_state(c.tournament_id);
  swept:=public.fn_sweep_pending_tournament_bounties(c.tournament_id,20);
  PERFORM pg_temp.bounty_terminal_assert(swept->>'processed'='0' AND swept->>'failed'='0'
   AND pg_temp.bounty_terminal_state(c.tournament_id)=before_replay,
   c.n||': settled bounty recovery replay changes no row or balance');
 END LOOP;
 PERFORM pg_temp.bounty_terminal_assert((SELECT current_bounty FROM public.tournament_players
  WHERE tournament_id='b7200000-0000-4000-8000-000000000002'
   AND user_id='b7100000-0000-4000-8000-000000000004')=10,
  'PKO winner retains both 2.5-chip carries before the terminal residual');
END $bounty_second_generation$;
-- Flush the real generation effects before terminal work, then restore the
-- same initial timing for the next real RPC. Invalid awards or seats fail here.
SELECT pg_temp.bounty_initial_constraint_mode(false);
SELECT pg_temp.bounty_initial_constraint_mode(true);

CREATE FUNCTION pg_temp.assert_bounty_terminal_completed(p_tournament_id uuid)
RETURNS void LANGUAGE plpgsql AS $complete$
DECLARE c native_bounty_terminal_cases%ROWTYPE;v jsonb;
BEGIN
 SELECT * INTO STRICT c FROM native_bounty_terminal_cases WHERE tournament_id=p_tournament_id;
 RAISE NOTICE 'BOUNTY_TERMINAL_DIAGNOSTIC=%',jsonb_build_object(
  'case',c.n,
  'event',(SELECT jsonb_build_object('id',t.id,'status',t.status,'ended_at',t.ended_at,
    'prize_pool',t.prize_pool,'bounty_pool',t.bounty_pool,'bounty_pool_paid',t.bounty_pool_paid,
    'prize_pool_finalized',t.prize_pool_finalized,'mystery_stage',t.mystery_bounty_stage,
    'mystery_pool_cents',t.mystery_bounty_pool_cents)
    FROM public.tournaments t WHERE t.id=p_tournament_id),
  'escrow',(SELECT to_jsonb(e) FROM public.tournament_escrow e WHERE e.tournament_id=p_tournament_id),
  'players',(SELECT jsonb_agg(jsonb_build_object('user_id',tp.user_id,'status',tp.status,
    'position',tp.position,'prize',tp.prize,'current_bounty',tp.current_bounty,
    'bounty_winnings',tp.bounty_winnings) ORDER BY tp.user_id)
    FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id),
  'wallets',(SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'balance',chip_balance) ORDER BY user_id)
    FROM public.club_members WHERE club_id='20000000-0000-0000-0000-000000000001'
      AND user_id IN(c.loser_id,c.winner_id)),
  'completion',(SELECT to_jsonb(r) FROM public.tournament_bounty_completion_receipts r
    WHERE r.tournament_id=p_tournament_id),
  'terminal',(SELECT to_jsonb(r) FROM public.tournament_terminal_settlements r
    WHERE r.tournament_id=p_tournament_id));
 PERFORM pg_temp.bounty_terminal_assert((SELECT status::text='COMPLETED' AND ended_at IS NOT NULL
  AND prize_pool=14 AND bounty_pool=15 AND bounty_pool_paid=15 AND prize_pool_finalized
  FROM public.tournaments WHERE id=p_tournament_id),c.n||': true terminal lifecycle and exact funded pools');
 PERFORM pg_temp.bounty_terminal_assert((SELECT count(*) FROM public.tournament_finish_receipts WHERE tournament_id=p_tournament_id)=1
  AND (SELECT count(*) FROM public.tournament_players WHERE tournament_id=p_tournament_id AND position IN(1,2)
   AND status IN('winner','eliminated') AND current_bounty=0)=2,
  c.n||': one real finish claim, exact standings, no residual live bounty head');
 v:=public.fn_ca_verify_terminal_place_batch(p_tournament_id,true);
 PERFORM pg_temp.bounty_terminal_assert(v->>'ok'='true' AND (v->>'place_total')::numeric=14,
  c.n||': current canonical terminal batch verifier proves the cash payout');
 PERFORM pg_temp.bounty_terminal_assert((SELECT prize_balance=0 AND bounty_balance=0 AND fee_balance=0
  AND closed_at IS NOT NULL AND close_note='terminal receipt: exact zero'
  AND gross_in=30 AND prize_out=14 AND bounty_out=15 AND fee_out=1 FROM public.tournament_escrow WHERE tournament_id=p_tournament_id)
  AND (SELECT sum(chip_balance) FROM public.club_members WHERE club_id='20000000-0000-0000-0000-000000000001'
   AND user_id IN(c.loser_id,c.winner_id))=119
  AND (SELECT chip_balance FROM public.club_members WHERE club_id='20000000-0000-0000-0000-000000000001'
   AND user_id=c.loser_id)=90
  AND (SELECT chip_balance FROM public.club_members WHERE club_id='20000000-0000-0000-0000-000000000001'
   AND user_id=c.winner_id)=29,
  c.n||': three escrow banks close at zero with exact 14 prize, 15 bounty and 1 fee split');
 PERFORM pg_temp.bounty_terminal_assert(EXISTS(SELECT 1 FROM public.tournament_rake_settlements
  WHERE tournament_id=p_tournament_id AND amount=1 AND settled_at IS NOT NULL
   AND destination='club_treasury:20000000-0000-0000-0000-000000000001')
  AND (SELECT chip_treasury FROM public.clubs WHERE id='20000000-0000-0000-0000-000000000001')
    -(SELECT chip_treasury FROM native_bounty_house_before)
    =(SELECT sum(amount) FROM public.tournament_rake_settlements
      WHERE tournament_id IN(SELECT tournament_id FROM native_bounty_terminal_cases)),
  c.n||': exact rebuy fee reaches house treasury once and conserves with both player wallets');
 PERFORM pg_temp.bounty_terminal_assert((SELECT sum(amount) FROM public.wallet_transactions
  WHERE related_entity_id=p_tournament_id AND category='bounty')=15
  AND NOT EXISTS(SELECT 1 FROM public.tournament_obligations WHERE tournament_id=p_tournament_id
   AND (amount_paid IS DISTINCT FROM amount_owed OR settled_at IS NULL))
  AND EXISTS(SELECT 1 FROM public.tournament_bounty_completion_receipts WHERE tournament_id=p_tournament_id
   AND winner_user_id=c.winner_id AND pool_finalized_at IS NOT NULL
   AND (pool_result->>'residual')::numeric=c.expected_residual),
  c.n||': exact bounty wallet credits and immutable champion residual receipt');
 PERFORM pg_temp.bounty_terminal_assert((SELECT status='closed' AND lifecycle='closed' AND current_players=0
  AND terminal_closed_at IS NOT NULL FROM public.tables WHERE id=c.table_id)
  AND NOT EXISTS(SELECT 1 FROM public.table_seats WHERE table_id=c.table_id AND (left_at IS NULL OR status<>'left'))
  AND NOT EXISTS(SELECT 1 FROM public.tournament_seat_exit_authorizations WHERE tournament_id=p_tournament_id),
  c.n||': every seat and table closes with no remaining seat capability');
 IF c.n=3 THEN
  PERFORM pg_temp.bounty_terminal_assert((SELECT mystery_bounty_stage='complete' FROM public.tournaments WHERE id=p_tournament_id)
   AND (SELECT sum(amount_cents) FROM public.tournament_bounty_chests WHERE tournament_id=p_tournament_id AND status='paid')=750
   AND (SELECT sum(amount_cents) FROM public.tournament_bounty_chests WHERE tournament_id=p_tournament_id AND status='void')=250
   AND NOT EXISTS(SELECT 1 FROM public.tournament_bounty_chests WHERE tournament_id=p_tournament_id AND status NOT IN('paid','void'))
   AND EXISTS(SELECT 1 FROM public.tournament_bounty_completion_receipts WHERE tournament_id=p_tournament_id
    AND mystery_settled_at IS NOT NULL AND (mystery_result->>'settled_cents')::numeric=1000
    AND (mystery_result->>'variance_cents')::numeric=0),
   'mystery paid chests plus real 250-cent residual conserve the entire frozen inventory');
 END IF;
END $complete$;

DO $bounty_finish_claims$
DECLARE c record;r jsonb;before_replay jsonb;replay jsonb;
BEGIN
 PERFORM set_config('request.jwt.claim.sub','',true);
 FOR c IN SELECT * FROM native_bounty_terminal_cases ORDER BY n LOOP
  r:=public.fn_claim_tournament_finish(c.tournament_id,c.winner_id,'native-bounty-terminal-proof');
  PERFORM pg_temp.bounty_terminal_assert(r->>'ok'='true' AND r->>'status'='COMPLETING'
   AND (SELECT status='COMPLETING' FROM public.tournaments WHERE id=c.tournament_id)
   AND EXISTS(SELECT 1 FROM public.tournament_finish_receipts WHERE tournament_id=c.tournament_id
    AND winner_user_id=c.winner_id AND finish_kind='normal'
    AND claim_source='native-bounty-terminal-proof' AND claimed_at IS NOT NULL
    AND certified_at IS NULL AND completed_at IS NULL AND evidence IS NULL),
   c.n||': actual engine finish claim records the sole live winner before terminal settlement');
  before_replay:=pg_temp.bounty_terminal_state(c.tournament_id);
  replay:=public.fn_claim_tournament_finish(c.tournament_id,c.winner_id,'native-bounty-terminal-proof');
  PERFORM pg_temp.bounty_terminal_assert(replay->>'ok'='true'
   AND pg_temp.bounty_terminal_state(c.tournament_id)=before_replay,
   c.n||': replay of the immutable finish claim changes no money or lifecycle row');
 END LOOP;
END $bounty_finish_claims$;

CREATE FUNCTION pg_temp.bounty_terminal_late_fault() RETURNS trigger
LANGUAGE plpgsql AS $fault$
BEGIN
 IF EXISTS(SELECT 1 FROM native_bounty_terminal_cases WHERE tournament_id=NEW.tournament_id) THEN
  PERFORM pg_temp.assert_bounty_terminal_completed(NEW.tournament_id);
  RAISE EXCEPTION 'expected bounty terminal final receipt fault' USING ERRCODE='ZX923';
 END IF;
 RETURN NEW;
END $fault$;
CREATE TRIGGER native_bounty_terminal_late_fault AFTER INSERT ON public.tournament_terminal_settlements
FOR EACH ROW EXECUTE FUNCTION pg_temp.bounty_terminal_late_fault();
DO $terminal_rollback$
DECLARE c record;before_fault jsonb;caught boolean;
BEGIN
 FOR c IN SELECT * FROM native_bounty_terminal_cases ORDER BY n LOOP
  before_fault:=pg_temp.bounty_terminal_state(c.tournament_id);caught:=false;
  BEGIN
   PERFORM public.fn_complete_tournament_terminal(c.tournament_id,c.winner_id,'places');
  EXCEPTION WHEN SQLSTATE 'ZX923' THEN caught:=SQLERRM='expected bounty terminal final receipt fault';
  END;
  PERFORM pg_temp.bounty_terminal_assert(caught AND pg_temp.bounty_terminal_state(c.tournament_id)=before_fault,
   c.n||': final receipt fault rolls back all cash, residual, claim, lifecycle and seat effects');
 END LOOP;
END $terminal_rollback$;
DROP TRIGGER native_bounty_terminal_late_fault ON public.tournament_terminal_settlements;
DO $terminal_success$
DECLARE c record;r jsonb;replay jsonb;outcome jsonb;before_replay jsonb;
BEGIN
 FOR c IN SELECT * FROM native_bounty_terminal_cases ORDER BY n LOOP
  r:=public.fn_complete_tournament_terminal(c.tournament_id,c.winner_id,'places');
  PERFORM pg_temp.bounty_terminal_assert(r->>'ok'='true' AND r->>'status'='COMPLETED' AND r->>'fully_settled'='true',
   c.n||': real terminal authority returns one completed settlement');
  PERFORM pg_temp.assert_bounty_terminal_completed(c.tournament_id);
  before_replay:=pg_temp.bounty_terminal_state(c.tournament_id);
  replay:=public.fn_complete_tournament_terminal(c.tournament_id,c.winner_id,'places');
  outcome:=public.fn_resolve_tournament_terminal_outcome(c.tournament_id,c.winner_id,'places');
  PERFORM pg_temp.bounty_terminal_assert(replay=r AND outcome->>'terminal_committed'='true'
   AND pg_temp.bounty_terminal_state(c.tournament_id)=before_replay,
   c.n||': terminal replay and lost-response resolver preserve exact outcome without payment');
  INSERT INTO native_bounty_terminal_results VALUES(c.tournament_id,r);
 END LOOP;
END $terminal_success$;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT 'BOUNTY_TERMINAL_NATIVE_EVIDENCE='||jsonb_build_object(
 'terminal_completed',true,'native_replication_role',current_setting('session_replication_role'),
 'accepted_hand_evidence_is_synthetic',true,
 'synthetic_mystery_scheduling_deadline_aged_for_next_rpc',true,
 'checks',(SELECT count(*) FROM native_bounty_terminal_checks),
 'cases',(SELECT jsonb_agg(jsonb_build_object('tournament_id',r.tournament_id,'receipt',r.receipt,
   'state',pg_temp.bounty_terminal_state(r.tournament_id)) ORDER BY r.tournament_id)
  FROM native_bounty_terminal_results r),
 'deferred_constraints_checked',true)::text;
-- END BOUNTY TERMINAL EXERCISE
