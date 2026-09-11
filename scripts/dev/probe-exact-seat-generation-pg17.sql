\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION pg_temp.probe_exact_commit(
  p_table_id uuid,
  p_hand_number bigint,
  p_stacks jsonb,
  p_time_banks jsonb
) RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  v_club_id uuid;
  v_contributions jsonb;
  v_promos jsonb;
  v_hand_row jsonb;
  v_obligations jsonb;
BEGIN
  SELECT t.club_id INTO STRICT v_club_id
    FROM public.tables t
   WHERE t.id = p_table_id;

  SELECT jsonb_object_agg(x->>'user_id', 10)
    INTO v_contributions
    FROM jsonb_array_elements(p_stacks) x;
  SELECT jsonb_agg(
           jsonb_build_object(
             'club_id', v_club_id,
             'user_id', x->>'user_id',
             'wagered', 10
           )
           ORDER BY x->>'user_id'
         )
    INTO v_promos
    FROM jsonb_array_elements(p_stacks) x;

  v_hand_row := jsonb_build_object(
    'pot_size', 20,
    'big_blind', 2,
    '_accepted_post_commit_facts', jsonb_build_object(
      'contributions', v_contributions,
      'returned_uncalled', '{}'::jsonb,
      'insurance', '[]'::jsonb
    )
  );
  v_obligations := jsonb_build_object(
    'version', 1,
    'time_banks', p_time_banks,
    'rake', NULL,
    'bbj_contribution', NULL,
    'promo_playthrough', v_promos,
    'insurance', '[]'::jsonb,
    'pending_addons', jsonb_build_object(
      'enabled', true,
      'max_buy_in', 1000
    )
  );

  RETURN public.fn_ca_commit_hand_settlement(
    p_table_id,
    p_hand_number,
    p_stacks,
    0,
    0,
    'pg17-exact-seat:' || p_hand_number::text,
    0,
    v_hand_row,
    '[]'::jsonb,
    'pg17-exact-seat',
    'd0000000-0000-4000-8000-000000000001',
    v_obligations
  );
END;
$function$;

INSERT INTO public.clubs(id, union_id)
VALUES ('c0000000-0000-4000-8000-000000000001', NULL);

INSERT INTO public.tournaments(id, starting_chips, rebuy_chips, addon_chips)
VALUES ('e0000000-0000-4000-8000-000000000001', 1000, 1000, 1000);

INSERT INTO public.tables(id, club_id, tournament_id, status)
VALUES
  (
    'a0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    NULL,
    'running'
  ),
  (
    'a0000000-0000-4000-8000-000000000002',
    'c0000000-0000-4000-8000-000000000001',
    NULL,
    'running'
  ),
  (
    'a0000000-0000-4000-8000-000000000003',
    'c0000000-0000-4000-8000-000000000001',
    'e0000000-0000-4000-8000-000000000001',
    'running'
  );

INSERT INTO public.engine_table_leases(
  table_id, instance_id, lease_generation, protocol_version, heartbeat_at
)
SELECT
  t.id,
  'pg17-exact-seat',
  'd0000000-0000-4000-8000-000000000001',
  2,
  clock_timestamp()
FROM public.tables t;

INSERT INTO public.club_members(user_id, club_id, chip_balance, updated_at)
VALUES
  (
    '10000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    1000,
    clock_timestamp()
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    'c0000000-0000-4000-8000-000000000001',
    1000,
    clock_timestamp()
  ),
  (
    '10000000-0000-4000-8000-000000000003',
    'c0000000-0000-4000-8000-000000000001',
    1000,
    clock_timestamp()
  ),
  (
    '10000000-0000-4000-8000-000000000004',
    'c0000000-0000-4000-8000-000000000001',
    1000,
    clock_timestamp()
  ),
  (
    '10000000-0000-4000-8000-000000000005',
    'c0000000-0000-4000-8000-000000000001',
    1000,
    clock_timestamp()
  ),
  (
    '10000000-0000-4000-8000-000000000006',
    'c0000000-0000-4000-8000-000000000001',
    1000,
    clock_timestamp()
  );

/* Different-chair rejoin. The first row is the generation which was dealt;
   the second is the same player's later active seat. */
