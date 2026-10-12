-- A Final Table is an unlimited-MTT lifecycle phase. Fixed formats already
-- begin and end on one table, but the old count-and-table-shape gate marked
-- Spins, SNGs, seat-first satellites, and unresolved legacy rows as Final
-- Tables.
--
-- RELEASE ORDER: install 20261005111453 first, release and prove the compatible
-- client and engine, and only then install this cleanup. This transaction
-- intentionally contains no client or engine prerequisite DDL. It retires the
-- legacy customization write paths, clears Final Table false positives,
-- reconciles any MTT transition won by the old engine during rollout, and then
-- enforces the durable MTT-only contract.
-- @live-proof: EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid = 'public.tournaments'::regclass AND c.conname = 'tournaments_final_table_requires_mtt_check' AND c.convalidated)

BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '20min';

DO $guard$
DECLARE
  v_missing text;
  v_client_sha text;
  v_engine_sha text;
  v_sealed_at timestamptz;
  v_heartbeat_at timestamptz;
  v_live_versions bigint;
  v_wrong_versions bigint;
BEGIN
  IF to_regclass('public.tournaments') IS NULL THEN
    RAISE EXCEPTION 'final-table format guard: public.tournaments is missing';
  END IF;

  SELECT string_agg(required.column_name, ', ' ORDER BY required.column_name)
    INTO v_missing
    FROM (VALUES ('final_table_triggered'), ('format_contract')) AS required(column_name)
   WHERE NOT EXISTS (
     SELECT 1
       FROM information_schema.columns actual
      WHERE actual.table_schema = 'public'
        AND actual.table_name = 'tournaments'
        AND actual.column_name = required.column_name
   );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'final-table format guard: required columns are missing: %', v_missing;
  END IF;

  IF to_regclass('public.tournament_final_table_transition_receipts') IS NULL
     OR to_regclass('public.tournament_final_table_events') IS NULL
     OR to_regclass('public.phase_one_customization_prerequisite') IS NULL
     OR to_regclass('public.phase_one_customization_cutover_seals') IS NULL
     OR to_regclass('public.ca_engine_deploy_attempts') IS NULL
     OR to_regclass('public.engine_leader') IS NULL
     OR to_regclass('public.engine_table_leases') IS NULL
     OR to_regprocedure('public.fn_set_interface_theme(uuid,uuid,text)') IS NULL
     OR to_regprocedure('public.fn_mark_table_setting_touched(uuid,text[])') IS NULL
     OR to_regprocedure('public.fn_seed_table_studio_preferences(uuid,text[],jsonb)') IS NULL
     OR to_regprocedure(
       'public.fn_mutate_table_studio_preferences(uuid,text,boolean,integer,jsonb)'
     ) IS NULL
     OR to_regprocedure('public.fn_claim_final_table_transition(uuid,uuid)') IS NULL
     OR to_regprocedure('public.fn_read_final_table_transition(uuid)') IS NULL
     OR to_regprocedure('public.fn_ack_final_table_announcement(uuid,uuid)') IS NULL
     OR to_regprocedure(
       'public.fn_seal_phase_one_customization_cutover(text,text)'
     ) IS NULL THEN
    RAISE EXCEPTION
      'post-cutover guard: install 20261005111453 and release the compatible client and engine first';
  END IF;

  SELECT s.client_sha, s.engine_sha, s.sealed_at
    INTO v_client_sha, v_engine_sha, v_sealed_at
    FROM public.phase_one_customization_cutover_seals s
   WHERE s.contract = 'phase1-customization-v1'
   ORDER BY s.sealed_at DESC
   LIMIT 1;

  IF v_sealed_at IS NULL
     OR v_client_sha !~ '^[0-9a-f]{40}$'
     OR v_engine_sha !~ '^[0-9a-f]{40}$' THEN
    RAISE EXCEPTION
      'post-cutover guard: exact live client and engine identities have not been sealed'
      USING ERRCODE = '55000';
  END IF;

  -- Lease heartbeats store the audited eight-character runtime version. The
  -- seal retains the exact full SHA already proved by its shipped deploy
  -- receipt and live /health read. Fail closed on NULL or any other value.
  WITH live AS (
    SELECT l.engine_version, l.heartbeat_at
      FROM public.engine_leader l
     WHERE l.heartbeat_at > clock_timestamp() - interval '180 seconds'
    UNION ALL
    SELECT l.engine_version, l.heartbeat_at
      FROM public.engine_table_leases l
     WHERE l.heartbeat_at > clock_timestamp() - interval '180 seconds'
  )
  SELECT max(live.heartbeat_at),
         count(DISTINCT coalesce(live.engine_version, '<null>')),
         count(*) FILTER (
           WHERE live.engine_version IS DISTINCT FROM left(v_engine_sha, 8)
         )
    INTO v_heartbeat_at, v_live_versions, v_wrong_versions
    FROM live;

  IF v_heartbeat_at IS NULL OR v_live_versions <> 1 OR v_wrong_versions <> 0 THEN
    RAISE EXCEPTION
      'post-cutover guard: the sealed engine is not the one currently heartbeating'
      USING ERRCODE = '55000';
  END IF;
