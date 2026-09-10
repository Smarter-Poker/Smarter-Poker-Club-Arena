-- 20260909235232_a_registrant_the_launch_cannot_seat_is_released_with_an_exac.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- A tournament launch seats its roster one atomic RPC at a time and, until
-- now, the engine treated ONE refused chair as a failed launch: the receipt
-- stayed incomplete, the event stayed REGISTERING, and the other 380 players
-- sat on felt that never dealt. On 2026-09-09 that was a legacy-id verifier
-- bug; on 2026-09-09 morning it was 13 registrants the four-table guard
-- refused at the chair (see club-arena-tournament-seat-moves). The shape is
-- the same either way: a player the platform cannot seat at start must not
-- hold the start hostage. He is released with his exact refund, and the
-- field starts without him.
--
-- The exact refund authority for a registration already exists -
-- fn_ca_unregister_tournament_player_exact - and it is the ONLY writer that
-- may refund a registration (10.9: never hand-write a wallet row). Its gate
-- refuses once clock_timestamp() >= start_time, which is exactly when a
-- launch runs. This migration:
--
--   1. gives it one more start authority, launch_release: a release performed
--      by the launch that holds the event's incomplete launch receipt
--      (transaction-local app.ca_launch_release_launch_id equal to the
--      receipt's launch_id) is judged by the seat-first proofs - no hand
--      dealt, started_at unset, launch not completed - because the event has
--      not started, and its receipt says so. The edit is made by substitution
--      against the catalogue, asserted to match exactly once, so the other
--      ~16,000 characters of money path are not retyped. The receipt table's
--      start-authority check admits the new value.
--   2. adds the one door the engine calls,
--      fn_ca_release_unseatable_registrant_at_launch: service-only, verifies
--      the incomplete receipt by launch_id, verifies the player holds NO live
--      seat in the event (a seated player is never released - that is a
--      different defect), derives a deterministic request id from
--      (launch_id, user_id) so a lost response replays the same receipt, and
--      settles through the exact authority above.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

DO $gate$
DECLARE
  v_oid oid := to_regprocedure(
    'public.fn_ca_unregister_tournament_player_exact(uuid,uuid,uuid,text,uuid)');
  v_def text;
  v_release_clause text := $clause$
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_launch_receipts r
          WHERE r.tournament_id=p_tournament_id
            AND r.completed_at IS NULL
            AND r.launch_id::text=NULLIF(
              current_setting('app.ca_launch_release_launch_id',true),''))$clause$;
  /* An earlier cut of this migration patched the two scheduled-clock gates
     directly and was applied live; the honest shape is a start AUTHORITY of
     its own, so the receipt says what happened. Gates one and two are put
     back to their original text wherever the earlier cut is found. */
  v_gate1_original text := $t$
    IF clock_timestamp()>=v_t.start_time THEN
      RETURN jsonb_build_object('ok',false,'reason','tournament_started');
    END IF;
  ELSE$t$;
  v_gate1_patched text;
  v_gate2_original text := $t$
    IF v_unregistered_at>=v_t.start_time THEN
      RAISE EXCEPTION 'tournament started before unregistration could commit'
        USING ERRCODE='55000';
    END IF;
  ELSE$t$;
  v_gate2_patched text;
  -- The authority: after the spin / heads-up classification.
  v_auth_old text := $t$
    v_start_authority:='heads_up_sng_actual_start';
  END IF;
$t$;
  v_auth_new text := $t$
    v_start_authority:='heads_up_sng_actual_start';
  END IF;
  /* A release performed by the launch that holds this event's INCOMPLETE
     launch receipt has its own start authority. The clock has passed
     start_time, but no hand has been dealt (checked below, fails closed)
     and the receipt has not been completed, so the seat-first proofs -
     started_at unset, launch not completed - are the right ones and the
     receipt records launch_release. The launch names its receipt through
     the transaction-local app.ca_launch_release_launch_id, set only by
     fn_ca_release_unseatable_registrant_at_launch. */
  IF v_start_authority='scheduled_clock' AND EXISTS (
       SELECT 1 FROM public.tournament_launch_receipts r
        WHERE r.tournament_id=p_tournament_id
          AND r.completed_at IS NULL
          AND r.launch_id::text=NULLIF(
            current_setting('app.ca_launch_release_launch_id',true),'')) THEN
    v_start_authority:='launch_release';
  END IF;