INSERT INTO public.table_seats(
  id, table_id, user_id, seat_number, stack, left_at, joined_at, club_id,
  time_bank_uses_remaining, time_bank_remaining
)
VALUES
  (
    '51000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    1,
    100,
    '2026-09-08T10:04:00Z',
    '2026-09-08T10:00:00Z',
    'c0000000-0000-4000-8000-000000000001',
    9,
    99
  ),
  (
    '51000000-0000-4000-8000-000000000002',
    'a0000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    3,
    500,
    NULL,
    '2026-09-08T10:05:00Z',
    'c0000000-0000-4000-8000-000000000001',
    9,
    99
  ),
  (
    '51000000-0000-4000-8000-000000000003',
    'a0000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    2,
    100,
    NULL,
    '2026-09-08T10:00:00Z',
    'c0000000-0000-4000-8000-000000000001',
    9,
    99
  );

/* Same-chair reuse. The row id survived, but joined_at now names the later
   generation. The original generation no longer exists. */
INSERT INTO public.table_seats(
  id, table_id, user_id, seat_number, stack, left_at, joined_at, club_id,
  time_bank_uses_remaining, time_bank_remaining
)
VALUES
  (
    '51000000-0000-4000-8000-000000000004',
    'a0000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000003',
    1,
    500,
    NULL,
    '2026-09-08T10:05:00Z',
    'c0000000-0000-4000-8000-000000000001',
    9,
    99
  ),
  (
    '51000000-0000-4000-8000-000000000005',
    'a0000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000004',
    2,
    100,
    NULL,
    '2026-09-08T10:00:00Z',
    'c0000000-0000-4000-8000-000000000001',
    9,
    99
  );

/* Tournament departure plus a later different-chair rejoin. Tournament chips
   never settle against the club wallet, even when the old generation is exact. */
INSERT INTO public.table_seats(
  id, table_id, user_id, seat_number, stack, left_at, joined_at, club_id,
  time_bank_uses_remaining, time_bank_remaining
)
VALUES
  (
    '51000000-0000-4000-8000-000000000006',
    'a0000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000005',
    1,
    100,
    '2026-09-08T10:04:00Z',
    '2026-09-08T10:00:00Z',
    'c0000000-0000-4000-8000-000000000001',
    9,
    99
  ),
  (
    '51000000-0000-4000-8000-000000000007',
    'a0000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000005',
    3,
    500,
    NULL,
    '2026-09-08T10:05:00Z',
    'c0000000-0000-4000-8000-000000000001',
    9,
    99
  ),
  (
    '51000000-0000-4000-8000-000000000008',
    'a0000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000006',
    2,
    100,
    NULL,
    '2026-09-08T10:00:00Z',
    'c0000000-0000-4000-8000-000000000001',
    9,
    99
  );

DO $different_chair_stack_targets_dealt_generation$
DECLARE
  v_stacks jsonb := jsonb_build_array(
    jsonb_build_object(
      'user_id', '10000000-0000-4000-8000-000000000001',
      'seat_id', '51000000-0000-4000-8000-000000000001',
      'seat_joined_at', '2026-09-08T10:00:00Z',
      'stack_before', 100,
      'stack', 90
    ),
    jsonb_build_object(
      'user_id', '10000000-0000-4000-8000-000000000002',
      'seat_id', '51000000-0000-4000-8000-000000000003',
      'seat_joined_at', '2026-09-08T05:00:00-05:00',
      'stack_before', 100,
      'stack', 110
    )
  );
  v_reversed jsonb;
  v_first jsonb;
  v_replay jsonb;
  v_before_replay jsonb;
  v_after_replay jsonb;
  v_conflict_caught boolean := false;
