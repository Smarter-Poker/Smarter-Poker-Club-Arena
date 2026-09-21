-- FIXED. (ii) THE PIN, ISOLATED. In one transaction, four hands that satisfy
-- the five financial conditions identically, differing ONLY in identity:
--
--   World A  Noon, the pinned triple, via f06_retired_origin_snapshot   -> ACCEPTED
--   World C  Noon, the pinned triple, via f06_retained_mtt_abort_snapshot -> ACCEPTED
--   World D  Afternoon, same cohort, via f06_retired_origin_snapshot    -> REFUSED
--   World B  another tournament, via f06_retained_mtt_abort_snapshot    -> REFUSED
--
-- Identity is the only variable. Both edited functions accept the pinned hand
-- and refuse the others, so neither function can have been repaired more
-- widely than the other. This must fail on the live bodies, where A and C are
-- refused for want of cards.
\set ON_ERROR_STOP on
BEGIN;
SELECT probe.expect_inert('A', true,  'the pinned triple');
SELECT probe.expect_inert('C', true,  'the pinned triple, through the other function');
SELECT probe.expect_inert('D', false, 'same cohort, same five conditions, different hand');
SELECT probe.expect_inert('B', false, 'same five conditions, different hand');
-- C FIRST, deliberately. probe.expect raises on the first world that
-- disagrees, so a scenario that always asks A first never records what C does
-- on the LIVE bodies. Scenario 010 asks A first; this one asks C first, so the
-- red state of the zero-card pinned case is observed on BOTH functions rather
-- than inferred for one of them. Order is safe either way: probe.run('C')
-- removes the Noon lease when it succeeds, and the exception block's implicit
-- savepoint removes it when it fails, so A always runs without a competing lease.
SELECT probe.expect('C', 'ACCEPTED', 'the pinned triple, via f06_retained_mtt_abort_snapshot');
SELECT probe.expect('A', 'ACCEPTED', 'the pinned triple, via f06_retired_origin_snapshot');
SELECT probe.expect_nonpinned_both('REFUSED', 'not the pinned triple, on both edited functions');
-- The canonical of the accepted pair must be an empty ARRAY on both functions,
-- not JSON null: both callers compare it with IS DISTINCT FROM.
DO $$
DECLARE which text; c jsonb;
BEGIN
 FOREACH which IN ARRAY ARRAY['A','C'] LOOP
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
