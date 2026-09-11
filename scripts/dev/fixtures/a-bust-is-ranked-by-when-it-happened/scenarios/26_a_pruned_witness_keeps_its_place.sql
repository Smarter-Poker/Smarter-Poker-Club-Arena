-- FIXED. The hand-history prune (sp_prune_hand_history, cron 117) deletes a
-- horse-only hand's hand_atomic_commits row seven days after the hand and
-- spares only hands a PENDING generation names, so the commit a consumed
-- ('eliminated') generation points at can be gone by the time a long event
-- finishes. The settlement then fell back to eliminated_at, which for every
-- bust recorded before 20260911062048 is the moment it was RECORDED - the order
-- this change exists to stop paying. The generation row itself is never
-- pruned and was captured before that commit, so a hand whose commit is gone
-- is now timed by its first capture: one time for the whole hand, so the
-- same-hand stack rank still decides within it even though a hand's captures
-- are written seconds apart and in no particular order.
--   x: a's and b's commits are pruned before the finish.
--   y: the finish pays, every commit is pruned, and the engine's terminal path
--      enters the settlement again: it replays what it paid instead of refusing.
--   z: a (3000 chips) and b (7000) bust in ONE hand, b's generation captured
--      half a second before a's, and the hand's commit is pruned: a still busts
--      first, by stack, and b finishes above a.
\set ON_ERROR_STOP on
\set x '26000000-0000-4000-8000-000000000001'
\set y '26000000-0000-4000-8000-000000000002'
\set xb '26000000-0000-4000-8000-0000000000ab'
\set yb '26000000-0000-4000-8000-0000000000ac'
\set w '26000000-0000-4000-8000-00000000000f'
\set a '26000000-0000-4000-8000-00000000000a'
\set b '26000000-0000-4000-8000-00000000000b'
\set c '26000000-0000-4000-8000-00000000000c'
\set d '26000000-0000-4000-8000-00000000000d'
INSERT INTO public.tournaments (id, status, prize_pool, payout_structure)
VALUES (:'x', 'RUNNING', 100.00,
        '[{"place": 1, "percentage": 50}, {"place": 2, "percentage": 30}, {"place": 3, "percentage": 20}]'),
       (:'y', 'RUNNING', 100.00,
        '[{"place": 1, "percentage": 50}, {"place": 2, "percentage": 30}, {"place": 3, "percentage": 20}]');
INSERT INTO public.tables (id, tournament_id) VALUES (:'xb', :'x'), (:'yb', :'y');
DO $setup$
DECLARE e record; p record;
BEGIN
  FOR e IN SELECT * FROM (VALUES
      ('26000000-0000-4000-8000-000000000001'::uuid, '26000000-0000-4000-8000-0000000000ab'::uuid, 2600000),
      ('26000000-0000-4000-8000-000000000002'::uuid, '26000000-0000-4000-8000-0000000000ac'::uuid, 2610000)) v(t, tb, h) LOOP
    PERFORM probe.player(e.t, '26000000-0000-4000-8000-00000000000f', 25000);
    -- bust order d, c, a, b
    FOR p IN SELECT * FROM (VALUES
        ('26000000-0000-4000-8000-00000000000d'::uuid, 1, '2026-09-01 10:00:00+00'::timestamptz),
        ('26000000-0000-4000-8000-00000000000c'::uuid, 2, '2026-09-01 10:10:00+00'::timestamptz),
        ('26000000-0000-4000-8000-00000000000a'::uuid, 3, '2026-09-01 10:20:00+00'::timestamptz),
        ('26000000-0000-4000-8000-00000000000b'::uuid, 4, '2026-09-01 10:30:00+00'::timestamptz)) q(uid, n, at) LOOP
      PERFORM probe.player(e.t, p.uid);
      PERFORM probe.bust(e.t, e.tb, p.uid, e.h + p.n, 5000, p.at);
    END LOOP;
  END LOOP;
END;
$setup$;
-- recorded d, c, b, a: a's bust is recorded last, after b's
SELECT probe.check((probe.door(:'x', :'d', 5)->>'claimed')::boolean AND (probe.door(:'x', :'c', 4)->>'claimed')::boolean
                   AND (probe.door(:'x', :'b', 3, 20.00)->>'claimed')::boolean AND (probe.door(:'x', :'a', 2, 30.00)->>'claimed')::boolean,
                   'x recorded d, c, b, a');
SELECT probe.check((probe.door(:'y', :'d', 5)->>'claimed')::boolean AND (probe.door(:'y', :'c', 4)->>'claimed')::boolean
                   AND (probe.door(:'y', :'b', 3, 20.00)->>'claimed')::boolean AND (probe.door(:'y', :'a', 2, 30.00)->>'claimed')::boolean,
                   'y recorded d, c, b, a');
-- as rows recorded before 20260911062048 carry it: the moment of recording
UPDATE public.tournament_players tp
   SET eliminated_at = '2026-09-01 11:00:00+00'::timestamptz
                       + (tp.elimination_sequence - (SELECT min(elimination_sequence) FROM public.tournament_players))
                         * interval '1 minute'
 WHERE tp.status = 'eliminated';

