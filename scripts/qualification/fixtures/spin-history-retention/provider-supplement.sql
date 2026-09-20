-- Genuine current catalog restoration ONLY for the disposable Spin provider.
-- Captured 2026-09-17 06:55:37.254267 UTC. No historical/business data seeded.
-- Existing schema/trigger/ACL restoration must finish before this supplement.
-- This is not a production component or a standalone allocation/runner.
\set ON_ERROR_STOP on
BEGIN;
SELECT set_config('spin_retention_fixture.execution', :'execution_uuid', true);
DO $boundary$
BEGIN
  IF current_user<>'fixture_bootstrap' OR session_user<>'fixture_bootstrap'
     OR current_database()<>'qual_spin_expiry_'||replace(current_setting('spin_retention_fixture.execution'),'-','')
     OR current_setting('spin_retention_fixture.execution') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>''
     OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
     OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='postgres' AND NOT rolsuper)
     OR to_regclass('public.hand_history_retention_policy') IS NOT NULL
     OR to_regclass('public.hand_projection_outbox') IS NOT NULL THEN
    RAISE EXCEPTION 'spin retention provider: isolated absent-object preimage required';
  END IF;
END;
$boundary$;
\ir sequence-authority.sql
SET LOCAL ROLE postgres;
\ir provider-closure.sql
CREATE TABLE public.hand_history_retention_policy (
  "id" boolean DEFAULT true NOT NULL,
  "horse_retention_days" integer DEFAULT 7 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "note" text,
  CONSTRAINT "hand_history_retention_policy_horse_retention_days_check" CHECK (horse_retention_days >= 1),
  CONSTRAINT "hand_history_retention_policy_id_check" CHECK (id),
  CONSTRAINT "hand_history_retention_policy_pkey" PRIMARY KEY (id)
);
ALTER TABLE public.hand_history_retention_policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hand_history_retention_policy FROM PUBLIC, anon, authenticated, service_role, postgres;
GRANT ALL ON public.hand_history_retention_policy TO postgres;
GRANT SELECT, REFERENCES, TRIGGER ON public.hand_history_retention_policy TO anon, authenticated;
GRANT ALL ON public.hand_history_retention_policy TO service_role;
CREATE TABLE public.hand_projection_outbox (
  "hand_id" uuid NOT NULL,
  "table_id" uuid NOT NULL,
  "hand_number" bigint NOT NULL,
  "created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  CONSTRAINT "hand_projection_outbox_hand_number_check" CHECK (hand_number >= 1000000),
  CONSTRAINT "hand_projection_outbox_hand_number_key" UNIQUE (hand_number),
  CONSTRAINT "hand_projection_outbox_pkey" PRIMARY KEY (hand_id)
);
CREATE INDEX idx_hand_projection_outbox_table_hand ON public.hand_projection_outbox USING btree (table_id, hand_number);
ALTER TABLE public.hand_projection_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hand_projection_outbox FROM PUBLIC, anon, authenticated, service_role, postgres;
GRANT ALL ON public.hand_projection_outbox TO postgres;
GRANT SELECT ON public.hand_projection_outbox TO service_role;
DO $function_restore$
DECLARE v_source constant text := $source$CREATE OR REPLACE FUNCTION public.sp_prune_hand_history(p_batch integer DEFAULT 2500)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_budget constant interval := interval '20 seconds';
  v_deadline timestamptz := clock_timestamp()+v_budget;
  v_days integer;
  v_window interval;
  v_doomed uuid[];
  v_keepers uuid[];
  v_deleted integer := 0;
  v_round integer;
