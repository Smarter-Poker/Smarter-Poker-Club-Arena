-- ROOT REVIEW ONLY: exact original linked reader algebra with pure materialization
-- barriers. No DDL/functions/payer/source writes or forced planner setting.
-- Recognition time belongs to original outcome; Union belongs to resolution.
BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ;
SET LOCAL statement_timeout='30s';
SET LOCAL lock_timeout='2s';
WITH timed AS MATERIALIZED(
 SELECT o.table_id,o.hand_number,o.hand_id,o.payload_hash,o.evidence
 FROM public.union_pnl_cash_outcomes o
 WHERE o.recognized_at>='2026-10-19 07:00Z'::timestamptz
 AND o.recognized_at<'2026-10-19 09:00Z'::timestamptz
),joined AS MATERIALIZED(
 SELECT r.table_id,r.hand_number,r.game_scope,r.evidence,
 r.hand_id resolution_hand_id,r.outcome_payload_hash,r.outcome_evidence_md5,r.proof_md5,r.proof,
 o.hand_id original_hand_id,o.payload_hash,o.evidence original_evidence
 FROM timed o JOIN public.union_pnl_cash_outcome_link_resolutions r
 ON o.table_id=r.table_id AND o.hand_number=r.hand_number
 WHERE r.game_scope->>'game_union_id'='fade0000-0000-0000-0000-000000000001'
),original_rows AS MATERIALIZED(
 SELECT table_id,hand_number,game_scope,evidence FROM joined
 WHERE resolution_hand_id=original_hand_id AND outcome_payload_hash=payload_hash
 AND outcome_evidence_md5=md5(original_evidence::text) AND proof_md5=md5(proof::text)
)
SELECT jsonb_build_object('observed_at',clock_timestamp(),
 'original_linked_owner_md5',md5(pg_get_functiondef('public.fn_union_pnl_linked_cash_outcomes(uuid,timestamptz,timestamptz)'::regprocedure)),
 'union_id','fade0000-0000-0000-0000-000000000001','window_start','2026-10-19T07:00:00Z','window_end','2026-10-19T09:00:00Z',
 'recognition_window_outcomes',(SELECT count(*)FROM timed),
 'recognition_union_link_rows',(SELECT count(*)FROM joined),
 'original_rows',count(*),'distinct_table_hand_rows',count(DISTINCT(table_id,hand_number)),
 'full_original_row_fields',jsonb_build_array('table_id','hand_number','game_scope','evidence'),
 'full_original_row_bag_md5',md5(coalesce(string_agg(md5(to_jsonb(k)::text),''ORDER BY table_id,hand_number),'')))
 FROM original_rows k;
ROLLBACK;
