-- KEPT. A COMPLETED event paid before this change, by recording order: a was
-- recorded last and paid second although b busted after a. A completed result
-- is never renumbered: the settlement's replay proves every receipt exactly as
-- it was paid and moves nothing, before and after.
\set ON_ERROR_STOP on
\set t '18000000-0000-4000-8000-000000000001'
\set tb '18000000-0000-4000-8000-0000000000ab'
\set w '18000000-0000-4000-8000-00000000000f'
\set a '18000000-0000-4000-8000-00000000000a'
\set b '18000000-0000-4000-8000-00000000000b'
\set c '18000000-0000-4000-8000-00000000000c'
\set d '18000000-0000-4000-8000-00000000000d'
INSERT INTO public.tournaments (id, status, prize_pool, prize_pool_finalized, payout_structure)
VALUES (:'t', 'RUNNING', 100.00, true,
        '[{"place": 1, "percentage": 50}, {"place": 2, "percentage": 30}, {"place": 3, "percentage": 20}]');
INSERT INTO public.tables (id, tournament_id) VALUES (:'tb', :'t');
SELECT probe.player(:'t', :'w', 25000);
DO $setup$
DECLARE p record; h bigint := 2200000;
BEGIN
  -- bust order d, c, a, b; recorded d, c, b, a; paid by recording order
  FOR p IN SELECT * FROM (VALUES ('18000000-0000-4000-8000-00000000000d'::uuid, '2026-09-10 10:00:00+00'::timestamptz, 5, 0.00),
                                 ('18000000-0000-4000-8000-00000000000c'::uuid, '2026-09-10 10:10:00+00'::timestamptz, 4, 0.00),
                                 ('18000000-0000-4000-8000-00000000000b'::uuid, '2026-09-10 10:30:00+00'::timestamptz, 3, 20.00),
                                 ('18000000-0000-4000-8000-00000000000a'::uuid, '2026-09-10 10:20:00+00'::timestamptz, 2, 30.00)) y(uid, at, pos, prize) LOOP
    h := h + 1;
    PERFORM probe.player('18000000-0000-4000-8000-000000000001', p.uid);
    PERFORM probe.bust('18000000-0000-4000-8000-000000000001', '18000000-0000-4000-8000-0000000000ab', p.uid, h, 5000, p.at, 'eliminated');
    UPDATE public.tournament_players SET status = 'eliminated', position = p.pos, prize = p.prize,
           eliminated_at = '2026-09-10 11:00:00+00'::timestamptz + (h - 2200000) * interval '1 minute'
     WHERE tournament_id = '18000000-0000-4000-8000-000000000001' AND user_id = p.uid;
  END LOOP;
END;
$setup$;
UPDATE public.tournament_players SET status = 'winner', position = 1, prize = 50.00, chips = 0
 WHERE tournament_id = :'t' AND user_id = :'w';
-- every place's debt, wallet identity and payout, exactly as a settlement leaves them
INSERT INTO public.tournament_obligations (id, tournament_id, kind, place, user_id, amount_owed, amount_paid, source, settled_at)
SELECT md5('ob:' || x.place)::uuid, :'t', 'place', x.place, x.uid, x.amount, x.amount, 'probe', now()
  FROM (VALUES (1, :'w'::uuid, 50.00), (2, :'a'::uuid, 30.00), (3, :'b'::uuid, 20.00)) x(place, uid, amount);
INSERT INTO public.wallet_credit_idempotency (key, user_id, amount)
SELECT 'tourney:' || :'t' || ':obl:' || o.id || ':place', o.user_id, o.amount_owed
  FROM public.tournament_obligations o WHERE o.tournament_id = :'t';
INSERT INTO public.tournament_payouts (tournament_id, user_id, position, amount, source, idempotency_key)
SELECT :'t', o.user_id, o.place, o.amount_owed, 'structure', 'tourney:' || :'t' || ':obl:' || o.id || ':place'
  FROM public.tournament_obligations o WHERE o.tournament_id = :'t';
UPDATE public.tournaments SET status = 'COMPLETED' WHERE id = :'t';

SELECT probe.settle(:'t', :'w') AS replay \gset
SELECT probe.check((:'replay'::jsonb->>'ok')::boolean AND :'replay'::jsonb->>'status' = 'COMPLETED',
                   'the completed result replays: ' || :'replay');
SELECT probe.check(probe.roster(:'t') = 'f=1/50.00,a=2/30.00,b=3/20.00,c=4/0.00,d=5/0.00',
                   'and stays exactly as it was paid: ' || probe.roster(:'t'));
SELECT probe.check(probe.paid(:'t') = '1:f:50.00,2:a:30.00,3:b:20.00', 'no money moved: ' || probe.paid(:'t'));
