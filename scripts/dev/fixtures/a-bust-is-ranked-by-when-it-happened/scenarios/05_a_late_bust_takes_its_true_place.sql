-- FIXED. End to end: five players, 100.00, paying 50/30/20. They bust in the
-- order d, c, a, b, but the door refuses a for a while and records b first, so
-- the ladder hands b place 3 (20.00) and a place 2 (30.00). The standings
-- normalizer and the place prepare rank by eliminated_at; with the bust time
-- stamped and the moved places re-priced, b is paid for second and a for third.
-- The old door stamped recording time, so a kept the second place it never won.
\set ON_ERROR_STOP on
\set t '50000000-0000-4000-8000-000000000001'
\set tb '50000000-0000-4000-8000-0000000000ab'
\set w '50000000-0000-4000-8000-00000000000f'
\set a '50000000-0000-4000-8000-00000000000a'
\set b '50000000-0000-4000-8000-00000000000b'
\set c '50000000-0000-4000-8000-00000000000c'
\set d '50000000-0000-4000-8000-00000000000d'
INSERT INTO public.tournaments (id, status, prize_pool, payout_structure)
VALUES (:'t', 'RUNNING', 100.00,
        '[{"place": 1, "percentage": 50}, {"place": 2, "percentage": 30}, {"place": 3, "percentage": 20}]');
INSERT INTO public.tables (id, tournament_id) VALUES (:'tb', :'t');
SELECT probe.player(:'t', :'w', 25000);
SELECT probe.player(:'t', :'a');
SELECT probe.player(:'t', :'b');
SELECT probe.player(:'t', :'c');
SELECT probe.player(:'t', :'d');
SELECT probe.bust(:'t', :'tb', :'d', 1500001, 5000, '2026-09-10 10:00:00+00');
SELECT probe.bust(:'t', :'tb', :'c', 1500002, 5000, '2026-09-10 10:10:00+00');
SELECT probe.bust(:'t', :'tb', :'a', 1500003, 5000, '2026-09-10 10:20:00+00');
SELECT probe.bust(:'t', :'tb', :'b', 1500004, 5000, '2026-09-10 10:30:00+00');

-- The engine records d, c, then b, and a only after the door stops refusing it.
SELECT probe.check((probe.door(:'t', :'d', 5)->>'claimed')::boolean, 'd recorded');
SELECT probe.check((probe.door(:'t', :'c', 4)->>'claimed')::boolean, 'c recorded');
SELECT probe.check((probe.door(:'t', :'b', 3, 20.00)->>'claimed')::boolean, 'b recorded before a');
SELECT probe.check((probe.door(:'t', :'a', 2, 30.00)->>'claimed')::boolean, 'a recorded last');

-- The finish: the survivor is the champion, the pool is final and banked.
UPDATE public.tournament_players SET status = 'winner', position = 1, prize = 50.00
 WHERE tournament_id = :'t' AND user_id = :'w';
UPDATE public.tournaments SET status = 'COMPLETING', prize_pool_finalized = true WHERE id = :'t';
INSERT INTO public.tournament_escrow (tournament_id, enforced, prize_balance) VALUES (:'t', true, 100.00);

SELECT public.fn_prepare_tournament_place_obligations(:'t') AS prepared \gset
SELECT probe.check((:'prepared'::jsonb->>'ok')::boolean, 'the place plan is accepted: ' || :'prepared');
SELECT probe.check((SELECT user_id FROM public.tournament_obligations
                     WHERE tournament_id = :'t' AND kind = 'place' AND place = 2) = :'b',
                   'second place is paid to b, who busted last');
SELECT probe.check((SELECT user_id FROM public.tournament_obligations
                     WHERE tournament_id = :'t' AND kind = 'place' AND place = 3) = :'a',
                   'third place is paid to a, whose bust was recorded late');
SELECT probe.check((SELECT string_agg(place || ':' || round(amount_owed, 2), ',' ORDER BY place)
                      FROM public.tournament_obligations
                     WHERE tournament_id = :'t' AND kind = 'place') = '1:50.00,2:30.00,3:20.00',
                   'the plan is the structure exactly');
SELECT probe.check((SELECT string_agg(user_id::text || '=' || position || '/' || round(prize, 2), ',' ORDER BY position)
                      FROM public.tournament_players WHERE tournament_id = :'t')
                   = format('%s=1/50.00,%s=2/30.00,%s=3/20.00,%s=4/0.00,%s=5/0.00', :'w', :'b', :'a', :'c', :'d'),
                   'the roster carries the re-priced places');
