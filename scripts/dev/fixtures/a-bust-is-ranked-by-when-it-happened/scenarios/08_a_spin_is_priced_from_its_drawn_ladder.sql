-- FIXED. A Spin pays its drawn multiplier's ladder, not its creation-time
-- structure: here 10x pays 80/20 while payout_structure still says 50/30/20.
-- The moved places are priced from spin_payout_ladder, as the place prepare
-- prices them, and the plan is accepted.
\set ON_ERROR_STOP on
\set t '80000000-0000-4000-8000-000000000001'
INSERT INTO public.tournaments (id, status, variant, tournament_type, spin_multiplier,
                                prize_pool, prize_pool_finalized, payout_structure)
VALUES (:'t', 'COMPLETING', 'spin', 'SPIN', 10, 30.00, true,
        '[{"place": 1, "percentage": 50}, {"place": 2, "percentage": 30}, {"place": 3, "percentage": 20}]');
INSERT INTO public.tournament_escrow (tournament_id, enforced, prize_balance) VALUES (:'t', true, 30.00);
INSERT INTO public.tournament_players (tournament_id, user_id, status, chips, position, prize, eliminated_at)
VALUES
  (:'t', '80000000-0000-4000-8000-000000000001', 'winner', 1500, 1, 24.00, NULL),
  (:'t', '80000000-0000-4000-8000-000000000002', 'eliminated', 0, 2, 6.00, '2026-09-10 10:00:00+00'),
  (:'t', '80000000-0000-4000-8000-000000000003', 'eliminated', 0, 3, 0, '2026-09-10 10:05:00+00');
SELECT public.fn_prepare_tournament_place_obligations(:'t') AS prepared \gset
SELECT probe.check((:'prepared'::jsonb->>'ok')::boolean, 'the Spin plan is accepted: ' || :'prepared');
SELECT probe.check((SELECT string_agg(right(user_id::text, 1) || '=' || position || '/' || round(prize, 2), ','
                                      ORDER BY position)
                      FROM public.tournament_players WHERE tournament_id = :'t')
                   = '1=1/24.00,3=2/6.00,2=3/0.00',
                   'second place carries the drawn ladder''s 20 percent, third carries nothing');