BEGIN
  v_first := public.fn_ca_settle_hand_stacks_absolute(
    'a0000000-0000-4000-8000-000000000001',
    1000001,
    v_stacks,
    0,
    0,
    'pg17:different-chair',
    0
  );
  IF COALESCE((v_first->>'success')::boolean, false) IS NOT TRUE
     OR (SELECT stack FROM public.table_seats
          WHERE id = '51000000-0000-4000-8000-000000000001')
          IS DISTINCT FROM 100::numeric
     OR (SELECT stack FROM public.table_seats
          WHERE id = '51000000-0000-4000-8000-000000000002')
          IS DISTINCT FROM 500::numeric
     OR (SELECT stack FROM public.table_seats
          WHERE id = '51000000-0000-4000-8000-000000000003')
          IS DISTINCT FROM 110::numeric
     OR (SELECT chip_balance FROM public.club_members
          WHERE user_id = '10000000-0000-4000-8000-000000000001')
          IS DISTINCT FROM 990::numeric
     OR (SELECT chip_balance FROM public.club_members
          WHERE user_id = '10000000-0000-4000-8000-000000000002')
          IS DISTINCT FROM 1000::numeric
     OR (SELECT count(*) FROM public.chip_transactions
          WHERE table_id = 'a0000000-0000-4000-8000-000000000001'
            AND to_user_id = '10000000-0000-4000-8000-000000000001'
            AND transaction_type = 'late_seat_debit'
            AND amount = 10) <> 1
     OR v_first->'departed'->0->>'seat_id'
          IS DISTINCT FROM '51000000-0000-4000-8000-000000000001' THEN
    RAISE EXCEPTION 'different-chair exact stack settlement failed: %', v_first;
  END IF;

  SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id)
    INTO v_before_replay
    FROM public.table_seats s
   WHERE s.table_id = 'a0000000-0000-4000-8000-000000000001';
  SELECT jsonb_agg(value ORDER BY value->>'user_id' DESC)
    INTO v_reversed
    FROM jsonb_array_elements(v_stacks);
  v_replay := public.fn_ca_settle_hand_stacks_absolute(
    'a0000000-0000-4000-8000-000000000001',
    1000001,
    v_reversed,
    0,
    0,
    'pg17:different-chair',
    0
  );
  SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id)
    INTO v_after_replay
    FROM public.table_seats s
   WHERE s.table_id = 'a0000000-0000-4000-8000-000000000001';
  IF COALESCE((v_replay->>'replay')::boolean, false) IS NOT TRUE
     OR v_after_replay IS DISTINCT FROM v_before_replay
     OR (SELECT count(*) FROM public.chip_transactions
          WHERE table_id = 'a0000000-0000-4000-8000-000000000001') <> 1 THEN
    RAISE EXCEPTION 'exact-generation replay was not idempotent: %', v_replay;
  END IF;

  BEGIN
    PERFORM public.fn_ca_settle_hand_stacks_absolute(
      'a0000000-0000-4000-8000-000000000001',
      1000001,
      jsonb_set(v_stacks, '{0,seat_joined_at}', '"2026-09-08T10:00:01Z"'),
      0,
      0,
      'pg17:different-chair',
      0
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    v_conflict_caught := true;
  END;
  IF NOT v_conflict_caught THEN
    RAISE EXCEPTION 'changed seat generation reused an existing hand receipt';
  END IF;
END;
$different_chair_stack_targets_dealt_generation$;

DO $different_chair_time_bank_targets_dealt_generation$
DECLARE
  v_stacks jsonb := jsonb_build_array(
    jsonb_build_object(
      'user_id', '10000000-0000-4000-8000-000000000001',
      'seat_id', '51000000-0000-4000-8000-000000000001',
      'seat_joined_at', '2026-09-08T10:00:00Z',
      'stack_before', 100,
      'stack', 100
    ),
    jsonb_build_object(
      'user_id', '10000000-0000-4000-8000-000000000002',
      'seat_id', '51000000-0000-4000-8000-000000000003',
      'seat_joined_at', '2026-09-08T10:00:00Z',
      'stack_before', 110,
      'stack', 110
    )
  );
  v_time_banks jsonb := jsonb_build_array(
    jsonb_build_object(
      'user_id', '10000000-0000-4000-8000-000000000001',
      'seat_id', '51000000-0000-4000-8000-000000000001',
      'seat_joined_at', '2026-09-08T05:00:00-05:00',
      'uses_remaining', 1,
      'seconds_remaining', 25
    ),
    jsonb_build_object(
      'user_id', '10000000-0000-4000-8000-000000000002',
      'seat_id', '51000000-0000-4000-8000-000000000003',
      'seat_joined_at', '2026-09-08T10:00:00Z',
      'uses_remaining', 2,
      'seconds_remaining', 30
    )
  );
  v_receipt jsonb;
BEGIN
  v_receipt := pg_temp.probe_exact_commit(
    'a0000000-0000-4000-8000-000000000001',
    2000001,
    v_stacks,
    v_time_banks
  );
  IF COALESCE((v_receipt->>'post_commit_obligations')::boolean, false) IS NOT TRUE
     OR (SELECT time_bank_uses_remaining FROM public.table_seats
          WHERE id = '51000000-0000-4000-8000-000000000001') <> 1
     OR (SELECT time_bank_remaining FROM public.table_seats
          WHERE id = '51000000-0000-4000-8000-000000000001') <> 25
     OR (SELECT time_bank_uses_remaining FROM public.table_seats
          WHERE id = '51000000-0000-4000-8000-000000000002') <> 9
     OR (SELECT time_bank_remaining FROM public.table_seats
          WHERE id = '51000000-0000-4000-8000-000000000002') <> 99
     OR (SELECT time_bank_uses_remaining FROM public.table_seats
          WHERE id = '51000000-0000-4000-8000-000000000003') <> 2
     OR (SELECT time_bank_remaining FROM public.table_seats
          WHERE id = '51000000-0000-4000-8000-000000000003') <> 30
     OR NOT EXISTS (
       SELECT 1
         FROM public.hand_atomic_commits c,
              jsonb_array_elements(c.post_commit_payload->'time_banks') x
        WHERE c.table_id = 'a0000000-0000-4000-8000-000000000001'
          AND c.hand_number = 2000001
          AND x->>'seat_id' = '51000000-0000-4000-8000-000000000001'
     ) THEN
    RAISE EXCEPTION 'different-chair exact time-bank write failed: %', v_receipt;
  END IF;
END;
$different_chair_time_bank_targets_dealt_generation$;

DO $same_chair_reuse_fails_closed$
DECLARE
  v_stacks jsonb := jsonb_build_array(
    jsonb_build_object(
      'user_id', '10000000-0000-4000-8000-000000000003',
      'seat_id', '51000000-0000-4000-8000-000000000004',
      'seat_joined_at', '2026-09-08T10:00:00Z',
      'stack_before', 100,
      'stack', 90
    ),
    jsonb_build_object(
      'user_id', '10000000-0000-4000-8000-000000000004',
      'seat_id', '51000000-0000-4000-8000-000000000005',
      'seat_joined_at', '2026-09-08T10:00:00Z',
      'stack_before', 100,
      'stack', 110
    )
  );
  v_time_banks jsonb := jsonb_build_array(
    jsonb_build_object(
      'user_id', '10000000-0000-4000-8000-000000000003',
      'seat_id', '51000000-0000-4000-8000-000000000004',
      'seat_joined_at', '2026-09-08T10:00:00Z',
      'uses_remaining', 1,
      'seconds_remaining', 25
    ),
    jsonb_build_object(
      'user_id', '10000000-0000-4000-8000-000000000004',
      'seat_id', '51000000-0000-4000-8000-000000000005',
      'seat_joined_at', '2026-09-08T10:00:00Z',
      'uses_remaining', 2,
      'seconds_remaining', 30
    )
  );
  v_receipt jsonb;
  v_outer_refused boolean := false;
BEGIN
  v_receipt := public.fn_ca_settle_hand_stacks_absolute(
    'a0000000-0000-4000-8000-000000000002',
    1000002,
    v_stacks,
    0,
    0,
    'pg17:same-chair',
    0
  );
  IF COALESCE((v_receipt->>'success')::boolean, true) IS NOT FALSE
     OR v_receipt->>'reason' IS DISTINCT FROM 'rolled_back'
     OR v_receipt->>'error' NOT LIKE '%exact seat generation missing or replaced%'
     OR (SELECT stack FROM public.table_seats
          WHERE id = '51000000-0000-4000-8000-000000000004') <> 500
     OR (SELECT stack FROM public.table_seats
          WHERE id = '51000000-0000-4000-8000-000000000005') <> 100
     OR EXISTS (
       SELECT 1 FROM public.chip_transactions
        WHERE table_id = 'a0000000-0000-4000-8000-000000000002'
     )
     OR EXISTS (
       SELECT 1 FROM public.club_members
        WHERE user_id IN (
          '10000000-0000-4000-8000-000000000003',
          '10000000-0000-4000-8000-000000000004'
        )
          AND chip_balance <> 1000
     ) THEN
    RAISE EXCEPTION 'same-chair stack reuse did not fail closed: %', v_receipt;
  END IF;

  BEGIN
    PERFORM pg_temp.probe_exact_commit(
      'a0000000-0000-4000-8000-000000000002',
      2000002,
      v_stacks,
      v_time_banks
    );
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%time_bank_seat_mismatch%' THEN
      v_outer_refused := true;
    ELSE
      RAISE;
    END IF;
  END;
  IF NOT v_outer_refused
     OR EXISTS (
       SELECT 1 FROM public.hand_atomic_commits
        WHERE table_id = 'a0000000-0000-4000-8000-000000000002'
          AND hand_number = 2000002
     )
     OR EXISTS (
       SELECT 1 FROM public.table_seats
        WHERE table_id = 'a0000000-0000-4000-8000-000000000002'
          AND (
            time_bank_uses_remaining <> 9
            OR time_bank_remaining <> 99
          )
     ) THEN
    RAISE EXCEPTION 'same-chair time-bank reuse was not rolled back whole';
  END IF;
END;
$same_chair_reuse_fails_closed$;

DO $departed_tournament_generation_fails_closed$
DECLARE
  v_receipt jsonb;
BEGIN
  v_receipt := public.fn_ca_settle_hand_stacks_absolute(
    'a0000000-0000-4000-8000-000000000003',
    1000005,
    jsonb_build_array(
      jsonb_build_object(
        'user_id', '10000000-0000-4000-8000-000000000005',
        'seat_id', '51000000-0000-4000-8000-000000000006',
        'seat_joined_at', '2026-09-08T10:00:00Z',
        'stack_before', 100,
        'stack', 90
      ),
      jsonb_build_object(
        'user_id', '10000000-0000-4000-8000-000000000006',
        'seat_id', '51000000-0000-4000-8000-000000000008',
        'seat_joined_at', '2026-09-08T10:00:00Z',
        'stack_before', 100,
        'stack', 110
      )
    ),
    0,
    0,
    'pg17:departed-tournament',
    0
  );

  IF COALESCE((v_receipt->>'success')::boolean, true) IS NOT FALSE
     OR v_receipt->>'reason' IS DISTINCT FROM 'rolled_back'
     OR v_receipt->>'error' NOT LIKE '%seat missing or left%'
     OR (SELECT stack FROM public.table_seats
          WHERE id = '51000000-0000-4000-8000-000000000006') <> 100
     OR (SELECT stack FROM public.table_seats
          WHERE id = '51000000-0000-4000-8000-000000000007') <> 500
     OR (SELECT stack FROM public.table_seats
          WHERE id = '51000000-0000-4000-8000-000000000008') <> 100
     OR EXISTS (
       SELECT 1 FROM public.club_members
        WHERE user_id IN (
          '10000000-0000-4000-8000-000000000005',
          '10000000-0000-4000-8000-000000000006'
        )
          AND chip_balance <> 1000
     )
     OR EXISTS (
       SELECT 1 FROM public.chip_transactions
        WHERE table_id = 'a0000000-0000-4000-8000-000000000003'
     ) THEN
    RAISE EXCEPTION
      'departed exact tournament generation did not fail closed: %',
      v_receipt;
  END IF;
END;
$departed_tournament_generation_fails_closed$;

DO $protocol_shapes_and_cross_narrative_pairs_are_refused$
DECLARE
  v_one_sided_caught boolean := false;
  v_malformed_joined_at_caught boolean := false;
  v_mixed_protocol_caught boolean := false;
  v_pair_mismatch_caught boolean := false;
  v_current_stacks jsonb := jsonb_build_array(
    jsonb_build_object(
      'user_id', '10000000-0000-4000-8000-000000000003',
      'seat_id', '51000000-0000-4000-8000-000000000004',
      'seat_joined_at', '2026-09-08T10:05:00Z',
      'stack_before', 500,
      'stack', 500
    ),
    jsonb_build_object(
      'user_id', '10000000-0000-4000-8000-000000000004',
      'seat_id', '51000000-0000-4000-8000-000000000005',
      'seat_joined_at', '2026-09-08T10:00:00Z',
      'stack_before', 100,
      'stack', 100
    )
  );
BEGIN
  BEGIN
    PERFORM public.fn_ca_settle_hand_stacks_absolute(
      'a0000000-0000-4000-8000-000000000002',
      1000003,
      jsonb_build_array(
        jsonb_build_object(
          'user_id', '10000000-0000-4000-8000-000000000003',
          'seat_id', '51000000-0000-4000-8000-000000000004',
          'stack_before', 500,
          'stack', 500
        ),
        jsonb_build_object(
          'user_id', '10000000-0000-4000-8000-000000000004',
          'stack_before', 100,
          'stack', 100
        )
      ),
      0,
      0,
      'pg17:one-sided',
      0
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    v_one_sided_caught := true;
  END;
  IF NOT v_one_sided_caught THEN
    RAISE EXCEPTION 'one-sided exact stack generation was accepted';
  END IF;

  BEGIN
    PERFORM public.fn_ca_settle_hand_stacks_absolute(
      'a0000000-0000-4000-8000-000000000002',
      1000006,
      jsonb_build_array(
        jsonb_build_object(
          'user_id', '10000000-0000-4000-8000-000000000003',
          'seat_id', '51000000-0000-4000-8000-000000000004',
          'seat_joined_at', 'definitely-not-a-timestamp',
          'stack_before', 500,
          'stack', 500
        ),
        jsonb_build_object(
          'user_id', '10000000-0000-4000-8000-000000000004',
          'seat_id', '51000000-0000-4000-8000-000000000005',
          'seat_joined_at', '2026-09-08T10:00:00Z',
          'stack_before', 100,
          'stack', 100
        )
      ),
      0,
      0,
      'pg17:malformed-joined-at',
      0
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    IF SQLERRM LIKE '%Invalid hand settlement seat generation%' THEN
      v_malformed_joined_at_caught := true;
    ELSE
      RAISE;
    END IF;
  END;
  IF NOT v_malformed_joined_at_caught THEN
    RAISE EXCEPTION 'malformed seat_joined_at was accepted';
  END IF;

  BEGIN
    PERFORM public.fn_ca_settle_hand_stacks_absolute(
      'a0000000-0000-4000-8000-000000000002',
      1000007,
      jsonb_build_array(
        jsonb_build_object(
          'user_id', '10000000-0000-4000-8000-000000000003',
          'seat_id', '51000000-0000-4000-8000-000000000004',
          'seat_joined_at', '2026-09-08T10:05:00Z',
          'stack_before', 500,
          'stack', 500
        ),
        jsonb_build_object(
          'user_id', '10000000-0000-4000-8000-000000000004',
          'stack_before', 100,
          'stack', 100
        )
      ),
      0,
      0,
      'pg17:mixed-protocol',
      0
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    IF SQLERRM LIKE '%Mixed legacy and exact hand settlement seat generations%' THEN
      v_mixed_protocol_caught := true;
    ELSE
      RAISE;
    END IF;
  END;
  IF NOT v_mixed_protocol_caught THEN
    RAISE EXCEPTION 'mixed exact/legacy stack generations were accepted';
  END IF;

  BEGIN
    PERFORM pg_temp.probe_exact_commit(
      'a0000000-0000-4000-8000-000000000002',
      2000003,
      v_current_stacks,
      jsonb_build_array(
        jsonb_build_object(
          'user_id', '10000000-0000-4000-8000-000000000003',
          'seat_id', '51000000-0000-4000-8000-000000000005',
          'seat_joined_at', '2026-09-08T10:00:00Z',
          'uses_remaining', 9,
          'seconds_remaining', 99
        ),
        jsonb_build_object(
          'user_id', '10000000-0000-4000-8000-000000000004',
          'seat_id', '51000000-0000-4000-8000-000000000005',
          'seat_joined_at', '2026-09-08T10:00:00Z',
          'uses_remaining', 9,
          'seconds_remaining', 99
        )
      )
    );
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%time_bank_seat_generation_mismatch%' THEN
      v_pair_mismatch_caught := true;
    ELSE
      RAISE;
    END IF;
  END;
  IF NOT v_pair_mismatch_caught
     OR EXISTS (
       SELECT 1 FROM public.hand_atomic_commits
        WHERE table_id = 'a0000000-0000-4000-8000-000000000002'
          AND hand_number = 2000003
     ) THEN
    RAISE EXCEPTION 'cross-narrative time-bank generation was accepted';
  END IF;

  /* Rolling expansion remains available until the explicit contraction. */
  IF COALESCE((public.fn_ca_settle_hand_stacks_absolute(
       'a0000000-0000-4000-8000-000000000002',
       1000004,
       jsonb_build_array(
         jsonb_build_object(
           'user_id', '10000000-0000-4000-8000-000000000003',
           'stack_before', 500,
           'stack', 500
         ),
         jsonb_build_object(
           'user_id', '10000000-0000-4000-8000-000000000004',
           'stack_before', 100,
           'stack', 100
         )
       ),
       0,
       0,
       'pg17:legacy-expansion',
       0
     )->>'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'all-legacy rolling stack request was refused';
  END IF;
END;
$protocol_shapes_and_cross_narrative_pairs_are_refused$;

SELECT 'PostgreSQL 17 exact seat-generation adversarial probes passed.' AS result;
