-- FIXED. A bust recorded long after it happened keeps the time it happened.
-- The old door stamped now(), the moment it accepted the bust.
\set ON_ERROR_STOP on
\set t '10000000-0000-4000-8000-000000000001'
\set tb '10000000-0000-4000-8000-0000000000ab'
\set a '10000000-0000-4000-8000-00000000000a'
\set w '10000000-0000-4000-8000-00000000000f'
INSERT INTO public.tournaments (id, status) VALUES (:'t', 'RUNNING');
INSERT INTO public.tables (id, tournament_id) VALUES (:'tb', :'t');
SELECT probe.player(:'t', :'a');
SELECT probe.player(:'t', :'w', 5000);
SELECT probe.player(:'t', '10000000-0000-4000-8000-00000000000e', 5000);
SELECT probe.bust(:'t', :'tb', :'a', 9166239, 30000, '2026-09-10 15:02:20.123456+00') AS k \gset
SELECT probe.check((probe.door(:'t', :'a', 3)->>'claimed')::boolean,
                   'the door accepts a proven bust');
SELECT probe.check(probe.eliminated_at(:'t', :'a') = '2026-09-10 15:02:20.123456+00',
                   'eliminated_at is the bust hand''s commit time, not the moment the door accepted it (got '
                   || probe.eliminated_at(:'t', :'a') || ')');
SELECT probe.check(probe.state(:'k') = 'eliminated', 'the bound generation is consumed');
SELECT probe.check((SELECT position = 3 AND status = 'eliminated' FROM public.tournament_players
                     WHERE tournament_id = :'t' AND user_id = :'a'), 'the place and status commit with it');
