\set ON_ERROR_STOP on

INSERT INTO public.clubs(id, union_id)
VALUES ('cccccccc-0000-4000-8000-000000000001', NULL);

INSERT INTO public.tables(id, club_id, tournament_id, status)
VALUES (
  'aaaaaaaa-0000-4000-8000-000000000001',
  'cccccccc-0000-4000-8000-000000000001',
  NULL,
  'running'
);

INSERT INTO public.engine_table_leases(
  table_id, instance_id, lease_generation, protocol_version, heartbeat_at
) VALUES (
  'aaaaaaaa-0000-4000-8000-000000000001',
  'pg17-probe',
  'dddddddd-0000-4000-8000-000000000001',
  2,
  clock_timestamp()
);

INSERT INTO public.table_seats(
  table_id, user_id, seat_number, stack,
  time_bank_uses_remaining, time_bank_remaining
) VALUES
  (
    'aaaaaaaa-0000-4000-8000-000000000001',
    '11111111-0000-4000-8000-000000000001',
    1, 80, 9, 99
  ),
  (
    'aaaaaaaa-0000-4000-8000-000000000001',
    '22222222-0000-4000-8000-000000000002',
    2, 80, 9, 99
  );

INSERT INTO public.table_pending_addons(
  id, table_id, user_id, amount, kind, created_at
) VALUES (
  'add00000-0000-4000-8000-000000000001',
  'aaaaaaaa-0000-4000-8000-000000000001',
  '11111111-0000-4000-8000-000000000001',
  30,
  'addon',
  clock_timestamp() - interval '1 minute'
);

CREATE OR REPLACE FUNCTION pg_temp.probe_commit(
  p_hand bigint,
  p_rake numeric DEFAULT 0,
  p_bbj numeric DEFAULT 0,
  p_with_insurance boolean DEFAULT false,
  p_first_seconds integer DEFAULT 25
) RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  v_contributions jsonb := jsonb_build_object(
    '11111111-0000-4000-8000-000000000001', 20,
    '22222222-0000-4000-8000-000000000002', 20
  );
  v_insurance jsonb := CASE WHEN p_with_insurance THEN jsonb_build_array(
    jsonb_build_object(
      'club_id', 'cccccccc-0000-4000-8000-000000000001',
      'player_id', '11111111-0000-4000-8000-000000000001',
      'equity_percent', 70,
      'premium', 3,
      'insured_amount', 20,
      'payout', 5,
      'player_won', false,
      'kind', 'insurance'
    )
  ) ELSE '[]'::jsonb END;
  v_facts jsonb;
  v_obligations jsonb;
BEGIN
  v_facts := jsonb_build_object(
    'contributions', v_contributions,
    'returned_uncalled', '{}'::jsonb,
    'insurance', v_insurance
  );
  v_obligations := jsonb_build_object(
    'version', 1,
    'time_banks', jsonb_build_array(
      jsonb_build_object(
        'user_id', '11111111-0000-4000-8000-000000000001',
        'uses_remaining', 1,
        'seconds_remaining', p_first_seconds
      ),
      jsonb_build_object(
        'user_id', '22222222-0000-4000-8000-000000000002',
        'uses_remaining', 0,
        'seconds_remaining', 0
      )
    ),
    'rake', CASE WHEN p_rake > 0 THEN jsonb_build_object(
      'club_id', 'cccccccc-0000-4000-8000-000000000001',
      'amount', p_rake,
      'bbj', p_bbj,
      'pot', 40,
      'num_players', 2,
      'contributions', v_contributions,
      'returned_uncalled', '{}'::jsonb,
      'tournament_id', NULL,
      'method', 'WEIGHTED_CONTRIBUTED'
    ) ELSE 'null'::jsonb END,
    'bbj_contribution', CASE WHEN p_bbj > 0 THEN jsonb_build_object(
      'club_id', 'cccccccc-0000-4000-8000-000000000001',
      'amount', p_bbj,
      'big_blind', 2
    ) ELSE 'null'::jsonb END,
    'promo_playthrough', jsonb_build_array(
      jsonb_build_object(
        'club_id', 'cccccccc-0000-4000-8000-000000000001',
        'user_id', '11111111-0000-4000-8000-000000000001',
        'wagered', 20
      ),
      jsonb_build_object(
        'club_id', 'cccccccc-0000-4000-8000-000000000001',
        'user_id', '22222222-0000-4000-8000-000000000002',
        'wagered', 20
      )
    ),
    'insurance', v_insurance,
    'pending_addons', jsonb_build_object('enabled', true, 'max_buy_in', 200)
  );

  RETURN public.fn_ca_commit_hand_settlement(
    'aaaaaaaa-0000-4000-8000-000000000001',
    p_hand,
    jsonb_build_array(
      jsonb_build_object(
        'user_id', '11111111-0000-4000-8000-000000000001', 'stack', 80
      ),
      jsonb_build_object(
        'user_id', '22222222-0000-4000-8000-000000000002', 'stack', 80
      )
    ),
    p_rake,
    p_bbj,
    'probe:' || p_hand::text,
    0,
    jsonb_build_object(
      'pot_size', 40,
      'big_blind', 2,
      '_accepted_post_commit_facts', v_facts
    ),
    '[]'::jsonb,
    'pg17-probe',
    'dddddddd-0000-4000-8000-000000000001',
    v_obligations
  );
