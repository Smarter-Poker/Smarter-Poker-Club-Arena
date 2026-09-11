-- KEPT. A place has been promised (an obligation) in one event and paid (a
-- positioned payout) in another, and the recorded ladder agrees with neither
-- the bust order nor the recording order. Moving it would relabel money that
-- already moved, so the settlement refuses for adjudication, as it always has,
-- and nothing is written.
\set ON_ERROR_STOP on
\set t '10a00000-0000-4000-8000-000000000001'
\set u '10a00000-0000-4000-8000-000000000002'
\set tb '10a00000-0000-4000-8000-0000000000ab'
\set ub '10a00000-0000-4000-8000-0000000000ac'
\set w '10a00000-0000-4000-8000-00000000000f'
\set a '10a00000-0000-4000-8000-00000000000a'
\set b '10a00000-0000-4000-8000-00000000000b'
\set c '10a00000-0000-4000-8000-00000000000c'
\set d '10a00000-0000-4000-8000-00000000000d'
INSERT INTO public.tournaments (id, status, prize_pool, payout_structure)
SELECT e, 'RUNNING', 100.00,
       '[{"place": 1, "percentage": 50}, {"place": 2, "percentage": 30}, {"place": 3, "percentage": 20}]'
  FROM (VALUES (:'t'::uuid), (:'u'::uuid)) v(e);
INSERT INTO public.tables (id, tournament_id) VALUES (:'tb', :'t'), (:'ub', :'u');
DO $setup$
DECLARE e record; p record; h bigint := 2000000;
BEGIN
  FOR e IN SELECT * FROM (VALUES ('10a00000-0000-4000-8000-000000000001'::uuid, '10a00000-0000-4000-8000-0000000000ab'::uuid),
                                 ('10a00000-0000-4000-8000-000000000002'::uuid, '10a00000-0000-4000-8000-0000000000ac'::uuid)) x(t, tb) LOOP
    PERFORM probe.player(e.t, '10a00000-0000-4000-8000-00000000000f', 25000);
    -- bust order d, c, a, b; recorded in the same order; recorded places wrong
    FOR p IN SELECT * FROM (VALUES ('10a00000-0000-4000-8000-00000000000d'::uuid, '2026-09-10 10:00:00+00'::timestamptz, 5),
                                   ('10a00000-0000-4000-8000-00000000000c'::uuid, '2026-09-10 10:10:00+00'::timestamptz, 4),
                                   ('10a00000-0000-4000-8000-00000000000a'::uuid, '2026-09-10 10:20:00+00'::timestamptz, 2),
                                   ('10a00000-0000-4000-8000-00000000000b'::uuid, '2026-09-10 10:30:00+00'::timestamptz, 3)) y(uid, at, pos) LOOP
      h := h + 1;
      PERFORM probe.player(e.t, p.uid);
      PERFORM probe.bust(e.t, e.tb, p.uid, h, 5000, p.at, 'eliminated');
      UPDATE public.tournament_players SET status = 'eliminated', position = p.pos, eliminated_at = p.at
       WHERE tournament_id = e.t AND user_id = p.uid;
    END LOOP;
  END LOOP;
END;
$setup$;
-- t: second place promised to a; u: second place paid to a
INSERT INTO public.tournament_obligations (tournament_id, kind, place, user_id, amount_owed, amount_paid, source)
VALUES (:'t', 'place', 2, :'a', 30.00, 0, 'probe');
INSERT INTO public.tournament_payouts (tournament_id, user_id, position, amount, source)
VALUES (:'u', :'a', 2, 30.00, 'structure');

SELECT probe.check(probe.settle_refusal(:'t', :'w') LIKE '%needs a late-entry position normalization but already carries settled place evidence%',
                   'a promised place is not relabelled: ' || COALESCE(probe.settle_refusal(:'t', :'w'), 'it settled'));
SELECT probe.check(probe.settle_refusal(:'u', :'w') LIKE '%needs a late-entry position normalization but already carries settled place evidence%',
                   'a paid place is not relabelled: ' || COALESCE(probe.settle_refusal(:'u', :'w'), 'it settled'));
SELECT probe.check(probe.roster(:'t') = 'a=2/0.00,b=3/0.00,c=4/0.00,d=5/0.00,f=-/0.00'
                   AND probe.roster(:'u') = 'a=2/0.00,b=3/0.00,c=4/0.00,d=5/0.00,f=-/0.00',
                   'nothing was written: ' || probe.roster(:'t') || ' / ' || probe.roster(:'u'));
SELECT probe.check((SELECT status FROM public.tournaments WHERE id = :'t') = 'RUNNING', 'the event did not finish');
