-- A round-two fingerprint sorts its sources instead of walking a temp index.
--
-- Midway's union close for book 2026-09-21..28 reached round 2 at 17:42Z on
-- 2026-10-01 and was still inside fn_settle_accounting_commission_stage when
-- the 17:55 maintenance freeze refused its first wallet write (the whole
-- attempt rolled back, as designed). auto_explain measured one statement at
-- 623 s:
--
--   SELECT count(*),md5(COALESCE(string_agg(row_md5,'' ORDER BY source_type,source_id),''))
--     FROM pg_temp._routed_sources_v4
--
-- The ORDER BY matches the temp table's primary key, so the planner (no
-- statistics on a fresh temp table) feeds the aggregate from a full index scan.
-- The heap was filled in another order, so every row is a random read through
-- the 8 MB local buffer pool: hundreds of thousands of temp-file page reads.
-- The same aggregate fed by a sort takes 1.7 s for 400k rows.
--
-- The fix orders by source_type||'' (the same text, same collation, so the
-- same order and the same fingerprint, proven equal on 100k rows) which no
-- index can supply, so the planner sorts. Nothing else changes.
--
-- @live-proof: position($q$string_agg(row_md5,'' ORDER BY source_type||'',source_id)$q$ in pg_get_functiondef('public.fn_settle_accounting_commission_stage(text,uuid,timestamptz,timestamptz)'::regprocedure)) > 0
-- Preimage-guarded: refuses unless the live function is the exact version this
-- was written against.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $mig$
DECLARE s regprocedure:='public.fn_settle_accounting_commission_stage(text,uuid,timestamptz,timestamptz)'::regprocedure;
 d text; x text:=$n$string_agg(row_md5,'' ORDER BY source_type,source_id)$n$;
BEGIN
 d:=pg_get_functiondef(s);
 IF md5(d)<>'017cc76b047124788a3c83e931b17d77' THEN RAISE EXCEPTION 'commission stage preimage %',md5(d); END IF;
 IF (length(d)-length(replace(d,x,'')))/length(x)<>1 THEN RAISE EXCEPTION 'commission stage needle count'; END IF;
 EXECUTE replace(d,x,$n$string_agg(row_md5,'' ORDER BY source_type||'',source_id)$n$);
 IF position($n$string_agg(row_md5,'' ORDER BY source_type||'',source_id)$n$ in pg_get_functiondef(s))=0 THEN
  RAISE EXCEPTION 'commission stage postimage check failed';
 END IF;
END
$mig$;
COMMIT;
