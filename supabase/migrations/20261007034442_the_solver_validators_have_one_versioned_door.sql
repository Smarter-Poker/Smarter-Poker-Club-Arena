-- Reserved by scripts/new-migration.mjs. TIER 3: superseded validator signature removal.
-- WHY: migration30040 left old and versioned signatures. One door with a
-- NULL default preserves omitted legacy validation without named-RPC ambiguity.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
DO $pre$ BEGIN
 IF md5(pg_get_functiondef('public.fn_gto_v31_hand_matrix_valid(jsonb,text)'::regprocedure))<>'9e928d8de5d76386df5151b7c9927791'
 OR md5(pg_get_functiondef('public.fn_gto_v31_hand_matrix_valid(jsonb,text,text)'::regprocedure))<>'98c53f538e565cabe8d650ca52322b93'
 OR md5(pg_get_functiondef('public.fn_gto_v31_compact_matrices_valid(jsonb,jsonb,jsonb,jsonb,text)'::regprocedure))<>'afb0bebf3c8aff77ec7d5b383954e89c'
 OR md5(pg_get_functiondef('public.fn_gto_v31_compact_matrices_valid(jsonb,jsonb,jsonb,jsonb,text,text)'::regprocedure))<>'12537c4b62eb1dbf52e472914a9bf722' THEN
 RAISE EXCEPTION 'validator preimages differ'; END IF;
END; $pre$;
CREATE OR REPLACE FUNCTION public.fn_gto_v31_hand_matrix_valid(p_matrix jsonb, p_street text, p_version text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_key text;
BEGIN
  IF p_matrix IS NULL OR jsonb_typeof(p_matrix) <> 'object'
     OR NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_matrix)) THEN
    RETURN false;
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_matrix) LOOP
    IF NOT public.fn_gto_v31_feature_key_valid(v_key,p_street,p_version) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_gto_v31_compact_matrices_valid(p_matrix jsonb, p_specs jsonb, p_policy_evs jsonb, p_action_evs jsonb, p_street text, p_version text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_hand record;
  v_action text;
  v_value numeric;
  v_sum numeric;
  v_action_count integer;
BEGIN
  IF NOT public.fn_gto_v31_action_specs_valid(p_specs)
     OR NOT public.fn_gto_v31_hand_matrix_valid(p_matrix,p_street,p_version)
     OR jsonb_typeof(p_policy_evs) <> 'object'
     OR jsonb_typeof(p_action_evs) <> 'object' THEN
    RETURN false;
  END IF;
  v_action_count := (SELECT count(*) FROM jsonb_object_keys(p_specs));
  IF (SELECT count(*) FROM jsonb_object_keys(p_policy_evs)) <>
       (SELECT count(*) FROM jsonb_object_keys(p_matrix))
     OR (SELECT count(*) FROM jsonb_object_keys(p_action_evs)) <>
       (SELECT count(*) FROM jsonb_object_keys(p_matrix)) THEN
    RETURN false;
  END IF;

  FOR v_hand IN SELECT key,value FROM jsonb_each(p_matrix) LOOP
    IF jsonb_typeof(v_hand.value) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(v_hand.value)) <> v_action_count
       OR EXISTS (
         SELECT 1 FROM jsonb_object_keys(p_specs) a(key)
          WHERE NOT (v_hand.value ? a.key)
       )
       OR NOT (p_policy_evs ? v_hand.key)
       OR jsonb_typeof(p_policy_evs->v_hand.key) <> 'number'
       OR NOT (p_action_evs ? v_hand.key)
       OR jsonb_typeof(p_action_evs->v_hand.key) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(p_action_evs->v_hand.key)) <> v_action_count
       OR EXISTS (
         SELECT 1 FROM jsonb_object_keys(p_specs) a(key)
          WHERE NOT ((p_action_evs->v_hand.key) ? a.key)
       ) THEN
      RETURN false;
    END IF;
    v_sum := 0;
    FOR v_action IN SELECT jsonb_object_keys(p_specs) LOOP
      IF jsonb_typeof(v_hand.value->v_action) <> 'number'
         OR jsonb_typeof(p_action_evs->v_hand.key->v_action) <> 'number' THEN
        RETURN false;
      END IF;
      v_value := (v_hand.value->>v_action)::numeric;
      IF v_value < 0 OR v_value > 1 THEN RETURN false; END IF;
      v_sum := v_sum + v_value;
    END LOOP;
    IF abs(v_sum - 1) > 0.002 THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$function$;
