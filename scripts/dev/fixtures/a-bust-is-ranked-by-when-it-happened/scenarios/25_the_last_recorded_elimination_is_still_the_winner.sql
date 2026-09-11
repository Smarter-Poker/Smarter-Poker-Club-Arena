-- KEPT. When the whole field reads eliminated (the survivor crossed through
-- 'eliminated' in an all-in race), the winner is the row the door recorded
-- LAST - elimination_sequence, the committed transition order - not the row
-- whose hand committed last. w's own zero-stack hand committed before b's, yet
-- w was recorded last and is the winner; the others are placed by their busts.
\set ON_ERROR_STOP on
\set t '25000000-0000-4000-8000-000000000001'
\set tb '25000000-0000-4000-8000-0000000000ab'
\set w '25000000-0000-4000-8000-00000000000f'
\set a '25000000-0000-4000-8000-00000000000a'
\set b '25000000-0000-4000-8000-00000000000b'
\set c '25000000-0000-4000-8000-00000000000c'
INSERT INTO public.tournaments (id, status, prize_pool, payout_structure)
VALUES (:'t', 'RUNNING', 100.00,
        '[{"place": 1, "percentage": 50}, {"place": 2, "percentage": 30}, {"place": 3, "percentage": 20}]');
INSERT INTO public.tables (id, tournament_id) VALUES (:'tb', :'t');
SELECT probe.player(:'t', :'w');
SELECT probe.player(:'t', :'a');
SELECT probe.player(:'t', :'b');
SELECT probe.player(:'t', :'c');
SELECT probe.bust(:'t', :'tb', :'c', 2600001, 5000, '2026-09-10 10:00:00+00', 'eliminated');
SELECT probe.bust(:'t', :'tb', :'a', 2600002, 5000, '2026-09-10 10:10:00+00', 'eliminated');
SELECT probe.bust(:'t', :'tb', :'w', 2600003, 5000, '2026-09-10 10:15:00+00', 'eliminated');
SELECT probe.bust(:'t', :'tb', :'b', 2600004, 5000, '2026-09-10 10:20:00+00', 'eliminated');
UPDATE public.tournament_players SET status = 'eliminated', position = 4, eliminated_at = '2026-09-10 10:00:00+00'
 WHERE tournament_id = :'t' AND user_id = :'c';
UPDATE public.tournament_players SET status = 'eliminated', position = 3, eliminated_at = '2026-09-10 10:10:00+00'
 WHERE tournament_id = :'t' AND user_id = :'a';
UPDATE public.tournament_players SET status = 'eliminated', position = 2, eliminated_at = '2026-09-10 10:20:00+00'
 WHERE tournament_id = :'t' AND user_id = :'b';
UPDATE public.tournament_players SET status = 'eliminated', position = 1, eliminated_at = '2026-09-10 10:15:00+00'
 WHERE tournament_id = :'t' AND user_id = :'w';

SELECT probe.settle(:'t', :'w') AS settled \gset
SELECT probe.check((:'settled'::jsonb->>'ok')::boolean, 'the last recorded elimination settles as the winner: ' || :'settled');
SELECT probe.check(probe.roster(:'t') = 'f=1/50.00,b=2/30.00,a=3/20.00,c=4/0.00', 'the roster: ' || probe.roster(:'t'));
SELECT probe.check((SELECT status = 'winner' AND elimination_sequence IS NULL AND eliminated_at IS NULL
                      FROM public.tournament_players WHERE tournament_id = :'t' AND user_id = :'w'),
                   'w is promoted to winner');
SELECT probe.check(probe.settle_refusal(:'t', :'b') IS NOT NULL, 'and nobody else can be named the winner');
