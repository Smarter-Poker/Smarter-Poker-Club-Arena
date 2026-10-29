-- 20261028233353_durable_private_hand_continuation
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-28 23:33:53 UTC.
--
-- Restart admission discarded unfinished legacy snapshots because they omitted
-- the private controller/deck. Retain each new original before its events or
-- action acknowledgement, claim it under the current lease without rewriting
-- its permit, and finish through the existing atomic financial owner once.
-- A complete unacted PLO5 river can retain its exact saved original with an
-- explicitly unavailable unused deck; recovery never invents cards or actions.
-- Native PG17 exercises exact current captured financial owners, second
-- restarts at final retention/acceptance, original-generation fences, guarded
-- dispositions, permissions/freeze, MVCC races and full rollback comparisons.
-- Install database-first through the protected applier; engine activation and
-- natural live continuation are separate evidence. No periodic repair owns it.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- No FK to a hot table, public grant, or realtime publication. This contains
-- every private hole card and the future deck, not a player-facing snapshot.
CREATE TABLE smarter_private.hand_continuations (
  table_id uuid NOT NULL,
  hand_number bigint NOT NULL CHECK (hand_number > 0),
  tournament_id uuid NOT NULL,
  permit_id uuid NOT NULL UNIQUE,
  original_generation uuid NOT NULL,
  writer_generation uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence >= 0),
  payload text NOT NULL CHECK (octet_length(payload) <= 1048576),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (table_id, hand_number)
);
ALTER TABLE smarter_private.hand_continuations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.hand_continuations FROM PUBLIC, anon, authenticated, service_role;
CREATE UNIQUE INDEX hand_continuation_one_open ON smarter_private.hand_continuations (table_id);

-- A unique disposition fence, rather than an EXISTS-only trigger, also
-- refuses an abort/closer whose repeatable-read snapshot predates retention.
CREATE TABLE smarter_private.hand_continuation_dispositions (
  table_id uuid NOT NULL, hand_number bigint NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('retained', 'disposed')),
  PRIMARY KEY (table_id, hand_number)
);
ALTER TABLE smarter_private.hand_continuation_dispositions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.hand_continuation_dispositions FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER hand_continuation_disposition_immutable BEFORE UPDATE OR DELETE ON smarter_private.hand_continuation_dispositions
 FOR EACH ROW EXECUTE FUNCTION smarter_private.hand_submission_immutable();
CREATE TRIGGER hand_continuation_disposition_no_truncate BEFORE TRUNCATE ON smarter_private.hand_continuation_dispositions
 FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.hand_submission_immutable();

CREATE FUNCTION smarter_private.assert_hand_continuation_disposition(tab uuid, hn bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE d text;
BEGIN
  INSERT INTO smarter_private.hand_continuation_dispositions(table_id, hand_number, disposition)
    VALUES(tab, hn, 'disposed') ON CONFLICT(table_id, hand_number) DO NOTHING;
  SELECT disposition INTO STRICT d FROM smarter_private.hand_continuation_dispositions
   WHERE table_id = tab AND hand_number = hn;
  IF d <> 'disposed' THEN RAISE EXCEPTION 'HAND_CONTINUATION_UNSETTLED' USING ERRCODE = '55000'; END IF;
END $body$;
REVOKE ALL ON FUNCTION smarter_private.assert_hand_continuation_disposition(uuid,bigint) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.fn_f06_retain_hand_continuation(
  p_tournament_id uuid, p_lease_generation uuid, p_table_id uuid,
  p_hand_number bigint, p_sequence bigint, p_payload text, p_sha256 text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, smarter_private AS $body$
DECLARE h smarter_private.f06_hand_permits; c smarter_private.hand_continuations; v jsonb;
BEGIN
  IF NOT pg_try_advisory_xact_lock_shared(530090,1) THEN
    RAISE EXCEPTION 'HAND_CONTINUATION_MAINTENANCE_BUSY' USING ERRCODE='55P03'; END IF;
  PERFORM smarter_private.f06_prefix(p_tournament_id, p_lease_generation, '{}', ARRAY[p_table_id]);
  IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'PLATFORM_FROZEN'; END IF;
  IF p_sequence IS NULL OR p_sequence < 0 OR p_hand_number IS NULL OR p_hand_number < 1
     OR p_payload IS NULL OR octet_length(p_payload) > 1048576
     OR p_sha256 IS NULL OR p_sha256 !~ '^[a-f0-9]{64}$'
     OR encode(extensions.digest(p_payload, 'sha256'), 'hex') IS DISTINCT FROM p_sha256 THEN
    RAISE EXCEPTION 'HAND_CONTINUATION_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  v := p_payload::jsonb;
  SELECT * INTO h FROM smarter_private.f06_hand_permits
   WHERE table_id = p_table_id AND hand_number = p_hand_number
     AND tournament_id = p_tournament_id FOR UPDATE;
  IF h.permit_id IS NULL OR h.state <> 'reserved' OR h.evidence_id IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM public.tables tb WHERE tb.id = p_table_id
                     AND tb.tournament_id = p_tournament_id AND tb.f06_lifecycle = h.lifecycle)
     OR EXISTS (SELECT 1 FROM public.hand_atomic_commits a
                 WHERE a.table_id = p_table_id AND a.hand_number >= p_hand_number)
     OR EXISTS (SELECT 1 FROM public.hand_history hh
                 WHERE hh.table_id = p_table_id AND hh.hand_number >= p_hand_number)
     OR EXISTS (SELECT 1 FROM smarter_private.hand_submission_dispositions d
                 WHERE d.table_id = p_table_id AND d.hand_number = p_hand_number AND d.disposition = 'disposed') THEN
    RAISE EXCEPTION 'HAND_CONTINUATION_ORIGINAL_UNPROVEN' USING ERRCODE = '55000';
  END IF;
  IF v->>'version' IS DISTINCT FROM '1' OR v#>>'{batch,version}' IS DISTINCT FROM '1'
     OR v#>>'{batch,sequence}' IS DISTINCT FROM p_sequence::text
     OR v#>>'{original,tournament_id}' IS DISTINCT FROM h.tournament_id::text
     OR v#>>'{original,table_id}' IS DISTINCT FROM h.table_id::text
     OR v#>>'{original,hand_number}' IS DISTINCT FROM h.hand_number::text
     OR v#>>'{original,permit_id}' IS DISTINCT FROM h.permit_id::text
     OR v#>>'{original,lifecycle}' IS DISTINCT FROM h.lifecycle::text
     OR v#>>'{original,custody_id}' IS DISTINCT FROM h.custody_id::text
     OR v#>>'{original,lease_generation}' IS DISTINCT FROM h.generation::text
     OR jsonb_typeof(v->'seats') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v#>'{batch,events}') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v#>'{batch,engine}') IS DISTINCT FROM 'object'
     OR jsonb_typeof(v#>'{batch,controller}') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'HAND_CONTINUATION_BINDING_CHANGED' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(v->'seats') NOT BETWEEN 2 AND 9
     OR (SELECT count(DISTINCT x->>'user_id') FROM jsonb_array_elements(v->'seats') x)
          <> jsonb_array_length(v->'seats') THEN
    RAISE EXCEPTION 'HAND_CONTINUATION_ROSTER_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO c FROM smarter_private.hand_continuations
   WHERE table_id = p_table_id AND hand_number = p_hand_number FOR UPDATE;
  IF FOUND THEN
    IF c.writer_generation IS DISTINCT FROM p_lease_generation
       OR c.original_generation IS DISTINCT FROM h.generation OR c.permit_id IS DISTINCT FROM h.permit_id
       OR c.payload::jsonb->'seats' IS DISTINCT FROM v->'seats' THEN
      RAISE EXCEPTION 'HAND_CONTINUATION_WRITER_FENCED' USING ERRCODE = '42501';
    END IF;
    IF c.sequence = p_sequence AND c.payload = p_payload AND c.payload_sha256 = p_sha256 THEN
      RETURN jsonb_build_object('ok', true, 'table_id', p_table_id, 'hand_number', p_hand_number::text,
        'sequence', p_sequence::text, 'sha256', p_sha256, 'writer_generation', c.writer_generation);
    END IF;
    IF p_sequence <> c.sequence + 1 THEN RAISE EXCEPTION 'HAND_CONTINUATION_SEQUENCE_CHANGED' USING ERRCODE = '55000'; END IF;
    UPDATE smarter_private.hand_continuations SET sequence = p_sequence, payload = p_payload,
      payload_sha256 = p_sha256, updated_at = clock_timestamp()
     WHERE table_id = p_table_id AND hand_number = p_hand_number;
  ELSE
    IF h.generation IS DISTINCT FROM p_lease_generation OR p_sequence <> 0
       OR v#>'{batch,events}' <> '[]'::jsonb THEN
      RAISE EXCEPTION 'HAND_CONTINUATION_ANCHOR_REQUIRED' USING ERRCODE = '55000';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v->'seats') x
                WHERE NOT EXISTS (SELECT 1 FROM public.table_seats s
                  WHERE s.id::text = x->>'seat_id' AND s.table_id = p_table_id
                    AND s.user_id::text = x->>'user_id' AND s.left_at IS NULL
                    AND s.joined_at = (x->>'seat_joined_at')::timestamptz
                    AND s.stack = (x->>'stack_before')::numeric)) THEN
      RAISE EXCEPTION 'HAND_CONTINUATION_ROSTER_CHANGED' USING ERRCODE = '55000';
    END IF;
    INSERT INTO smarter_private.hand_continuation_dispositions(table_id, hand_number, disposition)
      VALUES(p_table_id, p_hand_number, 'retained') ON CONFLICT(table_id, hand_number) DO NOTHING;
    IF NOT EXISTS (SELECT 1 FROM smarter_private.hand_continuation_dispositions d
                   WHERE d.table_id = p_table_id AND d.hand_number = p_hand_number AND d.disposition = 'retained') THEN
      RAISE EXCEPTION 'HAND_CONTINUATION_ALREADY_DISPOSED' USING ERRCODE = '55000';
    END IF;
    INSERT INTO smarter_private.hand_continuations
      (table_id, hand_number, tournament_id, permit_id, original_generation, writer_generation,
       sequence, payload, payload_sha256)
    VALUES (p_table_id, p_hand_number, p_tournament_id, h.permit_id, h.generation,
      p_lease_generation, p_sequence, p_payload, p_sha256);
  END IF;
  RETURN jsonb_build_object('ok', true, 'table_id', p_table_id, 'hand_number', p_hand_number::text,
    'sequence', p_sequence::text, 'sha256', p_sha256, 'writer_generation', p_lease_generation);