BEGIN
  SELECT greatest(coalesce(horse_retention_days,7),1)
    INTO v_days FROM public.hand_history_retention_policy LIMIT 1;
  IF v_days IS NULL THEN v_days := 7; END IF;
  v_window := make_interval(days=>v_days);

  LOOP
    v_doomed := NULL;
    v_keepers := NULL;
    WITH candidates AS (
      SELECT hh.id,hh.players
        FROM public.hand_history hh
       WHERE hh.has_human IS DISTINCT FROM true
         AND hh.reported IS NOT true
         AND hh.created_at<now()-v_window
         AND NOT EXISTS (
           SELECT 1 FROM public.bbj_payouts bp
            WHERE bp.table_id=hh.table_id AND bp.hand_number=hh.hand_number)
         AND NOT EXISTS (
           SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id=hh.id)
         AND NOT EXISTS (
           SELECT 1 FROM public.tournament_knockout_candidates c
            WHERE c.hand_id=hh.id AND c.state='pending')
       ORDER BY hh.created_at
       LIMIT p_batch
       FOR UPDATE SKIP LOCKED
    ), classified AS (
      SELECT c.id,
        CASE
          WHEN jsonb_typeof(c.players) IS DISTINCT FROM 'array' THEN true
          WHEN jsonb_array_length(c.players)=0 THEN true
          ELSE EXISTS (
            SELECT 1
              FROM jsonb_array_elements(c.players) e
              LEFT JOIN public.profiles p ON p.id=(CASE
                WHEN length(e.value->>'userId')=36
                 AND (e.value->>'userId') ~
                   '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                THEN (e.value->>'userId')::uuid END)
             WHERE p.id IS NULL OR p.is_horse IS NOT true)
        END AS is_human
        FROM candidates c
    )
    SELECT array_agg(id) FILTER (WHERE is_human IS false),
           array_agg(id) FILTER (WHERE is_human IS DISTINCT FROM false)
      INTO v_doomed,v_keepers FROM classified;

    EXIT WHEN v_doomed IS NULL AND v_keepers IS NULL;
    IF v_keepers IS NOT NULL AND cardinality(v_keepers)>0 THEN
      UPDATE public.hand_history SET has_human=true WHERE id=ANY(v_keepers);
    END IF;
    IF v_doomed IS NOT NULL AND cardinality(v_doomed)>0 THEN
      DELETE FROM public.rake_attributions WHERE hand_id=ANY(v_doomed);
      DELETE FROM public.ca_hand_player_idx WHERE hand_id=ANY(v_doomed);
      DELETE FROM public.hand_atomic_commits WHERE hand_id=ANY(v_doomed);
      DELETE FROM public.hand_history WHERE id=ANY(v_doomed);
      GET DIAGNOSTICS v_round=ROW_COUNT;
      v_deleted := v_deleted+v_round;
    END IF;
    EXIT WHEN clock_timestamp()>=v_deadline;
  END LOOP;
  RETURN v_deleted;
END;
$function$
$source$; v_oid oid := to_regprocedure('public.sp_prune_hand_history(integer)');
BEGIN
  IF md5(v_source)<>'03f156a50f882354f7d09f30fe08afd2' THEN RAISE EXCEPTION 'spin retention provider: input source changed'; END IF;
  IF v_oid IS NULL THEN
    EXECUTE v_source;
    REVOKE ALL ON FUNCTION public.sp_prune_hand_history(integer) FROM PUBLIC, anon, authenticated, service_role, postgres;
    GRANT EXECUTE ON FUNCTION public.sp_prune_hand_history(integer) TO postgres;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.sp_prune_hand_history(integer)')
      AND pg_get_functiondef(p.oid)=v_source AND pg_get_userbyid(p.proowner)='postgres'
      AND p.proacl::text='{postgres=X/postgres}') THEN
    RAISE EXCEPTION 'spin retention provider: captured function authority differs %', 'public.sp_prune_hand_history(integer)';
  END IF;
END;
$function_restore$;
DO $function_restore$
DECLARE v_source constant text := $source$CREATE OR REPLACE FUNCTION public.trg_finish_hand_post_commit_obligations()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.fn_ca_process_hand_post_commit_obligations(OLD.hand_id);
  IF COALESCE((v_result->>'ok')::boolean, false) IS NOT TRUE
     AND v_result->>'reason' <> 'legacy_no_obligations' THEN
    RAISE EXCEPTION 'hand post-commit obligations remain pending for %: %',
      OLD.hand_id, v_result;
  END IF;
  RETURN OLD;
