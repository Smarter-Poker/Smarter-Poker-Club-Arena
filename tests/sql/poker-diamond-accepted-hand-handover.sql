-- A DIAMOND TABLE CHANGES ENGINES AND ITS CUSTODY COMES THROUGH EXACTLY
-- (Diamond Phase 11, line 3: one engine owner per table, safe release and recovery.)
--
-- Runs after the accepted-hand acceptance, on the one table whose Diamond hand
-- 1000002 the engine "fixture-engine" (generation ...0001) has committed. The
-- engine then crashes, a successor takes the table, the dead engine's late
-- delivery arrives, the successor re-delivers the committed hand and deals the
-- next one, and finally hands the table over on a clean release. Custody,
-- seats, purchase lots and receipts must be exactly what one owner at a time
-- produces: nothing lost, nothing doubled.
--
-- The two ownership doors below are production's, captured on 2026-09-30 by
-- scripts/dev/two-engine-ownership/capture-live-doors.py (read-only), and the
-- md5 check after them proves the bytes are unchanged.
CREATE OR REPLACE FUNCTION public.claim_table_lease_v2(p_table_id uuid, p_instance_id text, p_version text DEFAULT NULL::text, p_requested_generation uuid DEFAULT NULL::uuid, p_stale_seconds integer DEFAULT 30)
 RETURNS TABLE(granted boolean, holder text, holder_age_seconds numeric, lease_generation uuid, protocol_version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_holder text;
  v_heartbeat timestamptz;
  v_generation uuid;
  v_protocol integer;
BEGIN
  IF p_table_id IS NULL
     OR length(btrim(COALESCE(p_instance_id, ''))) = 0
     OR p_requested_generation IS NULL THEN
    RAISE EXCEPTION
      'claim_table_lease_v2 requires table_id, instance_id, and requested_generation'
      USING ERRCODE = '22023';
  END IF;
  IF p_stale_seconds IS DISTINCT FROM public.fn_engine_lease_stale_seconds() THEN
    RAISE EXCEPTION 'claim_table_lease_v2 requires the audited 30 second stale window'
      USING ERRCODE = '22023';
  END IF;

  /* A BUSY TABLE KEEPS ITS LEASE (2026-09-12): the takeover waits for every
     in-flight settlement (they hold FOR KEY SHARE on this row). The upsert
     below only takes FOR NO KEY UPDATE on its own, which FOR KEY SHARE does
     not block - so without this the settlement's lock would exclude nothing.
     This is the cash half of the pair claim_tournament_lease_v2 has had since
     2026-09-10. */
  PERFORM 1 FROM public.engine_table_leases l
   WHERE l.table_id = p_table_id
   FOR UPDATE;

  INSERT INTO public.engine_table_leases AS l (
    table_id,
    instance_id,
    engine_version,
    acquired_at,
    heartbeat_at,
    lease_generation,
    protocol_version
  ) VALUES (
    p_table_id,
    p_instance_id,
    p_version,
    clock_timestamp(),
    clock_timestamp(),
    p_requested_generation,
    2
  )
  ON CONFLICT (table_id) DO UPDATE
     SET instance_id = EXCLUDED.instance_id,
         engine_version = EXCLUDED.engine_version,
         acquired_at = CASE
           WHEN l.protocol_version = 2
            AND l.instance_id = EXCLUDED.instance_id
            AND l.lease_generation = EXCLUDED.lease_generation THEN l.acquired_at
           ELSE clock_timestamp()
         END,
         heartbeat_at = clock_timestamp(),
         lease_generation = EXCLUDED.lease_generation,
         protocol_version = 2
   WHERE (
       l.protocol_version = 2
       AND l.instance_id = EXCLUDED.instance_id
       AND l.lease_generation = EXCLUDED.lease_generation
     )
      OR (
       l.protocol_version < 2
       AND l.instance_id = EXCLUDED.instance_id
     )
      OR (
           l.heartbeat_at < clock_timestamp() - make_interval(
             secs => public.fn_engine_lease_stale_seconds()
           )
       AND l.lease_generation IS DISTINCT FROM EXCLUDED.lease_generation
         )
  RETURNING l.instance_id,
            l.heartbeat_at,
            l.lease_generation,
            l.protocol_version
       INTO v_holder, v_heartbeat, v_generation, v_protocol;

  IF v_holder IS NOT NULL THEN
    RETURN QUERY SELECT true, v_holder, 0::numeric, v_generation, v_protocol;
    RETURN;
  END IF;

  SELECT l.instance_id,
         l.heartbeat_at,
         l.lease_generation,
         l.protocol_version
    INTO v_holder, v_heartbeat, v_generation, v_protocol
    FROM public.engine_table_leases l
   WHERE l.table_id = p_table_id;

  RETURN QUERY
    SELECT false,
           v_holder,
           round(extract(epoch FROM (clock_timestamp() - v_heartbeat))::numeric, 1),
           v_generation,
           v_protocol;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.release_table_leases_v2(p_instance_id text, p_claims jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_deleted integer;
BEGIN
  IF length(btrim(COALESCE(p_instance_id, ''))) = 0
     OR p_claims IS NULL
     OR jsonb_typeof(p_claims) <> 'array' THEN
    RAISE EXCEPTION 'release_table_leases_v2 requires instance_id and a JSON claim array'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_claims) item
     WHERE jsonb_typeof(item) <> 'object'
        OR length(btrim(COALESCE(item ->> 'table_id', ''))) = 0
        OR length(btrim(COALESCE(item ->> 'lease_generation', ''))) = 0
  ) THEN
    RAISE EXCEPTION 'release_table_leases_v2 requires one exact generation per claim'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    WITH asked AS (
      SELECT (item ->> 'table_id')::uuid AS id
        FROM jsonb_array_elements(p_claims) item
    )
    SELECT 1 FROM asked GROUP BY id HAVING count(*) <> 1
  ) THEN
    RAISE EXCEPTION 'release_table_leases_v2 refuses duplicate tables'
      USING ERRCODE = '22023';
  END IF;

  WITH asked AS MATERIALIZED (
    SELECT (item ->> 'table_id')::uuid AS table_id,
           (item ->> 'lease_generation')::uuid AS lease_generation
      FROM jsonb_array_elements(p_claims) item
  )
  DELETE FROM public.engine_table_leases l
   USING asked a
   WHERE l.table_id = a.table_id
     AND l.instance_id = p_instance_id
     AND l.protocol_version = 2
     AND l.lease_generation = a.lease_generation;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$