END $body$;

CREATE FUNCTION public.fn_f06_claim_hand_continuation(
  p_tournament_id uuid, p_lease_generation uuid, p_table_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, smarter_private AS $body$
DECLARE c smarter_private.hand_continuations; h smarter_private.f06_hand_permits;
BEGIN
  IF NOT pg_try_advisory_xact_lock_shared(530090,1) THEN
    RAISE EXCEPTION 'HAND_CONTINUATION_MAINTENANCE_BUSY' USING ERRCODE='55P03'; END IF;
  PERFORM smarter_private.f06_prefix(p_tournament_id, p_lease_generation, '{}', ARRAY[p_table_id]);
  IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'PLATFORM_FROZEN'; END IF;
  SELECT * INTO c FROM smarter_private.hand_continuations
   WHERE table_id = p_table_id AND tournament_id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', true, 'table_id', p_table_id, 'continuation', NULL); END IF;
  SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE permit_id = c.permit_id FOR UPDATE;
  IF h.state IS DISTINCT FROM 'reserved' OR h.evidence_id IS NOT NULL
     OR h.table_id IS DISTINCT FROM p_table_id OR h.tournament_id IS DISTINCT FROM p_tournament_id
     OR h.hand_number IS DISTINCT FROM c.hand_number OR h.generation IS DISTINCT FROM c.original_generation
     OR NOT EXISTS (SELECT 1 FROM public.tables tb WHERE tb.id = p_table_id
                     AND tb.tournament_id = p_tournament_id AND tb.f06_lifecycle = h.lifecycle)
     OR EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits n
                 WHERE n.table_id = p_table_id AND n.hand_number > c.hand_number)
     OR EXISTS (SELECT 1 FROM public.hand_atomic_commits a
                 WHERE a.table_id = p_table_id AND a.hand_number >= c.hand_number)
     OR EXISTS (SELECT 1 FROM public.hand_history hh
                 WHERE hh.table_id = p_table_id AND hh.hand_number >= c.hand_number)
     OR EXISTS (SELECT 1 FROM smarter_private.hand_submissions s
                 WHERE s.table_id = p_table_id AND s.hand_number = c.hand_number) THEN
    RAISE EXCEPTION 'HAND_CONTINUATION_CLAIM_UNPROVEN' USING ERRCODE = '55000';
  END IF;
  -- Never replace a chair, rewind a stack, or erase a separate add-on to
  -- manufacture recovery. Current authority fences the previous writer.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(c.payload::jsonb->'seats') x
              WHERE NOT EXISTS (SELECT 1 FROM public.table_seats s
                WHERE s.id::text = x->>'seat_id' AND s.table_id = p_table_id
                  AND s.user_id::text = x->>'user_id' AND s.left_at IS NULL
                  AND s.joined_at = (x->>'seat_joined_at')::timestamptz
                  AND s.stack = (x->>'stack_before')::numeric)) THEN
    RAISE EXCEPTION 'HAND_CONTINUATION_ROSTER_CHANGED' USING ERRCODE = '55000';
  END IF;
  UPDATE smarter_private.hand_continuations SET writer_generation = p_lease_generation,
    updated_at = clock_timestamp() WHERE table_id = p_table_id AND hand_number = c.hand_number;
  RETURN jsonb_build_object('ok', true, 'table_id', p_table_id, 'writer_generation', p_lease_generation,
    'continuation', jsonb_build_object('payload', c.payload, 'sha256', c.payload_sha256,
      'sequence', c.sequence::text, 'hand_number', c.hand_number::text));
END $body$;

