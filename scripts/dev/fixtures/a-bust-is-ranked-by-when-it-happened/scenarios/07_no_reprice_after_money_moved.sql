-- FIXED. The same misordered paid places, but money has already moved for the
-- event: a payout row in one, an obligation in the other. Re-pricing under money
-- could pay a place twice or take one back, so the normalizer refuses, says why,
-- and renumbers nothing. The old normalizer renumbered anyway and left the
-- prizes behind, for the place prepare to refuse later.
\set ON_ERROR_STOP on
\set t '70000000-0000-4000-8000-000000000001'
\set u '70000000-0000-4000-8000-000000000002'
INSERT INTO public.tournaments (id, status, prize_pool, prize_pool_finalized, payout_structure)
VALUES (:'t', 'COMPLETING', 100.00, true,
        '[{"place": 1, "percentage": 50}, {"place": 2, "percentage": 30}, {"place": 3, "percentage": 20}]'),
       (:'u', 'COMPLETING', 100.00, true,
        '[{"place": 1, "percentage": 50}, {"place": 2, "percentage": 30}, {"place": 3, "percentage": 20}]');
INSERT INTO public.tournament_players (tournament_id, user_id, status, chips, position, prize, eliminated_at)
SELECT e.id, x.user_id, x.status, 0, x.position, x.prize, x.eliminated_at
  FROM (VALUES (:'t'::uuid), (:'u'::uuid)) AS e(id),
       (VALUES ('7a000000-0000-4000-8000-000000000001'::uuid, 'winner', 1, 50.00, NULL::timestamptz),
               ('7a000000-0000-4000-8000-000000000002'::uuid, 'eliminated', 2, 30.00, '2026-09-10 10:01:00+00'),
               ('7a000000-0000-4000-8000-000000000003'::uuid, 'eliminated', 3, 20.00, '2026-09-10 10:02:00+00'),
               ('7a000000-0000-4000-8000-000000000004'::uuid, 'eliminated', 4, 0, '2026-09-10 10:00:00+00'))
       AS x(user_id, status, position, prize, eliminated_at);
-- money moved: a bounty paid out in t, a Bubble Protection promise in u
INSERT INTO public.tournament_payouts (tournament_id, user_id, position, amount, source)
VALUES (:'t', '7a000000-0000-4000-8000-000000000004', NULL, 1.00, 'bounty');
INSERT INTO public.tournament_obligations (tournament_id, kind, place, user_id, amount_owed, amount_paid, source)
VALUES (:'u', 'bubble_protection', NULL, '7a000000-0000-4000-8000-000000000004', 1.00, 0, 'engine.eliminatePlayer');

SELECT public.fn_normalize_tournament_final_standings(:'t') AS paid \gset
SELECT public.fn_normalize_tournament_final_standings(:'u') AS promised \gset
SELECT probe.check(:'paid'::jsonb->>'reason' = 'moved_places_cannot_be_repriced_after_money_moved'
                   AND (:'paid'::jsonb->>'ok')::boolean IS FALSE,
                   'a payout row refuses the re-price: ' || :'paid');
SELECT probe.check(:'promised'::jsonb->>'reason' = 'moved_places_cannot_be_repriced_after_money_moved',
                   'an obligation refuses the re-price: ' || :'promised');
SELECT probe.check((SELECT count(*) FROM public.tournament_players tp
                     WHERE tp.tournament_id IN (:'t', :'u')
                       AND ((right(tp.user_id::text, 1) = '2' AND tp.position = 2 AND tp.prize = 30.00)
                         OR (right(tp.user_id::text, 1) = '3' AND tp.position = 3 AND tp.prize = 20.00))) = 4,
                   'nothing was renumbered or re-priced');
-- and the place prepare reports the refusal instead of freezing a plan
SELECT public.fn_prepare_tournament_place_obligations(:'t') AS prepared \gset
SELECT probe.check(:'prepared'::jsonb->>'normalization_reason' = 'moved_places_cannot_be_repriced_after_money_moved',
                   'prepare surfaces the reason: ' || :'prepared');
