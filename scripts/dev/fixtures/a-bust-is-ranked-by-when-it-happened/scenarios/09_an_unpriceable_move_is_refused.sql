-- FIXED. The standings must move paid places but the event has no ladder that
-- can be derived (payout_structure is the column default 'Standard'). The
-- normalizer will not guess an amount: it refuses and renumbers nothing. The old
-- normalizer renumbered and reported success with the prizes left behind.
\set ON_ERROR_STOP on
\set t '90000000-0000-4000-8000-000000000001'
INSERT INTO public.tournaments (id, status, prize_pool, prize_pool_finalized)
VALUES (:'t', 'COMPLETING', 100.00, true);
INSERT INTO public.tournament_players (tournament_id, user_id, status, chips, position, prize, eliminated_at)
VALUES
  (:'t', '90000000-0000-4000-8000-000000000001', 'winner', 1500, 1, 50.00, NULL),
  (:'t', '90000000-0000-4000-8000-000000000002', 'eliminated', 0, 2, 30.00, '2026-09-10 10:00:00+00'),
  (:'t', '90000000-0000-4000-8000-000000000003', 'eliminated', 0, 3, 20.00, '2026-09-10 10:05:00+00');
SELECT public.fn_normalize_tournament_final_standings(:'t') AS normalized \gset
SELECT probe.check(:'normalized'::jsonb->>'reason' = 'moved_places_cannot_be_priced'
                   AND :'normalized'::jsonb->>'detail' = 'payout_structure_is_invalid',
                   'an underivable ladder refuses the move: ' || :'normalized');
SELECT probe.check((SELECT string_agg(right(user_id::text, 1) || '=' || position || '/' || round(prize, 2), ','
                                      ORDER BY position)
                      FROM public.tournament_players WHERE tournament_id = :'t')
                   = '1=1/50.00,2=2/30.00,3=3/20.00', 'nothing was renumbered');
