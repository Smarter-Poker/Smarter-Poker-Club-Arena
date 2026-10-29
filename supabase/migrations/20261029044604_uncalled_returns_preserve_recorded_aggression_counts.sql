-- Version reserved by scripts/new-migration.mjs.
-- A legitimate uncalled-bet return is public settlement bookkeeping. It must
-- neither count as aggression nor invalidate otherwise complete action evidence.
-- Repair the original insert-time helper; preserve historical NULL coverage,
-- permissions, money, player records and the existing capture trigger.
-- @live-proof: public.ca_fact_aggression_counts('[{"userId":"20000000-0000-0000-0000-000000000001","action":"raise","amount":6,"stage":"preflop"},{"userId":"20000000-0000-0000-0000-000000000001","action":"return","amount":4,"stage":"preflop"}]'::jsonb,'20000000-0000-0000-0000-000000000001'::uuid,2)=jsonb_build_object('bets_raises',1,'calls',0)
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $patch$
DECLARE d text; old_anchor text:=$anchor$'dead_blind','bring_in')$anchor$;
BEGIN
 d:=pg_get_functiondef('public.ca_fact_aggression_counts(jsonb,uuid,numeric)'::regprocedure);
 IF (length(d)-length(replace(d,old_anchor,'')))/length(old_anchor)<>1
 THEN RAISE EXCEPTION 'Aggression action validation source anchor changed'; END IF;
 d:=replace(d,old_anchor,$anchor$'dead_blind','bring_in','return')$anchor$);
 EXECUTE d;
 IF public.ca_fact_aggression_counts('[{"userId":"20000000-0000-0000-0000-000000000001","action":"raise","amount":6,"stage":"preflop"},{"userId":"20000000-0000-0000-0000-000000000001","action":"return","amount":4,"stage":"preflop"}]'::jsonb,'20000000-0000-0000-0000-000000000001',2)
  IS DISTINCT FROM jsonb_build_object('bets_raises',1,'calls',0)
 THEN RAISE EXCEPTION 'Uncalled return still invalidates aggression evidence'; END IF;
END $patch$;
COMMIT;
