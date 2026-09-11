-- FIXED. The same misordered paid places in two events. In u a place is
-- already promised - a Bubble Protection obligation - and re-pricing under
-- place money could pay a place twice or take one back, so the normalizer
-- refuses, says why, and renumbers nothing. In t the only money that moved is
-- a bounty, which its own authority paid for a knockout, not for a place: it
-- does not hold the ladder, and t is renumbered and re-priced. The old
-- normalizer renumbered both and left the prizes behind, for the place prepare
-- to refuse later.
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

SELECT public.fn_normalize_tournament_final_standings(:'t') AS bounty_only \gset
SELECT public.fn_normalize_tournament_final_standings(:'u') AS promised \gset
SELECT probe.check((:'bounty_only'::jsonb->>'ok')::boolean AND (:'bounty_only'::jsonb->>'repriced')::integer = 2,
                   'a bounty payout does not hold the ladder: ' || :'bounty_only');
SELECT probe.check(probe.roster(:'t') = '1=1/50.00,3=2/30.00,2=3/20.00,4=4/0.00',
                   'each moved place carries its own price: ' || probe.roster(:'t'));
SELECT probe.check(:'promised'::jsonb->>'reason' = 'moved_places_cannot_be_repriced_after_money_moved'
                   AND (:'promised'::jsonb->>'ok')::boolean IS FALSE,
                   'a Bubble Protection promise refuses the re-price: ' || :'promised');
SELECT probe.check(probe.roster(:'u') = '1=1/50.00,2=2/30.00,3=3/20.00,4=4/0.00',
                   'nothing was renumbered or re-priced under the promise: ' || probe.roster(:'u'));
-- and the place prepare reports the refusal instead of freezing a plan
SELECT public.fn_prepare_tournament_place_obligations(:'u') AS prepared \gset
SELECT probe.check(:'prepared'::jsonb->>'normalization_reason' = 'moved_places_cannot_be_repriced_after_money_moved',
                   'prepare surfaces the reason: ' || :'prepared');
