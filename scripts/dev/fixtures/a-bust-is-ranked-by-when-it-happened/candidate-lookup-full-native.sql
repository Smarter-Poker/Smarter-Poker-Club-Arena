-- Companion to the EXISTING bounty-rebuy-generation-atomicity.sql setup.
-- The caller composes that probe through its first replica seed section, then
-- this file. Use the real full catalog; no payment or resolver is replaced.
-- All setup, exercise and lookup-statistics assertions are rolled back.
DO $local_only$
BEGIN
 IF current_user<>'postgres' OR inet_server_addr() IS NOT NULL
    OR current_database() !~ '^r46_mtt_'
    OR current_setting('server_version_num')::integer/10000<>17
    OR current_setting('session_replication_role')<>'replica' THEN
  RAISE EXCEPTION 'candidate lookup probe requires the owned PG17 native fixture setup';
 END IF;
END $local_only$;
SET LOCAL track_functions='all';

-- Unrelated rows reproduce the estate-wide predicate scan. They are synthetic
-- structural inputs only, with no entry, hand, payment or authority claims.
INSERT INTO public.tournament_knockout_candidates(
 id,tournament_id,eliminated_user_id,table_id,seat_id,seat_joined_at,
 hand_id,hand_number,stack_before,stack_after,state)
SELECT md5('lookup-noise-candidate-'||n)::uuid,
 md5('lookup-noise-event-'||n)::uuid,md5('lookup-noise-user-'||n)::uuid,
 md5('lookup-noise-table-'||n)::uuid,md5('lookup-noise-seat-'||n)::uuid,
 clock_timestamp()-interval '1 hour',md5('lookup-noise-hand-'||n)::uuid,
 9800000+n,100,0,'pending'
FROM generate_series(1,1000) n;

-- Keep the original accepted-hand seed, aligning only its synthetic clock:
-- settlement/history and candidate precede the final atomic commit. Updating
-- the four target tuples AFTER the noise ensures the original SELECT INTO
-- must traverse unrelated rows before finding the actual candidate.
UPDATE public.hand_atomic_commits SET committed_at=clock_timestamp()-interval '10 seconds'
 WHERE hand_number BETWEEN 9720001 AND 9720004;
UPDATE public.settlement_idempotency_keys k SET completed_at=a.committed_at-interval '3 milliseconds'
 FROM public.hand_atomic_commits a
 WHERE a.hand_number BETWEEN 9720001 AND 9720004
   AND k.table_id=a.table_id AND k.hand_id=(a.stack_result->>'hand_id')::uuid;
UPDATE public.hand_history h SET created_at=a.committed_at-interval '2 milliseconds'
 FROM public.hand_atomic_commits a
 WHERE a.hand_number BETWEEN 9720001 AND 9720004 AND h.id=a.hand_id;

-- The older rebuy-only setup captured the loser alone. Current PKO causal
-- admission requires the full accepted roster, as the actual hand writer emits.
UPDATE public.hand_atomic_commits a SET stack_result=jsonb_set(a.stack_result,'{written}',
 (SELECT jsonb_object_agg(p->>'userId',p->'stack') FROM jsonb_array_elements(h.players) p))
 FROM public.hand_history h WHERE a.hand_number BETWEEN 9720001 AND 9720004 AND h.id=a.hand_id;
UPDATE public.settlement_idempotency_keys k SET result=jsonb_set(k.result,'{written}',a.stack_result->'written')
 FROM public.hand_atomic_commits a WHERE a.hand_number BETWEEN 9720001 AND 9720004
  AND k.table_id=a.table_id AND k.hand_id=(a.stack_result->>'hand_id')::uuid;

UPDATE public.tournament_knockout_candidates c
 SET created_at=a.committed_at-interval '1 millisecond',rebuy_prompt_until=NULL
 FROM public.hand_atomic_commits a
 WHERE a.hand_number BETWEEN 9720001 AND 9720004
   AND c.table_id=a.table_id AND c.hand_id=a.hand_id;
-- Use the first existing setup for ordinary elimination; no money is paid by
-- this operation. Its synthetic opening balances remain the before snapshot.
UPDATE public.tournaments SET is_bounty=false,is_pko=false,is_mystery_bounty=false
 WHERE id='b7200000-0000-4000-8000-000000000001';
ANALYZE public.tournament_knockout_candidates;
SET LOCAL session_replication_role=origin;

