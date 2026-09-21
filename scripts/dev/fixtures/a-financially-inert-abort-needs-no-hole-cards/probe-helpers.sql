-- Callers for the two functions under repair, and the assertions a scenario
-- writes with. Nothing here evaluates the hole-card rule itself; it only
-- builds the exact input each function demands and reports what came back.
\set ON_ERROR_STOP on
CREATE SCHEMA probe;

-- The physical proof smarter_private.f06_retired_origin_begin(jsonb) and the
-- snapshot both demand, composed from the IMMUTABLE cohort so it cannot drift
-- away from the cohort it is checked against.
CREATE FUNCTION probe.physical_a() RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object(
   'source','8825af51817f379c4261658ca29ecc9d8d81932d',
   'instance_id','1-3846b8bb',
   'process_id','1231816',
   'application_pid','1',
   'container_id','c63b254ee71b76aa26f4d1394d96189963774310244b046bc91186e219ca3f66',
   'image','sha256:7973b0cd170e7ea00a948f6376b17a201485c3e03ae47c06f0248b17a4bfae1c',
   'manager_id', c->>'manager_id',
   'generation', c->>'generation',
   'all_processes_accounted', true, 'all_owned_work_joined', true,
   'original_stop_completed', true, 'owner_index_complete', true,
   'scheduler_pending', 0, 'lifecycle_pending', 0,
   'table_id', c#>>'{permit,table_id}',
   'permit_id', c#>>'{permit,permit_id}',
   'engine_id', c->'engines'->>(c#>>'{permit,table_id}'),
   'evidence_sha256', repeat('a',64),
   'engines', (SELECT jsonb_agg(jsonb_build_object(
       'table_id', e.key, 'engine_id', e.value, 'generation', c->>'generation',
       'terminal', true, 'running', false, 'last_event','stop_completed',
       'owned_work_joined', true, 'diagnostic_write_failures', 0, 'dropped_records', 0,
       'dealing_loop', false, 'settlements', 0, 'post_hand_tasks', false,
       'tournament_moves', 0,
       'read_continuation_proof','8825_stop_completed_joins_fixed_point'))
     FROM jsonb_each_text(c->'engines') e))
 FROM (SELECT smarter_private.f06_retired_origin_cohort('5a387a75-754a-416e-8fee-b85b15fc2702') AS c) q
$$;

CREATE FUNCTION probe.input_a() RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object(
   'kind','retained_mtt_interruption_v1',
   'tournament_id','5a387a75-754a-416e-8fee-b85b15fc2702',
   'generation', c->>'generation',
   'lease', NULL::jsonb,
   'physical', probe.physical_a(),
   'hands', jsonb_build_array(jsonb_build_object(
      'permit', c->'permit',
      'interruption', jsonb_build_object('kind','original_preflop_snapshot'))),
   'accepted_zeros','[]'::jsonb)
 FROM (SELECT smarter_private.f06_retired_origin_cohort('5a387a75-754a-416e-8fee-b85b15fc2702') AS c) q
$$;

CREATE FUNCTION probe.input_b() RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object(
   'kind','retained_mtt_interruption_v1',
   'tournament_id', l.tournament_id,
   'generation', l.lease_generation,
   'lease', to_jsonb(l),
   'physical', jsonb_build_object(
     'source', l.engine_version, 'instance_id', l.instance_id,
     'generation', l.lease_generation::text,
     'evidence_sha256', repeat('b',64), 'process_id','4242',
     'container_id','probe-container','manager_id','bbbb8888-0000-4000-8000-00000000000b',
     'all_processes_accounted', true, 'all_owned_work_joined', true,
     'original_stop_completed', true,
     'table_id', p.table_id::text, 'permit_id', p.permit_id::text,
     'engine_id','bbbb9999-0000-4000-8000-00000000000b'),
   'hands', jsonb_build_array(jsonb_build_object(
      'permit', to_jsonb(p),
      'interruption', jsonb_build_object('kind','original_preflop_snapshot'))),
   'accepted_zeros','[]'::jsonb)
 FROM public.engine_tournament_leases l
 JOIN smarter_private.f06_hand_permits p ON p.tournament_id=l.tournament_id
 WHERE l.tournament_id='bbbb0000-0000-4000-8000-00000000000b'
$$;

-- Runs one function and reports 'ACCEPTED' or the SQLSTATE and message it
-- refused with. A scenario never sees the canonical unless it asks for it.
CREATE FUNCTION probe.run(which text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE out jsonb;
BEGIN
 PERFORM set_config('request.jwt.claim.role','service_role',true);
 PERFORM set_config('app.smarter_data_actor','service',true);
 BEGIN
  IF which='A' THEN out := smarter_private.f06_retired_origin_snapshot(probe.input_a());
  ELSE            out := smarter_private.f06_retained_mtt_abort_snapshot(probe.input_b());
  END IF;
 EXCEPTION WHEN OTHERS THEN RETURN 'REFUSED: '||SQLERRM;
 END;
 RETURN 'ACCEPTED';
END $$;

-- The cards the canonical carries for the accepted case, so a scenario can
-- assert the jsonb type as well as the value: '[]' is comparable with
-- IS DISTINCT FROM, JSON null is not the same thing.
CREATE FUNCTION probe.cards(which text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE out jsonb;
BEGIN
 PERFORM set_config('request.jwt.claim.role','service_role',true);
 PERFORM set_config('app.smarter_data_actor','service',true);
 IF which='A' THEN out := smarter_private.f06_retired_origin_snapshot(probe.input_a());
 ELSE            out := smarter_private.f06_retained_mtt_abort_snapshot(probe.input_b());
 END IF;
 RETURN out#>'{hands,0,interruption,cards}';
END $$;

CREATE FUNCTION probe.expect(which text, want text, note text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE got text := probe.run(which);
BEGIN
 IF want='ACCEPTED' AND got<>'ACCEPTED' THEN
  RAISE EXCEPTION 'PROBE FAILED: world % should ACCEPT (%) but got %', which, note, got;
 END IF;
 IF want='REFUSED' AND got='ACCEPTED' THEN
  RAISE EXCEPTION 'PROBE FAILED: world % should REFUSE (%) but it ACCEPTED', which, note;
 END IF;
 RAISE NOTICE 'VERDICT % % | % | %', which, want, note, got;
END $$;

-- Both worlds at once: the two functions must never disagree.
CREATE FUNCTION probe.expect_both(want text, note text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN PERFORM probe.expect('A',want,note); PERFORM probe.expect('B',want,note); END $$;

CREATE FUNCTION probe.deal(p_table uuid, p_hand bigint, p_seats int[]) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO public.table_hole_cards(table_id,hand_number,user_id,seat_number,cards,created_at)
 SELECT p_table, p_hand, s.user_id, s.seat_number, '["Ah","Kd"]'::jsonb, now()-interval '30 hours'
   FROM public.table_seats s
  WHERE s.table_id=p_table AND s.left_at IS NULL AND s.seat_number = ANY(p_seats);
END $$;

-- The inertness predicate, asked directly, so a scenario can prove the gate's
-- own clause even where an assertion EARLIER in the function refuses first.
-- Returns NULL before the migration installs it, which a scenario treats as
-- "not yet present" rather than as an answer.
CREATE FUNCTION probe.inert(which text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE out boolean;
BEGIN
 IF to_regprocedure('smarter_private.f06_zero_cards_abort_is_inert(uuid,uuid,bigint)') IS NULL THEN
  RETURN NULL;
 END IF;
 IF which='A' THEN
  EXECUTE $q$SELECT smarter_private.f06_zero_cards_abort_is_inert(
    '5a387a75-754a-416e-8fee-b85b15fc2702','2c621856-e728-4e8b-bf08-4c56746a8649',12942021)$q$ INTO out;
 ELSE
  EXECUTE $q$SELECT smarter_private.f06_zero_cards_abort_is_inert(
    'bbbb0000-0000-4000-8000-00000000000b','bbbb1111-0000-4000-8000-00000000000b',900001)$q$ INTO out;
 END IF;
 RETURN out;
END $$;

CREATE FUNCTION probe.expect_inert(which text, want boolean, note text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE got boolean := probe.inert(which);
BEGIN
 IF got IS NULL THEN
  RAISE NOTICE 'GATE   % (not installed yet) | %', which, note; RETURN;
 END IF;
 IF got IS DISTINCT FROM want THEN
  RAISE EXCEPTION 'PROBE FAILED: gate for world % should be % (%) but is %', which, want, note, got;
 END IF;
 RAISE NOTICE 'GATE   % %   | % ', which, want, note;
END $$;

CREATE FUNCTION probe.expect_inert_both(want boolean, note text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN PERFORM probe.expect_inert('A',want,note); PERFORM probe.expect_inert('B',want,note); END $$;
