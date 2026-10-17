-- Law 10.5 permits horse identification and horse-fleet input plumbing.
-- The owner-authorized exact 72-player pilot control validates its manifest;
-- it changes no common gameplay, rewards, eligibility or player treatment.
-- Only its reviewed complete definition is recognized. Unknown functions and
-- any changed control definition remain subject to the original broad guard.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_lightning_rollout_readiness(uuid)'::regprocedure))='eeec07e85e652927425c00dc6ccbb50a' AND md5(pg_get_functiondef('public.fn_lightning_pilot_assignment_set(boolean,uuid,text,uuid[],text)'::regprocedure))='42ad4c77c5fbf91c56ba84401a8acb31')
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='15s';
DO $repair$
DECLARE
  v_oid oid := 'public.fn_lightning_rollout_readiness(uuid)'::regprocedure;
  v_before text;
  v_after text;
  v_catalog record;
  v_old text := $old$AND regexp_replace(pg_get_functiondef(p.oid), v_strip, '', 'g') ~ v_horse);$old$;
  v_new text := $new$AND regexp_replace(pg_get_functiondef(p.oid), v_strip, '', 'g') ~ v_horse
                          AND NOT (p.oid = to_regprocedure('public.fn_lightning_pilot_assignment_set(boolean,uuid,text,uuid[],text)')
                            AND md5(pg_get_functiondef(p.oid)) = '42ad4c77c5fbf91c56ba84401a8acb31'));$new$;
BEGIN
  SELECT pg_get_functiondef(v_oid) INTO v_before;
  SELECT proowner,proacl,proconfig,prosecdef,provolatile INTO v_catalog FROM pg_proc WHERE oid=v_oid;
  IF md5(v_before) <> 'd5fe0f2eb62a16f7e4587fdb5bf82caa'
     OR md5(pg_get_functiondef('public.fn_lightning_pilot_assignment_set(boolean,uuid,text,uuid[],text)'::regprocedure)) <> '42ad4c77c5fbf91c56ba84401a8acb31'
     OR pg_get_userbyid(v_catalog.proowner) <> 'postgres'
     OR NOT v_catalog.prosecdef OR v_catalog.provolatile <> 's'
     OR NOT v_catalog.proconfig @> ARRAY['search_path=public, pg_temp'] THEN
    RAISE EXCEPTION 'Lightning readiness fleet boundary predecessor mismatch';
  END IF;
  IF (length(v_before)-length(replace(v_before,v_old,'')))/length(v_old) <> 1 THEN
    RAISE EXCEPTION 'Lightning readiness law predicate occurrence mismatch';
  END IF;
  v_after := replace(v_before,v_old,v_new);
  EXECUTE v_after;
  IF md5(pg_get_functiondef(v_oid)) <> 'eeec07e85e652927425c00dc6ccbb50a'
     OR replace(pg_get_functiondef(v_oid),v_new,v_old) <> v_before
     OR EXISTS(SELECT 1 FROM pg_proc WHERE oid=v_oid AND
       (proowner IS DISTINCT FROM v_catalog.proowner OR proacl IS DISTINCT FROM v_catalog.proacl
        OR proconfig IS DISTINCT FROM v_catalog.proconfig OR prosecdef IS DISTINCT FROM v_catalog.prosecdef
        OR provolatile IS DISTINCT FROM v_catalog.provolatile)) THEN
    RAISE EXCEPTION 'Lightning readiness fleet boundary changed unrelated source or authority';
  END IF;
END $repair$;
COMMIT;
