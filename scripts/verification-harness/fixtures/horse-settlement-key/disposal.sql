CREATE OR REPLACE FUNCTION smarter_private.hand_submission_retention_disposal(p_hand_ids uuid[], p_reason text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE v_rows integer := 0;
BEGIN
  IF p_hand_ids IS NULL OR cardinality(p_hand_ids) = 0 THEN RETURN 0; END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 40 THEN
    RAISE EXCEPTION 'HAND_DISPOSAL_IDENTITY_REQUIRED' USING ERRCODE = '22023';
  END IF;

  INSERT INTO smarter_private.hand_submission_disposals
    (table_id, hand_number, submission_id, receipt_id, witness_hand_number, reason, expected)
  SELECT s.table_id, s.hand_number, s.submission_id,
         md5('hand:disposal:retention:' || s.submission_id::text)::uuid,
         s.hand_number, p_reason,
         jsonb_build_object(
           'kind', 'retention_pruned_settled_hand',
           'table_id', s.table_id, 'hand_number', s.hand_number,
           'submission_id', s.submission_id, 'retained_at', s.retained_at,
           'dealer_generation', s.lease_generation, 'request_hash', s.request_hash,
           'pruned_hand_id', hh.id, 'hand_created_at', hh.created_at,
           'settled', EXISTS (SELECT 1 FROM public.hand_atomic_commits a
                               WHERE a.table_id = s.table_id AND a.hand_number = s.hand_number),
           'settlement_completed_at', (SELECT a.post_commit_completed_at FROM public.hand_atomic_commits a WHERE a.table_id=s.table_id AND a.hand_number=s.hand_number AND a.hand_id=s.submission_id),
           'settlement_completed', EXISTS (SELECT 1 FROM public.hand_atomic_commits a WHERE a.table_id=s.table_id AND a.hand_number=s.hand_number AND a.hand_id=s.submission_id AND a.post_commit_completed_at IS NOT NULL AND a.post_commit_result->>'ok'='true'),
           'disposed_at', clock_timestamp())
    FROM public.hand_history hh
    JOIN smarter_private.hand_submissions s
      ON s.table_id = hh.table_id AND s.hand_number = hh.hand_number
   WHERE hh.id = ANY (p_hand_ids)
     AND NOT EXISTS (SELECT 1 FROM smarter_private.hand_submission_disposals dd
                      WHERE dd.table_id = s.table_id AND dd.hand_number = s.hand_number)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM smarter_private.compact_settled_horse_requests(p_hand_ids);
  RETURN v_rows;
END
$function$
