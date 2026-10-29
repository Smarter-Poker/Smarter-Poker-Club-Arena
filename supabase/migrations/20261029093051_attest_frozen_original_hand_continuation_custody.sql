-- Attest an exact privately retained original during the real maintenance freeze.
-- The claim door must keep refusing writes while frozen. This separate, read-only
-- door returns custody identities and digests, never private controller/deck data.
-- It does not claim, retain, dispose, settle, stop, change a lease or approve restart.
-- @live-proof: EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_f06_attest_frozen_hand_continuation(uuid,uuid,uuid,bigint,bigint,text)') AND md5(p.prosrc)='d47f131bbecd7fd7aaba9873af68285e' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.provolatile='s' AND p.prorettype='jsonb'::regtype AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('smarter_private.attest_frozen_hand_continuation(uuid,uuid,uuid,bigint,bigint,text)') AND md5(p.prosrc)='7e5ebd0b8f622ba6daa596c2d2e45db0' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.provolatile='s' AND p.prorettype='jsonb'::regtype AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private'])
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DO $preimage$
BEGIN
  IF to_regprocedure('public.fn_f06_attest_frozen_hand_continuation(uuid,uuid,uuid,bigint,bigint,text)') IS NOT NULL
     OR to_regprocedure('smarter_private.attest_frozen_hand_continuation(uuid,uuid,uuid,bigint,bigint,text)') IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM pg_proc p
       WHERE p.oid='smarter_private.f06_authority(uuid,uuid,boolean)'::regprocedure
         AND md5(p.prosrc)='939908ee892773e79e04fc73241c3f75'
         AND p.proowner='postgres'::regrole AND p.prosecdef
         AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private'])
     OR to_regclass('smarter_private.hand_continuations') IS NULL THEN
    RAISE EXCEPTION 'HAND_CONTINUATION_ATTESTATION_PREIMAGE_CHANGED' USING ERRCODE='55000';
  END IF;
END $preimage$;

