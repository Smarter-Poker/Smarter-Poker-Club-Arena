-- P14.2 accepted-roster cash fixture. Loaded after the hand-submission
-- opening inside one transaction that is always rolled back. Synthetic rows
-- only; every new row is cloned from the maintained structural opening.
--
-- Seven exact seat generations at one cash table:
--   1 10000000-...-0001 human, contributes 10
--   2 10000000-...-0002 horse, contributes 10 and wins 21
--   3 88200000-...-0003 silent horse: dealt, no action, contributes 0
--   4 88200000-...-0004 post-only horse: posts 1 and folds
--   5 88200000-...-0005 profile with is_horse NULL
--   6 88200000-...-0006 human (table_seats.user_id references profiles, so a
--     seated player always has a profile; profile_missing is proved on the
--     builder in the native cases)
--   7 88200000-...-0007 human whose seat lawfully left during the hand
SET LOCAL session_replication_role = replica;
INSERT INTO auth.users(id)
SELECT v.id FROM (VALUES ('88200000-0000-0000-0000-000000000003'::uuid), ('88200000-0000-0000-0000-000000000004'::uuid),
  ('88200000-0000-0000-0000-000000000005'::uuid), ('88200000-0000-0000-0000-000000000006'::uuid),
  ('88200000-0000-0000-0000-000000000007'::uuid)) v(id);
INSERT INTO public.users(id, username)
SELECT v.id, 'roster_probe_user_' || right(v.id::text, 1) FROM (VALUES ('88200000-0000-0000-0000-000000000003'::uuid),
  ('88200000-0000-0000-0000-000000000004'::uuid), ('88200000-0000-0000-0000-000000000005'::uuid),
  ('88200000-0000-0000-0000-000000000006'::uuid), ('88200000-0000-0000-0000-000000000007'::uuid)) v(id);
UPDATE public.profiles SET is_horse = false WHERE id = '10000000-0000-0000-0000-000000000001';
UPDATE public.profiles SET is_horse = true WHERE id = '10000000-0000-0000-0000-000000000002';
INSERT INTO public.profiles
SELECT (jsonb_populate_record(NULL::public.profiles, to_jsonb(p) || jsonb_build_object(
  'id', v.id, 'username', 'roster_probe_' || v.n, 'display_name', 'Roster Probe ' || v.n,
  'is_horse', v.horse))).*
  FROM public.profiles p
  CROSS JOIN (VALUES
    ('88200000-0000-0000-0000-000000000003'::uuid, 3, true),
    ('88200000-0000-0000-0000-000000000004'::uuid, 4, true),
    ('88200000-0000-0000-0000-000000000005'::uuid, 5, NULL::boolean),
    ('88200000-0000-0000-0000-000000000006'::uuid, 6, false),
    ('88200000-0000-0000-0000-000000000007'::uuid, 7, false)) v(id, n, horse)
 WHERE p.id = '10000000-0000-0000-0000-000000000001';
INSERT INTO public.club_members
SELECT (jsonb_populate_record(NULL::public.club_members, to_jsonb(m) || jsonb_build_object(
  'user_id', v.id) || CASE WHEN to_jsonb(m) ? 'id' THEN jsonb_build_object('id', gen_random_uuid()) ELSE '{}'::jsonb END)).*
  FROM public.club_members m
  CROSS JOIN (VALUES
    ('88200000-0000-0000-0000-000000000003'::uuid), ('88200000-0000-0000-0000-000000000004'::uuid),
    ('88200000-0000-0000-0000-000000000005'::uuid), ('88200000-0000-0000-0000-000000000006'::uuid),
    ('88200000-0000-0000-0000-000000000007'::uuid)) v(id)
 WHERE m.club_id = '20000000-0000-0000-0000-000000000001'
   AND m.user_id = '10000000-0000-0000-0000-000000000002';
INSERT INTO public.cash_games(id, club_id, name, template_name, variant, sb, bb, handedness, ruleset_snapshot)
VALUES ('88900000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001',
        'Roster Probe Cash', 'classic', 'nlh', 1, 2, 9, '{}');
INSERT INTO public.tables(id, name, tournament_id, game_type, game_variant, status, lifecycle, club_id,
  small_blind, big_blind, cluster_id, seat_game_scope, seat_admission_key, max_players)
VALUES ('88100000-0000-0000-0000-000000000001', 'Roster probe cash', NULL, 'cash', 'nlh', 'running', 'live',
  '20000000-0000-0000-0000-000000000001', 1, 2, '88900000-0000-0000-0000-000000000001',
  'cluster:88900000-0000-0000-0000-000000000001', 'cash', 9);
