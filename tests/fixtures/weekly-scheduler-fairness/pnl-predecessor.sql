-- Explicit dependency seam: these scheduler tests do not qualify PNL quality.
-- Reproduce ONLY the preceding component's one coordinator predicate addition.
-- The separate PNL fixture must qualify its actual reader and full component.
CREATE FUNCTION public.fn_union_pnl_close_quality(uuid,timestamptz,timestamptz)
RETURNS jsonb LANGUAGE sql AS $$SELECT '{"status":"ready"}'::jsonb$$;
DO $fixture$
DECLARE definition text;old_anchor text:=
$old$      IF v_complete AND v_orphans=0 AND v_previous->>'success'='true' AND v_previous->>'accounting_version'='3' THEN$old$;
new_anchor text:=
$new$      IF v_complete AND v_orphans=0 AND v_previous->>'success'='true' AND v_previous->>'accounting_version'='3'
        AND public.fn_union_pnl_close_quality(v_union.id,v_from,v_end)->>'status'='ready' THEN$new$;
BEGIN
 SELECT pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure) INTO definition;
 IF md5(definition) IS DISTINCT FROM '63f8248cd6d804f450a0b8f0fbc05e77' OR position(old_anchor IN definition)=0 THEN
  RAISE EXCEPTION 'fairness fixture requires exact J coordinator';END IF;
 EXECUTE replace(definition,old_anchor,new_anchor);
END $fixture$;
