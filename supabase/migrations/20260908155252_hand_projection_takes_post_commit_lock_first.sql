-- 20260908155252_hand_projection_takes_post_commit_lock_first
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-08 15:36:19 UTC.
--
-- fn_project_hand_side_effects claimed hand_projection_outbox and updated
-- player_stats before its DELETE trigger tried to take the per-table
-- hand-post-commit advisory lock. The live post-commit path takes that advisory
-- lock first and can then reach the same player_stats rows through rake side
-- effects. Those opposite edges form a real cycle: projection owns
-- player_stats and waits for hand-post-commit while post-commit owns
-- hand-post-commit and waits for player_stats.
--
-- Preserve the exact installed projector behind an owner-only implementation
-- name. The public RPC now reads and verifies only the immutable hand/table
-- scope, takes hand-post-commit first, consumes or refuses the exact durable
-- obligation envelope, then takes hand-projection and delegates to the
-- unchanged implementation. That implementation still claims the exact
-- outbox row FOR UPDATE, enforces predecessor order, applies every existing
-- projection, and deletes through the existing idempotent BEFORE DELETE
-- obligation trigger. No retry, cron, reconciliation path, or weaker guard is
-- introduced.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '0';

DO $preserve_exact_projector$
DECLARE
  v_source text;
  v_owner text;
  v_security_definer boolean;
BEGIN
  IF to_regprocedure(
       'public.fn_project_hand_side_effects_after_post_commit_20260908(uuid)'
     ) IS NULL THEN
    SELECT pg_get_functiondef(p.oid), pg_get_userbyid(p.proowner), p.prosecdef
      INTO v_source, v_owner, v_security_definer
      FROM pg_proc p
     WHERE p.oid =
       to_regprocedure('public.fn_project_hand_side_effects(uuid)');

    IF v_source IS NULL
       OR v_owner IS DISTINCT FROM 'postgres'
       OR v_security_definer IS NOT TRUE
       OR position('FOR UPDATE OF o' IN v_source) = 0
       OR position('hand-projection:' IN v_source) = 0
       OR position('predecessor_pending' IN v_source) = 0
       OR position('DELETE FROM public.hand_projection_outbox' IN v_source) = 0 THEN
      RAISE EXCEPTION
        'refusing hand-projector lock-order cutover: installed projector is not the reviewed implementation';
    END IF;

    ALTER FUNCTION public.fn_project_hand_side_effects(uuid)
      RENAME TO fn_project_hand_side_effects_after_post_commit_20260908;
  ELSE
    SELECT pg_get_functiondef(p.oid) INTO v_source
      FROM pg_proc p
     WHERE p.oid =
       to_regprocedure('public.fn_project_hand_side_effects(uuid)');

    IF v_source IS NOT NULL
       AND position(
         'fn_project_hand_side_effects_after_post_commit_20260908' IN v_source
       ) = 0 THEN
      RAISE EXCEPTION
        'refusing hand-projector lock-order cutover: canonical wrapper drifted';
    END IF;
  END IF;
END;
$preserve_exact_projector$;

