-- 20260926131050_the_abandoned_generation_door_reads_the_last_hand_by_when_it.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ===========================================================================
--  THE ABANDONED-GENERATION DOOR READS THE LAST HAND BY WHEN IT WAS PLAYED
-- ===========================================================================
--
-- This replaces 20260926091455 (PR #5321), which merged but can never apply:
-- its pre-image pins fn_ca_resume_hand_submission at 1aa58a5d, and
-- 20260926091630 (PR #5320, applied 2026-09-26) had already moved that body
-- to 828edb10. Both PRs fixed the same refusal for event 8ec7e81d (a chair
-- taken after a retained hand's deal); #5320's clause is live and is kept.
-- The file of 20260926091455 is deleted in the same pull request.
--
-- What #5321 carried that is NOT live, and is the whole of this migration:
--
--   public.fn_f06_abort_abandoned_generation read the event's last dealt hand
--   ORDER BY created_at. A finished hand its successor commits late from a
--   retained submission (fn_ca_resume_hand_submission) is WRITTEN now but was
--   PLAYED when it ended, with the blinds of that time. The door, asked again
--   right after the handoff, takes that hand as the event's last dealt level
--   and turns the clock back on every table that has dealt since. For
--   8ec7e81d (hand 12976717, played 2026-09-18 23:07-23:08 at level 0 blinds,
--   event at level 3 on 2026-09-26 13:08 UTC) that is a reset to level 0.
--   The hand is now ordered by when it was played:
--   COALESCE(ended_at, created_at), then created_at.
--
-- The installed body is byte for byte the one #5321 reviewed (md5 adeba11b,
-- pinned by its law test); nothing else in the door changes. Read 2026-09-26
-- 13:10 UTC: the live door is f7424f0f (20260926075505) and the live handoff
-- is 828edb10 (20260926091630). Cost of the new ORDER BY: an index scan of
-- idx_hand_history_tournament_created for the one event plus a top-N sort,
-- measured 180 ms on the largest retained event (5a387a75).
--
-- No money moves. The door still credits 0 and every other clause is as it
-- was. Law: tests/a-bystander-seated-after-a-finished-hand-does-not-hold-its-settlement.law.test.ts
--
-- @live-proof: (SELECT pg_get_functiondef('public.fn_f06_abort_abandoned_generation(uuid,uuid,uuid,text,boolean)'::regprocedure) LIKE '%ORDER BY COALESCE(hh.ended_at, hh.created_at) DESC, hh.created_at DESC LIMIT 1;%')

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
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
    RAISE EXCEPTION 'PREIMAGE: fn_f06_abort_abandoned_generation is not the definition of 20260926075505';
  END IF;
  -- The handoff this door follows is #5320's (20260926091630), not #5321's.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure
       AND md5(p.prosrc) = '828edb105fa8d69f089430d7945f5fb9') THEN
    RAISE EXCEPTION 'PREIMAGE: fn_ca_resume_hand_submission is not the definition of 20260926091630';
  END IF;
END
$pre$;

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
  -- PLAY TIME, NOT WRITE TIME (2026-09-26): a finished hand its successor
  -- commits late from a retained submission is written now but was played
  -- when it ended. Ordered by write time, its old blinds would read as the
  -- event's last dealt level and turn the clock back on every table that has
  -- dealt since.
  SELECT hh.small_blind, hh.big_blind, COALESCE(hh.ended_at, hh.created_at) AS created_at INTO v_hh
    FROM public.hand_history hh WHERE hh.tournament_id = t
   ORDER BY COALESCE(hh.ended_at, hh.created_at) DESC, hh.created_at DESC LIMIT 1;
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
       AND md5(p.prosrc) = 'adeba11b33ec9c234c77d8d26c9e2324'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig::text = '{"search_path=pg_catalog, public, smarter_private"}'
       AND p.prosecdef
       AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'POSTIMAGE: fn_f06_abort_abandoned_generation is not the play-time definition with its owner, grants and settings';
  END IF;
  IF has_function_privilege('anon', 'public.fn_f06_abort_abandoned_generation(uuid,uuid,uuid,text,boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_f06_abort_abandoned_generation(uuid,uuid,uuid,text,boolean)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.fn_f06_abort_abandoned_generation(uuid,uuid,uuid,text,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTIMAGE: grants are not service_role only';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc
       WHERE oid = 'public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure) <> '828edb105fa8d69f089430d7945f5fb9' THEN
    RAISE EXCEPTION 'POSTIMAGE: the handoff changed';
  END IF;
END
$post$;

COMMIT;
