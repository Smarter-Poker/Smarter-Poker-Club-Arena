-- FIXED. The engine's own finish. Five players, 100.00, paying 50/30/20. They
-- bust d, c, a, b; the door records d, c and b, and a only after a refusal lets
-- go. fn_settle_tournament_places - the cash authority fn_complete_tournament_terminal
-- calls - numbered places by elimination_sequence, the RECORDING order, and so
-- paid a 30.00 for a second place a never finished in and b 20.00 for third.
-- It now ranks every bust by the commit of the hand that took the stack.
\set ON_ERROR_STOP on
\set t 'c0000000-0000-4000-8000-000000000001'
\set tb 'c0000000-0000-4000-8000-0000000000ab'
\set w 'c0000000-0000-4000-8000-00000000000f'
\set a 'c0000000-0000-4000-8000-00000000000a'
\set b 'c0000000-0000-4000-8000-00000000000b'
\set c 'c0000000-0000-4000-8000-00000000000c'
\set d 'c0000000-0000-4000-8000-00000000000d'
INSERT INTO public.tournaments (id, status, prize_pool, payout_structure)
VALUES (:'t', 'RUNNING', 100.00,
        '[{"place": 1, "percentage": 50}, {"place": 2, "percentage": 30}, {"place": 3, "percentage": 20}]');
INSERT INTO public.tables (id, tournament_id) VALUES (:'tb', :'t');
SELECT probe.player(:'t', :'w', 25000);
SELECT probe.player(:'t', :'a');
SELECT probe.player(:'t', :'b');
SELECT probe.player(:'t', :'c');
SELECT probe.player(:'t', :'d');
SELECT probe.bust(:'t', :'tb', :'d', 1600001, 5000, '2026-09-10 10:00:00+00');
SELECT probe.bust(:'t', :'tb', :'c', 1600002, 5000, '2026-09-10 10:10:00+00');
SELECT probe.bust(:'t', :'tb', :'a', 1600003, 5000, '2026-09-10 10:20:00+00');
SELECT probe.bust(:'t', :'tb', :'b', 1600004, 5000, '2026-09-10 10:30:00+00');
SELECT probe.check((probe.door(:'t', :'d', 5)->>'claimed')::boolean, 'd recorded');
SELECT probe.check((probe.door(:'t', :'c', 4)->>'claimed')::boolean, 'c recorded');
SELECT probe.check((probe.door(:'t', :'b', 3, 20.00)->>'claimed')::boolean, 'b recorded before a');
SELECT probe.check((probe.door(:'t', :'a', 2, 30.00)->>'claimed')::boolean, 'a recorded last');
-- A bust recorded before 20260911062048 carries the time the door recorded it,
-- not the time it happened. Stamp these that way: the settlement must read the
-- bust from the hand, not from this column, so no backfill is needed.
UPDATE public.tournament_players tp
   SET eliminated_at = '2026-09-10 11:00:00+00'::timestamptz
                       + (tp.elimination_sequence - (SELECT min(elimination_sequence)
                                                       FROM public.tournament_players
                                                      WHERE tournament_id = :'t'))
                         * interval '1 minute'
 WHERE tp.tournament_id = :'t' AND tp.status = 'eliminated';

SELECT probe.settle(:'t', :'w') AS settled \gset
SELECT probe.check((:'settled'::jsonb->>'ok')::boolean
                   AND :'settled'::jsonb->>'status' = 'COMPLETING', 'the finish settles: ' || :'settled');
SELECT probe.check(probe.paid(:'t') = '1:f:50.00,2:b:30.00,3:a:20.00',
                   'b is paid second and a third, the order they busted in (paid ' || probe.paid(:'t') || ')');
SELECT probe.check(probe.roster(:'t') = 'f=1/50.00,b=2/30.00,a=3/20.00,c=4/0.00,d=5/0.00',
                   'the roster carries the places they finished in: ' || probe.roster(:'t'));
