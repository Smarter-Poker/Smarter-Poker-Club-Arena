-- 20260923165133_a_drawn_spin_with_no_launch_evidence_is_refundable
--
-- Oldest open row on the Production Alerts board (operational_alert_events
-- id=5, SpinUnfilledBacklog, received 2026-09-13, investigating since). 13
-- Spin tournaments drawn on 2026-09-08 (spin_multiplier stamped, exactly one
-- spin_reserve_ledger 'jackpot_draw' each, real chips already moved: draw
-- amounts -200,-100,-4,-40,-4,-2,-10,-40,-6,-20,-10,-6,-4) never launched:
-- zero tournament_launch_receipts rows (not even an in-flight, uncompleted
-- one), zero spin_draw_receipts, zero hand_history, status REGISTERING,
-- started_at NULL, 15 days later. 346 chips of member-club reserve and 39
-- chip legs across 3 players each (39 total) sit stranded.
--
-- Root cause #1: atomic_cancel_tournament's never-cancel-a-started-event
-- guard refuses ANY tournament with a stamped spin_multiplier or a
-- jackpot_draw row, unconditionally - it does not distinguish a Spin whose
-- launch is genuinely in flight from one whose launch never started at all.
-- docs/laws.d/a-spin-is-drawn-stamped-and-booked-by-the-launch-that-deals-
-- it.md (owner policy v2.9, 2026-09-22) already fixed the forward case: a
-- Spin's draw, reserve booking and row stamp now commit in the one launch
-- transaction, and that law's own repair jobs (spin_repair_missing_
-- multiplier, spin_sweep_unbooked) found nothing to repair as of 2026-09-22.
-- Verified live: of five OTHER Spins drawn in the same 2026-09-08 13:35-46
-- UTC window, five recovered on 2026-09-14 (5.4 days later) via the launch
-- lease itself - each carries a tournament_launch_receipts row with
-- started_at at draw time and claimed_at/completed_at on 2026-09-14. That is
-- a real, legitimate delayed-launch recovery and must never be interrupted.
-- The 13 stuck rows here carry NO tournament_launch_receipts row at all,
-- not even an incomplete one - no launch attempt was ever even started for
-- them, so there is no in-flight lease this migration could step on. That
-- absence, not elapsed time, is what distinguishes "dead reserve" from "a
-- launch still claiming its lease", so the guard is narrowed on exactly that
-- evidence: block on ANY tournament_launch_receipts row (not only a
-- completed one, which is what actually protects the 2026-09-14 case) and
-- drop the standalone spin_multiplier/jackpot_draw checks, which the law
-- above makes redundant with the launch-receipt check for every Spin drawn
-- under the current, fixed code.
--
-- Root cause #2, independently found live and independently corroborated by
-- docs/audits/2026-09-09-phase3-tournament-lifecycle.md ("all 22 [drawn
-- Spins examined] had the fixed embedded rake in fee_entries_in while their
-- advertised refund fee was zero. The generic fn_ca_tournament_refund_plan
-- therefore cannot serve as a Spin admission proof ... remains an open
-- T06/S11 finding for the cancellation review", 2026-09-09, never fixed):
-- fn_ca_tournament_refund_plan's escrow invariant compares
-- tournament_escrow.fee_entries_in against v_direct_fee, the sum of each
-- player's own refund_fee entitlement. A Spin itemizes the WHOLE buy-in as
-- prize (fn_tournament_entry_split sets refund_fee=0 for every Spin
-- wallet_charge entitlement) and pools its 8% rake separately at booking
-- (fn_spin_book_entry, source of the rake_records rows that fn_ca_
-- tournament_escrow_chips actually shadow-initialised fee_entries_in from).
-- So v_direct_fee is structurally always 0 for a Spin with a completed
-- booking while fee_entries_in is always > 0 - the assertion can never pass
-- for ANY spin tournament, independent of these 13 rows. Verified live for
-- all 13: fee_entries_in exactly equals sum(rake_records.rake_amount) where
-- source='fn_spin_book_entry' for that tournament (0.24=0.24, 24.00=24.00,
-- 0.48=0.48, ... all 13 exact to the cent). Fixed by comparing against that
-- pooled total for a Spin (mirroring fn_ca_tournament_escrow_chips's own
-- rr.fee_in-rr.fee_sat computation exactly) and leaving every non-spin
-- tournament on the original v_direct_fee comparison, byte-for-byte
-- unchanged.
--
-- Both fixes are necessary and neither alone unblocks these 13: root cause
-- #1 alone still trips root cause #2's assertion inside the per-player
-- refund loop; root cause #2 alone is still refused before ever reaching
-- that loop.
--
-- Money: 346.00 chips total prize pool across 13 tournaments, 39 wallet
-- entitlements (3 players x 13), each entitlement's gross equals exactly
-- what that player's wallet was charged (no fee split for a Spin buy-in) -
-- refunding entitlement.gross returns exactly and only what was paid in,
-- nothing invented, nothing withheld. Settled below through
-- atomic_cancel_tournament itself (the platform's own idempotent
-- cancellation/refund authority - fn_settle_tournament_refund_exact per
-- player, draw/contribution reversal through spin_reserve_ledger, rake
-- reversal, exact-zero escrow close, one immutable
-- tournament_cancellation_receipts row), not a hand-written wallet credit.
-- Read live immediately before writing this migration (2026-09-23); asserted
-- against those exact read numbers below so this aborts if the board moved
-- underneath it.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc
      WHERE oid='public.atomic_cancel_tournament(uuid,uuid)'::regprocedure
        AND md5(prosrc)='0aea21224182e48dc5a466e4592a09e4') THEN
    RAISE EXCEPTION 'atomic_cancel_tournament has drifted since this migration was written; re-diff before applying';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc
      WHERE oid='public.fn_ca_tournament_refund_plan(uuid,uuid)'::regprocedure
        AND md5(prosrc)='27cedb21bac278709f43f037a31403a0') THEN
    RAISE EXCEPTION 'fn_ca_tournament_refund_plan has drifted since this migration was written; re-diff before applying';
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.atomic_cancel_tournament(p_tournament_id uuid, p_admin_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_actor uuid := COALESCE(
    auth.uid(),p_admin_id,'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);
  v_t public.tournaments%ROWTYPE;
  v_stored public.tournament_cancellation_receipts%ROWTYPE;
  v_e public.tournament_escrow%ROWTYPE;
  v_player record;
  v_entitlement public.tournament_refund_entitlements%ROWTYPE;
  v_fee record;
  v_contribution public.spin_reserve_ledger%ROWTYPE;
  v_draw public.spin_reserve_ledger%ROWTYPE;
  v_pool public.spin_bonus_pools%ROWTYPE;
  v_settle jsonb;
  v_receipt jsonb;
  v_refunds jsonb := '[]'::jsonb;
  v_ticket_returns jsonb := '[]'::jsonb;
  v_source_player_ids uuid[] := ARRAY[]::uuid[];
  v_refunded_registration_ids uuid[] := ARRAY[]::uuid[];
  v_ticket_return_ids uuid[] := ARRAY[]::uuid[];
  v_zero_refund_registration_ids uuid[] := ARRAY[]::uuid[];
  v_closed_table_ids uuid[] := ARRAY[]::uuid[];
  v_source_seat_ids uuid[] := ARRAY[]::uuid[];
  v_released_seat_ids uuid[] := ARRAY[]::uuid[];
  v_fee_reversal_ids uuid[] := ARRAY[]::uuid[];
  v_registration_id uuid;
  v_fee_reversal_id uuid;
  v_original_entry_journal_id uuid;
  v_original_draw_journal_id uuid;
  v_draw_reversal_id uuid;
  v_draw_reversal_journal_id uuid;
  v_contribution_reversal_id uuid;
  v_contribution_reversal_journal_id uuid;
  v_spin_unwind_id uuid;
  v_source_player_count integer := 0;
  v_refunded_count integer := 0;
  v_refund_line_count integer := 0;
  v_ticket_return_count integer := 0;
  v_zero_refund_count integer := 0;
  v_closed_table_count integer := 0;
  v_source_seat_count integer := 0;
  v_released_seat_count integer := 0;
  v_total_refunded numeric := 0;
  v_total_ticket_returned numeric := 0;
  v_fees_reversed numeric := 0;
  v_total_rake_before numeric := 0;
  v_total_rake_after numeric := 0;
  v_total_owed numeric;
  v_draw_amount numeric := 0;
  v_pool_balance_before numeric;
  v_pool_balance_after numeric;
  v_rows integer;
  v_journal_count integer;
  v_cancelled_at timestamptz := transaction_timestamp();
  v_close_note constant text := 'atomic cancellation receipt: exact zero';
BEGIN
  -- Every terminal authority takes this lock before any row lock. Cancellation,
  -- satellite finish and cash finish can touch the same wallets and event rows.
  PERFORM public.fn_ca_lock_settlement_lane_global();
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'Tournament id is required' USING ERRCODE = '22004';
  END IF;

  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament not found' USING ERRCODE = 'P0002';
  END IF;
  -- DIAMOND PHASE 8: a Diamond event is cancelled by its own authority, which
  -- returns every entry from custody and writes the same immutable receipt;
  -- the chip rails below never saw a Diamond entry.
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RETURN public.fn_poker_diamond_tournament_cancel(p_tournament_id, p_admin_id);
  END IF;
  IF v_uid IS NOT NULL
     AND NOT public.fn_can_create_games(v_t.club_id,v_uid) THEN
    RAISE EXCEPTION 'Only the governed game operator may cancel a tournament'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_stored FROM public.tournament_cancellation_receipts h
   WHERE h.tournament_id=p_tournament_id FOR UPDATE;
  IF FOUND THEN
    RETURN public.fn_ca_tournament_cancellation_receipt(p_tournament_id,NULL);
  END IF;
  IF upper(COALESCE(v_t.status::text,'')) IN
       ('COMPLETED','CANCELLED','CANCELED','COMPLETING') THEN
    RAISE EXCEPTION 'Tournament is already %',v_t.status USING ERRCODE='55000';
  END IF;

  -- A tournament that has started is resumed or settled, never voided.
  -- start_time is a schedule/fill deadline; it is not proof that play began.
  -- The stored receipt above remains replayable without another cancellation.
  --
  -- A Spin's draw, reserve booking and row stamp commit in the one launch
  -- transaction (docs/laws.d/a-spin-is-drawn-stamped-and-booked-by-the-
  -- launch-that-deals-it.md, owner policy v2.9): a Spin drawn under that
  -- guarantee also carries a tournament_launch_receipts row from the same
  -- instant, so checking for that row - any row, not only a completed one,
  -- to protect a launch that is still claiming a stale lease days later -
  -- is strictly more precise than refusing every stamped multiplier or
  -- jackpot_draw outright. A Spin drawn with no launch_receipts row at all
  -- never had a launch attempt begin; it is dead reserve, not a Spin in play.
  IF v_t.started_at IS NOT NULL
     OR upper(COALESCE(v_t.status::text,'')) IN ('RUNNING','BREAK')
     OR EXISTS (SELECT 1 FROM public.tournament_launch_receipts r
                 WHERE r.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.spin_draw_receipts r
                 WHERE r.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.hand_history hh
                 WHERE hh.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tables tb
                 JOIN public.hand_history hh ON hh.table_id=tb.id
                 WHERE tb.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id=p_tournament_id
                   AND o.kind<>'refund' AND o.amount_paid>0) THEN
    RAISE EXCEPTION
      'Tournament has started or committed awards; resume or settle it instead of cancelling'
      USING ERRCODE='55000';
  END IF;

  PERFORM public.fn_lock_accounting_tournament_recognition_week(p_tournament_id,transaction_timestamp());

  -- Freeze every identity before any payer runs. Any concurrent registration,
  -- seat move or hand settlement either committed before these locks and is in
  -- the receipt, or waits behind this transaction and sees a terminal parent.
  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
   ORDER BY tp.user_id,tp.id FOR UPDATE;
  PERFORM 1 FROM public.tables tb
   WHERE tb.tournament_id=p_tournament_id ORDER BY tb.id FOR UPDATE;
  PERFORM 1 FROM public.table_seats s
   JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
   ORDER BY s.table_id,s.id FOR UPDATE OF s;
  SELECT COALESCE(array_agg(tp.id ORDER BY tp.id),ARRAY[]::uuid[])
    INTO v_source_player_ids FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id;
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id),ARRAY[]::uuid[])
    INTO v_closed_table_ids FROM public.tables tb
   WHERE tb.tournament_id=p_tournament_id;
  SELECT COALESCE(array_agg(s.id ORDER BY s.table_id,s.id),ARRAY[]::uuid[])
    INTO v_source_seat_ids FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id;
  v_source_player_count := cardinality(v_source_player_ids);
  v_closed_table_count := cardinality(v_closed_table_ids);
  v_source_seat_count := cardinality(v_source_seat_ids);

  PERFORM public.fn_ca_escrow_apply(
    p_tournament_id,'atomic cancellation escrow prelock');
  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id FOR UPDATE;
  IF v_e.tournament_id IS NULL OR v_e.enforced IS DISTINCT FROM true
     OR v_t.prize_pool IS DISTINCT FROM v_e.prize_balance
     OR v_t.bounty_pool IS DISTINCT FROM v_e.bounty_balance
     OR v_t.total_rake IS DISTINCT FROM v_e.fee_balance THEN
    RAISE EXCEPTION 'tournament % caches do not equal exact escrow before cancellation',
      p_tournament_id USING ERRCODE='P0404';
  END IF;

  -- A booked Spin first gives back its draw, then withdraws this event's own
  -- contribution. Each pool movement creates its strict journal before the
  -- matching immutable reversal row and all four ids are stored together.
  PERFORM 1 FROM public.spin_reserve_ledger r
   WHERE r.tournament_id=p_tournament_id ORDER BY r.created_at,r.id FOR UPDATE;
  SELECT * INTO v_contribution FROM public.spin_reserve_ledger r
   WHERE r.tournament_id=p_tournament_id AND r.kind='contribution';
  IF FOUND THEN
    IF (SELECT count(*) FROM public.spin_reserve_ledger r
         WHERE r.tournament_id=p_tournament_id AND r.kind='contribution') <> 1
       OR EXISTS (SELECT 1 FROM public.spin_reserve_ledger r
                   WHERE r.tournament_id=p_tournament_id
                     AND r.kind IN ('draw_reversal','contribution_reversal'))
       OR EXISTS (SELECT 1 FROM public.tournament_spin_cancellation_unwinds u
                   WHERE u.tournament_id=p_tournament_id) THEN
      RAISE EXCEPTION 'Spin % has an ambiguous or partially unwound reserve contract',
        p_tournament_id USING ERRCODE='P0404';
    END IF;
    SELECT * INTO v_draw FROM public.spin_reserve_ledger r
     WHERE r.tournament_id=p_tournament_id AND r.kind='jackpot_draw';
    IF FOUND AND (SELECT count(*) FROM public.spin_reserve_ledger r
                   WHERE r.tournament_id=p_tournament_id
                     AND r.kind='jackpot_draw') <> 1 THEN
      RAISE EXCEPTION 'Spin % has more than one immutable draw',p_tournament_id
        USING ERRCODE='P0404';
    END IF;
    SELECT * INTO v_pool FROM public.spin_bonus_pools p
     WHERE p.club_id=v_contribution.club_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Spin % original reserve owner is missing',p_tournament_id
        USING ERRCODE='P0404';
    END IF;
    v_pool_balance_before := v_pool.balance;
    IF v_pool_balance_before IS NULL
       OR v_pool_balance_before::text IN ('NaN','Infinity','-Infinity')
       OR v_pool_balance_before<0 THEN
      RAISE EXCEPTION 'Spin % reserve balance is invalid',p_tournament_id
        USING ERRCODE='22003';
    END IF;
    SELECT count(*),(array_agg(l.id ORDER BY l.created_at,l.id))[1]
      INTO v_journal_count,v_original_entry_journal_id
      FROM public.chip_ledger l
     WHERE l.tournament_id=p_tournament_id
       AND l.category='spin_entry'
       AND l.from_type='prize_liability'
       AND l.from_entity_id=p_tournament_id
       AND l.to_type='spin_reserve' AND l.to_entity_id=v_pool.id
       AND l.amount=v_contribution.amount;
    IF v_journal_count<>1 OR v_contribution.amount<=0 THEN
      RAISE EXCEPTION 'Spin % contribution has no single exact journal',p_tournament_id
        USING ERRCODE='P0404';
    END IF;

    IF v_draw.id IS NOT NULL THEN
      IF v_draw.club_id IS DISTINCT FROM v_contribution.club_id
         OR v_draw.amount>=0 THEN
        RAISE EXCEPTION 'Spin % draw disagrees with its contribution owner',p_tournament_id
          USING ERRCODE='P0404';
      END IF;
      v_draw_amount := round(-v_draw.amount,2);
      SELECT count(*),(array_agg(l.id ORDER BY l.created_at,l.id))[1]
        INTO v_journal_count,v_original_draw_journal_id
        FROM public.chip_ledger l
       WHERE l.tournament_id=p_tournament_id
         AND l.category='spin_prize'
         AND l.from_type='spin_reserve' AND l.from_entity_id=v_pool.id
         AND l.to_type='prize_liability' AND l.to_entity_id=p_tournament_id
         AND l.amount=v_draw_amount;
      IF v_journal_count<>1 THEN
        RAISE EXCEPTION 'Spin % draw has no single exact journal',p_tournament_id
          USING ERRCODE='P0404';
      END IF;
      PERFORM public.fn_ca_declare_ledger(
        'reversal','prize_liability',p_tournament_id,NULL,
        'spin:'||p_tournament_id::text||':cancel:draw',NULL);
      UPDATE public.spin_bonus_pools
         SET balance=balance+v_draw_amount,updated_at=now()
       WHERE id=v_pool.id RETURNING balance INTO v_pool_balance_after;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Spin % reserve vanished during draw reversal',p_tournament_id
          USING ERRCODE='40001';
      END IF;
      INSERT INTO public.spin_reserve_ledger
        (club_id,tournament_id,kind,amount,balance_after,multiplier,
         buy_in,seats,house_rake,note)
      VALUES
        (v_draw.club_id,p_tournament_id,'draw_reversal',v_draw_amount,
         v_pool_balance_after,v_draw.multiplier,v_draw.buy_in,v_draw.seats,
         v_draw.house_rake,'atomic cancellation reversed the exact reserve draw')
      RETURNING id INTO v_draw_reversal_id;
      SELECT count(*),(array_agg(l.id ORDER BY l.created_at,l.id))[1]
        INTO v_journal_count,v_draw_reversal_journal_id
        FROM public.chip_ledger l
       WHERE l.idempotency_key='spin:'||p_tournament_id::text||':cancel:draw'
         AND l.tournament_id=p_tournament_id AND l.category='reversal'
         AND l.from_type='prize_liability' AND l.from_entity_id=p_tournament_id
         AND l.to_type='spin_reserve' AND l.to_entity_id=v_pool.id
         AND l.amount=v_draw_amount;
      IF v_journal_count<>1 THEN
        RAISE EXCEPTION 'Spin % draw reversal has no single exact journal',p_tournament_id
          USING ERRCODE='P0404';
      END IF;
    ELSE
      v_pool_balance_after := v_pool_balance_before;
    END IF;

    IF v_pool_balance_after<v_contribution.amount THEN
      RAISE EXCEPTION 'Spin % reserve cannot return its own contribution',p_tournament_id
        USING ERRCODE='P0403';
    END IF;
    PERFORM public.fn_ca_declare_ledger(
      'reversal','prize_liability',p_tournament_id,NULL,
      'spin:'||p_tournament_id::text||':cancel:entry',NULL);
    UPDATE public.spin_bonus_pools
       SET balance=balance-v_contribution.amount,updated_at=now()
     WHERE id=v_pool.id RETURNING balance INTO v_pool_balance_after;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Spin % reserve vanished during contribution reversal',p_tournament_id
        USING ERRCODE='40001';
    END IF;
    INSERT INTO public.spin_reserve_ledger
      (club_id,tournament_id,kind,amount,balance_after,multiplier,
       buy_in,seats,house_rake,note)
    VALUES
      (v_contribution.club_id,p_tournament_id,'contribution_reversal',
       -v_contribution.amount,v_pool_balance_after,v_contribution.multiplier,
       v_contribution.buy_in,v_contribution.seats,v_contribution.house_rake,
       'atomic cancellation returned the exact entry contribution')
    RETURNING id INTO v_contribution_reversal_id;
    SELECT count(*),(array_agg(l.id ORDER BY l.created_at,l.id))[1]
      INTO v_journal_count,v_contribution_reversal_journal_id
      FROM public.chip_ledger l
     WHERE l.idempotency_key='spin:'||p_tournament_id::text||':cancel:entry'
       AND l.tournament_id=p_tournament_id AND l.category='reversal'
       AND l.from_type='spin_reserve' AND l.from_entity_id=v_pool.id
       AND l.to_type='prize_liability' AND l.to_entity_id=p_tournament_id
       AND l.amount=v_contribution.amount;
    IF v_journal_count<>1 THEN
      RAISE EXCEPTION 'Spin % contribution reversal has no single exact journal',
        p_tournament_id USING ERRCODE='P0404';
    END IF;
    INSERT INTO public.tournament_spin_cancellation_unwinds(
      tournament_id,pool_id,reserve_owner_id,
      original_contribution_id,original_draw_id,
      original_entry_journal_id,original_draw_journal_id,
      draw_reversal_id,draw_reversal_journal_id,
      contribution_reversal_id,contribution_reversal_journal_id,
      contribution_amount,draw_amount,pool_balance_before,pool_balance_after,
      settled_at)
    VALUES(
      p_tournament_id,v_pool.id,v_contribution.club_id,
      v_contribution.id,v_draw.id,
      v_original_entry_journal_id,v_original_draw_journal_id,
      v_draw_reversal_id,v_draw_reversal_journal_id,
      v_contribution_reversal_id,v_contribution_reversal_journal_id,
      v_contribution.amount,v_draw_amount,v_pool_balance_before,
      v_pool_balance_after,v_cancelled_at)
    RETURNING tournament_id INTO v_spin_unwind_id;
  ELSIF EXISTS (
    SELECT 1 FROM public.spin_reserve_ledger r
     WHERE r.tournament_id=p_tournament_id
       AND r.kind IN ('jackpot_draw','draw_reversal','contribution_reversal')) THEN
    RAISE EXCEPTION 'Spin % has reserve evidence without its contribution',p_tournament_id
      USING ERRCODE='P0404';
  END IF;

  -- Return each unconsumed funded entitlement as cash to its recorded club.
  -- The exact refund payer proves wallet, satellite transfer or redeemed-ticket
  -- funding and excludes value already returned as a ticket. Stored historical
  -- cancellation receipts continue to replay through their original evidence.
  IF EXISTS (
    SELECT 1 FROM public.tournament_refund_entitlements e
    JOIN public.tournament_players tp ON tp.id=e.registration_id
    JOIN public.tournament_tickets tk
      ON tk.source_refund_entitlement_id=e.id
   WHERE e.tournament_id=p_tournament_id
     AND tp.tournament_id=p_tournament_id) THEN
    RAISE EXCEPTION 'active qualifier roster already has an unreceipted return ticket'
      USING ERRCODE='P0404';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_refund_entitlements e
    LEFT JOIN public.tournament_players tp
      ON tp.tournament_id=e.tournament_id AND tp.user_id=e.user_id
   WHERE e.tournament_id=p_tournament_id
     AND (tp.id IS NULL OR (e.entitlement_kind IN (
            'satellite_seat','tournament_ticket')
          AND e.registration_id IS DISTINCT FROM tp.id))) THEN
    RAISE EXCEPTION 'refund entitlement is detached from the frozen roster'
      USING ERRCODE='P0404';
  END IF;
  FOR v_player IN
    SELECT DISTINCT ON (tp.user_id) tp.id,tp.user_id
      FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id AND tp.user_id IS NOT NULL
     ORDER BY tp.user_id,tp.id
  LOOP
    -- The owner-only plan validates every source ledger, wallet debit and
    -- escrow rail. Identity comes from the locked entitlement table below.
    PERFORM 1 FROM public.fn_ca_tournament_refund_plan(
      p_tournament_id,v_player.user_id);
    LOOP
      SELECT e.* INTO v_entitlement
        FROM public.tournament_refund_entitlements e
       WHERE e.tournament_id=p_tournament_id
         AND e.user_id=v_player.user_id
         AND NOT EXISTS (
           SELECT 1 FROM public.tournament_refund_tranches tr
            WHERE tr.entitlement_id=e.id)
         AND NOT EXISTS (
           SELECT 1 FROM public.tournament_tickets tk
            WHERE tk.source_refund_entitlement_id=e.id)
       ORDER BY e.entitlement_kind,e.id
       LIMIT 1 FOR UPDATE OF e;
      EXIT WHEN NOT FOUND;
      v_registration_id:=COALESCE(v_entitlement.registration_id,v_player.id);
      IF v_entitlement.entitlement_kind IN (
          'wallet_charge','satellite_seat','tournament_ticket') THEN
        SELECT COALESCE(o.amount_paid,0)+v_entitlement.gross
          INTO v_total_owed FROM public.tournament_obligations o
         WHERE o.tournament_id=p_tournament_id AND o.kind='refund'
           AND o.place IS NULL AND o.user_id=v_player.user_id FOR UPDATE;
        IF NOT FOUND THEN v_total_owed:=v_entitlement.gross; END IF;
        v_settle:=public.fn_settle_tournament_refund_exact(
          p_tournament_id,v_player.user_id,
          v_entitlement.refund_wallet_club_id,v_total_owed,
          v_entitlement.refund_prize,v_entitlement.refund_bounty,
          v_entitlement.refund_fee,'atomic_cancel_tournament',
          'Tournament cancellation refund: '||COALESCE(v_t.name,'Unknown'));
        IF COALESCE((v_settle->>'ok')::boolean,false) IS NOT TRUE
           OR COALESCE((v_settle->>'fully_settled')::boolean,false) IS NOT TRUE
           OR COALESCE((v_settle->>'remaining')::numeric,-1)<>0
           OR (v_settle->>'entitlement_id')::uuid
                IS DISTINCT FROM v_entitlement.id
           OR v_settle->>'entitlement_kind' IS DISTINCT FROM v_entitlement.entitlement_kind
           OR (v_settle->>'paid')::numeric IS DISTINCT FROM v_entitlement.gross
           OR (v_settle->>'refund_prize')::numeric
                IS DISTINCT FROM v_entitlement.refund_prize
           OR (v_settle->>'refund_bounty')::numeric
                IS DISTINCT FROM v_entitlement.refund_bounty
           OR (v_settle->>'refund_fee')::numeric
                IS DISTINCT FROM v_entitlement.refund_fee THEN
          RAISE EXCEPTION 'exact cancellation refund refused entitlement %: %',
            v_entitlement.id,v_settle USING ERRCODE='55000';
        END IF;
        v_refunds:=v_refunds||jsonb_build_array(jsonb_build_object(
          'registration_id',v_registration_id,
          'user_id',v_player.user_id,
          'entitlement_id',v_entitlement.id,
          'entitlement_kind',v_entitlement.entitlement_kind,
          'source_wallet_club_id',v_entitlement.refund_wallet_club_id,
          'gross_paid',v_entitlement.gross,
          'amount_paid_before',(v_settle->>'already_paid')::numeric,
          'amount_paid_now',(v_settle->>'paid')::numeric,
          'refund_prize',(v_settle->>'refund_prize')::numeric,
          'refund_bounty',(v_settle->>'refund_bounty')::numeric,
          'refund_fee',(v_settle->>'refund_fee')::numeric,
          'obligation_id',(v_settle->>'obligation_id')::uuid,
          'idempotency_key',v_settle->>'idempotency_key',
          'credit_ledger_id',(v_settle->>'credit_ledger_id')::uuid,
          'wallet_transaction_id',(v_settle->>'wallet_transaction_id')::uuid));
        v_refund_line_count:=v_refund_line_count+1;
        v_total_refunded:=round(
          v_total_refunded+(v_settle->>'paid')::numeric,2);
      ELSE
        RAISE EXCEPTION 'unknown cancellation entitlement kind %',
          v_entitlement.entitlement_kind USING ERRCODE='P0404';
      END IF;
      IF NOT v_registration_id=ANY(v_refunded_registration_ids) THEN
        v_refunded_registration_ids:=array_append(
          v_refunded_registration_ids,v_registration_id);
      END IF;
    END LOOP;
  END LOOP;
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_refunded_registration_ids
    FROM unnest(v_refunded_registration_ids) ids(id);
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_zero_refund_registration_ids
    FROM unnest(v_source_player_ids) ids(id)
   WHERE NOT id=ANY(v_refunded_registration_ids);
  v_refunded_count:=cardinality(v_refunded_registration_ids);
  v_zero_refund_count:=cardinality(v_zero_refund_registration_ids);

  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id AND tp.user_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.fn_ca_tournament_refund_plan(
                    p_tournament_id,tp.user_id))) THEN
    RAISE EXCEPTION 'cancellation left a refundable entitlement unpaid'
      USING ERRCODE='55000';
  END IF;

  -- Rake reversal is attribution only: the exact refund payer already returned
  -- the fee component from escrow. Reverse each current player's net fee and
  -- each aggregate Spin source exactly once, retaining immutable source ids.
  IF EXISTS (SELECT 1 FROM public.rake_records r
              WHERE r.tournament_id=p_tournament_id
                AND r.source='atomic_cancel_tournament') THEN
    RAISE EXCEPTION 'unreceipted cancellation rake evidence already exists'
      USING ERRCODE='P0404';
  END IF;
  SELECT round(COALESCE(sum(r.rake_amount),0),2)
    INTO v_total_rake_before FROM public.rake_records r
   WHERE r.tournament_id=p_tournament_id AND r.is_tournament;
  IF v_total_rake_before<0
     OR v_total_rake_before::text IN ('NaN','Infinity','-Infinity')
     OR round(COALESCE(v_t.total_rake,0),2) IS DISTINCT FROM v_total_rake_before THEN
    RAISE EXCEPTION 'tournament % rake cache and evidence disagree',p_tournament_id
      USING ERRCODE='P0404';
  END IF;

  FOR v_fee IN
    SELECT tp.user_id,r.club_id,
           round(sum(r.rake_amount),2) AS amount,
           jsonb_agg(r.id ORDER BY r.id) AS source_ids
      FROM (SELECT DISTINCT p.user_id FROM public.tournament_players p
             WHERE p.tournament_id=p_tournament_id AND p.user_id IS NOT NULL) tp
      JOIN public.rake_records r
        ON r.tournament_id=p_tournament_id AND r.is_tournament
       AND r.metadata->>'user_id'=tp.user_id::text
     GROUP BY tp.user_id,r.club_id HAVING round(sum(r.rake_amount),2)>0
     ORDER BY tp.user_id,r.club_id
  LOOP
    INSERT INTO public.rake_records(
      hand_id,table_id,club_id,rake_amount,pot_size,num_players,
      bbj_contribution,is_tournament,tournament_id,source,metadata)
    VALUES(NULL,NULL,v_fee.club_id,-v_fee.amount,v_fee.amount,1,0,true,
      p_tournament_id,'atomic_cancel_tournament',jsonb_build_object(
        'kind','tournament_fee_refund','user_id',v_fee.user_id,
        'original_rake_record_ids',v_fee.source_ids))
    RETURNING id INTO v_fee_reversal_id;
    v_fee_reversal_ids:=array_append(v_fee_reversal_ids,v_fee_reversal_id);
    v_fees_reversed:=round(v_fees_reversed+v_fee.amount,2);
  END LOOP;
  FOR v_fee IN
    SELECT r.*,round(r.rake_amount+COALESCE((SELECT sum(rr.rake_amount)
      FROM public.rake_records rr WHERE rr.tournament_id=p_tournament_id
       AND rr.source='atomic_cancel_tournament'
       AND rr.metadata->>'original_rake_record_id'=r.id::text),0),2) AS amount
      FROM public.rake_records r
     WHERE r.tournament_id=p_tournament_id AND r.is_tournament
       AND r.source IN ('fn_spin_book_entry','fn_spin_settle_game')
       AND r.rake_amount>0 AND NULLIF(r.metadata->>'user_id','') IS NULL
     ORDER BY r.id FOR UPDATE
  LOOP
    IF v_fee.amount>0 THEN
      INSERT INTO public.rake_records(
        hand_id,table_id,club_id,rake_amount,pot_size,num_players,
        bbj_contribution,is_tournament,tournament_id,source,
        player_contributions,metadata)
      VALUES(NULL,NULL,v_fee.club_id,-v_fee.amount,v_fee.pot_size,
        v_fee.num_players,0,true,p_tournament_id,'atomic_cancel_tournament',
        v_fee.player_contributions,jsonb_build_object(
          'kind','spin_rake_refund','original_source',v_fee.source,
          'original_rake_record_id',v_fee.id))
      RETURNING id INTO v_fee_reversal_id;
      v_fee_reversal_ids:=array_append(v_fee_reversal_ids,v_fee_reversal_id);
      v_fees_reversed:=round(v_fees_reversed+v_fee.amount,2);
    END IF;
  END LOOP;
  SELECT round(COALESCE(sum(r.rake_amount),0),2)
    INTO v_total_rake_after FROM public.rake_records r
   WHERE r.tournament_id=p_tournament_id AND r.is_tournament;
  IF v_total_rake_after IS DISTINCT FROM 0::numeric
     OR v_fees_reversed IS DISTINCT FROM v_total_rake_before THEN
    RAISE EXCEPTION 'tournament % fee reversal did not close exactly',p_tournament_id
      USING ERRCODE='P0404';
  END IF;

  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id FOR UPDATE;
  IF v_e.tournament_id IS NULL OR v_e.enforced IS DISTINCT FROM true
     OR v_e.prize_balance IS DISTINCT FROM 0::numeric
     OR v_e.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_e.fee_balance IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION 'tournament % cancellation did not close all escrow banks',
      p_tournament_id USING ERRCODE='P0404';
  END IF;
  UPDATE public.tournament_escrow
     SET closed_at=v_cancelled_at,close_note=v_close_note,updated_at=now()
   WHERE tournament_id=p_tournament_id AND closed_at IS NULL
     AND prize_balance=0 AND bounty_balance=0 AND fee_balance=0;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'tournament % lost its exact-zero escrow close',p_tournament_id
      USING ERRCODE='40001';
  END IF;

  UPDATE public.tournament_players
     SET status='eliminated',eliminated_at=v_cancelled_at,
         chips=0,current_bounty=0
   WHERE tournament_id=p_tournament_id;
  WITH released AS (
    UPDATE public.table_seats s
       SET left_at=v_cancelled_at,status='left',leave_pending=false,
           is_sitting_out=false,is_away=false,sit_out_at=NULL,
           scheduled_leave_hands=NULL
      FROM public.tables tb
     WHERE tb.id=s.table_id AND tb.tournament_id=p_tournament_id
       AND s.left_at IS NULL RETURNING s.id)
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_released_seat_ids FROM released;
  v_released_seat_count:=cardinality(v_released_seat_ids);
  UPDATE public.table_seats s
     SET status='left',leave_pending=false,is_sitting_out=false,is_away=false,
         sit_out_at=NULL,scheduled_leave_hands=NULL
   WHERE s.id=ANY(v_source_seat_ids) AND s.left_at IS NOT NULL;

  UPDATE public.tournaments
     SET status='CANCELLED',ended_at=v_cancelled_at,updated_at=now(),
         prize_pool=0,bounty_pool=0,total_rake=0,current_players=0,
         on_break=false,break_started_at=NULL,break_ends_at=NULL
   WHERE id=p_tournament_id
     AND upper(COALESCE(status::text,'')) NOT IN
         ('COMPLETED','CANCELLED','CANCELED','COMPLETING');
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'tournament % lost its cancellation lifecycle claim',
      p_tournament_id USING ERRCODE='40001';
  END IF;
  UPDATE public.tables
     SET status='closed',lifecycle='closed',current_players=0,
         terminal_closed_at=v_cancelled_at,updated_at=now()
   WHERE tournament_id=p_tournament_id;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>v_closed_table_count THEN
    RAISE EXCEPTION 'tournament % did not close every table',p_tournament_id
      USING ERRCODE='40001';
  END IF;

  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_fee_reversal_ids FROM unnest(v_fee_reversal_ids) ids(id);
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_ticket_return_ids FROM unnest(v_ticket_return_ids) ids(id);
  v_receipt:=jsonb_build_object(
    'ok',true,'success',true,'fully_settled',true,'receipt_version',2,
    'tournament_id',p_tournament_id,'actor_id',v_actor,'status','CANCELLED',
    'source_player_count',v_source_player_count,
    'refunded_count',v_refunded_count,'refund_line_count',v_refund_line_count,
    'ticket_return_count',v_ticket_return_count,
    'total_ticket_returned',v_total_ticket_returned,
    'total_refunded',v_total_refunded,'fees_reversed',v_fees_reversed,
    'closed_table_count',v_closed_table_count,
    'source_seat_count',v_source_seat_count,
    'released_seat_count',v_released_seat_count,
    'refunds',v_refunds,'ticket_returns',v_ticket_returns,
    'settled_at',v_cancelled_at);
  INSERT INTO public.tournament_cancellation_receipts(
    tournament_id,actor_id,receipt_version,
    source_player_count,source_player_ids,
    refunded_count,refunded_registration_ids,refund_line_count,
    ticket_return_count,ticket_return_ids,total_ticket_returned,
    zero_refund_count,zero_refund_registration_ids,
    total_refunded,fees_reversed,total_rake_before,total_rake_after,
    closed_table_count,closed_table_ids,source_seat_count,source_seat_ids,
    released_seat_count,released_seat_ids,fee_reversal_ids,
    escrow_closed_at,escrow_close_note,spin_unwind_tournament_id,
    receipt,settled_at)
  VALUES(
    p_tournament_id,v_actor,2,
    v_source_player_count,v_source_player_ids,
    v_refunded_count,v_refunded_registration_ids,v_refund_line_count,
    v_ticket_return_count,v_ticket_return_ids,v_total_ticket_returned,
    v_zero_refund_count,v_zero_refund_registration_ids,
    v_total_refunded,v_fees_reversed,v_total_rake_before,v_total_rake_after,
    v_closed_table_count,v_closed_table_ids,v_source_seat_count,v_source_seat_ids,
    v_released_seat_count,v_released_seat_ids,v_fee_reversal_ids,
    v_cancelled_at,v_close_note,v_spin_unwind_id,v_receipt,v_cancelled_at);

  PERFORM public.fn_record_accounting_tournament_cancellation(p_tournament_id);
  RETURN public.fn_ca_tournament_cancellation_receipt(p_tournament_id,v_actor);
