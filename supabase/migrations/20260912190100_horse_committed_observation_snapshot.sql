-- One statement snapshot of retained, committed source rows. No data writes,
-- trigger, index, scheduler or adaptive activation is added.
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
    SELECT h.id, h.created_at, h.actions
      FROM public.hand_history h
     WHERE h.players @> jsonb_build_array(jsonb_build_object('userId',p_actor::text))
       AND h.created_at > to_timestamp(p_from_ms::double precision / 1000)
       AND h.created_at <= to_timestamp(p_through_ms::double precision / 1000)
     LIMIT 513
  ), measured AS MATERIALIZED (
    SELECT c.*,
           octet_length(c.actions::text) AS bytes,
           CASE WHEN jsonb_typeof(c.actions)='array'
                THEN jsonb_array_length(c.actions) ELSE 0 END AS action_count,
           CASE WHEN jsonb_typeof(c.actions)='array'
                THEN jsonb_array_length(c.actions) > 4096 ELSE true END AS invalid
      FROM candidates c
  ), totals AS (
    SELECT count(*)::integer AS n, coalesce(sum(bytes),0)::bigint AS bytes,
           coalesce(sum(action_count),0)::bigint AS actions,
           coalesce(bool_or(invalid OR bytes > 1048576),false) AS invalid
      FROM measured
  )
  SELECT t.n, t.bytes, t.invalid, t.actions,
         CASE WHEN t.n <= 512 AND t.bytes <= 8388608 AND t.actions <= 20000 AND NOT t.invalid THEN
           (SELECT coalesce(jsonb_agg(jsonb_build_object(
               'id',m.id,
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
    INTO v_count,v_bytes,v_invalid,v_actions,v_rows FROM totals t;

  RETURN jsonb_build_object(
    'version',1,
    'status',CASE WHEN v_count > 512 OR v_bytes > 8388608 OR v_actions > 20000 OR v_invalid
                  THEN 'unavailable' ELSE 'snapshot' END,
    'reason',CASE WHEN v_count > 512 THEN 'hand_budget_exceeded'
                  WHEN v_bytes > 8388608 THEN 'byte_budget_exceeded'
                  WHEN v_actions > 20000 THEN 'action_budget_exceeded'
                  WHEN v_invalid THEN 'invalid_or_oversized_hand' ELSE NULL END,
    'actor',p_actor,'fromMs',p_from_ms,'throughMs',p_through_ms,
    'readAtMs',v_now_ms,'snapshotId',pg_current_snapshot()::text,
    'coverage','retained_committed_roster_rows',
    'handCount',v_count,'actionCount',v_actions,'sourceBytes',v_bytes,'hands',v_rows
  );
END
$function$;

REVOKE ALL ON FUNCTION public.fn_horse_committed_observation_snapshot(uuid,bigint,bigint)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_horse_committed_observation_snapshot(uuid,bigint,bigint)
  TO service_role;
COMMENT ON FUNCTION public.fn_horse_committed_observation_snapshot(uuid,bigint,bigint) IS
  'Service-only bounded read of one committed MVCC snapshot, not an observation-time watermark. Refuses truncation. No outcomes or top-level private action fields. Qualification must keep only validated public fields; capture gaps and uncommitted/late hands remain explicit.';

DO $check$
BEGIN
  IF has_function_privilege('anon','public.fn_horse_committed_observation_snapshot(uuid,bigint,bigint)','EXECUTE')
     OR has_function_privilege('authenticated','public.fn_horse_committed_observation_snapshot(uuid,bigint,bigint)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.fn_horse_committed_observation_snapshot(uuid,bigint,bigint)','EXECUTE') THEN
    RAISE EXCEPTION 'horse committed snapshot execution grants are incorrect';
  END IF;
END
$check$;