-- Legacy snapshots do not contain an unused deck. Only a fully dealt,
-- unacted single-board PLO5 river can be anchored without inventing cards.
-- The next decision remains the original actor's decision, not a recovery vote.
CREATE FUNCTION public.fn_f06_claim_legacy_river_continuation(
 p_tournament_id uuid, p_lease_generation uuid, p_table_id uuid,
 p_hand_number bigint, p_snapshot_updated_at timestamptz, p_payload text, p_sha256 text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, smarter_private AS $body$
DECLARE h smarter_private.f06_hand_permits; snap public.hand_state_snapshots;
 v jsonb; ctrl jsonb; st jsonb; d text;
BEGIN
 IF NOT pg_try_advisory_xact_lock_shared(530090,1) THEN
  RAISE EXCEPTION 'HAND_CONTINUATION_MAINTENANCE_BUSY' USING ERRCODE='55P03'; END IF;
 PERFORM smarter_private.f06_prefix(p_tournament_id,p_lease_generation,'{}',ARRAY[p_table_id]);
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'PLATFORM_FROZEN'; END IF;
 IF p_hand_number IS NULL OR p_hand_number<1 OR p_payload IS NULL
  OR octet_length(p_payload)>1048576 OR p_sha256 IS NULL OR p_sha256 !~ '^[a-f0-9]{64}$'
  OR encode(extensions.digest(p_payload,'sha256'),'hex') IS DISTINCT FROM p_sha256 THEN
  RAISE EXCEPTION 'HAND_CONTINUATION_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 v:=p_payload::jsonb;
 SELECT * INTO h FROM smarter_private.f06_hand_permits
  WHERE table_id=p_table_id AND hand_number=p_hand_number AND tournament_id=p_tournament_id FOR UPDATE;
 SELECT * INTO snap FROM public.hand_state_snapshots
  WHERE table_id=p_table_id AND hand_number=p_hand_number FOR UPDATE;
 IF h.permit_id IS NULL OR h.state<>'reserved' OR h.evidence_id IS NOT NULL
  OR h.generation=p_lease_generation OR snap.table_id IS NULL OR snap.is_complete
  OR snap.updated_at IS DISTINCT FROM p_snapshot_updated_at
  OR NOT EXISTS(SELECT 1 FROM public.tables t WHERE t.id=p_table_id
   AND t.tournament_id=p_tournament_id AND t.f06_lifecycle=h.lifecycle)
  OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits p WHERE p.table_id=p_table_id AND p.hand_number>p_hand_number)
  OR EXISTS(SELECT 1 FROM public.hand_atomic_commits a WHERE a.table_id=p_table_id AND a.hand_number>=p_hand_number)
  OR EXISTS(SELECT 1 FROM public.hand_history a WHERE a.table_id=p_table_id AND a.hand_number>=p_hand_number)
  OR EXISTS(SELECT 1 FROM smarter_private.hand_submissions a WHERE a.table_id=p_table_id AND a.hand_number=p_hand_number)
  OR EXISTS(SELECT 1 FROM smarter_private.hand_submission_dispositions a WHERE a.table_id=p_table_id AND a.hand_number=p_hand_number)
 THEN RAISE EXCEPTION 'HAND_CONTINUATION_LEGACY_ORIGINAL_UNPROVEN' USING ERRCODE='55000'; END IF;
 IF v->>'version' IS DISTINCT FROM '1' OR v#>>'{batch,version}' IS DISTINCT FROM '1'
  OR v#>>'{batch,sequence}' IS DISTINCT FROM '0' OR v#>'{batch,events}' IS DISTINCT FROM '[]'::jsonb
  OR jsonb_typeof(v#>'{batch,engine}') IS DISTINCT FROM 'object'
  OR v->'original' IS DISTINCT FROM jsonb_build_object('tournament_id',h.tournament_id::text,
   'table_id',h.table_id::text,'hand_number',h.hand_number::text,'permit_id',h.permit_id::text,
   'lifecycle',h.lifecycle::text,'custody_id',h.custody_id::text,'lease_generation',h.generation::text)
 THEN RAISE EXCEPTION 'HAND_CONTINUATION_BINDING_CHANGED' USING ERRCODE='22023'; END IF;
 ctrl:=(v#>>'{batch,controller}')::jsonb; st:=snap.state_json;
 IF ctrl->'state' IS DISTINCT FROM st OR ctrl->>'version' IS DISTINCT FROM '1'
  OR (ctrl->'config') - 'isTournament' - 'asset' IS DISTINCT FROM snap.config_json
  OR ctrl#>>'{config,isTournament}' IS DISTINCT FROM 'true'
  OR (ctrl#>>'{config,asset}' IS NOT NULL AND ctrl#>>'{config,asset}'<>'chips')
  OR snap.config_json->>'ante' IS DISTINCT FROM '0'
  OR (snap.config_json->>'smallBlind')::numeric<=0
  OR (snap.config_json->>'bigBlind')::numeric<=(snap.config_json->>'smallBlind')::numeric
  OR st#>>'{actionHistory,0,publicNode,street}' IS DISTINCT FROM 'preflop'
  OR ctrl->'postedBlindSeats' IS DISTINCT FROM jsonb_build_object(
   'smallBlind',(SELECT (seat->>0)::integer FROM jsonb_array_elements(st#>'{actionHistory,0,publicNode,seats}') seat
    WHERE (seat->>2)::numeric=(snap.config_json->>'smallBlind')::numeric),
   'bigBlind',(SELECT (seat->>0)::integer FROM jsonb_array_elements(st#>'{actionHistory,0,publicNode,seats}') seat
    WHERE (seat->>2)::numeric=(snap.config_json->>'bigBlind')::numeric))
  OR (SELECT sum((p->>'totalInvested')::numeric) FROM jsonb_array_elements(st->'players') p)
   IS DISTINCT FROM (st->>'pot')::numeric
  OR snap.config_json->>'gameVariant' IS DISTINCT FROM 'plo5'
  OR snap.config_json->>'tableId' IS DISTINCT FROM p_table_id::text
  OR snap.config_json->>'handNumber' IS DISTINCT FROM p_hand_number::text
  OR snap.config_json#>>'{rakeConfig,percent}' IS DISTINCT FROM '0'
  OR snap.config_json#>>'{rakeConfig,cap}' IS DISTINCT FROM '0'
  OR snap.config_json#>>'{bbjConfig,enabled}' IS DISTINCT FROM 'false'
  OR coalesce((snap.config_json->>'bombPot')::boolean,false)
  OR coalesce((snap.config_json->>'killPot')::boolean,false)
  OR coalesce((snap.config_json->>'allInOrFold')::boolean,false)
  OR coalesce((snap.config_json->>'insuranceEnabled')::boolean,false)
  OR snap.stage IS DISTINCT FROM 'river' OR st->>'stage' IS DISTINCT FROM 'river'
  OR st->>'currentBet' IS DISTINCT FROM '0' OR st->>'sawFlop' IS DISTINCT FROM 'true'
  OR jsonb_array_length(st->'communityCards')<>5
  OR st->'communityCards2' IS DISTINCT FROM '[]'::jsonb OR st->'communityCards3' IS DISTINCT FROM '[]'::jsonb
  OR ctrl->>'deckAvailability' IS DISTINCT FROM 'unused_after_river' OR ctrl->'deck' IS DISTINCT FROM '[]'::jsonb
  OR ctrl->>'handStarted' IS DISTINCT FROM 'true' OR ctrl->>'handCompleted' IS DISTINCT FROM 'false'
  OR ctrl->>'handFsm' IS DISTINCT FROM 'river' OR ctrl->'riverCalled' IS DISTINCT FROM '[]'::jsonb
  OR ctrl->>'activeBoardCount' IS DISTINCT FROM '1' OR ctrl->>'allInShowdownLocked' IS DISTINCT FROM 'false'
  OR ctrl->'allInRunoutWitness' IS DISTINCT FROM 'null'::jsonb
  OR ctrl->'pineappleDiscardsRemaining' IS DISTINCT FROM '[]'::jsonb
  OR ctrl->'pineappleKnownDeadCards' IS DISTINCT FROM '[]'::jsonb
  OR ctrl->'preparedPineappleRunoutDiscards' IS DISTINCT FROM 'null'::jsonb
  OR ctrl->'pendingPerPotAwards' IS DISTINCT FROM '[]'::jsonb
  OR coalesce(ctrl->'pendingWinnersByBoard','[]'::jsonb)<>'[]'::jsonb
  OR jsonb_array_length(st->'actionHistory')<1
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(st->'actionHistory') a
   WHERE a->>'stage'='river' OR a#>>'{publicNode,mode}' IS DISTINCT FROM 'tournament'
    OR a#>>'{publicNode,asset}' IS DISTINCT FROM 'chips'
    OR a#>>'{publicNode,bombPot}' IS DISTINCT FROM 'false'
    OR a#>>'{publicNode,allInOrFold}' IS DISTINCT FROM 'false'
    OR a#>>'{publicNode,boardCount}' IS DISTINCT FROM '1')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(st->'players') p WHERE p->>'bet' IS DISTINCT FROM '0'
   OR p->>'is_all_in' IS DISTINCT FROM 'false' OR (p->>'stack')::numeric<0 OR (p->>'totalInvested')::numeric<0
   OR coalesce((p->>'returnedUncalled')::numeric,0)<>0 OR jsonb_array_length(p->'cards')<>5)
  OR (SELECT count(*) FROM jsonb_array_elements(st->'players') p
   WHERE p->>'is_folded'='false' AND p->>'is_sitting_out'='false')<>2
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(st->'players') p WHERE p->>'seat'=st->>'currentPlayerSeat'
   AND p->>'is_folded'='false' AND p->>'is_sitting_out'='false')
 THEN RAISE EXCEPTION 'HAND_CONTINUATION_LEGACY_RIVER_UNPROVEN' USING ERRCODE='55000'; END IF;
 IF jsonb_typeof(v->'seats') IS DISTINCT FROM 'array'
  OR jsonb_array_length(v->'seats') NOT BETWEEN 2 AND 9
  OR jsonb_array_length(v->'seats')<>jsonb_array_length(st->'players')
  OR (SELECT count(DISTINCT p->>'user_id') FROM jsonb_array_elements(v->'seats') p)<>jsonb_array_length(v->'seats')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(v->'seats') x WHERE NOT EXISTS(
   SELECT 1 FROM public.table_seats s JOIN jsonb_array_elements(st->'players') p ON p->>'user_id'=s.user_id::text
   WHERE s.id::text=x->>'seat_id' AND s.table_id=p_table_id AND s.left_at IS NULL
    AND s.user_id::text=x->>'user_id' AND s.joined_at=(x->>'seat_joined_at')::timestamptz
    AND s.joined_at<=snap.created_at AND s.seat_number=(p->>'seat')::integer
    AND s.stack=(x->>'stack_before')::numeric
    AND s.stack=(p->>'stack')::numeric+(p->>'totalInvested')::numeric))
 THEN RAISE EXCEPTION 'HAND_CONTINUATION_ROSTER_CHANGED' USING ERRCODE='55000'; END IF;
 -- Every check and the unique retention fence share the current F06 lane.
 INSERT INTO smarter_private.hand_continuation_dispositions VALUES(p_table_id,p_hand_number,'retained')
  ON CONFLICT(table_id,hand_number) DO NOTHING;
 SELECT disposition INTO STRICT d FROM smarter_private.hand_continuation_dispositions
  WHERE table_id=p_table_id AND hand_number=p_hand_number;
 IF d<>'retained' THEN RAISE EXCEPTION 'HAND_CONTINUATION_ALREADY_DISPOSED' USING ERRCODE='55000'; END IF;
 INSERT INTO smarter_private.hand_continuations(table_id,hand_number,tournament_id,permit_id,
  original_generation,writer_generation,sequence,payload,payload_sha256)
 VALUES(p_table_id,p_hand_number,p_tournament_id,h.permit_id,h.generation,p_lease_generation,0,p_payload,p_sha256)
 ON CONFLICT(table_id,hand_number) DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM smarter_private.hand_continuations c WHERE c.table_id=p_table_id
  AND c.hand_number=p_hand_number AND c.payload=p_payload AND c.payload_sha256=p_sha256 AND c.sequence=0
  AND c.writer_generation=p_lease_generation) THEN
  RAISE EXCEPTION 'HAND_CONTINUATION_LEGACY_ANCHOR_CHANGED' USING ERRCODE='55000'; END IF;
 RETURN jsonb_build_object('ok',true,'table_id',p_table_id,'hand_number',p_hand_number::text,
  'sequence','0','sha256',p_sha256,'writer_generation',p_lease_generation);
END $body$;
REVOKE ALL ON FUNCTION public.fn_f06_claim_legacy_river_continuation(uuid,uuid,uuid,bigint,timestamptz,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_claim_legacy_river_continuation(uuid,uuid,uuid,bigint,timestamptz,text,text) TO service_role;

-- Final submission retains the current writer's authority while preserving
-- the original permit identity. No claimed terminal capsule means no exception.
DO $pre$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_retain_hand_submission(jsonb)'::regprocedure
  AND md5(prosrc)='147a21c2e799b4e2f8df443c79f77cd0' AND pg_get_userbyid(proowner)='postgres'
  AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND prosecdef
  AND proconfig::text='{"search_path=pg_catalog, public, extensions"}') THEN
  RAISE EXCEPTION 'HAND_CONTINUATION_GUARD_PREIMAGE_CHANGED: fn_ca_retain_hand_submission'; END IF;
END $pre$;
CREATE OR REPLACE FUNCTION public.fn_ca_retain_hand_submission(p_request jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'extensions'
AS $function$
DECLARE s smarter_private.hand_submissions; h smarter_private.f06_hand_permits;
 d smarter_private.hand_submission_dispositions;
 tid uuid; hn bigint; sid uuid; instance text; generation uuid; tour uuid; locked_tour uuid;
 holder text; lease uuid; protocol integer; beat timestamptz; request_hash text;
BEGIN
 IF jsonb_typeof(p_request) IS DISTINCT FROM 'object'
 OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_request) k) IS DISTINCT FROM
 ARRAY['p_bbj','p_hand_number','p_hand_row','p_inflow','p_instance_id','p_lease_generation','p_post_commit_obligations','p_rake','p_ref','p_stacks','p_table_id','p_units']
 OR jsonb_typeof(p_request->'p_stacks') IS DISTINCT FROM 'array'
 OR jsonb_typeof(p_request->'p_hand_row') IS DISTINCT FROM 'object'
 OR jsonb_typeof(p_request->'p_post_commit_obligations') IS DISTINCT FROM 'object'
 OR jsonb_typeof(p_request->'p_units') IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_INVALID_REQUEST' USING ERRCODE='22023';
 END IF;
 tid:=(p_request->>'p_table_id')::uuid; hn:=(p_request->>'p_hand_number')::bigint;
 sid:=(p_request->'p_hand_row'->>'id')::uuid;
 instance:=p_request->>'p_instance_id'; generation:=(p_request->>'p_lease_generation')::uuid;
 IF tid IS NULL OR hn IS NULL OR hn<=0 OR sid IS NULL OR generation IS NULL OR length(btrim(COALESCE(instance,'')))=0
 OR (p_request->'p_hand_row'->>'table_id')::uuid IS DISTINCT FROM tid
 OR (p_request->'p_hand_row'->>'hand_number')::bigint IS DISTINCT FROM hn THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_INVALID_IDENTITY' USING ERRCODE='22023';
 END IF;
 PERFORM public.fn_ca_share_settlement_lane_for_table(tid);
 PERFORM smarter_private.assert_retained_hand_submission(p_request);
 SELECT * INTO s FROM smarter_private.hand_submissions WHERE table_id=tid AND hand_number=hn;
 IF FOUND THEN
  RETURN jsonb_build_object('retained',true,'submission_id',s.submission_id,'request_hash',s.request_hash,'replay',true);
 END IF;
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE table_id=tid AND hand_number=hn;
 IF FOUND THEN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('f06:hand:'||h.permit_id::text,0)) THEN
   RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE='55P03'; END IF;
  SELECT * INTO STRICT h FROM smarter_private.f06_hand_permits WHERE permit_id=h.permit_id;
  IF h.state NOT IN ('reserved','accepted') OR (h.generation IS DISTINCT FROM generation AND NOT EXISTS(
   SELECT 1 FROM smarter_private.hand_continuations c
    WHERE c.table_id=tid AND c.hand_number=hn AND c.tournament_id=h.tournament_id
     AND c.permit_id=h.permit_id AND c.original_generation=h.generation AND c.writer_generation=generation
     AND (c.payload::jsonb#>>'{batch,controller}')::jsonb->>'handCompleted'='true'
     AND jsonb_array_length(p_request->'p_stacks')=jsonb_array_length(c.payload::jsonb->'seats')
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.payload::jsonb->'seats') orig WHERE NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(p_request->'p_stacks') final
       WHERE final->>'user_id'=orig->>'user_id' AND final->>'seat_id'=orig->>'seat_id'
        AND (final->>'seat_joined_at')::timestamptz=(orig->>'seat_joined_at')::timestamptz
        AND (final->>'stack_before')::numeric=(orig->>'stack_before')::numeric)))) THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_PERMIT_FENCED' USING ERRCODE='55000'; END IF;
 END IF;
 SELECT tournament_id INTO tour FROM public.tables WHERE id=tid;
 IF NOT FOUND THEN RAISE EXCEPTION 'HAND_SUBMISSION_TABLE_MISSING' USING ERRCODE='55000'; END IF;
 IF tour IS NOT NULL AND (h.permit_id IS NULL OR h.tournament_id IS DISTINCT FROM tour) THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_ORIGINAL_PERMIT_REQUIRED' USING ERRCODE='55000'; END IF;
 IF tour IS NULL THEN
  SELECT instance_id,lease_generation,protocol_version,heartbeat_at INTO holder,lease,protocol,beat
  FROM public.engine_table_leases WHERE table_id=tid FOR KEY SHARE;
 ELSE
  SELECT instance_id,lease_generation,protocol_version,heartbeat_at INTO holder,lease,protocol,beat
  FROM public.engine_tournament_leases WHERE tournament_id=tour FOR KEY SHARE;
 END IF;
 -- A LAPSED CASH LEASE STILL RETAINS ITS FINISHED HAND (2026-10-04). Retention
 -- moves no money: fn_ca_resume_hand_submission settles the request only under
 -- a successor's own fresh lease, after proving the original never settled it
 -- and that every chair, before-stack and hand number is unchanged. A cash
 -- original whose heartbeat went stale while its finished hand was in flight
 -- may therefore still retain it while the lease names its exact instance and
 -- generation. Taken, released or re-claimed still refuses. A tournament
 -- retention keeps the fresh-heartbeat requirement.
 IF holder IS DISTINCT FROM instance OR lease IS DISTINCT FROM generation OR protocol IS DISTINCT FROM 2
 OR beat IS NULL OR (tour IS NOT NULL
   AND beat<clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds())) THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_LEASE_UNPROVEN' USING ERRCODE='55000'; END IF;
 IF tour IS NOT NULL THEN PERFORM 1 FROM public.tournaments WHERE id=tour FOR SHARE; END IF;
 SELECT tournament_id INTO locked_tour FROM public.tables WHERE id=tid FOR UPDATE;
 IF NOT FOUND OR locked_tour IS DISTINCT FROM tour THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_SCOPE_CHANGED' USING ERRCODE='55000'; END IF;
 INSERT INTO smarter_private.hand_submission_dispositions(table_id,hand_number,permit_id,disposition,submission_id)
 VALUES(tid,hn,h.permit_id,'retained',sid) ON CONFLICT(table_id,hand_number) DO NOTHING;
 SELECT * INTO STRICT d FROM smarter_private.hand_submission_dispositions WHERE table_id=tid AND hand_number=hn;
 IF d.disposition<>'retained' OR d.submission_id IS DISTINCT FROM sid OR d.permit_id IS DISTINCT FROM h.permit_id THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_PERMIT_DISPOSED' USING ERRCODE='55000'; END IF;
 request_hash:=encode(extensions.digest(convert_to(p_request::text,'UTF8'),'sha256'),'hex');
 INSERT INTO smarter_private.hand_submissions(submission_id,table_id,hand_number,instance_id,lease_generation,request,request_hash)
 VALUES(sid,tid,hn,instance,generation,p_request,request_hash);
 RETURN jsonb_build_object('retained',true,'submission_id',sid,'request_hash',request_hash,'replay',false);