END;
$function$;

-- Same ACL-preservation gap as fn_ca_tournament_refund_plan below: a replace
-- keeps the live grant, but the gate reads only this file. Every prior
-- migration that touched atomic_cancel_tournament restated this same pair
-- (20260902050100 through 20260910171843) - doing the same here, not a
-- change of policy.
REVOKE ALL ON FUNCTION public.atomic_cancel_tournament(uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_cancel_tournament(uuid,uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_refund_plan(p_tournament_id uuid, p_user_id uuid)
 RETURNS TABLE(source_wallet_club_id uuid, gross_remaining numeric, prize_remaining numeric, bounty_remaining numeric, fee_remaining numeric, debit_count bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_escrow public.tournament_escrow%ROWTYPE;
  v_wallet_count bigint;
  v_wallet_total numeric;
  v_charge_count bigint;
  v_charge_total numeric;
  v_refund_count bigint;
  v_refund_total numeric;
  v_tranche_count bigint;
  v_tranche_total numeric;
  v_wallet_gross numeric;
  v_direct_fee numeric;
  v_satellite_fee numeric;
  v_bounty numeric;
  v_satellite_in numeric;
  v_invalid bigint;
  v_is_spin boolean;
  v_expected_fee_entries numeric;
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'refund plan requires tournament and player ids'
      USING ERRCODE = '22004';
  END IF;
  SELECT COALESCE(t.spin_multiplier,0)>0 INTO v_is_spin
    FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'refund plan tournament % does not exist',p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id
   ORDER BY e.user_id,e.entitlement_kind,e.id FOR SHARE;
  PERFORM 1 FROM public.tournament_refund_tranches tr
   WHERE tr.tournament_id=p_tournament_id
   ORDER BY tr.user_id,tr.entitlement_id FOR SHARE;

  SELECT count(*),round(COALESCE(sum(w.amount),0),2)
    INTO v_wallet_count,v_wallet_total
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.type='debit'
     AND lower(w.category) IN ('tournament_buyin','rebuy','addon');
  SELECT count(*),round(COALESCE(sum(e.gross),0),2)
    INTO v_charge_count,v_charge_total
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id
     AND e.entitlement_kind='wallet_charge';
  IF v_wallet_count IS DISTINCT FROM v_charge_count
     OR v_wallet_total IS DISTINCT FROM v_charge_total THEN
    RAISE EXCEPTION
      'tournament % wallet charges and immutable entitlements disagree',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_invalid
    FROM public.tournament_refund_entitlements e
    LEFT JOIN public.chip_ledger l ON l.id=e.source_ledger_id
   WHERE e.tournament_id=p_tournament_id
     AND (
       l.id IS NULL OR l.club_id IS DISTINCT FROM e.refund_wallet_club_id
       OR l.amount IS DISTINCT FROM e.gross
       OR (e.entitlement_kind='wallet_charge' AND (
         l.tournament_id IS DISTINCT FROM e.tournament_id
         OR l.from_type IS DISTINCT FROM 'player_wallet'
         OR l.from_entity_id IS DISTINCT FROM e.user_id
         OR l.to_type IS DISTINCT FROM 'prize_liability'
         OR l.to_entity_id IS DISTINCT FROM e.tournament_id
         OR lower(l.category) IS DISTINCT FROM e.charge_category))
       OR (e.entitlement_kind='satellite_seat' AND (
         l.from_type IS DISTINCT FROM 'prize_liability'
         OR l.from_entity_id IS DISTINCT FROM e.source_satellite_id
         OR l.to_type IS DISTINCT FROM 'prize_liability'
         OR l.to_entity_id IS DISTINCT FROM e.tournament_id
         OR l.metadata->>'user_id' IS DISTINCT FROM e.user_id::text
         OR l.metadata->>'registration_id' IS DISTINCT FROM
              e.registration_id::text))
       OR (e.entitlement_kind='tournament_ticket' AND (
         l.tournament_id IS DISTINCT FROM e.tournament_id
         OR l.from_type IS DISTINCT FROM 'escrow'
         OR l.from_entity_id IS DISTINCT FROM e.source_ticket_id
         OR l.to_type IS DISTINCT FROM 'prize_liability'
         OR l.to_entity_id IS DISTINCT FROM e.tournament_id
         OR l.category IS DISTINCT FROM 'ticket_redeem'
         OR l.metadata->>'user_id' IS DISTINCT FROM e.user_id::text
         OR l.metadata->>'registration_id' IS DISTINCT FROM
              e.registration_id::text))
     );
  IF v_invalid <> 0 THEN
    RAISE EXCEPTION 'tournament % has % invalid refund entitlement sources',
      p_tournament_id,v_invalid USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(CASE
           WHEN e.escrow_bucket IN ('wallet_gross','ticket_gross')
             THEN e.gross
           WHEN e.escrow_bucket='satellite_gross'
             THEN e.refund_prize+e.refund_bounty ELSE 0 END),0),2),
         round(COALESCE(sum(CASE
           WHEN e.entitlement_kind IN ('wallet_charge','tournament_ticket')
             THEN e.refund_fee
           ELSE 0 END),0),2),
         round(COALESCE(sum(CASE
           WHEN e.entitlement_kind='satellite_seat' THEN e.refund_fee
           ELSE 0 END),0),2),
         round(COALESCE(sum(CASE
           WHEN e.escrow_bucket IN (
             'wallet_gross','satellite_gross','ticket_gross')
             THEN e.refund_bounty ELSE 0 END),0),2),
         round(COALESCE(sum(CASE
           WHEN e.escrow_bucket='satellite_in'
             THEN e.refund_prize+e.refund_bounty ELSE 0 END),0),2)
    INTO v_wallet_gross,v_direct_fee,v_satellite_fee,v_bounty,v_satellite_in
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id;
  SELECT * INTO v_escrow FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id FOR SHARE;
  IF v_is_spin THEN
    -- A Spin pools its fee at booking (fn_spin_book_entry), never per player:
    -- fn_tournament_entry_split always sets refund_fee=0 on a Spin's
    -- wallet_charge entitlements (the whole buy-in itemizes as prize), and
    -- fn_ca_tournament_escrow_chips shadow-initialised fee_entries_in from
    -- the pooled rake_records total, not from these entitlements. Read that
    -- same source (rr.fee_in-rr.fee_sat there) instead of the per-player
    -- v_direct_fee, which is structurally always 0 for a Spin - but unlike
    -- fee_in, exclude any prior atomic_cancel_tournament/fn_unregister_from_
    -- tournament reversal row: fee_entries_in was fixed at booking and must
    -- not drift if this function is asked again after a partial refund
    -- already wrote one (this check itself runs before this migration's own
    -- reversal rows exist, so it is a no-op for these 13, but the function
    -- is the platform's shared refund-plan authority, not scoped to them).
    -- Non-spin tournaments are unchanged.
    SELECT round(COALESCE(sum(r.rake_amount) FILTER (
          WHERE NOT (r.rake_amount<0 AND r.source IN (
            'atomic_cancel_tournament','fn_unregister_from_tournament'))),0),2)
        - round(COALESCE(sum(r.rake_amount) FILTER (
          WHERE r.source='fn_award_satellite_seat'),0),2)
      INTO v_expected_fee_entries
      FROM public.rake_records r
     WHERE r.tournament_id=p_tournament_id AND r.is_tournament;
  ELSE
    v_expected_fee_entries:=v_direct_fee;
  END IF;
  IF v_escrow.tournament_id IS NULL
     OR v_escrow.enforced IS DISTINCT FROM true
     OR v_escrow.gross_in IS DISTINCT FROM v_wallet_gross
     OR v_escrow.fee_entries_in IS DISTINCT FROM v_expected_fee_entries
     OR v_escrow.satellite_fee_in IS DISTINCT FROM v_satellite_fee
     OR v_escrow.bounty_in IS DISTINCT FROM v_bounty
     OR v_escrow.satellite_in IS DISTINCT FROM v_satellite_in THEN
    RAISE EXCEPTION
      'tournament % escrow does not equal its immutable entitlement rails',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*),round(COALESCE(sum(w.amount),0),2)
    INTO v_refund_count,v_refund_total
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.user_id=p_user_id
     AND w.type='credit'
     AND lower(w.category) IN ('refund','tournament_refund');
  SELECT count(*),round(COALESCE(sum(tr.amount_paid_now),0),2)
    INTO v_tranche_count,v_tranche_total
    FROM public.tournament_refund_tranches tr
   WHERE tr.tournament_id=p_tournament_id AND tr.user_id=p_user_id;
  IF v_refund_count IS DISTINCT FROM v_tranche_count
     OR v_refund_total IS DISTINCT FROM v_tranche_total THEN
    RAISE EXCEPTION
      'player % tournament % has refund money without exact entitlement tranches',
      p_user_id,p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tournament_refund_tranches tr
    JOIN public.tournament_refund_entitlements e ON e.id=tr.entitlement_id
    WHERE tr.tournament_id=p_tournament_id AND (
      e.tournament_id IS DISTINCT FROM tr.tournament_id
      OR e.user_id IS DISTINCT FROM tr.user_id
      OR e.refund_wallet_club_id IS DISTINCT FROM tr.source_wallet_club_id
      OR e.gross IS DISTINCT FROM tr.amount_paid_now
      OR e.refund_prize IS DISTINCT FROM tr.refund_prize
      OR e.refund_bounty IS DISTINCT FROM tr.refund_bounty
      OR e.refund_fee IS DISTINCT FROM tr.refund_fee)
  ) THEN
    RAISE EXCEPTION 'tournament % has a tranche detached from its entitlement',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  RETURN QUERY
  SELECT e.refund_wallet_club_id,e.gross,e.refund_prize,e.refund_bounty,
         e.refund_fee,1::bigint
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND e.entitlement_kind='wallet_charge'
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_refund_tranches tr
        WHERE tr.entitlement_id=e.id)
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_tickets tk
        WHERE tk.source_refund_entitlement_id=e.id)
   ORDER BY e.entitlement_kind,e.id;