ALTER FUNCTION public.fn_project_hand_side_effects_after_post_commit_20260908(uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.fn_project_hand_side_effects_after_post_commit_20260908(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_project_hand_side_effects(p_hand_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_table_id uuid;
  v_hand_number bigint;
  v_history_table_id uuid;
  v_history_hand_number bigint;
  v_commit_table_id uuid;
  v_commit_hand_number bigint;
  v_post_commit jsonb;
BEGIN
  IF NOT (current_user IN ('postgres','service_role')) THEN
    RAISE EXCEPTION 'fn_project_hand_side_effects is engine/service only';
  END IF;

  /* LOCK ORDER 1: read the exact durable scope without claiming the outbox.
     Another worker may finish it after this read; the implementation claim
     below remains the sole authority to apply projections. */
  SELECT o.table_id, o.hand_number
    INTO v_table_id, v_hand_number
    FROM public.hand_projection_outbox o
   WHERE o.hand_id = p_hand_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'not_pending',
      'hand_id', p_hand_id
    );
  END IF;

  SELECT h.table_id, h.hand_number
    INTO v_history_table_id, v_history_hand_number
    FROM public.hand_history h
   WHERE h.id = p_hand_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pending hand projection has no hand history row: %', p_hand_id;
  END IF;

  SELECT c.table_id, c.hand_number
    INTO v_commit_table_id, v_commit_hand_number
    FROM public.hand_atomic_commits c
   WHERE c.hand_id = p_hand_id;
  IF NOT FOUND
     OR v_history_table_id IS DISTINCT FROM v_table_id
     OR v_history_hand_number IS DISTINCT FROM v_hand_number
     OR v_commit_table_id IS DISTINCT FROM v_table_id
     OR v_commit_hand_number IS DISTINCT FROM v_hand_number THEN
    RAISE EXCEPTION
      'pending hand projection scope disagrees with immutable hand receipt: %',
      p_hand_id;
  END IF;

  /* LOCK ORDER 2: every path that can consume the frozen post-commit envelope
     owns this per-table advisory lock before reaching any player/stat row. */
  PERFORM pg_advisory_xact_lock(
    hashtextextended('hand-post-commit:' || v_table_id::text, 0)
  );

  /* LOCK ORDER 3: consume the exact stored envelope, or leave the outbox row
     untouched. predecessor_pending is returned unchanged so the event-driven
     worker preserves causal order. Any thrown validation/hash error aborts the
     transaction and is intentionally not converted into success. */
  v_post_commit :=
    public.fn_ca_process_hand_post_commit_obligations(p_hand_id);
  IF COALESCE((v_post_commit->>'ok')::boolean, false) IS NOT TRUE
     AND COALESCE(v_post_commit->>'reason', '') <> 'legacy_no_obligations' THEN
    RETURN COALESCE(v_post_commit, '{}'::jsonb) || jsonb_build_object(
      'projection_applied', false,
      'hand_id', p_hand_id
    );
  END IF;

  /* LOCK ORDER 4: projection serialisation comes after post-commit. The
     preserved implementation next claims this exact outbox row FOR UPDATE,
     checks projection predecessors, applies the unchanged projections, and
     deletes through a0_finish_hand_post_commit_obligations. The trigger's
     second processor call is an idempotent completed/legacy assertion while
     this transaction still owns both advisory locks. */
  PERFORM pg_advisory_xact_lock(
    hashtextextended('hand-projection:' || v_table_id::text, 0)
  );

  RETURN public.fn_project_hand_side_effects_after_post_commit_20260908(
    p_hand_id
  );
END;
$function$;

ALTER FUNCTION public.fn_project_hand_side_effects(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_project_hand_side_effects(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_project_hand_side_effects(uuid)
  TO service_role;

COMMENT ON FUNCTION public.fn_project_hand_side_effects(uuid) IS
  'Consumes one accepted-hand post-commit envelope before claiming and applying its ordered hand projections. Lock order is hand-post-commit, hand-projection, exact outbox row.';
COMMENT ON FUNCTION
  public.fn_project_hand_side_effects_after_post_commit_20260908(uuid) IS
  'Owner-only preserved projection implementation. Call only through fn_project_hand_side_effects, which establishes post-commit-before-projection lock order.';

DO $assert_projector_lock_order$
DECLARE
  v_wrapper text;
  v_core text;
  v_scope integer;
  v_post_lock integer;
  v_post_process integer;
  v_projection_lock integer;
  v_core_call integer;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO STRICT v_wrapper
    FROM pg_proc p
   WHERE p.oid =
     'public.fn_project_hand_side_effects(uuid)'::regprocedure
     AND p.prosecdef
     AND pg_get_userbyid(p.proowner) = 'postgres';
  SELECT pg_get_functiondef(p.oid) INTO STRICT v_core
    FROM pg_proc p
   WHERE p.oid =
     'public.fn_project_hand_side_effects_after_post_commit_20260908(uuid)'::regprocedure
     AND p.prosecdef
     AND pg_get_userbyid(p.proowner) = 'postgres';

  v_scope := position('FROM public.hand_projection_outbox o' IN v_wrapper);
  v_post_lock := position('hand-post-commit:' IN v_wrapper);
  v_post_process := position(
    'fn_ca_process_hand_post_commit_obligations' IN v_wrapper
  );
  v_projection_lock := position('hand-projection:' IN v_wrapper);
  v_core_call := position(
    'fn_project_hand_side_effects_after_post_commit_20260908' IN v_wrapper
  );

  IF v_scope = 0
     OR v_post_lock <= v_scope
     OR v_post_process <= v_post_lock
     OR v_projection_lock <= v_post_process
     OR v_core_call <= v_projection_lock
     OR position('FOR UPDATE OF o' IN v_core) = 0
     OR position('predecessor_pending' IN v_core) = 0
     OR position('DELETE FROM public.hand_projection_outbox' IN v_core) = 0
     OR position('projection_applied' IN v_wrapper) = 0 THEN
    RAISE EXCEPTION 'hand projector lock order or causal guards are incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger t
     WHERE t.tgrelid = 'public.hand_projection_outbox'::regclass
       AND t.tgname = 'a0_finish_hand_post_commit_obligations'
       AND NOT t.tgisinternal
       AND position(
         'fn_ca_process_hand_post_commit_obligations' IN
         pg_get_functiondef(t.tgfoid)
       ) > 0
  ) THEN
    RAISE EXCEPTION 'idempotent post-commit delete defense is missing';
  END IF;

  IF has_function_privilege(
       'service_role',
       'public.fn_project_hand_side_effects_after_post_commit_20260908(uuid)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.fn_project_hand_side_effects_after_post_commit_20260908(uuid)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.fn_project_hand_side_effects_after_post_commit_20260908(uuid)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_project_hand_side_effects(uuid)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.fn_project_hand_side_effects(uuid)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.fn_project_hand_side_effects(uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'hand projector lock-order wrapper ACLs are wrong';
  END IF;
END;
$assert_projector_lock_order$;

COMMIT;
