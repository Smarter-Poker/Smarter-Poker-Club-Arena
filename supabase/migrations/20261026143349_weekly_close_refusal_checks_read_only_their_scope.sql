-- Weekly close refusal checks read the compact receipt cover before details.
-- 2026-10-26: a self-aborting Midway preparation probe spent its entire
-- 60-second statement in fn_cash_source_refusals_for_period, before P&L or
-- recompute. 137,425 blocked work rows probe a 5,468 MB receipt heap.
-- A materialized identity/scope/time pass uses the immutable receipt cover;
-- only matching current pointers fetch reason/detail rows. Every original
-- period, unknown-scope, NULL and duplicate-pointer behavior remains.
-- The source retry selector also sorts the entire blocked queue because its
-- existing index starts with next_attempt_at while its order starts with
-- attempts. The matching partial work cover both preserves that order and
-- makes this refusal walk index-only on the work side too.
-- No balances, source verdicts, business schedule, grants or locks change.
-- The live-written receipt table needs a CONCURRENT index; the supported
-- applier installs this preamble outside the single function transaction.
-- Rollback: restore the exact prior function from the native fixture; the
-- unused cover can remain until an explicitly qualified removal.
-- @live-proof: position('WITH scoped_refusals AS MATERIALIZED' in pg_get_functiondef('public.fn_cash_source_refusals_for_period(uuid,uuid,timestamptz,timestamptz)'::regprocedure))>0
-- @live-proof: (SELECT indisvalid AND indisready AND indislive FROM pg_index WHERE indexrelid=to_regclass('public.accounting_cash_work_attempt_cover'))
-- @live-proof: (SELECT indisvalid AND indisready AND indislive FROM pg_index WHERE indexrelid=to_regclass('public.accounting_cash_receipts_refusal_cover'))
CREATE INDEX CONCURRENTLY IF NOT EXISTS accounting_cash_receipts_refusal_cover
 ON public.accounting_cash_source_receipts (id) INCLUDE (earned_at,scope);
CREATE INDEX CONCURRENTLY IF NOT EXISTS accounting_cash_work_attempt_cover
 ON public.accounting_cash_source_work (attempts,next_attempt_at,rake_record_id) INCLUDE (receipt_id) WHERE status='blocked';
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
DO $change$
DECLARE target oid:='public.fn_cash_source_refusals_for_period(uuid,uuid,timestamptz,timestamptz)'::regprocedure;
 original text; candidate text; before_meta jsonb; after_meta jsonb;
 old_query constant text := $old$ SELECT COALESCE(jsonb_agg(jsonb_build_object('rake_record_id',r.rake_record_id,'reason',r.reason,'scope',r.scope)
  ORDER BY r.rake_record_id),'[]'::jsonb) INTO problems
 FROM public.accounting_cash_source_work w JOIN public.accounting_cash_source_receipts r ON r.id=w.receipt_id
 WHERE w.status='blocked' AND (NOT isfinite(r.earned_at) OR(r.earned_at>=p_from AND r.earned_at<p_to))
 AND(r.scope->>'kind'='unknown' OR(r.scope->>'kind'='union' AND r.scope->>'id'=p_union_id::text)
  OR(r.scope->>'kind'='club' AND r.scope->>'id'=p_club_id::text));
$old$;
 new_query constant text := $new$ -- Read only the receipt's compact indexed identity, scope and time before
 -- fetching its reason. MATERIALIZED keeps the final detail fetch outside
 -- the global blocked queue walk; no status, scope or period test is omitted.
 WITH scoped_refusals AS MATERIALIZED (
  SELECT r.id
  FROM public.accounting_cash_source_work w
  JOIN LATERAL (
   SELECT x.id,x.earned_at,x.scope FROM public.accounting_cash_source_receipts x
   WHERE x.id=w.receipt_id OFFSET 0
  ) r ON true
  WHERE w.status='blocked' AND (NOT isfinite(r.earned_at) OR(r.earned_at>=p_from AND r.earned_at<p_to))
  AND(r.scope->>'kind'='unknown' OR(r.scope->>'kind'='union' AND r.scope->>'id'=p_union_id::text)
   OR(r.scope->>'kind'='club' AND r.scope->>'id'=p_club_id::text))
 )
 SELECT COALESCE(jsonb_agg(jsonb_build_object('rake_record_id',r.rake_record_id,'reason',r.reason,'scope',r.scope)
  ORDER BY r.rake_record_id),'[]'::jsonb) INTO problems
 FROM scoped_refusals s JOIN public.accounting_cash_source_receipts r ON r.id=s.id;
$new$;
BEGIN
 IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RAISE EXCEPTION 'weekly_refusal_install_frozen'; END IF;
 IF NOT EXISTS(SELECT FROM pg_index i WHERE i.indexrelid=to_regclass('public.accounting_cash_receipts_refusal_cover')
  AND i.indrelid='public.accounting_cash_source_receipts'::regclass AND i.indisvalid AND i.indisready AND i.indislive
  AND NOT i.indisunique AND i.indnkeyatts=1 AND i.indnatts=3 AND i.indexprs IS NULL AND i.indpred IS NULL
  AND i.indkey::text=(SELECT string_agg(attnum::text,' ' ORDER BY ord) FROM unnest(ARRAY['id','earned_at','scope']) WITH ORDINALITY n(name,ord)
   JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attname=n.name))
 THEN RAISE EXCEPTION 'weekly_refusal_cover_not_qualified'; END IF;
 IF NOT EXISTS(SELECT FROM pg_index i WHERE i.indexrelid=to_regclass('public.accounting_cash_work_attempt_cover')
  AND i.indrelid='public.accounting_cash_source_work'::regclass AND i.indisvalid AND i.indisready AND i.indislive
  AND NOT i.indisunique AND i.indnkeyatts=3 AND i.indnatts=4 AND i.indexprs IS NULL
  AND pg_get_expr(i.indpred,i.indrelid)='(status = ''blocked''::text)'
  AND i.indkey::text=(SELECT string_agg(attnum::text,' ' ORDER BY ord) FROM unnest(ARRAY['attempts','next_attempt_at','rake_record_id','receipt_id']) WITH ORDINALITY n(name,ord)
   JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attname=n.name))
 THEN RAISE EXCEPTION 'weekly_refusal_work_cover_not_qualified'; END IF;
 SELECT pg_get_functiondef(oid),jsonb_build_array(proowner,proacl,prosecdef,provolatile,proconfig,proparallel,proisstrict)
 INTO original,before_meta FROM pg_proc WHERE oid=target;
 IF md5(original)<>'ac7d777693e79eca6a13084b51cd1305' THEN RAISE EXCEPTION 'weekly_refusal_preimage_changed'; END IF;
 IF (length(original)-length(replace(original,old_query,'')))/length(old_query)<>1 THEN RAISE EXCEPTION 'weekly_refusal_shape_changed'; END IF;
 candidate:=replace(original,old_query,new_query);
 EXECUTE candidate;
 SELECT jsonb_build_array(proowner,proacl,prosecdef,provolatile,proconfig,proparallel,proisstrict) INTO after_meta FROM pg_proc WHERE oid=target;
 IF after_meta IS DISTINCT FROM before_meta OR pg_get_functiondef(target) IS DISTINCT FROM candidate
 THEN RAISE EXCEPTION 'weekly_refusal_postimage_changed'; END IF;
END $change$;
COMMIT;
