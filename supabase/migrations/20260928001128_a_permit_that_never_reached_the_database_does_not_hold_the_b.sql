-- 20260928001128_a_permit_that_never_reached_the_database_does_not_hold_the_b.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- A PERMIT THAT NEVER REACHED THE DATABASE DOES NOT HOLD THE BANK (2026-09-27).
--
-- An engine reserves its next hand with public.fn_f06_begin_hand, which writes
-- the smarter_private.f06_hand_permits row under the tournament's settlement
-- lane (f06_prefix). When that call's reply is lost - a supabase timeout, a
-- dropped connection - the engine cannot tell whether the row was written:
-- its permit goes to phase 'unknown' (F06HandPermit.reserveOriginal ->
-- f06_permit_unproven), every later deal attempt throws
-- f06_prior_hand_unresolved, and hasUnresolvedF06Preparation() holds the
-- table. The zombie reaper stops the engine, and the replacement is refused
-- (adoptStoppedTimeBankCustody refuses while the original's preparation is
-- unresolved). The only way out is the stopped-custody park, which takes the
-- engine's attestation of that permit and closes it (20260927153827).
--
-- But the park looked the attested permit up by id and, finding no row,
-- refused `unstarted_permit_not_this_engines`. A permit whose begin never
-- committed has no row, so the engine that holds it can never resolve it: the
-- table can neither deal nor be replaced, its bank is never written, and it
-- holds the restart certificate shut for every release.
--
-- Measured on production, tournament 72e595f4 ("$100 Freeroll - 6:00 PM"),
-- engine cfe8a739, lease generation 0ac081f3: tables 7e681bb6, a7f144bb,
-- a4583f4a and df913df7 committed their last hands at 23:19:33-37Z (add-on
-- window, supabase_timeout errors around 23:20Z), cycled f06_allocation_unproven
-- / f06_permit_unproven / f06_prior_hand_unresolved, were zombie-killed at
-- 23:22:37Z and never replaced. No permit row exists above any of their last
-- accepted hands (the begin never committed). At 23:53:02Z the park refused all
-- four `unstarted_permit_not_this_engines`; /health carried
-- f06_preparation_stuck 4 and stopped_bank_custody_unwritten 4, readyForRestart
-- false, and the 23:55Z break did not cut over (the lease at 00:05Z is still
-- instance 1-730b8fe1). The engine certificate for cfe8a739 (run 36359297209)
-- failed on stalledTableCount 4.
--
-- The change, in one transaction:
--   * smarter_private.f06_absent_permit_releases records, once, a permit its
--     engine attested and the database never saw (append-only, RLS on, no
--     grants).
--   * fn_park_stopped_time_bank_custody: when the attested permit_id has no
--     row, it first takes the tournament's canonical lane
--     (fn_ca_lock_settlement_lane_for_tournament, the lane fn_f06_begin_hand
--     holds through f06_prefix until it commits), BEFORE the retired-origin
--     try-lock, so a begin still in flight has committed or aborted before the
--     row is read again under FOR UPDATE. If the row appeared, the existing
--     reserved-permit path runs unchanged. If it is still absent, and the call
--     carries its generation, it refuses `hand_after_custody`
--     (`absent_permit_start_witness`) over ANY durable witness of a hand at
--     the attested number - a permit row of any id, f06_hand_dispatch for the
--     permit, hand_atomic_commits, hand_history, hand_state_snapshots,
--     hand_private_state, table_hole_cards - and otherwise records the absence
--     and answers `unstarted_permit_released` with the attested id. A replay
--     with the same (table, tournament, generation, hand) returns the same
--     release; any other shape still refuses `unstarted_permit_not_this_engines`.
--     Every other check, the lock wait, the ACL and the security posture are
--     unchanged, and the bank is still written only when they all pass.
--   * fn_f06_begin_hand refuses `permit_released_absent` for a permit id so
--     recorded, so a begin that arrives after the release can never start the
--     hand the engine attested it never started. The check runs after
--     f06_prefix, under the same lane the release was recorded under.
--
-- No engine change is needed: persistStoppedCustodyForRestart already attests
-- a permit in phase 'unknown', and clears f06CurrentPermit when the reply names
-- it as released; the replacement then adopts the custody and deals.
--
-- Proved first against production in ROLLED-BACK transactions (pg_temp copies
-- of both bodies, table 7e681bb6 at custody 16124103, 2026-09-28 00:06Z and
-- 00:10Z): the old park refused `unstarted_permit_not_this_engines`; the new
-- one answered ok with `unstarted_permit_released` = the attested id; the replay
-- answered the same; the same permit at another hand number refused
-- `unstarted_permit_not_this_engines`; an attestation at 16124103 (which
-- carries a permit row and hand_history) refused `absent_permit_start_witness`
-- and recorded nothing; a late begin of the released permit answered
-- `permit_released_absent`; 0.08-0.11 s each.
--
-- @live-proof: select public.fn_park_stopped_time_bank_custody(...) for 7e681bb6 with the engine's attested permit -> ok, unstarted_permit_released (rolled back, 2026-09-28 00:06Z)
-- @live-proof: witness at an attested number carrying hand_history -> hand_after_custody / absent_permit_start_witness (rolled back, 2026-09-28 00:10Z)
--
-- Changelog: docs/changelog/a-permit-that-never-reached-the-database-does-not-hold-the-bank-2026-09-27.md
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
  b pg_proc;
