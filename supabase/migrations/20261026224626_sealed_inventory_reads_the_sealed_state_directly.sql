-- @live-proof: (position('sealed boundary already contains the exact state' IN pg_get_functiondef('public.fn_union_pnl_inventory_state(timestamptz,timestamptz)'::regprocedure))>0 AND smarter_private.original_inventory_proof_sources_match())
-- Weekly rakeback payout outage: the opening inventory alone took 119 seconds.
-- At base=boundary the delta is empty. Its hashes, windows and continuation
-- joins cannot contribute a row or an issue. Read the SAME sealed row/issue
-- projections directly. All delta paths, admission checks and book locks stay.
-- Native qualification retains the captured original 14,941-row population,
-- all 245 issues/admissions, forged-cache refusals and generation invalidation.
BEGIN;
SET LOCAL lock_timeout='2s';
DO $repair$
DECLARE original text;patched text;guard_body text;guard_after text;anchor text;old_pin text;new_pin text;
BEGIN
 IF md5(pg_get_functiondef('public.fn_union_pnl_inventory_state(timestamptz,timestamptz)'::regprocedure))<>'06bf76e3f1a3dccc6faa8dbace9b40ba'
 OR smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'sealed_inventory_reader_original_sources_changed';
 END IF;
 original:=pg_get_functiondef('public.fn_union_pnl_inventory_state(timestamptz,timestamptz)'::regprocedure);
 anchor:=E' RETURN QUERY\n WITH d AS MATERIALIZED (';
 IF (length(original)-length(replace(original,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'sealed_inventory_reader_anchor_changed';END IF;
 patched:=replace(original,anchor,$fast$ -- A sealed boundary already contains the exact state: no delta exists.
 IF p_base=p_at THEN
  RETURN QUERY
  SELECT 'row'::text,r.source_name,r.row_id,r.latest_event_id,r.first_operation,r.after_row
   FROM public.union_pnl_inventory_published_rows r WHERE r.boundary=p_base
  UNION ALL
  SELECT 'issue'::text,i.source_name,i.row_id,i.event_id,NULL::text,NULL::jsonb
   FROM public.union_pnl_inventory_published_issues i WHERE i.boundary=p_base;
  RETURN;
 END IF;
 RETURN QUERY
 WITH d AS MATERIALIZED ($fast$);
 EXECUTE patched;
 IF pg_get_functiondef('public.fn_union_pnl_inventory_state(timestamptz,timestamptz)'::regprocedure) IS DISTINCT FROM patched THEN RAISE EXCEPTION 'sealed_inventory_reader_postimage_changed';END IF;
 -- Renew exactly this qualified read's pin. Preserve every other source,
 -- owner, count and refusal in the original forty-source authority.
 guard_body:=pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure);
 old_pin:=$pin$('public.fn_union_pnl_inventory_state(timestamptz,timestamptz)','06bf76e3f1a3dccc6faa8dbace9b40ba')$pin$;
 new_pin:=replace(old_pin,'06bf76e3f1a3dccc6faa8dbace9b40ba',md5(patched));
 IF (length(guard_body)-length(replace(guard_body,old_pin,'')))/length(old_pin)<>1 THEN RAISE EXCEPTION 'sealed_inventory_reader_source_pin_changed';END IF;
 guard_after:=replace(guard_body,old_pin,new_pin);EXECUTE guard_after;
 IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN RAISE EXCEPTION 'sealed_inventory_reader_source_authority_failed';END IF;
END $repair$;
COMMIT;
