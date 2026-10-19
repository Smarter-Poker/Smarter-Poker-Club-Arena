-- A locked launch cohort and its atomic accepted-entry handoff.
-- Original full seat/funding/lease proofs remain authoritative. No seat or
-- balance is written by this migration. Legacy receipts retain strict proof.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='35s';

DO $pre$ BEGIN IF md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_begin_tournament_launch_before_lease_generation(uuid,uuid,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '97a2d8bf6fbf8e6b13bb620869f3e1e6' THEN RAISE EXCEPTION 'LAUNCH_COHORT_PREIMAGE_DRIFT: fn_begin_tournament_launch_before_lease_generation'; END IF; END $pre$;

DO $pre$ BEGIN IF md5((SELECT prosrc FROM pg_proc WHERE oid='public.trg_tournament_launch_receipt_is_immutable()'::regprocedure)) IS DISTINCT FROM '1d7c6bbe680abdb190fd418d4276016f' THEN RAISE EXCEPTION 'LAUNCH_COHORT_PREIMAGE_DRIFT: trg_tournament_launch_receipt_is_immutable'; END IF; END $pre$;

DO $pre$ BEGIN IF md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_complete_tournament_launch_before_lease_generation(uuid,uuid)'::regprocedure)) IS DISTINCT FROM '34524f5a0e0a7b8aed2f47cf69dfb1e7' THEN RAISE EXCEPTION 'LAUNCH_COHORT_PREIMAGE_DRIFT: fn_complete_tournament_launch_before_lease_generation'; END IF; END $pre$;

ALTER TABLE public.tournament_launch_receipts ADD COLUMN launch_player_ids uuid[];

CREATE OR REPLACE FUNCTION public.trg_tournament_launch_receipt_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tournament launch receipts cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
     OR NEW.launch_id IS DISTINCT FROM OLD.launch_id
     OR NEW.started_at IS DISTINCT FROM OLD.started_at
     OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
     OR NEW.launch_player_ids IS DISTINCT FROM OLD.launch_player_ids THEN
    RAISE EXCEPTION 'tournament launch receipt identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'completed tournament launch receipts are immutable'
      USING ERRCODE = '55000';
  END IF;

  /* Completion may set completed_at once, but cannot change its authority. */
  IF NEW.completed_at IS NOT NULL THEN
    IF NEW.lease_generation IS DISTINCT FROM OLD.lease_generation THEN
      RAISE EXCEPTION 'a tournament launch receipt generation cannot rotate during completion'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  /* Takeover adoption may rotate only the generation of an incomplete
     receipt, under the exact transaction-local marker set by begin. */
  IF NEW.lease_generation IS DISTINCT FROM OLD.lease_generation
     AND current_setting('app.atomic_tournament_launch_lease_adoption', true)
         = OLD.tournament_id::text || ':' || OLD.lease_generation::text || ':' || NEW.lease_generation::text THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'an incomplete tournament launch receipt may only rotate its lease generation during adoption'
    USING ERRCODE = '55000';
END;
$function$;
DO $post$ BEGIN IF md5((SELECT prosrc FROM pg_proc WHERE oid='public.trg_tournament_launch_receipt_is_immutable()'::regprocedure)) IS DISTINCT FROM '68b0147e67c004f60cfd34c7e0ac0f18' THEN RAISE EXCEPTION 'LAUNCH_COHORT_POSTIMAGE_DRIFT'; END IF; END $post$;

CREATE OR REPLACE FUNCTION public.fn_begin_tournament_launch_before_lease_generation(p_tournament_id uuid, p_launch_id uuid, p_started_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_existing public.tournament_launch_receipts%ROWTYPE;
  v_status text;
  v_tournament_started_at timestamptz;
  v_requested_started_at timestamptz := COALESCE(p_started_at, transaction_timestamp());
  v_cohort uuid[];
BEGIN
  IF public.fn_ca_launch_tournament_start_refused(p_tournament_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','operator_floor_parked');
  END IF;
  PERFORM pg_advisory_xact_lock_shared(530090, 1);

  IF p_tournament_id IS NULL OR p_launch_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_launch_request');
  END IF;

  SELECT * INTO v_existing
    FROM public.tournament_launch_receipts r
   WHERE r.tournament_id = p_tournament_id
   FOR UPDATE;
  IF FOUND THEN
    IF p_started_at IS NOT NULL
       AND v_existing.launch_id = p_launch_id
       AND v_existing.started_at IS DISTINCT FROM p_started_at THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'launch_request_mismatch');
    END IF;
    SELECT t.status, t.started_at INTO v_status, v_tournament_started_at
      FROM public.tournaments t
     WHERE t.id = p_tournament_id
     FOR UPDATE;
    IF NOT FOUND
       OR (v_existing.completed_at IS NULL AND v_status <> 'REGISTERING')
       OR (v_existing.completed_at IS NOT NULL
           AND (v_status <> 'RUNNING'
                OR v_tournament_started_at IS DISTINCT FROM v_existing.started_at)) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'launch_receipt_state_mismatch');
    END IF;
    RETURN jsonb_build_object(
      'ok', true,
      'claimed', true,
      'launch_id', v_existing.launch_id,
      'replay', true,
      'started_at', v_existing.started_at,
      'completed', v_existing.completed_at IS NOT NULL,
      'status', v_status,
      'launch_player_ids', to_jsonb(v_existing.launch_player_ids)
    );
  END IF;

  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'platform_frozen');
  END IF;

  SELECT t.status, t.started_at INTO v_status, v_tournament_started_at
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;
  IF v_status <> 'REGISTERING' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'launch_status_changed',
      'status', v_status
    );
  END IF;
  IF v_tournament_started_at IS NOT NULL
     AND v_tournament_started_at IS DISTINCT FROM v_requested_started_at THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_started_at_mismatch');
  END IF;

  INSERT INTO public.tournament_launch_receipts (
    tournament_id, launch_id, started_at, launch_player_ids
  ) VALUES (
    p_tournament_id, p_launch_id, v_requested_started_at,
    CASE WHEN public.fn_ca_tournament_recorded_format(p_tournament_id) IN ('mtt-v1','mtt-v2')
      THEN ARRAY(SELECT p.id FROM public.tournament_players p
        WHERE p.tournament_id=p_tournament_id AND p.status IN ('registered','playing')
        ORDER BY p.id)
      ELSE NULL END
  ) RETURNING launch_player_ids INTO v_cohort;

  RETURN jsonb_build_object(
    'ok', true,
    'claimed', true,
    'launch_id', p_launch_id,
    'replay', false,
    'started_at', v_requested_started_at,
    'completed', false,
    'launch_player_ids', to_jsonb(v_cohort)
  );
