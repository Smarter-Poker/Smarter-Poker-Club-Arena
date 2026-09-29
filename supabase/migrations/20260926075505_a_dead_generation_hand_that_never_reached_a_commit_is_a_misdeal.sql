-- 20260926075505_a_dead_generation_hand_that_never_reached_a_commit_is_a_misdeal
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-26 07:55:05 UTC.
--
-- ===========================================================================
--  A DEAD GENERATION'S HAND THAT NEVER REACHED A COMMIT IS A MISDEAL
-- ===========================================================================
--
-- What was wrong
-- --------------
-- public.fn_f06_abort_abandoned_generation voids the hand a dead lease
-- generation left reserved, so the adopting successor can take the table and
-- the event can go on. The engine's table admission re-asks it every ten
-- minutes (#5258/#5280). Ten legacy events have been refused on every ask
-- since 2026-09-18 and 2026-09-22 under two named rules, and their tables have
-- not dealt since:
--
--   F06_ABANDONED_CARDS_WITHOUT_SNAPSHOT (6 events, 14 horses)
--     b5a48510 $100 Freeroll 6:00 PM, 3203a371 100 Chip Spin NLH,
--     140ecf5f 20 Chip Deep Stack Spin PLO4, 887802a7 5 Chip Spin PLO4,
--     fc2898f1 50 Chip Spin PLO5, 23ef2d58 NLH Heads-Up 25.
--     Hole cards were dealt (2-3 table_hole_cards rows, one per live chair,
--     written 2026-09-22 13:53:28 and 15:12:00, 9-41 s after the table's last
--     committed hand) and the hand-start snapshot, the engine's first write
--     after the deal (fire-and-forget, ServerTableEngineDealing), never
--     landed: the process died inside that window.
--
--   F06_ABORT_COMMITTED_OR_DISPATCHED, dispatch row but no commit (4 events,
--   9 horses)
--     0147ba18 50 Chip Deep Stack Spin PLO5, 64609b68 100 Chip Deep Stack
--     Spin NLH, 9470a333 PLO4 Heads-Up 10, 991c7324 20 Chip Deep Stack Spin
--     PLO6 (all 2026-09-18).
--     fn_ca_commit_hand_settlement writes the dispatch row through
--     f06_hand_dispatch_guard and then RETURNS the refusal of its exact-
--     generation core (it does not raise), so the dispatch row commits while
--     the hand does not. Each of the four also carries the platform's own
--     verdict: a hand_submission_dispositions row 'disposed' with no
--     submission, which hand_submission_snapshot_guard writes when a hand is
--     closed without an accepted commit. 9470a333 and 991c7324 still hold that
--     completed snapshot; the other two no longer hold one.
--
-- Read from rows for every one of the ten tables, 2026-09-26 07:40-07:50 UTC:
--   * zero hand_atomic_commits, hand_history and hand_private_state at or
--     after the permit's hand number;
--   * zero rows for the hand in every other table keyed by (table_id,
--     hand_number): no discard, no BBJ contribution, no knockout, no financial
--     fact, no submission (dynamic scan of public and smarter_private);
--   * every hole card belongs to a live chair at the table;
--   * every live chair's stack equals, to the chip, that same player's end
--     stack in the table's last committed hand_history row, and the table
--     totals agree (3000/3000, 3000/3000, 2000/2000, 900/900, 3000/3000,
--     900/900, 2000/2000, 3000/3000, 90000/90000, 900/900). No blind, ante or
--     bet of the unfinished hand ever left a chair.
--
-- The ruling
-- ----------
-- Misdeal: the hand is void and every chair keeps what it had. That is the
-- standard rule for a hand the house could not complete (a malfunction voids
-- the hand; chips return to where the last completed hand left them), and
-- here the rows prove it returns nothing because nothing was ever taken. For
-- a dispatched hand it is also what the platform already recorded: disposed,
-- not accepted.
--
-- What changes
-- ------------
-- The door gains one named outcome, 'misdeal_voided', for exactly two shapes:
--   (a) hole cards dealt and no snapshot;
--   (b) a dispatch row with no commit, and a 'disposed' disposition with no
--       submission.
-- It is taken ONLY when every clause holds: no commit, history or private
-- state at or after the hand; no discard; no open (incomplete) staged
-- snapshot; every hole card at a live chair; the table's last committed hand
-- exists and every live chair holds exactly that player's end stack there;
-- every existing roster, bust, park, lease and custody check of the door as
-- before. Otherwise the refusal each shape always had is raised, unchanged.
-- The permit goes to 'aborted_unsettled' with this door's receipt, and its
-- f06_generation_abort_hands row (ruling, shape, evidence, last committed
-- hand, roster) fences the hand number: a00_f06_aborted_hand refuses any late
-- commit or history row for it. No permit is deleted, no hand number is
-- re-issued (UNIQUE (table_id, hand_number) and the fence), no chair,
-- registration or wallet is written, and the reply still says credit 0.
--
-- A retained submission (F06_ABANDONED_HAND_HAS_A_RETAINED_SUBMISSION,
-- 8ec7e81d) is NOT touched: that hand finished and the platform holds its
-- result, so it is not a misdeal. It stays refused.
--
-- DDL: f06_generation_abort_hands.snapshot_id may be NULL, and only for a
-- 'misdeal_voided' receipt (a CHECK keeps every other receipt as it was).
--
-- Five tests (CLAUDE.md 10.9), per shape, both PASS:
--   1. Read, not assumed: the rows above, per table.
--   2. Nobody paid twice: the door credits and debits nothing; its receipt is
--      idempotent (advisory lock on the receipt, replay returns the stored
--      outcome, one receipt per (event, generation)).
--   3. Nothing clawed back: every chair already holds its last committed end
--      stack and keeps it; nothing was ever credited for the void hand.
--   4. Proved rolled back: see PROBE below.
--   5. The paragraph: docs/changelog/2026-09-26-a-dead-generation-hand-that-never-reached-a-commit-is-a-misdeal.md
--      names every event and why each player keeps exactly the chips they hold.
--
-- Every one of these 23 players is a horse, and nothing here treats them
-- differently for it (CLAUDE.md 10.5): the same ruling applies to a human.
--
-- PROBE (rolled back, 2026-09-26 08:04 UTC, one execute_sql call: this exact
-- door body as a pg_temp function, then one DO block ending in RAISE; the one
-- difference is that the probe's receipt used the permit id where snapshot_id
-- is NULL, because relaxing NOT NULL is DDL and cannot be probed):
--   0147ba18 64609b68 9470a333 991c7324 (dispatched)  -> OK, misdeals_voided 1
--   b5a48510 3203a371 140ecf5f 887802a7 fc2898f1 23ef2d58 (cards) -> OK, 1 each
--   8ec7e81d -> REFUSED F06_ABANDONED_HAND_HAS_A_RETAINED_SUBMISSION (held)
--   afterwards: 10 permits aborted_unsettled, 10 fencing receipts, 1 reserved;
--   every level answer restored=false (the clock stays where play stopped);
--   no chair or registration of the ten tables written by the door.
-- Negative controls in the same transaction: a discard recorded for a
-- dispatched hand -> F06_ABORT_COMMITTED_OR_DISPATCHED; one chip moved between
-- the two chairs of b5a48510's table (supply unchanged) -> the proof fails
-- (F06_ABANDONED_CARDS_WITHOUT_SNAPSHOT), and holds again once undone.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_f06_abort_abandoned_generation(uuid,uuid,uuid,text,boolean)'::regprocedure
       AND md5(p.prosrc) = '53950f516ec6139b4ad30d7753ab47e9'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig::text = '{"search_path=pg_catalog, public, smarter_private"}'
       AND p.prosecdef
       AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'PREIMAGE: fn_f06_abort_abandoned_generation is not the definition of 20260926043558';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'smarter_private' AND table_name = 'f06_generation_abort_hands'
                    AND column_name = 'snapshot_id' AND is_nullable = 'NO') THEN
    RAISE EXCEPTION 'PREIMAGE: f06_generation_abort_hands.snapshot_id is not NOT NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'smarter_private.f06_generation_abort_hands'::regclass
                AND conname = 'f06_generation_abort_hands_snapshot_or_misdeal') THEN
    RAISE EXCEPTION 'PREIMAGE: the misdeal constraint already exists';
  END IF;
