-- 20260926090846_a_terminal_engines_frozen_time_bank_is_not_manager_authority.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- A TERMINAL ENGINE'S FROZEN TIME BANK IS NOT MANAGER AUTHORITY (2026-09-26).
--
-- Club Arena's engine collapsed about an hour after each of today's restarts
-- (f1d956c3 at 04:45Z, 209d1b45 at ~07:52Z; at the peak 436 tournament
-- managers quarantined and 487 tables stalled). The chain, read on production:
--
--   1. A tournament manager loses its lease; its table engines go terminal
--      holding stopped time-bank custody (a frozen, immutable record of every
--      seated player's bank at one hand number).
--   2. #5255 made such an engine write that custody to engine_presence_parked
--      with an UNCONDITIONAL upsert - but under the DEAD manager's data-actor
--      headers, and smarter_private.fn_smarter_data_api_pre_request fences
--      every request of a lease that is no longer current:
--        [savePresenceAtPark] <table>: TOURNAMENT_MANAGER_FENCED: lease
--        generation is no longer current            (698 in 16 minutes)
--   3. With the bank never on disk, the manager's stop fails "retained
--      time-bank custody" (134,904 in the same 16 minutes), the retirement
--      reads the park row under the same dead headers, is fenced again, and
--      throws f06_mixed_bank_evidence_unavailable (100,607). The manager is
--      quarantined, its tables stall, and stopped_bank_custody_stuck holds the
--      restart certificate shut until someone restarts the engine by hand.
--
-- The fence exists to stop a stale manager from corrupting a successor's live
-- state. Writing down a bank balance that was frozen at a known hand number is
-- not manager data authority - it is the process recording what it holds - so
-- the engine now writes it as the `service` actor, through this function, which
-- replaces the unconditional upsert with one that CANNOT clobber newer state.
-- It writes the custody only if:
--
--   * the table has dealt no hand after the custody's hand number (no
--     hand_history, hand_atomic_commits or hand_state_snapshots row, and no
--     F06 permit other than never_started, above it);
--   * any existing park row carries a bank snapshot at a hand number <= the
--     custody's own, and was not written by an F06 mixed-custody completion;
--   * no F06 mixed manager-custody transfer that names this table is open (or
--     was completed from this very generation) - that transfer's CAS evidence
--     includes this row, and changing it would wedge its admission; and the
--     write takes the same retired-origin lock the transfer's prepare takes,
--     so the two can never interleave.
--
-- Otherwise it refuses and names why. A refusal writes nothing, so the engine
-- records no acknowledgement and the restart gate still refuses: this makes a
-- write SUCCEED, it never admits a bank that is not on disk.
--
-- ONE transaction. No existing function is redefined. Pre-image guards pin the
-- fence, the transfer bank proof and lock this function is designed around,
-- and the exact shape of engine_presence_parked; the post-image asserts the
-- definition, owner, security, volatility, search_path and an ACL of exactly
-- {postgres, service_role}.

BEGIN;

-- ── PRE-IMAGE ───────────────────────────────────────────────────────────────
DO $pre$
DECLARE
  r record;
  v_md5 text;
  v_cols text;
BEGIN
  IF to_regprocedure(
       'public.fn_park_stopped_time_bank_custody(uuid,uuid,uuid,bigint,text,jsonb,jsonb,text)'
     ) IS NOT NULL THEN
    RAISE EXCEPTION 'STOPPED_CUSTODY_PREIMAGE: public.fn_park_stopped_time_bank_custody already exists; this migration is never replayed';
  END IF;

  -- The functions this one is designed around: the request fence it is
  -- written to be called outside of, the transfer's bank proof whose CAS it
  -- must never break, and the lock it shares with the transfer's prepare.
  FOR r IN SELECT * FROM (VALUES
      ('smarter_private.fn_smarter_data_api_pre_request()', '88d1373951b8e9184c50f703701bd28f'),
      ('smarter_private.f06_mixed_bank_proof(uuid,jsonb)', '41dee9b610c1053fb7ade12ab998cfc1')
    ) v(sig, want)
  LOOP
    SELECT md5(pg_get_functiondef(to_regprocedure(r.sig))) INTO v_md5;
    IF v_md5 IS DISTINCT FROM r.want THEN
      RAISE EXCEPTION 'STOPPED_CUSTODY_PREIMAGE: % is not the reviewed definition (md5 %)',
        r.sig, COALESCE(v_md5, 'absent');
    END IF;
  END LOOP;
  IF to_regprocedure('smarter_private.f06_retired_origin_lock(uuid)') IS NULL
     OR position('f06:retired-origin:' IN pg_get_functiondef(
          to_regprocedure('smarter_private.f06_retired_origin_lock(uuid)'))) = 0
     OR position('smarter_private.f06_retired_origin_lock(p_tournament_id)' IN pg_get_functiondef(
          to_regprocedure('public.fn_f06_prepare_mixed_manager_custody(uuid,uuid,uuid,uuid,jsonb,jsonb)'))) = 0 THEN
    RAISE EXCEPTION 'STOPPED_CUSTODY_PREIMAGE: the transfer prepare no longer takes f06_retired_origin_lock';
  END IF;

  SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod) || ':' || attnotnull, ','
                    ORDER BY attnum)
    INTO v_cols
    FROM pg_attribute
   WHERE attrelid = 'public.engine_presence_parked'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_cols IS DISTINCT FROM
       'table_id:uuid:true,disconnect_states:jsonb:true,parked_at:timestamp with time zone:true,'
       'engine_instance:text:false,time_bank_snapshot:jsonb:false' THEN
    RAISE EXCEPTION 'STOPPED_CUSTODY_PREIMAGE: engine_presence_parked is not the reviewed shape (%)', v_cols;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.engine_presence_parked'::regclass
                    AND contype = 'p'
                    AND pg_get_constraintdef(oid) = 'PRIMARY KEY (table_id)') THEN
    RAISE EXCEPTION 'STOPPED_CUSTODY_PREIMAGE: engine_presence_parked is not keyed by table_id';
  END IF;

  -- Every hand-activity read is an index range scan on (table_id, hand_number).
  FOR r IN SELECT * FROM (VALUES
      ('public.hand_history', 'idx_hand_history_table_handnum'),
      ('public.hand_atomic_commits', 'hand_atomic_commits_pkey'),
      ('public.hand_state_snapshots', 'idx_hand_state_snapshots_table_hand'),
      ('smarter_private.f06_hand_permits', 'f06_hand_permits_table_id_hand_number_key')
    ) v(rel, idx)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                    WHERE i.indrelid = to_regclass(r.rel) AND c.relname = r.idx
                      AND pg_get_indexdef(i.indexrelid) ~ '\(table_id, hand_number') THEN
      RAISE EXCEPTION 'STOPPED_CUSTODY_PREIMAGE: % has no (table_id, hand_number) index %', r.rel, r.idx;
    END IF;
  END LOOP;
  IF to_regclass('smarter_private.f06_manager_custody_transfers') IS NULL
     OR to_regclass('smarter_private.f06_manager_custody_completions') IS NULL THEN
    RAISE EXCEPTION 'STOPPED_CUSTODY_PREIMAGE: the F06 manager-custody transfer tables are missing';
  END IF;
