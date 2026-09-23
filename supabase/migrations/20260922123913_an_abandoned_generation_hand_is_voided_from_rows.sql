-- AN ABANDONED GENERATION'S HAND IS VOIDED FROM ROWS (2026-09-22)
--
-- What was wrong
-- --------------
-- A tournament hand is authorised by one smarter_private.f06_hand_permits row
-- (state 'reserved') written under the tournament's lease generation. When that
-- generation dies mid-hand (lease lost, engine restart, watchdog kill) the permit
-- stays 'reserved' for ever: every successor refuses to deal at that table
-- ('f06_startup_permit_projection_unproven' / 'f06_prior_hand_unresolved'),
-- because the only doors that could close the permit are bespoke to single
-- reviewed incidents (fn_f06_abort_unsettled_generation needs the SAME live
-- generation, fn_f06_abort_successor_unsettled_hand needs a heads-up SNG with a
-- park, f06_zero_cards_abort_is_inert is pinned to one hand).
--
-- Measured 2026-09-22 12:30 UTC: 694 reserved permits, 464 RUNNING tournaments,
-- 3,425 live tournament seats and 863 horses held in events that had not dealt
-- since 2026-09-18. The fleet manager counts those horses as seated and seeds
-- nothing, so horses dealing fell 964 -> 250 and tournament completions fell
-- 14,165/day -> 90/day.
--
-- What this adds
-- --------------
-- ONE general, receipted, zero-credit door for exactly that shape:
--
--   public.fn_f06_abort_abandoned_generation(tournament, generation, receipt,
--                                            reason, release_current_lease)
--
-- It closes every reserved permit of ONE dead generation of ONE running event,
-- and it refuses unless every one of these is proved from rows, under the same
-- lease -> lane -> player -> event -> table -> seat -> permit lock order as the
-- existing abort doors:
--
--   * the generation is dead: no fresh lease row carries it;
--   * no manager custody transfer is pending for the event;
--   * no hand at or after the permit committed (hand_atomic_commits,
--     hand_history), was dispatched (f06_hand_dispatch), wrote private state,
--     or has a retained submission (those belong to the successor handoff in
--     fn_ca_resume_hand_submission, never to an abort);
--   * no later permit exists at the table and the table is the live incarnation
--     the permit names;
--   * every live chair at the table is exactly one 'playing' registration
--     holding the same chips;
--   * with a snapshot: it is the only one, incomplete, preflop, has 2-10
--     players, names exactly the live chairs, and for EVERY player
--     stack + totalInvested == the durable seat stack == the registration's
--     chips (no uncalled return, dead investment inside the total), and the pot
--     is the sum of the investments. The pot therefore exists only inside the
--     snapshot, was never deducted from anything durable, and voiding the hand
--     restores exactly what is already durable. Nothing is credited or debited.
--   * without a snapshot: no hole cards were ever persisted for the hand either,
--     so the hand never started durably; its permit closes as 'never_started'.
--
-- The receipt is written into the existing receipt tables the F06 guards
-- already read (f06_generation_aborts / f06_generation_abort_hands), so
-- f06_generation_aborted() fences the dead generation for ever and
-- f06_aborted_hand_guard fences its hands. A pre-manifest park of that
-- generation is withdrawn under the same receipt.
--
-- THE CLOCK RETURNS TO WHERE PLAY STOPPED. A frozen event's blind clock kept
-- running for days (median level 182 on the stuck Spins, 1,340 on one), so a
-- resume would deal 10,000,000/10,000,000 blinds. Dan's maintenance rule is
-- that play "PICKS BACK UP EXACTLY AS IT WAS". The door therefore restores the
-- level of the latest durable hand evidence (the voided snapshot's blinds or the
-- event's last hand_history row, whichever is later), resolved through
-- fn_resolve_tournament_blinds, with a fresh full level - and only ever
-- backwards, never forwards, and never for an event on a break.
--
-- release_current_lease = true additionally retires the CURRENT owner's
-- generation (fenced by its own receipt row) and releases its lease so a fresh
-- manager adopts the event from rows. It refuses if that owner has a hand of
-- its own in the air.
--
-- Service role only, replay-safe on the receipt id, refuses under the platform
-- freeze. It never moves chips, prizes, escrow, wallets or ledger rows.

CREATE OR REPLACE FUNCTION public.fn_f06_abort_abandoned_generation(
  p_tournament_id uuid,
  p_generation uuid,
  p_receipt_id uuid,
  p_reason text,
  p_release_current_lease boolean DEFAULT false
) RETURNS jsonb
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
       OR EXISTS (SELECT 1 FROM smarter_private.f06_hand_dispatch d WHERE d.permit_id = h.permit_id)
       OR EXISTS (SELECT 1 FROM public.hand_private_state hp
                   WHERE hp.table_id = h.table_id AND hp.hand_number >= h.hand_number) THEN
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
                                        AND s.seat_number = tp.seat_number AND s.left_at IS NULL)) THEN
      RAISE EXCEPTION 'F06_ABANDONED_ROSTER_CHANGED' USING ERRCODE = '55000';
    END IF;

    SELECT count(*) INTO n FROM public.hand_state_snapshots s
     WHERE s.table_id = h.table_id AND s.hand_number = h.hand_number;
    IF n > 1 THEN
      RAISE EXCEPTION 'F06_ABORT_SNAPSHOT_AMBIGUOUS' USING ERRCODE = '55000';
    END IF;

    v_break := NULL;
    FOR o IN SELECT * FROM smarter_private.f06_operations
              WHERE source_table_id = h.table_id
                AND state NOT IN ('acknowledged', 'withdrawn_before_manifest')
              ORDER BY break_id LOOP
      -- Only one pre-manifest park of this exact dead generation can take a
      -- truthful withdrawal, and only against a hand receipt that names it.
      IF v_break IS NOT NULL OR n = 0
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

    IF n = 1 THEN
      SELECT * INTO snap FROM public.hand_state_snapshots s
       WHERE s.table_id = h.table_id AND s.hand_number = h.hand_number FOR UPDATE;
      IF snap.is_complete IS DISTINCT FROM false
         OR snap.stage IS DISTINCT FROM 'preflop'
         OR snap.state_json->>'stage' IS DISTINCT FROM 'preflop'
         OR jsonb_typeof(snap.state_json->'players') IS DISTINCT FROM 'array'
         OR jsonb_array_length(snap.state_json->'players') NOT BETWEEN 2 AND 10
         OR jsonb_array_length(snap.state_json->'players') IS DISTINCT FROM jsonb_array_length(roster)
         OR (SELECT count(DISTINCT x->>'user_id') FROM jsonb_array_elements(snap.state_json->'players') x)
              IS DISTINCT FROM jsonb_array_length(roster)::bigint
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
                   AND COALESCE((x->>'returnedUncalled')::numeric, 0) = 0
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
      hands := hands || jsonb_build_array(jsonb_build_object(
        'permit', to_jsonb(h), 'snapshot_id', snap.id,
        'snapshot_hash', md5(to_jsonb(snap)::text), 'snapshot_created_at', snap.created_at,
        'roster', roster, 'break_id', v_break,
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
        'permit', to_jsonb(h), 'roster', roster));
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
    'level', v_level, 'release_current_lease', p_release_current_lease, 'reason', p_reason);
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
            (item->>'snapshot_id')::uuid, (item->>'break_id')::uuid, item);
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
    'parks_withdrawn', cardinality(v_withdraw), 'level', v_level,
    'released_generation', CASE WHEN p_release_current_lease AND v_lease_found THEN v_current_g END,
    'credit', 0);
END
$function$;

REVOKE ALL ON FUNCTION public.fn_f06_abort_abandoned_generation(uuid, uuid, uuid, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_abort_abandoned_generation(uuid, uuid, uuid, text, boolean)
  TO service_role;

COMMENT ON FUNCTION public.fn_f06_abort_abandoned_generation(uuid, uuid, uuid, text, boolean) IS
  'Zero-credit, receipted void of every reserved F06 hand permit of one dead lease generation of one running event, proved from rows; restores the blind level of the last durable hand; optionally retires the current owner generation and releases its lease. 2026-09-22.';
