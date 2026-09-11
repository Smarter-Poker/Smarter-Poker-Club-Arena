-- FIXED. Three players bust in one hand and the door records them in the wrong
-- order, largest stack first. eliminated_at still says who went first: the
-- smaller hand-start stack, then user id, one microsecond apart. The old door
-- stamped each with the moment it recorded it, which is the reverse.
\set ON_ERROR_STOP on
\set t '20000000-0000-4000-8000-000000000001'
\set tb '20000000-0000-4000-8000-0000000000ab'
\set big '20000000-0000-4000-8000-00000000000b'
\set c '20000000-0000-4000-8000-00000000000c'
\set e '20000000-0000-4000-8000-00000000000e'
INSERT INTO public.tournaments (id, status) VALUES (:'t', 'RUNNING');
INSERT INTO public.tables (id, tournament_id) VALUES (:'tb', :'t');
SELECT probe.player(:'t', :'big');
SELECT probe.player(:'t', :'c');
SELECT probe.player(:'t', :'e');
SELECT probe.player(:'t', '20000000-0000-4000-8000-00000000000f', 9000);
SELECT probe.player(:'t', '20000000-0000-4000-8000-000000000010', 9000);
SELECT probe.bust(:'t', :'tb', :'big', 1000200, 500, '2026-09-10 12:00:00+00');
SELECT probe.bust(:'t', :'tb', :'c', 1000200, 200, '2026-09-10 12:00:00+00');
SELECT probe.bust(:'t', :'tb', :'e', 1000200, 200, '2026-09-10 12:00:00+00');
SELECT probe.check((probe.door(:'t', :'big', 5)->>'claimed')::boolean, 'the largest stack is recorded first');
SELECT probe.check((probe.door(:'t', :'e', 4)->>'claimed')::boolean, 'then e');
SELECT probe.check((probe.door(:'t', :'c', 3)->>'claimed')::boolean, 'then c');
SELECT probe.check(probe.eliminated_at(:'t', :'c') = '2026-09-10 12:00:00+00',
                   'the smaller stack (and lower user id) busted first: exactly the hand time');
SELECT probe.check(probe.eliminated_at(:'t', :'e') = '2026-09-10 12:00:00.000001+00',
                   'the equal stack with the higher user id is one microsecond later');
SELECT probe.check(probe.eliminated_at(:'t', :'big') = '2026-09-10 12:00:00.000002+00',
                   'the largest stack busted last in the hand');
-- A replay of an accepted bust is still the same receipt and moves nothing.
SELECT probe.check((probe.door(:'t', :'big', 5)->>'already')::boolean, 'a replay is recognised');
SELECT probe.check(probe.eliminated_at(:'t', :'big') = '2026-09-10 12:00:00.000002+00',
                   'a replay does not restamp the bust');
