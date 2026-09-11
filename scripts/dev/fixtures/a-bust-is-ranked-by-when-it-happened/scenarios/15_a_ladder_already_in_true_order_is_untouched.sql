-- FIXED. The places are already in the order the players busted - a repair
-- set them from the hands, as 798866ae's were at 07:04 on 2026-09-11 - but the
-- recording order (elimination_sequence) still disagrees. The settlement
-- renumbered them back to recording order before paying: a second, b third.
-- It now decides whether anything must move by the same bust order it pays
-- by, so a ladder already in true order is paid exactly as it stands.
\set ON_ERROR_STOP on
\set t 'f0000000-0000-4000-8000-000000000001'
\set tb 'f0000000-0000-4000-8000-0000000000ab'
\set w 'f0000000-0000-4000-8000-00000000000f'
\set a 'f0000000-0000-4000-8000-00000000000a'
\set b 'f0000000-0000-4000-8000-00000000000b'
\set c 'f0000000-0000-4000-8000-00000000000c'
\set d 'f0000000-0000-4000-8000-00000000000d'
INSERT INTO public.tournaments (id, status, prize_pool, payout_structure)
VALUES (:'t', 'RUNNING', 100.00,
        '[{"place": 1, "percentage": 50}, {"place": 2, "percentage": 30}, {"place": 3, "percentage": 20}]');
INSERT INTO public.tables (id, tournament_id) VALUES (:'tb', :'t');
SELECT probe.player(:'t', :'w', 25000);
SELECT probe.player(:'t', :'a');
SELECT probe.player(:'t', :'b');
SELECT probe.player(:'t', :'c');
SELECT probe.player(:'t', :'d');
-- every generation already consumed by the door
SELECT probe.bust(:'t', :'tb', :'d', 1900001, 5000, '2026-09-10 10:00:00+00', 'eliminated');
SELECT probe.bust(:'t', :'tb', :'c', 1900002, 5000, '2026-09-10 10:10:00+00', 'eliminated');
SELECT probe.bust(:'t', :'tb', :'a', 1900003, 5000, '2026-09-10 10:20:00+00', 'eliminated');
SELECT probe.bust(:'t', :'tb', :'b', 1900004, 5000, '2026-09-10 10:30:00+00', 'eliminated');
-- recorded d, c, b, a (a last), each already holding its TRUE place
UPDATE public.tournament_players SET status = 'eliminated', position = 5, eliminated_at = '2026-09-10 10:00:00+00'
 WHERE tournament_id = :'t' AND user_id = :'d';
UPDATE public.tournament_players SET status = 'eliminated', position = 4, eliminated_at = '2026-09-10 10:10:00+00'
 WHERE tournament_id = :'t' AND user_id = :'c';
UPDATE public.tournament_players SET status = 'eliminated', position = 2, eliminated_at = '2026-09-10 10:30:00+00'
 WHERE tournament_id = :'t' AND user_id = :'b';
UPDATE public.tournament_players SET status = 'eliminated', position = 3, eliminated_at = '2026-09-10 10:20:00+00'
 WHERE tournament_id = :'t' AND user_id = :'a';
SELECT probe.check((SELECT elimination_sequence FROM public.tournament_players WHERE tournament_id = :'t' AND user_id = :'a')
                   > (SELECT elimination_sequence FROM public.tournament_players WHERE tournament_id = :'t' AND user_id = :'b'),
                   'setup: a was recorded after b');
CREATE TEMP TABLE before_settle AS
  SELECT id, position FROM public.tournament_players
   WHERE tournament_id = :'t' AND status = 'eliminated';

SELECT probe.settle(:'t', :'w') AS settled \gset
SELECT probe.check((:'settled'::jsonb->>'ok')::boolean, 'the finish settles: ' || :'settled');
SELECT probe.check((SELECT count(*) FROM before_settle b JOIN public.tournament_players tp ON tp.id = b.id
                     WHERE tp.position = b.position) = 4,
                   'no place moved: ' || probe.roster(:'t'));
SELECT probe.check(probe.paid(:'t') = '1:f:50.00,2:b:30.00,3:a:20.00',
                   'the true ladder is paid as it stood (paid ' || probe.paid(:'t') || ')');