END;
$function$;

DO $first_commit_and_replay$
DECLARE
  v_first jsonb;
  v_replay jsonb;
BEGIN
  v_first := pg_temp.probe_commit(1, 2, 1, true, 25);
  v_replay := pg_temp.probe_commit(1, 2, 1, true, 25);
  IF COALESCE((v_first->>'post_commit_obligations')::boolean, false) IS NOT TRUE
     OR COALESCE((v_first->>'replay')::boolean, true) IS TRUE
     OR COALESCE((v_replay->>'replay')::boolean, false) IS NOT TRUE
     OR v_replay->>'post_commit_payload_hash'
          IS DISTINCT FROM v_first->>'post_commit_payload_hash' THEN
    RAISE EXCEPTION 'exact post-commit receipt/replay contract failed: %, %',
      v_first, v_replay;
  END IF;
END;
$first_commit_and_replay$;

DO $accepted_time_bank_is_immediate$
BEGIN
  IF (SELECT time_bank_remaining FROM public.table_seats
       WHERE table_id = 'aaaaaaaa-0000-4000-8000-000000000001'
         AND user_id = '11111111-0000-4000-8000-000000000001')
       IS DISTINCT FROM 25
     OR (SELECT time_bank_uses_remaining FROM public.table_seats
          WHERE table_id = 'aaaaaaaa-0000-4000-8000-000000000001'
            AND user_id = '22222222-0000-4000-8000-000000000002')
       IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'accepted-hand time banks were not stamped atomically';
  END IF;
END;
$accepted_time_bank_is_immediate$;

/* This row did not exist when hand 1 committed and must not be stolen by its
   delayed processor. The exact pre-deal resolver owns it instead. */
INSERT INTO public.table_pending_addons(
  id, table_id, user_id, amount, kind, created_at
) VALUES (
  'add00000-0000-4000-8000-000000000002',
  'aaaaaaaa-0000-4000-8000-000000000001',
  '22222222-0000-4000-8000-000000000002',
  25,
  'addon',
  clock_timestamp()
);

DO $unbound_resolver_is_exact_and_disjoint$
DECLARE
  v_refused jsonb;
  v_resolved jsonb;
