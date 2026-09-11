-- KEPT. Without a leg that proves the older generation was bought back, the door
-- refuses the newer bust exactly as before and writes nothing. Each player here
-- is one way a leg can fail to be proof.
\set ON_ERROR_STOP on
\set t '40000000-0000-4000-8000-000000000001'
\set other '40000000-0000-4000-8000-000000000002'
\set tb '40000000-0000-4000-8000-0000000000ab'
INSERT INTO public.tournaments (id, status) VALUES (:'t', 'RUNNING'), (:'other', 'RUNNING');
INSERT INTO public.tables (id, tournament_id) VALUES (:'tb', :'t');
SELECT probe.player(:'t', '40000000-0000-4000-8000-0000000000ff', 9000);
SELECT probe.player(:'t', '40000000-0000-4000-8000-0000000000fe', 9000);

CREATE TEMP TABLE unproven (user_id uuid, why text, older uuid, newer uuid);

-- 1. no leg at all
SELECT probe.player(:'t', '40000000-0000-4000-8000-000000000011');
INSERT INTO unproven SELECT '40000000-0000-4000-8000-000000000011', 'no leg',
  probe.bust(:'t', :'tb', '40000000-0000-4000-8000-000000000011', 1100001, 100, '2026-09-10 10:00:00+00'),
  probe.bust(:'t', :'tb', '40000000-0000-4000-8000-000000000011', 1100002, 100, '2026-09-10 11:00:00+00');
-- 2. the leg came after the newer generation: it paid for that one, not the older
SELECT probe.player(:'t', '40000000-0000-4000-8000-000000000012');
INSERT INTO unproven SELECT '40000000-0000-4000-8000-000000000012', 'leg after the newer generation',
  probe.bust(:'t', :'tb', '40000000-0000-4000-8000-000000000012', 1100011, 100, '2026-09-10 10:00:00+00'),
  probe.bust(:'t', :'tb', '40000000-0000-4000-8000-000000000012', 1100012, 100, '2026-09-10 11:00:00+00');
SELECT probe.rebuy_leg(:'t', '40000000-0000-4000-8000-000000000012', '2026-09-10 11:00:05+00');
-- 3. an add-on is not a rebuy
SELECT probe.player(:'t', '40000000-0000-4000-8000-000000000013');
INSERT INTO unproven SELECT '40000000-0000-4000-8000-000000000013', 'an addon leg',
  probe.bust(:'t', :'tb', '40000000-0000-4000-8000-000000000013', 1100021, 100, '2026-09-10 10:00:00+00'),
  probe.bust(:'t', :'tb', '40000000-0000-4000-8000-000000000013', 1100022, 100, '2026-09-10 11:00:00+00');
SELECT probe.rebuy_leg(:'t', '40000000-0000-4000-8000-000000000013', '2026-09-10 10:00:05+00', 'addon');
-- 4. a leg that did not post
SELECT probe.player(:'t', '40000000-0000-4000-8000-000000000014');
INSERT INTO unproven SELECT '40000000-0000-4000-8000-000000000014', 'an unposted leg',
  probe.bust(:'t', :'tb', '40000000-0000-4000-8000-000000000014', 1100031, 100, '2026-09-10 10:00:00+00'),
  probe.bust(:'t', :'tb', '40000000-0000-4000-8000-000000000014', 1100032, 100, '2026-09-10 11:00:00+00');
SELECT probe.rebuy_leg(:'t', '40000000-0000-4000-8000-000000000014', '2026-09-10 10:00:05+00', 'rebuy', 'reversed');
-- 5. somebody else's rebuy
SELECT probe.player(:'t', '40000000-0000-4000-8000-000000000015');
INSERT INTO unproven SELECT '40000000-0000-4000-8000-000000000015', 'another player''s leg',
  probe.bust(:'t', :'tb', '40000000-0000-4000-8000-000000000015', 1100041, 100, '2026-09-10 10:00:00+00'),
  probe.bust(:'t', :'tb', '40000000-0000-4000-8000-000000000015', 1100042, 100, '2026-09-10 11:00:00+00');
SELECT probe.rebuy_leg(:'t', '40000000-0000-4000-8000-0000000000ff', '2026-09-10 10:00:05+00');
-- 6. a rebuy into a different event
SELECT probe.player(:'t', '40000000-0000-4000-8000-000000000016');
INSERT INTO unproven SELECT '40000000-0000-4000-8000-000000000016', 'a leg into another event',
  probe.bust(:'t', :'tb', '40000000-0000-4000-8000-000000000016', 1100051, 100, '2026-09-10 10:00:00+00'),
  probe.bust(:'t', :'tb', '40000000-0000-4000-8000-000000000016', 1100052, 100, '2026-09-10 11:00:00+00');
SELECT probe.rebuy_leg(:'other', '40000000-0000-4000-8000-000000000016', '2026-09-10 10:00:05+00');
-- 7. only a PENDING generation can be proven bought back; an eliminated one is not touched
SELECT probe.player(:'t', '40000000-0000-4000-8000-000000000017');
INSERT INTO unproven SELECT '40000000-0000-4000-8000-000000000017', 'an older eliminated generation',
  probe.bust(:'t', :'tb', '40000000-0000-4000-8000-000000000017', 1100061, 100, '2026-09-10 10:00:00+00', 'eliminated'),
  probe.bust(:'t', :'tb', '40000000-0000-4000-8000-000000000017', 1100062, 100, '2026-09-10 11:00:00+00');
SELECT probe.rebuy_leg(:'t', '40000000-0000-4000-8000-000000000017', '2026-09-10 10:00:05+00');

DO $check$
DECLARE u record; v_result jsonb; v_place integer := 20;
BEGIN
  FOR u IN SELECT * FROM unproven ORDER BY user_id LOOP
    v_result := probe.door('40000000-0000-4000-8000-000000000001', u.user_id, v_place);
    v_place := v_place - 1;
    PERFORM probe.check(v_result->>'reason' = 'unresolved_knockout_generation_chain',
                        u.why || ': the newer bust is still refused, got ' || v_result);
    PERFORM probe.check(probe.state(u.newer) = 'pending' AND
                        probe.state(u.older) IN ('pending', 'eliminated'),
                        u.why || ': no generation changed');
    PERFORM probe.check((SELECT status = 'playing' AND position IS NULL AND eliminated_at IS NULL
                           FROM public.tournament_players
                          WHERE tournament_id = '40000000-0000-4000-8000-000000000001'
                            AND user_id = u.user_id), u.why || ': the roster row is untouched');
  END LOOP;
END;
$check$;