;

SELECT fixture_assert(md5(pg_get_functiondef('public.claim_table_lease_v2(uuid,text,text,uuid,integer)'::regprocedure))
 ='2c6a2555d927c8dbbad47b8ac7b60552','the production claim door (md5 2c6a2555d927c8dbbad47b8ac7b60552) decides who owns the Diamond table');
SELECT fixture_assert(md5(pg_get_functiondef('public.release_table_leases_v2(text,jsonb)'::regprocedure))
 ='a08340dd1708cd37530e8b66e3c2a1d9','the production release door (md5 a08340dd1708cd37530e8b66e3c2a1d9) hands it back');

CREATE FUNCTION fixture_next_hand(p_hand bigint, p_winner uuid) RETURNS fixture_accepted_payload
LANGUAGE plpgsql AS $$
DECLARE p fixture_accepted_payload%ROWTYPE;
BEGIN
 SELECT * INTO p FROM fixture_accepted_payload;
 SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'seat_id',id,'seat_joined_at',joined_at,
  'stack_before',stack,'stack',CASE WHEN user_id=p_winner THEN stack+50 ELSE stack-50 END) ORDER BY user_id),
  jsonb_agg(jsonb_build_object('userId',user_id,'seat',seat_number,
  'stack',CASE WHEN user_id=p_winner THEN stack+50 ELSE stack-50 END) ORDER BY user_id)
  INTO p.stacks, p.hand_row FROM table_seats;
 p.hand_row := jsonb_set(jsonb_set(jsonb_set((SELECT hand_row FROM fixture_accepted_payload),
  '{hand_number}',to_jsonb(p_hand)),'{players}',p.hand_row),
  '{winners}',jsonb_build_array(jsonb_build_object('userId',p_winner,'amount',100)));
 RETURN p;
END $$;
CREATE FUNCTION fixture_accept_as(p_instance text, p_lease uuid, p fixture_accepted_payload) RETURNS jsonb
LANGUAGE sql AS $$
 SELECT fn_ca_commit_hand_settlement('30000000-0000-0000-0000-000000000001',(p.hand_row->>'hand_number')::bigint,p.stacks,0,0,null,0,
  p.hand_row,'[]'::jsonb,p_instance,p_lease,p.obligations)
$$;
CREATE TABLE fixture_handover_before AS SELECT fixture_accepted_state() s;
CREATE TABLE fixture_hand_1000003 AS SELECT fixture_next_hand(1000003,'10000000-0000-0000-0000-000000000001') p;