END;
$function$
$source$; v_oid oid := to_regprocedure('public.trg_finish_hand_post_commit_obligations()');
BEGIN
  IF md5(v_source)<>'66d5a81792f64fc5ec1ab33ced6a05ba' THEN RAISE EXCEPTION 'spin retention provider: input source changed'; END IF;
  IF v_oid IS NULL THEN
    EXECUTE v_source;
    REVOKE ALL ON FUNCTION public.trg_finish_hand_post_commit_obligations() FROM PUBLIC, anon, authenticated, service_role, postgres;
    GRANT EXECUTE ON FUNCTION public.trg_finish_hand_post_commit_obligations() TO postgres;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.trg_finish_hand_post_commit_obligations()')
      AND pg_get_functiondef(p.oid)=v_source AND pg_get_userbyid(p.proowner)='postgres'
      AND p.proacl::text='{postgres=X/postgres}') THEN
    RAISE EXCEPTION 'spin retention provider: captured function authority differs %', 'public.trg_finish_hand_post_commit_obligations()';
  END IF;
END;
$function_restore$;
DO $function_restore$
DECLARE v_source constant text := $source$CREATE OR REPLACE FUNCTION public.trg_notify_hand_projection_outbox()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- The engine treats this as a wake-up only: it re-reads the outbox ordered
  -- by hand_number (server/src/services/supabase/handProjection.ts runDrain).
  -- hand_id:table_id is carried for logging and metrics, never consumed.
  PERFORM pg_notify('hand_projection_outbox', NEW.hand_id::text || ':' || coalesce(NEW.table_id::text, ''));
  RETURN NEW;
END;
$function$
$source$; v_oid oid := to_regprocedure('public.trg_notify_hand_projection_outbox()');
BEGIN
  IF md5(v_source)<>'57069a33071dbb02460486310802be90' THEN RAISE EXCEPTION 'spin retention provider: input source changed'; END IF;
  IF v_oid IS NULL THEN
    EXECUTE v_source;
    REVOKE ALL ON FUNCTION public.trg_notify_hand_projection_outbox() FROM PUBLIC, anon, authenticated, service_role, postgres;
    GRANT EXECUTE ON FUNCTION public.trg_notify_hand_projection_outbox() TO postgres;
    GRANT EXECUTE ON FUNCTION public.trg_notify_hand_projection_outbox() TO service_role;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.trg_notify_hand_projection_outbox()')
      AND pg_get_functiondef(p.oid)=v_source AND pg_get_userbyid(p.proowner)='postgres'
      AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN
    RAISE EXCEPTION 'spin retention provider: captured function authority differs %', 'public.trg_notify_hand_projection_outbox()';
  END IF;
END;
$function_restore$;
CREATE TRIGGER a0_finish_hand_post_commit_obligations BEFORE DELETE ON hand_projection_outbox FOR EACH ROW EXECUTE FUNCTION trg_finish_hand_post_commit_obligations();
CREATE TRIGGER z9_notify_hand_projection_outbox AFTER INSERT ON hand_projection_outbox FOR EACH ROW EXECUTE FUNCTION trg_notify_hand_projection_outbox();
-- The actual before-delete delegate must exist. This fixture never deletes
-- an outbox row to bypass obligations. Pruner exclusions read the real outbox.
DO $closure$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_proc p
      WHERE p.oid=to_regprocedure('public.fn_ca_process_hand_post_commit_obligations(uuid)')
        AND md5(pg_get_functiondef(p.oid))='8d18dde12765610895b25e297a1f403f'
        AND pg_get_userbyid(p.proowner)='postgres'
        AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN
    RAISE EXCEPTION 'spin retention provider: actual obligation delegate absent';
  END IF;
  IF EXISTS(SELECT 1 FROM public.hand_history_retention_policy)
     OR EXISTS(SELECT 1 FROM public.hand_projection_outbox) THEN
    RAISE EXCEPTION 'spin retention provider: schema-only restore wrote business rows';
  END IF;
END;
$closure$;
\ir provider-check.sql
COMMIT;
