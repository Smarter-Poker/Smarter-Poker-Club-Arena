-- FIXED. Places are ranked by when each bust happened; a row with no committed
-- knockout hand to read it from falls back to its eliminated_at. A row with
-- neither cannot be ranked, and a guess is never allowed to take a place: the
-- settlement refuses the finish and writes nothing. It used to number the row
-- by recording order and pay it.
\set ON_ERROR_STOP on
\set t '24000000-0000-4000-8000-000000000001'
\set w '24000000-0000-4000-8000-00000000000f'
\set a '24000000-0000-4000-8000-00000000000a'
\set b '24000000-0000-4000-8000-00000000000b'
\set c '24000000-0000-4000-8000-00000000000c'
INSERT INTO public.tournaments (id, status, prize_pool, payout_structure)
VALUES (:'t', 'RUNNING', 100.00, '[{"place": 1, "percentage": 70}, {"place": 2, "percentage": 30}]');
SELECT probe.player(:'t', :'w', 25000);
SELECT probe.player(:'t', :'a');
SELECT probe.player(:'t', :'b');
SELECT probe.player(:'t', :'c');
-- recorded outside the knockout door: no generation, and b's time was lost
UPDATE public.tournament_players SET status = 'eliminated', position = 4, eliminated_at = '2026-09-10 10:00:00+00'
 WHERE tournament_id = :'t' AND user_id = :'c';
UPDATE public.tournament_players SET status = 'eliminated', position = 3, eliminated_at = NULL
 WHERE tournament_id = :'t' AND user_id = :'b';
UPDATE public.tournament_players SET status = 'eliminated', position = 2, eliminated_at = '2026-09-10 10:20:00+00'
 WHERE tournament_id = :'t' AND user_id = :'a';

SELECT COALESCE(probe.settle_refusal(:'t', :'w'), 'it settled') AS refusal \gset
SELECT probe.check(:'refusal' LIKE '%has 1 eliminated player(s) with no bust witness and no eliminated_at%',
                   'an unrankable bust refuses the finish: ' || :'refusal' || ', paid ' || COALESCE(probe.paid(:'t'), 'nothing'));
SELECT probe.check(probe.paid(:'t') IS NULL AND (SELECT status FROM public.tournaments WHERE id = :'t') = 'RUNNING',
                   'nothing was paid and the event is still running');

-- a row with no generation but a time is ranked by that time
UPDATE public.tournament_players SET eliminated_at = '2026-09-10 10:30:00+00'
 WHERE tournament_id = :'t' AND user_id = :'b';
SELECT probe.settle(:'t', :'w') AS settled \gset
SELECT probe.check((:'settled'::jsonb->>'ok')::boolean, 'with its time it settles: ' || :'settled');
SELECT probe.check(probe.paid(:'t') = '1:f:70.00,2:b:30.00',
                   'and b, whose eliminated_at is the latest, is second: ' || probe.paid(:'t'));