END $function$
;

-- A second restart after this claimed controller retained its final request
-- must continue that same final request, not reject its original permit.
DO $pre$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure
  AND md5(prosrc)='416aa6d77fb3999e393587e6f12de751' AND pg_get_userbyid(proowner)='postgres'
  AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND prosecdef
  AND proconfig::text='{"search_path=pg_catalog, public"}') THEN
  RAISE EXCEPTION 'HAND_CONTINUATION_GUARD_PREIMAGE_CHANGED: fn_ca_resume_hand_submission'; END IF;
END $pre$;
CREATE OR REPLACE FUNCTION public.fn_ca_resume_hand_submission(p_table_id uuid, p_instance_id text, p_lease_generation uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE s smarter_private.hand_submissions; h smarter_private.f06_hand_permits;
 a public.hand_atomic_commits; q jsonb; r jsonb; post jsonb; finished jsonb;
 tour uuid; locked_tour uuid; holder text; generation uuid; protocol integer; beat timestamptz;
 users uuid[]; code text; message text; claimed boolean:=false; evidence text;
 mark bigint; lo bigint; hi bigint; window_rows integer; windows integer:=0;
 retirement_restored boolean:=false;
 retired_cash_restored boolean:=false;
 source_corrected boolean:=false; source_proof jsonb;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'HAND_SUBMISSION_ENGINE_ONLY' USING ERRCODE='42501'; END IF;
 -- THE READ STARTS AT THE TABLE'S SETTLED MARK, A BOUNDED WINDOW AT A TIME
 -- (2026-10-02). This read walked EVERY submission the table ever retained
 -- (23,405 rows on one cash table, a heap fetch each in a 33 GB relation) to
 -- answer "nothing unfinished": 1.8 s warm, past the 8 s statement timeout
 -- cold, 15,085 timeouts in 12 hours, and each one refused the table's start.
 -- A finished submission stays finished (disposals and submissions are
 -- immutable; a completed post-commit is never reopened; a permit is
 -- reserved only for a new, higher hand), and only the current lease
 -- generation can retain, after this start, a higher hand number. So every
 -- hand at or below the mark is settled for ever, and the walk resumes above
 -- it. Windows of 200 hands are read until two seconds of this statement
 -- have passed (a cold hand costs ~2 random reads: 2,500 timed out at 5 s on
 -- 2026-10-02 09:25 and a 500 window started late still passed 8 s at 10:20);
 -- a table with more unread history keeps its progress and answers pending,
 -- which every caller already retries.
 SELECT m.settled_through INTO mark FROM smarter_private.hand_submission_resume_marks m
  WHERE m.table_id=p_table_id;
 lo:=COALESCE(mark,-1);
 LOOP
  SELECT max(w.hand_number),count(*) INTO hi,window_rows FROM (SELECT j.hand_number
    FROM smarter_private.hand_submissions j WHERE j.table_id=p_table_id AND j.hand_number>lo
    ORDER BY j.hand_number LIMIT 200) w;
  s:=NULL;
  EXIT WHEN window_rows=0;
  SELECT j.* INTO s FROM smarter_private.hand_submissions j
  LEFT JOIN public.hand_atomic_commits c ON c.table_id=j.table_id AND c.hand_number=j.hand_number
  LEFT JOIN smarter_private.f06_hand_permits p ON p.table_id=j.table_id AND p.hand_number=j.hand_number
  WHERE j.table_id=p_table_id AND j.hand_number>lo AND j.hand_number<=hi
  AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_disposals dd
    WHERE dd.table_id=j.table_id AND dd.hand_number=j.hand_number)
  AND (c.hand_id IS DISTINCT FROM j.submission_id OR c.post_commit_completed_at IS NULL
    OR c.post_commit_result->>'ok' IS DISTINCT FROM 'true' OR p.state='reserved')
  ORDER BY j.hand_number LIMIT 1;
  EXIT WHEN FOUND;
  lo:=hi; windows:=windows+1;
  EXIT WHEN window_rows<200;
  IF clock_timestamp()-statement_timestamp()>interval '2 seconds' THEN
   INSERT INTO smarter_private.hand_submission_resume_marks(table_id,settled_through,marked_at)
    VALUES(p_table_id,lo,clock_timestamp())
   ON CONFLICT(table_id) DO UPDATE SET settled_through=greatest(hand_submission_resume_marks.settled_through,EXCLUDED.settled_through),marked_at=EXCLUDED.marked_at;
   RETURN jsonb_build_object('found',true,'completed',false,'reason','resume_scan_continues','settled_through',lo::text);
  END IF;
 END LOOP;
 IF lo>COALESCE(mark,-1) THEN
  INSERT INTO smarter_private.hand_submission_resume_marks(table_id,settled_through,marked_at)
   VALUES(p_table_id,lo,clock_timestamp())
  ON CONFLICT(table_id) DO UPDATE SET settled_through=greatest(hand_submission_resume_marks.settled_through,EXCLUDED.settled_through),marked_at=EXCLUDED.marked_at;
 END IF;
 IF s.submission_id IS NULL THEN RETURN jsonb_build_object('found',false); END IF;
 -- This is startup continuation, not an in-flight original settlement. Keep
 -- both financial handoff and accepted postcommit behind the existing freeze
 -- boundary, before any lease or lifecycle lane. Refusal spends no claim.
 IF NOT pg_try_advisory_xact_lock_shared(530090,1) THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_MAINTENANCE_BUSY' USING ERRCODE='55P03'; END IF;
 IF public.fn_platform_frozen() THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_PLATFORM_FROZEN' USING ERRCODE='55000'; END IF;
 SELECT tournament_id INTO tour FROM public.tables WHERE id=p_table_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'HAND_SUBMISSION_TABLE_MISSING' USING ERRCODE='55000'; END IF;
 IF tour IS NOT NULL THEN
  IF EXISTS(SELECT 1 FROM smarter_private.retirement_original_hand_qualification c WHERE c.submission_id=s.submission_id) THEN
   PERFORM public.fn_ca_lock_settlement_lane_for_tournament(tour,p_table_id);
  END IF;
  SELECT array_agg((x->>'user_id')::uuid ORDER BY x->>'user_id') INTO users FROM jsonb_array_elements(s.request->'p_stacks') x;
  PERFORM smarter_private.f06_prefix(tour,p_lease_generation,users,ARRAY[p_table_id]);
  SELECT instance_id,lease_generation,protocol_version,heartbeat_at INTO holder,generation,protocol,beat
   FROM public.engine_tournament_leases WHERE tournament_id=tour FOR KEY SHARE;
 ELSE
  SELECT instance_id,lease_generation,protocol_version,heartbeat_at INTO holder,generation,protocol,beat
   FROM public.engine_table_leases WHERE table_id=p_table_id FOR KEY SHARE;
  PERFORM public.fn_ca_share_settlement_lane_for_table(p_table_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('hand:submission:'||s.table_id::text||':'||s.hand_number::text,0));
  PERFORM 1 FROM public.tables WHERE id=p_table_id FOR UPDATE;
  PERFORM 1 FROM public.table_seats WHERE table_id=p_table_id ORDER BY id FOR UPDATE;
 END IF;
 IF holder IS DISTINCT FROM p_instance_id OR generation IS DISTINCT FROM p_lease_generation OR protocol IS DISTINCT FROM 2
 OR beat IS NULL OR beat<clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds()) THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_LEASE_UNPROVEN' USING ERRCODE='55000'; END IF;
 SELECT tournament_id INTO locked_tour FROM public.tables WHERE id=p_table_id;
 IF locked_tour IS DISTINCT FROM tour THEN RAISE EXCEPTION 'HAND_SUBMISSION_SCOPE_CHANGED' USING ERRCODE='55000'; END IF;
 -- A HAND THIS CASH TABLE HAS ALREADY DEALT PAST IS DISPOSED AT ITS DOOR
 -- (2026-09-29). A later committed hand consumed the before-stacks this
 -- request names, so nobody can ever apply it; the receipted, zero-credit
 -- disposal is written here, under this caller's proven lease and the
 -- table's locks, and the next unfinished request is read. A tournament
 -- table's dead hands stay with the F06 abort doors.
 -- A REFUSED HAND WHOSE CHAIRS HAVE ALL CLOSED IS DISPOSED HERE TOO
 -- (2026-10-09): rolled back, never durable, and no chair left to apply it to.
 IF tour IS NULL AND ((EXISTS(SELECT 1 FROM public.hand_atomic_commits
   WHERE table_id=p_table_id AND hand_number>s.hand_number)
  AND smarter_private.hand_submission_dispose_dealt_past(p_table_id,s.hand_number)>0)
  OR smarter_private.hand_submission_dispose_refused_vacated(p_table_id,s.submission_id)>0) THEN
  -- The next unfinished request, read above the hands just disposed and
  -- inside the window already proven: everything at or below lo is settled.
  SELECT j.* INTO s FROM smarter_private.hand_submissions j
  LEFT JOIN public.hand_atomic_commits c ON c.table_id=j.table_id AND c.hand_number=j.hand_number
  LEFT JOIN smarter_private.f06_hand_permits p ON p.table_id=j.table_id AND p.hand_number=j.hand_number
  WHERE j.table_id=p_table_id AND j.hand_number>lo AND j.hand_number<=hi
  AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_disposals dd
    WHERE dd.table_id=j.table_id AND dd.hand_number=j.hand_number)
  AND (c.hand_id IS DISTINCT FROM j.submission_id OR c.post_commit_completed_at IS NULL
    OR c.post_commit_result->>'ok' IS DISTINCT FROM 'true' OR p.state='reserved')
  ORDER BY j.hand_number LIMIT 1;
  IF NOT FOUND AND window_rows>=200 THEN
   RETURN jsonb_build_object('found',true,'completed',false,'reason','resume_scan_continues','settled_through',lo::text); END IF;
  IF NOT FOUND THEN RETURN jsonb_build_object('found',false); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hand:submission:'||s.table_id::text||':'||s.hand_number::text,0));
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('hand:submission:'||s.table_id::text||':'||s.hand_number::text,0));
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE table_id=s.table_id AND hand_number=s.hand_number;
 IF tour IS NOT NULL THEN
  IF h.permit_id IS NULL OR h.tournament_id IS DISTINCT FROM tour OR (h.generation IS DISTINCT FROM s.lease_generation AND NOT EXISTS(
    SELECT 1 FROM smarter_private.hand_continuations c WHERE c.table_id=s.table_id
     AND c.hand_number=s.hand_number AND c.tournament_id=h.tournament_id AND c.permit_id=h.permit_id
     AND c.original_generation=h.generation AND c.writer_generation=s.lease_generation
     AND (c.payload::jsonb#>>'{batch,controller}')::jsonb->>'handCompleted'='true'))
   OR h.state NOT IN('reserved','accepted') THEN RAISE EXCEPTION 'HAND_SUBMISSION_ORIGINAL_PERMIT_REQUIRED' USING ERRCODE='55000'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('f06:hand:'||h.permit_id::text,0)) THEN
   RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE='55P03'; END IF;
 END IF;
 SELECT * INTO a FROM public.hand_atomic_commits WHERE table_id=s.table_id AND hand_number=s.hand_number;
 IF FOUND THEN
  IF a.hand_id IS DISTINCT FROM s.submission_id OR a.post_commit_payload IS NULL THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_ACCEPTANCE_UNPROVEN' USING ERRCODE='55000'; END IF;
  r:=a.stack_result||jsonb_build_object('success',true,'atomic_hand_commit',true,'history_id',a.hand_id,
    'commit_hash',a.payload_hash,'post_commit_obligations',true,'post_commit_payload_hash',a.post_commit_payload_hash);
 ELSE
  IF EXISTS(SELECT 1 FROM smarter_private.hand_submission_handoffs WHERE submission_id=s.submission_id) THEN
   source_proof:=smarter_private.original_hand_source_correction_proof(s.submission_id);
   IF source_proof IS NULL OR NOT EXISTS(SELECT FROM smarter_private.hand_submission_source_corrections c WHERE c.submission_id=s.submission_id AND c.proof=source_proof)
    OR EXISTS(SELECT FROM smarter_private.hand_submission_correction_claims c WHERE c.submission_id=s.submission_id) THEN
    RETURN jsonb_build_object('found',true,'completed',false,'submission_id',s.submission_id,'reason','successor_financial_claim_spent');END IF;
   source_corrected:=true;
  END IF;
  -- The original generation owns its own door; it is never its own successor.
  IF s.lease_generation=p_lease_generation THEN
   RETURN jsonb_build_object('found',true,'completed',false,'submission_id',s.submission_id,'reason','original_failure_or_handoff_unproven'); END IF;
  -- A canonical failure row is one proof that the original cannot settle this
  -- hand. The other is read here: the scope lease holds this caller's
  -- generation, not the original's, and this transaction has held that row
  -- FOR KEY SHARE since it was verified, so no takeover or release can move
  -- it until this transaction ends. Every settlement of this hand holds this
  -- hand's submission lock (taken above) from before its own lease check to
  -- its end, and the atomic receipt read under that lock found nothing. So the
  -- original never settled this hand, cannot settle it while its generation is
  -- not the lease, and if it ever holds the lease again it can only replay the
  -- payload-identical receipt this one handoff writes.
  IF generation IS DISTINCT FROM p_lease_generation OR generation IS NOT DISTINCT FROM s.lease_generation THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_LEASE_UNPROVEN' USING ERRCODE='55000'; END IF;
  evidence:=CASE WHEN EXISTS(SELECT 1 FROM smarter_private.hand_submission_failures f
   WHERE f.submission_id=s.submission_id AND f.request_hash=s.request_hash)
   THEN 'canonical_failure' ELSE 'superseded_generation' END;
  -- The original exact generations and before-stacks must still occupy the
  -- table. No later hand/permit may have consumed this starting state.
  -- A chair taken AFTER this hand was dealt is not part of it: it was not
  -- dealt in, the hand cannot move its chips, and the committed stacks name
  -- only the hand's own seats. Such a chair must not hold the finished hand
  -- hostage (2026-09-26, 8ec7e81d: a late registrant seated 30 s after the
  -- hand ended froze its table for eight days). A chair that was present at
  -- the deal and is missing from the submission is admitted only when the
  -- hand declares no inflow, the hand's own record never names its player,
  -- and every player the record names is in the submission (2026-09-29,
  -- 6c9ee4b6: two horses seated 43 s and 18 s before the deal, not dealt in,
  -- froze the table for six days). The settlement still refuses any
  -- non-conserving stack set, so a dealt player left out of the stacks can
  -- never settle. A hand player seated twice still refuses; an undated deal
  -- refuses.
  q:=s.request;
  retirement_restored:=smarter_private.restore_retired_original_tournament_hand(s.submission_id,p_instance_id,p_lease_generation);
  retired_cash_restored:=smarter_private.adopt_retired_cash_original_hand(s.submission_id,p_instance_id,p_lease_generation);
  IF NOT EXISTS(SELECT 1 FROM public.tables WHERE id=s.table_id
      AND NOT COALESCE(is_deleted,false) AND lower(status) IN ('waiting','running')
      -- Cash tables are 'live', or 'breaking' while the table is being closed
      -- (2026-09-29, 499aa67a): the original commit never refused a breaking
      -- cash table, so its successor must not either. A tournament table keeps
      -- NULL until it closes; 'closed' still refuses everywhere.
      AND (lifecycle='live' OR (tour IS NULL AND lifecycle='breaking') OR (tour IS NOT NULL AND lifecycle IS NULL)))
   OR (tour IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id=tour AND upper(status)='RUNNING')) THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_TABLE_NOT_ADMITTED' USING ERRCODE='55000'; END IF;
  IF jsonb_array_length(q->'p_stacks')=0 OR
   (q->'p_hand_row'->>'started_at') IS NULL
   OR EXISTS(SELECT 1 FROM public.table_seats late WHERE late.table_id=s.table_id AND late.left_at IS NULL
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q->'p_stacks') x WHERE (x->>'seat_id')::uuid=late.id)
     AND ((late.joined_at<=(q->'p_hand_row'->>'started_at')::timestamptz
         AND (strpos((q->'p_hand_row')::text,late.user_id::text)>0
           OR COALESCE((q->>'p_inflow')::numeric,0)<>0
           OR jsonb_typeof(q->'p_hand_row'->'players') IS DISTINCT FROM 'array'
           OR EXISTS(SELECT 1 FROM jsonb_array_elements(q->'p_hand_row'->'players') hp
             WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q->'p_stacks') x WHERE x->>'user_id'=hp->>'userId'))))
       OR late.user_id IN (SELECT (x->>'user_id')::uuid FROM jsonb_array_elements(q->'p_stacks') x)))
   OR (SELECT count(DISTINCT x->>'seat_id') FROM jsonb_array_elements(q->'p_stacks') x)<>jsonb_array_length(q->'p_stacks')
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(q->'p_stacks') x WHERE NOT EXISTS(
     SELECT 1 FROM smarter_private.retired_cash_hand_custody r
      WHERE r.submission_id=s.submission_id AND r.request_hash=s.request_hash AND r.state='held'
       AND r.transaction_id=txid_current() AND r.user_id=(x->>'user_id')::uuid
       AND r.seat_id=(x->>'seat_id')::uuid AND r.occupancy_id=(x->>'occupancy_id')::uuid
       AND r.seat_joined_at=(x->>'seat_joined_at')::timestamptz
       AND r.stack_before=(x->>'stack_before')::numeric AND r.stack_after=(x->>'stack')::numeric)
    AND NOT EXISTS(
     SELECT 1 FROM public.table_seats seat WHERE seat.table_id=s.table_id AND seat.id=(x->>'seat_id')::uuid
       AND seat.user_id=(x->>'user_id')::uuid AND seat.joined_at=(x->>'seat_joined_at')::timestamptz
       AND seat.left_at IS NULL AND (seat.stack=(x->>'stack_before')::numeric
       -- AN ADD-ON CREDITED WHILE THE HAND WAITED (2026-10-02). A tournament
       -- chair may hold exactly the event's addon_chips more than the hand
       -- dealt from, only when its registration bought the add-on. The
       -- settlement runs in delta mode (every element carries stack_before),
       -- so that credit is preserved, not overwritten.
       OR (tour IS NOT NULL AND EXISTS(SELECT 1 FROM public.tournament_players tp
         JOIN public.tournaments ev ON ev.id=tp.tournament_id
         WHERE tp.tournament_id=tour AND tp.user_id=seat.user_id AND tp.add_on IS TRUE
           AND COALESCE(ev.addon_chips,0)>0
           AND seat.stack=(x->>'stack_before')::numeric+ev.addon_chips)))))
   OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=s.table_id AND hand_number>=s.hand_number)
   OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=s.table_id AND hand_number>=s.hand_number)
   OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=s.table_id AND hand_number>s.hand_number) THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_HANDOFF_STATE_CHANGED' USING ERRCODE='55000'; END IF;
  -- A wait for another lane may outlast the heartbeat or cross the existing
  -- announced freeze clock. Recheck immediately before the irreversible claim.
  IF public.fn_platform_frozen() THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_PLATFORM_FROZEN' USING ERRCODE='55000'; END IF;
  IF tour IS NULL THEN
   SELECT heartbeat_at INTO beat FROM public.engine_table_leases WHERE table_id=s.table_id;
  ELSE
   SELECT heartbeat_at INTO beat FROM public.engine_tournament_leases WHERE tournament_id=tour;
  END IF;
  IF beat IS NULL OR beat<clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds()) THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_LEASE_UNPROVEN' USING ERRCODE='55000'; END IF;
  IF source_corrected THEN
   -- Reprove under original lifecycle/lease/hand locks, immediately before this additive one-time claim.
   IF smarter_private.original_hand_source_correction_proof(s.submission_id) IS DISTINCT FROM source_proof THEN RAISE EXCEPTION 'HAND_SOURCE_CORRECTION_ADMISSION_CHANGED' USING ERRCODE='55000';END IF;
   INSERT INTO smarter_private.hand_submission_correction_claims(submission_id,request_hash,instance_id,lease_generation,transaction_id) VALUES(s.submission_id,s.request_hash,p_instance_id,p_lease_generation,txid_current());
  ELSE
  INSERT INTO smarter_private.hand_submission_handoffs(submission_id,original_generation,instance_id,lease_generation,request_hash,transaction_id)
   VALUES(s.submission_id,s.lease_generation,p_instance_id,p_lease_generation,s.request_hash,txid_current());
  END IF;
  claimed:=true;
  BEGIN
   INSERT INTO smarter_private.hand_submission_dispatch VALUES(txid_current(),s.submission_id,s.request_hash,p_instance_id,p_lease_generation);
   r:=public.fn_ca_commit_hand_settlement(s.table_id,s.hand_number,q->'p_stacks',
    (q->>'p_rake')::numeric,(q->>'p_bbj')::numeric,q->>'p_ref',(q->>'p_inflow')::numeric,
    q->'p_hand_row',q->'p_units',p_instance_id,p_lease_generation,q->'p_post_commit_obligations');
  EXCEPTION WHEN OTHERS THEN
   GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE,message=MESSAGE_TEXT;
   r:=jsonb_build_object('success',false,'atomic_hand_commit',false,'reason','successor_authority_refused','sqlstate',code,'error',message);
  END;
  -- Metadata restoration is valid only if the SAME original hand commits.
  -- A returned or thrown financial refusal rolls back the entire call,
  -- including every restored row, receipt and handoff claim.
  IF (retirement_restored OR retired_cash_restored) AND (r->>'success' IS DISTINCT FROM 'true' OR r->>'atomic_hand_commit' IS DISTINCT FROM 'true') THEN
   RAISE EXCEPTION 'RETIREMENT_ORIGINAL_HAND_NOT_COMMITTED: %',r USING ERRCODE='P0404';
  END IF;
  -- A lock/freeze/lease admission refusal is not the one financial attempt.
  -- Raise outside the caught subtransaction so its claim also rolls back.
  IF r->>'success' IS DISTINCT FROM 'true' AND (
    r->>'sqlstate' IN ('55P03','40001','40P01')
    OR r->>'reason' IN ('hand_lease_lost','hand_lease_stale','hand_lease_scope_changed','invalid_hand_lease_authority')
    OR (r->>'sqlstate'='42501' AND r->>'error'='F06_LEASE_FENCED')
    -- A CODE DEFECT IS NOT THE HAND'S ONE FINANCIAL ATTEMPT (2026-10-15). A
    -- settlement that rolled back on a programming or internal error (class 42,
    -- 0A or XX: an undefined column, a missing function, an internal failure)
    -- says nothing about the hand. Spending the claim on it stranded 217 hands
    -- (record "new" has no field "metadata"), 8 of them freezing Freeroll
    -- a38b88a9 for 35 hours. Raise, so the claim, handoff and dispatch roll back
    -- and the next admission settles the hand once the defect is fixed.
    OR (r->>'reason'='rolled_back' AND left(COALESCE(r->>'sqlstate',''),2) IN ('42','0A','XX'))
    OR public.fn_platform_frozen()) THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_ADMISSION_CHANGED: %',r USING ERRCODE='55P03';
  END IF;
  DELETE FROM smarter_private.hand_submission_dispatch WHERE transaction_id=txid_current() AND submission_id=s.submission_id;
  IF source_corrected THEN
   INSERT INTO smarter_private.hand_submission_correction_results(submission_id,result) VALUES(s.submission_id,r||jsonb_build_object('source_correction',true));
  ELSE
  INSERT INTO smarter_private.hand_submission_handoff_results VALUES(s.submission_id,r||jsonb_build_object('handoff_evidence',evidence));
  END IF;
  IF r->>'success' IS DISTINCT FROM 'true' OR r->>'atomic_hand_commit' IS DISTINCT FROM 'true' THEN
   RETURN jsonb_build_object('found',true,'completed',false,'submission_id',s.submission_id,'reason','successor_financial_refused','outcome',r); END IF;
 END IF;
 r:=smarter_private.acknowledge_hand_submission(s.submission_id,r);
 -- A later current owner may replay this branch after acknowledgment loss.
 -- It never spends or recreates the one-time financial claim.
 BEGIN
  post:=public.fn_ca_process_hand_post_commit_obligations(s.submission_id);
  IF post->>'ok' IS DISTINCT FROM 'true' OR NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits
    WHERE table_id=s.table_id AND hand_number=s.hand_number AND hand_id=s.submission_id
    AND post_commit_completed_at IS NOT NULL AND post_commit_result->>'ok'='true') THEN
   IF retired_cash_restored THEN
    RAISE EXCEPTION 'RETIRED_CASH_ORIGINAL_POSTCOMMIT_NOT_COMPLETED' USING ERRCODE='P0404';
   END IF;
   RETURN r||jsonb_build_object('found',true,'completed',false,'reason','accepted_postcommit_pending'); END IF;
  IF tour IS NOT NULL THEN
   finished:=public.fn_f06_finish_hand(tour,p_lease_generation,h.permit_id,'accepted',s.submission_id);
   IF finished->>'ok' IS DISTINCT FROM 'true' OR finished->>'state' IS DISTINCT FROM 'accepted'
    OR finished->>'evidence_id' IS DISTINCT FROM s.submission_id::text THEN
    RAISE EXCEPTION 'HAND_SUBMISSION_PERMIT_COMPLETION_UNPROVEN' USING ERRCODE='55000'; END IF;
  END IF;
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE,message=MESSAGE_TEXT;
  IF retired_cash_restored THEN
   RAISE EXCEPTION 'RETIRED_CASH_ORIGINAL_POSTCOMMIT_REFUSED: % %',code,message USING ERRCODE='P0404';
  END IF;
  RETURN r||jsonb_build_object('found',true,'completed',false,'reason','accepted_postcommit_pending','sqlstate',code,'error',message);
 END;
 IF retired_cash_restored AND EXISTS(SELECT 1 FROM smarter_private.retired_cash_hand_custody c
  WHERE c.submission_id=s.submission_id AND (c.state IS DISTINCT FROM 'consumed'
   OR c.accepted_time_bank IS DISTINCT FROM c.original_time_bank OR c.settlement_id IS NULL)) THEN
  RAISE EXCEPTION 'RETIRED_CASH_ORIGINAL_CUSTODY_NOT_CONSUMED' USING ERRCODE='P0404';
 END IF;
 RETURN r||jsonb_build_object('found',true,'completed',true,'hand_number',s.hand_number::text,
   'financial_handoff',claimed,'permit_id',h.permit_id,'post_commit_completed',true);
