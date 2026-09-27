-- 20260927145449_a_stranded_mixed_original_hand_is_voided_with_every_stack_un.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ===========================================================================
--  A STRANDED MIXED ORIGINAL HAND IS VOIDED, WITH EVERY STACK UNCHANGED
-- ===========================================================================
--
-- At 2026-09-26 09:33 UTC 604 tournament leases expired in one second (the
-- agent-probe collapse). For each event whose table had a hand in the air,
-- the engine wrote a mixed custody transfer (origin generation -> successor
-- generation) and died with it. Read 2026-09-27 15:00 UTC: 71 RUNNING events
-- (Spin, SNG heads-up and MTT, 20 to 9 players, incl. 23ef2d58 "NLH Heads-Up
-- 25") have held no lease since, 30 hours. Each has exactly one open transfer
-- whose successor was never admitted, and 1 to 4 reserved hands of the ORIGIN
-- generation. Every one of those hands has the same shape: one open preflop
-- hand_state_snapshots row, hole cards dealt to live chairs, and NO dispatch,
-- commit, history, private state, submission, disposition or discard.
--
-- Why it never ends: the engine re-reads the transfer and claims the
-- successor lease, and fn_f06_admit_mixed_manager_custody refuses
-- F06_MIXED_ORIGINAL_DISPOSITION_REQUIRED until every original hand has a
-- terminal disposition (f06_mixed_custody_snapshot: accepted with a commit,
-- never_started with a cancellation, or aborted_unsettled with a
-- f06_mixed_abort_hands receipt). Only the origin generation could give one,
-- and it is dead; the abandoned-generation door refuses a pending mixed
-- transfer (F06_MIXED_CUSTODY_PENDING), and fn_f06_abort_mixed_unsettled_generation
-- needs a live lease of the generation it disposes. The lease is released and
-- the claim retried, forever.
--
-- THE RULING (the misdeal ruling of 2026-09-26, 20260926075505): a hand the
-- dead generation dealt that never reached a commit is void, and every chair
-- keeps what it had before the deal. Here that is PROVED from rows before
-- anything is written: every live chair is one playing registration with the
-- same chips, and holds exactly its snapshot stack plus everything it put in
-- (blinds and antes never left a durable chair); the pot is the sum of what
-- was put in; every hole card went to a live chair of that table. So no
-- chair, registration, ledger row or wallet is written. credit = 0.
--
-- public.fn_f06_void_stranded_mixed_original(tournament) writes the one
-- receipt shape the successor's admission already reads as the original's
-- terminal disposition (f06_mixed_aborts, f06_mixed_abort_generations for the
-- ORIGIN only, f06_mixed_abort_hands with the reserved permit image), marks the
-- permits aborted_unsettled and closes their snapshots. The successor
-- generation is NOT disposed: the engine claims it and is admitted exactly as
-- designed, then completes the transfer and resumes dealing. Owner postgres,
-- EXECUTE for nobody else: only this reviewed migration calls it.
--
-- It refuses, by name, anything else: an event anybody holds a lease on
-- (retried), an admitted transfer, any reserved hand that is not one of the
-- transfer's originals, any open table break, a started or dispatched hand,
-- a changed chair or registration, a snapshot that is not the open preflop
-- one or whose stacks do not add back.
--
-- THE DRIVER takes each event in its own subtransaction with only try-locks
-- (the event's own lane, never queued). A busy lane or a claim in flight is
-- deferred; a named F06 refusal is reported; anything unexpected rolls the
-- whole migration back. It stops starting events after 4 s so the shared
-- settlement lane is never held long. Deferred events are named in the log.
--
-- Law: tests/a-stranded-mixed-original-hand-is-voided-with-every-stack-unchanged.law.test.ts
-- (run against rows exported from production for 23ef2d58 and the four-table
-- MTT 4e2de62d in a local PostgreSQL 17: both voided, replay returns the
-- stored outcome, a lease or a moved chip refuses).
--
-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fn_f06_void_stranded_mixed_original(uuid)'::regprocedure) = '49f45101006d8b94d192ac826ad7327f'
-- @live-proof: (SELECT count(*) FROM smarter_private.f06_mixed_aborts WHERE expected->>'kind' = 'stranded_mixed_original') >= 1

BEGIN;
SET LOCAL lock_timeout = '2s';

DO $pre$
BEGIN
  IF to_regprocedure('public.fn_f06_void_stranded_mixed_original(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'PREIMAGE: fn_f06_void_stranded_mixed_original already exists';
  END IF;
  -- The evidence reader, the admission, the permit guards and the lane this
  -- receipt is written for, as read 2026-09-27.
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'smarter_private.f06_mixed_custody_snapshot(uuid,uuid,jsonb)'::regprocedure) <> '5422e7f73fdbdd34bf73d46e514e844e'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fn_f06_admit_mixed_manager_custody(uuid,uuid,uuid,jsonb)'::regprocedure) <> 'aeaabb44975b8d138ed447687b0aea22'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'smarter_private.f06_generation_aborted(uuid,uuid)'::regprocedure) <> '76f64dfc5436d6208c6afbed3ad7da53'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'smarter_private.f06_immutable_identity()'::regprocedure) <> '31329a1df4bec9c92e0517b38fd42b93'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'smarter_private.f06_retained_submission_guard()'::regprocedure) <> '3ada0d8599460649be4fe90e7c338e84'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'smarter_private.f06_mixed_preparation_guard()'::regprocedure) <> '5d061187142fe383baf6392b6306519e'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'smarter_private.f06_try_lane(uuid)'::regprocedure) <> 'e2926a0246837b974c7237872ec42aa5' THEN
    RAISE EXCEPTION 'PREIMAGE: the mixed custody evidence, admission, guards or lane are not the definitions read 2026-09-27';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.fn_f06_void_stranded_mixed_original(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE
  t uuid := p_tournament_id;
  xfer smarter_private.f06_manager_custody_transfers;
  event public.tournaments;
  h smarter_private.f06_hand_permits;
  snap public.hand_state_snapshots;
  b jsonb;
  reserved_ids uuid[];
  original_ids uuid[];
  tab_ids uuid[];
  users uuid[];
  u uuid;
  n integer;
  roster jsonb;
  hands jsonb := '[]'::jsonb;
  item jsonb;
  actual jsonb;
  v_receipt uuid;
  v_snap_ids uuid[] := ARRAY[]::uuid[];
  v_before jsonb;
  v_after jsonb;
  v_busts jsonb;
BEGIN
  IF t IS NULL THEN
    RAISE EXCEPTION 'F06_STRANDED_IDENTITY_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION 'PLATFORM_FROZEN: stranded mixed void refused' USING ERRCODE = '55000';
  END IF;

  -- The event's own lane, taken only when it is free (never queued).
  PERFORM smarter_private.f06_try_lane(t);

  -- Exactly one custody transfer is still open, and its successor was never
  -- admitted: nobody but the dead origin ever held the hands it reserved.
  SELECT c.* INTO xfer FROM smarter_private.f06_manager_custody_transfers c
   WHERE c.tournament_id = t
     AND NOT EXISTS (SELECT 1 FROM smarter_private.f06_manager_custody_completions d
                      WHERE d.transfer_id = c.transfer_id);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'F06_STRANDED_TRANSFER_REQUIRED' USING ERRCODE = '55000';
  END IF;
  v_receipt := md5('f06:stranded-mixed-original:' || xfer.transfer_id::text)::uuid;
  IF EXISTS (SELECT 1 FROM smarter_private.f06_mixed_aborts WHERE receipt_id = v_receipt) THEN
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'receipt_id', v_receipt,
                              'tournament_id', t, 'credit', 0);
  END IF;
  IF EXISTS (SELECT 1 FROM smarter_private.f06_manager_custody_admissions a
              WHERE a.transfer_id = xfer.transfer_id) THEN
    RAISE EXCEPTION 'F06_STRANDED_TRANSFER_ADMITTED' USING ERRCODE = '55000';
  END IF;
  IF smarter_private.f06_generation_aborted(t, xfer.origin_generation)
     OR smarter_private.f06_generation_aborted(t, xfer.successor_generation) THEN
    RAISE EXCEPTION 'F06_STRANDED_GENERATION_DISPOSED' USING ERRCODE = '55000';
  END IF;
  -- Nobody holds the event. A claim in flight is retried, never raced.
  IF EXISTS (SELECT 1 FROM public.engine_tournament_leases WHERE tournament_id = t) THEN
    RAISE EXCEPTION 'F06_STRANDED_EVENT_OWNED' USING ERRCODE = '40001';
  END IF;

  -- The reserved set is exactly the transfer's original hands.
  SELECT array_agg(permit_id ORDER BY permit_id) INTO reserved_ids
    FROM smarter_private.f06_hand_permits WHERE tournament_id = t AND state = 'reserved';
  SELECT array_agg((e#>>'{permit,binding,permit_id}')::uuid ORDER BY (e#>>'{permit,binding,permit_id}')::uuid)
    INTO original_ids
    FROM jsonb_array_elements(xfer.local_proof->'engines') e
   WHERE e->'permit' IS DISTINCT FROM 'null'::jsonb;
  IF reserved_ids IS NULL OR reserved_ids IS DISTINCT FROM original_ids THEN
    RAISE EXCEPTION 'F06_STRANDED_ORIGINALS_CHANGED' USING ERRCODE = '55000';
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
  PERFORM 1 FROM smarter_private.f06_operations WHERE tournament_id = t ORDER BY break_id FOR UPDATE;

  IF event.id IS NULL OR event.status IS DISTINCT FROM 'RUNNING'
     OR event.format_contract IS NULL
     OR event.format_contract NOT IN ('mtt-v1', 'mtt-v2', 'spin-v1', 'sng-v1') THEN
    RAISE EXCEPTION 'F06_STRANDED_EVENT_NOT_RUNNING' USING ERRCODE = '55000';
  END IF;
  -- No table break of any origin is open: nothing but the hands is in the air.
  IF EXISTS (SELECT 1 FROM smarter_private.f06_operations
              WHERE tournament_id = t AND state NOT IN ('acknowledged', 'withdrawn_before_manifest')) THEN
    RAISE EXCEPTION 'F06_STRANDED_PARK_OPEN' USING ERRCODE = '55000';
  END IF;

  -- Every chip and registration of the affected tables, before.
  SELECT jsonb_build_object(
           'seats', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', s.id, 'user_id', s.user_id,
                              'stack', s.stack, 'left_at', s.left_at) ORDER BY s.id), '[]'::jsonb)
                       FROM public.table_seats s WHERE s.table_id = ANY (tab_ids)),
           'registrations', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', p.id, 'status', p.status,
                              'chips', p.chips, 'table_id', p.table_id, 'seat_number', p.seat_number) ORDER BY p.id), '[]'::jsonb)
                       FROM public.tournament_players p WHERE p.tournament_id = t))
    INTO v_before;

  FOR h IN SELECT * FROM smarter_private.f06_hand_permits
            WHERE permit_id = ANY (reserved_ids) ORDER BY permit_id LOOP
    SELECT e#>'{permit,binding}' INTO b FROM jsonb_array_elements(xfer.local_proof->'engines') e
     WHERE e#>>'{permit,binding,permit_id}' = h.permit_id::text;
    IF h.generation IS DISTINCT FROM xfer.origin_generation OR h.evidence_id IS NOT NULL
       OR b->>'tournament_id' IS DISTINCT FROM t::text
       OR b->>'table_id' IS DISTINCT FROM h.table_id::text
       OR b->>'hand_number' IS DISTINCT FROM h.hand_number::text
       OR b->>'lifecycle' IS DISTINCT FROM h.lifecycle::text
       OR b->>'custody_id' IS DISTINCT FROM h.custody_id::text
       OR b->>'lease_generation' IS DISTINCT FROM h.generation::text
       OR NOT EXISTS (SELECT 1 FROM public.tables tb
                       WHERE tb.id = h.table_id AND tb.tournament_id = t
                         AND NOT COALESCE(tb.is_deleted, false)
                         AND lower(COALESCE(tb.status, '')) IN ('waiting', 'running')
                         AND tb.f06_lifecycle = h.lifecycle)
       OR EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits q
                   WHERE q.table_id = h.table_id AND q.hand_number > h.hand_number) THEN
      RAISE EXCEPTION 'F06_STRANDED_PERMIT_CHANGED' USING ERRCODE = '55000';
    END IF;
    -- The hand never reached the platform: no commit, history, private state,
    -- dispatch, submission, disposition or recorded action.
    IF EXISTS (SELECT 1 FROM public.hand_atomic_commits c
                WHERE c.table_id = h.table_id AND c.hand_number >= h.hand_number)
       OR EXISTS (SELECT 1 FROM public.hand_history hh
                   WHERE hh.table_id = h.table_id AND hh.hand_number >= h.hand_number)
       OR EXISTS (SELECT 1 FROM public.hand_private_state hp
                   WHERE hp.table_id = h.table_id AND hp.hand_number >= h.hand_number)
       OR EXISTS (SELECT 1 FROM smarter_private.f06_hand_dispatch d WHERE d.permit_id = h.permit_id) THEN
      RAISE EXCEPTION 'F06_ABORT_COMMITTED_OR_DISPATCHED' USING ERRCODE = '55000';
    END IF;
    IF EXISTS (SELECT 1 FROM smarter_private.hand_submissions s
                WHERE s.table_id = h.table_id AND s.hand_number = h.hand_number)
       OR EXISTS (SELECT 1 FROM smarter_private.hand_submission_dispositions d
                   WHERE d.table_id = h.table_id AND d.hand_number = h.hand_number)
       OR EXISTS (SELECT 1 FROM public.hand_discards z
                   WHERE z.table_id = h.table_id AND z.hand_number = h.hand_number) THEN
      RAISE EXCEPTION 'F06_STRANDED_HAND_HAS_A_SUBMISSION' USING ERRCODE = '55000';
    END IF;

    -- Every live chair is one playing registration holding the same chips,
    -- and every playing registration at this table has its live chair.
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
                   WHERE r->>'registration_id' IS NULL OR r->>'stack' IS NULL
                      OR (r->>'stack')::numeric < 0
                      OR (r->>'stack')::numeric IS DISTINCT FROM (r->>'chips')::numeric)
       OR EXISTS (SELECT 1 FROM public.tournament_players tp
                   WHERE tp.tournament_id = t AND tp.table_id = h.table_id AND tp.status = 'playing'
                     AND NOT EXISTS (SELECT 1 FROM public.table_seats s
                                      WHERE s.table_id = h.table_id AND s.user_id = tp.user_id
                                        AND s.seat_number = tp.seat_number AND s.left_at IS NULL)
                     -- A bust whose elimination is still pending holds nothing
                     -- (the abandoned-generation door's ruling of 2026-09-26):
                     -- zero chips, and no chair it ever had in the event is
                     -- live or holds a chip. It was not dealt into this hand
                     -- either: the snapshot must name exactly the live chairs.
                     AND NOT (tp.chips = 0
                              AND NOT EXISTS (SELECT 1 FROM public.table_seats bs
                                                JOIN public.tables bt ON bt.id = bs.table_id
                                               WHERE bt.tournament_id = t AND bs.user_id = tp.user_id
                                                 AND (bs.left_at IS NULL OR bs.stack IS DISTINCT FROM 0)))) THEN
      RAISE EXCEPTION 'F06_STRANDED_ROSTER_CHANGED' USING ERRCODE = '55000';
    END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'registration_id', tp.id, 'user_id', tp.user_id,
             'seat_number', tp.seat_number, 'chips', tp.chips) ORDER BY tp.user_id), '[]'::jsonb)
      INTO v_busts
      FROM public.tournament_players tp
     WHERE tp.tournament_id = t AND tp.table_id = h.table_id AND tp.status = 'playing'
       AND NOT EXISTS (SELECT 1 FROM public.table_seats s
                        WHERE s.table_id = h.table_id AND s.user_id = tp.user_id
                          AND s.seat_number = tp.seat_number AND s.left_at IS NULL);

    -- One open preflop snapshot, and every chair still holds exactly what it
    -- held before the deal: its snapshot stack plus everything it put in. No
    -- blind, ante or bet of this hand ever left a durable chair.
    SELECT count(*) INTO n FROM public.hand_state_snapshots s
     WHERE s.table_id = h.table_id AND s.hand_number = h.hand_number;
    IF n <> 1 THEN
      RAISE EXCEPTION 'F06_STRANDED_SNAPSHOT_REQUIRED' USING ERRCODE = '55000';
    END IF;
    SELECT * INTO snap FROM public.hand_state_snapshots s
     WHERE s.table_id = h.table_id AND s.hand_number = h.hand_number FOR UPDATE;
    IF snap.is_complete IS DISTINCT FROM false
       OR snap.stage IS DISTINCT FROM 'preflop'
       OR snap.state_json->>'stage' IS DISTINCT FROM 'preflop'
       OR jsonb_typeof(snap.state_json->'players') IS DISTINCT FROM 'array'
       OR jsonb_array_length(snap.state_json->'players') NOT BETWEEN 2 AND 10
       OR jsonb_array_length(snap.state_json->'players') <> jsonb_array_length(roster)
       OR (SELECT count(DISTINCT x->>'user_id') FROM jsonb_array_elements(snap.state_json->'players') x)
            IS DISTINCT FROM jsonb_array_length(snap.state_json->'players')::bigint
       OR NOT COALESCE(pg_input_is_valid(snap.state_json->>'pot', 'numeric'), false)
       OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(snap.state_json->'players') x
             WHERE NOT (CASE
               WHEN COALESCE(pg_input_is_valid(x->>'user_id', 'uuid'), false)
                AND COALESCE(pg_input_is_valid(x->>'seat', 'integer'), false)
                AND COALESCE(pg_input_is_valid(x->>'stack', 'numeric'), false)
                AND COALESCE(pg_input_is_valid(x->>'totalInvested', 'numeric'), false)
                AND COALESCE(pg_input_is_valid(COALESCE(x->>'deadInvested', '0'), 'numeric'), false)
               THEN
                 (x->>'stack')::numeric >= 0
                 AND (x->>'totalInvested')::numeric >= 0
                 AND COALESCE((x->>'deadInvested')::numeric, 0) BETWEEN 0 AND (x->>'totalInvested')::numeric
                 AND (x->>'stack')::numeric::text NOT IN ('NaN', 'Infinity', '-Infinity')
                 AND (x->>'totalInvested')::numeric::text NOT IN ('NaN', 'Infinity', '-Infinity')
                 AND EXISTS (SELECT 1 FROM jsonb_array_elements(roster) r
                              WHERE r->>'user_id' = x->>'user_id'
                                AND (r->>'seat_number')::integer = (x->>'seat')::integer
                                AND (r->>'stack')::numeric
                                      = (x->>'stack')::numeric + (x->>'totalInvested')::numeric)
               ELSE false END))
       OR (snap.state_json->>'pot')::numeric IS DISTINCT FROM
            (SELECT sum((x->>'totalInvested')::numeric)
               FROM jsonb_array_elements(snap.state_json->'players') x) THEN
      RAISE EXCEPTION 'F06_ABORT_SAVED_STACKS_CHANGED' USING ERRCODE = '55000';
    END IF;
    -- Every hole card went to a live chair of this table.
    IF EXISTS (SELECT 1 FROM public.table_hole_cards c
                WHERE c.table_id = h.table_id AND c.hand_number = h.hand_number
                  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(roster) r
                                   WHERE r->>'user_id' = c.user_id::text)) THEN
      RAISE EXCEPTION 'F06_STRANDED_CARDS_CHANGED' USING ERRCODE = '55000';
    END IF;

    hands := hands || jsonb_build_array(jsonb_build_object(
      'permit', to_jsonb(h), 'ruling', 'misdeal_voided', 'shape', 'stranded_mixed_original',
      'snapshot_id', snap.id, 'snapshot_hash', md5(to_jsonb(snap)::text),
      'snapshot_created_at', snap.created_at, 'pot_returned_to_chairs', snap.state_json->'pot',
      'hole_cards', (SELECT count(*) FROM public.table_hole_cards c
                      WHERE c.table_id = h.table_id AND c.hand_number = h.hand_number),
      'binding', b, 'roster', roster, 'busts_pending_elimination', v_busts, 'break_id', NULL));
    v_snap_ids := v_snap_ids || snap.id;
  END LOOP;

  actual := jsonb_build_object(
    'kind', 'stranded_mixed_original', 'tournament_id', t, 'format_contract', event.format_contract,
    'transfer_id', xfer.transfer_id, 'origin_generation', xfer.origin_generation,
    'successor_generation', xfer.successor_generation, 'transfer_created_at', xfer.created_at,
    'hands', hands, 'credit', 0,
    'reason', 'The origin generation reserved and dealt these hands and died before any reached a commit; its successor can only be admitted once each has a terminal disposition, and only the origin could give one. Every chair already holds its pre-deal stack, so the hands are misdeals and nothing moves.');
  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION 'PLATFORM_FROZEN: stranded mixed void refused' USING ERRCODE = '55000';
  END IF;

  -- The receipt the mixed custody snapshot reads as the original's terminal
  -- disposition. Only the ORIGIN generation is disposed; the successor stays
  -- claimable, and is admitted by the engine exactly as designed.
  INSERT INTO smarter_private.f06_mixed_aborts (receipt_id, tournament_id, expected)
  VALUES (v_receipt, t, actual);
  INSERT INTO smarter_private.f06_mixed_abort_generations (tournament_id, generation, receipt_id)
  VALUES (t, xfer.origin_generation, v_receipt);
  FOR item IN SELECT value FROM jsonb_array_elements(hands) LOOP
    INSERT INTO smarter_private.f06_mixed_abort_hands
      (permit_id, receipt_id, tournament_id, generation, table_id, hand_number,
       snapshot_id, break_id, prior_hand_id, prior_abort_receipt_id, expected)
    VALUES ((item->'permit'->>'permit_id')::uuid, v_receipt, t, xfer.origin_generation,
            (item->'permit'->>'table_id')::uuid, (item->'permit'->>'hand_number')::bigint,
            (item->>'snapshot_id')::uuid, NULL, NULL, NULL, item);
  END LOOP;
  UPDATE smarter_private.f06_hand_permits SET state = 'aborted_unsettled', evidence_id = v_receipt
   WHERE permit_id = ANY (reserved_ids) AND state = 'reserved';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> cardinality(reserved_ids) THEN
    RAISE EXCEPTION 'F06_STRANDED_PERMIT_CLAIM_LOST' USING ERRCODE = '40001';
  END IF;
  UPDATE public.hand_state_snapshots SET is_complete = true
   WHERE id = ANY (v_snap_ids) AND NOT is_complete;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> cardinality(v_snap_ids) THEN
    RAISE EXCEPTION 'F06_STRANDED_SNAPSHOT_CLAIM_LOST' USING ERRCODE = '40001';
  END IF;

  -- After: nothing reserved, the origin disposed and the successor not, every
  -- original carries the evidence the successor's admission reads, and not
  -- one chip or registration moved.
  SELECT jsonb_build_object(
           'seats', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', s.id, 'user_id', s.user_id,
                              'stack', s.stack, 'left_at', s.left_at) ORDER BY s.id), '[]'::jsonb)
                       FROM public.table_seats s WHERE s.table_id = ANY (tab_ids)),
           'registrations', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', p.id, 'status', p.status,
                              'chips', p.chips, 'table_id', p.table_id, 'seat_number', p.seat_number) ORDER BY p.id), '[]'::jsonb)
                       FROM public.tournament_players p WHERE p.tournament_id = t))
    INTO v_after;
  IF v_after IS DISTINCT FROM v_before
     OR EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits WHERE tournament_id = t AND state = 'reserved')
     OR NOT smarter_private.f06_generation_aborted(t, xfer.origin_generation)
     OR smarter_private.f06_generation_aborted(t, xfer.successor_generation)
     OR EXISTS (
          SELECT 1 FROM smarter_private.f06_hand_permits o
           WHERE o.permit_id = ANY (original_ids)
             AND NOT EXISTS (
               SELECT 1 FROM smarter_private.f06_mixed_abort_hands a
                 JOIN smarter_private.f06_mixed_aborts c USING (receipt_id, tournament_id)
                WHERE (a.permit_id, a.receipt_id, a.tournament_id, a.generation, a.table_id, a.hand_number)
                      = (o.permit_id, o.evidence_id, o.tournament_id, o.generation, o.table_id, o.hand_number)
                  AND o.state = 'aborted_unsettled' AND c.outcome = 'aborted_unsettled'
                  AND a.expected->'permit' = (to_jsonb(o) || jsonb_build_object('state', 'reserved', 'evidence_id', NULL)))) THEN
    RAISE EXCEPTION 'F06_STRANDED_POSTIMAGE_CHANGED' USING ERRCODE = '55000';
  END IF;

  RETURN jsonb_build_object('ok', true, 'outcome', 'aborted_unsettled', 'receipt_id', v_receipt,
    'tournament_id', t, 'transfer_id', xfer.transfer_id, 'origin_generation', xfer.origin_generation,
    'successor_generation', xfer.successor_generation, 'hands_voided', cardinality(reserved_ids),
    'credit', 0);
