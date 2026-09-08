-- Phase 4 operator reads were correctly gated through fn_is_horse_admin(), but
-- two defects remained:
--
--   1. the live telemetry-exposure guard deliberately does not trust a nested
--      helper as proof that a SECURITY DEFINER routine inspected its caller;
--      ca_horse_solver_agreement_decisions() and
--      ca_solver_pipeline_liveness() therefore remained red in CI; and
--   2. the functions granted service_role EXECUTE while their nested admin
--      gate rejected a service-role session with no user id.
--
-- Keep the browser surface required by the horse admin panel, but make the
-- authorization boundary direct and explicit. Service workers are admitted by
-- auth.role(); every browser request must carry auth.uid() and pass the shared
-- horse-admin lookup. No allowlist exemption is needed for this shape.

BEGIN;

CREATE OR REPLACE FUNCTION public.ca_horse_solver_agreement(p_runs integer DEFAULT 14)
RETURNS TABLE (
  run_date date, reference text, spots integer, agreement numeric, pure_misses integer,
  eligible_spots integer, reconciled_spots integer, action_regret_bb numeric,
  regret_eligible_spots integer, decision_checksum text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF COALESCE(auth.role(),'') <> 'service_role'
     AND (auth.uid() IS NULL OR NOT public.fn_is_horse_admin()) THEN
    RAISE EXCEPTION 'admin only';
  END IF;
  RETURN QUERY
    SELECT a.run_date,a.reference,a.spots,a.agreement,a.pure_misses,
           a.eligible_spots,a.reconciled_spots,a.action_regret_bb,
           a.regret_eligible_spots,a.decision_checksum
      FROM public.horse_solver_agreement a
     ORDER BY a.run_date DESC
     LIMIT least(greatest(COALESCE(p_runs,14),1),90);
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_horse_solver_agreement(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_horse_solver_agreement(integer)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ca_horse_solver_agreement_decisions(
  p_day date DEFAULT NULL,
  p_reference text DEFAULT 'gto_charts',
  p_limit integer DEFAULT 100
)
RETURNS TABLE (
  run_date date, reference text, state_key text, decision_state jsonb, kind text, game_type text,
  hero_position text, stack_bb numeric, hand text, final_action text,
  reference_distribution jsonb, chosen_probability numeric,
  action_regret_bb numeric, regret_eligible boolean, pure_miss boolean,
  source_seal jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_day date;
BEGIN
  IF COALESCE(auth.role(),'') <> 'service_role'
     AND (auth.uid() IS NULL OR NOT public.fn_is_horse_admin()) THEN
    RAISE EXCEPTION 'admin only';
  END IF;
  SELECT COALESCE(p_day,max(d.run_date)) INTO v_day
    FROM public.horse_solver_agreement_decisions d
   WHERE d.reference=p_reference;
  IF v_day IS NULL THEN RETURN; END IF;
  RETURN QUERY
    SELECT d.run_date,d.reference,d.state_key,d.decision_state,d.kind,d.game_type,d.position,
           d.stack_bb,d.hand,d.final_action,d.reference_distribution,
           d.chosen_probability,d.action_regret_bb,d.regret_eligible,
           d.pure_miss,d.source_seal
      FROM public.horse_solver_agreement_decisions d
     WHERE d.run_date=v_day AND d.reference=p_reference
     ORDER BY d.pure_miss DESC,d.action_regret_bb DESC NULLS LAST,d.state_key
     LIMIT least(greatest(COALESCE(p_limit,100),1),1000);
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_horse_solver_agreement_decisions(date,text,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_horse_solver_agreement_decisions(date,text,integer)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ca_solver_pipeline_liveness()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF COALESCE(auth.role(),'') <> 'service_role'
     AND (auth.uid() IS NULL OR NOT public.fn_is_horse_admin()) THEN
    RAISE EXCEPTION 'admin only';
  END IF;
  RETURN jsonb_build_object(
    'workers',COALESCE((SELECT jsonb_agg(to_jsonb(w) ORDER BY w.machine_id)
      FROM public.solver_worker_liveness w),'[]'::jsonb),
    'compactor',(SELECT to_jsonb(c) FROM public.solver_compact_liveness c WHERE singleton),
    'generated_at',now()
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_solver_pipeline_liveness()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_solver_pipeline_liveness()
  TO authenticated, service_role;

-- The summary reader predated the direct caller check and was allowlisted by
-- name. Remove that broader exception now that the body proves its own scope;
-- otherwise a future unsafe replacement with the same name could be hidden.
DELETE FROM public.ca_browser_definer_allowlist
 WHERE proname = 'ca_horse_solver_agreement';

DO $postcheck$
DECLARE
  v_sig regprocedure;
  v_source text;
  v_open text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.ca_horse_solver_agreement(integer)'::regprocedure,
    'public.ca_horse_solver_agreement_decisions(date,text,integer)'::regprocedure,
    'public.ca_solver_pipeline_liveness()'::regprocedure
  ] LOOP
    SELECT lower(p.prosrc) INTO v_source FROM pg_proc p WHERE p.oid=v_sig;
    IF position('auth.uid()' IN v_source)=0 OR position('auth.role()' IN v_source)=0 THEN
      RAISE EXCEPTION 'POST-APPLY: % does not directly inspect auth.uid() and auth.role()',v_sig;
    END IF;
    IF has_function_privilege('anon',v_sig,'EXECUTE')
       OR NOT has_function_privilege('authenticated',v_sig,'EXECUTE')
       OR NOT has_function_privilege('service_role',v_sig,'EXECUTE') THEN
      RAISE EXCEPTION 'POST-APPLY: % has the wrong browser/service grants',v_sig;
    END IF;
  END LOOP;

  SELECT string_agg(t.proname,', ' ORDER BY t.proname) INTO v_open
    FROM public.fn_ca_browser_reachable_telemetry() t
   WHERE t.proname IN (
     'ca_horse_solver_agreement',
     'ca_horse_solver_agreement_decisions',
     'ca_solver_pipeline_liveness'
   );
  IF v_open IS NOT NULL THEN
    RAISE EXCEPTION 'POST-APPLY: Phase 4 operator read(s) remain unscoped: %',v_open;
  END IF;
END;
$postcheck$;

COMMENT ON FUNCTION public.ca_horse_solver_agreement(integer) IS
  'Admin-only solver-agreement summary. Browser callers are directly identified and checked; service_role is explicitly admitted.';
COMMENT ON FUNCTION public.ca_horse_solver_agreement_decisions(date,text,integer) IS
  'Admin-only immutable solver decision evidence. Browser callers are directly identified and checked; service_role is explicitly admitted.';
COMMENT ON FUNCTION public.ca_solver_pipeline_liveness() IS
  'Admin-only M1/M2/compactor liveness read. Browser callers are directly identified and checked; service_role is explicitly admitted.';

COMMIT;
