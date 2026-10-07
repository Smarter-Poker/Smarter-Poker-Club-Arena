-- P14.2 accepted-roster native cases. Runs after the hand-submission opening
-- and accepted-hand-roster-fixture.sql inside ONE transaction the runner
-- always rolls back. Every case asserts with ROSTER PASS notices; a capsule a
-- case wants retained is emitted as one ROSTER CAPSULE notice of JSON.
CREATE FUNCTION pg_temp.roster_assert(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ROSTER FAIL: %', label; END IF;
  RAISE NOTICE 'ROSTER PASS: %', label;
END $$;
CREATE FUNCTION pg_temp.roster_id(n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT ('88400000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.roster_row_of(p_hand bigint) RETURNS smarter_private.accepted_hand_rosters
LANGUAGE sql AS $$
  SELECT * FROM smarter_private.accepted_hand_rosters
   WHERE table_id = '88100000-0000-0000-0000-000000000001' AND hand_number = p_hand $$;
CREATE FUNCTION pg_temp.roster_receipt(p_hand bigint) RETURNS public.hand_atomic_commits
LANGUAGE sql AS $$
  SELECT * FROM public.hand_atomic_commits
   WHERE table_id = '88100000-0000-0000-0000-000000000001' AND hand_number = p_hand $$;
CREATE FUNCTION pg_temp.sha(p jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(extensions.digest(convert_to(p::text, 'UTF8'), 'sha256'), 'hex') $$;
-- Relation and advisory locks this backend holds right now, outside the
-- system catalogs and their toast (the forced case's own CREATE FUNCTION
-- writes pg_proc's toast; settlement never does). An index lock is reported under its table.
CREATE FUNCTION pg_temp.roster_locks() RETURNS text[] LANGUAGE sql VOLATILE AS $$
  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}')
    FROM (SELECT CASE WHEN l.locktype = 'relation'
                      THEN 'relation:' || COALESCE(i.indrelid, l.relation)::regclass::text || ':' || l.mode
                      ELSE l.locktype || ':' || COALESCE(l.objid::text, '') || ':' || l.mode END AS x
            FROM pg_locks l
            LEFT JOIN pg_index i ON i.indexrelid = l.relation
            LEFT JOIN pg_class c ON c.oid = COALESCE(i.indrelid, l.relation)
           WHERE l.pid = pg_backend_pid() AND l.granted
             AND (l.locktype = 'advisory'
                  OR (l.locktype = 'relation' AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
                      AND c.relnamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace, 'pg_toast'::regnamespace)
                      AND c.relpersistence <> 't'))) q $$;

-- ═══ C1: a caller-supplied roster key is refused whole ══════════════════════
DO $spoof$
DECLARE denied boolean := false; o jsonb;
BEGIN
  o := pg_temp.roster_obligations('exact') || jsonb_build_object('accepted_actor_roster',
       jsonb_build_object('version', 1, 'basis', 'profiles_read_in_acceptance_transaction', 'actors', '[]'::jsonb));
  BEGIN
    PERFORM pg_temp.roster_commit(8800001, pg_temp.roster_id(1), 'exact', o);
  EXCEPTION WHEN OTHERS THEN
    denied := SQLERRM = 'atomic hand commit refused (invalid_post_commit_obligations)';
  END;
  PERFORM pg_temp.roster_assert(denied, 'spoofed accepted_actor_roster obligations key refused by the existing invalid_post_commit_obligations refusal');
  denied := false;
  BEGIN
    PERFORM pg_temp.roster_commit(8800001, pg_temp.roster_id(1), 'exact',
      pg_temp.roster_obligations('exact') || '{"accepted_actor_roster":null}'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    denied := SQLERRM = 'atomic hand commit refused (invalid_post_commit_obligations)';
  END;
  PERFORM pg_temp.roster_assert(denied, 'a null-valued spoof key is refused too');
  PERFORM pg_temp.roster_assert((pg_temp.roster_receipt(8800001)).hand_id IS NULL
    AND (pg_temp.roster_row_of(8800001)).table_id IS NULL
    AND (SELECT sum(stack) FROM public.table_seats WHERE table_id = '88100000-0000-0000-0000-000000000001') = 650,
    'spoof refusal leaves no receipt, no roster row and every stack untouched');
END $spoof$;

-- ═══ C4: a failing producer cannot fail the hand or change its money ════════
DO $forced$
DECLARE r jsonb; normal jsonb; forced jsonb; locks_normal text[]; locks_forced text[]; added text[];
  base text[];
BEGIN
  base := pg_temp.roster_locks();
  BEGIN
    r := pg_temp.roster_commit(8800002, pg_temp.roster_id(2));
    normal := pg_temp.roster_money_state(8800002, r);
    locks_normal := pg_temp.roster_locks();
    PERFORM pg_temp.roster_assert(r#>>'{accepted_roster,status}' = 'captured', 'control hand captures');
    RAISE EXCEPTION 'restore control' USING ERRCODE = 'P9001';
  EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL; END;
  BEGIN
    EXECUTE $f$CREATE OR REPLACE FUNCTION smarter_private.accepted_hand_roster_build(
      p_table_id uuid, p_hand_number bigint, p_hand_id uuid, p_stacks jsonb,
      p_exact boolean, p_lightning_seats jsonb, p_captured_at timestamptz)
      RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $b$
      BEGIN RAISE EXCEPTION 'forced roster producer failure' USING ERRCODE = 'XX001'; END $b$$f$;
    r := pg_temp.roster_commit(8800002, pg_temp.roster_id(2));
    forced := pg_temp.roster_money_state(8800002, r);
    locks_forced := pg_temp.roster_locks();
    PERFORM pg_temp.roster_assert(r->>'success' = 'true' AND r->>'atomic_hand_commit' = 'true'
      AND r#>>'{accepted_roster,status}' = 'unavailable'
      AND r#>'{accepted_roster,reasons}' = '["roster_producer_error:XX001"]'::jsonb
      AND r#>'{accepted_roster,roster}' = 'null'::jsonb
      AND r#>>'{accepted_roster,payloadDigest}' = r->>'post_commit_payload_hash',
      'a forced producer error still commits the hand and reports unavailable by sqlstate');
    PERFORM pg_temp.roster_assert((pg_temp.roster_row_of(8800002)).table_id IS NULL
      AND (pg_temp.roster_receipt(8800002)).post_commit_request_hash IS NOT NULL,
      'the failed producer subtransaction leaves no roster row; the receipt is whole');
    RAISE EXCEPTION 'restore forced' USING ERRCODE = 'P9001';
  EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL; END;
  PERFORM pg_temp.roster_assert(normal IS NOT NULL AND normal = forced,
    'stacks, wallets, receipt, envelope, hashes, settlement totals and result are identical with or without the roster');
  SELECT COALESCE(array_agg(x ORDER BY x), '{}') INTO added FROM unnest(locks_normal) x WHERE x <> ALL(locks_forced);
  RAISE NOTICE 'ROSTER LOCKS: normal-only=% forced-only=%', added,
    (SELECT array_agg(x) FROM unnest(locks_forced) x WHERE x <> ALL(locks_normal));
  PERFORM pg_temp.roster_assert(NOT EXISTS (SELECT 1 FROM unnest(locks_forced) x WHERE x <> ALL(locks_normal))
    AND NOT EXISTS (SELECT 1 FROM unnest(added) x
      WHERE x NOT IN ('relation:smarter_private.accepted_hand_rosters:RowExclusiveLock',
                      'relation:smarter_private.accepted_hand_rosters:AccessShareLock')
        AND x NOT LIKE 'relation:%:AccessShareLock'),
    'the producer adds only its own private-table write lock and read locks: ' || array_to_string(added, ','));
  PERFORM pg_temp.roster_assert(NOT EXISTS (SELECT 1 FROM unnest(added) x
      WHERE x LIKE 'relation:%:AccessShareLock' AND x NOT LIKE 'relation:smarter_private.accepted_hand_rosters%'
        AND split_part(x, ':', 2) NOT IN ('profiles', 'table_seats')),
    'its only other relations are profiles and table_seats, read without a row lock');
  PERFORM pg_temp.roster_assert(base = pg_temp.roster_locks()
    AND (pg_temp.roster_receipt(8800002)).hand_id IS NULL,
    'both rehearsals rolled back completely');
END $forced$;

-- ═══ C5: a recording failure records unavailable and still commits ══════════
DO $record$
DECLARE r jsonb; r2 jsonb; d smarter_private.accepted_hand_rosters;
BEGIN
  BEGIN
    CREATE FUNCTION pg_temp.roster_refuse_capture() RETURNS trigger LANGUAGE plpgsql AS $t$
      BEGIN IF NEW.status = 'captured' THEN RAISE EXCEPTION 'forced record failure' USING ERRCODE = 'XX002'; END IF;
      RETURN NEW; END $t$;
    CREATE TRIGGER zz_roster_refuse_capture BEFORE INSERT ON smarter_private.accepted_hand_rosters
      FOR EACH ROW EXECUTE FUNCTION pg_temp.roster_refuse_capture();
    r := pg_temp.roster_commit(8800003, pg_temp.roster_id(3));
    d := pg_temp.roster_row_of(8800003);
    PERFORM pg_temp.roster_assert(r->>'success' = 'true'
      AND r#>>'{accepted_roster,status}' = 'unavailable'
      AND r#>'{accepted_roster,reasons}' = '["roster_record_error:XX002"]'::jsonb
      AND d.status = 'unavailable' AND d.reasons = ARRAY['roster_record_error:XX002'] AND d.roster IS NULL,
      'a refused capture row records unavailable with the recording sqlstate and the hand commits');
    DROP TRIGGER zz_roster_refuse_capture ON smarter_private.accepted_hand_rosters;
    r2 := pg_temp.roster_commit(8800003, pg_temp.roster_id(3));
    PERFORM pg_temp.roster_assert(r2->>'replay' = 'true' AND r2->'accepted_roster' = r->'accepted_roster',
      'a stored unavailable row replays exactly; capture is never retried later');
    RAISE EXCEPTION 'restore record' USING ERRCODE = 'P9001';
  EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL; END;
END $record$;

-- ═══ C7: legacy (non-exact) stacks commit as before, roster unavailable ═════
DO $legacy$
DECLARE r jsonb; d smarter_private.accepted_hand_rosters;
BEGIN
  BEGIN
    r := pg_temp.roster_commit(8800006, pg_temp.roster_id(6), 'legacy');
    d := pg_temp.roster_row_of(8800006);
    PERFORM pg_temp.roster_assert(r->>'success' = 'true'
      AND r#>>'{accepted_roster,status}' = 'unavailable'
      AND r#>'{accepted_roster,reasons}' = '["legacy_stack_seat_generation"]'::jsonb
      AND r#>'{accepted_roster,roster}' = 'null'::jsonb
      AND d.status = 'unavailable' AND d.reasons = ARRAY['legacy_stack_seat_generation']
      AND d.post_commit_payload_hash = r->>'post_commit_payload_hash',
      'a legacy roster without seat generations commits and names why no capsule exists');
    RAISE EXCEPTION 'restore legacy' USING ERRCODE = 'P9001';
  EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL; END;
END $legacy$;

-- ═══ C10: the production path, retained submission -> commit, carries it ═══
DO $submission$
DECLARE q jsonb; r jsonb; ret jsonb; d smarter_private.accepted_hand_rosters;
BEGIN
 BEGIN
  q := jsonb_build_object('p_table_id', '88100000-0000-0000-0000-000000000001', 'p_hand_number', 8800005,
    'p_stacks', pg_temp.roster_stacks('exact'), 'p_rake', 0, 'p_bbj', 0, 'p_ref', 'roster-probe', 'p_inflow', 0,
    'p_hand_row', pg_temp.roster_row(8800005, pg_temp.roster_id(5)), 'p_units', '[]'::jsonb,
    'p_instance_id', 'roster-probe', 'p_lease_generation', '88500000-0000-0000-0000-000000000001',
    'p_post_commit_obligations', pg_temp.roster_obligations('exact'));
  ret := public.fn_ca_retain_hand_submission(q);
  PERFORM pg_temp.roster_assert(ret->>'retained' = 'true', 'the engine request is retained unchanged');
  r := public.fn_ca_commit_hand_submission(pg_temp.roster_id(5), 'roster-probe', '88500000-0000-0000-0000-000000000001');
  d := pg_temp.roster_row_of(8800005);
  PERFORM pg_temp.roster_assert(r->>'success' = 'true' AND r->>'submission_id' = pg_temp.roster_id(5)::text
    AND r#>>'{accepted_roster,status}' = 'captured' AND r#>'{accepted_roster,roster}' = d.roster
    AND r#>>'{accepted_roster,payloadDigest}' = r->>'post_commit_payload_hash'
    AND jsonb_array_length(r#>'{accepted_roster,roster,actors}') = 7,
    'fn_ca_commit_hand_submission returns the door''s accepted_roster to the engine');
  RAISE NOTICE 'ROSTER CAPSULE: %', jsonb_build_object('case', 'retained_submission_first_acceptance', 'result', r);
  r := public.fn_ca_commit_hand_submission(pg_temp.roster_id(5), 'roster-probe', '88500000-0000-0000-0000-000000000001');
  PERFORM pg_temp.roster_assert(r->>'replay' = 'true' AND r#>'{accepted_roster,roster}' = d.roster,
    'an acknowledgement-loss resubmission returns the same capsule');
  RAISE EXCEPTION 'restore submission' USING ERRCODE = 'P9001';
  EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL;
 END;
END $submission$;
-- ═══ C2: first acceptance captures the whole dealt roster ═══════════════════
DO $first$
DECLARE r jsonb; ar jsonb; cap jsonb; a public.hand_atomic_commits; d smarter_private.accepted_hand_rosters;
  actors jsonb; sorted jsonb; seal jsonb;
BEGIN
  r := pg_temp.roster_commit(8800001, pg_temp.roster_id(1));
  PERFORM pg_temp.roster_assert(r->>'success' = 'true' AND r->>'atomic_hand_commit' = 'true'
    AND r->>'post_commit_obligations' = 'true', 'first acceptance commits the hand');
  ar := r->'accepted_roster'; cap := ar->'roster'; actors := cap->'actors';
  a := pg_temp.roster_receipt(8800001); d := pg_temp.roster_row_of(8800001);
  PERFORM pg_temp.roster_assert((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(ar) k)
      = ARRAY['payloadDigest','producerVersion','reasons','roster','status','version']
    AND ar->'version' = '1'::jsonb AND ar->>'status' = 'captured' AND ar->'reasons' = '[]'::jsonb
    AND ar->>'producerVersion' = 'accepted_hand_roster_v1',
    'result carries accepted_roster {version,status,reasons,payloadDigest,producerVersion,roster} captured');
  PERFORM pg_temp.roster_assert(ar->>'payloadDigest' = r->>'post_commit_payload_hash'
    AND ar->>'payloadDigest' = a.post_commit_payload_hash
    AND a.post_commit_payload_hash = pg_temp.sha(a.post_commit_payload),
    'payloadDigest is the receipt''s raw-text post_commit_payload_hash');
  PERFORM pg_temp.roster_assert((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(cap) k)
      = ARRAY['actors','basis','capturedAt','handId','handNumber','tableId','version']
    AND cap->'version' = '1'::jsonb AND cap->>'basis' = 'profiles_read_in_acceptance_transaction'
    AND cap->>'tableId' = '88100000-0000-0000-0000-000000000001'
    AND cap->>'handId' = pg_temp.roster_id(1)::text AND cap->'handNumber' = '8800001'::jsonb
    AND jsonb_typeof(cap->'handNumber') = 'number'
    AND cap->>'capturedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$'
    AND (cap->>'capturedAt')::timestamptz = transaction_timestamp(),
    'capsule names this table, history id, hand number and the transaction instant in UTC Z');
  SELECT jsonb_agg(x ORDER BY x->>'userId' COLLATE "C") INTO sorted FROM jsonb_array_elements(actors) x;
  PERFORM pg_temp.roster_assert(jsonb_array_length(actors) = 7 AND actors = sorted
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(actors) x
      WHERE (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(x) k)
            <> ARRAY['classification','seat','seatId','seatJoinedAt','status','userId']),
    'all seven dealt seat generations, exact keys, sorted by userId in byte order');
  PERFORM pg_temp.roster_assert(EXISTS (SELECT 1 FROM jsonb_array_elements(actors) x
      WHERE x->>'userId' = '88200000-0000-0000-0000-000000000003' AND x->'seat' = '3'::jsonb
        AND x->>'classification' = 'horse' AND x->>'status' = 'canonical_boolean'),
    'silent horse (dealt, no action, no chips in) is a horse in the roster');
  PERFORM pg_temp.roster_assert(EXISTS (SELECT 1 FROM jsonb_array_elements(actors) x
      WHERE x->>'userId' = '88200000-0000-0000-0000-000000000004' AND x->'seat' = '4'::jsonb
        AND x->>'classification' = 'horse' AND x->>'status' = 'canonical_boolean'),
    'post-only horse (posted, never named in the action log) is a horse in the roster');
  PERFORM pg_temp.roster_assert(EXISTS (SELECT 1 FROM jsonb_array_elements(actors) x
      WHERE x->>'userId' = '88200000-0000-0000-0000-000000000005'
        AND x->>'classification' = 'unknown' AND x->>'status' = 'classification_null')
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(actors) x
      WHERE x->>'userId' = '88200000-0000-0000-0000-000000000006'
        AND x->>'classification' = 'human' AND x->>'status' = 'canonical_boolean'),
    'a null is_horse is an explicit unknown, never guessed');
  PERFORM pg_temp.roster_assert(EXISTS (SELECT 1 FROM jsonb_array_elements(actors) x
      WHERE x->>'userId' = '88200000-0000-0000-0000-000000000007' AND x->'seat' = '7'::jsonb
        AND x->>'seatId' = '88300000-0000-0000-0000-000000000007'
        AND x->>'classification' = 'human' AND x->>'status' = 'canonical_boolean')
    AND (SELECT left_at IS NOT NULL FROM public.table_seats WHERE id = '88300000-0000-0000-0000-000000000007'),
    'a lawfully departed seat generation stays in the roster under its own seat');
  PERFORM pg_temp.roster_assert(EXISTS (SELECT 1 FROM jsonb_array_elements(actors) x
      WHERE x->>'userId' = '10000000-0000-0000-0000-000000000001'
        AND x->>'seatJoinedAt' = '2026-10-06T10:00:01.123456+00:00'
        AND x->>'seatId' = '88300000-0000-0000-0000-000000000001'
        AND x->>'classification' = 'human')
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(actors) x
      WHERE x->>'userId' = '10000000-0000-0000-0000-000000000002' AND x->>'classification' = 'horse'),
    'seat id and joined-at are the exact accepted generation text');
  PERFORM pg_temp.roster_assert(d.status = 'captured' AND d.reasons = '{}' AND d.roster = cap
    AND d.hand_id = pg_temp.roster_id(1) AND d.post_commit_payload_hash = a.post_commit_payload_hash
    AND d.producer_version = 'accepted_hand_roster_v1' AND d.captured_txid = txid_current()
    AND d.captured_at = transaction_timestamp(),
    'one discriminator row bound to the receipt hand id and final payload hash');
  PERFORM pg_temp.roster_assert(NOT (a.post_commit_payload ? 'accepted_actor_roster')
    AND a.post_commit_request_hash = pg_temp.sha(pg_temp.roster_obligations('exact')),
    'the stored envelope and its request hash are exactly the obligations');
  seal := (a.post_commit_payload - 'accepted_hand_facts') #- '{pending_addons,ids}';
  PERFORM pg_temp.roster_assert(pg_temp.sha(seal) = a.post_commit_request_hash,
    'the request reconstruction the seven seal verifiers perform still matches');
  PERFORM pg_temp.roster_assert(
    (SELECT jsonb_object_agg(user_id::text, stack) FROM public.table_seats
      WHERE table_id = '88100000-0000-0000-0000-000000000001')
    = '{"10000000-0000-0000-0000-000000000001":90,"10000000-0000-0000-0000-000000000002":111,
        "88200000-0000-0000-0000-000000000003":100,"88200000-0000-0000-0000-000000000004":99,
        "88200000-0000-0000-0000-000000000005":100,"88200000-0000-0000-0000-000000000006":100,
        "88200000-0000-0000-0000-000000000007":50}'::jsonb,
    'stacks settle by the unchanged delta rule');
  RAISE NOTICE 'ROSTER CAPSULE: %', jsonb_build_object('case', 'direct_first_acceptance', 'result', r,
    'discriminator', to_jsonb(d) - 'captured_txid', 'receipt', jsonb_build_object(
      'post_commit_payload_hash', a.post_commit_payload_hash,
      'post_commit_request_hash', a.post_commit_request_hash,
      'post_commit_payload', a.post_commit_payload));
END $first$;

-- ═══ C3: replay returns the stored roster even after profiles change ════════
DO $replay$
DECLARE r jsonb; first jsonb; before jsonb; after jsonb; n integer;
BEGIN
  first := (SELECT to_jsonb(d) FROM smarter_private.accepted_hand_rosters d
             WHERE table_id = '88100000-0000-0000-0000-000000000001' AND hand_number = 8800001);
  before := pg_temp.roster_money_state(8800001, NULL);
  -- Fixture-only flips: replica mode keeps the horse-socialization triggers
  -- (which need an alias vocabulary this catalog does not seed) out of it.
  SET LOCAL session_replication_role = replica;
  UPDATE public.profiles SET is_horse = false WHERE id = '88200000-0000-0000-0000-000000000003';
  UPDATE public.profiles SET is_horse = true WHERE id = '88200000-0000-0000-0000-000000000005';
  UPDATE public.profiles SET is_horse = NULL WHERE id = '10000000-0000-0000-0000-000000000002';
  SET LOCAL session_replication_role = origin;
  r := pg_temp.roster_commit(8800001, pg_temp.roster_id(1));
  after := pg_temp.roster_money_state(8800001, NULL);
  SELECT count(*) INTO n FROM smarter_private.accepted_hand_rosters WHERE hand_number = 8800001;
  PERFORM pg_temp.roster_assert(r->>'success' = 'true' AND r->>'replay' = 'true'
    AND r->'accepted_roster' = jsonb_build_object('version', 1, 'status', first->>'status',
      'reasons', first->'reasons', 'payloadDigest', first->>'post_commit_payload_hash',
      'producerVersion', 'accepted_hand_roster_v1', 'roster', first->'roster'),
    'same-request replay returns the identical stored capsule');
  PERFORM pg_temp.roster_assert(EXISTS (SELECT 1 FROM jsonb_array_elements(r#>'{accepted_roster,roster,actors}') x
      WHERE x->>'userId' = '88200000-0000-0000-0000-000000000003' AND x->>'classification' = 'horse')
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(r#>'{accepted_roster,roster,actors}') x
      WHERE x->>'userId' = '88200000-0000-0000-0000-000000000005' AND x->>'status' = 'classification_null'),
    'profile flips after acceptance do not reach the replayed roster');
  PERFORM pg_temp.roster_assert(n = 1 AND before = after
    AND to_jsonb(pg_temp.roster_row_of(8800001)) = first,
    'replay writes no roster row and moves no money');
  RAISE NOTICE 'ROSTER CAPSULE: %', jsonb_build_object('case', 'replay_after_profile_flip', 'result', r);
  SET LOCAL session_replication_role = replica;
  UPDATE public.profiles SET is_horse = true WHERE id = '88200000-0000-0000-0000-000000000003';
  UPDATE public.profiles SET is_horse = NULL WHERE id = '88200000-0000-0000-0000-000000000005';
  UPDATE public.profiles SET is_horse = true WHERE id = '10000000-0000-0000-0000-000000000002';
  SET LOCAL session_replication_role = origin;
END $replay$;

-- ═══ C6: a contradictory seat generation keeps the existing refusal ═════════
DO $contradiction$
DECLARE r jsonb; s jsonb; o jsonb; refused boolean := false;
BEGIN
  s := (SELECT jsonb_agg(CASE WHEN x->>'user_id' = '88200000-0000-0000-0000-000000000003'
          THEN jsonb_set(x, '{seat_joined_at}', '"2026-10-06T10:00:09+00:00"') ELSE x END)
          FROM jsonb_array_elements(pg_temp.roster_stacks('exact')) x);
  o := pg_temp.roster_obligations('exact');
  o := jsonb_set(o, '{time_banks}', (SELECT jsonb_agg(CASE WHEN x->>'user_id' = '88200000-0000-0000-0000-000000000003'
          THEN jsonb_set(x, '{seat_joined_at}', '"2026-10-06T10:00:09+00:00"') ELSE x END)
          FROM jsonb_array_elements(o->'time_banks') x));
  BEGIN
    r := public.fn_ca_commit_hand_settlement('88100000-0000-0000-0000-000000000001', 8800004, s, 0, 0,
      'roster-probe', 0, pg_temp.roster_row(8800004, pg_temp.roster_id(4)), '[]'::jsonb,
      'roster-probe', '88500000-0000-0000-0000-000000000001', o);
    refused := r->>'success' = 'false' AND r->>'reason' = 'rolled_back'
      AND r->>'error' = 'exact seat generation missing or replaced for 88200000-0000-0000-0000-000000000003 - hand write rejected whole'
      AND NOT (r ? 'accepted_roster');
  END;
  PERFORM pg_temp.roster_assert(refused AND (pg_temp.roster_receipt(8800004)).hand_id IS NULL
    AND (pg_temp.roster_row_of(8800004)).table_id IS NULL,
    'a seat generation that is not the dealt row is refused by the existing door; no roster');
END $contradiction$;

-- ═══ C8: the builder refuses what a capsule cannot honestly state ═══════════
DO $builder$
DECLARE s jsonb := pg_temp.roster_stacks('exact'); t timestamptz := transaction_timestamp();
  f text := 'smarter_private.accepted_hand_roster_build';
  b jsonb; one jsonb; eleven jsonb;
BEGIN
  one := jsonb_build_array(s->0);
  eleven := s || s || jsonb_build_array(s->0, s->1, s->2, s->3);
  b := smarter_private.accepted_hand_roster_build('88100000-0000-0000-0000-000000000001', 8800009, pg_temp.roster_id(9), one, true, '{}', t);
  PERFORM pg_temp.roster_assert(b = '{"status":"unavailable","reasons":["actor_count_below_two"],"roster":null}'::jsonb, 'one actor is unavailable');
  b := smarter_private.accepted_hand_roster_build('88100000-0000-0000-0000-000000000001', 8800009, pg_temp.roster_id(9), eleven, true, '{}', t);
  PERFORM pg_temp.roster_assert(b->>'status' = 'unavailable' AND b->'reasons' = '["actor_count_above_ten"]', 'eleven actors are unavailable');
  b := smarter_private.accepted_hand_roster_build('88100000-0000-0000-0000-000000000001', 8800009, pg_temp.roster_id(9), s, true,
    '{"10000000-0000-0000-0000-000000000001":"88100000-0000-0000-0000-000000000009"}', t);
  PERFORM pg_temp.roster_assert(b->'reasons' = '["lightning_seat_positions_unbound"]', 'a Lightning anchor hand is unavailable');
  b := smarter_private.accepted_hand_roster_build('88100000-0000-0000-0000-000000000001', 8800009, pg_temp.roster_id(9),
    jsonb_set(s, '{0,seat_id}', '"88300000-0000-0000-0000-0000000000ff"'), true, '{}', t);
  PERFORM pg_temp.roster_assert(b->'reasons' = '["seat_generation_row_missing"]' AND b->'roster' = 'null', 'an unknown seat generation is unavailable');
  b := smarter_private.accepted_hand_roster_build('88100000-0000-0000-0000-000000000001', 8800009, pg_temp.roster_id(9),
    jsonb_set(s, '{0,seat_joined_at}', '"2026-10-06T10:00:01.123457+00:00"'), true, '{}', t);
  PERFORM pg_temp.roster_assert(b->'reasons' = '["seat_generation_row_missing"]', 'a contradictory joined-at is unavailable');
  b := smarter_private.accepted_hand_roster_build('88100000-0000-0000-0000-000000000001', 8800009, pg_temp.roster_id(9),
    s || jsonb_build_array(s->0), true, '{}', t);
  PERFORM pg_temp.roster_assert(b->'reasons' = '["duplicate_seat_number","duplicate_seat_id","duplicate_actor"]', 'a duplicated generation is unavailable');
  b := smarter_private.accepted_hand_roster_build('88100000-0000-0000-0000-000000000001', 8800009, pg_temp.roster_id(9),
    jsonb_set(s, '{0,seat_joined_at}', '"2026-10-06 10:00:01.123456+00"'), true, '{}', t);
  PERFORM pg_temp.roster_assert(b->'reasons' = '["seat_joined_at_format"]', 'a joined-at text JavaScript cannot parse is unavailable');
  b := smarter_private.accepted_hand_roster_build('88100000-0000-0000-0000-000000000001', 8800009, pg_temp.roster_id(9),
    s, true, '{}', '2026-10-06T10:00:05+00:00');
  PERFORM pg_temp.roster_assert(b->'reasons' = '["seat_joined_after_capture"]', 'a seat joined after capture is unavailable');
  b := smarter_private.accepted_hand_roster_build('88100000-0000-0000-0000-000000000001', 8800009, pg_temp.roster_id(9), s, false, '{}', t);
  PERFORM pg_temp.roster_assert(b->'reasons' = '["legacy_stack_seat_generation"]', 'non-exact stacks are unavailable');
  b := smarter_private.accepted_hand_roster_build('88100000-0000-0000-0000-000000000001', 8800009, pg_temp.roster_id(9),
    jsonb_set(s, '{0,seat_id}', '"not-a-uuid"'), true, '{}', t);
  PERFORM pg_temp.roster_assert(b->>'status' = 'unavailable' AND b->'reasons' = '["roster_producer_error:22P02"]',
    'an unexpected builder error is caught inside the builder and named by sqlstate');
  BEGIN
    -- Replica mode skips the cascading RI trigger: only this way can a seated
    -- player's profile row be absent, which is exactly what is being proved.
    SET LOCAL session_replication_role = replica;
    DELETE FROM public.profiles WHERE id = '88200000-0000-0000-0000-000000000006';
    SET LOCAL session_replication_role = origin;
    b := smarter_private.accepted_hand_roster_build('88100000-0000-0000-0000-000000000001', 8800009, pg_temp.roster_id(9), s, true, '{}', t);
    PERFORM pg_temp.roster_assert(b->>'status' = 'captured' AND EXISTS (SELECT 1 FROM jsonb_array_elements(b#>'{roster,actors}') x
        WHERE x->>'userId' = '88200000-0000-0000-0000-000000000006'
          AND x->>'classification' = 'unknown' AND x->>'status' = 'profile_missing'),
      'a missing profile row is an explicit unknown with status profile_missing');
    RAISE EXCEPTION 'restore profile' USING ERRCODE = 'P9001';
  EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL; END;
  b := smarter_private.accepted_hand_roster_build('88100000-0000-0000-0000-000000000001', 8800009, pg_temp.roster_id(9), s, true, '{}', t);
  PERFORM pg_temp.roster_assert(b->>'status' = 'captured' AND b->'reasons' = '[]'
    AND NOT EXISTS (SELECT 1 FROM smarter_private.accepted_hand_rosters WHERE hand_number = 8800009),
    'the builder writes nothing');
END $builder$;

-- ═══ C9: the discriminator is private and immutable ═════════════════════════
DO $authority$
DECLARE denied boolean; action text; d smarter_private.accepted_hand_rosters := pg_temp.roster_row_of(8800001);
BEGIN
  PERFORM pg_temp.roster_assert(d.table_id IS NOT NULL, 'a captured row exists to attack');
  FOREACH action IN ARRAY ARRAY[
    'UPDATE smarter_private.accepted_hand_rosters SET status=status',
    'UPDATE smarter_private.accepted_hand_rosters SET roster=NULL,status=''unavailable'',reasons=ARRAY[''x'']',
    'DELETE FROM smarter_private.accepted_hand_rosters',
    'TRUNCATE smarter_private.accepted_hand_rosters'] LOOP
    denied := false;
    BEGIN EXECUTE action; EXCEPTION WHEN SQLSTATE '55000' THEN denied := SQLERRM = 'ACCEPTED_ROSTER_IMMUTABLE'; END;
    PERFORM pg_temp.roster_assert(denied, 'immutable: ' || action);
  END LOOP;
  denied := false;
  BEGIN
    INSERT INTO smarter_private.accepted_hand_rosters(table_id, hand_number, hand_id, post_commit_payload_hash, status, reasons, roster, captured_txid)
    VALUES (d.table_id, 8800010, d.hand_id, d.post_commit_payload_hash, 'captured', '{}', d.roster, 1);
  EXCEPTION WHEN SQLSTATE '55000' THEN denied := SQLERRM = 'ACCEPTED_ROSTER_TRANSACTION_REQUIRED'; END;
  PERFORM pg_temp.roster_assert(denied, 'a row claiming another transaction is refused');
  denied := false;
  BEGIN
    INSERT INTO smarter_private.accepted_hand_rosters(table_id, hand_number, hand_id, post_commit_payload_hash, status, reasons, roster)
    VALUES (d.table_id, 8800010, d.hand_id, d.post_commit_payload_hash, 'captured', '{}', d.roster);
  EXCEPTION WHEN SQLSTATE '55000' THEN denied := SQLERRM = 'ACCEPTED_ROSTER_RECEIPT_REQUIRED'; END;
  PERFORM pg_temp.roster_assert(denied, 'a row with no matching receipt and final payload hash is refused');
  denied := false;
  BEGIN
    INSERT INTO smarter_private.accepted_hand_rosters(table_id, hand_number, hand_id, post_commit_payload_hash, status, reasons, roster)
    VALUES (d.table_id, d.hand_number, d.hand_id, d.post_commit_payload_hash, 'captured', '{}', d.roster);
  EXCEPTION WHEN unique_violation THEN denied := true; END;
  PERFORM pg_temp.roster_assert(denied, 'a second row for an accepted hand is refused');
  PERFORM pg_temp.roster_assert(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r
      WHERE has_table_privilege(r, 'smarter_private.accepted_hand_rosters', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'))
    AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN unnest(ARRAY['anon','authenticated','service_role']) r
      WHERE n.nspname = 'smarter_private' AND p.proname LIKE 'accepted_hand_roster%' AND has_function_privilege(r, p.oid, 'EXECUTE'))
    AND has_function_privilege('service_role', 'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)', 'EXECUTE'),
    'no client or service role can read, write or call the private roster; the door ACL is unchanged');
  denied := false;
  BEGIN
    SET LOCAL ROLE service_role;
    PERFORM count(*) FROM smarter_private.accepted_hand_rosters;
  EXCEPTION WHEN insufficient_privilege THEN denied := true; END;
  RESET ROLE;
  PERFORM pg_temp.roster_assert(denied, 'service_role is refused a direct read of the private roster');
END $authority$;

SELECT 'ACCEPTED_ROSTER_NATIVE_PASS';