END;
$function$;

-- CREATE OR REPLACE preserves an existing function's ACL rather than
-- resetting it, so the 20260909165629 REVOKE ALL already holds live. Restated
-- here anyway: the definer-authorization gate reads only the migration that
-- declares a function, not the full history, so a replace with no grant
-- statement of its own reads as silently reopened. Idempotent, not a change
-- of policy - this function is called only from other SECURITY DEFINER
-- functions owned by the same role (atomic_cancel_tournament), never as a
-- direct RPC.
REVOKE ALL ON FUNCTION public.fn_ca_tournament_refund_plan(uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Settle the 13 stuck rows themselves through the platform's own idempotent
-- cancellation/refund authority. Re-running this migration a second time is
-- safe: atomic_cancel_tournament replays a tournament that already has a
-- tournament_cancellation_receipts row instead of re-crediting it.
DO $settle_stuck_spins$
DECLARE
  v_ids uuid[] := ARRAY[
    '2aa4cba1-506f-426b-a1ba-d8e22e018533','44d7e2d8-66ed-48ae-a1cb-306ae92b6dfa',
    '482e90bb-ef9d-4135-9067-9f0332c94142','6d359f61-d681-49ba-82f3-00493178e5b3',
    '7284506c-093c-491a-8da7-5816bf1ccccf','8904c10b-6a47-4934-bdf2-def1b1e76f0b',
    '8d5969da-df76-44fa-8c83-5608b844ca06','95e43b6e-c1c9-445e-a1d9-cbe711e3bac1',
    '9cecb4fa-4fdd-4447-9e98-2fe5c20c46a8','b3b65e07-6b3a-4b6c-b5d1-aeb5af17fa99',
    'b67ab0cb-e2d6-4955-8f43-4bff32551400','c2fd1c7e-9572-4b95-90dd-3b999777a145',
    'efd5455d-d188-4171-becb-1d35b016d06a']::uuid[];
  -- Expected total_refunded = sum(entitlement.gross) per tournament, read
  -- live 2026-09-23 immediately before writing this migration.
  v_expected numeric[] := ARRAY[
    300.00,150.00,6.00,60.00,6.00,3.00,15.00,60.00,9.00,30.00,15.00,9.00,6.00
  ]::numeric[];
  v_id uuid;
  v_result jsonb;
  v_i int;
BEGIN
  FOR v_i IN 1..array_length(v_ids,1) LOOP
    v_id:=v_ids[v_i];
    v_result:=public.atomic_cancel_tournament(v_id,NULL);
    IF COALESCE((v_result->>'ok')::boolean,false) IS NOT TRUE
       OR COALESCE((v_result->>'fully_settled')::boolean,false) IS NOT TRUE
       OR (v_result->>'total_refunded')::numeric IS DISTINCT FROM v_expected[v_i] THEN
      RAISE EXCEPTION 'settlement of stuck spin % did not match its proven refund plan: %',
        v_id, v_result USING ERRCODE='55000';
    END IF;
  END LOOP;
END $settle_stuck_spins$;

COMMIT;