CREATE FUNCTION pg_temp.lookup_assert(ok boolean,label text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL lookup %',label; END IF;
 RAISE NOTICE 'PASS lookup %',label;
END $$;

DO $plan_and_count$
DECLARE plan jsonb; before_calls bigint; delta bigint; resolved uuid; found_id uuid;
 resolver oid:='public.fn_ca_latest_committed_knockout_candidate(uuid,uuid)'::regprocedure;
BEGIN
 EXECUTE $plan$EXPLAIN (FORMAT JSON) SELECT c.id FROM public.tournament_knockout_candidates c
  WHERE c.id=public.fn_ca_latest_committed_knockout_candidate(
  'b7200000-0000-4000-8000-000000000001','b7100000-0000-4000-8000-000000000001')$plan$ INTO plan;
 PERFORM pg_temp.lookup_assert(plan->0->'Plan'->>'Node Type'='Seq Scan',
  'original volatile predicate scans unrelated candidates');
 before_calls:=coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid=resolver),0);
 PERFORM c.id FROM public.tournament_knockout_candidates c
  WHERE c.id=public.fn_ca_latest_committed_knockout_candidate(
  'b7200000-0000-4000-8000-000000000001','b7100000-0000-4000-8000-000000000001');
 delta:=coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid=resolver),0)-before_calls;
 PERFORM pg_temp.lookup_assert(delta>=1000,'original predicate repeats real resolver across estate');
 RAISE NOTICE 'LOOKUP_BASELINE_RESOLVER_CALLS=%',delta;
 before_calls:=coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid=resolver),0);
 resolved:=public.fn_ca_latest_committed_knockout_candidate(
  'b7200000-0000-4000-8000-000000000001','b7100000-0000-4000-8000-000000000001');
 SELECT c.id INTO found_id FROM public.tournament_knockout_candidates c WHERE c.id=resolved;
 delta:=coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid=resolver),0)-before_calls;
 PERFORM pg_temp.lookup_assert(delta=1 AND found_id=resolved,'bound UUID resolves exactly once');
 EXECUTE format('EXPLAIN (FORMAT JSON) SELECT c.* FROM public.tournament_knockout_candidates c WHERE c.id=%L::uuid',resolved) INTO plan;
 PERFORM pg_temp.lookup_assert(plan->0->'Plan'->>'Node Type'='Index Scan'
  AND plan->0->'Plan'->>'Index Name'='tournament_knockout_candidates_pkey',
  'bound candidate lookup uses real primary key');
 PERFORM pg_temp.lookup_assert((SELECT provolatile='v' FROM pg_proc WHERE oid=resolver),
  'resolver keeps volatile transactional semantics');
END $plan_and_count$;

DO $ordinary_and_replay$
DECLARE r jsonb; before_calls bigint; delta bigint;
 resolver oid:='public.fn_ca_latest_committed_knockout_candidate(uuid,uuid)'::regprocedure;
BEGIN
 before_calls:=coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid=resolver),0);
 r:=public.fn_eliminate_tournament_player_atomic(
  'b7200000-0000-4000-8000-000000000001','b7100000-0000-4000-8000-000000000001',2,0,0);
 delta:=coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid=resolver),0)-before_calls;
 PERFORM pg_temp.lookup_assert(r->>'ok'='true' AND r->>'claimed'='true',
  'real ordinary door records the accepted zero-stack generation');
 RAISE NOTICE 'LOOKUP_ORDINARY_RESOLVER_CALLS=%',delta;
 PERFORM pg_temp.lookup_assert(delta=2,'ordinary outer and private core each resolve once');
 PERFORM pg_temp.lookup_assert((SELECT state='eliminated' FROM public.tournament_knockout_candidates
  WHERE id='b7800000-0000-4000-8000-000000000001'), 'ordinary candidate closes with result');
 before_calls:=coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid=resolver),0);
 r:=public.fn_eliminate_tournament_player_atomic(
  'b7200000-0000-4000-8000-000000000001','b7100000-0000-4000-8000-000000000001',2,0,0);
 delta:=coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid=resolver),0)-before_calls;
 PERFORM pg_temp.lookup_assert(r->>'already'='true' AND delta=1,
  'ordinary exact replay retains original result without private-core re-resolution');
 r:=public.fn_eliminate_tournament_player_atomic(
  'b7200000-0000-4000-8000-000000000001','b7100000-0000-4000-8000-000000000001',3,0,0);
 PERFORM pg_temp.lookup_assert(r->>'ok'='false' AND r->>'reason'='elimination_identity_conflict',
  'conflicting place still refuses');
END $ordinary_and_replay$;

