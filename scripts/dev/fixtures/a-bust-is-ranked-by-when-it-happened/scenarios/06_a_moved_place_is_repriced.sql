-- FIXED. The bust times are already right; the provisional ladder is not. The
-- old normalizer renumbered the places and left each prize on the player who
-- held it, so the place prepare refused recorded_prize_disagrees_with_structure
-- for ever. Now every moved row carries its new place's amount and the plan is
-- accepted: 7 players, 200.00, paying 50/30/20 of a pool that does not divide
-- evenly into cents at every place.
\set ON_ERROR_STOP on
\set t '60000000-0000-4000-8000-000000000001'
INSERT INTO public.tournaments (id, status, prize_pool, prize_pool_finalized, payout_structure)
VALUES (:'t', 'COMPLETING', 200.01, true,
        '[{"place": 1, "percentage": 50}, {"place": 2, "percentage": 30}, {"place": 3, "percentage": 20}]');
INSERT INTO public.tournament_escrow (tournament_id, enforced, prize_balance) VALUES (:'t', true, 200.01);
-- user, status, recorded position, recorded prize, bust time
INSERT INTO public.tournament_players (tournament_id, user_id, status, chips, position, prize, eliminated_at)
VALUES
  (:'t', '60000000-0000-4000-8000-000000000001', 'winner', 70000, 1, 100.01, NULL),
  -- recorded 2nd, busted third-from-last: really 4th
  (:'t', '60000000-0000-4000-8000-000000000002', 'eliminated', 0, 2, 60.00, '2026-09-10 10:03:00+00'),
  -- recorded 3rd, busted last: really 2nd
  (:'t', '60000000-0000-4000-8000-000000000003', 'eliminated', 0, 3, 40.00, '2026-09-10 10:06:00+00'),
  -- recorded 4th, busted second-from-last: really 3rd
  (:'t', '60000000-0000-4000-8000-000000000004', 'eliminated', 0, 4, 0, '2026-09-10 10:05:00+00'),
  (:'t', '60000000-0000-4000-8000-000000000005', 'eliminated', 0, 5, 0, '2026-09-10 10:02:00+00'),
  (:'t', '60000000-0000-4000-8000-000000000006', 'eliminated', 0, 6, 0, '2026-09-10 10:01:00+00'),
  (:'t', '60000000-0000-4000-8000-000000000007', 'eliminated', 0, 7, 0, '2026-09-10 10:00:00+00');

SELECT public.fn_prepare_tournament_place_obligations(:'t') AS prepared \gset
SELECT probe.check((:'prepared'::jsonb->>'ok')::boolean, 'the place plan is accepted: ' || :'prepared');
SELECT probe.check((SELECT string_agg(right(user_id::text, 1) || '=' || position || '/' || round(prize, 2), ','
                                      ORDER BY position)
                      FROM public.tournament_players WHERE tournament_id = :'t')
                   = '1=1/100.01,3=2/60.00,4=3/40.00,2=4/0.00,5=5/0.00,6=6/0.00,7=7/0.00',
                   'every moved place carries its own amount, and the rows that did not move are untouched');
SELECT probe.check((SELECT string_agg(place || ':' || right(user_id::text, 1) || ':' || round(amount_owed, 2), ','
                                      ORDER BY place)
                      FROM public.tournament_obligations WHERE tournament_id = :'t' AND kind = 'place')
                   = '1:1:100.01,2:3:60.00,3:4:40.00',
                   'the frozen plan pays the chronological places, last place taking the remainder cent');
