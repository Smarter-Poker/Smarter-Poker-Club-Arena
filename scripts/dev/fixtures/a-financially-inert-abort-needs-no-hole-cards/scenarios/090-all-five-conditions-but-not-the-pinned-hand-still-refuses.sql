-- KEPT. (i) THE CASE THE PREVIOUS ATTEMPT GOT WRONG. Two hands that are NOT
-- the pinned triple, each satisfying ALL FIVE financial conditions exactly as
-- completely as the pinned hand does: zero surviving hole cards, no commit for
-- the hand, no later commit at the table, a single un-acted preflop snapshot,
-- and every durable balance already equal to stack + totalInvested.
--
--   World D is Afternoon - the OTHER tournament in the same frozen
--   smarter_private.f06_retired_origin_cohort - reached through
--   smarter_private.f06_retired_origin_snapshot. It is precisely the hand a
--   cohort-DERIVED identity pin would also have admitted, which is why the
--   pin is three hardcoded literals instead.
--   World B is an ordinary tournament reached through
--   smarter_private.f06_retained_mtt_abort_snapshot.
--
-- 20260921023053 would have ACCEPTED both, and 466 more like them. Under the
-- identity pin both must refuse, before the migration and after it, on BOTH
-- edited functions. Nothing is mutated here: the point is that these hands
-- need no drift to be refused - being a different hand is enough.
\set ON_ERROR_STOP on
BEGIN;
-- The predicate itself, asked directly for both non-pinned hands.
SELECT probe.expect_inert('D', false, 'all five conditions hold, but Afternoon is not the pinned triple');
SELECT probe.expect_inert('B', false, 'all five conditions hold, but this is not the pinned triple');
-- And the functions themselves, end to end.
SELECT probe.expect_nonpinned_both('REFUSED', 'all five conditions hold but the hand is not the pinned triple');
-- Proof that the five conditions really do all hold for these two hands, so
-- the refusal above is attributable to the identity pin and to nothing else.
DO $$
DECLARE r record; n int := 0;
BEGIN
 FOR r IN SELECT * FROM (VALUES
     ('D','615783bf-15e3-40b7-9368-75f21b6ac53b'::uuid,'9f30d335-8262-4872-8926-3ddf1fefe75c'::uuid,12943630::bigint),
     ('B','bbbb0000-0000-4000-8000-00000000000b'::uuid,'bbbb1111-0000-4000-8000-00000000000b'::uuid,900001::bigint)
   ) AS w(world,t,tb,hn)
 LOOP
  IF NOT (
    NOT EXISTS (SELECT 1 FROM public.table_hole_cards c WHERE c.table_id=r.tb AND c.hand_number=r.hn)
    AND NOT EXISTS (SELECT 1 FROM public.hand_atomic_commits a WHERE a.table_id=r.tb AND a.hand_number>=r.hn)
    AND EXISTS (SELECT 1 FROM public.hand_state_snapshots s
                 WHERE s.table_id=r.tb AND s.hand_number=r.hn AND s.is_complete IS FALSE
                   AND s.stage='preflop' AND s.state_json->>'stage'='preflop'
                   AND s.state_json->'actionHistory'='[]'::jsonb
                   AND jsonb_array_length(s.state_json->'players')>0)
    AND NOT EXISTS (
          SELECT 1 FROM public.hand_state_snapshots s
            CROSS JOIN LATERAL jsonb_array_elements(s.state_json->'players') x
           WHERE s.table_id=r.tb AND s.hand_number=r.hn
             AND NOT (EXISTS (SELECT 1 FROM public.tournament_players p
                               WHERE p.tournament_id=r.t AND p.user_id=(x->>'user_id')::uuid
                                 AND p.chips::numeric=(x->>'stack')::numeric+(x->>'totalInvested')::numeric)
                  AND EXISTS (SELECT 1 FROM public.table_seats q
                               WHERE q.table_id=r.tb AND q.user_id=(x->>'user_id')::uuid AND q.left_at IS NULL
                                 AND q.stack::numeric=(x->>'stack')::numeric+(x->>'totalInvested')::numeric)))
    AND (SELECT count(*) FROM public.hand_state_snapshots s WHERE s.table_id=r.tb AND s.hand_number=r.hn)=1
  ) THEN
   RAISE EXCEPTION 'PROBE FAILED: world % does not actually satisfy all five conditions, so this scenario proves nothing', r.world;
  END IF;
  n := n + 1;
  RAISE NOTICE 'GATE   % false | all five conditions HOLD for table % hand %, and it is refused anyway', r.world, r.tb, r.hn;
 END LOOP;
 IF n <> 2 THEN RAISE EXCEPTION 'PROBE FAILED: expected 2 non-pinned worlds, checked %', n; END IF;
END $$;
COMMIT;