END;
$function$;
DO $post$ BEGIN IF md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_begin_tournament_launch_before_lease_generation(uuid,uuid,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM 'fa0a771ba327e690dd91c26351701a7a' THEN RAISE EXCEPTION 'LAUNCH_COHORT_POSTIMAGE_DRIFT'; END IF; END $post$;

CREATE OR REPLACE FUNCTION public.fn_complete_tournament_launch_before_lease_generation(p_tournament_id uuid, p_launch_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_receipt public.tournament_launch_receipts%ROWTYPE;
  v_status text;
  v_started_at timestamptz;
  v_completed_at timestamptz := transaction_timestamp();
  v_required_field integer;
  v_active_count bigint;
  v_bad_roster_count bigint;
  v_live_seat_count bigint;
  v_bad_live_seat_count bigint;
  v_distinct_live_users bigint;
  v_distinct_live_coordinates bigint;
  v_matching_roster_seats bigint;
  v_bad_table_count bigint;
  v_live_table_count bigint;
  v_is_paid_spin boolean;
  v_spin_multiplier numeric;
  v_spin_ledger_count bigint;
  v_spin_ledger_multiplier numeric;
  v_post_claim_pending uuid[] := ARRAY[]::uuid[];
  v_pending_wake_id bigint;
BEGIN
  SELECT * INTO v_receipt
    FROM public.tournament_launch_receipts r
   WHERE r.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND OR v_receipt.launch_id <> p_launch_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_receipt_mismatch');
  END IF;
  IF v_receipt.completed_at IS NOT NULL THEN
    SELECT t.status, t.started_at INTO v_status, v_started_at
      FROM public.tournaments t
     WHERE t.id = p_tournament_id;
    IF NOT FOUND OR v_status <> 'RUNNING'
       OR v_started_at IS DISTINCT FROM v_receipt.started_at THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'launch_receipt_state_mismatch');
    END IF;
    RETURN jsonb_build_object(
      'ok', true,
      'completed', true,
      'replay', true,
      'status', v_status,
      'started_at', v_started_at,
      'completed_at', v_receipt.completed_at
    );
  END IF;

  SELECT t.status,
         t.started_at,
         CASE WHEN t.format_contract='mtt-v1' THEN GREATEST(2,COALESCE(t.min_players,2))
              WHEN t.format_contract='mtt-v2' THEN GREATEST(3,COALESCE(t.min_players,3))
              WHEN COALESCE(t.max_players,0)>0 THEN GREATEST(2,LEAST(3,t.max_players))
              ELSE 3 END,
         ((lower(COALESCE(t.variant, '')) = 'spin'
           OR upper(COALESCE(t.tournament_type, '')) = 'SPIN')
          AND COALESCE(t.buy_in_amount, 0) > 0),
         t.spin_multiplier
    INTO v_status, v_started_at, v_required_field,
         v_is_paid_spin, v_spin_multiplier
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND OR v_status <> 'REGISTERING'
     OR (v_started_at IS NOT NULL AND v_started_at IS DISTINCT FROM v_receipt.started_at) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_receipt_state_mismatch');
  END IF;

  -- The begin transaction captured the launch cohort while holding this
  -- tournament row. A later accepted MTT entrant owns an ordinary late-entry
  -- seat; it must neither invalidate that cohort nor disappear from custody.
  -- NULL is a historical receipt: preserve its original strict full-roster
  -- proof rather than inventing which registrations belonged to it.
  IF v_receipt.launch_player_ids IS NOT NULL
     AND public.fn_ca_tournament_recorded_format(p_tournament_id) IN ('mtt-v1','mtt-v2')
     AND NOT EXISTS(SELECT 1 FROM public.hand_history h WHERE h.tournament_id=p_tournament_id) THEN
    SELECT COALESCE(array_agg(p.id ORDER BY p.id),ARRAY[]::uuid[])
      INTO v_post_claim_pending
      FROM public.tournament_players p
     WHERE p.tournament_id=p_tournament_id AND p.status='registered'
       AND NOT (p.id=ANY(v_receipt.launch_player_ids))
       AND p.user_id IS NOT NULL AND p.table_id IS NULL AND p.seat_number IS NULL
       AND COALESCE(p.chips,0)>=0 AND COALESCE(p.chips,0)::text NOT IN ('NaN','Infinity','-Infinity')
       AND NOT EXISTS(SELECT 1 FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
         WHERE tb.tournament_id=p_tournament_id AND s.user_id=p.user_id AND s.left_at IS NULL);
  END IF;

  /* Completion is the status transaction, so it owns the final database
     proof too. Every registration/admission path locks this tournament row:
     one that committed first is visible here and makes completion refuse;
     one waiting behind us observes RUNNING and rolls back. This removes the
     proof-to-complete race that no sequence of client reads can close. */
  SELECT count(*),
         count(*) FILTER (
           WHERE p.status <> 'playing'
              OR p.user_id IS NULL
              OR COALESCE(p.chips, 0) < 0
              OR p.table_id IS NULL
              OR p.seat_number IS NULL
              OR p.seat_number <= 0
         )
    INTO v_active_count, v_bad_roster_count
    FROM public.tournament_players p
   WHERE p.tournament_id = p_tournament_id
     AND p.status IN ('registered', 'playing')
     AND NOT (p.id=ANY(v_post_claim_pending));

  IF (SELECT COALESCE(sum(p2.chips), 0)
         FROM public.tournament_players p2
        WHERE p2.tournament_id = p_tournament_id
          AND p2.status IN ('registered', 'playing')
     AND NOT (p2.id=ANY(v_post_claim_pending)))
      < v_active_count * COALESCE(
          (SELECT t2.starting_chips FROM public.tournaments t2
            WHERE t2.id = p_tournament_id), 0)
     OR (SELECT COALESCE(sum(s2.stack), 0)
           FROM public.table_seats s2
           JOIN public.tables t3 ON t3.id = s2.table_id
          WHERE t3.tournament_id = p_tournament_id
            AND s2.left_at IS NULL)
        < v_active_count * COALESCE(
            (SELECT t2.starting_chips FROM public.tournaments t2
              WHERE t2.id = p_tournament_id), 0) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'launch_stacks_uncredited',
      'active_players', v_active_count
    );
  END IF;

  IF v_is_paid_spin AND v_active_count = 2
     AND COALESCE(
       (public.fn_prove_played_spin_launch_recovery(p_tournament_id)->>'ok')::boolean,
       false
     ) THEN
    v_required_field := 2;
  END IF;

  /* A GAME THAT WAS DEALT FINISHES WITH THE FIELD IT HAS (2026-09-11). The
     narrow escape above covers a paid spin with exactly two survivors. Forty
     games dealt on 2026-09-08 lost their engine before this commit and have
     been stuck in REGISTERING since, decided, winners unpaid, because the
     field they now hold can never satisfy a proof written for a field that has
     not played yet. fn_prove_played_launch_recovery generalises the same
     evidence: the pool is finalized, hands were dealt, THIS receipt's
     started_at is the moment of the first one, nobody is sitting in a pre-deal
     status, the field that was dealt met the requirement, and every survivor
     holds a live seat. A fresh under-filled game has no hand and is refused at
     the second check, so this can never open the door early. */
  IF v_active_count < v_required_field
     AND COALESCE(
       (public.fn_prove_played_launch_recovery(
          p_tournament_id, v_receipt.started_at)->>'ok')::boolean,
       false
     ) THEN
    v_required_field := v_active_count;
  END IF;

  IF v_active_count < v_required_field OR v_bad_roster_count <> 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'launch_roster_unproven',
      'active_players', v_active_count,
      'required_players', v_required_field,
      'invalid_players', v_bad_roster_count
    );
  END IF;

  SELECT count(*),
         count(*) FILTER (
           WHERE s.user_id IS NULL
              OR COALESCE(s.stack, 0) < 0
              OR s.seat_number IS NULL
              OR s.seat_number <= 0
              OR s.seat_number > COALESCE(t.max_players, 0)
         ),
         count(DISTINCT s.user_id),
         count(DISTINCT (s.table_id, s.seat_number))
    INTO v_live_seat_count, v_bad_live_seat_count,
         v_distinct_live_users, v_distinct_live_coordinates
    FROM public.table_seats s
    JOIN public.tables t ON t.id = s.table_id
   WHERE t.tournament_id = p_tournament_id
     AND s.left_at IS NULL;

  SELECT count(*) INTO v_matching_roster_seats
    FROM public.tournament_players p
    JOIN public.table_seats s
      ON s.user_id = p.user_id
     AND s.table_id = p.table_id
     AND s.seat_number = p.seat_number
     AND s.left_at IS NULL
    JOIN public.tables t
      ON t.id = s.table_id
     AND t.tournament_id = p_tournament_id
   WHERE p.tournament_id = p_tournament_id
     AND p.status IN ('registered', 'playing')
     AND NOT (p.id=ANY(v_post_claim_pending));

  IF v_live_seat_count <> v_active_count
     OR v_bad_live_seat_count <> 0
     OR v_distinct_live_users <> v_active_count
     OR v_distinct_live_coordinates <> v_active_count
     OR v_matching_roster_seats <> v_active_count THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'launch_seats_unproven',
      'active_players', v_active_count,
      'live_seats', v_live_seat_count,
      'matching_seats', v_matching_roster_seats
    );
  END IF;

  /* A CLOSED TABLE IS HISTORY, NOT A BROKEN ONE (2026-09-11). This scan had no
     status filter, so every table a multi-table event had already broken and
     closed - empty by definition, and 'closed' by definition - counted as an
     invalid table and refused the completion. A fresh launch has no closed
     table, so nothing about a first launch changes; what changes is that an
     event which has been playing and consolidating can complete a launch its
     engine never committed. Measured on "Breakfast Turbo" (2026-09-08): tables
     1, 2 and 4 closed with 58, 27 and 49 hands behind them, table 3 running
     with 2 seats and current_players 2, and the whole completion refused for
     the three that had done their job. The live table count is asserted
     separately below so an event whose tables are ALL closed cannot pass this
     vacuously; the seat proof above is independent of both. */
  SELECT count(*) FILTER (
           WHERE seats.table_id IS NULL
              OR t.status NOT IN ('running', 'waiting')
              OR t.current_players IS DISTINCT FROM seats.live_count
         ),
         count(*)
    INTO v_bad_table_count, v_live_table_count
    FROM public.tables t
    LEFT JOIN (
      SELECT s.table_id, count(*) AS live_count
        FROM public.table_seats s
       WHERE s.left_at IS NULL
       GROUP BY s.table_id
    ) seats ON seats.table_id = t.id
   WHERE t.tournament_id = p_tournament_id
     AND t.status <> 'closed';

  IF v_bad_table_count <> 0 OR v_live_table_count < 1 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'launch_tables_unproven',
      'invalid_tables', v_bad_table_count,
      'live_tables', v_live_table_count
    );
  END IF;

  IF v_is_paid_spin THEN
    -- DIAMOND PHASE 9: a Diamond Spin proves its draw by its own receipt, its
    -- ledger legs and the source's register rows, read into the same two
    -- variables the chip proof fills from its one jackpot_draw row.
    IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
      SELECT CASE WHEN COALESCE((d.proof->>'ok')::boolean, false) THEN 1 ELSE 0 END,
             (d.proof->>'multiplier')::numeric
        INTO v_spin_ledger_count, v_spin_ledger_multiplier
        FROM (SELECT public.fn_poker_diamond_spin_draw_proof(p_tournament_id, p_launch_id) AS proof) d;
    ELSE
    SELECT count(*), min(l.multiplier)
      INTO v_spin_ledger_count, v_spin_ledger_multiplier
      FROM public.spin_reserve_ledger l
     WHERE l.tournament_id = p_tournament_id
       AND l.kind = 'jackpot_draw';
    END IF;
    IF v_spin_ledger_count <> 1
       OR COALESCE(v_spin_multiplier, 0) <= 0
       OR v_spin_ledger_multiplier IS DISTINCT FROM v_spin_multiplier THEN
      RETURN jsonb_build_object(
        'ok', false,
        'reason', 'launch_spin_settlement_unproven',
        'draw_rows', v_spin_ledger_count
      );
    END IF;
  END IF;

  PERFORM set_config(
    'app.atomic_tournament_launch',
    p_tournament_id::text || ':' || p_launch_id::text,
    true
  );
  UPDATE public.tournaments
     SET status = 'RUNNING',
         started_at = v_receipt.started_at
   WHERE id = p_tournament_id
     AND status = 'REGISTERING';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament launch status changed inside its completion transaction'
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.tournament_launch_receipts
     SET completed_at = v_completed_at
   WHERE tournament_id = p_tournament_id
     AND launch_id = p_launch_id
     AND completed_at IS NULL;
  -- This is the existing causal late-registration owner, not a scan or a
  -- repair queue. Status, launch completion and the accepted-entry handoff
  -- commit together. A wake failure aborts all three; receipt replay returns
  -- above before any second emission. The normal accepted-entry path retains
  -- seat eligibility even after the entry clock closes.
  IF cardinality(v_post_claim_pending)>0 THEN
    v_pending_wake_id:=public.fn_emit_tournament_manager_wake(p_tournament_id,'late_registration');
    IF v_pending_wake_id IS NULL THEN
      RAISE EXCEPTION 'launch post-claim entry handoff was not retained' USING ERRCODE='55000';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'completed', true,
    'replay', false,
    'post_claim_pending_entries', cardinality(v_post_claim_pending),
    'post_claim_wake_id', v_pending_wake_id,
    'status', 'RUNNING',
    'started_at', v_receipt.started_at,
    'completed_at', v_completed_at
  );
