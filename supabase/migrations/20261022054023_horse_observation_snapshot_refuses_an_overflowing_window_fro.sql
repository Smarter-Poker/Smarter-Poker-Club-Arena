-- 20261022054023_horse_observation_snapshot_refuses_an_overflowing_window_fro.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- 20261022034135 (installed 2026-10-22 05:27 UTC, run 39727159245) moved the
-- candidate search of fn_horse_committed_observation_snapshot onto
-- ca_hand_player_idx. A six-hour production call went from 9.7 s to
-- 1.6-3.7 s, but the capture worker's first slice is usually the whole six
-- hours, and for an active horse that window holds 1,800-2,700 hands: the
-- function then reads 513 history rows (random heap, roster recheck,
-- receipt join, action payload sizes) only to answer hand_budget_exceeded,
-- and the worker refines the slice and asks again. Measured after install:
-- 64 calls, mean 2,424 ms; per call, the 513 heap probes are 0.4-3 s cold
-- while the index read that finds them is 2-15 ms.
--
-- Fix: before reading any history row, count up to 513 index rows for the
-- actor in the window whose (created_at, id) still exists in hand_history.
-- The projector writes each index row from the hand's own roster with the
-- hand's own created_at (production, 253,474 rows of one hour checked:
-- 0 orphans, 0 created_at mismatches, 0 users absent from the roster), so
-- 513 of them prove overflow. The check reads two indexes
-- (idx_ca_hand_player_idx_user_time, idx_hand_history_time_identity) and no
-- history payload: 78-670 ms cold on production for overflowing horses.
--
-- It can only REFUSE. A window under the budget is read by the unchanged
-- roster-qualified path, so every snapshot returned is byte-for-byte what
-- 20261022034135 returns; and a refusal only makes the capture worker refine
-- to a smaller slice, which is then read exactly. The refusal keeps the
-- response keys, reason and empty hands of the old overflow answer;
-- actionCount and sourceBytes are NULL because nothing was measured (the
-- engine reads only status and reason from an unavailable answer).
--
-- Unchanged: signature, STABLE SECURITY INVOKER, search_path, grants, every
-- other refusal and budget, and the snapshot path. CREATE OR REPLACE only.
--
-- @live-proof: position('LIMIT 513) overflow' IN pg_get_functiondef('public.fn_horse_committed_observation_snapshot(uuid,bigint,bigint)'::regprocedure))>0

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $guard$
DECLARE v text;
BEGIN
  v := md5(pg_get_functiondef('public.fn_horse_committed_observation_snapshot(uuid,bigint,bigint)'::regprocedure));
  -- d1df5793...: the live definition installed by 20261022034135 (read
  -- 2026-10-22 05:28 UTC). A definition that already carries the overflow
  -- precheck is this migration replayed.
  IF v <> 'd1df5793f8117878ba28553c08ea922c'
     AND position('LIMIT 513) overflow' IN pg_get_functiondef('public.fn_horse_committed_observation_snapshot(uuid,bigint,bigint)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'fn_horse_committed_observation_snapshot preimage changed (md5 %)', v;
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
  v_from timestamptz;
  v_through timestamptz;
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
  v_from := to_timestamp(p_from_ms::double precision / 1000);
  v_through := to_timestamp(p_through_ms::double precision / 1000);

  -- 2026-10-22 (second pass): an overflowing window is refused before any
  -- history row is read. Each ca_hand_player_idx row is written from the
  -- hand's own roster with the hand's own created_at, so 513 index rows whose
  -- (created_at, id) still exist in hand_history prove more than 512 hands
  -- in this window. That answer comes from two indexes (the per-player time
  -- index and idx_hand_history_time_identity) instead of 513 random heap
  -- reads plus roster rechecks: 1.6-3.7 s -> well under 1 s on production.
  -- It can only refuse, never admit: a window under the budget still goes
  -- through the full roster-qualified read below, and a refusal only makes
  -- the capture worker refine to a smaller slice that is read exactly.
  SELECT count(*)::integer INTO v_count FROM (
    SELECT 1 FROM public.ca_hand_player_idx i
     WHERE i.user_id = p_actor AND i.created_at > v_from AND i.created_at <= v_through
       AND EXISTS (SELECT 1 FROM public.hand_history h
                    WHERE h.created_at = i.created_at AND h.id = i.hand_id)
     LIMIT 513) overflow;
  IF v_count > 512 THEN
    RETURN jsonb_build_object(
      'version',1,'status','unavailable','reason','hand_budget_exceeded',
      'actor',p_actor,'fromMs',p_from_ms,'throughMs',p_through_ms,
      'readAtMs',v_now_ms,'snapshotId',pg_current_snapshot()::text,
      'coverage','retained_committed_roster_rows','acceptance','atomic_hand_receipts',
      'handCount',v_count,'actionCount',NULL,'sourceBytes',NULL,'hands','[]'::jsonb);
  END IF;

  -- 2026-10-22: candidates are FOUND through the per-player time index and
  -- the pending projection outbox, and QUALIFIED by the canonical roster on
  -- the history row itself. The roster GIN alone cannot bound time: for a
  -- busy horse it matched ~38,000 hands across retention to keep 513, read
  -- ~37,000 random heap pages and held hand_history for up to 8 seconds.
  --
  -- Completeness in this one snapshot: a committed hand writes its history
  -- row and its hand_projection_outbox row in one transaction; the projector
  -- writes ca_hand_player_idx (same created_at) and deletes the outbox row in
  -- one transaction. So every visible hand is reachable through the outbox
  -- or through the index, never neither. A voided stat fact removes one
  -- index row while the roster keeps the player; those hands are re-added.
  -- The roster containment and window are rechecked on the history row, so
  -- the index can only narrow the search, never decide membership.
  WITH found AS MATERIALIZED (
    SELECT i.hand_id FROM public.ca_hand_player_idx i
     WHERE i.user_id = p_actor AND i.created_at > v_from AND i.created_at <= v_through
    UNION
    SELECT o.hand_id FROM public.hand_projection_outbox o
    UNION
    SELECT r.hand_id FROM public.ca_hand_fact_revisions r
     WHERE r.user_id = p_actor AND r.kind = 'void'
  ), candidates AS MATERIALIZED (
    -- One primary-key probe per found hand. The roster test is wrapped in
    -- IS TRUE so the planner cannot turn it back into the roster GIN scan
    -- this replaces. A 513th row proves overflow; it is never silently
    -- dropped. No action payload is read until the bounded set is known.
    SELECT h.id, h.created_at, h.table_id, h.hand_number
      FROM found f
     CROSS JOIN LATERAL (
       SELECT h.id, h.created_at, h.table_id, h.hand_number
         FROM public.hand_history h
        WHERE h.id = f.hand_id
          AND h.created_at > v_from
          AND h.created_at <= v_through
          AND (h.players @> jsonb_build_array(jsonb_build_object('userId',p_actor::text))) IS TRUE
     ) h
     LIMIT 513
  ), measured AS MATERIALIZED (
    SELECT c.id, c.created_at, c.table_id, c.hand_number, h.actions,
           a.payload_hash AS acceptance_hash,
           a.hand_id IS NULL AS missing_receipt,
           octet_length(h.actions::text) AS bytes,
           CASE WHEN jsonb_typeof(h.actions)='array'
                THEN jsonb_array_length(h.actions) ELSE 0 END AS action_count,
           CASE WHEN jsonb_typeof(h.actions)='array'
                THEN jsonb_array_length(h.actions) > 4096 ELSE true END AS invalid
      FROM candidates c
      JOIN public.hand_history h ON h.id = c.id
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
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_committed_observation_snapshot(uuid,bigint,bigint)
  TO service_role;

COMMIT;