CREATE FUNCTION smarter_private.attest_frozen_hand_continuation(
  p_tournament_id uuid, p_lease_generation uuid, p_table_id uuid,
  p_hand_number bigint, p_sequence bigint, p_payload_sha256 text
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, smarter_private AS $body$
DECLARE
  c smarter_private.hand_continuations;
  h smarter_private.f06_hand_permits;
  v jsonb;
  b public.engine_maintenance_break;
BEGIN
  IF p_tournament_id IS NULL OR p_lease_generation IS NULL OR p_table_id IS NULL
     OR p_hand_number IS NULL OR p_hand_number < 1 OR p_sequence IS NULL
     OR p_sequence NOT BETWEEN 0 AND 9007199254740991
     OR p_payload_sha256 IS NULL OR p_payload_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'HAND_CONTINUATION_ATTESTATION_INPUT_INVALID' USING ERRCODE='22023';
  END IF;
  -- The private kernel is postgres-only. Public callers separately prove their
  -- existing actor authority; neither caller may substitute a different lease.
  IF NOT EXISTS (SELECT 1 FROM public.engine_tournament_leases l
      WHERE l.tournament_id=p_tournament_id AND l.protocol_version=2
        AND l.lease_generation=p_lease_generation
        AND l.heartbeat_at >= clock_timestamp()-interval '30 seconds') THEN
    RAISE EXCEPTION 'F06_LEASE_FENCED' USING ERRCODE='42501';
  END IF;
  SELECT * INTO b FROM public.engine_maintenance_break
   WHERE enforce_freeze AND phase='counting_down'
     AND announced_at <= break_started_at
     AND break_started_at <= clock_timestamp() AND break_ends_at > clock_timestamp()
     AND break_ends_at > break_started_at
     AND break_ends_at < announced_at + interval '15 minutes';
  IF NOT FOUND OR public.fn_platform_frozen() IS NOT TRUE THEN
    RAISE EXCEPTION 'HAND_CONTINUATION_ATTESTATION_REQUIRES_FREEZE' USING ERRCODE='55000';
  END IF;
  SELECT * INTO c FROM smarter_private.hand_continuations
   WHERE tournament_id=p_tournament_id AND table_id=p_table_id AND hand_number=p_hand_number;
  IF NOT FOUND OR c.writer_generation IS DISTINCT FROM p_lease_generation
     OR c.sequence IS DISTINCT FROM p_sequence OR c.payload_sha256 IS DISTINCT FROM p_payload_sha256
     OR octet_length(c.payload) NOT BETWEEN 1 AND 1048576
     OR encode(extensions.digest(convert_to(c.payload,'UTF8'),'sha256'),'hex') IS DISTINCT FROM c.payload_sha256 THEN
    RAISE EXCEPTION 'HAND_CONTINUATION_ATTESTATION_CAPSULE_CHANGED' USING ERRCODE='55000';
  END IF;
  SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE permit_id=c.permit_id;
  IF NOT FOUND OR h.state IS DISTINCT FROM 'reserved' OR h.evidence_id IS NOT NULL
     OR h.table_id IS DISTINCT FROM p_table_id OR h.tournament_id IS DISTINCT FROM p_tournament_id
     OR h.hand_number IS DISTINCT FROM p_hand_number OR h.generation IS DISTINCT FROM c.original_generation
     OR NOT EXISTS (SELECT 1 FROM public.tables tb WHERE tb.id=p_table_id
          AND tb.tournament_id=p_tournament_id AND tb.f06_lifecycle=h.lifecycle)
     OR NOT EXISTS (SELECT 1 FROM smarter_private.hand_continuation_dispositions d
          WHERE d.table_id=p_table_id AND d.hand_number=p_hand_number AND d.disposition='retained')
     OR EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits n
          WHERE n.table_id=p_table_id AND n.hand_number>p_hand_number)
     OR EXISTS (SELECT 1 FROM public.hand_atomic_commits a
          WHERE a.table_id=p_table_id AND a.hand_number>=p_hand_number)
     OR EXISTS (SELECT 1 FROM public.hand_history a
          WHERE a.table_id=p_table_id AND a.hand_number>=p_hand_number)
     OR EXISTS (SELECT 1 FROM smarter_private.hand_submissions s
          WHERE s.table_id=p_table_id AND s.hand_number=p_hand_number)
     OR EXISTS (SELECT 1 FROM smarter_private.hand_submission_dispositions d
          WHERE d.table_id=p_table_id AND d.hand_number=p_hand_number) THEN
    RAISE EXCEPTION 'HAND_CONTINUATION_ATTESTATION_ORIGINAL_UNPROVEN' USING ERRCODE='55000';
  END IF;
  v := c.payload::jsonb;
  IF v->>'version' IS DISTINCT FROM '1' OR v#>>'{batch,version}' IS DISTINCT FROM '1'
     OR v#>>'{batch,sequence}' IS DISTINCT FROM p_sequence::text
     OR v#>>'{original,tournament_id}' IS DISTINCT FROM h.tournament_id::text
     OR v#>>'{original,table_id}' IS DISTINCT FROM h.table_id::text
     OR v#>>'{original,hand_number}' IS DISTINCT FROM h.hand_number::text
     OR v#>>'{original,permit_id}' IS DISTINCT FROM h.permit_id::text
     OR v#>>'{original,lifecycle}' IS DISTINCT FROM h.lifecycle::text
     OR v#>>'{original,custody_id}' IS DISTINCT FROM h.custody_id::text
     OR v#>>'{original,lease_generation}' IS DISTINCT FROM h.generation::text
     OR jsonb_typeof(v#>'{batch,controller}') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'HAND_CONTINUATION_ATTESTATION_BINDING_CHANGED' USING ERRCODE='55000';
  END IF;
  RETURN jsonb_build_object('ok',true,'frozen',true,'tournament_id',p_tournament_id,
    'writer_generation',p_lease_generation,'table_id',p_table_id,'hand_number',p_hand_number::text,
    'sequence',p_sequence::text,'sha256',c.payload_sha256,'permit_id',h.permit_id,
    'original_generation',h.generation,'lifecycle',h.lifecycle::text,'custody_id',h.custody_id,
    'controller_sha256',encode(extensions.digest(convert_to(v#>>'{batch,controller}','UTF8'),'sha256'),'hex'),
    'announced_at',b.announced_at,'break_started_at',b.break_started_at,'break_ends_at',b.break_ends_at,
    'original',jsonb_build_object('tournament_id',h.tournament_id,'lease_generation',h.generation,
      'table_id',h.table_id,'lifecycle',h.lifecycle::text,'permit_id',h.permit_id,
      'hand_number',h.hand_number::text,'custody_id',h.custody_id),
    'capsule_created_at',c.created_at,'captured_at',v#>'{batch,engine,capturedAt}');
END $body$;
ALTER FUNCTION smarter_private.attest_frozen_hand_continuation(uuid,uuid,uuid,bigint,bigint,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.attest_frozen_hand_continuation(uuid,uuid,uuid,bigint,bigint,text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.fn_f06_attest_frozen_hand_continuation(
  p_tournament_id uuid, p_lease_generation uuid, p_table_id uuid,
  p_hand_number bigint, p_sequence bigint, p_payload_sha256 text
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, smarter_private AS $public_body$
BEGIN
  -- Keep the existing manager actor/current unexpired lease check without
  -- taking its writer lock. The process-root park caller uses its own guard.
  PERFORM smarter_private.f06_authority(p_tournament_id,p_lease_generation,false);
  RETURN smarter_private.attest_frozen_hand_continuation(p_tournament_id,p_lease_generation,
    p_table_id,p_hand_number,p_sequence,p_payload_sha256)
    - 'original' - 'capsule_created_at' - 'captured_at';
END $public_body$;
ALTER FUNCTION public.fn_f06_attest_frozen_hand_continuation(uuid,uuid,uuid,bigint,bigint,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_f06_attest_frozen_hand_continuation(uuid,uuid,uuid,bigint,bigint,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_attest_frozen_hand_continuation(uuid,uuid,uuid,bigint,bigint,text) TO service_role;

COMMIT;
