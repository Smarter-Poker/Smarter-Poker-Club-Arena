-- Scope both immutable-contract mismatch predicates to the selected dataset.
-- The old A AND B OR C form let unrelated V3/V4 cells veto sealing/promotion.
-- No data, quality threshold, approval, provenance or release gate changes.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
DO $repair$
DECLARE r record; before_body text; after_body text; expected text;
 anchor text := 'c.dataset_id=p_dataset_id AND c.feature_contract_version IS DISTINCT FROM v_dataset.feature_contract_version OR c.policy_export_schema IS DISTINCT FROM v_dataset.policy_export_schema) THEN';
 replacement text := 'c.dataset_id=p_dataset_id AND (c.feature_contract_version IS DISTINCT FROM v_dataset.feature_contract_version OR c.policy_export_schema IS DISTINCT FROM v_dataset.policy_export_schema)) THEN';
BEGIN
 FOR r IN SELECT oid,proname,proowner,proacl,proconfig,prosecdef FROM pg_proc
  WHERE oid IN ('public.fn_gto_v31_seal_build(uuid)'::regprocedure,
               'public.fn_gto_v31_promote_dataset(uuid)'::regprocedure)
 LOOP
  before_body:=pg_get_functiondef(r.oid);
  expected:=CASE r.proname WHEN 'fn_gto_v31_seal_build' THEN '07add58bf732501c8d8d37121d40890e'
    WHEN 'fn_gto_v31_promote_dataset' THEN 'e8c13cfcebd14832f3bc6e68f145b1cc' END;
  IF md5(before_body) IS DISTINCT FROM expected OR
     (length(before_body)-length(replace(before_body,anchor,'')))/length(anchor)<>1 THEN
   RAISE EXCEPTION 'V31 certification scope exact preimage differs: %',r.proname;
  END IF;
  after_body:=replace(before_body,anchor,replacement);
  EXECUTE after_body;
  IF pg_get_functiondef(r.oid) IS DISTINCT FROM after_body OR NOT EXISTS (
    SELECT 1 FROM pg_proc p WHERE p.oid=r.oid AND p.proowner=r.proowner
      AND p.proacl IS NOT DISTINCT FROM r.proacl AND p.proconfig IS NOT DISTINCT FROM r.proconfig
      AND p.prosecdef=r.prosecdef) THEN
   RAISE EXCEPTION 'V31 certification scope postimage or privileges differ: %',r.proname;
  END IF;
 END LOOP;
END;
$repair$;
-- @live-proof: md5(pg_get_functiondef('public.fn_gto_v31_seal_build(uuid)'::regprocedure)) = 'bc390a78ca6fca87aeaca253219cd6f3'
-- @live-proof: md5(pg_get_functiondef('public.fn_gto_v31_promote_dataset(uuid)'::regprocedure)) = 'e403c6bc53964cebda3a6275ade0fb86'
COMMIT;
