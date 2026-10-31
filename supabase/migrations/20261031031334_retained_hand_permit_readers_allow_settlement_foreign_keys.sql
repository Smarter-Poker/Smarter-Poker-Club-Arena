-- @live-proof: EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_f06_retain_hand_continuation(uuid,uuid,uuid,bigint,bigint,text,text)'::regprocedure AND md5(pg_get_functiondef(p.oid))='64833fbf30f5e2011550f6f59f8a7fab' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private'])
-- Production deadlocks: retained save owns table then waits on permit FOR UPDATE;
-- settlement owns the dispatch FK KEY SHARE on that permit then waits on table.
-- Retention does not update the permit. SHARE retains state-writer exclusion
-- while allowing the FK reader. Table/seat and continuation locks are unchanged.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $pin$ BEGIN IF NOT (EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_f06_retain_hand_continuation(uuid,uuid,uuid,bigint,bigint,text,text)'::regprocedure AND md5(pg_get_functiondef(p.oid))='95a7b245fe68c5a361fc04a1362f5b11' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private'])) THEN RAISE EXCEPTION 'RETAIN_PERMIT_READER_PREIMAGE_CHANGED';END IF;END $pin$;
CREATE OR REPLACE FUNCTION public.fn_f06_retain_hand_continuation(p_tournament_id uuid, p_lease_generation uuid, p_table_id uuid, p_hand_number bigint, p_sequence bigint, p_payload text, p_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE h smarter_private.f06_hand_permits; c smarter_private.hand_continuations; v jsonb;
BEGIN
  PERFORM smarter_private.lock_hand_continuation_maintenance_lane();
  PERFORM public.fn_ca_f06_share_table_lane(p_tournament_id, p_lease_generation, p_table_id);
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
     AND tournament_id = p_tournament_id FOR SHARE;
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
END $function$
;
REVOKE ALL ON FUNCTION public.fn_f06_retain_hand_continuation(uuid,uuid,uuid,bigint,bigint,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_retain_hand_continuation(uuid,uuid,uuid,bigint,bigint,text,text) TO service_role;
DO $post$ BEGIN IF NOT (EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_f06_retain_hand_continuation(uuid,uuid,uuid,bigint,bigint,text,text)'::regprocedure AND md5(pg_get_functiondef(p.oid))='64833fbf30f5e2011550f6f59f8a7fab' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private'])) THEN RAISE EXCEPTION 'RETAIN_PERMIT_READER_POSTIMAGE_CHANGED';END IF;END $post$;
COMMIT;
