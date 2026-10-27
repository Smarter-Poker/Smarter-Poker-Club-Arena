-- @live-proof: (position('source_cardinalities AS MATERIALIZED' IN pg_get_functiondef('public.fn_accounting_union_earned_plan_window(uuid,timestamptz,timestamptz)'::regprocedure))>0)
-- Active weekly rakeback payout outage. The count of every hand's complete
-- effective source set was expanding its admission view twice per bank row.
-- Compute the SAME unfiltered per-hand count once for the bank keyset and
-- hash-join it. Keep every q1..q6 check, effective contract, sum and fingerprint.
-- Read-only production parity: 38,689 cash and 6,599 tournament sources,
-- exact amounts/IDs/fingerprints and all six checks, in 18.469 seconds.
BEGIN;
SET LOCAL lock_timeout='2s';
DO $repair$
DECLARE original text;patched text;anchor text;
BEGIN
 original:=pg_get_functiondef('public.fn_accounting_union_earned_plan_window(uuid,timestamptz,timestamptz)'::regprocedure);
 IF md5(original)<>'5fedbe9c2594648f8999d8a427aebcfc' THEN RAISE EXCEPTION 'earned_window_cardinality_original_changed';END IF;
 anchor:=E'  ), counts AS (\n';
 IF (length(original)-length(replace(original,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'earned_window_cardinality_cte_anchor_changed';END IF;
 patched:=replace(original,anchor,$counts$  ), source_cardinalities AS MATERIALIZED (
   SELECT s2.rake_record_id,count(*) AS n
    FROM public.accounting_effective_cash_rake_sources s2
    WHERE s2.rake_record_id=ANY(ARRAY(SELECT c0.rake_record_id FROM cw c0))
    GROUP BY s2.rake_record_id
  ), counts AS (
$counts$);
 anchor:=E'       LEFT JOIN xw x ON x.rake_record_id=c.rake_record_id\n';
 IF (length(patched)-length(replace(patched,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'earned_window_cardinality_join_anchor_changed';END IF;
 patched:=replace(patched,anchor,anchor||E'       LEFT JOIN source_cardinalities all_sources ON all_sources.rake_record_id=c.rake_record_id\n');
 anchor:='(SELECT count(*) FROM public.accounting_effective_cash_rake_sources s2 WHERE s2.rake_record_id=c.rake_record_id)<>x.n';
 IF (length(patched)-length(replace(patched,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'earned_window_cardinality_count_anchor_changed';END IF;
 patched:=replace(patched,anchor,'COALESCE(all_sources.n,0)<>x.n');
 EXECUTE patched;
 IF pg_get_functiondef('public.fn_accounting_union_earned_plan_window(uuid,timestamptz,timestamptz)'::regprocedure) IS DISTINCT FROM patched THEN RAISE EXCEPTION 'earned_window_cardinality_postimage_changed';END IF;
END $repair$;
COMMIT;