-- Missing accepted roster evidence still fails closed through the repaired
-- outer door. Restore only this synthetic corruption before the positive case.
SAVEPOINT missing_pko_history;
SET LOCAL session_replication_role=replica;
DELETE FROM public.hand_history WHERE id='b7600000-0000-4000-8000-000000000002';
SET LOCAL session_replication_role=origin;
DO $missing_pko_history$
DECLARE r jsonb; joined timestamptz;
BEGIN
 SELECT seat_joined_at INTO STRICT joined FROM public.tournament_knockout_candidates
  WHERE id='b7800000-0000-4000-8000-000000000002';
 r:=public.fn_claim_tournament_bounty_elimination(
  'b7200000-0000-4000-8000-000000000002','b7100000-0000-4000-8000-000000000003',2,0,
  'b7300000-0000-4000-8000-000000000002','b7600000-0000-4000-8000-000000000002',9720002,joined,
  'b7100000-0000-4000-8000-000000000004',
  '[{"user_id":"b7100000-0000-4000-8000-000000000004","weight":1}]',0,false);
 PERFORM pg_temp.lookup_assert(r->>'ok'='false' AND r->>'reason'='exact_knockout_history_not_found',
  'current PKO authority still refuses missing accepted history');
 PERFORM pg_temp.lookup_assert(NOT EXISTS(SELECT 1 FROM public.tournament_bounty_obligations
  WHERE tournament_id='b7200000-0000-4000-8000-000000000002') AND EXISTS(
  SELECT 1 FROM public.tournament_players WHERE tournament_id='b7200000-0000-4000-8000-000000000002'
   AND user_id='b7100000-0000-4000-8000-000000000003' AND status='playing' AND current_bounty=5),
  'unknown PKO evidence creates no place or payable obligation');
END $missing_pko_history$;
ROLLBACK TO SAVEPOINT missing_pko_history;
RELEASE SAVEPOINT missing_pko_history;

DO $bounty_and_replay$
DECLARE r jsonb; before_calls bigint; delta bigint; joined timestamptz; obligation uuid;
 resolver oid:='public.fn_ca_latest_committed_knockout_candidate(uuid,uuid)'::regprocedure;
BEGIN
 SELECT seat_joined_at INTO STRICT joined FROM public.tournament_knockout_candidates
  WHERE id='b7800000-0000-4000-8000-000000000002';
 before_calls:=coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid=resolver),0);
 r:=public.fn_claim_tournament_bounty_elimination(
  'b7200000-0000-4000-8000-000000000002','b7100000-0000-4000-8000-000000000003',2,0,
  'b7300000-0000-4000-8000-000000000002','b7600000-0000-4000-8000-000000000002',9720002,joined,
  'b7100000-0000-4000-8000-000000000004',
  '[{"user_id":"b7100000-0000-4000-8000-000000000004","weight":1}]',0,false);
 delta:=coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid=resolver),0)-before_calls;
 RAISE NOTICE 'LOOKUP_PKO_CLAIM_RESULT=%',r;
 PERFORM pg_temp.lookup_assert(r->>'ok'='true' AND r->>'claimed'='true',
  'real PKO door admits exact accepted head under current causal guards');
 PERFORM pg_temp.lookup_assert(delta=1,'PKO outer resolves exactly once');
 RAISE NOTICE 'LOOKUP_PKO_RESOLVER_CALLS=%',delta;
 obligation:=(r->>'obligation_id')::uuid;
 PERFORM pg_temp.lookup_assert(obligation IS NOT NULL AND EXISTS(
  SELECT 1 FROM public.tournament_bounty_obligations o WHERE o.id=obligation
   AND o.state='pending' AND o.mode='pko' AND o.head_amount=5),
  'unpaid PKO obligation retains exact five-chip head');
 before_calls:=coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid=resolver),0);
 r:=public.fn_claim_tournament_bounty_elimination(
  'b7200000-0000-4000-8000-000000000002','b7100000-0000-4000-8000-000000000003',2,0,
  'b7300000-0000-4000-8000-000000000002','b7600000-0000-4000-8000-000000000002',9720002,joined,
  'b7100000-0000-4000-8000-000000000004',
  '[{"user_id":"b7100000-0000-4000-8000-000000000004","weight":1}]',0,false);
 delta:=coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid=resolver),0)-before_calls;
 PERFORM pg_temp.lookup_assert(r->>'already'='true' AND delta=0,
  'existing exact bounty obligation replays before candidate resolution');
END $bounty_and_replay$;

SELECT 'MTT_ELIMINATION_CANDIDATE_LOOKUP_NATIVE_PASS';
ROLLBACK;
