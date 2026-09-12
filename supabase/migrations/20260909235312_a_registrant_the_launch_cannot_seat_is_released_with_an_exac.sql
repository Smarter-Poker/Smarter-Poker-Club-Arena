-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260909235312; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260909235312   (the stamp IS the apply time, UTC: 2026-09-09 23:53:12)
--   name        a_registrant_the_launch_cannot_seat_is_released_with_an_exac
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 5570 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260909235312 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_ca_release_unseatable_registrant_at_launch
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

DO $gate$
DECLARE
  v_oid oid := to_regprocedure(
    'public.fn_ca_unregister_tournament_player_exact(uuid,uuid,uuid,text,uuid)');
  v_def text;
  v_old text := $old$
  IF v_start_authority='scheduled_clock' THEN
    IF v_t.start_time IS NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','registration_schedule_unset');
    END IF;
    IF clock_timestamp()>=v_t.start_time THEN
      RETURN jsonb_build_object('ok',false,'reason','tournament_started');
    END IF;
  ELSE$old$;
  v_new text := $new$
  IF v_start_authority='scheduled_clock' THEN
    IF v_t.start_time IS NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','registration_schedule_unset');
    END IF;
    /* A release performed by the launch that holds this event's INCOMPLETE
       launch receipt is pre-start: the clock has passed start_time, but no
       hand has been dealt (checked above, fails closed) and the receipt has
       not been completed. The launch names its receipt through the
       transaction-local app.ca_launch_release_launch_id, set only by
       fn_ca_release_unseatable_registrant_at_launch. */
    IF clock_timestamp()>=v_t.start_time
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_launch_receipts r
          WHERE r.tournament_id=p_tournament_id
            AND r.completed_at IS NULL
            AND r.launch_id::text=NULLIF(
              current_setting('app.ca_launch_release_launch_id',true),'')) THEN
      RETURN jsonb_build_object('ok',false,'reason','tournament_started');
    END IF;
  ELSE$new$;
  v_count integer;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'fn_ca_unregister_tournament_player_exact(uuid,uuid,uuid,text,uuid) is not installed';
  END IF;
  v_def := pg_get_functiondef(v_oid);
  v_count := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'the scheduled-clock gate of fn_ca_unregister_tournament_player_exact was expected exactly once, found %', v_count;
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END
$gate$;

CREATE OR REPLACE FUNCTION public.fn_ca_release_unseatable_registrant_at_launch(
  p_tournament_id uuid,
  p_user_id uuid,
  p_launch_id uuid,
  p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_status text;
  v_receipt public.tournament_launch_receipts%ROWTYPE;
  v_request_id uuid;
  v_result jsonb;
  v_reason text := left(COALESCE(NULLIF(btrim(p_reason),''),'seat refused'),200);
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'fn_ca_release_unseatable_registrant_at_launch requires service authority'
      USING ERRCODE='28000';
  END IF;
  IF p_tournament_id IS NULL OR p_user_id IS NULL OR p_launch_id IS NULL THEN
    RAISE EXCEPTION 'tournament, player and launch ids are required'
      USING ERRCODE='22023';
  END IF;

  SELECT upper(COALESCE(t.status::text,'')) INTO v_status
    FROM public.tournaments t WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  IF v_status<>'REGISTERING' THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_launching','status',v_status);
  END IF;

  SELECT * INTO v_receipt FROM public.tournament_launch_receipts r
   WHERE r.tournament_id=p_tournament_id FOR UPDATE;
  IF NOT FOUND OR v_receipt.launch_id<>p_launch_id OR v_receipt.completed_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','launch_receipt_mismatch');
  END IF;

  -- A seated player is never released here. If he holds a live seat in this
  -- event the launch's inventory was stale; the next pass reads him seated.
  IF EXISTS (
    SELECT 1 FROM public.table_seats s
      JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id
       AND s.user_id=p_user_id AND s.left_at IS NULL) THEN
    RETURN jsonb_build_object('ok',false,'reason','player_is_seated');
  END IF;

  -- One request id per (launch, player): a lost response replays the same
  -- unregistration receipt instead of refunding twice.
  v_request_id := md5(p_launch_id::text||':'||p_user_id::text)::uuid;

  PERFORM set_config('app.ca_launch_release_launch_id', p_launch_id::text, true);
  v_result := public.fn_ca_unregister_tournament_player_exact(
    p_tournament_id, p_user_id, NULL,
    'Released at launch (could not be seated: '||v_reason||')',
    v_request_id);
  PERFORM set_config('app.ca_launch_release_launch_id', '', true);

  RETURN COALESCE(v_result,'{}'::jsonb)
         || jsonb_build_object('released', COALESCE((v_result->>'ok')::boolean,false),
                               'request_id', v_request_id,
                               'launch_id', p_launch_id,
                               'release_reason', v_reason);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_release_unseatable_registrant_at_launch(uuid,uuid,uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_release_unseatable_registrant_at_launch(uuid,uuid,uuid,text)
  TO service_role;

COMMENT ON FUNCTION public.fn_ca_release_unseatable_registrant_at_launch(uuid,uuid,uuid,text) IS
  'The one door a launch uses to release a registrant it cannot seat: service-only, requires the event''s incomplete launch receipt by launch_id, refuses a player holding a live seat, and settles the exact refund through fn_ca_unregister_tournament_player_exact under a deterministic (launch, player) request id.';