END $function$
;

-- Keep the installed trigger bindings and their existing final-submission
-- guards. Replacing their functions needs no new lock on a hot public table.
DO $pre$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname='hand_submission_snapshot_guard' AND tgenabled='O' AND pg_get_triggerdef(oid)='CREATE TRIGGER hand_submission_snapshot_guard AFTER INSERT OR UPDATE OF is_complete ON public.hand_state_snapshots FOR EACH ROW EXECUTE FUNCTION smarter_private.hand_submission_snapshot_guard()') THEN
    RAISE EXCEPTION 'HAND_CONTINUATION_GUARD_PREIMAGE_CHANGED: trigger hand_submission_snapshot_guard'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname='f06_retained_submission_guard' AND tgenabled='O' AND pg_get_triggerdef(oid)='CREATE TRIGGER f06_retained_submission_guard AFTER UPDATE OF state ON smarter_private.f06_hand_permits FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_retained_submission_guard()') THEN
    RAISE EXCEPTION 'HAND_CONTINUATION_GUARD_PREIMAGE_CHANGED: trigger f06_retained_submission_guard'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'smarter_private.f06_retained_submission_guard()'::regprocedure
    AND md5(prosrc) = '3ada0d8599460649be4fe90e7c338e84' AND pg_get_userbyid(proowner) = 'postgres'
    AND proacl::text = '{postgres=X/postgres}' AND prosecdef
    AND proconfig::text = '{search_path=pg_catalog}') THEN
    RAISE EXCEPTION 'HAND_CONTINUATION_GUARD_PREIMAGE_CHANGED: f06_retained_submission_guard';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'smarter_private.hand_submission_snapshot_guard()'::regprocedure
    AND md5(prosrc) = 'a08b3de2dd259283b0057a69e029380b' AND pg_get_userbyid(proowner) = 'postgres'
    AND proacl::text = '{postgres=X/postgres}' AND prosecdef
    AND proconfig::text = '{search_path=pg_catalog}') THEN
    RAISE EXCEPTION 'HAND_CONTINUATION_GUARD_PREIMAGE_CHANGED: hand_submission_snapshot_guard';
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION smarter_private.f06_retained_submission_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE d smarter_private.hand_submission_dispositions;
BEGIN
 IF NEW.state = 'accepted' AND EXISTS (SELECT 1 FROM smarter_private.hand_continuations c WHERE c.permit_id = NEW.permit_id) THEN
  IF NOT EXISTS (SELECT 1 FROM public.hand_atomic_commits a WHERE a.table_id = NEW.table_id
    AND a.hand_number = NEW.hand_number AND a.hand_id = NEW.evidence_id AND a.post_commit_completed_at IS NOT NULL) THEN
   RAISE EXCEPTION 'HAND_CONTINUATION_ACCEPTANCE_UNPROVEN' USING ERRCODE='55000';
  END IF;
  -- Positive atomic acceptance owns cleanup; no periodic private-deck retention.
  DELETE FROM smarter_private.hand_continuations WHERE permit_id = NEW.permit_id;
 END IF;
 IF NEW.state NOT IN ('never_started','aborted_unsettled') THEN RETURN NEW; END IF;
 PERFORM smarter_private.assert_hand_continuation_disposition(NEW.table_id, NEW.hand_number);
 INSERT INTO smarter_private.hand_submission_dispositions(table_id,hand_number,permit_id,disposition,submission_id)
 VALUES(NEW.table_id,NEW.hand_number,NEW.permit_id,'disposed',NULL) ON CONFLICT(table_id,hand_number) DO NOTHING;
 SELECT * INTO STRICT d FROM smarter_private.hand_submission_dispositions WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number;
 IF d.disposition<>'disposed' OR (d.permit_id IS NOT NULL AND d.permit_id IS DISTINCT FROM NEW.permit_id) THEN
  RAISE EXCEPTION 'F06_RETAINED_HAND_SUBMISSION_REQUIRES_ACCEPTED_DISPOSITION' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION smarter_private.hand_submission_snapshot_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE d smarter_private.hand_submission_dispositions;