DROP FUNCTION public.fn_gto_v31_compact_matrices_valid(jsonb,jsonb,jsonb,jsonb,text);
DROP FUNCTION public.fn_gto_v31_hand_matrix_valid(jsonb,text);
REVOKE ALL ON FUNCTION public.fn_gto_v31_hand_matrix_valid(jsonb,text,text),public.fn_gto_v31_compact_matrices_valid(jsonb,jsonb,jsonb,jsonb,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_hand_matrix_valid(jsonb,text,text),public.fn_gto_v31_compact_matrices_valid(jsonb,jsonb,jsonb,jsonb,text,text) TO service_role;
DO $post$ BEGIN
 IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_gto_v31_hand_matrix_valid')<>1
 OR (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_gto_v31_compact_matrices_valid')<>1 THEN
 RAISE EXCEPTION 'validators must each have exactly one door'; END IF;
 IF NOT public.fn_gto_v31_hand_matrix_valid('{"AKo:21":{"check":1}}'::jsonb,'flop')
 OR public.fn_gto_v31_hand_matrix_valid('{"AKo:21":{"check":1}}'::jsonb,'flop','unknown') THEN
 RAISE EXCEPTION 'omitted legacy or unknown version validation changed'; END IF;
END; $post$;
COMMIT;
-- EXECUTABLE VALIDATOR ROLLBACK: stop admission; execute as a new migration.
-- BEGIN;
-- SET LOCAL lock_timeout='2s';
-- SET LOCAL statement_timeout='60s';
-- ALTER TABLE public.gto_v31_runtime_cells DROP CONSTRAINT gto_v31_runtime_cells_hand_keys_match_street_chk, DROP CONSTRAINT gto_v31_runtime_cells_compact_matrices_valid_chk;
-- DROP FUNCTION public.fn_gto_v31_compact_matrices_valid(jsonb,jsonb,jsonb,jsonb,text,text);
-- DROP FUNCTION public.fn_gto_v31_hand_matrix_valid(jsonb,text,text);
-- CREATE OR REPLACE FUNCTION public.fn_gto_v31_hand_matrix_valid(p_matrix jsonb, p_street text)
--  RETURNS boolean
--  LANGUAGE plpgsql
--  IMMUTABLE
--  SET search_path TO 'public'
-- AS $function$
-- DECLARE
--   v_key text;
-- BEGIN
--   IF p_matrix IS NULL OR jsonb_typeof(p_matrix) <> 'object'
--      OR NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_matrix)) THEN
--     RETURN false;
--   END IF;
--   FOR v_key IN SELECT jsonb_object_keys(p_matrix) LOOP
--     IF NOT public.fn_gto_v31_hand_key_valid(v_key,p_street) THEN RETURN false; END IF;
--   END LOOP;
--   RETURN true;
-- EXCEPTION WHEN OTHERS THEN
--   RETURN false;
-- END;
-- $function$;
-- CREATE OR REPLACE FUNCTION public.fn_gto_v31_hand_matrix_valid(p_matrix jsonb, p_street text, p_version text)
--  RETURNS boolean
--  LANGUAGE plpgsql
--  IMMUTABLE
--  SET search_path TO 'public'
-- AS $function$
-- DECLARE
--   v_key text;
-- BEGIN
--   IF p_matrix IS NULL OR jsonb_typeof(p_matrix) <> 'object'
--      OR NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_matrix)) THEN
--     RETURN false;
--   END IF;
--   FOR v_key IN SELECT jsonb_object_keys(p_matrix) LOOP
--     IF NOT public.fn_gto_v31_feature_key_valid(v_key,p_street,p_version) THEN RETURN false; END IF;
--   END LOOP;
--   RETURN true;
-- EXCEPTION WHEN OTHERS THEN
--   RETURN false;
-- END;
-- $function$;
-- CREATE OR REPLACE FUNCTION public.fn_gto_v31_compact_matrices_valid(p_matrix jsonb, p_specs jsonb, p_policy_evs jsonb, p_action_evs jsonb, p_street text)
--  RETURNS boolean
--  LANGUAGE plpgsql
--  IMMUTABLE
--  SET search_path TO 'public'
-- AS $function$
-- DECLARE
--   v_hand record;
--   v_action text;
--   v_value numeric;
--   v_sum numeric;
--   v_action_count integer;
-- BEGIN
--   IF NOT public.fn_gto_v31_action_specs_valid(p_specs)
--      OR NOT public.fn_gto_v31_hand_matrix_valid(p_matrix,p_street)
--      OR jsonb_typeof(p_policy_evs) <> 'object'
--      OR jsonb_typeof(p_action_evs) <> 'object' THEN
--     RETURN false;
--   END IF;
--   v_action_count := (SELECT count(*) FROM jsonb_object_keys(p_specs));
--   IF (SELECT count(*) FROM jsonb_object_keys(p_policy_evs)) <>
--        (SELECT count(*) FROM jsonb_object_keys(p_matrix))
--      OR (SELECT count(*) FROM jsonb_object_keys(p_action_evs)) <>
--        (SELECT count(*) FROM jsonb_object_keys(p_matrix)) THEN
--     RETURN false;
--   END IF;
--
--   FOR v_hand IN SELECT key,value FROM jsonb_each(p_matrix) LOOP
--     IF jsonb_typeof(v_hand.value) <> 'object'
--        OR (SELECT count(*) FROM jsonb_object_keys(v_hand.value)) <> v_action_count
--        OR EXISTS (
--          SELECT 1 FROM jsonb_object_keys(p_specs) a(key)
--           WHERE NOT (v_hand.value ? a.key)
--        )
--        OR NOT (p_policy_evs ? v_hand.key)
--        OR jsonb_typeof(p_policy_evs->v_hand.key) <> 'number'
--        OR NOT (p_action_evs ? v_hand.key)
--        OR jsonb_typeof(p_action_evs->v_hand.key) <> 'object'
--        OR (SELECT count(*) FROM jsonb_object_keys(p_action_evs->v_hand.key)) <> v_action_count
--        OR EXISTS (
--          SELECT 1 FROM jsonb_object_keys(p_specs) a(key)
--           WHERE NOT ((p_action_evs->v_hand.key) ? a.key)
--        ) THEN
--       RETURN false;
--     END IF;
--     v_sum := 0;
--     FOR v_action IN SELECT jsonb_object_keys(p_specs) LOOP
--       IF jsonb_typeof(v_hand.value->v_action) <> 'number'
--          OR jsonb_typeof(p_action_evs->v_hand.key->v_action) <> 'number' THEN
--         RETURN false;
--       END IF;
--       v_value := (v_hand.value->>v_action)::numeric;
--       IF v_value < 0 OR v_value > 1 THEN RETURN false; END IF;
--       v_sum := v_sum + v_value;
--     END LOOP;
--     IF abs(v_sum - 1) > 0.002 THEN RETURN false; END IF;
--   END LOOP;
--   RETURN true;
-- EXCEPTION WHEN OTHERS THEN
--   RETURN false;
-- END;
-- $function$;
-- CREATE OR REPLACE FUNCTION public.fn_gto_v31_compact_matrices_valid(p_matrix jsonb, p_specs jsonb, p_policy_evs jsonb, p_action_evs jsonb, p_street text, p_version text)
--  RETURNS boolean
--  LANGUAGE plpgsql
--  IMMUTABLE
--  SET search_path TO 'public'
-- AS $function$
-- DECLARE
--   v_hand record;
--   v_action text;
--   v_value numeric;
--   v_sum numeric;
--   v_action_count integer;
-- BEGIN
--   IF NOT public.fn_gto_v31_action_specs_valid(p_specs)
--      OR NOT public.fn_gto_v31_hand_matrix_valid(p_matrix,p_street,p_version)
--      OR jsonb_typeof(p_policy_evs) <> 'object'
--      OR jsonb_typeof(p_action_evs) <> 'object' THEN
--     RETURN false;
--   END IF;
--   v_action_count := (SELECT count(*) FROM jsonb_object_keys(p_specs));
--   IF (SELECT count(*) FROM jsonb_object_keys(p_policy_evs)) <>
--        (SELECT count(*) FROM jsonb_object_keys(p_matrix))
--      OR (SELECT count(*) FROM jsonb_object_keys(p_action_evs)) <>
--        (SELECT count(*) FROM jsonb_object_keys(p_matrix)) THEN
--     RETURN false;
--   END IF;
--
--   FOR v_hand IN SELECT key,value FROM jsonb_each(p_matrix) LOOP
--     IF jsonb_typeof(v_hand.value) <> 'object'
--        OR (SELECT count(*) FROM jsonb_object_keys(v_hand.value)) <> v_action_count
--        OR EXISTS (
--          SELECT 1 FROM jsonb_object_keys(p_specs) a(key)
--           WHERE NOT (v_hand.value ? a.key)
--        )
--        OR NOT (p_policy_evs ? v_hand.key)
--        OR jsonb_typeof(p_policy_evs->v_hand.key) <> 'number'
--        OR NOT (p_action_evs ? v_hand.key)
--        OR jsonb_typeof(p_action_evs->v_hand.key) <> 'object'
--        OR (SELECT count(*) FROM jsonb_object_keys(p_action_evs->v_hand.key)) <> v_action_count
--        OR EXISTS (
--          SELECT 1 FROM jsonb_object_keys(p_specs) a(key)
--           WHERE NOT ((p_action_evs->v_hand.key) ? a.key)
--        ) THEN
--       RETURN false;
--     END IF;
--     v_sum := 0;
--     FOR v_action IN SELECT jsonb_object_keys(p_specs) LOOP
--       IF jsonb_typeof(v_hand.value->v_action) <> 'number'
--          OR jsonb_typeof(p_action_evs->v_hand.key->v_action) <> 'number' THEN
--         RETURN false;
--       END IF;
--       v_value := (v_hand.value->>v_action)::numeric;
--       IF v_value < 0 OR v_value > 1 THEN RETURN false; END IF;
--       v_sum := v_sum + v_value;
--     END LOOP;
--     IF abs(v_sum - 1) > 0.002 THEN RETURN false; END IF;
--   END LOOP;
--   RETURN true;
-- EXCEPTION WHEN OTHERS THEN
--   RETURN false;
-- END;
-- $function$;
-- ALTER TABLE public.gto_v31_runtime_cells ADD CONSTRAINT gto_v31_runtime_cells_hand_keys_match_street_chk CHECK(public.fn_gto_v31_hand_matrix_valid(hand_matrix,street,feature_contract_version)), ADD CONSTRAINT gto_v31_runtime_cells_compact_matrices_valid_chk CHECK(public.fn_gto_v31_compact_matrices_valid(hand_matrix,action_specs,policy_ev_matrix,action_ev_matrix,street,feature_contract_version));
-- REVOKE ALL ON FUNCTION public.fn_gto_v31_hand_matrix_valid(jsonb,text),public.fn_gto_v31_hand_matrix_valid(jsonb,text,text),public.fn_gto_v31_compact_matrices_valid(jsonb,jsonb,jsonb,jsonb,text),public.fn_gto_v31_compact_matrices_valid(jsonb,jsonb,jsonb,jsonb,text,text) FROM PUBLIC,anon,authenticated;
-- GRANT EXECUTE ON FUNCTION public.fn_gto_v31_hand_matrix_valid(jsonb,text),public.fn_gto_v31_hand_matrix_valid(jsonb,text,text),public.fn_gto_v31_compact_matrices_valid(jsonb,jsonb,jsonb,jsonb,text),public.fn_gto_v31_compact_matrices_valid(jsonb,jsonb,jsonb,jsonb,text,text) TO service_role;
-- COMMIT;
-- END EXECUTABLE VALIDATOR ROLLBACK
