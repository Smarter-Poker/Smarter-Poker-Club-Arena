-- KEPT. A satellite pays seats through its own settlement, not this ladder. Its
-- standings are renumbered exactly as before and no prize is rewritten.
\set ON_ERROR_STOP on
\set t 'b0000000-0000-4000-8000-000000000001'
INSERT INTO public.tournaments (id, status, variant, prize_pool, prize_pool_finalized, payout_structure)
VALUES (:'t', 'COMPLETING', 'satellite', 100.00, true,
        '[{"place": 1, "percentage": 50}, {"place": 2, "percentage": 30}, {"place": 3, "percentage": 20}]');
INSERT INTO public.tournament_players (tournament_id, user_id, status, chips, position, prize, eliminated_at)
VALUES
  (:'t', 'b0000000-0000-4000-8000-000000000001', 'winner', 1500, 1, 50.00, NULL),
  (:'t', 'b0000000-0000-4000-8000-000000000002', 'eliminated', 0, 2, 30.00, '2026-09-10 10:00:00+00'),
  (:'t', 'b0000000-0000-4000-8000-000000000003', 'eliminated', 0, 3, 20.00, '2026-09-10 10:05:00+00');
SELECT public.fn_normalize_tournament_final_standings(:'t') AS normalized \gset
SELECT probe.check((:'normalized'::jsonb->>'ok')::boolean, 'a satellite still normalizes: ' || :'normalized');
SELECT probe.check((SELECT string_agg(right(user_id::text, 1) || '=' || position || '/' || round(prize, 2), ','
                                      ORDER BY position)
                      FROM public.tournament_players WHERE tournament_id = :'t')
                   = '1=1/50.00,3=2/20.00,2=3/30.00', 'renumbered, prizes untouched');