INSERT INTO public.table_seats
SELECT (jsonb_populate_record(NULL::public.table_seats, to_jsonb(t) || jsonb_build_object(
  'id', v.seat_id, 'occupancy_id', gen_random_uuid(), 'table_id', '88100000-0000-0000-0000-000000000001',
  'user_id', v.user_id, 'seat_number', v.seat, 'stack', v.stack, 'joined_at', v.joined,
  'left_at', v.left_at, 'status', CASE WHEN v.left_at IS NULL THEN 'active' ELSE 'left' END,
  'horse_id', NULL, 'time_bank_uses_remaining', 4, 'time_bank_remaining', 30,
  'active_game_scope', CASE WHEN v.left_at IS NULL THEN 'cluster:88900000-0000-0000-0000-000000000001' END,
  'active_parent_key', CASE WHEN v.left_at IS NULL THEN 'cash' END))).*
  FROM public.table_seats t
  CROSS JOIN (VALUES
    ('88300000-0000-0000-0000-000000000001'::uuid, '10000000-0000-0000-0000-000000000001'::uuid, 1, 100, '2026-10-06 10:00:01.123456+00'::timestamptz, NULL::timestamptz),
    ('88300000-0000-0000-0000-000000000002'::uuid, '10000000-0000-0000-0000-000000000002'::uuid, 2, 100, '2026-10-06 10:00:02+00'::timestamptz, NULL::timestamptz),
    ('88300000-0000-0000-0000-000000000003'::uuid, '88200000-0000-0000-0000-000000000003'::uuid, 3, 100, '2026-10-06 10:00:03+00'::timestamptz, NULL::timestamptz),
    ('88300000-0000-0000-0000-000000000004'::uuid, '88200000-0000-0000-0000-000000000004'::uuid, 4, 100, '2026-10-06 10:00:04+00'::timestamptz, NULL::timestamptz),
    ('88300000-0000-0000-0000-000000000005'::uuid, '88200000-0000-0000-0000-000000000005'::uuid, 5, 100, '2026-10-06 10:00:05+00'::timestamptz, NULL::timestamptz),
    ('88300000-0000-0000-0000-000000000006'::uuid, '88200000-0000-0000-0000-000000000006'::uuid, 6, 100, '2026-10-06 10:00:06+00'::timestamptz, NULL::timestamptz),
    ('88300000-0000-0000-0000-000000000007'::uuid, '88200000-0000-0000-0000-000000000007'::uuid, 7, 50, '2026-10-06 10:00:07+00'::timestamptz, '2026-10-06 11:00:00+00'::timestamptz)
  ) v(seat_id, user_id, seat, stack, joined, left_at)
 WHERE t.id = '86300000-0000-0000-0000-000000000001';
SET LOCAL session_replication_role = origin;
INSERT INTO public.engine_table_leases(table_id, instance_id, lease_generation, protocol_version, heartbeat_at)
VALUES ('88100000-0000-0000-0000-000000000001', 'roster-probe', '88500000-0000-0000-0000-000000000001', 2, clock_timestamp());

