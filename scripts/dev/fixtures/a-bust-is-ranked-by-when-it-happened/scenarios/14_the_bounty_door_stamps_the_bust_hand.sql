-- FIXED. A bounty event, where every bust goes through
-- fn_claim_tournament_bounty_elimination. That door stamped eliminated_at with
-- now(), the moment it accepted the claim; it now stamps the commit of the bust
-- hand, one microsecond apart per same-hand rank, exactly as the non-bounty
-- door does. And the finish ranks the bounty event's busts by their hands too:
-- d, c, a, b bust in that order, the door records a last, and b - who busted
-- last - is paid second.
\set ON_ERROR_STOP on
\set t 'e0000000-0000-4000-8000-000000000001'
\set tb 'e0000000-0000-4000-8000-0000000000ab'
\set w 'e0000000-0000-4000-8000-00000000000f'
\set a 'e0000000-0000-4000-8000-00000000000a'
\set b 'e0000000-0000-4000-8000-00000000000b'
\set c 'e0000000-0000-4000-8000-00000000000c'
\set d 'e0000000-0000-4000-8000-00000000000d'
\set e 'e0000000-0000-4000-8000-00000000000e'
INSERT INTO public.tournaments (id, status, is_bounty, bounty_amount, prize_pool, payout_structure)
VALUES (:'t', 'RUNNING', true, 1.00, 100.00,
        '[{"place": 1, "percentage": 50}, {"place": 2, "percentage": 30}, {"place": 3, "percentage": 20}]');
INSERT INTO public.tables (id, tournament_id) VALUES (:'tb', :'t');
SELECT probe.player(:'t', :'w', 25000);
SELECT probe.player(:'t', :'a');
SELECT probe.player(:'t', :'b');
SELECT probe.player(:'t', :'c');
SELECT probe.player(:'t', :'d');
SELECT probe.player(:'t', :'e');
SELECT probe.bust(:'t', :'tb', :'e', 1800001, 7000, '2026-09-10 09:50:00.250000+00');
-- d and c bust in one hand: c had the smaller stack and busts first
SELECT probe.bust(:'t', :'tb', :'d', 1800002, 5000, '2026-09-10 10:00:00.123456+00');
SELECT probe.bust(:'t', :'tb', :'c', 1800002, 3000, '2026-09-10 10:00:00.123456+00');
SELECT probe.bust(:'t', :'tb', :'a', 1800003, 5000, '2026-09-10 10:20:00+00');
SELECT probe.bust(:'t', :'tb', :'b', 1800004, 5000, '2026-09-10 10:30:00+00');
-- w won d's pot, so d's head has a claimant and is owed; the others' heads
-- could not be attributed and stay in the pool
INSERT INTO public.probe_claimants (hand_id, eliminated_user_id, claimants)
VALUES (md5('hand:1800002')::uuid, :'d', jsonb_build_array(jsonb_build_object('user_id', :'w', 'weight', 1)));

SELECT probe.check((probe.claim(:'t', :'e', 6)->>'claimed')::boolean, 'e recorded');
SELECT probe.claim(:'t', :'d', 5) AS d_claim \gset
SELECT probe.check((:'d_claim'::jsonb->>'claimed')::boolean
                   AND :'d_claim'::jsonb->>'obligation_id' IS NOT NULL, 'd recorded with its bounty owed: ' || :'d_claim');
SELECT probe.check((probe.claim(:'t', :'c', 4)->>'claimed')::boolean, 'c recorded');
SELECT probe.check((probe.claim(:'t', :'b', 3, 20.00)->>'claimed')::boolean, 'b recorded before a');
SELECT probe.check((probe.claim(:'t', :'a', 2, 30.00)->>'claimed')::boolean, 'a recorded last');

SELECT probe.check(probe.eliminated_at(:'t', :'e') = '2026-09-10 09:50:00.250000+00',
                   'e is stamped with its bust hand, not the moment the claim was accepted (got '
                   || probe.eliminated_at(:'t', :'e') || ')');
SELECT probe.check(probe.eliminated_at(:'t', :'c') = '2026-09-10 10:00:00.123456+00'
                   AND probe.eliminated_at(:'t', :'d') = '2026-09-10 10:00:00.123457+00',
                   'one hand: the smaller stack is the hand time, the larger one microsecond later');
SELECT probe.check(probe.eliminated_at(:'t', :'a') = '2026-09-10 10:20:00+00'
                   AND probe.eliminated_at(:'t', :'b') = '2026-09-10 10:30:00+00',
                   'a and b keep the time they busted, whatever order they were recorded in');
SELECT probe.check((SELECT count(*) = 5 FROM public.tournament_knockout_candidates
                     WHERE tournament_id = :'t' AND state = 'eliminated'), 'every bound generation is consumed');

SELECT probe.settle(:'t', :'w') AS settled \gset
SELECT probe.check((:'settled'::jsonb->>'ok')::boolean, 'the finish settles: ' || :'settled');
SELECT probe.check(probe.paid(:'t') = '1:f:50.00,2:b:30.00,3:a:20.00',
                   'the bounty event pays its places in bust order too (paid ' || probe.paid(:'t') || ')');
SELECT probe.check(probe.roster(:'t') = 'f=1/50.00,b=2/30.00,a=3/20.00,d=4/0.00,c=5/0.00,e=6/0.00',
                   'the roster: ' || probe.roster(:'t'));
