-- FIXED. The shape of six rows production already holds (798866ae 22af2652,
-- 6d6b3cc2, 20a40df1, 45a5e770; 7aa16fa7 71efcdb3; a5aa6984 55256246, all out of
-- the money): the player busted, a posted rebuy leg followed within seconds, the
-- 2026-09-08/09 rebuy chain never marked that generation 'rebought', and the
-- player then PLAYED ON - later hands deal them in with chips. The generation
-- the door binds is still that old one, so its hand is not the bust. The doors
-- accepted it and stamped the clock; stamping its hand instead would rank the
-- player at a bust they came back from. Both doors now refuse it
-- (knockout_bust_time_unproven) and write nothing. A leg after the bust with no
-- later hand (a purchase that never seated the player) proves nothing about a
-- later bust and is still recorded at its hand.
\set ON_ERROR_STOP on
\set t '20000000-2000-4000-8000-000000000001'
\set k '20000000-2000-4000-8000-000000000002'
\set tb '20000000-2000-4000-8000-0000000000ab'
\set kb '20000000-2000-4000-8000-0000000000ac'
INSERT INTO public.tournaments (id, status) VALUES (:'t', 'RUNNING');
INSERT INTO public.tournaments (id, status, is_bounty, bounty_amount) VALUES (:'k', 'RUNNING', true, 1.00);
INSERT INTO public.tables (id, tournament_id) VALUES (:'tb', :'t'), (:'kb', :'k');
SELECT probe.player(:'t', '20000000-2000-4000-8000-0000000000ff', 90000);
SELECT probe.player(:'k', '20000000-2000-4000-8000-0000000000ff', 90000);

-- user, bound hand, bound at, first leg after, a later hand that deals them in
CREATE TEMP TABLE played_on (user_id uuid, hand bigint, bound_at timestamptz, leg_at timestamptz, later_hand bigint);
INSERT INTO played_on VALUES
  ('22af2652-0000-4000-8000-000000000001', 8540571, '2026-09-09 05:10:09.792328+00', '2026-09-09 05:10:10.776201+00', 8554750),
  ('6d6b3cc2-0000-4000-8000-000000000001', 8540573, '2026-09-09 05:10:17.110227+00', '2026-09-09 05:10:17.916943+00', 8552431),
  ('20a40df1-0000-4000-8000-000000000001', 8551332, '2026-09-09 05:29:15.359401+00', '2026-09-09 05:29:17.285648+00', 8553088),
  ('45a5e770-0000-4000-8000-000000000001', 8550715, '2026-09-09 05:28:29.441840+00', '2026-09-09 05:28:31.824262+00', 8552238),
  ('71efcdb3-0000-4000-8000-000000000001', 8271172, '2026-09-08 18:32:03.976809+00', '2026-09-08 18:32:14.184011+00', 8441527),
  ('55256246-0000-4000-8000-000000000001', 8579957, '2026-09-09 06:30:05.045595+00', '2026-09-09 06:30:08.536982+00', 8587116);
DO $setup$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM played_on LOOP
    PERFORM probe.player('20000000-2000-4000-8000-000000000001', r.user_id);
    PERFORM probe.bust('20000000-2000-4000-8000-000000000001', '20000000-2000-4000-8000-0000000000ab',
                       r.user_id, r.hand, 2500, r.bound_at + interval '1 millisecond');
    PERFORM probe.rebuy_leg('20000000-2000-4000-8000-000000000001', r.user_id, r.leg_at);
    PERFORM probe.dealt('20000000-2000-4000-8000-000000000001', '20000000-2000-4000-8000-0000000000ab',
                        r.user_id, r.later_hand, 3773, r.leg_at + interval '4 minutes');
  END LOOP;
END;
$setup$;

DO $check$
DECLARE r record; v jsonb; v_place integer := 80;
BEGIN
  FOR r IN SELECT * FROM played_on ORDER BY user_id LOOP
    v := probe.door('20000000-2000-4000-8000-000000000001', r.user_id, v_place);
    v_place := v_place - 1;
    PERFORM probe.check(v->>'reason' = 'knockout_bust_time_unproven',
                        left(r.user_id::text, 8) || ' played on after a rebuy: refused, not stamped with hand '
                        || r.hand || ' (got ' || v || ')');
    PERFORM probe.check((SELECT tp.status = 'playing' AND tp.position IS NULL AND tp.eliminated_at IS NULL
                           FROM public.tournament_players tp
                          WHERE tp.tournament_id = '20000000-2000-4000-8000-000000000001'
                            AND tp.user_id = r.user_id),
                        left(r.user_id::text, 8) || ': the roster row is untouched');
    PERFORM probe.check((SELECT c.state = 'pending' FROM public.tournament_knockout_candidates c
                          WHERE c.tournament_id = '20000000-2000-4000-8000-000000000001'
                            AND c.eliminated_user_id = r.user_id),
                        left(r.user_id::text, 8) || ': the generation is not consumed');
  END LOOP;
END;
$check$;

-- the bounty door, same shape
SELECT probe.player(:'k', '22af2652-0000-4000-8000-00000000000b');
SELECT probe.bust(:'k', :'kb', '22af2652-0000-4000-8000-00000000000b', 8540579, 2500, '2026-09-09 05:10:09.793+00');
SELECT probe.rebuy_leg(:'k', '22af2652-0000-4000-8000-00000000000b', '2026-09-09 05:10:10.776+00');
SELECT probe.dealt(:'k', :'kb', '22af2652-0000-4000-8000-00000000000b', 8554751, 3773, '2026-09-09 05:14:05+00');
SELECT probe.claim(:'k', '22af2652-0000-4000-8000-00000000000b', 30) AS bounty_result \gset
SELECT probe.check(:'bounty_result'::jsonb->>'reason' = 'knockout_bust_time_unproven',
                   'the bounty door refuses the same shape: ' || :'bounty_result');
SELECT probe.check((SELECT status = 'playing' AND eliminated_at IS NULL FROM public.tournament_players
                     WHERE tournament_id = :'k' AND user_id = '22af2652-0000-4000-8000-00000000000b')
                   AND NOT EXISTS (SELECT 1 FROM public.tournament_bounty_obligations WHERE tournament_id = :'k'),
                   'and writes nothing');

-- a leg after the bust but no later hand: the purchase never seated the player
SELECT probe.player(:'t', 'dca6c345-0000-4000-8000-000000000001');
SELECT probe.bust(:'t', :'tb', 'dca6c345-0000-4000-8000-000000000001', 8569325, 2330, '2026-09-09 06:13:09.079372+00');
SELECT probe.rebuy_leg(:'t', 'dca6c345-0000-4000-8000-000000000001', '2026-09-09 06:28:26.46404+00');
SELECT probe.door(:'t', 'dca6c345-0000-4000-8000-000000000001', 70) AS unseated \gset
SELECT probe.check((:'unseated'::jsonb->>'claimed')::boolean, 'a rebuy that never dealt the player in does not block the bust: ' || :'unseated');
SELECT probe.check(probe.eliminated_at(:'t', 'dca6c345-0000-4000-8000-000000000001') = '2026-09-09 06:13:09.079372+00',
                   'and the bust keeps its hand''s time');
