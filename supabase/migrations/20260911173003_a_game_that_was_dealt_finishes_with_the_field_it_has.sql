-- ═══════════════════════════════════════════════════════════════════════════
--  A GAME THAT WAS DEALT FINISHES WITH THE FIELD IT HAS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Forty games dealt on 2026-09-08 between 12:49 and 14:53 UTC lost their engine
-- at the :53 break before the RUNNING commit. Three days later they are still
-- REGISTERING with started_at NULL, their tables running, their entrants
-- eliminated down to a survivor, and 2,164.60 chips of finalized prize pools
-- unpaid. Settlement starts from RUNNING, and REGISTERING to RUNNING belongs to
-- the atomic launch completion RPC (fn_refuse_new_entries_while_frozen refuses
-- anything else, correctly). So the only way to pay these winners is for that
-- RPC to be able to complete the launch their engine never committed.
--
-- It could not, for two reasons, both measured by running all 40 through the
-- sanctioned pair inside a transaction that was rolled back:
--
--   31 of 40  launch_roster_unproven. The roster proof is written for a field
--             that has not played yet: every entrant still 'playing', at least
--             GREATEST(2, LEAST(3, max_players)) of them. These fields have
--             since shrunk to their survivor, so the proof can never pass.
--    1 of 40  launch_tables_unproven. "Breakfast Turbo" broke and closed three
--             tables while it played (58, 27 and 49 hands behind them); the
--             table scan had no status filter, so a correctly closed table read
--             as an invalid one.
--
-- WHAT THIS CHANGES
--
-- 1. fn_prove_played_launch_recovery: the general form of the escape that
--    already exists for one narrow case. fn_prove_played_spin_launch_recovery
--    lets a PAID SPIN with exactly two survivors complete; this proves the same
--    idea for any game that can show what it dealt.
--
-- 2. fn_complete_tournament_launch_before_lease_generation: uses it to accept
--    the surviving field, and stops counting closed tables as broken ones.
--    Everything else in that function is byte-identical to what production ran
--    (pg_get_functiondef, md5 dce5d1ac72e862f3c30c9a9a73f56d18, read today).
--
-- WHY IT CANNOT OPEN A DOOR EARLY. The recovery requires, in order: a finalized
-- pool, at least one hand dealt, THIS receipt's started_at equal to the moment
-- of the first hand, no entrant in a pre-deal status, a dealt field that met
-- the requirement, and every survivor holding a live seat. A fresh game short
-- of its field has no hand and is refused at the second check. Measured against
-- the live board: 25 healthy REGISTERING rows, 0 accepted; a receipt naming the
-- wrong moment, refused; a NULL receipt moment, refused. And the completion's
-- own status gate still refuses anything not REGISTERING, so the 109 RUNNING
-- events on the board are not reachable by this path at all.
--
-- NOT A REPAIR JOB (CLAUDE.md 10.12). Nothing here pays anybody and nothing is
-- back-filled. It removes a refusal that was standing between forty decided
-- games and the platform's own settlement path; the engine finishes them, as it
-- finishes every other game, and the winners are paid by the terminal
-- settlement authority through its own idempotent path.
--
-- Probed first (CLAUDE.md 11.5): both bodies installed in pg_temp and all 40
-- games run through them inside one rolled-back transaction. 40 of 40 complete.
-- One transaction; apply once, outside :50-:03 UTC.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- A GAME THAT WAS DEALT PROVES ITSELF BY WHAT IT DEALT (2026-09-11).
--
-- fn_complete_tournament_launch_* proves the roster as it would be at a launch
-- that has not dealt yet: every entrant still 'playing', and at least
-- GREATEST(2, LEAST(3, max_players)) of them. Forty games dealt on 2026-09-08
-- lost their engine at the :53 break before the RUNNING commit and have sat in
-- REGISTERING since, decided, with their winners unpaid: 2,164.60 chips of
-- finalized pools. Their fields have shrunk to the survivor, so that proof can
-- never pass for them and they can never reach the settlement path, which
-- starts from RUNNING.
--
-- There is already an escape of exactly this shape for one narrow case - a
-- paid spin with exactly two active entrants, proved by
-- fn_prove_played_spin_launch_recovery. This is that idea, general: any game
-- that can show it dealt the field it was supposed to deal, and that every
-- entrant who is no longer playing was eliminated rather than never dealt in.
--
-- It refuses everything the narrow shape refuses and more. Read the checks in
-- order: the pool must be finalized, a hand must exist, THE RECEIPT'S
-- started_at must be the moment of the first hand (so a receipt minted for a
-- different launch cannot borrow another game's evidence), no entrant may be
-- sitting in a pre-deal status, the field that was dealt must meet the
-- requirement, and the survivors must each hold a live seat. A fresh
-- under-filled game has no hand and fails at the second check.
CREATE OR REPLACE FUNCTION public.fn_prove_played_launch_recovery(
  p_tournament_id uuid,
  p_started_at timestamptz
) RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_required int;
  v_finalized boolean;
  v_playing int;
  v_eliminated int;
  v_other int;
  v_hands bigint;
  v_first_hand timestamptz;
  v_seated int;
BEGIN
  SELECT CASE WHEN COALESCE(t.max_players, 0) > 0
              THEN GREATEST(2, LEAST(3, t.max_players))
              ELSE 3 END,
         COALESCE(t.prize_pool_finalized, false)
    INTO v_required, v_finalized
    FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF v_required IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;
  IF NOT v_finalized THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pool_not_finalized');
  END IF;

  SELECT count(*) FILTER (WHERE p.status = 'playing'),
         count(*) FILTER (WHERE p.status = 'eliminated'),
         count(*) FILTER (WHERE p.status NOT IN ('playing', 'eliminated'))
    INTO v_playing, v_eliminated, v_other
    FROM public.tournament_players p
   WHERE p.tournament_id = p_tournament_id;

  SELECT count(*), min(h.created_at)
    INTO v_hands, v_first_hand
    FROM public.hand_history h
    JOIN public.tables tb ON tb.id = h.table_id
   WHERE tb.tournament_id = p_tournament_id;

  IF COALESCE(v_hands, 0) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_hand_was_dealt');
  END IF;

  IF p_started_at IS NULL OR v_first_hand IS DISTINCT FROM p_started_at THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'the_receipt_is_not_the_deal_that_happened',
      'first_hand_at', v_first_hand,
      'receipt_started_at', p_started_at
    );
  END IF;

  IF v_other <> 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'an_entrant_was_never_dealt_in',
      'pre_deal_entrants', v_other
    );
  END IF;

  IF v_playing + v_eliminated < v_required THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'the_field_that_was_dealt_is_short',
      'dealt_field', v_playing + v_eliminated,
      'required_players', v_required
    );
  END IF;

  SELECT count(*)
    INTO v_seated
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id
     AND s.left_at IS NULL;

  IF v_playing < 1 OR v_seated <> v_playing THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'the_surviving_field_is_not_seated',
      'playing', v_playing,
      'live_seats', v_seated
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'hands_dealt', v_hands,
    'first_hand_at', v_first_hand,
    'dealt_field', v_playing + v_eliminated,
    'required_players', v_required,
    'playing', v_playing,
    'eliminated', v_eliminated
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_prove_played_launch_recovery(uuid, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

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
         CASE WHEN COALESCE(t.max_players, 0) > 0
              THEN GREATEST(2, LEAST(3, t.max_players))
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
     AND p.status IN ('registered', 'playing');

  IF (SELECT COALESCE(sum(p2.chips), 0)
         FROM public.tournament_players p2
        WHERE p2.tournament_id = p_tournament_id
          AND p2.status IN ('registered', 'playing'))
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
     AND p.status IN ('registered', 'playing');

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
    SELECT count(*), min(l.multiplier)
      INTO v_spin_ledger_count, v_spin_ledger_multiplier
      FROM public.spin_reserve_ledger l
     WHERE l.tournament_id = p_tournament_id
       AND l.kind = 'jackpot_draw';
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
      USING ERRCODE = '40001';
  END IF;

  UPDATE public.tournament_launch_receipts
     SET completed_at = v_completed_at
   WHERE tournament_id = p_tournament_id
     AND launch_id = p_launch_id
     AND completed_at IS NULL;
  RETURN jsonb_build_object(
    'ok', true,
    'completed', true,
    'replay', false,
    'status', 'RUNNING',
    'started_at', v_receipt.started_at,
    'completed_at', v_completed_at
  );
END;
$function$;

-- The grants, stated. Production holds no EXECUTE for anon, authenticated or
-- service_role on the completion core today; it is reachable only through
-- fn_complete_tournament_launch_atomic. CREATE FUNCTION grants PUBLIC EXECUTE
-- by default, so say it rather than inherit it.
REVOKE ALL ON FUNCTION public.fn_complete_tournament_launch_before_lease_generation(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

DO $check$
BEGIN
  IF has_function_privilege('anon',
       'public.fn_complete_tournament_launch_before_lease_generation(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_complete_tournament_launch_before_lease_generation(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.fn_prove_played_launch_recovery(uuid,timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_prove_played_launch_recovery(uuid,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a launch completion core became reachable from the client';
  END IF;
  IF (SELECT prosrc FROM pg_proc
       WHERE oid = 'public.fn_complete_tournament_launch_before_lease_generation(uuid,uuid)'::regprocedure)
     NOT LIKE '%fn_prove_played_launch_recovery%' THEN
    RAISE EXCEPTION 'the played-field recovery did not land in the completion';
  END IF;
  IF (SELECT prosrc FROM pg_proc
       WHERE oid = 'public.fn_complete_tournament_launch_before_lease_generation(uuid,uuid)'::regprocedure)
     NOT LIKE '%fn_prove_played_spin_launch_recovery%' THEN
    RAISE EXCEPTION 'the narrow spin recovery was lost';
  END IF;
  -- A game that never dealt is still refused, asked of the live board.
  IF EXISTS (
    SELECT 1 FROM public.tournaments t
     WHERE t.status = 'REGISTERING'
       AND NOT COALESCE(t.prize_pool_finalized, false)
       AND COALESCE((public.fn_prove_played_launch_recovery(t.id, now())->>'ok')::boolean, false)
  ) THEN
    RAISE EXCEPTION 'the played-field recovery accepted a game that has not played';
  END IF;
END
$check$;

COMMIT;
