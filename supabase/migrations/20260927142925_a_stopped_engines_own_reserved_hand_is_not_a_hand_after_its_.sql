-- 20260927142925_a_stopped_engines_own_reserved_hand_is_not_a_hand_after_its_.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- One transaction (CLAUDE.md production DDL policy).
--
-- WHAT THIS CHANGES, AND WHY:
--
-- public.fn_park_stopped_time_bank_custody (#5323, then 20260926145903) answers
-- hand_after_custody when any f06_hand_permits row for the table has a hand
-- number above the custody's and a state other than never_started. That
-- includes 'reserved': the permit a table takes for its NEXT hand just before
-- it deals. Six tournament managers lost their leases at 15:07Z on 2026-09-26
-- in exactly that instant (579489da, bec2c908, c53d96df, 39cd2945, 14cde86e,
-- 74042784). Each table holds one reserved permit of the SAME generation as its
-- stopped custody (hands 14865642..14865656), with no hand_history,
-- hand_atomic_commits or hand_state_snapshots row after the custody's hand.
-- The engine's own unfinished reservation refused its own custody, the stop
-- failed "retained time-bank custody" 16,000 times per manager, /health showed
-- stopped_bank_custody_stuck=6 at every countdown, the restart certificate
-- never opened, and every engine release since 15:09Z on 2026-09-26 failed.
--
-- The only change: a 'reserved' permit whose generation IS the caller's
-- generation is not evidence of a later hand. A reserved permit of any other
-- generation, every accepted or aborted_unsettled permit, and every
-- hand_history / hand_atomic_commits / hand_state_snapshots row after the
-- custody still refuse. The lock, every other refusal, SECURITY DEFINER, the
-- search_path and the ACL are unchanged and pinned below.

BEGIN;
SET LOCAL lock_timeout = '3s';

DO $pre$
DECLARE
  p pg_proc;
BEGIN
  SELECT * INTO p FROM pg_proc
   WHERE oid = 'public.fn_park_stopped_time_bank_custody(uuid,uuid,uuid,bigint,text,jsonb,jsonb,text)'::regprocedure;
  IF md5(p.prosrc) IS DISTINCT FROM '3515641cabc3fbfa5c39b9b377285750' THEN
    RAISE EXCEPTION 'STOPPED_CUSTODY_PREIMAGE: body is not 20260926145903 (md5 %)', md5(p.prosrc);
  END IF;
  IF pg_get_userbyid(p.proowner) IS DISTINCT FROM 'postgres'
     OR p.proacl::text[] IS DISTINCT FROM ARRAY['postgres=X/postgres', 'service_role=X/postgres']
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
     OR NOT p.prosecdef
     OR p.provolatile IS DISTINCT FROM 'v' THEN
    RAISE EXCEPTION 'STOPPED_CUSTODY_PREIMAGE: owner/ACL/config/definer/volatility changed: % % % % %',
      pg_get_userbyid(p.proowner), p.proacl, p.proconfig, p.prosecdef, p.provolatile;
  END IF;
END
$pre$;

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
  /* A STOPPED ENGINE'S OWN RESERVED HAND IS NOT A HAND AFTER ITS CUSTODY
     (2026-09-27, 20260927142925). A table that loses its manager's lease
     while it is about to deal has already reserved the next hand's permit
     under that same generation; nothing was committed, snapshotted or
     recorded for it (the three checks above prove that). Counting it as a
     later hand refused this engine's own custody forever: six managers
     quarantined for 24 hours, 16,000 stop attempts each, and the restart
     certificate shut at every break, so no engine release could ship. A
     reserved permit of ANOTHER generation, and every accepted or
     aborted_unsettled permit, still refuses. */
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
                            'hand_number', p_hand_number, 'parked_at', p_parked_at);
END
$function$;

REVOKE ALL ON FUNCTION public.fn_park_stopped_time_bank_custody(uuid,uuid,uuid,bigint,text,jsonb,jsonb,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_park_stopped_time_bank_custody(uuid,uuid,uuid,bigint,text,jsonb,jsonb,text) TO service_role;

DO $post$
DECLARE
  p pg_proc;
BEGIN
  SELECT * INTO p FROM pg_proc
   WHERE oid = 'public.fn_park_stopped_time_bank_custody(uuid,uuid,uuid,bigint,text,jsonb,jsonb,text)'::regprocedure;
  IF NOT p.prosecdef OR p.provolatile IS DISTINCT FROM 'v'
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
     OR pg_get_userbyid(p.proowner) IS DISTINCT FROM 'postgres' THEN
    RAISE EXCEPTION 'STOPPED_CUSTODY_POSTIMAGE: definer/volatility/config/owner changed';
  END IF;
  IF p.proacl::text[] IS DISTINCT FROM ARRAY['postgres=X/postgres', 'service_role=X/postgres'] THEN
    RAISE EXCEPTION 'STOPPED_CUSTODY_POSTIMAGE: ACL is not exactly {postgres, service_role}: %', p.proacl;
  END IF;
  IF position('FOR UPDATE' IN p.prosrc) = 0
     OR position('f06_retired_origin_lock' IN p.prosrc) = 0
     OR position('newer_park' IN p.prosrc) = 0
     OR position('hand_after_custody' IN p.prosrc) = 0
     OR position('mixed_transfer_recorded' IN p.prosrc) = 0
     OR position('mixed_custody_adopted' IN p.prosrc) = 0
     OR position('custody_transfer_busy' IN p.prosrc) = 0
     OR position('v_attempt >= 40' IN p.prosrc) = 0
     OR position('app.smarter_data_actor' IN p.prosrc) = 0
     OR position('AND h.generation = p_generation' IN p.prosrc) = 0
     OR position('AND p_generation IS NOT NULL' IN p.prosrc) = 0 THEN
    RAISE EXCEPTION 'STOPPED_CUSTODY_POSTIMAGE: a guard is missing from the body';
  END IF;
END
$post$;

COMMIT;
