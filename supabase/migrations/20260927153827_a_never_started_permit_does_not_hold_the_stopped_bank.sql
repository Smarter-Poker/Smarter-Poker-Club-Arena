-- 20260927153827_a_never_started_permit_does_not_hold_the_stopped_bank.sql
--
-- Version 20260927150704 was reserved by scripts/new-migration.mjs; the guarded install on
-- 2026-09-27 recorded it as 20260927153827, and the file carries the applied version.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- A NEVER-STARTED PERMIT DOES NOT HOLD THE STOPPED BANK (2026-09-27).
--
-- public.fn_park_stopped_time_bank_custody (20260926090846, #5323; lock wait
-- 20260926145903) refuses `hand_after_custody` when any F06 hand permit other
-- than never_started sits above the custody's hand number. That is right for
-- a hand that was dealt. It is wrong for the one permit the SAME terminal
-- engine reserved for its next hand and never started: the number was taken
-- and the row written `reserved`, then the pause or the lease loss arrived
-- before `permit.start`. Only that engine knows the hand never started -
-- `start` is a local fence and the database sees `reserved` either way - and
-- the door that records it, fn_f06_cancel_prepared_hand, requires the live
-- lease (f06_prefix -> f06_authority), which is exactly what the engine no
-- longer has.
--
-- Measured on production, release f2e484a3, 2026-09-26 15:07Z to 2026-09-27
-- 15:00Z: six tournaments (579489da, bec2c908, c53d96df, 39cd2945, 14cde86e,
-- 74042784) lost their lease at 15:07Z each holding one `reserved` permit
-- above the last dealt hand (for 28fad37d: hand_history max 14864901, permit
-- 14865646 reserved, no evidence). Every stop retried every 5 s and failed
-- "retained time-bank custody" (16,400 attempts per manager), the park logged
-- `refused (hand_after_custody)` each time, /health carried
-- stopped_bank_custody_stuck 6 at all 26 hourly countdowns, the restart
-- certificate stayed shut by law (#5267), and no release was admitted for 24
-- hours - including the releases carrying the decision-lane fixes.
--
-- The change: the park takes two optional arguments, the id and hand number
-- of the one permit the engine attests it never started. When they are
-- given, and only then, the function in the SAME transaction:
--   * locks that permit row and requires it to be this table's, this
--     tournament's, this generation's, at exactly that hand number, above the
--     custody's hand number, still `reserved` with no evidence;
--   * requires that this generation no longer holds the tournament lease
--     (no engine_tournament_leases row for it with a heartbeat in the last
--     fn_engine_lease_stale_seconds()) - a live manager uses its own door;
--   * refuses `hand_after_custody` if ANY durable witness of a start exists:
--     the exact set fn_f06_cancel_prepared_hand refuses over (f06_hand_dispatch,
--     hand_atomic_commits, hand_history, an incomplete hand_state_snapshots
--     row, hand_private_state, table_hole_cards at that hand number);
--   * records the same receipt that door records
--     (smarter_private.f06_prepared_hand_cancellations) and closes the permit
--     `never_started` with evidence_id = permit_id, as that door does.
-- Then the ordinary checks run unchanged (including #5409's exemption of a
-- reserved permit of the caller's own generation, 20260927142925), and the
-- bank is written only if they pass. A refusal writes nothing at all (one transaction). Every
-- existing refusal, the lock wait, the ACL and the security posture are
-- unchanged. Callers that pass eight arguments (the engine on every release
-- before this one, and smarter_private.fn_fenced_manager_stopped_custody_park)
-- resolve to the same function through the two defaults, and behave exactly
-- as before.
--
-- Changelog: docs/changelog/a-never-started-permit-does-not-hold-the-stopped-bank-2026-09-27.md
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '3s';

-- ── PRE-IMAGE ───────────────────────────────────────────────────────────────
DO $pre$
DECLARE
  p pg_proc;
BEGIN
  SELECT * INTO p FROM pg_proc
   WHERE oid = to_regprocedure(
     'public.fn_park_stopped_time_bank_custody(uuid,uuid,uuid,bigint,text,jsonb,jsonb,text)');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'UNSTARTED_PERMIT_PREIMAGE: fn_park_stopped_time_bank_custody(8) is missing';
  END IF;
  IF position('v_attempt >= 40' IN p.prosrc) = 0
     OR position('hand_after_custody' IN p.prosrc) = 0
     OR position('AND h.generation = p_generation' IN p.prosrc) = 0 THEN
    RAISE EXCEPTION 'UNSTARTED_PERMIT_PREIMAGE: the park is not the reviewed image (20260926145903 + 20260927142925)';
  END IF;
  IF to_regprocedure('public.fn_park_stopped_time_bank_custody(uuid,uuid,uuid,bigint,text,jsonb,jsonb,text,uuid,bigint)') IS NOT NULL THEN
    RAISE EXCEPTION 'UNSTARTED_PERMIT_PREIMAGE: the ten-argument park already exists';
  END IF;
  IF to_regclass('smarter_private.f06_prepared_hand_cancellations') IS NULL
     OR to_regclass('smarter_private.f06_hand_permits') IS NULL
     OR to_regclass('smarter_private.f06_hand_dispatch') IS NULL
     OR to_regclass('public.engine_tournament_leases') IS NULL
     OR to_regprocedure('public.fn_engine_lease_stale_seconds()') IS NULL THEN
    RAISE EXCEPTION 'UNSTARTED_PERMIT_PREIMAGE: a relation this function reads is missing';
  END IF;
  IF to_regprocedure('smarter_private.fn_fenced_manager_stopped_custody_park()') IS NULL THEN
    RAISE EXCEPTION 'UNSTARTED_PERMIT_PREIMAGE: the fenced-manager trigger function is missing';
  END IF;
END
$pre$;

DROP FUNCTION public.fn_park_stopped_time_bank_custody(uuid,uuid,uuid,bigint,text,jsonb,jsonb,text);

CREATE FUNCTION public.fn_park_stopped_time_bank_custody(
  p_table_id uuid,
  p_tournament_id uuid,
  p_generation uuid,
  p_hand_number bigint,
  p_parked_at text,
  p_disconnect_states jsonb,
  p_players jsonb,
  p_engine_instance text,
  p_unstarted_permit_id uuid DEFAULT NULL,
  p_unstarted_hand_number bigint DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_parked_at timestamptz;
  v_existing public.engine_presence_parked;
  v_found boolean;
  v_hand jsonb;
  v_rows integer;
  v_attempt integer := 0;
  v_permit smarter_private.f06_hand_permits;
  v_released uuid := NULL;
BEGIN
  /* The engine calls this at the process root, as the `service` actor. A
     manager's headers are exactly what the fence refuses once its lease is
     gone, and this record is not that manager's authority to exercise. */
  IF auth.role() IS DISTINCT FROM 'service_role'
     OR current_setting('app.smarter_data_actor', true) IS DISTINCT FROM 'service' THEN
    RAISE EXCEPTION 'STOPPED_CUSTODY_SERVICE_REQUIRED: stopped time-bank custody is written by the process, not by a manager'
      USING ERRCODE = '42501';
  END IF;
  IF p_table_id IS NULL OR p_tournament_id IS NULL
     OR p_hand_number IS NULL OR p_hand_number < 0
     OR jsonb_typeof(p_disconnect_states) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_players) IS DISTINCT FROM 'object'
     OR COALESCE(btrim(p_engine_instance), '') = ''
     OR COALESCE(p_parked_at, '') = '' THEN
    RAISE EXCEPTION 'STOPPED_CUSTODY_INVALID: table, tournament, hand number, banks, presence, instance and time are all required'
      USING ERRCODE = '22023';
  END IF;
  /* The attestation is both halves or neither, and names a hand strictly
     above the custody: a permit at or below it is not "the next hand". */
  IF (p_unstarted_permit_id IS NULL) <> (p_unstarted_hand_number IS NULL)
     OR (p_unstarted_hand_number IS NOT NULL AND p_unstarted_hand_number <= p_hand_number) THEN
    RAISE EXCEPTION 'STOPPED_CUSTODY_INVALID: an unstarted permit is attested by id and by a hand number above the custody'
      USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_parked_at := p_parked_at::timestamptz;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'STOPPED_CUSTODY_INVALID: parked_at is not a timestamp' USING ERRCODE = '22023';
  END;
  IF NOT isfinite(v_parked_at)
     OR abs(extract(epoch FROM (v_parked_at - clock_timestamp()))) > 900 THEN
    RAISE EXCEPTION 'STOPPED_CUSTODY_INVALID: parked_at is not now' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.tables t
                  WHERE t.id = p_table_id AND t.tournament_id = p_tournament_id) THEN
    RETURN jsonb_build_object('ok', false, 'refused', 'table_not_in_tournament',
                              'table_id', p_table_id);
  END IF;

  /* The transfer's prepare holds this lock while it reads this row into its
     CAS evidence. Never interleave with it; a busy lock is "not now". */
  /* A BUSY LOCK IS WAITED FOR, BRIEFLY (2026-09-26, 20260926145903).
     Every terminal engine of a tournament asks at the same :53 fan-out, and
     this lock is a try-lock, so siblings refused each other: 123
     custody_transfer_busy at 13:53Z. The engine asks again only at the next
     announcement, an hour later, and until then the table holds the restart
     certificate shut. The holder is one short transaction (this function, or
     the transfer's prepare), so ask again up to 40 times, 25 ms apart. The
     lock is still taken before anything is read or written, so the two never
     interleave; only the wait is new. */
  LOOP
    BEGIN
      PERFORM smarter_private.f06_retired_origin_lock(p_tournament_id);
      EXIT;
    EXCEPTION WHEN SQLSTATE '40001' THEN
      v_attempt := v_attempt + 1;
      IF v_attempt >= 40 THEN
        RETURN jsonb_build_object('ok', false, 'refused', 'custody_transfer_busy',
                                  'table_id', p_table_id);
      END IF;
    END;
    PERFORM pg_sleep(0.025);
  END LOOP;

  SELECT * INTO v_existing
    FROM public.engine_presence_parked p
   WHERE p.table_id = p_table_id
     FOR UPDATE;
  v_found := FOUND;

  IF EXISTS (
    SELECT 1
      FROM smarter_private.f06_manager_custody_transfers x
     WHERE x.tournament_id = p_tournament_id
       AND x.local_proof -> 'engines'
             @> jsonb_build_array(jsonb_build_object('table_id', p_table_id::text))
       AND (x.origin_generation IS NOT DISTINCT FROM p_generation
            OR NOT EXISTS (SELECT 1 FROM smarter_private.f06_manager_custody_completions c
                            WHERE c.transfer_id = x.transfer_id))
  ) THEN
    RETURN jsonb_build_object('ok', false, 'refused', 'mixed_transfer_recorded',
                              'table_id', p_table_id);
  END IF;

  IF v_found THEN
    IF v_existing.engine_instance = 'f06_mixed_custody' THEN
      RETURN jsonb_build_object('ok', false, 'refused', 'mixed_custody_adopted',
                                'table_id', p_table_id);
    END IF;
    IF v_existing.time_bank_snapshot IS NOT NULL
       AND v_existing.time_bank_snapshot <> 'null'::jsonb THEN
      v_hand := v_existing.time_bank_snapshot -> 'handNumber';
      IF jsonb_typeof(v_hand) IS DISTINCT FROM 'number'
         OR (v_hand::text)::numeric <> trunc((v_hand::text)::numeric) THEN
        RETURN jsonb_build_object('ok', false, 'refused', 'existing_park_unreadable',
                                  'table_id', p_table_id);
      END IF;
      IF (v_hand::text)::numeric > p_hand_number THEN
        RETURN jsonb_build_object('ok', false, 'refused', 'newer_park',
                                  'table_id', p_table_id,
                                  'existing_hand_number', v_hand);
      END IF;
    END IF;
  END IF;

  /* A NEVER-STARTED PERMIT DOES NOT HOLD THE BANK (2026-09-27). The engine
     that holds this custody attests the one permit it reserved above it and
     never started. Only the original process can say that (start is a local
     fence), and its own door is fenced with its lease; so it is recorded
     here, as the process, under the same refusals that door applies, and
     only for a generation that no longer holds the lease. A live manager is
     never second-guessed: it has fn_f06_cancel_prepared_hand. */
  IF p_unstarted_permit_id IS NOT NULL THEN
    SELECT * INTO v_permit
      FROM smarter_private.f06_hand_permits h
     WHERE h.permit_id = p_unstarted_permit_id
       FOR UPDATE;
    IF NOT FOUND
       OR v_permit.table_id IS DISTINCT FROM p_table_id
       OR v_permit.tournament_id IS DISTINCT FROM p_tournament_id
       OR v_permit.generation IS DISTINCT FROM p_generation
       OR v_permit.hand_number IS DISTINCT FROM p_unstarted_hand_number THEN
      RETURN jsonb_build_object('ok', false, 'refused', 'unstarted_permit_not_this_engines',
                                'table_id', p_table_id, 'permit_id', p_unstarted_permit_id);
    END IF;
    IF v_permit.state = 'never_started' THEN
      /* Already recorded (a receipt replayed, or the prepared cancellation
         landed after all): nothing to close, and nothing above the custody. */
      v_released := p_unstarted_permit_id;
    ELSE
      IF v_permit.state <> 'reserved' OR v_permit.evidence_id IS NOT NULL THEN
        RETURN jsonb_build_object('ok', false, 'refused', 'hand_after_custody',
                                  'evidence', 'f06_hand_permits',
                                  'permit_state', v_permit.state, 'table_id', p_table_id);
      END IF;
      IF EXISTS (SELECT 1 FROM public.engine_tournament_leases l
                  WHERE l.tournament_id = p_tournament_id
                    AND l.lease_generation = p_generation
                    AND l.heartbeat_at >= clock_timestamp()
                        - make_interval(secs => public.fn_engine_lease_stale_seconds())) THEN
        RETURN jsonb_build_object('ok', false, 'refused', 'unstarted_permit_generation_live',
                                  'table_id', p_table_id, 'permit_id', p_unstarted_permit_id);
      END IF;
      /* Durable witnesses only REFUSE a claimed no-start; their absence cannot
         grant it - the engine's attestation is the grant, exactly as in
         fn_f06_cancel_prepared_hand. */
      IF EXISTS (SELECT 1 FROM smarter_private.f06_hand_dispatch d WHERE d.permit_id = p_unstarted_permit_id)
         OR EXISTS (SELECT 1 FROM public.hand_atomic_commits h
                     WHERE h.table_id = p_table_id AND h.hand_number = p_unstarted_hand_number)
         OR EXISTS (SELECT 1 FROM public.hand_history h
                     WHERE h.table_id = p_table_id AND h.hand_number = p_unstarted_hand_number)
         OR EXISTS (SELECT 1 FROM public.hand_state_snapshots h
                     WHERE h.table_id = p_table_id AND NOT h.is_complete
                       AND h.hand_number = p_unstarted_hand_number)
         OR EXISTS (SELECT 1 FROM public.hand_private_state h
                     WHERE h.table_id = p_table_id AND h.hand_number = p_unstarted_hand_number)
         OR EXISTS (SELECT 1 FROM public.table_hole_cards h
                     WHERE h.table_id = p_table_id AND h.hand_number = p_unstarted_hand_number) THEN
        RETURN jsonb_build_object('ok', false, 'refused', 'hand_after_custody',
                                  'evidence', 'unstarted_permit_start_witness',
                                  'table_id', p_table_id, 'permit_id', p_unstarted_permit_id);
      END IF;
      INSERT INTO smarter_private.f06_prepared_hand_cancellations
        (permit_id, tournament_id, generation, table_id, lifecycle, hand_number, custody_id)
      VALUES
        (v_permit.permit_id, v_permit.tournament_id, v_permit.generation, v_permit.table_id,
         v_permit.lifecycle, v_permit.hand_number, v_permit.custody_id);
      UPDATE smarter_private.f06_hand_permits
         SET state = 'never_started', evidence_id = p_unstarted_permit_id
       WHERE permit_id = p_unstarted_permit_id AND state = 'reserved' AND evidence_id IS NULL;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'STOPPED_CUSTODY_PERMIT_RACE: the reserved permit changed under its lock'
          USING ERRCODE = '55000';
      END IF;
      v_released := p_unstarted_permit_id;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM public.hand_history h
              WHERE h.table_id = p_table_id AND h.hand_number > p_hand_number) THEN
    RETURN jsonb_build_object('ok', false, 'refused', 'hand_after_custody',
                              'evidence', 'hand_history', 'table_id', p_table_id);
  END IF;
  IF EXISTS (SELECT 1 FROM public.hand_atomic_commits h
              WHERE h.table_id = p_table_id AND h.hand_number > p_hand_number) THEN
    RETURN jsonb_build_object('ok', false, 'refused', 'hand_after_custody',
                              'evidence', 'hand_atomic_commits', 'table_id', p_table_id);
  END IF;
  IF EXISTS (SELECT 1 FROM public.hand_state_snapshots h
              WHERE h.table_id = p_table_id AND h.hand_number > p_hand_number) THEN
    RETURN jsonb_build_object('ok', false, 'refused', 'hand_after_custody',
                              'evidence', 'hand_state_snapshots', 'table_id', p_table_id);
  END IF;
  /* A STOPPED ENGINE'S OWN RESERVED HAND IS NOT A HAND AFTER ITS CUSTODY
     (2026-09-27, 20260927142925, #5409). A reserved permit of the caller's
     own generation is not evidence of a later hand; a reserved permit of
     ANOTHER generation, and every accepted or aborted_unsettled permit,
     still refuses. Unchanged here. The attestation above goes one step
     further for the one permit the engine names: it is closed
     never_started with a receipt, so the successor never meets it as
     hand_permit_unresolved and this engine's preparation is resolved. */
  IF EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits h
              WHERE h.table_id = p_table_id AND h.hand_number > p_hand_number
                AND h.state <> 'never_started'
                AND NOT (h.state = 'reserved'
                         AND p_generation IS NOT NULL
                         AND h.generation = p_generation)) THEN
    RETURN jsonb_build_object('ok', false, 'refused', 'hand_after_custody',
                              'evidence', 'f06_hand_permits', 'table_id', p_table_id);
  END IF;

  IF v_found THEN
    UPDATE public.engine_presence_parked
       SET disconnect_states = p_disconnect_states,
           parked_at = v_parked_at,
           engine_instance = p_engine_instance,
           time_bank_snapshot = jsonb_build_object(
             'version', 1, 'parkedAt', p_parked_at,
             'handNumber', p_hand_number, 'players', p_players)
     WHERE table_id = p_table_id;
  ELSE
    INSERT INTO public.engine_presence_parked
      (table_id, disconnect_states, parked_at, engine_instance, time_bank_snapshot)
    VALUES
      (p_table_id, p_disconnect_states, v_parked_at, p_engine_instance,
       jsonb_build_object('version', 1, 'parkedAt', p_parked_at,
                          'handNumber', p_hand_number, 'players', p_players))
    ON CONFLICT (table_id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RETURN jsonb_build_object('ok', false, 'refused', 'concurrent_park',
                                'table_id', p_table_id);
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'table_id', p_table_id,
                            'hand_number', p_hand_number, 'parked_at', p_parked_at,
                            'unstarted_permit_released', v_released);
