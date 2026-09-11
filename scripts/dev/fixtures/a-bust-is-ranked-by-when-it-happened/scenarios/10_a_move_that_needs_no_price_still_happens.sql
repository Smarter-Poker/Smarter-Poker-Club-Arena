-- KEPT. Places that move below the money carry nothing and need no price, so
-- the normalizer renumbers them exactly as before - even though a bounty has
-- already been paid in the event. Only a move that would change a prize is
-- held to the money rule.
\set ON_ERROR_STOP on
\set t 'a0000000-0000-4000-8000-000000000001'
INSERT INTO public.tournaments (id, status, prize_pool, prize_pool_finalized, payout_structure)
VALUES (:'t', 'COMPLETING', 100.00, true,
        '[{"place": 1, "percentage": 50}, {"place": 2, "percentage": 30}, {"place": 3, "percentage": 20}]');
INSERT INTO public.tournament_players (tournament_id, user_id, status, chips, position, prize, eliminated_at)
VALUES
  (:'t', 'a0000000-0000-4000-8000-000000000001', 'winner', 1500, 1, 50.00, NULL),
  (:'t', 'a0000000-0000-4000-8000-000000000002', 'eliminated', 0, 2, 30.00, '2026-09-10 10:09:00+00'),
  (:'t', 'a0000000-0000-4000-8000-000000000003', 'eliminated', 0, 3, 20.00, '2026-09-10 10:08:00+00'),
  (:'t', 'a0000000-0000-4000-8000-000000000004', 'eliminated', 0, 4, 0, '2026-09-10 10:00:00+00'),
  (:'t', 'a0000000-0000-4000-8000-000000000005', 'eliminated', 0, 5, 0, '2026-09-10 10:05:00+00');
INSERT INTO public.tournament_payouts (tournament_id, user_id, position, amount, source)
VALUES (:'t', 'a0000000-0000-4000-8000-000000000002', NULL, 1.00, 'bounty');
SELECT public.fn_normalize_tournament_final_standings(:'t') AS normalized \gset
SELECT probe.check((:'normalized'::jsonb->>'ok')::boolean,
                   'the unpaid rows are renumbered: ' || :'normalized');
SELECT probe.check((SELECT string_agg(right(user_id::text, 1) || '=' || position || '/' || round(prize, 2), ','
                                      ORDER BY position)
                      FROM public.tournament_players WHERE tournament_id = :'t')
                   = '1=1/50.00,2=2/30.00,3=3/20.00,5=4/0.00,4=5/0.00',
                   'only the two unpaid places swapped, and no prize moved');
