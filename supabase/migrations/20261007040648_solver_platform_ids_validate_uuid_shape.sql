-- Reserved by scripts/new-migration.mjs. TIER 2: function-body validation correction.
-- WHY: immutable30040 copied UUID version/variant filters for platform bundle
-- and dataset IDs. Validate UUID shape; retain approved-row/checksum/receipt bindings.
-- Forward recovery accepts only the captured feature-bound or legacy rollback
-- preimages. Never restore the defective expression as a rollback of this fix.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
CREATE TEMP TABLE v31_uuid_shape_preimages ON COMMIT DROP AS
 SELECT oid,oid::regprocedure::text signature,pg_get_functiondef(oid) definition,
 proowner,proacl,proconfig,prosecdef FROM pg_proc WHERE oid IN
 ('public.fn_gto_v31_register_dataset(jsonb)'::regprocedure,
 'public.fn_horse_solver_agreement_v31_decision(jsonb)'::regprocedure);
DO $repair$
DECLARE r record; expected text[]; old_predicate text:=
 '^[0-9a-f]{8}-[0-9a-f]{4}-[1-'||'5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
 shape text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
 IF (SELECT count(*) FROM v31_uuid_shape_preimages)<>2 THEN RAISE EXCEPTION 'UUID shape correction requires two exact functions'; END IF;
 FOR r IN SELECT * FROM v31_uuid_shape_preimages LOOP
  expected:=CASE r.signature
   WHEN 'fn_gto_v31_register_dataset(jsonb)' THEN ARRAY['c1e3c11e47fc37b9f4966b6c84c6b7a3','89394d43e3adb6376dd4e76087982408']
   WHEN 'fn_horse_solver_agreement_v31_decision(jsonb)' THEN ARRAY['b0dd9f5d02894324ef4524ba2529fead','093518d601694eec1f0092f8a4f38879']
   ELSE ARRAY[]::text[] END;
  IF NOT md5(r.definition)=ANY(expected)
   OR (length(r.definition)-length(replace(r.definition,old_predicate,'')))/length(old_predicate)<>1
   THEN RAISE EXCEPTION 'UUID shape correction preimage differs: %',r.signature; END IF;
  EXECUTE replace(r.definition,old_predicate,shape);
 END LOOP;
END; $repair$;
DO $post$
DECLARE r record; after_def text; old_predicate text:=
 '^[0-9a-f]{8}-[0-9a-f]{4}-[1-'||'5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
 shape text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
 FOR r IN SELECT * FROM v31_uuid_shape_preimages LOOP
  SELECT pg_get_functiondef(oid) INTO after_def FROM pg_proc WHERE oid=r.oid;
  IF after_def IS DISTINCT FROM replace(r.definition,old_predicate,shape)
   OR strpos(after_def,old_predicate)>0 OR strpos(after_def,shape)=0
   OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=r.oid AND p.proowner=r.proowner
    AND p.proacl IS NOT DISTINCT FROM r.proacl AND p.proconfig IS NOT DISTINCT FROM r.proconfig
    AND p.prosecdef=r.prosecdef)
   THEN RAISE EXCEPTION 'UUID shape postimage/bindings/ACL changed: %',r.signature; END IF;
 END LOOP;
END; $post$;
COMMIT;
