-- FIXED. Three players bust in one hand at a four-handed final table paying
-- 50/30/20 of 100.00. The smaller hand-start stack busts first and finishes
-- lower (TDA): c and e started it with 200, big with 500, so big is second, e
-- (the higher user id of the two 200s) third and c fourth. The door recorded
-- them largest stack first, and the settlement numbered places by recording
-- order - so it paid c 30.00 and e 20.00 and big nothing.
\set ON_ERROR_STOP on
\set t 'd0000000-0000-4000-8000-000000000001'
\set tb 'd0000000-0000-4000-8000-0000000000ab'
\set w 'd0000000-0000-4000-8000-00000000000f'
\set big 'd0000000-0000-4000-8000-00000000000b'
\set c 'd0000000-0000-4000-8000-00000000000c'
\set e 'd0000000-0000-4000-8000-00000000000e'
INSERT INTO public.tournaments (id, status, prize_pool, payout_structure)
VALUES (:'t', 'RUNNING', 100.00,
        '[{"place": 1, "percentage": 50}, {"place": 2, "percentage": 30}, {"place": 3, "percentage": 20}]');
INSERT INTO public.tables (id, tournament_id) VALUES (:'tb', :'t');
SELECT probe.player(:'t', :'w', 9000);
SELECT probe.player(:'t', :'big');
SELECT probe.player(:'t', :'c');
SELECT probe.player(:'t', :'e');
SELECT probe.bust(:'t', :'tb', :'big', 1700200, 500, '2026-09-10 12:00:00+00');
SELECT probe.bust(:'t', :'tb', :'c', 1700200, 200, '2026-09-10 12:00:00+00');
SELECT probe.bust(:'t', :'tb', :'e', 1700200, 200, '2026-09-10 12:00:00+00');
SELECT probe.check((probe.door(:'t', :'big', 4)->>'claimed')::boolean, 'the largest stack is recorded first');
SELECT probe.check((probe.door(:'t', :'e', 3, 20.00)->>'claimed')::boolean, 'then e');
SELECT probe.check((probe.door(:'t', :'c', 2, 30.00)->>'claimed')::boolean, 'then c');

SELECT probe.settle(:'t', :'w') AS settled \gset
SELECT probe.check((:'settled'::jsonb->>'ok')::boolean, 'the finish settles: ' || :'settled');
SELECT probe.check(probe.paid(:'t') = '1:f:50.00,2:b:30.00,3:e:20.00',
                   'big busted last in the hand and is paid second, e third, c nothing (paid ' || probe.paid(:'t') || ')');
SELECT probe.check(probe.roster(:'t') = 'f=1/50.00,b=2/30.00,e=3/20.00,c=4/0.00',
                   'the roster: ' || probe.roster(:'t'));
