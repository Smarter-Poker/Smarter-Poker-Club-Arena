-- Original registration was scanning every certificate for each batch, including
-- empty originals: live bounded EXPLAIN read168000rows/28084cachedblocks/199ms.
-- Validated original SHA digests now drive existing certificate unique-key probes;
-- exact digest+batch membership and retired_at remain necessary. Empty originals
-- execute no certificate lookup. No index, grant, job, cap or barrier changes.
-- Forward-only exact installed helper preimage/owner/ACL/search_path guard.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$
DECLARE p pg_proc;
BEGIN
 SELECT * INTO p FROM pg_proc WHERE oid='smarter_private.register_horse_adaptive_batch_membership(text)'::regprocedure;
 IF md5(pg_get_functiondef(p.oid)) IS DISTINCT FROM '02b1038d96aef58c02af6fd7c41bdf5c'
 OR p.proowner<>'postgres'::regrole OR NOT p.prosecdef
 OR p.proacl::text IS DISTINCT FROM '{postgres=X/postgres}'
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, smarter_private']
 THEN RAISE EXCEPTION 'ADAPTIVE_MEMBERSHIP_LOOKUP_PREIMAGE_CHANGED'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION smarter_private.register_horse_adaptive_batch_membership(p_key text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $fn$
DECLARE b public.horse_adaptive_observation_batches; payload jsonb; hands text[];
BEGIN
 SELECT * INTO b FROM public.horse_adaptive_observation_batches WHERE batch_key=p_key FOR UPDATE;
 IF NOT FOUND OR b.retention_membership_ready THEN RETURN; END IF;
 IF b.canonical_payload IS NOT NULL THEN
  IF octet_length(b.canonical_payload)>16777216 THEN RAISE EXCEPTION 'ADAPTIVE_BATCH_MEMBERSHIP_INVALID'; END IF;
  payload:=b.canonical_payload::jsonb;
  IF jsonb_typeof(payload) IS DISTINCT FROM 'array'
  OR jsonb_array_length(payload)<>8 OR jsonb_typeof(payload->7) IS DISTINCT FROM 'array'
  OR jsonb_array_length(payload->7)>20000 THEN RAISE EXCEPTION 'ADAPTIVE_BATCH_MEMBERSHIP_INVALID'; END IF;
  -- Every original element is parsed and checked before DISTINCT. A malformed
  -- human, unknown or duplicate tuple cannot disappear in the deduplication.
  SELECT array_agg((v.value#>>'{}')::jsonb->>2) INTO hands FROM jsonb_array_elements(payload->7) v;
  IF EXISTS(SELECT 1 FROM unnest(hands) h(hand) WHERE hand IS NULL
   OR hand!~'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$')
  THEN RAISE EXCEPTION 'ADAPTIVE_BATCH_MEMBERSHIP_INVALID'; END IF;
  IF cardinality(hands)>0 THEN
   INSERT INTO smarter_private.horse_adaptive_batch_hand_membership(hand_digest,batch_key)
   SELECT encode(sha256(convert_to(hand,'UTF8')),'hex'),p_key FROM (SELECT DISTINCT unnest(hands) hand) h
   ON CONFLICT DO NOTHING;
  END IF;
  -- Most legacy batches contain no retired hand. Preserve their exact original
  -- bytes rather than computing a discarded sanitized representation.
  IF (CASE WHEN b.retention_compacted THEN
   EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_batch_hand_membership m
    JOIN smarter_private.horse_adaptive_disposal_certificates c USING(hand_digest)
    WHERE m.batch_key=p_key AND c.retired_at IS NOT NULL)
   ELSE EXISTS(SELECT 1 FROM
   (SELECT DISTINCT encode(sha256(convert_to(hand,'UTF8')),'hex') hand_digest
    FROM unnest(hands) h(hand)) original
   CROSS JOIN LATERAL (
    SELECT 1 FROM smarter_private.horse_adaptive_disposal_certificates c
    WHERE c.hand_digest=original.hand_digest AND c.retired_at IS NOT NULL
    AND EXISTS(SELECT 1 FROM smarter_private.horse_adaptive_batch_hand_membership m
     WHERE m.hand_digest=original.hand_digest AND m.batch_key=p_key)
    LIMIT 1
   ) retired) END) THEN
   UPDATE public.horse_adaptive_observation_batches SET canonical_payload=smarter_private.adaptive_retained_batch(b.canonical_payload),
    retention_compacted=true WHERE batch_key=p_key;
  END IF;
 END IF;
 UPDATE public.horse_adaptive_observation_batches SET retention_membership_ready=true WHERE batch_key=p_key;
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.register_horse_adaptive_batch_membership(text) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
