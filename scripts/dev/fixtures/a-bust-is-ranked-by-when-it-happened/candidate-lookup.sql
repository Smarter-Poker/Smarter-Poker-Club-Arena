-- Resolve-once regression under the existing reduced ranking fixture.
-- No payer or claimant double is invoked: the PKO case refuses while the
-- rebuy decision is open. Full current-catalog positive proof is separate.
BEGIN;
SET LOCAL track_functions='all';
INSERT INTO public.tournaments(id,status,is_pko)
VALUES('d4700000-0000-4000-8000-000000000001','RUNNING',false),
      ('d4700000-0000-4000-8000-000000000002','RUNNING',true);
INSERT INTO public.tables(id,tournament_id)
VALUES('d4710000-0000-4000-8000-000000000001','d4700000-0000-4000-8000-000000000001'),
      ('d4710000-0000-4000-8000-000000000002','d4700000-0000-4000-8000-000000000002');
SELECT probe.player('d4700000-0000-4000-8000-000000000001','d4720000-0000-4000-8000-000000000001');
SELECT probe.player('d4700000-0000-4000-8000-000000000002','d4720000-0000-4000-8000-000000000002');
-- Unrelated structural candidates precede the true hand physically, so the
-- original SELECT INTO cannot succeed on the first tuple accidentally.
INSERT INTO public.tournament_knockout_candidates(
 id,tournament_id,eliminated_user_id,table_id,seat_id,seat_joined_at,
 hand_id,hand_number,stack_before,stack_after,state)
SELECT md5('lookup-ci-noise-candidate-'||n)::uuid,
 md5('lookup-ci-noise-event-'||n)::uuid,md5('lookup-ci-noise-user-'||n)::uuid,
 md5('lookup-ci-noise-table-'||n)::uuid,md5('lookup-ci-noise-seat-'||n)::uuid,
 now()-interval '1 hour',md5('lookup-ci-noise-hand-'||n)::uuid,
 9800000+n,100,0,'pending' FROM generate_series(1,1000) n;
SELECT probe.bust('d4700000-0000-4000-8000-000000000001',
 'd4710000-0000-4000-8000-000000000001','d4720000-0000-4000-8000-000000000001',
 9740001,100,now()-interval '5 minutes');
SELECT probe.bust('d4700000-0000-4000-8000-000000000002',
 'd4710000-0000-4000-8000-000000000002','d4720000-0000-4000-8000-000000000002',
 9740002,100,now()-interval '5 minutes');
UPDATE public.tournament_knockout_candidates SET rebuy_prompt_until=now()+interval '1 hour'
 WHERE tournament_id='d4700000-0000-4000-8000-000000000002';
ANALYZE public.tournament_knockout_candidates;
DO $ordinary$
DECLARE before_calls bigint; delta bigint; r jsonb; plan jsonb; candidate uuid;
 resolver oid:='public.fn_ca_latest_committed_knockout_candidate(uuid,uuid)'::regprocedure;
BEGIN
 before_calls:=coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid=resolver),0);
 r:=probe.door('d4700000-0000-4000-8000-000000000001','d4720000-0000-4000-8000-000000000001',2,0);
 delta:=coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid=resolver),0)-before_calls;
 PERFORM probe.check(r->>'ok'='true' AND r->>'claimed'='true','lookup ordinary accepts exact hand');
 RAISE NOTICE 'LOOKUP_ORDINARY_RESOLVER_CALLS=%',delta;
 PERFORM probe.check(delta=2,'candidate lookup ordinary outer and core resolve once each');
 SELECT id INTO STRICT candidate FROM public.tournament_knockout_candidates
  WHERE tournament_id='d4700000-0000-4000-8000-000000000001';
 EXECUTE format('EXPLAIN (FORMAT JSON) SELECT c.* FROM public.tournament_knockout_candidates c WHERE c.id=%L::uuid',candidate) INTO plan;
 PERFORM probe.check(plan->0->'Plan'->>'Node Type'='Index Scan'
  AND plan->0->'Plan'->>'Index Name'='tournament_knockout_candidates_pkey','lookup bound UUID uses primary key');
 PERFORM probe.check((SELECT provolatile='v' FROM pg_proc WHERE oid=resolver),'lookup resolver stays volatile');
 before_calls:=coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid=resolver),0);
 r:=probe.door('d4700000-0000-4000-8000-000000000001','d4720000-0000-4000-8000-000000000001',2,0);
 delta:=coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid=resolver),0)-before_calls;
 PERFORM probe.check(r->>'already'='true' AND delta=1,'lookup exact ordinary replay resolves once');
 r:=probe.door('d4700000-0000-4000-8000-000000000001','d4720000-0000-4000-8000-000000000001',3,0);
 PERFORM probe.check(r->>'reason'='elimination_identity_conflict','lookup still refuses a conflicting place');
END $ordinary$;
DO $pko$
DECLARE before_calls bigint; delta bigint; r jsonb;
 resolver oid:='public.fn_ca_latest_committed_knockout_candidate(uuid,uuid)'::regprocedure;
BEGIN
 before_calls:=coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid=resolver),0);
 r:=probe.claim('d4700000-0000-4000-8000-000000000002','d4720000-0000-4000-8000-000000000002',2,0);
 delta:=coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid=resolver),0)-before_calls;
 RAISE NOTICE 'LOOKUP_PKO_RESOLVER_CALLS=%',delta;
 PERFORM probe.check(r->>'ok'='false' AND r->>'reason'='rebuy_decision_open' AND delta=1,
  'candidate lookup PKO decision refusal resolves once');
 PERFORM probe.check(NOT EXISTS(SELECT 1 FROM public.tournament_bounty_obligations
   WHERE tournament_id='d4700000-0000-4000-8000-000000000002') AND EXISTS(
   SELECT 1 FROM public.tournament_players WHERE tournament_id='d4700000-0000-4000-8000-000000000002'
    AND status='playing'),'lookup PKO refusal leaves status and obligations unchanged');
END $pko$;
SELECT 'CANDIDATE_LOOKUP_CI_PASS';
ROLLBACK;
