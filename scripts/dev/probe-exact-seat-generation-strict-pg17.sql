\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION pg_temp.probe_strict_commit(
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
    'pending_addons', jsonb_build_object('enabled', true, 'max_buy_in', 1000)
  );
  RETURN public.fn_ca_commit_hand_settlement(
    p_table_id,
    p_hand_number,
    p_stacks,
    0,
    0,
    'pg17-strict-seat:' || p_hand_number::text,
    0,
    v_hand_row,
    '[]'::jsonb,
    'pg17-exact-seat',
    'd0000000-0000-4000-8000-000000000001',
    v_obligations
  );
END;
$function$;

DO $strict_contract_and_acl$
DECLARE
  v_legacy_inner_refused boolean := false;
  v_legacy_outer_refused boolean := false;
  v_legacy_time_bank_refused boolean := false;
  v_malformed_refused boolean := false;
  v_before jsonb;
  v_after jsonb;
BEGIN
  IF has_function_privilege(
       'service_role',
       'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'the direct stack core is still an application RPC';
  END IF;

  SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id)
    INTO v_before
    FROM public.table_seats s;

  BEGIN
    PERFORM public.fn_ca_settle_hand_stacks_absolute(
      'a0000000-0000-4000-8000-000000000002',
      1000100,
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
      0, 0, 'pg17:strict-legacy-inner', 0
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    IF SQLERRM LIKE '%Exact hand settlement seat generation is required%' THEN
      v_legacy_inner_refused := true;
    ELSE
      RAISE;
    END IF;
  END;

  BEGIN
    PERFORM pg_temp.probe_strict_commit(
      'a0000000-0000-4000-8000-000000000002',
      2000100,
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
      jsonb_build_array(
        jsonb_build_object(
          'user_id', '10000000-0000-4000-8000-000000000003',
          'uses_remaining', 9,
          'seconds_remaining', 99
        ),
        jsonb_build_object(
          'user_id', '10000000-0000-4000-8000-000000000004',
          'uses_remaining', 9,
          'seconds_remaining', 99
        )
      )
    );
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%exact_stack_seat_generation_required%' THEN
      v_legacy_outer_refused := true;
    ELSE
      RAISE;
    END IF;
  END;

  BEGIN
    PERFORM pg_temp.probe_strict_commit(
      'a0000000-0000-4000-8000-000000000002',
      2000101,
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
          'seat_id', '51000000-0000-4000-8000-000000000005',
          'seat_joined_at', '2026-09-08T10:00:00Z',
          'stack_before', 100,
          'stack', 100
        )
      ),
      jsonb_build_array(
        jsonb_build_object(
          'user_id', '10000000-0000-4000-8000-000000000003',
          'uses_remaining', 9,
          'seconds_remaining', 99
        ),
        jsonb_build_object(
          'user_id', '10000000-0000-4000-8000-000000000004',
          'uses_remaining', 9,
          'seconds_remaining', 99
        )
      )
    );
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%exact_time_bank_seat_generation_required%' THEN
      v_legacy_time_bank_refused := true;
    ELSE
      RAISE;
    END IF;
  END;

  BEGIN
    PERFORM public.fn_ca_settle_hand_stacks_absolute(
      'a0000000-0000-4000-8000-000000000002',
      1000101,
      jsonb_build_array(
        jsonb_build_object(
          'user_id', '10000000-0000-4000-8000-000000000003',
          'seat_id', '51000000-0000-4000-8000-000000000004',
          'seat_joined_at', 'not-an-instant',
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
      0, 0, 'pg17:strict-malformed-inner', 0
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    v_malformed_refused := true;
  END;

  SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id)
    INTO v_after
    FROM public.table_seats s;
  IF NOT v_legacy_inner_refused
     OR NOT v_legacy_outer_refused
     OR NOT v_legacy_time_bank_refused
     OR NOT v_malformed_refused
     OR v_after IS DISTINCT FROM v_before
     OR EXISTS (
       SELECT 1 FROM public.hand_atomic_commits
        WHERE hand_number IN (2000100, 2000101)
     ) THEN
    RAISE EXCEPTION 'strict payload or no-write refusal contract failed';
  END IF;
END;
$strict_contract_and_acl$;

DO $strict_same_chair_reuse_fails_closed$
DECLARE
  v_receipt jsonb;
BEGIN
  v_receipt := public.fn_ca_settle_hand_stacks_absolute(
    'a0000000-0000-4000-8000-000000000002',
    1000102,
    jsonb_build_array(
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
    ),
    0, 0, 'pg17:strict-same-chair', 0
  );
  IF COALESCE((v_receipt->>'success')::boolean, true) IS NOT FALSE
     OR v_receipt->>'error' NOT LIKE '%exact seat generation missing or replaced%'
     OR (SELECT stack FROM public.table_seats
          WHERE id = '51000000-0000-4000-8000-000000000004') <> 500
     OR (SELECT stack FROM public.table_seats
          WHERE id = '51000000-0000-4000-8000-000000000005') <> 100
     OR EXISTS (
       SELECT 1 FROM public.chip_transactions
        WHERE table_id = 'a0000000-0000-4000-8000-000000000002'
     ) THEN
    RAISE EXCEPTION 'strict same-chair reuse did not fail closed: %', v_receipt;
  END IF;
END;
$strict_same_chair_reuse_fails_closed$;

DO $strict_different_chair_exact_generation_still_settles$
DECLARE
  v_receipt jsonb;
BEGIN
  v_receipt := pg_temp.probe_strict_commit(
    'a0000000-0000-4000-8000-000000000001',
    2000102,
    jsonb_build_array(
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
    ),
    jsonb_build_array(
      jsonb_build_object(
        'user_id', '10000000-0000-4000-8000-000000000001',
        'seat_id', '51000000-0000-4000-8000-000000000001',
        'seat_joined_at', '2026-09-08T05:00:00-05:00',
        'uses_remaining', 3,
        'seconds_remaining', 15
      ),
      jsonb_build_object(
        'user_id', '10000000-0000-4000-8000-000000000002',
        'seat_id', '51000000-0000-4000-8000-000000000003',
        'seat_joined_at', '2026-09-08T10:00:00Z',
        'uses_remaining', 4,
        'seconds_remaining', 20
      )
    )
  );

  IF COALESCE((v_receipt->>'post_commit_obligations')::boolean, false) IS NOT TRUE
     OR (SELECT time_bank_uses_remaining FROM public.table_seats
          WHERE id = '51000000-0000-4000-8000-000000000001') <> 3
     OR (SELECT time_bank_remaining FROM public.table_seats
          WHERE id = '51000000-0000-4000-8000-000000000001') <> 15
     OR (SELECT time_bank_uses_remaining FROM public.table_seats
          WHERE id = '51000000-0000-4000-8000-000000000002') <> 9
     OR (SELECT time_bank_remaining FROM public.table_seats
          WHERE id = '51000000-0000-4000-8000-000000000002') <> 99
     OR (SELECT time_bank_uses_remaining FROM public.table_seats
          WHERE id = '51000000-0000-4000-8000-000000000003') <> 4
     OR (SELECT time_bank_remaining FROM public.table_seats
          WHERE id = '51000000-0000-4000-8000-000000000003') <> 20 THEN
    RAISE EXCEPTION 'strict different-chair exact write failed: %', v_receipt;
  END IF;
END;
$strict_different_chair_exact_generation_still_settles$;

SELECT 'PostgreSQL 17 strict exact seat-generation probes passed.' AS result;