END
$pre$;

ALTER TABLE smarter_private.f06_generation_abort_hands
  ALTER COLUMN snapshot_id DROP NOT NULL;
ALTER TABLE smarter_private.f06_generation_abort_hands
  ADD CONSTRAINT f06_generation_abort_hands_snapshot_or_misdeal
  CHECK (snapshot_id IS NOT NULL OR expected->>'ruling' = 'misdeal_voided');

CREATE OR REPLACE FUNCTION public.fn_f06_abort_abandoned_generation(p_tournament_id uuid, p_generation uuid, p_receipt_id uuid, p_reason text, p_release_current_lease boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE
  t uuid := p_tournament_id;
  g uuid := p_generation;
  v_actor text := current_setting('app.smarter_data_actor', true);
  prior smarter_private.f06_generation_aborts;
  lease public.engine_tournament_leases;
  event public.tournaments;
  h smarter_private.f06_hand_permits;
  o smarter_private.f06_operations;
  snap public.hand_state_snapshots;
  reserved_ids uuid[];
  tab_ids uuid[];
  users uuid[];
  u uuid;
  roster jsonb;
  hands jsonb := '[]'::jsonb;
  no_start jsonb := '[]'::jsonb;
  item jsonb;
  n integer;
  v_break uuid;
  v_withdraw uuid[] := ARRAY[]::uuid[];
  v_foreign_parks uuid[] := ARRAY[]::uuid[];
  v_snap_ids uuid[] := ARRAY[]::uuid[];
  v_abort_ids uuid[] := ARRAY[]::uuid[];
  v_never_ids uuid[] := ARRAY[]::uuid[];
  v_lease_found boolean := false;
  v_current_g uuid;
  v_retire_receipt uuid;
  v_level jsonb := 'null'::jsonb;
  v_ev_at timestamptz;
  v_ev_sb numeric;
  v_ev_bb numeric;
  v_hh record;
  v_lvl integer;
  v_r jsonb;
  v_found integer;
  v_rows integer;
  actual jsonb;
  v_busts jsonb;
  v_dispatched boolean;
  v_cards integer;
  v_misdeal boolean;
  v_last record;
  v_misdeal_n integer := 0;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role'
     OR v_actor IS NULL OR v_actor NOT IN ('service', 'tournament-manager') THEN
    RAISE EXCEPTION 'F06_ABANDONED_SERVICE_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF t IS NULL OR g IS NULL OR p_receipt_id IS NULL
     OR length(btrim(COALESCE(p_reason, ''))) < 40 THEN
    RAISE EXCEPTION 'F06_ABANDONED_IDENTITY_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION 'PLATFORM_FROZEN: abandoned-generation abort refused' USING ERRCODE = '55000';
  END IF;

  -- Serializes duplicate receipts; an identical replay returns the stored outcome.
  PERFORM pg_advisory_xact_lock(hashtextextended('f06:abort:' || p_receipt_id::text, 0));
  SELECT * INTO prior FROM smarter_private.f06_generation_aborts WHERE receipt_id = p_receipt_id;
  IF FOUND THEN
    IF prior.tournament_id IS DISTINCT FROM t OR prior.generation IS DISTINCT FROM g THEN
      RAISE EXCEPTION 'F06_ABORT_CHANGED_REPLAY' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'outcome', prior.outcome,
      'receipt_id', p_receipt_id, 'tournament_id', t, 'generation', g, 'credit', 0);
  END IF;
  IF EXISTS (SELECT 1 FROM smarter_private.f06_generation_aborts
              WHERE tournament_id = t AND generation = g) THEN
    RAISE EXCEPTION 'F06_GENERATION_ALREADY_ABORTED' USING ERRCODE = '55000';
  END IF;

  -- The lease FOR UPDATE drains protocol-2 requests admitted FOR KEY SHARE by
  -- whichever generation owns the event now. Never wait on an earlier lane while
  -- holding it: direct SQL may own that lane (same order as the existing doors).
  SELECT * INTO lease FROM public.engine_tournament_leases
   WHERE tournament_id = t FOR UPDATE;
  v_lease_found := FOUND;
  IF v_lease_found THEN
    v_current_g := lease.lease_generation;
    IF lease.lease_generation = g
       AND lease.heartbeat_at >= clock_timestamp()
           - make_interval(secs => public.fn_engine_lease_stale_seconds()) THEN
      RAISE EXCEPTION 'F06_GENERATION_STILL_LIVE' USING ERRCODE = '55000';
    END IF;
  END IF;
  PERFORM smarter_private.f06_try_lane(t);

  IF EXISTS (SELECT 1 FROM smarter_private.f06_manager_custody_transfers c
              WHERE c.tournament_id = t
                AND NOT EXISTS (SELECT 1 FROM smarter_private.f06_manager_custody_completions d
                                 WHERE d.transfer_id = c.transfer_id)) THEN
    RAISE EXCEPTION 'F06_MIXED_CUSTODY_PENDING' USING ERRCODE = '55000';
  END IF;

  SELECT array_agg(permit_id ORDER BY permit_id) INTO reserved_ids
    FROM smarter_private.f06_hand_permits
   WHERE tournament_id = t AND generation = g AND state = 'reserved';
  IF reserved_ids IS NULL THEN
    RAISE EXCEPTION 'F06_ABANDONED_NOTHING_RESERVED' USING ERRCODE = '55000';
  END IF;
  FOREACH u IN ARRAY reserved_ids LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended('f06:hand:' || u::text, 0)) THEN
      RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE = '40001';
    END IF;
  END LOOP;

  SELECT array_agg(DISTINCT table_id ORDER BY table_id) INTO tab_ids
    FROM smarter_private.f06_hand_permits WHERE permit_id = ANY (reserved_ids);
  SELECT array_agg(DISTINCT user_id ORDER BY user_id) INTO users
    FROM public.table_seats WHERE table_id = ANY (tab_ids) AND left_at IS NULL;
  IF users IS NOT NULL THEN
    FOREACH u IN ARRAY users LOOP
      IF NOT pg_try_advisory_xact_lock(hashtextextended('table_cap:' || u::text, 0)) THEN
        RAISE EXCEPTION 'F06_ABORT_RETRY_PLAYER_LANE' USING ERRCODE = '40001';
      END IF;
    END LOOP;
  END IF;

  SELECT * INTO event FROM public.tournaments WHERE id = t FOR UPDATE;
  PERFORM 1 FROM public.tournament_players WHERE tournament_id = t ORDER BY user_id FOR UPDATE;
  PERFORM 1 FROM public.tables WHERE tournament_id = t ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.table_seats WHERE table_id = ANY (tab_ids) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM smarter_private.f06_hand_permits
   WHERE permit_id = ANY (reserved_ids) ORDER BY permit_id FOR UPDATE;
  PERFORM 1 FROM smarter_private.f06_operations
   WHERE tournament_id = t ORDER BY break_id FOR UPDATE;

  IF event.id IS NULL OR event.status IS DISTINCT FROM 'RUNNING' THEN
    RAISE EXCEPTION 'F06_ABANDONED_EVENT_NOT_RUNNING' USING ERRCODE = '55000';
  END IF;
  IF p_release_current_lease AND v_lease_found AND v_current_g IS DISTINCT FROM g
     AND EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits
                  WHERE tournament_id = t AND generation = v_current_g AND state = 'reserved') THEN
    RAISE EXCEPTION 'F06_CURRENT_OWNER_HAS_A_HAND_IN_THE_AIR' USING ERRCODE = '55000';
  END IF;

  FOR h IN SELECT * FROM smarter_private.f06_hand_permits
            WHERE permit_id = ANY (reserved_ids) ORDER BY permit_id LOOP
    IF h.evidence_id IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM public.tables tb
                       WHERE tb.id = h.table_id AND tb.tournament_id = t
                         AND NOT COALESCE(tb.is_deleted, false)
                         AND lower(COALESCE(tb.status, '')) IN ('waiting', 'running')
                         AND tb.f06_lifecycle = h.lifecycle)
       OR EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits q
                   WHERE q.table_id = h.table_id AND q.hand_number > h.hand_number) THEN
      RAISE EXCEPTION 'F06_ABANDONED_PERMIT_CHANGED' USING ERRCODE = '55000';
    END IF;
    IF EXISTS (SELECT 1 FROM public.hand_atomic_commits c
                WHERE c.table_id = h.table_id AND c.hand_number >= h.hand_number)
       OR EXISTS (SELECT 1 FROM public.hand_history hh
                   WHERE hh.table_id = h.table_id AND hh.hand_number >= h.hand_number)
       OR EXISTS (SELECT 1 FROM public.hand_private_state hp
                   WHERE hp.table_id = h.table_id AND hp.hand_number >= h.hand_number) THEN
      RAISE EXCEPTION 'F06_ABORT_COMMITTED_OR_DISPATCHED' USING ERRCODE = '55000';
    END IF;
    -- A DISPATCH ROW WITHOUT A COMMIT (2026-09-26). The commit door wrote it
    -- and then refused the hand (it returns a refusal, it does not raise, so
    -- the dispatch row commits). That is a misdeal only when the platform
    -- also recorded the hand as DISPOSED - completed without an accepted
    -- commit, with no submission retained - which is the platform's own
    -- record that the hand was not accepted. Anything else still refuses.
    v_dispatched := EXISTS (SELECT 1 FROM smarter_private.f06_hand_dispatch d WHERE d.permit_id = h.permit_id);
    IF v_dispatched
       AND NOT EXISTS (SELECT 1 FROM smarter_private.hand_submission_dispositions d
                        WHERE d.table_id = h.table_id AND d.hand_number = h.hand_number
                          AND d.disposition = 'disposed' AND d.submission_id IS NULL) THEN
      RAISE EXCEPTION 'F06_ABORT_COMMITTED_OR_DISPATCHED' USING ERRCODE = '55000';
    END IF;
    IF EXISTS (SELECT 1 FROM smarter_private.hand_submissions s
                WHERE s.table_id = h.table_id AND s.hand_number = h.hand_number)
       OR EXISTS (SELECT 1 FROM smarter_private.hand_submission_dispositions d
                   WHERE d.table_id = h.table_id AND d.hand_number = h.hand_number
                     AND d.disposition <> 'disposed') THEN
      RAISE EXCEPTION 'F06_ABANDONED_HAND_HAS_A_RETAINED_SUBMISSION' USING ERRCODE = '55000';
    END IF;

    -- Every live chair is exactly one playing registration holding the same
    -- chips, and every playing registration at this table has its live chair.
    SELECT jsonb_agg(jsonb_build_object(
             'seat_id', s.id, 'occupancy_id', s.occupancy_id, 'user_id', s.user_id,
             'seat_number', s.seat_number, 'stack', s.stack,
             'registration_id', tp.id, 'chips', tp.chips) ORDER BY s.user_id)
      INTO roster
      FROM public.table_seats s
      LEFT JOIN public.tournament_players tp
        ON tp.tournament_id = t AND tp.user_id = s.user_id AND tp.table_id = s.table_id
       AND tp.seat_number = s.seat_number AND tp.status = 'playing'
     WHERE s.table_id = h.table_id AND s.left_at IS NULL;
    IF roster IS NULL
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(roster) r
                   WHERE r->>'registration_id' IS NULL
                      OR r->>'stack' IS NULL
                      OR (r->>'stack')::numeric < 0
                      OR (r->>'stack')::numeric IS DISTINCT FROM (r->>'chips')::numeric)
       OR EXISTS (SELECT 1 FROM public.tournament_players tp
                   WHERE tp.tournament_id = t AND tp.table_id = h.table_id AND tp.status = 'playing'
                     AND NOT EXISTS (SELECT 1 FROM public.table_seats s
                                      WHERE s.table_id = h.table_id AND s.user_id = tp.user_id
                                        AND s.seat_number = tp.seat_number AND s.left_at IS NULL)
                     -- A BUST WHOSE ELIMINATION IS STILL PENDING holds nothing
                     -- (2026-09-26): the registration holds zero chips, and
                     -- no chair this player ever had in the event is live or
                     -- holds a chip. Nothing of it is anywhere to account for.
                     -- (Its own vacated chair is not required to still exist:
                     -- a later seat at that table reuses the row.) It was not
                     -- dealt into this hand either: a snapshot player without
                     -- a live chair still refuses below
                     -- (F06_ABORT_SAVED_STACKS_CHANGED), and a hand without a
                     -- snapshot had no hole cards. A registration holding ANY
                     -- chips, or any live or non-empty chair, still refuses.
                     AND NOT (tp.chips = 0
                              AND NOT EXISTS (SELECT 1 FROM public.table_seats b
                                                JOIN public.tables bt ON bt.id = b.table_id
                                               WHERE bt.tournament_id = t AND b.user_id = tp.user_id
                                                 AND (b.left_at IS NULL OR b.stack IS DISTINCT FROM 0)))) THEN
      RAISE EXCEPTION 'F06_ABANDONED_ROSTER_CHANGED' USING ERRCODE = '55000';
    END IF;
    -- Every bust admitted above is named on the receipt.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'registration_id', tp.id, 'user_id', tp.user_id,
             'seat_number', tp.seat_number, 'chips', tp.chips) ORDER BY tp.user_id), '[]'::jsonb)
      INTO v_busts
      FROM public.tournament_players tp
     WHERE tp.tournament_id = t AND tp.table_id = h.table_id AND tp.status = 'playing'
       AND NOT EXISTS (SELECT 1 FROM public.table_seats s
                        WHERE s.table_id = h.table_id AND s.user_id = tp.user_id
                          AND s.seat_number = tp.seat_number AND s.left_at IS NULL);

    SELECT count(*) INTO n FROM public.hand_state_snapshots s
     WHERE s.table_id = h.table_id AND s.hand_number = h.hand_number;
    IF n > 1 THEN
      RAISE EXCEPTION 'F06_ABORT_SNAPSHOT_AMBIGUOUS' USING ERRCODE = '55000';
    END IF;
    SELECT count(*) INTO v_cards FROM public.table_hole_cards c
     WHERE c.table_id = h.table_id AND c.hand_number = h.hand_number;
    -- THE MISDEAL RULING (2026-09-26): a hand the dead generation dealt or
    -- dispatched but that never reached a commit. Decided below from rows.
    v_misdeal := v_dispatched OR (n = 0 AND v_cards > 0);

    v_break := NULL;
    FOR o IN SELECT * FROM smarter_private.f06_operations
              WHERE source_table_id = h.table_id
                AND state NOT IN ('acknowledged', 'withdrawn_before_manifest')
              ORDER BY break_id LOOP
      -- A pre-manifest park that ANOTHER generation requested (a later owner
      -- asked to break this table while this hand was still reserved) is not
      -- this receipt's to withdraw and nothing of it ever moved: no manifest,
      -- no custody, no members, no attempts. It stays exactly as it is and the
      -- adopting successor takes custody of it as it does any foreign park.
      IF o.origin_generation IS DISTINCT FROM g
         AND o.tournament_id = t AND o.state = 'park_requested'
         AND o.manifest IS NULL AND o.close_receipt IS NULL AND o.cleanup_kind IS NULL
         AND o.abort_receipt_id IS NULL AND o.custody_generation IS NULL
         AND NOT EXISTS (SELECT 1 FROM smarter_private.f06_members m WHERE m.break_id = o.break_id)
         AND NOT EXISTS (SELECT 1 FROM smarter_private.f06_attempts a WHERE a.break_id = o.break_id) THEN
        v_foreign_parks := v_foreign_parks || o.break_id;
        CONTINUE;
      END IF;
      -- Only one pre-manifest park of this exact dead generation can take a
      -- truthful withdrawal, and only against a hand receipt that names it.
      IF v_break IS NOT NULL OR n = 0 OR v_misdeal
         OR o.tournament_id IS DISTINCT FROM t OR o.state IS DISTINCT FROM 'park_requested'
         OR o.origin_generation IS DISTINCT FROM g OR o.lifecycle IS DISTINCT FROM h.lifecycle
         OR (o.custody_generation IS NOT NULL AND o.custody_generation IS DISTINCT FROM g)
         OR o.manifest IS NOT NULL OR o.close_receipt IS NOT NULL OR o.cleanup_kind IS NOT NULL
         OR o.abort_receipt_id IS NOT NULL
         OR EXISTS (SELECT 1 FROM smarter_private.f06_members m WHERE m.break_id = o.break_id)
         OR EXISTS (SELECT 1 FROM smarter_private.f06_attempts a WHERE a.break_id = o.break_id) THEN
        RAISE EXCEPTION 'F06_ABANDONED_PARK_CHANGED' USING ERRCODE = '55000';
      END IF;
      v_break := o.break_id;
    END LOOP;

    IF v_misdeal THEN
      -- The hand is void and every chair keeps what it had. That is only true
      -- when it is PROVED from rows that the void takes nothing from anybody:
      --   * no commit, history or private state at or after this hand (above);
      --   * no action recorded for it: no discard, and no staged snapshot
      --     still open (a dispatched hand's snapshot, if any, is the completed
      --     one the platform disposed of);
      --   * every hole card was dealt to a live chair at this table;
      --   * the table's last committed hand exists, and EVERY live chair holds
      --     exactly that hand's end stack for the same player - so no blind,
      --     ante or bet of the void hand ever left a chair.
      -- Otherwise the refusal this shape always had is raised, unchanged.
      SELECT hh.id, hh.hand_number, hh.created_at, hh.players INTO v_last
        FROM public.hand_history hh
       WHERE hh.table_id = h.table_id AND hh.hand_number < h.hand_number
       ORDER BY hh.hand_number DESC LIMIT 1;
      IF (n = 1 AND NOT (v_dispatched AND EXISTS (SELECT 1 FROM public.hand_state_snapshots s
                                                    WHERE s.table_id = h.table_id AND s.hand_number = h.hand_number
                                                      AND s.is_complete IS TRUE)))
         OR EXISTS (SELECT 1 FROM public.hand_discards x
                     WHERE x.table_id = h.table_id AND x.hand_number = h.hand_number)
         OR EXISTS (SELECT 1 FROM public.table_hole_cards c
                     WHERE c.table_id = h.table_id AND c.hand_number = h.hand_number
                       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(roster) r
                                        WHERE r->>'user_id' = c.user_id::text))
         OR v_last.id IS NULL
         OR jsonb_typeof(v_last.players) IS DISTINCT FROM 'array'
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(roster) r
                     WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_last.players) x
                                        WHERE x->>'userId' = r->>'user_id'
                                          AND COALESCE(pg_input_is_valid(x->>'stack', 'numeric'), false)
                                          AND (x->>'stack')::numeric = (r->>'stack')::numeric)) THEN
        IF v_dispatched THEN
          RAISE EXCEPTION 'F06_ABORT_COMMITTED_OR_DISPATCHED' USING ERRCODE = '55000';
        END IF;
        RAISE EXCEPTION 'F06_ABANDONED_CARDS_WITHOUT_SNAPSHOT' USING ERRCODE = '55000';
      END IF;
      IF n = 1 THEN
        SELECT * INTO snap FROM public.hand_state_snapshots s
         WHERE s.table_id = h.table_id AND s.hand_number = h.hand_number;
      ELSE
        snap := NULL;
      END IF;
      hands := hands || jsonb_build_array(jsonb_build_object(
        'permit', to_jsonb(h), 'ruling', 'misdeal_voided',
        'shape', CASE WHEN v_dispatched THEN 'dispatched_without_commit' ELSE 'cards_without_snapshot' END,
        'snapshot_id', snap.id,
        'snapshot_hash', CASE WHEN snap.id IS NOT NULL THEN md5(to_jsonb(snap)::text) END,
        'hole_cards', v_cards,
        'dispatch_xid', (SELECT d.xid FROM smarter_private.f06_hand_dispatch d WHERE d.permit_id = h.permit_id),
        'last_committed_hand', jsonb_build_object('id', v_last.id, 'hand_number', v_last.hand_number,
                                                  'created_at', v_last.created_at),
        'roster', roster, 'busts_pending_elimination', v_busts, 'break_id', NULL));
      v_abort_ids := v_abort_ids || h.permit_id;
      v_misdeal_n := v_misdeal_n + 1;
    ELSIF n = 1 THEN
      SELECT * INTO snap FROM public.hand_state_snapshots s
       WHERE s.table_id = h.table_id AND s.hand_number = h.hand_number FOR UPDATE;
      IF snap.is_complete IS DISTINCT FROM false
         OR snap.stage IS DISTINCT FROM 'preflop'
         OR snap.state_json->>'stage' IS DISTINCT FROM 'preflop'
         OR jsonb_typeof(snap.state_json->'players') IS DISTINCT FROM 'array'
         OR jsonb_array_length(snap.state_json->'players') NOT BETWEEN 2 AND 10
         OR (SELECT count(DISTINCT x->>'user_id') FROM jsonb_array_elements(snap.state_json->'players') x)
              IS DISTINCT FROM jsonb_array_length(snap.state_json->'players')::bigint
         -- A live chair the snapshot does not name sat down after the snapshot
         -- was written (a late registration or a balancing move): it was never
         -- dealt in and holds only its own registration chips.
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(roster) r
                     WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(snap.state_json->'players') x
                                        WHERE x->>'user_id' = r->>'user_id')
                       AND NOT EXISTS (SELECT 1 FROM public.table_seats ls
                                        WHERE ls.id = (r->>'seat_id')::uuid
                                          AND ls.joined_at > snap.created_at))
         OR NOT COALESCE(pg_input_is_valid(snap.state_json->>'pot', 'numeric'), false)
         OR EXISTS (
              SELECT 1 FROM jsonb_array_elements(snap.state_json->'players') x
               WHERE NOT (CASE
                 WHEN COALESCE(pg_input_is_valid(x->>'user_id', 'uuid'), false)
                  AND COALESCE(pg_input_is_valid(x->>'seat', 'integer'), false)
                  AND COALESCE(pg_input_is_valid(x->>'stack', 'numeric'), false)
                  AND COALESCE(pg_input_is_valid(x->>'totalInvested', 'numeric'), false)
                  AND COALESCE(pg_input_is_valid(COALESCE(x->>'deadInvested', '0'), 'numeric'), false)
                  AND COALESCE(pg_input_is_valid(COALESCE(x->>'returnedUncalled', '0'), 'numeric'), false)
                 THEN
                   (x->>'stack')::numeric >= 0
                   AND (x->>'totalInvested')::numeric >= 0
                   AND COALESCE((x->>'deadInvested')::numeric, 0)
                         BETWEEN 0 AND (x->>'totalInvested')::numeric
                   AND (x->>'stack')::numeric::text NOT IN ('NaN', 'Infinity', '-Infinity')
                   AND (x->>'totalInvested')::numeric::text NOT IN ('NaN', 'Infinity', '-Infinity')
                   AND EXISTS (SELECT 1 FROM jsonb_array_elements(roster) r
                                WHERE r->>'user_id' = x->>'user_id'
                                  AND (r->>'seat_number')::integer = (x->>'seat')::integer
                                  AND ((r->>'stack')::numeric
                                         = (x->>'stack')::numeric + (x->>'totalInvested')::numeric
                                       -- The add-on this registration bought was
                                       -- credited to the chair and the registration
                                       -- after the snapshot: exactly the event's
                                       -- add-on chips, never any other amount.
                                       OR (COALESCE(event.addon_chips, 0) > 0
                                           AND EXISTS (SELECT 1 FROM public.tournament_players tp
                                                        WHERE tp.id = (r->>'registration_id')::uuid
                                                          AND tp.add_on IS TRUE)
                                           AND (r->>'stack')::numeric
                                               = (x->>'stack')::numeric + (x->>'totalInvested')::numeric
                                                 + event.addon_chips)))
                 ELSE false END))
         OR (snap.state_json->>'pot')::numeric IS DISTINCT FROM
              (SELECT sum((x->>'totalInvested')::numeric)
                 FROM jsonb_array_elements(snap.state_json->'players') x) THEN
        RAISE EXCEPTION 'F06_ABORT_SAVED_STACKS_CHANGED' USING ERRCODE = '55000';
      END IF;
      hands := hands || jsonb_build_array(jsonb_build_object(
        'permit', to_jsonb(h), 'snapshot_id', snap.id,
        'snapshot_hash', md5(to_jsonb(snap)::text), 'snapshot_created_at', snap.created_at,
        'roster', roster, 'busts_pending_elimination', v_busts, 'break_id', v_break,
        'blinds', jsonb_build_object('small_blind', snap.config_json->'smallBlind',
                                     'big_blind', snap.config_json->'bigBlind',
                                     'ante', snap.config_json->'ante')));
      v_abort_ids := v_abort_ids || h.permit_id;
      v_snap_ids := v_snap_ids || snap.id;
      IF v_break IS NOT NULL THEN v_withdraw := v_withdraw || v_break; END IF;
      IF COALESCE(pg_input_is_valid(snap.config_json->>'bigBlind', 'numeric'), false)
         AND COALESCE(pg_input_is_valid(snap.config_json->>'smallBlind', 'numeric'), false)
         AND (v_ev_at IS NULL OR snap.created_at > v_ev_at) THEN
        v_ev_at := snap.created_at;
        v_ev_sb := (snap.config_json->>'smallBlind')::numeric;
        v_ev_bb := (snap.config_json->>'bigBlind')::numeric;
      END IF;
    ELSE
      IF EXISTS (SELECT 1 FROM public.table_hole_cards c
                  WHERE c.table_id = h.table_id AND c.hand_number = h.hand_number) THEN
        RAISE EXCEPTION 'F06_ABANDONED_CARDS_WITHOUT_SNAPSHOT' USING ERRCODE = '55000';
      END IF;
      no_start := no_start || jsonb_build_array(jsonb_build_object(
        'permit', to_jsonb(h), 'roster', roster, 'busts_pending_elimination', v_busts));
      v_never_ids := v_never_ids || h.permit_id;
    END IF;
  END LOOP;

  -- THE CLOCK RETURNS TO WHERE PLAY STOPPED: the later of the voided evidence
  -- and the event's last dealt hand; only backwards; never on a break.
  SELECT hh.small_blind, hh.big_blind, hh.created_at INTO v_hh
    FROM public.hand_history hh WHERE hh.tournament_id = t
   ORDER BY hh.created_at DESC LIMIT 1;
  IF FOUND AND v_hh.big_blind IS NOT NULL AND (v_ev_at IS NULL OR v_hh.created_at > v_ev_at) THEN
    v_ev_at := v_hh.created_at;
    v_ev_sb := v_hh.small_blind;
    v_ev_bb := v_hh.big_blind;
  END IF;
  IF v_ev_bb IS NOT NULL AND NOT COALESCE(event.on_break, false)
     AND event.current_level IS NOT NULL AND event.current_level > 0 THEN
    v_found := NULL;
    FOR v_lvl IN 0 .. LEAST(event.current_level, 600) LOOP
      v_r := public.fn_resolve_tournament_blinds(event.blind_structure, v_lvl,
                                                 event.variant, event.tournament_type, NULL);
      IF (v_r->>'small_blind')::numeric = v_ev_sb AND (v_r->>'big_blind')::numeric = v_ev_bb THEN
        v_found := v_lvl;
        EXIT;
      END IF;
    END LOOP;
    IF v_found IS NOT NULL AND v_found < event.current_level THEN
      v_r := public.fn_resolve_tournament_blinds(event.blind_structure, v_found,
                                                 event.variant, event.tournament_type, NULL);
      v_level := jsonb_build_object(
        'from_level', event.current_level, 'from_state', event.blind_level_state,
        'from_started_at', event.level_started_at, 'to_level', v_found,
        'evidence_at', v_ev_at, 'small_blind', v_r->'small_blind',
        'big_blind', v_r->'big_blind', 'ante', v_r->'ante');
    ELSE
      v_level := jsonb_build_object('restored', false, 'current_level', event.current_level,
        'evidence_small_blind', v_ev_sb, 'evidence_big_blind', v_ev_bb, 'matched_level', v_found);
    END IF;
  END IF;

  actual := jsonb_build_object(
    'kind', 'abandoned_generation', 'tournament_id', t, 'generation', g,
    'current_generation', v_current_g,
    'current_instance_id', CASE WHEN v_lease_found THEN lease.instance_id END,
    'current_engine_version', CASE WHEN v_lease_found THEN lease.engine_version END,
    'current_heartbeat_at', CASE WHEN v_lease_found THEN lease.heartbeat_at END,
    'format_contract', event.format_contract, 'hands', hands, 'never_started', no_start,
    'level', v_level, 'foreign_parks_left', to_jsonb(v_foreign_parks),
    'release_current_lease', p_release_current_lease, 'reason', p_reason);
  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION 'PLATFORM_FROZEN: abandoned-generation abort refused' USING ERRCODE = '55000';
  END IF;

  INSERT INTO smarter_private.f06_generation_aborts (receipt_id, tournament_id, generation, expected)
  VALUES (p_receipt_id, t, g, actual);
  FOR item IN SELECT value FROM jsonb_array_elements(hands) LOOP
    INSERT INTO smarter_private.f06_generation_abort_hands
      (permit_id, receipt_id, tournament_id, generation, table_id, hand_number,
       snapshot_id, break_id, expected)
    VALUES ((item->'permit'->>'permit_id')::uuid, p_receipt_id, t, g,
            (item->'permit'->>'table_id')::uuid, (item->'permit'->>'hand_number')::bigint,
            NULLIF(item->>'snapshot_id', '')::uuid, NULLIF(item->>'break_id', '')::uuid, item);
  END LOOP;
  IF cardinality(v_abort_ids) > 0 THEN
    UPDATE smarter_private.f06_hand_permits
       SET state = 'aborted_unsettled', evidence_id = p_receipt_id
     WHERE permit_id = ANY (v_abort_ids);
  END IF;
  IF cardinality(v_never_ids) > 0 THEN
    UPDATE smarter_private.f06_hand_permits
       SET state = 'never_started', evidence_id = p_receipt_id
     WHERE permit_id = ANY (v_never_ids);
  END IF;
  IF cardinality(v_snap_ids) > 0 THEN
    UPDATE public.hand_state_snapshots SET is_complete = true WHERE id = ANY (v_snap_ids);
  END IF;
  IF cardinality(v_withdraw) > 0 THEN
    UPDATE smarter_private.f06_operations
       SET state = 'withdrawn_before_manifest', abort_receipt_id = p_receipt_id
     WHERE break_id = ANY (v_withdraw);
  END IF;

  IF v_level ? 'to_level' THEN
    UPDATE public.tournaments
       SET current_level = (v_level->>'to_level')::integer,
           level_started_at = clock_timestamp(),
           blind_level_state = jsonb_build_object(
             'index', (v_level->>'to_level')::integer,
             'small_blind', v_level->'small_blind',
             'big_blind', v_level->'big_blind',
             'ante', v_level->'ante')
     WHERE id = t;
    UPDATE public.tables
       SET small_blind = (v_level->>'small_blind')::numeric,
           big_blind = (v_level->>'big_blind')::numeric,
           ante = (v_level->>'ante')::numeric,
           stakes = trim_scale((v_level->>'small_blind')::numeric)::text || '/'
                    || trim_scale((v_level->>'big_blind')::numeric)::text
     WHERE tournament_id = t AND NOT COALESCE(is_deleted, false)
       AND lower(COALESCE(status::text, '')) NOT IN
           ('closed', 'deleted', 'completed', 'cancelled', 'finished');
  END IF;

  IF p_release_current_lease AND v_lease_found THEN
    IF v_current_g IS DISTINCT FROM g THEN
      v_retire_receipt := md5('f06:abandoned:retire:' || p_receipt_id::text)::uuid;
      INSERT INTO smarter_private.f06_generation_aborts (receipt_id, tournament_id, generation, expected)
      VALUES (v_retire_receipt, t, v_current_g, jsonb_build_object(
        'kind', 'retired_current_generation', 'retired_by', p_receipt_id,
        'tournament_id', t, 'generation', v_current_g, 'instance_id', lease.instance_id,
        'engine_version', lease.engine_version, 'hands', '[]'::jsonb, 'reason', p_reason));
    END IF;
    PERFORM public.release_tournament_leases_v2(lease.instance_id, jsonb_build_array(
      jsonb_build_object('tournament_id', t, 'lease_generation', v_current_g)));
    IF EXISTS (SELECT 1 FROM public.engine_tournament_leases
                WHERE tournament_id = t AND lease_generation = v_current_g) THEN
      RAISE EXCEPTION 'F06_ABORT_LEASE_NOT_WITHDRAWN' USING ERRCODE = '55000';
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'outcome', 'aborted_unsettled',
    'receipt_id', p_receipt_id, 'tournament_id', t, 'generation', g,
    'hands_aborted', cardinality(v_abort_ids), 'never_started', cardinality(v_never_ids),
    'misdeals_voided', v_misdeal_n,
    'parks_withdrawn', cardinality(v_withdraw), 'foreign_parks_left', cardinality(v_foreign_parks),
    'level', v_level,
    'released_generation', CASE WHEN p_release_current_lease AND v_lease_found THEN v_current_g END,
    'credit', 0);
