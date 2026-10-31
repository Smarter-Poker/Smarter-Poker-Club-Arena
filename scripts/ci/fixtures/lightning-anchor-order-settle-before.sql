-- Exact live source c9cece954b567607c11d7a1016f4eaa2 captured 2026-10-31.
CREATE OR REPLACE FUNCTION public.fn_lightning_settle_hand(p_hand_id uuid, p_request_id uuid, p_host_table_id uuid, p_lease_instance text, p_lease_generation uuid, p_results jsonb, p_rake numeric, p_bbj numeric, p_hand_row jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_instance uuid;
  h          record;
  i          record;
  l          record;
  t          record;
  a          record;
  s          record;
  v_now      timestamptz := clock_timestamp();
  v_rake     numeric := round(coalesce(p_rake, 0), 2);
  v_bbj      numeric := round(coalesce(p_bbj, 0), 2);
  v_row_in   jsonb := coalesce(p_hand_row, '{}'::jsonb);
  v_results  jsonb;
  v_hash     text;
  v_p        jsonb;
  v_n        integer;
  v_before   numeric;
  v_after    numeric;
  v_why      text;
  v_stacks   jsonb := '[]'::jsonb;
  v_banks    jsonb := '[]'::jsonb;
  v_contrib  jsonb;
  v_returned jsonb;
  v_promo    jsonb;
  v_players  jsonb;
  v_pot      numeric;
  v_bb       numeric;
  v_sb       numeric;
  v_max_buy  numeric;
  v_row      jsonb;
  v_env      jsonb;
  v_res      jsonb;
  v_hh       uuid;
  v_deltas   jsonb;
  v_receipt  jsonb;
  v_msg      text;
  v_detail   text;
  v_mode     text;
BEGIN
  -- 0. THE SHAPE. Nothing is read or locked for a call that cannot settle.
  IF p_hand_id IS NULL OR p_request_id IS NULL OR p_host_table_id IS NULL
     OR nullif(btrim(coalesce(p_lease_instance, '')), '') IS NULL OR p_lease_generation IS NULL
     OR jsonb_typeof(p_results) IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_row_in) IS DISTINCT FROM 'object'
     OR coalesce(p_rake, 0) < 0 OR coalesce(p_bbj, 0) < 0
     OR coalesce(p_rake, 0) <> v_rake OR coalesce(p_bbj, 0) <> v_bbj THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_arguments');
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_results) x
              WHERE jsonb_typeof(x) IS DISTINCT FROM 'object'
                 OR jsonb_typeof(x -> 'player_id') IS DISTINCT FROM 'string'
                 OR jsonb_typeof(x -> 'stack_after') IS DISTINCT FROM 'number'
                 OR jsonb_typeof(x -> 'contributed') IS DISTINCT FROM 'number'
                 OR jsonb_typeof(x -> 'won') IS DISTINCT FROM 'number'
                 OR jsonb_typeof(x -> 'showed') IS DISTINCT FROM 'boolean'
                 OR coalesce(x ->> 'fold_type', '') NOT IN ('none', 'normal', 'fast', 'fold_watch')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_results');
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_results) x
              WHERE NOT pg_input_is_valid(x ->> 'player_id', 'uuid')
                 OR (x ->> 'stack_after')::numeric < 0
                 OR (x ->> 'stack_after')::numeric <> round((x ->> 'stack_after')::numeric, 2)
                 OR (x ->> 'contributed')::numeric < 0
                 OR (x ->> 'won')::numeric < 0)
     OR (SELECT count(DISTINCT (x ->> 'player_id')::uuid) FROM jsonb_array_elements(p_results) x)
        IS DISTINCT FROM jsonb_array_length(p_results)::bigint THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_results');
  END IF;
  IF v_row_in ? 'returned_uncalled'
     AND (jsonb_typeof(v_row_in -> 'returned_uncalled') IS DISTINCT FROM 'object'
          OR EXISTS (SELECT 1 FROM jsonb_each(v_row_in -> 'returned_uncalled') e
                      WHERE NOT pg_input_is_valid(e.key, 'uuid') OR jsonb_typeof(e.value) IS DISTINCT FROM 'number')
          OR EXISTS (SELECT 1 FROM jsonb_each(v_row_in -> 'returned_uncalled') e
                      WHERE jsonb_typeof(e.value) = 'number' AND (e.value::text)::numeric < 0)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_returned_uncalled');
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'player_id', (x ->> 'player_id')::uuid,
           'stack_after', round((x ->> 'stack_after')::numeric, 2),
           'contributed', round((x ->> 'contributed')::numeric, 2),
           'won', round((x ->> 'won')::numeric, 2),
           'fold_type', x ->> 'fold_type',
           'showed', (x ->> 'showed')::boolean) ORDER BY (x ->> 'player_id')::uuid)
    INTO v_results FROM jsonb_array_elements(p_results) x;
  -- The request: everything that decides the outcome. The lease is not in it,
  -- so a retry after a renewal still answers the stored receipt.
  v_hash := encode(sha256(convert_to(jsonb_build_object(
              'hand_id', p_hand_id, 'request_id', p_request_id, 'host_table_id', p_host_table_id,
              'results', v_results, 'rake', v_rake, 'bbj', v_bbj, 'hand_row', v_row_in)::text, 'UTF8')), 'hex');

  -- 1. THE INSTANCE, LOCKED, as every door that changes a live hand takes it.
  SELECT lh.lightning_instance_id INTO v_instance FROM public.lightning_hand lh WHERE lh.hand_id = p_hand_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'hand_not_found');
  END IF;
  SELECT li.id, li.state, li.started_at, li.abandon_reason, li.cluster_id, li.cluster_epoch
    INTO i FROM public.lightning_instance li WHERE li.id = v_instance FOR UPDATE;
  SELECT lh.hand_id, lh.cluster_id, lh.cluster_epoch, lh.hand_number, lh.host_table_id,
         lh.settle_request_hash, lh.settle_receipt, lh.hand_history_id
    INTO h FROM public.lightning_hand lh WHERE lh.hand_id = p_hand_id;

  IF i.state = 'complete' THEN
    IF h.settle_request_hash IS NOT DISTINCT FROM v_hash AND h.settle_receipt IS NOT NULL THEN
      RETURN h.settle_receipt || jsonb_build_object('ok', true, 'replay', true,
        'accepted_lease_generation', (SELECT c.post_commit_payload #> '{accepted_hand_facts,horse_journal_identity,lease_generation}'
          FROM public.hand_atomic_commits c WHERE c.hand_id = h.hand_history_id AND c.table_id = h.host_table_id));
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'already_settled', 'hand_id', p_hand_id,
                              'hand_history_id', h.hand_history_id);
  END IF;
  IF i.state = 'abandoned' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'instance_abandoned', 'abandon_reason', i.abandon_reason);
  END IF;
  IF i.state IS DISTINCT FROM 'dealing' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'instance_not_dealing', 'state', i.state);
  END IF;
  -- LIGHTNING PHASE 6 REMEDIATION (20261001201216): A FROZEN CLUSTER SETTLES
  -- NOTHING. A freeze answers an impossible state; a hand still dealing when
  -- it lands must not move a chip afterwards. Refused here, before the
  -- marker, a seat or the hand row is written, so the engine abandons the
  -- instance and every anchor stack stays as it was. A hand settled before
  -- the freeze is answered above with its receipt. Read without a row lock:
  -- a lock would queue every settlement behind the matcher's and the tick's
  -- holds on the Cluster row, and a hand that passes this while a freeze is
  -- still uncommitted is held to its own conservation check below.
  SELECT cg.cluster_mode INTO v_mode FROM public.cash_games cg WHERE cg.id = i.cluster_id;
  IF v_mode IS NOT DISTINCT FROM 'frozen' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cluster_frozen', 'retry', false,
                              'hand_id', p_hand_id, 'cluster_id', i.cluster_id);
  END IF;
  IF h.hand_number IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'hand_number_not_bound');
  END IF;
  IF h.host_table_id IS DISTINCT FROM p_host_table_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'host_table_mismatch', 'host_table_id', h.host_table_id);
  END IF;

  -- 2. THE HOST LEASE, by the predicate the physical door fences with
  --    (fn_ca_commit_hand_settlement_exact_before_obligations), read-only so a
  --    stale engine is refused before anything is locked. The door re-checks
  --    it under its own lock.
  SELECT el.instance_id, el.lease_generation, el.protocol_version, el.heartbeat_at
    INTO l FROM public.engine_table_leases el WHERE el.table_id = p_host_table_id;
  IF NOT FOUND
     OR l.protocol_version IS DISTINCT FROM 2
     OR l.instance_id IS DISTINCT FROM p_lease_instance
     OR l.lease_generation IS DISTINCT FROM p_lease_generation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'hand_lease_lost');
  END IF;
  IF l.heartbeat_at < clock_timestamp() - make_interval(secs => public.fn_engine_lease_stale_seconds()) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'hand_lease_stale');
  END IF;

  SELECT tb.id, tb.club_id, tb.tournament_id, tb.small_blind, tb.big_blind, tb.max_buy_in,
         tb.game_variant, tb.cluster_id, coalesce(cl.asset, 'chips') AS asset
    INTO t FROM public.tables tb LEFT JOIN public.clubs cl ON cl.id = tb.club_id
   WHERE tb.id = p_host_table_id;
  IF NOT FOUND OR t.cluster_id IS DISTINCT FROM h.cluster_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'host_table_not_in_cluster');
  END IF;
  IF t.tournament_id IS NOT NULL OR t.club_id IS NULL OR t.asset IS DISTINCT FROM 'chips' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'host_table_cannot_record_a_chip_cash_hand');
  END IF;

  -- 3. EVERY PARTICIPANT, NAMED ONCE, with the result the engine reports.
  SELECT jsonb_agg(jsonb_build_object(
           'player_id', hp.player_id, 'pool_slot_id', hp.pool_slot_id,
           'pool_session_id', sl.pool_session_id, 'anchor_seat_id', ps.anchor_seat_id,
           'seat', hp.seat, 'stack_before', hp.stack_before,
           'recorded_fold', hp.fold_type, 'folded_at', hp.folded_at,
           'committed_at_fold', hp.committed_at_fold,
           'stack_after', rr.r -> 'stack_after', 'contributed', rr.r -> 'contributed',
           'won', rr.r -> 'won', 'fold_type', rr.r -> 'fold_type', 'showed', rr.r -> 'showed',
           'has_result', rr.r IS NOT NULL) ORDER BY hp.player_id),
         count(*)
    INTO v_p, v_n
    FROM public.lightning_hand_player hp
    JOIN public.lightning_pool_slot sl ON sl.id = hp.pool_slot_id
    JOIN public.lightning_pool_session ps ON ps.id = sl.pool_session_id
    LEFT JOIN LATERAL (SELECT x AS r FROM jsonb_array_elements(v_results) x
                        WHERE (x ->> 'player_id')::uuid = hp.player_id) rr ON true
   WHERE hp.hand_id = p_hand_id;
  IF coalesce(v_n, 0) < 2
     OR v_n IS DISTINCT FROM jsonb_array_length(v_results)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_p) x WHERE (x ->> 'has_result')::boolean IS DISTINCT FROM true) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'results_do_not_name_every_participant',
                              'participants', v_n, 'results', jsonb_array_length(v_results));
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_p) x
              WHERE x ->> 'recorded_fold' <> 'none' AND x ->> 'fold_type' IS DISTINCT FROM x ->> 'recorded_fold') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'fold_type_disagrees_with_the_recorded_fold');
  END IF;

  -- 4. THE MONEY. Any disagreement is an impossible state: the Cluster
  --    freezes and the hand is answered frozen, never raised (a raise would
  --    roll the freeze back with it).
  SELECT sum((x ->> 'stack_before')::numeric), sum((x ->> 'stack_after')::numeric)
    INTO v_before, v_after FROM jsonb_array_elements(v_p) x;
  v_why := CASE
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_p) x WHERE jsonb_typeof(x -> 'stack_before') IS DISTINCT FROM 'number')
      THEN 'stack_before_missing'
    WHEN round(v_before, 2) IS DISTINCT FROM round(v_after + v_rake + v_bbj, 2)
      THEN 'conservation'
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_p) x
                  WHERE jsonb_typeof(x -> 'committed_at_fold') = 'number'
                    AND (
                      (x ->> 'won')::numeric IS DISTINCT FROM 0::numeric
                      OR (x ->> 'contributed')::numeric
                           + coalesce((v_row_in -> 'returned_uncalled' ->> (x ->> 'player_id'))::numeric, 0)
                         IS DISTINCT FROM (x ->> 'committed_at_fold')::numeric
                      OR (x ->> 'stack_after')::numeric
                         IS DISTINCT FROM (x ->> 'stack_before')::numeric - (x ->> 'committed_at_fold')::numeric
                           + coalesce((v_row_in -> 'returned_uncalled' ->> (x ->> 'player_id'))::numeric, 0)
                    ))
      THEN 'fold_commitment'
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_p) x
                  WHERE x ->> 'recorded_fold' IN ('fast', 'normal')
                    AND (x ->> 'stack_after')::numeric > (x ->> 'stack_before')::numeric)
      THEN 'released_folder_gained'
  END;
  IF v_why IS NOT NULL THEN
    RETURN public.fn_lightning_settlement_freeze(h.cluster_id, h.cluster_epoch, p_hand_id, i.id, p_request_id, v_why,
      jsonb_build_object('stack_before_total', v_before, 'stack_after_total', v_after,
                         'rake', v_rake, 'bbj', v_bbj, 'participants', v_p));
  END IF;

  BEGIN
    -- 5. THE ANCHORS, FOR UPDATE, IN PLAYER ORDER, each named in the marker
    --    for this transaction. Anchors before pool slots and sessions: the
    --    formation barrier's own order.
    FOR a IN SELECT (x ->> 'player_id')::uuid AS player_id, (x ->> 'anchor_seat_id')::uuid AS seat_id,
                    round((x ->> 'stack_after')::numeric - (x ->> 'stack_before')::numeric, 2) AS delta,
                    x AS item
               FROM jsonb_array_elements(v_p) x
              ORDER BY (x ->> 'player_id')::uuid LOOP
      SELECT ts.id, ts.table_id, ts.user_id, ts.left_at, ts.joined_at, ts.stack,
             ts.time_bank_uses_remaining, ts.time_bank_remaining
        INTO s FROM public.table_seats ts WHERE ts.id = a.seat_id FOR UPDATE;
      IF NOT FOUND OR s.left_at IS NOT NULL OR s.user_id IS DISTINCT FROM a.player_id OR s.joined_at IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'PLT04', MESSAGE = 'anchor_not_live',
          DETAIL = jsonb_build_object('player_id', a.player_id, 'seat_id', a.seat_id)::text;
      END IF;
      IF coalesce(s.stack, 0) + a.delta < 0 THEN
        RAISE EXCEPTION USING ERRCODE = 'PLT04', MESSAGE = 'anchor_would_go_negative',
          DETAIL = jsonb_build_object('player_id', a.player_id, 'seat_id', a.seat_id,
                                      'stack', s.stack, 'delta', a.delta)::text;
      END IF;
      INSERT INTO public.lightning_settlement_marker
        (txid, seat_id, anchor_table_id, player_id, hand_id, host_table_id, hand_number)
      VALUES (pg_current_xact_id(), s.id, s.table_id, a.player_id, p_hand_id, p_host_table_id, h.hand_number);
      v_stacks := v_stacks || jsonb_build_array(jsonb_build_object(
        'user_id', a.player_id, 'seat_id', s.id, 'seat_joined_at', to_jsonb(s.joined_at) #>> '{}',
        'stack', a.item -> 'stack_after', 'stack_before', a.item -> 'stack_before'));
      -- The time banks are carried as they stand: a Lightning hand does not
      -- spend the anchor table's bank.
      v_banks := v_banks || jsonb_build_array(jsonb_build_object(
        'user_id', a.player_id, 'seat_id', s.id, 'seat_joined_at', to_jsonb(s.joined_at) #>> '{}',
        'uses_remaining', GREATEST(coalesce(s.time_bank_uses_remaining, 4), 0),
        'seconds_remaining', GREATEST(coalesce(s.time_bank_remaining, 30), 0)));
    END LOOP;

    -- 6. THE PHYSICAL RECORD AND ITS POST-COMMIT ENVELOPE, built exactly as the
    --    engine builds them for a physical hand at the host table.
    -- The accepted-hand envelope counts every dealt player, including zero payers.
    -- Promo playthrough below remains restricted to positive contributions.
    SELECT coalesce(jsonb_object_agg(x ->> 'player_id', (x ->> 'contributed')::numeric), '{}'::jsonb)
      INTO v_contrib FROM jsonb_array_elements(v_p) x;
    SELECT coalesce(jsonb_object_agg(lower(e.key), e.value), '{}'::jsonb)
      INTO v_returned FROM jsonb_each(coalesce(v_row_in -> 'returned_uncalled', '{}'::jsonb)) e;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_returned) k
                WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_p) x WHERE x ->> 'player_id' = k)) THEN
      RAISE EXCEPTION USING ERRCODE = 'PLT03', MESSAGE = 'returned_uncalled_names_a_stranger';
    END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('club_id', t.club_id, 'user_id', e.key, 'wagered', e.value)
                              ORDER BY e.key), '[]'::jsonb)
      INTO v_promo FROM jsonb_each(v_contrib) e WHERE (e.value::text)::numeric > 0;
    v_pot := CASE WHEN jsonb_typeof(v_row_in -> 'pot_size') = 'number' THEN (v_row_in ->> 'pot_size')::numeric
                  ELSE (SELECT coalesce(sum((x ->> 'contributed')::numeric), 0) FROM jsonb_array_elements(v_p) x) END;
    v_bb := CASE WHEN jsonb_typeof(v_row_in -> 'big_blind') = 'number' AND (v_row_in ->> 'big_blind')::numeric > 0
                 THEN (v_row_in ->> 'big_blind')::numeric ELSE t.big_blind END;
    v_sb := CASE WHEN jsonb_typeof(v_row_in -> 'small_blind') = 'number'
                 THEN (v_row_in ->> 'small_blind')::numeric ELSE t.small_blind END;
    v_max_buy := round(coalesce(nullif(t.max_buy_in, 0), coalesce(v_bb, 2) * 200), 2);
    v_players := CASE WHEN jsonb_typeof(v_row_in -> 'players') = 'array' THEN v_row_in -> 'players'
                      ELSE (SELECT jsonb_agg(jsonb_build_object('userId', x ->> 'player_id', 'seat', (x ->> 'seat')::integer,
                                                                'stack', x -> 'stack_after') ORDER BY (x ->> 'seat')::integer)
                              FROM jsonb_array_elements(v_p) x) END;
    v_row := (v_row_in - ARRAY['id', 'created_at', 'reported', 'reported_at', '_accepted_post_commit_facts',
                               'returned_uncalled', 'table_id', 'hand_number', 'tournament_id'])
             || jsonb_build_object(
                  'table_id', p_host_table_id, 'hand_number', h.hand_number, 'tournament_id', NULL,
                  'pot_size', v_pot, 'big_blind', v_bb, 'small_blind', v_sb,
                  'game_variant', coalesce(v_row_in ->> 'game_variant', t.game_variant, 'nlh'),
                  'rake_amount', v_rake, 'bbj_amount', v_bbj,
                  'started_at', coalesce(v_row_in -> 'started_at', to_jsonb(i.started_at)),
                  'ended_at', coalesce(v_row_in -> 'ended_at', to_jsonb(v_now)),
                  'players', v_players,
                  '_accepted_post_commit_facts', jsonb_build_object(
                    'contributions', v_contrib, 'returned_uncalled', v_returned, 'insurance', '[]'::jsonb,
                    'horse_journal_identity', jsonb_build_object('version', 1, 'lease_generation', p_lease_generation))
                    -- A LIGHTNING HAND IS A HAND IN THE STATS (20261025000729): the
                    -- engine's private per-hand facts, kept only when they name exactly
                    -- this hand, host table and club; the row then takes this hand's id
                    -- so the facts and the row agree. Otherwise dropped, as before.
                    || public.fn_lightning_hand_stats_facts(v_row_in, p_hand_id, p_host_table_id, t.club_id))
             || CASE WHEN public.fn_lightning_hand_stats_facts(v_row_in, p_hand_id, p_host_table_id, t.club_id) = '{}'::jsonb
                     THEN '{}'::jsonb ELSE jsonb_build_object('id', p_hand_id) END;
    v_env := jsonb_build_object(
      'version', 1,
      'time_banks', v_banks,
      'rake', CASE WHEN v_rake > 0 THEN jsonb_build_object(
                'club_id', t.club_id, 'amount', v_rake, 'bbj', v_bbj, 'pot', v_pot,
                -- EVERY PARTICIPANT DEALT IN, NOT EVERY PAYER (2026-10-15). The
                -- rake law prices a hand by how many were dealt; a fast-folder
                -- who never put a chip in is still dealt, and v_contrib leaves
                -- him out. v_n is this hand's lightning_hand_player count.
                'num_players', v_n,
                'contributions', v_contrib, 'returned_uncalled', v_returned,
                'tournament_id', NULL, 'method', 'WEIGHTED_CONTRIBUTED') ELSE 'null'::jsonb END,
      'bbj_contribution', CASE WHEN v_bbj > 0 THEN jsonb_build_object(
                'club_id', t.club_id, 'amount', v_bbj, 'big_blind', v_bb) ELSE 'null'::jsonb END,
      'promo_playthrough', v_promo,
      'insurance', '[]'::jsonb,
      'pending_addons', jsonb_build_object('enabled', true, 'max_buy_in', v_max_buy));

    -- THE UNCHANGED PHYSICAL DOOR: lease fence, idempotency key, ca_settlements,
    -- the delta-mode stack write and its conservation identity (through the
    -- adapter, at each anchor), hand_history, hand_projection_outbox,
    -- hand_atomic_commits with the envelope, the provenance receipt.
    v_res := public.fn_ca_commit_hand_settlement(
      p_host_table_id, h.hand_number, v_stacks, v_rake, v_bbj, 'lightning:' || p_hand_id::text,
      0::numeric, v_row, '[]'::jsonb, p_lease_instance, p_lease_generation, v_env);
    IF coalesce((v_res ->> 'replay')::boolean, false) THEN
      RAISE EXCEPTION USING ERRCODE = 'PLT03', MESSAGE = 'physical_hand_already_committed', DETAIL = v_res::text;
    END IF;
    IF coalesce((v_res ->> 'success')::boolean, false) IS NOT TRUE
       OR coalesce((v_res ->> 'atomic_hand_commit')::boolean, false) IS NOT TRUE
       OR coalesce((v_res ->> 'post_commit_obligations')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION USING ERRCODE = 'PLT03', MESSAGE = coalesce(v_res ->> 'reason', 'physical_settlement_refused'),
        DETAIL = v_res::text;
    END IF;
    v_hh := (v_res ->> 'history_id')::uuid;
    DELETE FROM public.lightning_settlement_marker m WHERE m.txid = pg_current_xact_id();

    -- 7. THE LIGHTNING RECORD.
    UPDATE public.lightning_hand_player hp
       SET stack_after = (x ->> 'stack_after')::numeric,
           net_result = (x ->> 'stack_after')::numeric - (x ->> 'stack_before')::numeric,
           showed = (x ->> 'showed')::boolean,
           fold_type = CASE WHEN hp.fold_type = 'none' THEN x ->> 'fold_type' ELSE hp.fold_type END,
           folded_at = CASE WHEN hp.folded_at IS NULL AND x ->> 'fold_type' <> 'none' THEN v_now ELSE hp.folded_at END
      FROM jsonb_array_elements(v_p) x
     WHERE hp.hand_id = p_hand_id AND hp.player_id = (x ->> 'player_id')::uuid;

    UPDATE public.lightning_pool_session ps
       SET hands = ps.hands + 1,
           fast_folds = ps.fast_folds + (q.fold = 'fast')::integer,
           normal_folds = ps.normal_folds + (q.fold = 'normal')::integer,
           fold_and_watch = ps.fold_and_watch + (q.fold = 'fold_watch')::integer,
           showdowns = ps.showdowns + q.showed::integer,
           net_result = ps.net_result + q.net,
           updated_at = clock_timestamp()
      FROM (SELECT (x ->> 'pool_session_id')::uuid AS sid, x ->> 'fold_type' AS fold,
                   (x ->> 'showed')::boolean AS showed,
                   (x ->> 'stack_after')::numeric - (x ->> 'stack_before')::numeric AS net
              FROM jsonb_array_elements(v_p) x) q
     WHERE ps.id = q.sid;
    UPDATE public.lightning_pool_slot sl
       SET hands = sl.hands + 1,
           fast_folds = sl.fast_folds + (q.fold = 'fast')::integer,
           normal_folds = sl.normal_folds + (q.fold = 'normal')::integer,
           fold_and_watch = sl.fold_and_watch + (q.fold = 'fold_watch')::integer,
           showdowns = sl.showdowns + q.showed::integer,
           updated_at = clock_timestamp()
      FROM (SELECT (x ->> 'pool_slot_id')::uuid AS slot_id, x ->> 'fold_type' AS fold,
                   (x ->> 'showed')::boolean AS showed
              FROM jsonb_array_elements(v_p) x) q
     WHERE sl.id = q.slot_id;

    SELECT jsonb_object_agg(x ->> 'player_id',
                            round((x ->> 'stack_after')::numeric - (x ->> 'stack_before')::numeric, 2))
      INTO v_deltas FROM jsonb_array_elements(v_p) x;
    v_receipt := jsonb_build_object(
      'ok', true, 'hand_id', p_hand_id, 'hand_history_id', v_hh, 'hand_number', h.hand_number,
      'host_table_id', p_host_table_id, 'deltas', v_deltas, 'rake', v_rake, 'bbj', v_bbj,
      'request_id', p_request_id, 'request_hash', v_hash,
      'commit_hash', v_res ->> 'commit_hash', 'post_commit_payload_hash', v_res ->> 'post_commit_payload_hash');
    v_receipt := v_receipt || jsonb_build_object(
      'receipt_hash', encode(sha256(convert_to(v_receipt::text, 'UTF8')), 'hex'));
    UPDATE public.lightning_hand
       SET settled_at = v_now, settle_request_id = p_request_id, settle_request_hash = v_hash,
           hand_history_id = v_hh, settle_receipt = v_receipt
     WHERE hand_id = p_hand_id;

    -- dealing -> settling -> complete, through the discipline trigger; the
    -- release trigger hands back every reservation still held (the players
    -- who played on, and fold-and-watch) and emits instance_completed.
    UPDATE public.lightning_instance SET state = 'settling' WHERE id = i.id;
    UPDATE public.lightning_instance
       SET state = 'complete', completed_at = GREATEST(clock_timestamp(), i.started_at)
     WHERE id = i.id;

    INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
    VALUES (h.cluster_id, 'hand_settled', jsonb_build_object(
      'cluster_id', h.cluster_id, 'cluster_epoch', h.cluster_epoch, 'hand_id', p_hand_id,
      'hand_number', h.hand_number, 'host_table_id', p_host_table_id, 'hand_history_id', v_hh,
      'deltas', v_deltas, 'rake', v_rake, 'bbj', v_bbj, 'players', v_n, 'at', v_now),
      h.cluster_epoch, p_request_id);
  EXCEPTION
    WHEN SQLSTATE 'PLT03' THEN
      -- A definite refusal by the physical path: everything since the block
      -- opened, the marker included, is rolled back and nothing moved.
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL;
      RETURN jsonb_build_object('ok', false, 'reason', v_msg,
                                'detail', CASE WHEN pg_input_is_valid(v_detail, 'jsonb') THEN v_detail::jsonb END);
    WHEN SQLSTATE 'PLT04' THEN
      -- An anchor the guard should have held is not where the hand left it.
      -- The block is rolled back and its seat locks released before the
      -- Cluster freezes.
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL;
      RETURN public.fn_lightning_settlement_freeze(h.cluster_id, h.cluster_epoch, p_hand_id, i.id, p_request_id, v_msg,
        CASE WHEN pg_input_is_valid(v_detail, 'jsonb') THEN v_detail::jsonb END);
    WHEN raise_exception THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      IF v_msg LIKE 'atomic hand commit refused%' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'physical_settlement_refused', 'detail', to_jsonb(v_msg));
      END IF;
      RAISE;
  END;

  RETURN v_receipt || jsonb_build_object('accepted_lease_generation',
    (SELECT c.post_commit_payload #> '{accepted_hand_facts,horse_journal_identity,lease_generation}'
       FROM public.hand_atomic_commits c WHERE c.hand_id = v_hh AND c.table_id = p_host_table_id));
END
$function$;
