SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS public.engine_deploy_exit_paths (
  id          bigserial   PRIMARY KEY,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  run_id      text        NOT NULL,
  target_sha  text        NOT NULL,
  stage       text        NOT NULL,
  outcome     text        NOT NULL,
  error       text,
  release_result text
);

CREATE INDEX IF NOT EXISTS ix_engine_deploy_exit_paths_recorded_at
  ON public.engine_deploy_exit_paths (recorded_at DESC);

COMMENT ON TABLE public.engine_deploy_exit_paths IS
  'One row per auto-deploy-hetzner run naming where the deploy job exited: stage (first step that did not succeed, engine-doors, or complete), outcome, error, target sha, run id. Append-only; written by fn_ca_record_engine_deploy_exit.';

ALTER TABLE public.engine_deploy_exit_paths ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.fn_ca_record_engine_deploy_exit(
  p_run_id         text,
  p_target_sha     text,
  p_stage          text,
  p_outcome        text,
  p_error          text DEFAULT NULL,
  p_release_result text DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE v_id bigint;
BEGIN
  IF p_target_sha IS NULL OR length(btrim(p_target_sha)) = 0 THEN
    RAISE EXCEPTION 'fn_ca_record_engine_deploy_exit: p_target_sha is required';
  END IF;
  INSERT INTO public.engine_deploy_exit_paths
    (run_id, target_sha, stage, outcome, error, release_result)
  VALUES (
    left(COALESCE(NULLIF(btrim(p_run_id), ''), 'unknown'), 120),
    left(btrim(p_target_sha), 40),
    left(COALESCE(NULLIF(btrim(p_stage), ''), 'unknown'), 80),
    left(COALESCE(NULLIF(btrim(p_outcome), ''), 'unknown'), 80),
    NULLIF(left(COALESCE(p_error, ''), 500), ''),
    NULLIF(left(COALESCE(p_release_result, ''), 120), '')
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$fn$;

REVOKE ALL ON TABLE public.engine_deploy_exit_paths FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.engine_deploy_exit_paths TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_record_engine_deploy_exit(text, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_record_engine_deploy_exit(text, text, text, text, text, text)
  TO service_role;