-- 20260928154327_a_superseded_mixed_custody_row_does_not_refuse_the_stopped_p.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- A SUPERSEDED MIXED CUSTODY ROW DOES NOT REFUSE THE STOPPED PARK (2026-09-28).
--
-- When an F06 mixed manager-custody transfer completes,
-- smarter_private.f06_mixed_adopt_presence writes one engine_presence_parked
-- row per destination table with engine_instance = 'f06_mixed_custody' and
-- time_bank_snapshot.handNumber = the table's last hand, for the successor's
-- engine to adopt. fn_park_stopped_time_bank_custody (20260926090846, carried
-- unchanged through 20260928001128) refused `mixed_custody_adopted` over ANY
-- such row, whatever its hand number. Nothing else ever rewrites it except a
-- live engine's own park at a maintenance break, so once a table dealt on from
-- that row and its manager then lost the lease before a break, every stop of
-- that manager was refused for ever, and "retained time-bank custody" held the
-- stop, the quarantine retry and the restart gate.
--
-- Measured on production, tournament 4e2de62d ("Friday Fight Night Opener",
-- 31 players): transfer 95634084 (origin 7a52706e, prepared 2026-09-26 09:34Z,
-- completed 2026-09-28 00:56:59Z) wrote the four rows at hands 14775285,
-- 14774766, 14772724 and 14775004 (tables 287108c9, bdee0569, ae9de3e7,
-- 77ded6f4). The event resumed at 13:47Z under generation 9e2be701 and dealt
-- to hands 16686550, 16686591, 16686578 and 16686521; the lease was lost at
-- 13:49:49Z and at 13:50:02Z all four stopped-custody parks were refused
-- `mixed_custody_adopted` ("failed to stop 4 table engine(s) ... retained
-- time-bank custody"). The stop fell through to a second mixed transfer
-- (2b5b36ff, 13:50:32Z) and the event has dealt nothing since. All seven
-- f06_mixed_custody rows on production today are superseded the same way.
--
-- A mixed row is read by exactly one thing, loadTimeBanksFromPark, and only
-- when the snapshot's handNumber equals the hand count the reading engine
-- boots at. Once hand_history carries a hand on the table above the row's
-- hand number, no engine can ever boot at that number again: the row is
-- dead, and the stopped custody is the only live record of those banks.
--
-- The change, in one transaction: fn_park_stopped_time_bank_custody still
-- refuses `mixed_custody_adopted`, but only when the mixed row is NOT proved
-- superseded - its hand number is unreadable, negative, or at or above the
-- custody being parked, or hand_history holds no hand on this table strictly
-- above the row and at or below the custody. A proved-superseded row falls
-- through to every existing check (newer_park, hand_after_custody, permits)
-- and is overwritten exactly as any other park row. The open-transfer refusal
-- (`mixed_transfer_recorded`), the lock, the attestation paths, the ACL and
-- the security posture are unchanged.
--
-- Proved first against production in a ROLLED-BACK transaction (pg_temp copy
-- of the new body, table 48bbf0ee of completed tournament bf09b28f, row at
-- 14777319, last hand 16140715, 2026-09-28 15:46Z): the production body
-- refused `mixed_custody_adopted` at 16140715; the new body refused it for a
-- custody at the row's own hand, refused it when the row was moved to
-- 16140715 and the custody placed at 16140718 with no hand between them,
-- parked ok at 16140715 over the real row (engine_instance and handNumber
-- rewritten), and answered ok again on replay; 0.07 s for all five calls.
-- New body md5 668e5dd56dfe9e8eab1c7021a064d031.
--
-- @live-proof: fn_park_stopped_time_bank_custody over a superseded f06_mixed_custody row -> ok (pg_temp copy, rolled back, 2026-09-28 15:46Z)
-- @live-proof: an unsuperseded f06_mixed_custody row -> mixed_custody_adopted (pg_temp copy, rolled back, 2026-09-28 15:46Z)
--
-- Changelog: docs/changelog/2026-09-28-a-superseded-mixed-custody-row-does-not-refuse-the-stopped-park.md
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ── PRE-IMAGE ───────────────────────────────────────────────────────────────
DO $pre$
DECLARE
  p pg_proc;
BEGIN
  SELECT * INTO p FROM pg_proc
   WHERE oid = to_regprocedure(
     'public.fn_park_stopped_time_bank_custody(uuid,uuid,uuid,bigint,text,jsonb,jsonb,text,uuid,bigint)');
  IF p.oid IS NULL THEN
    RAISE EXCEPTION 'SUPERSEDED_MIXED_PREIMAGE: the park is missing';
  END IF;
  IF md5(p.prosrc) IS DISTINCT FROM 'ed3f8597fbc516fb6368375bc303a6c2' THEN
    RAISE EXCEPTION 'SUPERSEDED_MIXED_PREIMAGE: the park is not the reviewed image (20260928001128): %', md5(p.prosrc);
  END IF;
  IF pg_get_userbyid(p.proowner) IS DISTINCT FROM 'postgres' OR p.prosecdef IS DISTINCT FROM true
     OR p.provolatile IS DISTINCT FROM 'v' OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
     OR p.pronargdefaults IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'SUPERSEDED_MIXED_PREIMAGE: owner/security/volatility/config/defaults is not the reviewed image';
  END IF;
  IF (SELECT array_agg(a::text ORDER BY a::text) FROM unnest(p.proacl) a)
       IS DISTINCT FROM ARRAY['postgres=X/postgres', 'service_role=X/postgres'] THEN
    RAISE EXCEPTION 'SUPERSEDED_MIXED_PREIMAGE: the ACL is not exactly {postgres, service_role}';
  END IF;
  IF (SELECT count(*) FROM pg_proc q JOIN pg_namespace n ON n.oid = q.pronamespace
       WHERE n.nspname = 'public' AND q.proname = 'fn_park_stopped_time_bank_custody') <> 1 THEN
    RAISE EXCEPTION 'SUPERSEDED_MIXED_PREIMAGE: the park must have exactly one definition';
  END IF;
  IF to_regclass('public.hand_history') IS NULL
     OR to_regclass('public.engine_presence_parked') IS NULL THEN
    RAISE EXCEPTION 'SUPERSEDED_MIXED_PREIMAGE: a relation this change reads is missing';
  END IF;
END
$pre$;

-- ── THE PARK ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_park_stopped_time_bank_custody(
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
  v_absent_lane boolean := false;
  v_absent smarter_private.f06_absent_permit_releases;
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

  /* A PERMIT THAT NEVER REACHED THE DATABASE HOLDS NOTHING (2026-09-27).
     The engine attests the permit it holds in phase 'unknown' after its
     fn_f06_begin_hand call was lost (a timeout or a dropped reply): it
     cannot tell whether the begin committed. When no row carries that
     permit_id, the begin either never ran or is still running. Take the
     tournament's canonical lane - the one fn_f06_begin_hand holds through
     f06_prefix until it commits - BEFORE the retired-origin lock, so any
     begin still in flight has committed or aborted before this reads, and
     record the absence below under that lane so a begin that arrives later
     is refused (fn_f06_begin_hand reads f06_absent_permit_releases). */
  IF p_unstarted_permit_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits h
                      WHERE h.permit_id = p_unstarted_permit_id) THEN
    PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
    v_absent_lane := true;
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
    /* A SUPERSEDED MIXED ROW IS NOT THE SUCCESSOR'S CUSTODY (2026-09-28).
       An F06 mixed completion writes this row for the successor to adopt at
       the table's last hand; while nothing has been dealt after it, it is
       the only record of the moved banks and is never overwritten. Once
       hand_history holds a hand on this table above the row's hand number,
       and no higher than the custody being parked, an engine booted at the
       row's hand and dealt on: loadTimeBanksFromPark reads a snapshot only
       at the exact hand an engine boots at, so no process can ever read
       this row again, and the stopped custody is the only live record of
       those players' banks. Anything else - an unreadable hand number, a
       row at or above the custody, no dealt hand between them - still
       refuses. */
    IF v_existing.engine_instance = 'f06_mixed_custody' THEN
      v_hand := v_existing.time_bank_snapshot -> 'handNumber';
      IF jsonb_typeof(v_hand) IS DISTINCT FROM 'number'
         OR (v_hand::text)::numeric <> trunc((v_hand::text)::numeric)
         OR (v_hand::text)::numeric < 0
         OR (v_hand::text)::numeric >= p_hand_number THEN
        RETURN jsonb_build_object('ok', false, 'refused', 'mixed_custody_adopted',
                                  'table_id', p_table_id);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.hand_history h
                      WHERE h.table_id = p_table_id
                        AND h.hand_number > (v_hand::text)::bigint
                        AND h.hand_number <= p_hand_number) THEN
        RETURN jsonb_build_object('ok', false, 'refused', 'mixed_custody_adopted',
                                  'table_id', p_table_id);
      END IF;
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
    IF NOT FOUND THEN
      /* No row: the begin never committed. Only the attestation of the
         engine that holds the permit names it, and only when this call took
         the lane above (a row read before the lane may not be trusted). A
         replay of the recorded absence returns the same release. Every
         durable start witness for the attested hand number still refuses,
         and so does a permit of any other id at that number. */
      IF NOT v_absent_lane OR p_generation IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'refused', 'unstarted_permit_not_this_engines',
                                  'table_id', p_table_id, 'permit_id', p_unstarted_permit_id);
      END IF;
      SELECT * INTO v_absent
        FROM smarter_private.f06_absent_permit_releases a
       WHERE a.permit_id = p_unstarted_permit_id;
      IF FOUND THEN
        IF (v_absent.table_id, v_absent.tournament_id, v_absent.generation, v_absent.hand_number)
           IS DISTINCT FROM (p_table_id, p_tournament_id, p_generation, p_unstarted_hand_number) THEN
          RETURN jsonb_build_object('ok', false, 'refused', 'unstarted_permit_not_this_engines',
                                    'table_id', p_table_id, 'permit_id', p_unstarted_permit_id);
        END IF;
      ELSE
        IF EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits h
                    WHERE h.table_id = p_table_id AND h.hand_number = p_unstarted_hand_number)
           OR EXISTS (SELECT 1 FROM smarter_private.f06_hand_dispatch d WHERE d.permit_id = p_unstarted_permit_id)
           OR EXISTS (SELECT 1 FROM public.hand_atomic_commits h
                       WHERE h.table_id = p_table_id AND h.hand_number = p_unstarted_hand_number)
           OR EXISTS (SELECT 1 FROM public.hand_history h
                       WHERE h.table_id = p_table_id AND h.hand_number = p_unstarted_hand_number)
           OR EXISTS (SELECT 1 FROM public.hand_state_snapshots h
                       WHERE h.table_id = p_table_id AND h.hand_number = p_unstarted_hand_number)
           OR EXISTS (SELECT 1 FROM public.hand_private_state h
                       WHERE h.table_id = p_table_id AND h.hand_number = p_unstarted_hand_number)
           OR EXISTS (SELECT 1 FROM public.table_hole_cards h
                       WHERE h.table_id = p_table_id AND h.hand_number = p_unstarted_hand_number) THEN
          RETURN jsonb_build_object('ok', false, 'refused', 'hand_after_custody',
                                    'evidence', 'absent_permit_start_witness',
                                    'table_id', p_table_id, 'permit_id', p_unstarted_permit_id);
        END IF;
        INSERT INTO smarter_private.f06_absent_permit_releases
          (permit_id, tournament_id, generation, table_id, hand_number, custody_hand_number)
        VALUES
          (p_unstarted_permit_id, p_tournament_id, p_generation, p_table_id,
           p_unstarted_hand_number, p_hand_number);
      END IF;
      v_released := p_unstarted_permit_id;
    ELSIF v_permit.table_id IS DISTINCT FROM p_table_id
       OR v_permit.tournament_id IS DISTINCT FROM p_tournament_id
       OR v_permit.generation IS DISTINCT FROM p_generation
       OR v_permit.hand_number IS DISTINCT FROM p_unstarted_hand_number THEN
      RETURN jsonb_build_object('ok', false, 'refused', 'unstarted_permit_not_this_engines',
                                'table_id', p_table_id, 'permit_id', p_unstarted_permit_id);
    END IF;
    IF v_released IS NOT NULL THEN
      NULL; -- released above: the attested permit never reached the database
    ELSIF v_permit.state = 'never_started' THEN
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
  IF md5(p.prosrc) IS DISTINCT FROM '668e5dd56dfe9e8eab1c7021a064d031' THEN
    RAISE EXCEPTION 'SUPERSEDED_MIXED_POSTIMAGE: the park is not the reviewed image: %', md5(p.prosrc);
  END IF;
  IF (SELECT count(*) FROM pg_proc q JOIN pg_namespace n ON n.oid = q.pronamespace
       WHERE n.nspname = 'public' AND q.proname = 'fn_park_stopped_time_bank_custody') <> 1 THEN
    RAISE EXCEPTION 'SUPERSEDED_MIXED_POSTIMAGE: the park must have exactly one definition';
  END IF;
  IF pg_get_userbyid(p.proowner) IS DISTINCT FROM 'postgres' OR p.prosecdef IS DISTINCT FROM true
     OR p.provolatile IS DISTINCT FROM 'v' OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
     OR p.pronargdefaults IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'SUPERSEDED_MIXED_POSTIMAGE: owner/security/volatility/config/defaults is not the reviewed image';
  END IF;
  IF (SELECT array_agg(a::text ORDER BY a::text) FROM unnest(p.proacl) a)
       IS DISTINCT FROM ARRAY['postgres=X/postgres', 'service_role=X/postgres'] THEN
    RAISE EXCEPTION 'SUPERSEDED_MIXED_POSTIMAGE: the ACL is not exactly {postgres, service_role}';
  END IF;
END
$post$;

COMMIT;