BEGIN
  SELECT * INTO p FROM pg_proc
   WHERE oid = to_regprocedure(
     'public.fn_park_stopped_time_bank_custody(uuid,uuid,uuid,bigint,text,jsonb,jsonb,text,uuid,bigint)');
  SELECT * INTO b FROM pg_proc
   WHERE oid = to_regprocedure('public.fn_f06_begin_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)');
  IF p.oid IS NULL OR b.oid IS NULL THEN
    RAISE EXCEPTION 'ABSENT_PERMIT_PREIMAGE: the park or fn_f06_begin_hand is missing';
  END IF;
  IF md5(p.prosrc) IS DISTINCT FROM 'b87a56faba23595ed750496ea8a9c917' THEN
    RAISE EXCEPTION 'ABSENT_PERMIT_PREIMAGE: the park is not the reviewed image (20260927153827): %', md5(p.prosrc);
  END IF;
  IF md5(b.prosrc) IS DISTINCT FROM 'ee839b0fd6bac5601191118fee304980' THEN
    RAISE EXCEPTION 'ABSENT_PERMIT_PREIMAGE: fn_f06_begin_hand is not the reviewed image (20260918053310): %', md5(b.prosrc);
  END IF;
  IF pg_get_userbyid(p.proowner) IS DISTINCT FROM 'postgres' OR p.prosecdef IS DISTINCT FROM true
     OR p.provolatile IS DISTINCT FROM 'v' OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
     OR pg_get_userbyid(b.proowner) IS DISTINCT FROM 'postgres' OR b.prosecdef IS DISTINCT FROM true
     OR b.provolatile IS DISTINCT FROM 'v'
     OR b.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, smarter_private'] THEN
    RAISE EXCEPTION 'ABSENT_PERMIT_PREIMAGE: owner/security/volatility/config is not the reviewed image';
  END IF;
  IF (SELECT array_agg(a::text ORDER BY a::text) FROM unnest(p.proacl) a)
       IS DISTINCT FROM ARRAY['postgres=X/postgres', 'service_role=X/postgres']
     OR (SELECT array_agg(a::text ORDER BY a::text) FROM unnest(b.proacl) a)
       IS DISTINCT FROM ARRAY['postgres=X/postgres', 'service_role=X/postgres'] THEN
    RAISE EXCEPTION 'ABSENT_PERMIT_PREIMAGE: an ACL is not exactly {postgres, service_role}';
  END IF;
  IF to_regclass('smarter_private.f06_absent_permit_releases') IS NOT NULL THEN
    RAISE EXCEPTION 'ABSENT_PERMIT_PREIMAGE: smarter_private.f06_absent_permit_releases already exists';
  END IF;
  IF to_regprocedure('public.fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)') IS NULL
     OR to_regprocedure('smarter_private.f06_retired_origin_lock(uuid)') IS NULL
     OR to_regclass('smarter_private.f06_hand_dispatch') IS NULL
     OR to_regclass('public.hand_private_state') IS NULL
     OR to_regclass('public.table_hole_cards') IS NULL THEN
    RAISE EXCEPTION 'ABSENT_PERMIT_PREIMAGE: a relation or lock this change reads is missing';
  END IF;