BEGIN
 IF NOT NEW.is_complete THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM public.hand_atomic_commits a WHERE a.table_id=NEW.table_id
   AND a.hand_number=NEW.hand_number AND a.hand_id IS NOT NULL AND a.post_commit_payload IS NOT NULL) THEN RETURN NEW; END IF;
 PERFORM smarter_private.assert_hand_continuation_disposition(NEW.table_id, NEW.hand_number);
 IF EXISTS(SELECT 1 FROM smarter_private.hand_submission_disposals dd
   WHERE dd.table_id=NEW.table_id AND dd.hand_number=NEW.hand_number) THEN RETURN NEW; END IF;
 INSERT INTO smarter_private.hand_submission_dispositions(table_id,hand_number,disposition,submission_id)
 VALUES(NEW.table_id,NEW.hand_number,'disposed',NULL) ON CONFLICT(table_id,hand_number) DO NOTHING;
 SELECT * INTO STRICT d FROM smarter_private.hand_submission_dispositions WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number;
 IF d.disposition<>'disposed' THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_ACCEPTANCE_REQUIRED_FOR_COMPLETION' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $function$;

REVOKE ALL ON FUNCTION public.fn_f06_retain_hand_continuation(uuid,uuid,uuid,bigint,bigint,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_f06_claim_hand_continuation(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_retain_hand_continuation(uuid,uuid,uuid,bigint,bigint,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_f06_claim_hand_continuation(uuid,uuid,uuid) TO service_role;
COMMIT;