-- 1. While its dealer heartbeats, nobody else may take the table.
UPDATE engine_table_leases SET heartbeat_at=clock_timestamp() WHERE table_id='30000000-0000-0000-0000-000000000001';
SELECT fixture_assert((SELECT NOT granted AND holder='fixture-engine' FROM claim_table_lease_v2('30000000-0000-0000-0000-000000000001','successor-engine',
 'phase-11','70000000-0000-0000-0000-00000000000b',30)),'while its dealer heartbeats, a second engine cannot take the Diamond table');

-- 2. The dealer crashes (no release). Once it has been silent for 30 seconds the successor takes the table.
UPDATE engine_table_leases SET heartbeat_at=clock_timestamp()-interval '31 seconds' WHERE table_id='30000000-0000-0000-0000-000000000001';
SELECT fixture_assert((SELECT granted AND lease_generation='70000000-0000-0000-0000-00000000000b' FROM claim_table_lease_v2('30000000-0000-0000-0000-000000000001','successor-engine',
 'phase-11','70000000-0000-0000-0000-00000000000b',30)),'after 30 silent seconds the successor takes the Diamond table under a new generation');

-- 3. The dead engine's late delivery of its next hand is refused and moves nothing.
SELECT fixture_assert(fixture_accept_as('fixture-engine','70000000-0000-0000-0000-000000000001',(SELECT p FROM fixture_hand_1000003))->>'reason'
 ='hand_lease_lost','the crashed engine''s late Diamond hand is refused after the takeover');
SELECT fixture_assert(fixture_accepted_state()=(SELECT s FROM fixture_handover_before),
 'the refused late hand moved no custody, stack, purchase lot or receipt');

-- 4. The successor re-delivers the hand the crashed engine had committed (its answer was lost in the crash).
DO $$ DECLARE r jsonb; BEGIN
 r:=fixture_accept_as('successor-engine','70000000-0000-0000-0000-00000000000b',(SELECT p FROM fixture_accepted_payload p));
 PERFORM fixture_assert(r->>'success' IS DISTINCT FROM 'true' OR r->>'replay'='true',
  format('the committed hand re-delivered by the successor is never settled a second time (it answered %s)',
   COALESCE(r->>'reason',CASE WHEN r->>'replay'='true' THEN 'replay of the original receipt' END,r::text)));
 PERFORM fixture_assert(fixture_accepted_state()=(SELECT s FROM fixture_handover_before),
  'custody, stacks, lots and receipts are exactly as the crashed engine left them');
END $$;

-- 5. The successor deals the next hand; every Diamond is still accounted for.
SELECT fixture_assert(fixture_accept_as('successor-engine','70000000-0000-0000-0000-00000000000b',(SELECT p FROM fixture_hand_1000003))->>'success'
 ='true','the successor deals the next Diamond hand on the same seats');
SELECT fixture_assert((SELECT sum(balance)=600 FROM poker_diamond_custody WHERE state='active')
 AND (SELECT stack=300 FROM table_seats WHERE seat_number=1) AND (SELECT stack=300 FROM table_seats WHERE seat_number=2)
 AND (SELECT count(*)=2 FROM hand_atomic_commits),
 'across the crash and takeover custody holds 600 Diamonds, both seats are exact and two hands are committed once each');

-- 6. A clean release (the sealed release's docker stop) hands the table over at once, and the old generation is dead.
SELECT fixture_assert(release_table_leases_v2('successor-engine',jsonb_build_array(jsonb_build_object(
 'table_id','30000000-0000-0000-0000-000000000001','lease_generation','70000000-0000-0000-0000-00000000000b')))=1,'a clean stop releases exactly its own generation');
SELECT fixture_assert((SELECT granted FROM claim_table_lease_v2('30000000-0000-0000-0000-000000000001','replacement-engine','phase-11','70000000-0000-0000-0000-00000000000c',30)),
 'a released Diamond table is claimable at once, with no staleness wait');
SELECT fixture_assert(fixture_accept_as('successor-engine','70000000-0000-0000-0000-00000000000b',fixture_next_hand(1000004,
 '10000000-0000-0000-0000-000000000002'))->>'reason'='hand_lease_lost',
 'the released generation cannot commit another Diamond hand');
SELECT fixture_assert((SELECT sum(balance)=600 FROM poker_diamond_custody WHERE state='active'),
 'after a crash, a takeover, a late delivery, a re-delivery and a release: 600 Diamonds in custody, none lost, none doubled');