END
$pre$;

-- ── THE RECORD OF A PERMIT THE DATABASE NEVER SAW ──────────────────────────
CREATE TABLE smarter_private.f06_absent_permit_releases (
  permit_id uuid PRIMARY KEY,
  tournament_id uuid NOT NULL,
  generation uuid NOT NULL,
  table_id uuid NOT NULL,
  hand_number bigint NOT NULL,
  custody_hand_number bigint NOT NULL,
  released_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (hand_number > custody_hand_number)
);
ALTER TABLE smarter_private.f06_absent_permit_releases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.f06_absent_permit_releases FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION smarter_private.f06_absent_permit_release_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $imm$
BEGIN RAISE EXCEPTION 'F06_ABSENT_PERMIT_RELEASE_IMMUTABLE' USING ERRCODE = '55000'; END $imm$;
REVOKE ALL ON FUNCTION smarter_private.f06_absent_permit_release_immutable() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER f06_absent_permit_release_immutable BEFORE UPDATE OR DELETE
  ON smarter_private.f06_absent_permit_releases FOR EACH ROW
  EXECUTE FUNCTION smarter_private.f06_absent_permit_release_immutable();
COMMENT ON TABLE smarter_private.f06_absent_permit_releases IS
  'One row per F06 hand permit a stopped engine attested it never started while no f06_hand_permits row carried it (its fn_f06_begin_hand reply was lost and the begin never committed). Written only by fn_park_stopped_time_bank_custody under the tournament lane; read by fn_f06_begin_hand, which refuses permit_released_absent. Append-only. 2026-09-27.';

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

-- ── THE BEGIN ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_f06_begin_hand(
  p_tournament_id uuid,
  p_lease_generation uuid,
  p_table_id uuid,
  p_lifecycle bigint,
  p_permit_id uuid,
  p_hand_number bigint,
  p_custody_id uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE h smarter_private.f06_hand_permits;
BEGIN
 PERFORM smarter_private.f06_prefix(p_tournament_id,p_lease_generation,'{}',ARRAY[p_table_id]);
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE permit_id=p_permit_id;
 IF FOUND THEN
 IF (h.tournament_id,h.table_id,h.lifecycle,h.hand_number,h.custody_id,h.generation) IS DISTINCT FROM(p_tournament_id,p_table_id,p_lifecycle,p_hand_number,p_custody_id,p_lease_generation) THEN
 RAISE EXCEPTION 'F06_CHANGED_HAND_PERMIT' USING ERRCODE='22023'; END IF;
 RETURN to_jsonb(h)||jsonb_build_object('ok',h.state='reserved','lifecycle',h.lifecycle::text,'hand_number',h.hand_number::text); END IF;
 -- A permit its engine attested absent (fn_park_stopped_time_bank_custody, 2026-09-27)
 -- can never be begun afterwards: the absence was recorded under this same lane.
 IF EXISTS(SELECT 1 FROM smarter_private.f06_absent_permit_releases WHERE permit_id=p_permit_id) THEN
 RETURN jsonb_build_object('ok',false,'reason','permit_released_absent'); END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id=p_table_id AND state NOT IN ('acknowledged','withdrawn_before_manifest')) THEN
 RETURN jsonb_build_object('ok',false,'reason','source_excluded'); END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tables tb JOIN public.tournaments t ON t.id=tb.tournament_id WHERE tb.id=p_table_id AND t.id=p_tournament_id AND upper(t.status)='RUNNING' AND tb.f06_lifecycle=p_lifecycle
 AND lower(tb.status)<>'closed' AND NOT COALESCE(tb.is_deleted,false)) THEN RAISE EXCEPTION 'F06_HAND_LIFECYCLE' USING ERRCODE='55000'; END IF;
 IF p_hand_number IS NULL OR p_hand_number<1 OR p_custody_id IS NULL THEN RAISE EXCEPTION 'F06_HAND_IDENTITY' USING ERRCODE='22023'; END IF;
 -- Hand numbers are permanently unique for the physical table, across every lifecycle.
 -- Exact permit replay above is lawful; a new permit cannot adopt historical evidence.
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=p_table_id AND hand_number=p_hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=p_table_id AND hand_number=p_hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=p_table_id AND hand_number=p_hand_number) THEN
 RETURN jsonb_build_object('ok',false,'reason','hand_number_already_used'); END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=p_table_id AND state='reserved') THEN
 RETURN jsonb_build_object('ok',false,'reason','hand_permit_unresolved'); END IF;
 INSERT INTO smarter_private.f06_hand_permits(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation)
 VALUES(p_permit_id,p_tournament_id,p_table_id,p_lifecycle,p_hand_number,p_custody_id,p_lease_generation) RETURNING * INTO h;
 RETURN to_jsonb(h)||jsonb_build_object('ok',true,'lifecycle',h.lifecycle::text,'hand_number',h.hand_number::text);