END;
$function$;
DO $post$ BEGIN IF md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_complete_tournament_launch_before_lease_generation(uuid,uuid)'::regprocedure)) IS DISTINCT FROM '3c21b5a3a1c4bc3f5ad67b07fc9f4a29' THEN RAISE EXCEPTION 'LAUNCH_COHORT_POSTIMAGE_DRIFT'; END IF; END $post$;

-- Engine-only lifecycle authorities: no browser role may execute either.
-- The installed ACL is postgres only; restating that keeps it exact.
REVOKE ALL ON FUNCTION public.fn_begin_tournament_launch_before_lease_generation(uuid,uuid,timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_complete_tournament_launch_before_lease_generation(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
DO $metadata$ BEGIN IF (SELECT jsonb_build_object('owner',pg_get_userbyid(p.proowner),'security_definer',p.prosecdef,'settings',p.proconfig,'acl',p.proacl::text) FROM pg_proc p WHERE p.oid='public.fn_begin_tournament_launch_before_lease_generation(uuid,uuid,timestamp with time zone)'::regprocedure) IS DISTINCT FROM '{"owner":"postgres","security_definer":true,"settings":["search_path=public, pg_temp","statement_timeout=30s"],"acl":"{postgres=X/postgres}"}'::jsonb THEN RAISE EXCEPTION 'LAUNCH_COHORT_AUTHORITY_METADATA_DRIFT'; END IF; END $metadata$;
DO $metadata$ BEGIN IF (SELECT jsonb_build_object('owner',pg_get_userbyid(p.proowner),'security_definer',p.prosecdef,'settings',p.proconfig,'acl',p.proacl::text) FROM pg_proc p WHERE p.oid='public.fn_complete_tournament_launch_before_lease_generation(uuid,uuid)'::regprocedure) IS DISTINCT FROM '{"owner":"postgres","security_definer":true,"settings":["search_path=public, pg_temp"],"acl":"{postgres=X/postgres}"}'::jsonb THEN RAISE EXCEPTION 'LAUNCH_COHORT_AUTHORITY_METADATA_DRIFT'; END IF; END $metadata$;
DO $metadata$ BEGIN IF (SELECT jsonb_build_object('owner',pg_get_userbyid(p.proowner),'security_definer',p.prosecdef,'settings',p.proconfig,'acl',p.proacl::text) FROM pg_proc p WHERE p.oid='public.trg_tournament_launch_receipt_is_immutable()'::regprocedure) IS DISTINCT FROM '{"owner":"postgres","security_definer":false,"settings":["search_path=public, pg_temp"],"acl":"{postgres=X/postgres}"}'::jsonb THEN RAISE EXCEPTION 'LAUNCH_COHORT_AUTHORITY_METADATA_DRIFT'; END IF; END $metadata$;
COMMIT;
