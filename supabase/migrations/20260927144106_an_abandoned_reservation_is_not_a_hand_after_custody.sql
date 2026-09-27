-- 20260927144106_an_abandoned_reservation_is_not_a_hand_after_custody.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- One transaction, one schema-cache reload (CLAUDE.md production DDL policy).
--
-- WHAT THIS CHANGES, AND WHY:
--
-- public.fn_park_stopped_time_bank_custody (#5323, last 20260926145903) is
-- the only way a terminal tournament engine writes the time banks it froze
-- at its stop. Until the write is confirmed the engine reports
-- stopped_bank_custody_unwritten, and past ten minutes
-- stopped_bank_custody_stuck, which refuses the restart certificate by
-- design (no bank or custody reason enters the release allow-list).
--
-- Since 2026-09-26 15:06:39Z six such engines on f2e484a3 (tables 36f1dd0d,
-- e9883efa, 357a379e, 28fad37d, 46331f63, 9df7f1b5; six Spin/SNG events whose
-- managers lost their leases in the same second) have been refused at every
-- :53 announcement, and engine_maintenance_break_log shows
-- unparked_at_countdown = 6 at every break from 15:55Z on 09-26 to 13:55Z on
-- 09-27 with ready_for_restart_at NULL throughout: no engine release could
-- cut over for 23 hours. A rolled-back probe of this function against each of
-- the six, at its last accepted hand, returned
--   {"ok": false, "refused": "hand_after_custody", "evidence": "f06_hand_permits"}
-- for all six. Each table holds exactly one permit above that hand, state
-- 'reserved', same generation as its lease, and no hand_history,
-- hand_atomic_commits or hand_state_snapshots row after it: the next hand's
-- reservation, taken under the rest, whose cancellation the lease loss fenced.
--
-- The only change is that permit clause: a 'reserved' permit of the caller's
-- own tournament and generation above the caller's hand no longer counts as a
-- hand after custody. Every other refusal, the lock-before-read order, the
-- ON CONFLICT DO NOTHING insert, SECURITY DEFINER and the ACL are unchanged
-- and pinned by the postimage. No permit, seat or chip row is written.
--
-- Law: tests/an-abandoned-reservation-is-not-a-hand-after-custody.law.test.ts
-- Changelog: docs/changelog/2026-09-27-an-abandoned-reservation-is-not-a-hand-after-custody.md

BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.fn_park_stopped_time_bank_custody(p_table_id uuid, p_tournament_id uuid, p_generation uuid, p_hand_number bigint, p_parked_at text, p_disconnect_states jsonb, p_players jsonb, p_engine_instance text)
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
  /* AN ABANDONED RESERVATION IS NOT A HAND AFTER CUSTODY (2026-09-27,
     20260927144106). A tournament engine reserves its NEXT hand's permit
     under the rest, before it deals. When its manager's lease is lost in
     that gap, the dealing loop exits with the hand never started: it puts
     handCount back to the last completed hand (dealHand's finally, "a
     reserved number abandoned before start is not a completed boundary")
     and tries to cancel the reservation - a request the database fences,
     because the lease that would authorise it is gone. The permit stays
     'reserved', and this function then read it as a hand dealt after the
     custody and refused hand_after_custody on every announcement for ever.
     Measured 2026-09-27: all six stopped_bank_custody_stuck tables on
     engine f2e484a3 held exactly this, one 'reserved' permit each at a hand
     number above the last accepted one, same generation, no hand_history,
     hand_atomic_commits or hand_state_snapshots row after the custody -
     and they held the restart certificate shut for 26 consecutive breaks.

     The caller is the witness: it is the terminal engine of THIS generation,
     it has joined its own dealing loop, and it names the last hand it
     completed. A reservation of the same tournament and generation above
     that hand is therefore its own preparation that never started. Every
     record of a hand that DID start still refuses (the three checks above),
     a permit of any other generation still refuses, and any state other
     than 'reserved' or 'never_started' still refuses. The permit itself is
     not touched here: it stays 'reserved' for the successor generation's
     abandoned-generation door to decide, exactly as before. */
  IF EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits h
              WHERE h.table_id = p_table_id AND h.hand_number > p_hand_number
                AND h.state <> 'never_started'
                AND NOT (h.state = 'reserved'
                         AND p_generation IS NOT NULL
                         AND h.generation = p_generation
                         AND h.tournament_id = p_tournament_id)) THEN
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
                            'hand_number', p_hand_number, 'parked_at', p_parked_at);
END
$function$;

DO $post$
DECLARE
  p pg_proc;
BEGIN
  SELECT * INTO p FROM pg_proc
   WHERE oid = 'public.fn_park_stopped_time_bank_custody(uuid,uuid,uuid,bigint,text,jsonb,jsonb,text)'::regprocedure;
  IF NOT p.prosecdef THEN
    RAISE EXCEPTION 'STOPPED_CUSTODY_POSTIMAGE: no longer SECURITY DEFINER';
  END IF;
  IF p.proacl::text[] IS DISTINCT FROM ARRAY['postgres=X/postgres', 'service_role=X/postgres'] THEN
    RAISE EXCEPTION 'STOPPED_CUSTODY_POSTIMAGE: ACL is not exactly {postgres, service_role}: %', p.proacl;
  END IF;
  IF position('FOR UPDATE' IN p.prosrc) = 0
     OR position('f06_retired_origin_lock' IN p.prosrc) = 0
     OR position('newer_park' IN p.prosrc) = 0
     OR position('hand_after_custody' IN p.prosrc) = 0
     OR position('mixed_transfer_recorded' IN p.prosrc) = 0
     OR position('custody_transfer_busy' IN p.prosrc) = 0
     OR position('v_attempt >= 40' IN p.prosrc) = 0
     OR position('app.smarter_data_actor' IN p.prosrc) = 0
     OR position('AND h.generation = p_generation' IN p.prosrc) = 0
     OR position('AND h.tournament_id = p_tournament_id' IN p.prosrc) = 0
     OR position('''hand_state_snapshots'', ''table_id''' IN p.prosrc) = 0 THEN
    RAISE EXCEPTION 'STOPPED_CUSTODY_POSTIMAGE: a guard is missing from the body';
  END IF;
END
$post$;

COMMIT;