END
$pre$;

-- ── THE GUARDED CUSTODY WRITE ───────────────────────────────────────────────
CREATE FUNCTION public.fn_park_stopped_time_bank_custody(
  p_table_id uuid,
  p_tournament_id uuid,
  p_generation uuid,
  p_hand_number bigint,
  p_parked_at text,
  p_disconnect_states jsonb,
  p_players jsonb,
  p_engine_instance text
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'pg_temp'
AS $fn$
DECLARE
  v_parked_at timestamptz;
  v_existing public.engine_presence_parked;
  v_found boolean;
  v_hand jsonb;
  v_rows integer;
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
  BEGIN
    PERFORM smarter_private.f06_retired_origin_lock(p_tournament_id);
  EXCEPTION WHEN SQLSTATE '40001' THEN
    RETURN jsonb_build_object('ok', false, 'refused', 'custody_transfer_busy',
                              'table_id', p_table_id);
  END;

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
  IF EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits h
              WHERE h.table_id = p_table_id AND h.hand_number > p_hand_number
                AND h.state <> 'never_started') THEN
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
$fn$;

COMMENT ON FUNCTION public.fn_park_stopped_time_bank_custody(uuid,uuid,uuid,bigint,text,jsonb,jsonb,text) IS
  'Writes a terminal tournament engine''s frozen stopped time-bank custody to engine_presence_parked as the service actor, only when it cannot clobber newer state (no later hand, no newer park, no open F06 mixed transfer). Refusals are named and write nothing. 2026-09-26.';

REVOKE ALL ON FUNCTION public.fn_park_stopped_time_bank_custody(uuid,uuid,uuid,bigint,text,jsonb,jsonb,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_park_stopped_time_bank_custody(uuid,uuid,uuid,bigint,text,jsonb,jsonb,text)
  TO service_role;

-- ── POST-IMAGE ──────────────────────────────────────────────────────────────
DO $post$
DECLARE
  p pg_proc;
BEGIN
  SELECT * INTO p FROM pg_proc
   WHERE oid = to_regprocedure(
     'public.fn_park_stopped_time_bank_custody(uuid,uuid,uuid,bigint,text,jsonb,jsonb,text)');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'STOPPED_CUSTODY_POSTIMAGE: function missing';
  END IF;
  IF pg_get_userbyid(p.proowner) IS DISTINCT FROM 'postgres'
     OR p.prosecdef IS DISTINCT FROM true
     OR p.provolatile IS DISTINCT FROM 'v'
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
     OR p.prorettype IS DISTINCT FROM 'jsonb'::regtype THEN
    RAISE EXCEPTION 'STOPPED_CUSTODY_POSTIMAGE: owner/security/volatility/config is not the reviewed image (%, %, %, %)',
      pg_get_userbyid(p.proowner), p.prosecdef, p.provolatile, p.proconfig;
  END IF;
  IF (SELECT array_agg(a::text ORDER BY a::text) FROM unnest(p.proacl) a)
     IS DISTINCT FROM ARRAY['postgres=X/postgres', 'service_role=X/postgres'] THEN
    RAISE EXCEPTION 'STOPPED_CUSTODY_POSTIMAGE: ACL is not exactly {postgres, service_role}: %', p.proacl;
  END IF;
  IF position('FOR UPDATE' IN p.prosrc) = 0
     OR position('f06_retired_origin_lock' IN p.prosrc) = 0
     OR position('newer_park' IN p.prosrc) = 0
     OR position('hand_after_custody' IN p.prosrc) = 0
     OR position('mixed_transfer_recorded' IN p.prosrc) = 0
     OR position('app.smarter_data_actor' IN p.prosrc) = 0 THEN
    RAISE EXCEPTION 'STOPPED_CUSTODY_POSTIMAGE: a guard is missing from the body';
  END IF;
END
$post$;

COMMIT;
