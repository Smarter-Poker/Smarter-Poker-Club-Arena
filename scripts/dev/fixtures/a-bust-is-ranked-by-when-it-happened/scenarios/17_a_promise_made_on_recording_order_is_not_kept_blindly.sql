-- FIXED. d, c, a, b bust in that order; the door recorded a last, so the
-- recorded ladder is the recording order (a second, b third), and a place has
-- already been promised on it: second place to a. The settlement used to find
-- nothing to move and pay the promise - 30.00 to a, who finished third. The
-- bust order now says the promised place is the wrong one, and a place that
-- carries money is never relabelled, so it refuses for adjudication instead of
-- paying it; nothing is written. (No RUNNING event carried place evidence when
-- this was measured, 2026-09-11.)
\set ON_ERROR_STOP on
\set t '17000000-0000-4000-8000-000000000001'
\set tb '17000000-0000-4000-8000-0000000000ab'
\set w '17000000-0000-4000-8000-00000000000f'
\set a '17000000-0000-4000-8000-00000000000a'
\set b '17000000-0000-4000-8000-00000000000b'
\set c '17000000-0000-4000-8000-00000000000c'
\set d '17000000-0000-4000-8000-00000000000d'
INSERT INTO public.tournaments (id, status, prize_pool, payout_structure)
VALUES (:'t', 'RUNNING', 100.00,
        '[{"place": 1, "percentage": 50}, {"place": 2, "percentage": 30}, {"place": 3, "percentage": 20}]');
INSERT INTO public.tables (id, tournament_id) VALUES (:'tb', :'t');
SELECT probe.player(:'t', :'w', 25000);
SELECT probe.player(:'t', :'a');
SELECT probe.player(:'t', :'b');
SELECT probe.player(:'t', :'c');
SELECT probe.player(:'t', :'d');
SELECT probe.bust(:'t', :'tb', :'d', 2100001, 5000, '2026-09-10 10:00:00+00');
SELECT probe.bust(:'t', :'tb', :'c', 2100002, 5000, '2026-09-10 10:10:00+00');
SELECT probe.bust(:'t', :'tb', :'a', 2100003, 5000, '2026-09-10 10:20:00+00');
SELECT probe.bust(:'t', :'tb', :'b', 2100004, 5000, '2026-09-10 10:30:00+00');
SELECT probe.check((probe.door(:'t', :'d', 5)->>'claimed')::boolean, 'd recorded');
SELECT probe.check((probe.door(:'t', :'c', 4)->>'claimed')::boolean, 'c recorded');
SELECT probe.check((probe.door(:'t', :'b', 3, 20.00)->>'claimed')::boolean, 'b recorded before a');
SELECT probe.check((probe.door(:'t', :'a', 2, 30.00)->>'claimed')::boolean, 'a recorded last');
INSERT INTO public.tournament_obligations (tournament_id, kind, place, user_id, amount_owed, amount_paid, source)
VALUES (:'t', 'place', 2, :'a', 30.00, 0, 'probe');

SELECT COALESCE(probe.settle_refusal(:'t', :'w'), 'it settled') AS refusal \gset
SELECT probe.check(:'refusal' LIKE '%needs a late-entry position normalization but already carries settled place evidence%',
                   'a place promised on the recording order is not paid to the wrong player: '
                   || :'refusal' || ', paid ' || COALESCE(probe.paid(:'t'), 'nothing'));
SELECT probe.check(probe.paid(:'t') IS NULL, 'nothing was paid');
SELECT probe.check(probe.roster(:'t') = 'a=2/30.00,b=3/20.00,c=4/0.00,d=5/0.00,f=-/0.00',
                   'nothing was renumbered: ' || probe.roster(:'t'));