END
$function$;

COMMENT ON FUNCTION public.fn_park_stopped_time_bank_custody(uuid,uuid,uuid,bigint,text,jsonb,jsonb,text,uuid,bigint) IS
  'Writes a terminal tournament engine''s frozen stopped time-bank custody to engine_presence_parked as the service actor, only when it cannot clobber newer state (no later hand, no newer park, no open F06 mixed transfer). With the engine''s attestation of the one permit it reserved above the custody and never started, closes that permit never_started in the same transaction, only for a generation that no longer holds the lease and only without a durable start witness. Refusals are named and write nothing. 2026-09-26, 2026-09-27.';

REVOKE ALL ON FUNCTION public.fn_park_stopped_time_bank_custody(uuid,uuid,uuid,bigint,text,jsonb,jsonb,text,uuid,bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_park_stopped_time_bank_custody(uuid,uuid,uuid,bigint,text,jsonb,jsonb,text,uuid,bigint)
  TO service_role;

-- ── POST-IMAGE ──────────────────────────────────────────────────────────────
DO $post$
DECLARE
  p pg_proc;
BEGIN
  SELECT * INTO p FROM pg_proc
   WHERE oid = to_regprocedure(
     'public.fn_park_stopped_time_bank_custody(uuid,uuid,uuid,bigint,text,jsonb,jsonb,text,uuid,bigint)');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'UNSTARTED_PERMIT_POSTIMAGE: function missing';
  END IF;
  IF (SELECT count(*) FROM pg_proc q JOIN pg_namespace n ON n.oid = q.pronamespace
       WHERE n.nspname = 'public' AND q.proname = 'fn_park_stopped_time_bank_custody') <> 1 THEN
    RAISE EXCEPTION 'UNSTARTED_PERMIT_POSTIMAGE: the park must have exactly one definition';
  END IF;
  IF pg_get_userbyid(p.proowner) IS DISTINCT FROM 'postgres'
     OR p.prosecdef IS DISTINCT FROM true
     OR p.provolatile IS DISTINCT FROM 'v'
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
     OR p.prorettype IS DISTINCT FROM 'jsonb'::regtype
     OR p.pronargdefaults IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'UNSTARTED_PERMIT_POSTIMAGE: owner/security/volatility/config/defaults is not the reviewed image (%, %, %, %, %)',
      pg_get_userbyid(p.proowner), p.prosecdef, p.provolatile, p.proconfig, p.pronargdefaults;
  END IF;
  IF (SELECT array_agg(a::text ORDER BY a::text) FROM unnest(p.proacl) a)
     IS DISTINCT FROM ARRAY['postgres=X/postgres', 'service_role=X/postgres'] THEN
    RAISE EXCEPTION 'UNSTARTED_PERMIT_POSTIMAGE: ACL is not exactly {postgres, service_role}: %', p.proacl;
  END IF;
  IF position('FOR UPDATE' IN p.prosrc) = 0
     OR position('f06_retired_origin_lock' IN p.prosrc) = 0
     OR position('v_attempt >= 40' IN p.prosrc) = 0
     OR position('newer_park' IN p.prosrc) = 0
     OR position('hand_after_custody' IN p.prosrc) = 0
     OR position('mixed_transfer_recorded' IN p.prosrc) = 0
     OR position('app.smarter_data_actor' IN p.prosrc) = 0
     OR position('unstarted_permit_generation_live' IN p.prosrc) = 0
     OR position('unstarted_permit_start_witness' IN p.prosrc) = 0
     OR position('f06_prepared_hand_cancellations' IN p.prosrc) = 0
     OR position('AND h.generation = p_generation' IN p.prosrc) = 0
     OR position('fn_engine_lease_stale_seconds' IN p.prosrc) = 0 THEN
    RAISE EXCEPTION 'UNSTARTED_PERMIT_POSTIMAGE: a guard is missing from the body';
  END IF;
  /* The eight-argument callers still resolve: the trigger passes eight
     positional arguments and the engine before this release passes eight
     named ones; both must land on this one definition. */
  IF to_regprocedure('public.fn_park_stopped_time_bank_custody(uuid,uuid,uuid,bigint,text,jsonb,jsonb,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'UNSTARTED_PERMIT_POSTIMAGE: the eight-argument overload must not coexist';
  END IF;
END
$post$;

COMMIT;