-- x: the prune takes a's and b's hands (their history rows and their commits)
DELETE FROM public.hand_history WHERE hand_number IN (2600003, 2600004);
DELETE FROM public.hand_atomic_commits WHERE hand_number IN (2600003, 2600004);
SELECT probe.settle(:'x', :'w') AS xs \gset
SELECT probe.check((:'xs'::jsonb->>'ok')::boolean, 'x settles: ' || :'xs');
SELECT probe.check(probe.paid(:'x') = '1:f:50.00,2:b:30.00,3:a:20.00',
                   'x pays b second and a third, the order they busted in, with their hands pruned (paid '
                   || probe.paid(:'x') || ')');

-- z: one hand, two busts, captured out of stack order, commit pruned
INSERT INTO public.tournaments (id, status, prize_pool, payout_structure)
VALUES ('26000000-0000-4000-8000-000000000003', 'RUNNING', 100.00,
        '[{"place": 1, "percentage": 50}, {"place": 2, "percentage": 30}, {"place": 3, "percentage": 20}]');
INSERT INTO public.tables (id, tournament_id)
VALUES ('26000000-0000-4000-8000-0000000000ad', '26000000-0000-4000-8000-000000000003');
SELECT probe.player('26000000-0000-4000-8000-000000000003', :'w', 25000);
SELECT probe.player('26000000-0000-4000-8000-000000000003', :'a');
SELECT probe.player('26000000-0000-4000-8000-000000000003', :'b');
SELECT probe.player('26000000-0000-4000-8000-000000000003', :'c');
SELECT probe.player('26000000-0000-4000-8000-000000000003', :'d');
SELECT probe.bust('26000000-0000-4000-8000-000000000003', '26000000-0000-4000-8000-0000000000ad', :'d', 2620001, 5000, '2026-09-01 10:00:00+00');
SELECT probe.bust('26000000-0000-4000-8000-000000000003', '26000000-0000-4000-8000-0000000000ad', :'c', 2620002, 5000, '2026-09-01 10:10:00+00');
SELECT probe.bust('26000000-0000-4000-8000-000000000003', '26000000-0000-4000-8000-0000000000ad', :'a', 2620003, 3000, '2026-09-01 10:20:00+00');
SELECT probe.bust('26000000-0000-4000-8000-000000000003', '26000000-0000-4000-8000-0000000000ad', :'b', 2620003, 7000, '2026-09-01 10:20:00+00');
UPDATE public.tournament_knockout_candidates
   SET created_at = CASE eliminated_user_id WHEN :'b' THEN '2026-09-01 10:19:59.000+00'::timestamptz
                                            ELSE '2026-09-01 10:19:59.500+00'::timestamptz END
 WHERE hand_number = 2620003;
-- recorded d, c, b, a: a's bust is recorded last
SELECT probe.check((probe.door('26000000-0000-4000-8000-000000000003', :'d', 5)->>'claimed')::boolean
                   AND (probe.door('26000000-0000-4000-8000-000000000003', :'c', 4)->>'claimed')::boolean
                   AND (probe.door('26000000-0000-4000-8000-000000000003', :'b', 3, 20.00)->>'claimed')::boolean
                   AND (probe.door('26000000-0000-4000-8000-000000000003', :'a', 2, 30.00)->>'claimed')::boolean,
                   'z recorded d, c, b, a');
-- as rows recorded before 20260911062048 carry it: the moment of recording
UPDATE public.tournament_players tp
   SET eliminated_at = '2026-09-01 12:00:00+00'::timestamptz
                       + (tp.elimination_sequence - (SELECT min(elimination_sequence) FROM public.tournament_players))
                         * interval '1 minute'
 WHERE tp.tournament_id = '26000000-0000-4000-8000-000000000003' AND tp.status = 'eliminated';
DELETE FROM public.hand_history WHERE hand_number = 2620003;
DELETE FROM public.hand_atomic_commits WHERE hand_number = 2620003;
SELECT probe.settle('26000000-0000-4000-8000-000000000003', :'w') AS zs \gset
SELECT probe.check(probe.paid('26000000-0000-4000-8000-000000000003') = '1:f:50.00,2:b:30.00,3:a:20.00',
                   'z: the smaller stack busts first in its hand even with its commit pruned (paid '
                   || probe.paid('26000000-0000-4000-8000-000000000003') || ')');

-- y: paid first, then pruned, then entered again
SELECT probe.settle(:'y', :'w') AS ys \gset
SELECT probe.check(probe.paid(:'y') = '1:f:50.00,2:b:30.00,3:a:20.00', 'y pays the bust order: ' || probe.paid(:'y'));
DELETE FROM public.hand_history WHERE hand_number BETWEEN 2610001 AND 2610004;
DELETE FROM public.hand_atomic_commits WHERE hand_number BETWEEN 2610001 AND 2610004;
SELECT COALESCE(probe.settle_refusal(:'y', :'w'), 'none') AS again \gset
SELECT probe.check(:'again' = 'none', 'y replays after the prune instead of refusing: ' || :'again');
SELECT probe.check(probe.paid(:'y') = '1:f:50.00,2:b:30.00,3:a:20.00'
                   AND probe.roster(:'y') = 'f=1/50.00,b=2/30.00,a=3/20.00,c=4/0.00,d=5/0.00',
                   'and moves nothing: ' || probe.roster(:'y'));
