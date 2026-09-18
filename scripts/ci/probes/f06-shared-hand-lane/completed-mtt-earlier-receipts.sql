-- Earlier recorded final stack receipts, not reconstructed canonical hand outcomes.
(k.status IS DISTINCT FROM 'succeeded'
 OR CASE WHEN a.hand_id IS NOT NULL THEN k.result IS DISTINCT FROM a.stack_result
 ELSE NOT COALESCE(
   CASE WHEN jsonb_typeof(k.result->'hand_number')='number'
          AND k.result->>'hand_number' ~ '^[1-9][0-9]*$'
        THEN (k.result->>'hand_number')::numeric<h.hand_number
        ELSE false END
   AND k.result->>'table_id'=k.table_id::text
   AND k.result->>'hand_id'=k.hand_id::text
   AND k.result->'success'='true'::jsonb
   AND k.result->'conservation_checked'='true'::jsonb
   AND k.result->>'mode'='delta'
   AND k.result->'rake'='0'::jsonb AND k.result->'bbj'='0'::jsonb
   AND k.result->'inflow'='0'::jsonb AND k.result->'net_deltas'='0'::jsonb
   AND k.result->'rebased'='{}'::jsonb AND k.result->'departed'='[]'::jsonb
   AND k.result->'players' IN ('2'::jsonb,'3'::jsonb,'4'::jsonb,'5'::jsonb,'6'::jsonb,'7'::jsonb,'8'::jsonb,'9'::jsonb,'10'::jsonb)
   AND k.attempt_count>0 AND isfinite(k.first_attempt_at) AND isfinite(k.completed_at)
   AND isfinite(k.last_attempt_at) AND isfinite(paid.completed_at)
   AND k.error IS NULL
   AND k.first_attempt_at<=k.completed_at
   AND k.completed_at<=k.last_attempt_at
   AND k.last_attempt_at<paid.completed_at
   AND (SELECT count(*) FROM public.ca_settlements c
        WHERE c.table_id=k.table_id AND c.hand_id=k.hand_id)=1
   AND EXISTS(SELECT 1 FROM public.ca_settlements c
        WHERE c.table_id=k.table_id AND c.hand_id=k.hand_id
        AND c.settlement_type='hand_stacks' AND c.state='final'
        AND c.error_detail IS NULL
        AND c.external_ref=k.table_id::text||':'||k.hand_id::text
        AND c.idempotency_key='hand:'||k.table_id::text||':'||k.hand_id::text
        AND c.totals->'mode'=k.result->'mode' AND c.totals->'players'=k.result->'players'
        AND c.totals->'rake'=k.result->'rake' AND c.totals->'bbj'=k.result->'bbj'
        AND c.totals->'inflow'=k.result->'inflow' AND c.totals->'net_deltas'=k.result->'net_deltas'
        AND c.totals->'rebased'=k.result->'rebased' AND c.totals->'departed'=k.result->'departed'
        AND isfinite(c.created_at) AND isfinite(c.updated_at)
        AND c.created_at<=c.updated_at AND c.updated_at<paid.completed_at)
 ,false) END)