END
$function$;

REVOKE ALL ON FUNCTION public.fn_f06_void_stranded_mixed_original(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

DO $post_fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_f06_void_stranded_mixed_original(uuid)'::regprocedure
       AND md5(p.prosrc) = '49f45101006d8b94d192ac826ad7327f'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.proconfig::text = '{"search_path=pg_catalog, public, smarter_private"}'
       AND p.prosecdef
       AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'POSTIMAGE: fn_f06_void_stranded_mixed_original is not the reviewed definition with its owner, grants and settings';
  END IF;
  IF has_function_privilege('anon', 'public.fn_f06_void_stranded_mixed_original(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_f06_void_stranded_mixed_original(uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.fn_f06_void_stranded_mixed_original(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTIMAGE: the stranded void is callable by a role other than its owner';
  END IF;
END
$post_fn$;

SET LOCAL statement_timeout = '30s';

DO $void$
DECLARE
  targets uuid[] := ARRAY['0638a24f-b164-4303-a40d-54012c2dd091'::uuid, '06891c6b-7034-4a3d-a43b-d94ac4a42c09'::uuid, '0d0be6c3-c03e-4b47-9a04-3049120fb6fe'::uuid, '0dc76da8-81ea-4219-80ac-b0fc8fe33588'::uuid, '15022394-c504-4a93-8a67-1f1812ee58c4'::uuid, '1a26a0d5-3b7d-4738-bbf8-689aad856dc2'::uuid, '229960ba-e11e-48cd-ba6e-03b4080a277a'::uuid, '23ef2d58-deb5-445e-8211-afd582cdc0cb'::uuid, '2460c193-29c2-4bc2-9e7b-f82edcde33c3'::uuid, '2533fd6e-42e3-4f10-b065-911191b1827e'::uuid, '2d05c13f-e9e8-4e10-8e1c-94e3331e17c5'::uuid, '2f56f096-131e-4217-9ade-43686be8e208'::uuid, '345d603d-2fd4-47c5-8245-44c09eea9527'::uuid, '376f71ad-4b3d-42c7-a7eb-8a7140fa50c3'::uuid, '3e88e86f-d14f-4140-a451-6efb985a7287'::uuid, '3ea5c637-746f-4599-8b6c-e0a1721a67bb'::uuid, '4a2cd958-d270-42c8-b1e4-4fc67b2e27cb'::uuid, '4b63520b-4931-457c-98c5-f627b97bee10'::uuid, '4d3b30c6-8dc0-4c60-bca3-9c450457ddbb'::uuid, '4e2de62d-3680-4247-ba6f-0b26485701b2'::uuid, '50c9366f-7388-4b48-8490-adf8b163e07a'::uuid, '53336c51-4af8-4519-b89a-24edbc48caf4'::uuid, '54077dd0-1cc7-4d81-84fb-1436555e36e2'::uuid, '55b3e483-e5b8-4ff7-a493-3dda67b2b403'::uuid, '59cf148e-cac6-4d58-8433-a8d4a0c30872'::uuid, '5cf01b6e-dd39-44fb-b8b9-54dc5cde2b48'::uuid, '707d45bd-8c0e-4c5f-a2f5-ceb4e6cae783'::uuid, '75035369-3f79-4fb1-b854-6f4a5e10dfd5'::uuid, '77848c8d-f46e-4a71-b322-c463e338813e'::uuid, '833ca956-dd48-4e7a-9288-9df5c2e4a910'::uuid, '83cd85d0-31e2-412a-96bd-198a8226b600'::uuid, '8470c181-2e2a-4a7d-bb80-efbca069cfa0'::uuid, '88283987-cb1c-49fb-b727-9a342712ad69'::uuid, '88bc3535-0a9c-4673-b85a-a2d95bb70057'::uuid, '89a23275-3d48-487b-b4b3-a7872dc6590f'::uuid, '8cefaea6-afa8-4c02-8399-db098faaedc4'::uuid, '8efe1e77-1502-4e2f-8b3c-5455a1dfd4a0'::uuid, '93768b56-a19c-4ae8-8d2e-e75c5dbfe510'::uuid, '9714693c-c47a-4a14-9475-d876fcf401f3'::uuid, '985f2f44-0ff3-4923-a0d3-e71fbcd33513'::uuid, '995b19b5-4c52-4132-aae9-02ce165ec20d'::uuid, 'a3a95a1b-ad40-40f8-ba44-188f17e72402'::uuid, 'a4297e3d-8801-45a6-a6e4-fccd472fcc19'::uuid, 'aabc4362-21f2-4ebe-b9ec-ec2cbf7c1cf3'::uuid, 'abd8d2f6-3c8b-4ab4-974d-972e372f3c19'::uuid, 'ae694628-d3d4-4246-acbc-ba46057e744d'::uuid, 'b0f7803d-ebd2-408d-89bb-7be1ab1f0965'::uuid, 'b62032c2-f3ba-44a6-a8c6-7cc355d55ca9'::uuid, 'b63e7df8-158b-46e7-a467-84ea3c198b54'::uuid, 'b6ec4419-012d-4368-b877-a284abaf4b7c'::uuid, 'bd74d80b-150f-487d-affc-1dadac0eaa9d'::uuid, 'c1f5fddf-606f-47a7-a5b1-1f3507a16908'::uuid, 'c4563a3d-1a18-4771-8506-3eb4cf7bc60d'::uuid, 'c55570a2-0228-4ffa-a6ac-841ba732fcbc'::uuid, 'c5d2b2fe-64c6-4e01-b094-b835302fd0cf'::uuid, 'c7f21a83-367c-459e-9639-067fa92516f5'::uuid, 'ccb3e27f-dc28-46cc-afa5-03f8281d1dc8'::uuid, 'ce6e331c-fc99-430a-bc72-ef9468a5be1f'::uuid, 'd4de97bd-41b1-4dce-ae62-29bcd9a2d961'::uuid, 'd5dad364-3106-4c40-a3db-c1ea8fd4d52a'::uuid, 'd964bc87-8a66-47ad-a8d5-2cc288c958ea'::uuid, 'de510a9f-9acd-406c-9ad1-fb3a3a4c8e2a'::uuid, 'e0e0c080-490e-4a48-8c17-f7f0c7ab3197'::uuid, 'e650dc99-e632-4d66-9e24-56154f8cbd50'::uuid, 'e8a722dd-ea0c-4e3c-8e4a-af303a88c9ab'::uuid, 'ef346768-53d1-446a-af36-10eebcda82b0'::uuid, 'f250b46c-c627-4643-9a9c-6e5361621901'::uuid, 'f5535d97-bc45-4cab-bce0-7771c72777ba'::uuid, 'f7336095-5934-4a64-ae4c-73eb43e3513d'::uuid, 'f8e73bf3-d0b6-48f3-9992-b5d5a9939bd2'::uuid, 'fa737031-2d8b-4d11-9a02-44ac5b3dbe67'::uuid];
  t uuid;
  r jsonb;
  v_started timestamptz := clock_timestamp();
  v_voided uuid[] := ARRAY[]::uuid[];
  v_deferred text[] := ARRAY[]::text[];
  v_refused text[] := ARRAY[]::text[];
  v_state text;
  v_msg text;
BEGIN
  IF cardinality(targets) <> 71 THEN
    RAISE EXCEPTION 'the target list is not the 71 events read 2026-09-27';
  END IF;
  FOREACH t IN ARRAY targets LOOP
    IF clock_timestamp() - v_started > interval '4 seconds' THEN
      v_deferred := v_deferred || (t::text || ':time_budget');
      CONTINUE;
    END IF;
    BEGIN
      r := public.fn_f06_void_stranded_mixed_original(t);
      IF COALESCE((r->>'ok')::boolean, false) IS NOT TRUE OR (r->>'credit')::numeric <> 0 THEN
        RAISE EXCEPTION 'unexpected void result for %: %', t, r;
      END IF;
      v_voided := v_voided || t;
    EXCEPTION
      WHEN serialization_failure OR lock_not_available THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
        v_deferred := v_deferred || (t::text || ':' || v_msg);
      WHEN object_not_in_prerequisite_state THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
        IF v_msg LIKE 'PLATFORM_FROZEN%' THEN
          v_deferred := v_deferred || (t::text || ':' || v_msg);
        ELSIF v_msg LIKE 'F06_%' THEN
          v_refused := v_refused || (t::text || ':' || v_msg);
        ELSE
          RAISE;
        END IF;
    END;
  END LOOP;
  RAISE NOTICE 'stranded mixed originals voided: % of %', cardinality(v_voided), cardinality(targets);
  RAISE NOTICE 'deferred (retryable): %', v_deferred;
  RAISE NOTICE 'refused (named): %', v_refused;
  IF cardinality(v_voided) = 0 THEN
    RAISE EXCEPTION 'no stranded event was voided; deferred % refused %', v_deferred, v_refused;
  END IF;
  -- POSTIMAGE for every voided event: nothing reserved, the origin disposed and
  -- the successor claimable, one stranded receipt, no lease written.
  IF EXISTS (
       SELECT 1 FROM unnest(v_voided) v(id)
        WHERE EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits p WHERE p.tournament_id = v.id AND p.state = 'reserved')
           OR EXISTS (SELECT 1 FROM public.engine_tournament_leases l WHERE l.tournament_id = v.id)
           OR (SELECT count(*) FROM smarter_private.f06_mixed_aborts a
                WHERE a.tournament_id = v.id AND a.expected->>'kind' = 'stranded_mixed_original') <> 1
           OR NOT EXISTS (
                SELECT 1 FROM smarter_private.f06_manager_custody_transfers x
                 WHERE x.tournament_id = v.id
                   AND smarter_private.f06_generation_aborted(v.id, x.origin_generation)
                   AND NOT smarter_private.f06_generation_aborted(v.id, x.successor_generation)
                   AND NOT EXISTS (SELECT 1 FROM smarter_private.f06_manager_custody_completions d
                                    WHERE d.transfer_id = x.transfer_id))) THEN
    RAISE EXCEPTION 'POSTIMAGE: a voided event is not in the admissible state';
  END IF;
END
$void$;

COMMIT;