BEGIN
  v_refused := public.fn_ca_resolve_unbound_pending_addons(
    'aaaaaaaa-0000-4000-8000-000000000001',
    200,
    'pg17-probe',
    'eeeeeeee-0000-4000-8000-000000000001'
  );
  IF v_refused->>'reason' IS DISTINCT FROM 'lease_lost'
     OR EXISTS (
       SELECT 1 FROM public.table_pending_addons
        WHERE id = 'add00000-0000-4000-8000-000000000002'
          AND resolved_at IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'wrong-generation unbound resolver mutated rows: %', v_refused;
  END IF;

  v_resolved := public.fn_ca_resolve_unbound_pending_addons(
    'aaaaaaaa-0000-4000-8000-000000000001',
    200,
    'pg17-probe',
    'dddddddd-0000-4000-8000-000000000001'
  );
  IF COALESCE((v_resolved->>'ok')::boolean, false) IS NOT TRUE
     OR (v_resolved->>'resolved')::integer <> 1
     OR v_resolved->'rows'->0->>'id'
          IS DISTINCT FROM 'add00000-0000-4000-8000-000000000002'
     OR EXISTS (
       SELECT 1 FROM public.table_pending_addons
        WHERE id = 'add00000-0000-4000-8000-000000000001'
          AND resolved_at IS NOT NULL
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.table_pending_addons
        WHERE id = 'add00000-0000-4000-8000-000000000002'
          AND resolved_at IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'unbound resolver crossed the accepted-hand boundary: %', v_resolved;
  END IF;
END;
$unbound_resolver_is_exact_and_disjoint$;

DO $tampered_replay_is_refused$
BEGIN
  BEGIN
    PERFORM pg_temp.probe_commit(1, 2, 1, true, 24);
    RAISE EXCEPTION 'tampered replay unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%post_commit_payload_conflict%' THEN
      RAISE;
    END IF;
  END;
END;
$tampered_replay_is_refused$;

SET probe.fail_promo = 'on';
DO $processor_is_all_or_none$
DECLARE
  v_hand_id uuid;
BEGIN
  SELECT hand_id INTO STRICT v_hand_id
    FROM public.hand_atomic_commits
   WHERE table_id = 'aaaaaaaa-0000-4000-8000-000000000001'
     AND hand_number = 1;
  BEGIN
    PERFORM public.fn_ca_process_hand_post_commit_obligations(v_hand_id);
    RAISE EXCEPTION 'forced processor failure unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%probe promo failure%' THEN
      RAISE;
    END IF;
  END;
END;
$processor_is_all_or_none$;
RESET probe.fail_promo;

DO $failed_processor_rolled_back_every_leg$
BEGIN
  IF EXISTS (SELECT 1 FROM public.probe_rake_receipts)
     OR EXISTS (SELECT 1 FROM public.probe_bbj_receipts)
     OR EXISTS (SELECT 1 FROM public.probe_promo_balances)
     OR EXISTS (SELECT 1 FROM public.insurance_transactions)
     OR EXISTS (
       SELECT 1 FROM public.table_pending_addons
        WHERE id = 'add00000-0000-4000-8000-000000000001'
          AND resolved_at IS NOT NULL
     )
     OR EXISTS (
       SELECT 1 FROM public.hand_atomic_commits
        WHERE hand_number = 1
          AND post_commit_completed_at IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'failed processor leaked a partial obligation';
  END IF;
END;
$failed_processor_rolled_back_every_leg$;

DO $processor_and_replay_are_exactly_once$
DECLARE
  v_hand_id uuid;
  v_first jsonb;
  v_replay jsonb;
BEGIN
  SELECT hand_id INTO STRICT v_hand_id
    FROM public.hand_atomic_commits
   WHERE table_id = 'aaaaaaaa-0000-4000-8000-000000000001'
     AND hand_number = 1;
  v_first := public.fn_ca_process_hand_post_commit_obligations(v_hand_id);
  v_replay := public.fn_ca_process_hand_post_commit_obligations(v_hand_id);
  IF COALESCE((v_first->>'ok')::boolean, false) IS NOT TRUE
     OR COALESCE((v_first->>'already_completed')::boolean, true) IS TRUE
     OR COALESCE((v_replay->>'already_completed')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'processor receipt/replay failed: %, %', v_first, v_replay;
  END IF;
END;
$processor_and_replay_are_exactly_once$;

DO $every_obligation_landed_once$
BEGIN
  IF (SELECT count(*) FROM public.probe_rake_receipts) <> 1
     OR (SELECT sum(amount) FROM public.probe_rake_receipts) IS DISTINCT FROM 2::numeric
     OR (SELECT count(*) FROM public.probe_bbj_receipts) <> 1
     OR (SELECT sum(amount) FROM public.probe_bbj_receipts) IS DISTINCT FROM 1::numeric
     OR (SELECT count(*) FROM public.probe_promo_balances) <> 2
     OR (SELECT sum(wagered) FROM public.probe_promo_balances) IS DISTINCT FROM 40::numeric
     OR (SELECT count(*) FROM public.insurance_transactions) <> 1
     OR (SELECT count(*) FROM public.table_pending_addons
          WHERE id = 'add00000-0000-4000-8000-000000000001'
            AND resolved_at IS NOT NULL) <> 1
     OR (SELECT count(*) FROM public.table_pending_addons
          WHERE id = 'add00000-0000-4000-8000-000000000002'
            AND resolved_at IS NOT NULL) <> 1
     OR (SELECT stack FROM public.table_seats
          WHERE table_id = 'aaaaaaaa-0000-4000-8000-000000000001'
            AND user_id = '11111111-0000-4000-8000-000000000001')
          IS DISTINCT FROM 110::numeric
     OR (SELECT stack FROM public.table_seats
          WHERE table_id = 'aaaaaaaa-0000-4000-8000-000000000001'
            AND user_id = '22222222-0000-4000-8000-000000000002')
          IS DISTINCT FROM 105::numeric THEN
    RAISE EXCEPTION 'one or more obligations did not land exactly once';
  END IF;
END;
$every_obligation_landed_once$;

/* A projection DELETE is the crash/lost-response successor. Hand 2 freezes an
   add-on created after the pre-deal boundary, and the trigger must finish it
   in the same transaction that removes the causal outbox row. */
INSERT INTO public.table_pending_addons(
  id, table_id, user_id, amount, kind, created_at
) VALUES (
  'add00000-0000-4000-8000-000000000003',
  'aaaaaaaa-0000-4000-8000-000000000001',
  '22222222-0000-4000-8000-000000000002',
  15,
  'addon',
  clock_timestamp()
);

DO $projection_trigger_is_the_successor$
DECLARE
  v_commit jsonb;
  v_hand_id uuid;
  v_project jsonb;
BEGIN
  v_commit := pg_temp.probe_commit(2, 0, 0, false, 20);
  v_hand_id := (v_commit->>'history_id')::uuid;
  v_project := public.fn_project_hand_side_effects(v_hand_id);
  IF COALESCE((v_project->>'ok')::boolean, false) IS NOT TRUE
     OR EXISTS (SELECT 1 FROM public.hand_projection_outbox WHERE hand_id = v_hand_id)
     OR NOT EXISTS (
       SELECT 1 FROM public.hand_atomic_commits
        WHERE hand_id = v_hand_id
          AND post_commit_completed_at IS NOT NULL
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.table_pending_addons
        WHERE id = 'add00000-0000-4000-8000-000000000003'
          AND resolved_at IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'projection trigger did not finish the durable envelope';
  END IF;
END;
$projection_trigger_is_the_successor$;

DO $predecessor_order_is_causal$
DECLARE
  v_three uuid;
  v_four uuid;
  v_early jsonb;
BEGIN
  v_three := (pg_temp.probe_commit(3, 0, 0, false, 19)->>'history_id')::uuid;
  v_four := (pg_temp.probe_commit(4, 0, 0, false, 18)->>'history_id')::uuid;
  v_early := public.fn_ca_process_hand_post_commit_obligations(v_four);
  IF v_early->>'reason' IS DISTINCT FROM 'predecessor_pending' THEN
    RAISE EXCEPTION 'later hand crossed its predecessor: %', v_early;
  END IF;
  PERFORM public.fn_ca_process_hand_post_commit_obligations(v_three);
  IF COALESCE(
       (public.fn_ca_process_hand_post_commit_obligations(v_four)->>'ok')::boolean,
       false
     ) IS NOT TRUE THEN
    RAISE EXCEPTION 'later hand did not resume after predecessor completion';
  END IF;
END;
$predecessor_order_is_causal$;

DO $legacy_receipt_cannot_grow_an_envelope$
DECLARE
  v_legacy jsonb;
BEGIN
  v_legacy := public.fn_ca_commit_hand_settlement_exact_before_obligations(
    'aaaaaaaa-0000-4000-8000-000000000001',
    5,
    '[]'::jsonb,
    0,
    0,
    'legacy:5',
    0,
    '{}'::jsonb,
    '[]'::jsonb,
    'pg17-probe',
    'dddddddd-0000-4000-8000-000000000001'
  );
  BEGIN
    PERFORM pg_temp.probe_commit(5, 0, 0, false, 17);
    RAISE EXCEPTION 'legacy receipt unexpectedly acquired an envelope';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%legacy_receipt_has_no_post_commit_envelope%' THEN
      RAISE;
    END IF;
  END;
END;
$legacy_receipt_cannot_grow_an_envelope$;

DO $grants_and_hashes_are_exact$
BEGIN
  IF has_function_privilege(
       'authenticated',
       'public.fn_ca_process_hand_post_commit_obligations(uuid)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_ca_process_hand_post_commit_obligations(uuid)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.fn_ca_resolve_unbound_pending_addons(uuid,numeric,text,uuid)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_ca_resolve_unbound_pending_addons(uuid,numeric,text,uuid)',
       'EXECUTE'
     )
     OR EXISTS (
       SELECT 1 FROM public.hand_atomic_commits c
        WHERE c.post_commit_payload IS NOT NULL
          AND c.post_commit_payload_hash IS DISTINCT FROM encode(
            extensions.digest(convert_to(c.post_commit_payload::text, 'UTF8'), 'sha256'),
            'hex'
          )
     ) THEN
    RAISE EXCEPTION 'post-commit grants or immutable hashes are wrong';
  END IF;
END;
$grants_and_hashes_are_exact$;

SELECT 'PostgreSQL 17 post-commit obligation probes passed.' AS result;