END $function$;

REVOKE ALL ON FUNCTION public.fn_f06_begin_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_begin_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)
  TO service_role;

-- ── POST-IMAGE ──────────────────────────────────────────────────────────────
DO $post$
DECLARE
  p pg_proc;
  b pg_proc;
BEGIN
  SELECT * INTO p FROM pg_proc
   WHERE oid = to_regprocedure(
     'public.fn_park_stopped_time_bank_custody(uuid,uuid,uuid,bigint,text,jsonb,jsonb,text,uuid,bigint)');
  SELECT * INTO b FROM pg_proc
   WHERE oid = to_regprocedure('public.fn_f06_begin_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)');
  IF md5(p.prosrc) IS DISTINCT FROM 'ed3f8597fbc516fb6368375bc303a6c2'
     OR md5(b.prosrc) IS DISTINCT FROM 'ade86201474e9f7621dbe0c90689d3a7' THEN
    RAISE EXCEPTION 'ABSENT_PERMIT_POSTIMAGE: a body is not the reviewed image (%, %)', md5(p.prosrc), md5(b.prosrc);
  END IF;
  IF (SELECT count(*) FROM pg_proc q JOIN pg_namespace n ON n.oid = q.pronamespace
       WHERE n.nspname = 'public' AND q.proname IN ('fn_park_stopped_time_bank_custody', 'fn_f06_begin_hand')) <> 2 THEN
    RAISE EXCEPTION 'ABSENT_PERMIT_POSTIMAGE: each function must have exactly one definition';
  END IF;
  IF pg_get_userbyid(p.proowner) IS DISTINCT FROM 'postgres' OR p.prosecdef IS DISTINCT FROM true
     OR p.provolatile IS DISTINCT FROM 'v' OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
     OR p.pronargdefaults IS DISTINCT FROM 2
     OR pg_get_userbyid(b.proowner) IS DISTINCT FROM 'postgres' OR b.prosecdef IS DISTINCT FROM true
     OR b.provolatile IS DISTINCT FROM 'v'
     OR b.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, smarter_private'] THEN
    RAISE EXCEPTION 'ABSENT_PERMIT_POSTIMAGE: owner/security/volatility/config/defaults is not the reviewed image';
  END IF;
  IF (SELECT array_agg(a::text ORDER BY a::text) FROM unnest(p.proacl) a)
       IS DISTINCT FROM ARRAY['postgres=X/postgres', 'service_role=X/postgres']
     OR (SELECT array_agg(a::text ORDER BY a::text) FROM unnest(b.proacl) a)
       IS DISTINCT FROM ARRAY['postgres=X/postgres', 'service_role=X/postgres'] THEN
    RAISE EXCEPTION 'ABSENT_PERMIT_POSTIMAGE: an ACL is not exactly {postgres, service_role}';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'smarter_private.f06_absent_permit_releases'::regclass)
     OR has_table_privilege('service_role', 'smarter_private.f06_absent_permit_releases', 'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('authenticated', 'smarter_private.f06_absent_permit_releases', 'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('anon', 'smarter_private.f06_absent_permit_releases', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'ABSENT_PERMIT_POSTIMAGE: the release record is readable or writable outside its functions';
  END IF;
END
$post$;

COMMIT;