-- The exact accepted roster of one cash hand. p_variant selects a request
-- shape: 'exact' (the engine's protocol-2 roster) or 'legacy' (no seat ids).
-- A legacy (protocol-1) roster cannot name a departed seat, so 'legacy'
-- leaves seat 7 out of the hand entirely.
CREATE FUNCTION pg_temp.roster_seats(p_variant text DEFAULT 'exact') RETURNS TABLE(user_id text, seat_id text, joined text,
  before numeric, after numeric, contributed numeric, uses integer, secs integer)
LANGUAGE sql IMMUTABLE AS $$
  SELECT * FROM (VALUES
   ('10000000-0000-0000-0000-000000000001','88300000-0000-0000-0000-000000000001','2026-10-06T10:00:01.123456+00:00',100::numeric, 90::numeric,10::numeric,3,17),
   ('10000000-0000-0000-0000-000000000002','88300000-0000-0000-0000-000000000002','2026-10-06T10:00:02+00:00',100,111,10,2,19),
   ('88200000-0000-0000-0000-000000000003','88300000-0000-0000-0000-000000000003','2026-10-06T10:00:03+00:00',100,100,0,4,30),
   ('88200000-0000-0000-0000-000000000004','88300000-0000-0000-0000-000000000004','2026-10-06T10:00:04+00:00',100, 99,1,4,30),
   ('88200000-0000-0000-0000-000000000005','88300000-0000-0000-0000-000000000005','2026-10-06T10:00:05+00:00',100,100,0,4,30),
   ('88200000-0000-0000-0000-000000000006','88300000-0000-0000-0000-000000000006','2026-10-06T10:00:06+00:00',100,100,0,4,30),
   ('88200000-0000-0000-0000-000000000007','88300000-0000-0000-0000-000000000007','2026-10-06T10:00:07+00:00', 50, 50,0,1,5)
  ) v(user_id, seat_id, joined, before, after, contributed, uses, secs)
  WHERE p_variant <> 'legacy' OR v.user_id <> '88200000-0000-0000-0000-000000000007'
$$;
CREATE FUNCTION pg_temp.roster_stacks(p_variant text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_agg(CASE WHEN p_variant = 'legacy' THEN '{}'::jsonb
                        ELSE jsonb_build_object('seat_id', s.seat_id, 'seat_joined_at', s.joined) END
                   || jsonb_build_object('user_id', s.user_id, 'stack_before', s.before, 'stack', s.after)
                   ORDER BY s.user_id)
    FROM pg_temp.roster_seats(p_variant) s;
$$;
CREATE FUNCTION pg_temp.roster_row(p_hand bigint, p_id uuid, p_variant text DEFAULT 'exact') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'id', p_id, 'table_id', '88100000-0000-0000-0000-000000000001', 'tournament_id', NULL,
    'hand_number', p_hand, 'game_variant', 'nlh', 'small_blind', 1, 'big_blind', 2,
    'pot_size', 21, 'rake_amount', 0, 'bbj_amount', 0,
    'players', (SELECT jsonb_agg(jsonb_build_object('user_id', s.user_id, 'stack', s.after) ORDER BY s.user_id)
                  FROM pg_temp.roster_seats(p_variant) s),
    -- The action log names two players only: the silent and post-only horses
    -- and the others appear nowhere in it.
    'actions', jsonb_build_array(
      jsonb_build_object('userId', '10000000-0000-0000-0000-000000000001', 'action', 'bet', 'amount', 10),
      jsonb_build_object('userId', '10000000-0000-0000-0000-000000000002', 'action', 'call', 'amount', 10)),
    'winners', jsonb_build_array(jsonb_build_object('user_id', '10000000-0000-0000-0000-000000000002', 'amount', 21)),
    '_accepted_post_commit_facts', jsonb_build_object(
      'contributions', (SELECT jsonb_object_agg(s.user_id, s.contributed) FROM pg_temp.roster_seats(p_variant) s),
      'returned_uncalled', '{}'::jsonb, 'insurance', '[]'::jsonb));
$$;
CREATE FUNCTION pg_temp.roster_obligations(p_variant text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'version', '1',
    'time_banks', (SELECT jsonb_agg(CASE WHEN p_variant = 'legacy' THEN '{}'::jsonb
                        ELSE jsonb_build_object('seat_id', s.seat_id, 'seat_joined_at', s.joined) END
                     || jsonb_build_object('user_id', s.user_id, 'uses_remaining', s.uses, 'seconds_remaining', s.secs)
                     ORDER BY s.user_id) FROM pg_temp.roster_seats(p_variant) s),
    'promo_playthrough', (SELECT jsonb_agg(jsonb_build_object('club_id', '20000000-0000-0000-0000-000000000001',
                            'user_id', s.user_id, 'wagered', s.contributed) ORDER BY s.user_id)
                            FROM pg_temp.roster_seats(p_variant) s WHERE s.contributed > 0),
    'insurance', '[]'::jsonb,
    'pending_addons', jsonb_build_object('enabled', true, 'max_buy_in', 200),
    'rake', 'null'::jsonb,
    'bbj_contribution', 'null'::jsonb);
$$;
CREATE FUNCTION pg_temp.roster_commit(p_hand bigint, p_id uuid, p_variant text DEFAULT 'exact',
  p_obligations jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE sql SET search_path TO 'public','pg_temp' AS $$
  SELECT public.fn_ca_commit_hand_settlement('88100000-0000-0000-0000-000000000001', p_hand,
    pg_temp.roster_stacks(p_variant), 0, 0, 'roster-probe', 0, pg_temp.roster_row(p_hand, p_id, p_variant), '[]'::jsonb,
    'roster-probe', '88500000-0000-0000-0000-000000000001',
    COALESCE(p_obligations, pg_temp.roster_obligations(p_variant)));
$$;
-- Everything money-bearing that one accepted cash hand touches, with
-- generated identities and wall-clock instants left out.
CREATE FUNCTION pg_temp.roster_money_state(p_hand bigint, p_result jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'seats', (SELECT jsonb_agg(jsonb_build_array(s.id, s.user_id, s.stack, s.left_at,
                s.time_bank_uses_remaining, s.time_bank_remaining) ORDER BY s.id)
                FROM public.table_seats s WHERE s.table_id = '88100000-0000-0000-0000-000000000001'),
    'wallets', (SELECT jsonb_agg(jsonb_build_array(m.user_id, m.chip_balance) ORDER BY m.user_id)
                  FROM public.club_members m WHERE m.club_id = '20000000-0000-0000-0000-000000000001'),
    'receipt', (SELECT jsonb_build_object('payload_hash', a.payload_hash, 'payload', a.post_commit_payload,
                  'request_hash', a.post_commit_request_hash, 'payload_digest', a.post_commit_payload_hash,
                  'stack_result', a.stack_result - 'ca_settlement_id' - 'settlement_id')
                  FROM public.hand_atomic_commits a
                 WHERE a.table_id = '88100000-0000-0000-0000-000000000001' AND a.hand_number = p_hand),
    'settlement_totals', (SELECT jsonb_agg(c.totals ORDER BY c.totals::text) FROM public.ca_settlements c
                           WHERE c.table_id = '88100000-0000-0000-0000-000000000001'),
    'table_players', (SELECT current_players FROM public.tables WHERE id = '88100000-0000-0000-0000-000000000001'),
    'result', p_result - 'accepted_roster' - 'commit_id' - 'committed_at');
$$;
