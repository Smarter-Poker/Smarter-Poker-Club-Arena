-- Reserved 2026-09-13 19:58:56 UTC. A committed history row is not proof
-- that stacks and the authoritative accepted-hand transaction committed.
-- Require matching immutable atomic receipt identity for every candidate;
-- refuse the whole bounded source window on a missing/mismatched receipt.
-- Read-only change; no hand/money writes, triggers, hot-table indexes or FK.
BEGIN;
SET LOCAL lock_timeout = '2s';
DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_horse_committed_observation_snapshot(uuid,bigint,bigint)'::regprocedure)
     IS DISTINCT FROM 'ed2e11a8fdde285a933024eaa0159c6e' THEN
    RAISE EXCEPTION 'HORSE_COMMITTED_SNAPSHOT_BODY_CHANGED';
  END IF;
END
$guard$;
CREATE OR REPLACE FUNCTION public.fn_horse_committed_observation_snapshot(
  p_actor uuid, p_from_ms bigint, p_through_ms bigint
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path TO pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_at timestamptz := statement_timestamp();
  v_now_ms bigint := floor(extract(epoch FROM v_at) * 1000)::bigint;
  v_rows jsonb;
  v_count integer;
  v_actions bigint;
  v_bytes bigint;
  v_invalid boolean;
  v_missing_receipt boolean;
BEGIN
  -- Six-hour source windows within the latest day. The deployed horse-only
  -- prune has a one-day minimum; this does not promise historical retention
  -- or that actions in hands which have not committed are already visible.
  IF p_actor IS NULL OR p_from_ms IS NULL OR p_through_ms IS NULL
     OR p_from_ms < v_now_ms - 86400000 OR p_through_ms > v_now_ms
     OR p_through_ms <= p_from_ms OR p_through_ms - p_from_ms > 21600000 THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','invalid_window');
  END IF;

  -- Do not use the asynchronously maintained player index as completeness
  -- authority. The canonical roster GIN can directly answer this containment.
  -- A 513th row proves overflow; it is never silently dropped. No ordering is
  -- needed until the bounded complete set is known.
  WITH candidates AS MATERIALIZED (
    SELECT h.id, h.created_at, h.actions, h.table_id, h.hand_number
      FROM public.hand_history h
     WHERE h.players @> jsonb_build_array(jsonb_build_object('userId',p_actor::text))
       AND h.created_at > to_timestamp(p_from_ms::double precision / 1000)
       AND h.created_at <= to_timestamp(p_through_ms::double precision / 1000)
     LIMIT 513
  ), measured AS MATERIALIZED (
    SELECT c.*, a.payload_hash AS acceptance_hash,
           a.hand_id IS NULL AS missing_receipt,
           octet_length(c.actions::text) AS bytes,
           CASE WHEN jsonb_typeof(c.actions)='array'
                THEN jsonb_array_length(c.actions) ELSE 0 END AS action_count,
           CASE WHEN jsonb_typeof(c.actions)='array'
                THEN jsonb_array_length(c.actions) > 4096 ELSE true END AS invalid
      FROM candidates c
      LEFT JOIN public.hand_atomic_commits a
        ON a.hand_id=c.id AND a.table_id=c.table_id AND a.hand_number=c.hand_number
  ), totals AS (
    SELECT count(*)::integer AS n, coalesce(sum(bytes),0)::bigint AS bytes,
           coalesce(sum(action_count),0)::bigint AS actions,
           coalesce(bool_or(invalid OR bytes > 1048576),false) AS invalid,
           coalesce(bool_or(missing_receipt),false) AS missing_receipt
      FROM measured
  )
  SELECT t.n, t.bytes, t.invalid, t.missing_receipt, t.actions,
         CASE WHEN t.n <= 512 AND t.bytes <= 8388608 AND t.actions <= 20000 AND NOT t.invalid AND NOT t.missing_receipt THEN
           (SELECT coalesce(jsonb_agg(jsonb_build_object(
               'id',m.id,
               'acceptance',jsonb_build_object('kind','atomic_hand_receipt','tableId',m.table_id,
                 'handNumber',m.hand_number,'payloadHash',m.acceptance_hash),
               'createdAt',to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
               -- Exclude showdown, hole cards, outcomes, names and arbitrary
               -- action fields before crossing the service boundary. Ordinals
               -- and non-betting entries stay intact for public-line replay.
               'actions',(SELECT coalesce(jsonb_agg(
                   CASE WHEN jsonb_typeof(a.value)='object' THEN
                     (SELECT coalesce(jsonb_object_agg(f.key,f.value),'{}'::jsonb)
                        FROM jsonb_each(a.value) f
                       WHERE f.key IN ('userId','action','stage','timestamp',
                                       'publicNode','origin','observationIdentity'))
                   ELSE a.value END ORDER BY a.ordinality),'[]'::jsonb)
                   FROM jsonb_array_elements(m.actions) WITH ORDINALITY a(value,ordinality))
             ) ORDER BY m.created_at,m.id),'[]'::jsonb) FROM measured m)
         ELSE '[]'::jsonb END
    INTO v_count,v_bytes,v_invalid,v_missing_receipt,v_actions,v_rows FROM totals t;

  RETURN jsonb_build_object(
    'version',1,
    'status',CASE WHEN v_count > 512 OR v_bytes > 8388608 OR v_actions > 20000 OR v_invalid OR v_missing_receipt
                  THEN 'unavailable' ELSE 'snapshot' END,
    'reason',CASE WHEN v_count > 512 THEN 'hand_budget_exceeded'
                  WHEN v_bytes > 8388608 THEN 'byte_budget_exceeded'
                  WHEN v_actions > 20000 THEN 'action_budget_exceeded'
                  WHEN v_invalid THEN 'invalid_or_oversized_hand'
                  WHEN v_missing_receipt THEN 'atomic_receipt_missing' ELSE NULL END,
    'actor',p_actor,'fromMs',p_from_ms,'throughMs',p_through_ms,
    'readAtMs',v_now_ms,'snapshotId',pg_current_snapshot()::text,
    'coverage','retained_committed_roster_rows','acceptance','atomic_hand_receipts',
    'handCount',v_count,'actionCount',v_actions,'sourceBytes',v_bytes,'hands',v_rows
  );
END
$function$;

REVOKE ALL ON FUNCTION public.fn_horse_committed_observation_snapshot(uuid,bigint,bigint)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_horse_committed_observation_snapshot(uuid,bigint,bigint)
  TO service_role;
COMMENT ON FUNCTION public.fn_horse_committed_observation_snapshot(uuid,bigint,bigint) IS
  'Service-only STABLE read of bounded retained history with a matching table/number/UUID atomic accepted-hand receipt. Any missing receipt refuses the entire source window. No commit-time watermark, retention completeness or policy activation.';
COMMIT;