$t$;
  v_changed boolean := false;
  v_n integer;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'fn_ca_unregister_tournament_player_exact(uuid,uuid,uuid,text,uuid) is not installed';
  END IF;
  v_gate1_patched := $t$
    /* A release performed by the launch that holds this event's INCOMPLETE
       launch receipt is pre-start: the clock has passed start_time, but no
       hand has been dealt (checked above, fails closed) and the receipt has
       not been completed. The launch names its receipt through the
       transaction-local app.ca_launch_release_launch_id, set only by
       fn_ca_release_unseatable_registrant_at_launch. */
    IF clock_timestamp()>=v_t.start_time$t$ || v_release_clause || $t$ THEN
      RETURN jsonb_build_object('ok',false,'reason','tournament_started');
    END IF;
  ELSE$t$;
  v_gate2_patched := $t$
    IF v_unregistered_at>=v_t.start_time$t$ || v_release_clause || $t$ THEN
      RAISE EXCEPTION 'tournament started before unregistration could commit'
        USING ERRCODE='55000';
    END IF;
  ELSE$t$;
  v_def := pg_get_functiondef(v_oid);
  IF position(v_gate1_patched IN v_def) > 0 THEN
    v_def := replace(v_def, v_gate1_patched, v_gate1_original); v_changed := true;
  END IF;
  IF position(v_gate2_patched IN v_def) > 0 THEN
    v_def := replace(v_def, v_gate2_patched, v_gate2_original); v_changed := true;
  END IF;
  IF position(v_gate1_original IN v_def) = 0 OR position(v_gate2_original IN v_def) = 0 THEN
    RAISE EXCEPTION 'the scheduled-clock gates of fn_ca_unregister_tournament_player_exact are not in a known shape';
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_auth_old, ''))) / length(v_auth_old);
  IF position(v_auth_new IN v_def) = 0 THEN
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the start-authority block of fn_ca_unregister_tournament_player_exact was expected exactly once, found %', v_n;
    END IF;
    v_def := replace(v_def, v_auth_old, v_auth_new); v_changed := true;
  END IF;
  IF v_changed THEN EXECUTE v_def; END IF;
END
$gate$;

-- The receipt reader re-proves every receipt it returns. It learns the new
-- authority the same way: by substitution, asserted to match exactly once.
DO $reader$
DECLARE
  v_oid oid := to_regprocedure(
    'public.fn_ca_tournament_unregistration_receipt(uuid,uuid,uuid,uuid)');
  v_def text;
  v_old1 text := $t$     OR (v_r.start_authority IN (
           'spin_actual_start','heads_up_sng_actual_start')
       AND EXISTS ($t$;
  v_new1 text := $t$     OR (v_r.start_authority IN (
           'spin_actual_start','heads_up_sng_actual_start','launch_release')
       AND EXISTS ($t$;
  v_old2 text := $t$     OR v_r.start_authority NOT IN (
          'scheduled_clock','spin_actual_start','heads_up_sng_actual_start')$t$;
  v_new2 text := $t$     OR v_r.start_authority NOT IN (
          'scheduled_clock','spin_actual_start','heads_up_sng_actual_start',
          'launch_release')$t$;
  v_changed boolean := false;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'fn_ca_tournament_unregistration_receipt(uuid,uuid,uuid,uuid) is not installed';
  END IF;
  v_def := pg_get_functiondef(v_oid);
  IF position(v_new1 IN v_def) = 0 THEN
    IF (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1) <> 1 THEN
      RAISE EXCEPTION 'the seat-first authority clause of fn_ca_tournament_unregistration_receipt was expected exactly once';
    END IF;
    v_def := replace(v_def, v_old1, v_new1); v_changed := true;
  END IF;
  IF position(v_new2 IN v_def) = 0 THEN
    IF (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2) <> 1 THEN
      RAISE EXCEPTION 'the authority whitelist of fn_ca_tournament_unregistration_receipt was expected exactly once';
    END IF;
    v_def := replace(v_def, v_old2, v_new2); v_changed := true;
  END IF;
  IF v_changed THEN EXECUTE v_def; END IF;
END
$reader$;

-- The receipt names its authority. launch_release joins the two seat-first
-- authorities: settled after the advertised start, before any hand.
ALTER TABLE public.tournament_unregistration_receipts
  DROP CONSTRAINT IF EXISTS tournament_unregistration_actual_start_check;
ALTER TABLE public.tournament_unregistration_receipts
  ADD CONSTRAINT tournament_unregistration_actual_start_check CHECK (
    (start_authority = 'scheduled_clock' AND settled_at < scheduled_start_at)
    OR start_authority IN ('spin_actual_start', 'heads_up_sng_actual_start', 'launch_release'));

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

COMMIT;
