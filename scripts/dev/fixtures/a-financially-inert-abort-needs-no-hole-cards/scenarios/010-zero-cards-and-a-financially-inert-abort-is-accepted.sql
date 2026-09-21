-- FIXED. (a) Exactly zero hole cards and all five conditions hold, so the
-- abort moves no chips and the destroyed cards cannot decide anything. This is
-- the one case the repair admits, and it must fail on the live bodies.
\set ON_ERROR_STOP on
BEGIN;
SELECT probe.expect_inert_both(true, 'zero cards, hand never committed, nothing later, un-acted preflop, every durable balance already equals stack+totalInvested');
SELECT probe.expect_both('ACCEPTED', 'zero cards, provably financially inert');
-- The canonical must stay comparable: jsonb_agg over zero rows is SQL NULL,
-- and both callers compare the canonical with IS DISTINCT FROM.
DO $$
DECLARE which text; c jsonb;
BEGIN
 FOREACH which IN ARRAY ARRAY['A','B'] LOOP
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  PERFORM set_config('app.smarter_data_actor','service',true);
  c := probe.cards(which);
  IF c IS DISTINCT FROM '[]'::jsonb OR jsonb_typeof(c) IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'PROBE FAILED: world % canonical cards is % (%), not an empty array',
    which, coalesce(c::text,'SQL NULL'), coalesce(jsonb_typeof(c),'none');
  END IF;
  RAISE NOTICE 'CANONICAL % cards=% type=%', which, c, jsonb_typeof(c);
 END LOOP;
END $$;
COMMIT;
