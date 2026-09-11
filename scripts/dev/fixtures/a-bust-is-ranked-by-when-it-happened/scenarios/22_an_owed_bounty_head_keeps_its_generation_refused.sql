-- KEPT. The same orphan shape, but the older generation's head was not
-- collected: r's obligation is still pending (owed to its knocker), s's says
-- settled but has no complete marker, t's generation has no rebuy leg at all,
-- and u's has a rebuy leg but no bounty obligation - its head was never
-- claimed, and the rebuy added the new head on top of it, so closing the
-- generation would pay both heads to u's next knocker. A head still owed would
-- be collected against a player this claim is about to record under a newer
-- head. The door keeps refusing all four exactly as before, and changes no
-- generation, roster row or obligation.
\set ON_ERROR_STOP on
\set t '22000000-0000-4000-8000-000000000001'
\set tb '22000000-0000-4000-8000-0000000000ab'
\set w '22000000-0000-4000-8000-00000000000f'
INSERT INTO public.tournaments (id, status, is_bounty, bounty_amount) VALUES (:'t', 'RUNNING', true, 1.00);
INSERT INTO public.tables (id, tournament_id) VALUES (:'tb', :'t');
SELECT probe.player(:'t', :'w', 90000);
SELECT probe.player(:'t', '22000000-0000-4000-8000-0000000000fe', 90000);

CREATE TEMP TABLE unproven (user_id uuid, why text, older uuid, newer uuid);
DO $setup$
DECLARE v_t uuid := '22000000-0000-4000-8000-000000000001';
        v_tb uuid := '22000000-0000-4000-8000-0000000000ab';
        r record; v_older uuid; v_newer uuid; h bigint := 2400000;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('22000000-0000-4000-8000-000000000011'::uuid, 'an owed head', 'pending', true),
      ('22000000-0000-4000-8000-000000000012'::uuid, 'a settled head with no complete marker', 'incomplete', true),
      ('22000000-0000-4000-8000-000000000013'::uuid, 'no rebuy leg', 'none', false),
      ('22000000-0000-4000-8000-000000000014'::uuid, 'a rebuy leg but a head no obligation names', 'none', true)) x(uid, why, head, leg) LOOP
    PERFORM probe.player(v_t, r.uid);
    h := h + 10;
    v_older := probe.bust(v_t, v_tb, r.uid, h, 100, '2026-09-10 10:00:00+00');
    IF r.leg THEN PERFORM probe.rebuy_leg(v_t, r.uid, '2026-09-10 10:00:05+00'); END IF;
    v_newer := probe.bust(v_t, v_tb, r.uid, h + 1, 100, '2026-09-10 11:00:00+00');
    IF r.head <> 'none' THEN
      INSERT INTO public.tournament_bounty_obligations (
        tournament_id, eliminated_user_id, table_id, hand_id, hand_number, settlement_completed_at,
        seat_joined_at, position, prize, mode, head_amount, knocker_user_id, claimants, state, settled_at)
      SELECT c.tournament_id, c.eliminated_user_id, c.table_id, c.hand_id, c.hand_number, c.created_at,
             c.seat_joined_at, 3, 0, 'regular', 1.00, '22000000-0000-4000-8000-00000000000f',
             '[{"user_id": "22000000-0000-4000-8000-00000000000f", "weight": 1}]'::jsonb,
             CASE WHEN r.head = 'pending' THEN 'pending' ELSE 'settled' END,
             -- 'incomplete': settled, but no bounty row pays its head
             CASE WHEN r.head = 'incomplete' THEN c.created_at + interval '5 seconds' END
        FROM public.tournament_knockout_candidates c WHERE c.id = v_older;
    END IF;
    INSERT INTO unproven VALUES (r.uid, r.why, v_older, v_newer);
  END LOOP;
END;
$setup$;

DO $check$
DECLARE u record; v_result jsonb; v_place integer := 10;
BEGIN
  FOR u IN SELECT * FROM unproven ORDER BY user_id LOOP
    v_result := probe.claim('22000000-0000-4000-8000-000000000001', u.user_id, v_place);
    v_place := v_place - 1;
    PERFORM probe.check(v_result->>'reason' = 'unresolved_knockout_generation_chain',
                        u.why || ': the newer bust is still refused, got ' || v_result);
    PERFORM probe.check(probe.state(u.newer) = 'pending' AND probe.state(u.older) = 'pending',
                        u.why || ': no generation changed');
    PERFORM probe.check((SELECT status = 'playing' AND position IS NULL AND eliminated_at IS NULL
                           FROM public.tournament_players
                          WHERE tournament_id = '22000000-0000-4000-8000-000000000001'
                            AND user_id = u.user_id), u.why || ': the roster row is untouched');
  END LOOP;
  PERFORM probe.check((SELECT count(*) FROM public.tournament_bounty_obligations
                        WHERE tournament_id = '22000000-0000-4000-8000-000000000001') = 2,
                      'no obligation was written or collected');
END;
$check$;