END
$function$;

REVOKE ALL ON FUNCTION public.fn_f06_abort_abandoned_generation(uuid, uuid, uuid, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_abort_abandoned_generation(uuid, uuid, uuid, text, boolean)
  TO service_role;

DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_f06_abort_abandoned_generation(uuid,uuid,uuid,text,boolean)'::regprocedure
       AND md5(p.prosrc) = 'f7424f0f1d7df2ad0cf44e99541d7235'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig::text = '{"search_path=pg_catalog, public, smarter_private"}'
       AND p.prosecdef
       AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'POSTIMAGE: fn_f06_abort_abandoned_generation is not the misdeal definition with its owner, grants and settings';
  END IF;
  IF has_function_privilege('anon', 'public.fn_f06_abort_abandoned_generation(uuid,uuid,uuid,text,boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_f06_abort_abandoned_generation(uuid,uuid,uuid,text,boolean)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.fn_f06_abort_abandoned_generation(uuid,uuid,uuid,text,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTIMAGE: fn_f06_abort_abandoned_generation grants are not service_role only';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'smarter_private' AND table_name = 'f06_generation_abort_hands'
                    AND column_name = 'snapshot_id' AND is_nullable = 'YES')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid = 'smarter_private.f06_generation_abort_hands'::regclass
                       AND conname = 'f06_generation_abort_hands_snapshot_or_misdeal' AND convalidated) THEN
    RAISE EXCEPTION 'POSTIMAGE: the misdeal receipt shape is not installed';
  END IF;
END
$post$;

COMMIT;