END;
$guard$;

-- The compatible client now uses account-bound mutation receipts. Only at
-- this post-cutover point may the direct appearance upsert and unbound legacy
-- RPC overloads be retired without breaking the serving application.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON TABLE public.user_theme_settings
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.fn_set_interface_theme(text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_mark_table_setting_touched(text[])
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_seed_table_studio_preferences(text[], jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_mutate_table_studio_preferences(text, boolean, integer, jsonb)
  FROM PUBLIC, anon, authenticated;

UPDATE public.tournaments
   SET final_table_triggered = false
 WHERE final_table_triggered IS NULL
    OR (
      final_table_triggered IS TRUE
      AND (format_contract IN ('mtt-v1', 'mtt-v2')) IS NOT TRUE
    );

ALTER TABLE public.tournaments
  ALTER COLUMN final_table_triggered SET DEFAULT false,
  ALTER COLUMN final_table_triggered SET NOT NULL;

ALTER TABLE public.tournaments
  DROP CONSTRAINT IF EXISTS tournaments_final_table_requires_mtt_check;

ALTER TABLE public.tournaments
  ADD CONSTRAINT tournaments_final_table_requires_mtt_check
  CHECK (
    final_table_triggered IS NOT TRUE
    OR (format_contract IN ('mtt-v1', 'mtt-v2')) IS TRUE
  ) NOT VALID;

ALTER TABLE public.tournaments
  VALIDATE CONSTRAINT tournaments_final_table_requires_mtt_check;

-- The legacy engine can set a valid MTT flag between the prerequisite install
-- and compatible-engine cutover. Give any such transition a non-replayable
-- owner and the same public state event before enforcing completeness.
INSERT INTO public.tournament_final_table_transition_receipts (
  tournament_id,
  ownership_token
)
SELECT t.id, gen_random_uuid()
  FROM public.tournaments t
 WHERE t.final_table_triggered IS TRUE
   AND (t.format_contract IN ('mtt-v1', 'mtt-v2')) IS TRUE
ON CONFLICT (tournament_id) DO NOTHING;

INSERT INTO public.tournament_final_table_events (tournament_id)
SELECT t.id
  FROM public.tournaments t
 WHERE t.final_table_triggered IS TRUE
   AND (t.format_contract IN ('mtt-v1', 'mtt-v2')) IS TRUE
ON CONFLICT (tournament_id) DO NOTHING;

DO $verify$
DECLARE
  v_invalid bigint;
  v_constraint_valid boolean;
BEGIN
  IF has_table_privilege('anon', 'public.user_theme_settings', 'INSERT')
     OR has_table_privilege('authenticated', 'public.user_theme_settings', 'INSERT')
     OR has_table_privilege('anon', 'public.user_theme_settings', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.user_theme_settings', 'UPDATE')
     OR has_table_privilege('anon', 'public.user_theme_settings', 'DELETE')
     OR has_table_privilege('authenticated', 'public.user_theme_settings', 'DELETE')
     OR has_table_privilege('anon', 'public.user_theme_settings', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.user_theme_settings', 'TRUNCATE')
  THEN
    RAISE EXCEPTION 'post-cutover guard: direct appearance writes remain executable';
  END IF;

  IF has_function_privilege('authenticated', 'public.fn_set_interface_theme(text)', 'EXECUTE')
     OR has_function_privilege(
       'authenticated',
       'public.fn_seed_table_studio_preferences(text[], jsonb)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.fn_mutate_table_studio_preferences(text, boolean, integer, jsonb)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.fn_mark_table_setting_touched(text[])',
       'EXECUTE'
     )
  THEN
    RAISE EXCEPTION 'post-cutover guard: an unbound customization RPC remains executable';
  END IF;

  SELECT count(*)
    INTO v_invalid
    FROM public.tournaments
   WHERE final_table_triggered IS NULL
      OR (
        final_table_triggered IS TRUE
        AND (format_contract IN ('mtt-v1', 'mtt-v2')) IS NOT TRUE
      );

  IF v_invalid <> 0 THEN
    RAISE EXCEPTION 'final-table format guard: % invalid flag(s) remain', v_invalid;
  END IF;

  SELECT count(*)
    INTO v_invalid
    FROM public.tournament_final_table_transition_receipts r
    JOIN public.tournaments t ON t.id = r.tournament_id
   WHERE t.final_table_triggered IS NOT TRUE
      OR (t.format_contract IN ('mtt-v1', 'mtt-v2')) IS NOT TRUE;

  IF v_invalid <> 0 THEN
    RAISE EXCEPTION 'final-table format guard: % invalid transition receipt(s) remain',
      v_invalid;
  END IF;

  SELECT count(*)
    INTO v_invalid
    FROM public.tournament_final_table_events e
    JOIN public.tournaments t ON t.id = e.tournament_id
   WHERE t.final_table_triggered IS NOT TRUE
      OR (t.format_contract IN ('mtt-v1', 'mtt-v2')) IS NOT TRUE;

  IF v_invalid <> 0 THEN
    RAISE EXCEPTION 'final-table format guard: % invalid public event(s) remain', v_invalid;
  END IF;

  SELECT count(*)
    INTO v_invalid
    FROM public.tournaments t
   WHERE t.final_table_triggered IS TRUE
     AND NOT EXISTS (
       SELECT 1
         FROM public.tournament_final_table_transition_receipts r
        WHERE r.tournament_id = t.id
     );

  IF v_invalid <> 0 THEN
    RAISE EXCEPTION 'final-table format guard: % triggered tournament(s) have no owner receipt',
      v_invalid;
  END IF;

  SELECT count(*)
    INTO v_invalid
    FROM public.tournaments t
   WHERE t.final_table_triggered IS TRUE
     AND NOT EXISTS (
       SELECT 1
         FROM public.tournament_final_table_events e
        WHERE e.tournament_id = t.id
     );

  IF v_invalid <> 0 THEN
    RAISE EXCEPTION 'final-table format guard: % triggered tournament(s) have no public event',
      v_invalid;
  END IF;

  SELECT convalidated
    INTO v_constraint_valid
    FROM pg_constraint
   WHERE conrelid = 'public.tournaments'::regclass
     AND conname = 'tournaments_final_table_requires_mtt_check';

  IF v_constraint_valid IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'final-table format guard is missing or unvalidated';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) AND NOT EXISTS (
    SELECT 1
      FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'tournament_final_table_events'
  ) THEN
    RAISE EXCEPTION 'final-table public event is missing from supabase_realtime';
  END IF;
END;
$verify$;

COMMIT;
