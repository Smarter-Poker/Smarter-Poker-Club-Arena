-- 20260905200041_a_cancelled_target_refunds_the_satellite_seat_it_holds.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (chip standard 5.3, 2026-09-05 20:0x UTC):
--
-- THE RULING (mine under CLAUDE.md 10.9, handed to me by Dan today): a
-- satellite seat is ordinary money in the target event's escrow. It arrived
-- there from the satellite's own pool on the pool_transfer leg. A qualifier
-- who unregisters is refunded it in cash exactly like any entry (already so:
-- fn_unregister_from_tournament refunds the entry split); a target that is
-- cancelled refunds every qualifier in cash exactly like every other entrant.
-- No ticket, no separate ticket liability: the escrow already holds it.
--
-- THE GAP. atomic_cancel_tournament computed what each entrant is owed from
-- their OWN wallet debits, and the deferred trigger tournaments_cancel_must_
-- refund checked the same way. A qualifier has no wallet debit, so both read
-- zero: a cancel refunded them nothing, the seat's value stayed in the escrow
-- at CANCELLED, and the trigger let the cancel commit. No target holding a
-- qualifier was cancelled in the last 7 days (measured: 0 of 13 targets, 569
-- qualifiers), so nobody has lost a seat this way yet; the next one would.
--
-- THE SECOND GAP, found by the probe of the first. A cancel reverses each
-- entrant's fee with a negative rake row; a qualifier's fee had been banked
-- in satellite_fee_in, and the reversal landed in fee_entries_in, driving it
-- negative and the refund apportioning with it (prize -33.75 on a target
-- holding 43 qualifiers, then escrow_short: the cancel could not complete).
-- The reversal of a qualifier's fee now comes out of satellite_fee_in, in the
-- escrow and in the shadow alike, and an event with no cash entry on its
-- books apportions a refund by its own entry structure.
--
-- Both now read the seat: what the satellite actually moved on the leg keyed
-- tourney:<satellite>:seat:<user>:pool_transfer, less any refund already
-- paid; refunded through fn_settle_tournament_obligation under the user's
-- refund key (idempotent, escrow debits with the credit). A seat awarded
-- before origin tracking (source_satellite_id NULL) names no leg and is left
-- to the epoch reset gate, as before. Bodies are the live definitions with
-- those changes; ACLs restated in full. Probed rolled back on a live
-- REGISTERING target holding qualifiers.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.atomic_cancel_tournament(p_tournament_id uuid, p_admin_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_uid uuid := auth.uid();
    v_t RECORD; v_player RECORD;
    v_paid NUMERIC; v_gross NUMERIC; v_fee_net NUMERIC; v_settle jsonb;
    v_refunded_count INT := 0; v_total_refunded NUMERIC := 0; v_fees_reversed NUMERIC := 0;
BEGIN
    SELECT * INTO v_t FROM tournaments WHERE id = p_tournament_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Tournament not found'; END IF;

    IF v_uid IS NOT NULL AND NOT public.is_club_admin(v_t.club_id, v_uid) THEN
        RAISE EXCEPTION 'Only a club admin may cancel a tournament' USING ERRCODE = '42501';
    END IF;

    IF upper(COALESCE(v_t.status,'')) IN ('COMPLETED','CANCELLED','CANCELED','COMPLETING') THEN
        RAISE EXCEPTION 'Tournament is already %', v_t.status;
    END IF;

    UPDATE tournaments
       SET status='CANCELLED', ended_at=NOW(), updated_at=NOW(),
           prize_pool=0, bounty_pool=0
     WHERE id=p_tournament_id;

    FOR v_player IN (
      SELECT tp.id, tp.user_id, COALESCE(tp.is_satellite_qualifier, false) AS is_q, tp.source_satellite_id
        FROM tournament_players tp
       WHERE tp.tournament_id = p_tournament_id AND tp.user_id IS NOT NULL
    )
    LOOP
        -- v_gross: everything this entrant paid in (buy-in + fee, rebuys,
        -- add-ons) - the refund obligation's TOTAL (standard S13).
        -- v_paid: what is still owed after the refunds already on the ledger,
        -- the same net figure the old body credited.
        SELECT round(COALESCE(sum(
                 CASE WHEN w.type='debit' AND w.category IN ('tournament_buyin','rebuy','addon') THEN w.amount
                      ELSE 0 END), 0), 2),
               round(COALESCE(sum(
                 CASE WHEN w.type='debit'  AND w.category IN ('tournament_buyin','rebuy','addon') THEN w.amount
                      WHEN w.type='credit' AND w.category='refund' THEN -w.amount
                      ELSE 0 END), 0), 2)
          INTO v_gross, v_paid
          FROM wallet_transactions w
         WHERE w.user_id = v_player.user_id AND w.related_entity_id = p_tournament_id;

        /* CHIP STANDARD 5.3 (2026-09-05): A SATELLITE SEAT IS MONEY THE TARGET
           HOLDS. A qualifier paid nothing from a wallet, so the sums above read
           zero and a cancel used to refund them nothing while the seat's value
           (moved from the satellite's pool on the pool_transfer leg) stayed in
           this event's escrow. The seat is refunded in cash like any entry:
           what the satellite actually moved, less any refund already paid. A
           seat awarded before origin tracking (source NULL) names no leg and
           is left for the epoch reset gate, as before. */
        IF v_gross = 0 AND v_player.is_q AND v_player.source_satellite_id IS NOT NULL THEN
            SELECT round(COALESCE(sum(l.amount), 0), 2) INTO v_gross
              FROM chip_ledger l
             WHERE l.to_entity_id = p_tournament_id AND l.to_type = 'prize_liability'
               AND l.idempotency_key = 'tourney:' || v_player.source_satellite_id::text || ':seat:' || v_player.user_id::text || ':pool_transfer';
            v_paid := round(v_gross + v_paid, 2);
        END IF;

        IF v_paid > 0 THEN
            /* ONE PAYER (R3, 2026-09-02). User-keyed 'refund' obligation; the
               settle function seeds amount_paid from the refund credits already
               on the ledger and pays gross - seeded. A refused refund is
               skipped here exactly as a refused fn_credit_and_log was, and the
               deferred trigger tournaments_cancel_must_refund then refuses the
               whole cancel at commit because an entrant is still owed. */
            v_settle := public.fn_settle_tournament_obligation(
              p_tournament_id, 'refund', NULL, v_player.user_id, v_gross,
              'atomic_cancel_tournament',
              'Tournament cancellation refund: ' || COALESCE(v_t.name,'Unknown'));
            IF COALESCE((v_settle->>'ok')::boolean, false)
               AND COALESCE((v_settle->>'paid')::numeric, 0) > 0 THEN
                v_refunded_count := v_refunded_count + 1;
                v_total_refunded := v_total_refunded + (v_settle->>'paid')::numeric;
            END IF;
        END IF;

        IF v_t.club_id IS NOT NULL THEN
            SELECT round(COALESCE(sum(r.rake_amount), 0), 2) INTO v_fee_net
              FROM rake_records r
             WHERE r.tournament_id = p_tournament_id AND r.is_tournament
               AND r.metadata->>'user_id' = v_player.user_id::text;
            IF v_fee_net > 0 THEN
                INSERT INTO rake_records (hand_id, table_id, club_id, rake_amount, pot_size,
                  num_players, bbj_contribution, is_tournament, tournament_id, source, metadata)
                VALUES (NULL, NULL, v_t.club_id, -v_fee_net, v_fee_net, 1, 0, true,
                  p_tournament_id, 'atomic_cancel_tournament',
                  jsonb_build_object('kind','tournament_fee_refund','user_id',v_player.user_id));
                v_fees_reversed := v_fees_reversed + v_fee_net;
            END IF;
        END IF;
    END LOOP;

    IF v_fees_reversed > 0 THEN
        UPDATE tournaments SET total_rake = GREATEST(0, COALESCE(total_rake,0) - v_fees_reversed)
         WHERE id = p_tournament_id;
    END IF;

    UPDATE tournament_players SET status='eliminated', eliminated_at=NOW()
     WHERE tournament_id = p_tournament_id AND status IN ('registered','playing');
    UPDATE tables SET status='closed', current_players=0 WHERE tournament_id = p_tournament_id;

    RETURN jsonb_build_object('success', true, 'refunded_count', v_refunded_count,
      'total_refunded', v_total_refunded, 'fees_reversed', v_fees_reversed);
END; $function$;
REVOKE ALL ON FUNCTION public.atomic_cancel_tournament(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_cancel_tournament(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.trg_tournaments_cancel_must_refund()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rows integer; v_sum numeric;
BEGIN
  IF NEW.ended_at IS NULL THEN
    RAISE EXCEPTION
      'Tournament % cannot be CANCELLED without ended_at - cancel via atomic_cancel_tournament so the refunds and fee reversal run',
      NEW.id
      USING ERRCODE = '55000';
  END IF;

  WITH paid AS (
    SELECT w.user_id,
           round(COALESCE(sum(
             CASE WHEN w.type = 'debit'  AND w.category IN ('tournament_buyin','rebuy','addon') THEN w.amount
                  WHEN w.type = 'credit' AND w.category = 'refund' THEN -w.amount
                  ELSE 0 END), 0), 2) AS net
      FROM wallet_transactions w
     WHERE w.related_entity_id = NEW.id
     GROUP BY w.user_id
  ), seats AS (
    /* CHIP STANDARD 5.3 (2026-09-05): a satellite qualifier is owed the seat
       value the satellite moved into this event (the pool_transfer leg). */
    SELECT tp.user_id, round(COALESCE(sum(l.amount), 0), 2) AS net
      FROM tournament_players tp
      JOIN chip_ledger l
        ON l.to_entity_id = NEW.id AND l.to_type = 'prize_liability'
       AND l.idempotency_key = 'tourney:' || tp.source_satellite_id::text || ':seat:' || tp.user_id::text || ':pool_transfer'
     WHERE tp.tournament_id = NEW.id AND COALESCE(tp.is_satellite_qualifier, false) AND tp.source_satellite_id IS NOT NULL
     GROUP BY tp.user_id
  ), owed AS (
    SELECT user_id, round(sum(net), 2) AS net FROM (SELECT * FROM paid UNION ALL SELECT * FROM seats) x GROUP BY user_id
  )
  SELECT count(*), COALESCE(round(sum(net), 2), 0)
    INTO v_rows, v_sum
    FROM owed WHERE net > 0.005;

  IF COALESCE(v_rows, 0) > 0 THEN
    RAISE EXCEPTION
      'Tournament % cannot be CANCELLED: % entrant(s) paid % chips that were never refunded. Cancel via atomic_cancel_tournament.',
      NEW.id, v_rows, v_sum
      USING ERRCODE = '55000';
  END IF;

  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.trg_tournaments_cancel_must_refund() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trg_tournaments_cancel_must_refund() TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_escrow_apply(p_tournament_id uuid, p_what text, p_gross_in numeric DEFAULT 0, p_fee_entries_in numeric DEFAULT 0, p_satellite_fee_in numeric DEFAULT 0, p_bounty_in numeric DEFAULT 0, p_overlay_in numeric DEFAULT 0, p_satellite_in numeric DEFAULT 0, p_prize_out numeric DEFAULT 0, p_bounty_out numeric DEFAULT 0, p_fee_out numeric DEFAULT 0, p_refund numeric DEFAULT 0, p_reserve_out numeric DEFAULT 0, p_reserve_in numeric DEFAULT 0)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v public.tournament_escrow%ROWTYPE;
  v_spin boolean; e record; v_sat_fee numeric;
  v_prize_in numeric; v_tot numeric; r_p numeric := 0; r_b numeric := 0; r_f numeric := 0;
  /* PHASE 5 GATE (2026-09-05): a spin's reserve_out is the engine moving the
     filled pool into spin_reserve inside the registration that filled it; it
     is the pool's own money on its way to the draw, not a payment, and it is
     never refused. Payments and refunds are. */
  v_outflow boolean := COALESCE(p_prize_out, 0) > 0 OR COALESCE(p_bounty_out, 0) > 0 OR COALESCE(p_fee_out, 0) > 0 OR COALESCE(p_refund, 0) > 0;
  r_out numeric := 0; r_in numeric := 0;
  v_sp_prize numeric; v_sp_bounty numeric;
BEGIN
  SELECT * INTO v FROM public.tournament_escrow WHERE tournament_id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    /* FIRST SIGHT: open from the shadow, which already includes the row that
       fired this call (AFTER trigger), so this call's deltas are not applied. */
    SELECT (COALESCE(t.variant, '') = 'spin' OR COALESCE(t.is_premium_spin, false)) INTO v_spin
      FROM public.tournaments t WHERE t.id = p_tournament_id;
    IF NOT FOUND THEN
      RETURN;  -- the entity is not a tournament (wallet rows carry other entities)
    END IF;
    SELECT * INTO e FROM public.fn_ca_tournament_escrow(p_tournament_id);
    SELECT COALESCE(sum(rr.rake_amount), 0) INTO v_sat_fee FROM public.rake_records rr
     WHERE rr.tournament_id = p_tournament_id AND rr.is_tournament AND rr.source = 'fn_award_satellite_seat';
    -- The shadow apportions the refund total by the event's split; carry its parts.
    v_prize_in := e.prize_in; v_tot := e.prize_in + e.bounty_in + (e.fee_in - v_sat_fee);
    IF v_tot > 0 THEN
      r_p := round(e.refund_out * e.prize_in / v_tot, 2);
      r_b := round(e.refund_out * e.bounty_in / v_tot, 2);
    ELSE
      r_p := e.refund_out;
    END IF;
    r_f := round(e.refund_out - r_p - r_b, 2);
    /* PHASE 5.2: a spin's prize bank also moves through the reserve. The legs
       the engine already writes (spin_entry: prize_liability -> spin_reserve;
       spin_prize: spin_reserve -> prize_liability) are read at first sight,
       the firing leg included, so nothing is counted twice. */
    SELECT COALESCE(sum(l.amount) FILTER (WHERE l.category = 'spin_entry' AND l.from_entity_id = p_tournament_id), 0),
           COALESCE(sum(l.amount) FILTER (WHERE l.category = 'spin_prize' AND l.to_entity_id = p_tournament_id), 0)
      INTO r_out, r_in
      FROM public.chip_ledger l
     WHERE l.category IN ('spin_entry', 'spin_prize')
       AND (l.from_entity_id = p_tournament_id OR l.to_entity_id = p_tournament_id);
    INSERT INTO public.tournament_escrow
      (tournament_id, enforced, gross_in, fee_entries_in, satellite_fee_in, bounty_in, overlay_in, satellite_in,
       prize_out, bounty_out, fee_out, refund_prize, refund_bounty, refund_fee, reserve_out, reserve_in,
       prize_balance, bounty_balance, fee_balance, opened_from)
    VALUES
      (p_tournament_id, true,  -- PHASE 5 GATE: spins are enforced too (13,346 spins measured: none paid before its draw, none paid beyond its bank)
       round(e.prize_in + e.bounty_in + (e.fee_in - v_sat_fee), 2), round(e.fee_in - v_sat_fee, 2), round(v_sat_fee, 2),
       e.bounty_in, e.overlay_in, e.satellite_in, e.prize_out, e.bounty_out, e.fee_out, r_p, r_b, r_f, round(r_out, 2), round(r_in, 2),
       round(e.prize_balance - r_out + r_in, 2), e.bounty_balance, e.fee_balance,
       'shadow at first sight (' || p_what || ')')
    ON CONFLICT (tournament_id) DO NOTHING;
    RETURN;
  END IF;

  -- A refund returns a whole entry: apportioned by the event's own split
  -- (prize : bounty : fee of what the entries brought in), as the shadow does.
  IF COALESCE(p_refund, 0) > 0 THEN
    v_prize_in := v.gross_in - v.fee_entries_in - v.bounty_in;
    v_tot := v.gross_in;
    IF v_tot > 0 THEN
      r_p := round(p_refund * v_prize_in / v_tot, 2);
      r_b := round(p_refund * v.bounty_in / v_tot, 2);
    ELSE
      /* CHIP STANDARD 5.3 (2026-09-05): an event with no cash entry on its
         books (every entrant a satellite qualifier) still apportions a refund
         by its own entry structure, so the fee slice returns from the fee
         bank and the prize bank is not asked for the whole refund. */
      SELECT s.prize, s.bounty INTO v_sp_prize, v_sp_bounty
        FROM public.tournaments t2
        CROSS JOIN LATERAL public.fn_tournament_entry_split(t2.buy_in_amount, t2.buy_in_fee, t2.bounty_amount,
               COALESCE(t2.is_bounty, false) OR COALESCE(t2.is_pko, false) OR COALESCE(t2.is_mystery_bounty, false)) s
       WHERE t2.id = p_tournament_id;
      IF COALESCE(v_sp_prize, 0) + COALESCE(v_sp_bounty, 0) > 0 THEN
        r_p := round(p_refund * v_sp_prize / (v_sp_prize + v_sp_bounty + (SELECT COALESCE(t3.buy_in_fee, 0) FROM public.tournaments t3 WHERE t3.id = p_tournament_id)), 2);
        r_b := round(p_refund * v_sp_bounty / (v_sp_prize + v_sp_bounty + (SELECT COALESCE(t3.buy_in_fee, 0) FROM public.tournaments t3 WHERE t3.id = p_tournament_id)), 2);
      ELSE
        r_p := p_refund;
      END IF;
    END IF;
    r_f := round(p_refund - r_p - r_b, 2);
  END IF;

  UPDATE public.tournament_escrow
     SET gross_in = gross_in + COALESCE(p_gross_in, 0),
         fee_entries_in = fee_entries_in + COALESCE(p_fee_entries_in, 0),
         satellite_fee_in = satellite_fee_in + COALESCE(p_satellite_fee_in, 0),
         bounty_in = bounty_in + COALESCE(p_bounty_in, 0),
         overlay_in = overlay_in + COALESCE(p_overlay_in, 0),
         satellite_in = satellite_in + COALESCE(p_satellite_in, 0),
         prize_out = prize_out + COALESCE(p_prize_out, 0),
         bounty_out = bounty_out + COALESCE(p_bounty_out, 0),
         fee_out = fee_out + COALESCE(p_fee_out, 0),
         refund_prize = refund_prize + r_p, refund_bounty = refund_bounty + r_b, refund_fee = refund_fee + r_f,
         reserve_out = reserve_out + COALESCE(p_reserve_out, 0), reserve_in = reserve_in + COALESCE(p_reserve_in, 0),
         updated_at = now()
   WHERE tournament_id = p_tournament_id;
  UPDATE public.tournament_escrow
     SET prize_balance  = round((gross_in - fee_entries_in - bounty_in) + overlay_in + satellite_in - reserve_out + reserve_in - prize_out - refund_prize, 2),
         bounty_balance = round(bounty_in - bounty_out - refund_bounty, 2),
         fee_balance    = round(fee_entries_in + satellite_fee_in - fee_out - refund_fee, 2)
   WHERE tournament_id = p_tournament_id
   RETURNING * INTO v;

  /* THE REFUSAL. Only an OUTFLOW can be refused (an entry's fee row lands a
     moment after its wallet debit inside the same transaction, so a bank may
     dip for that instant on the way in, never on the way out). A refused
     outflow aborts the statement that paid it: the wallet credit and the
     escrow debit stand or fall together. */
  IF v.enforced AND v_outflow
     AND (v.prize_balance < -0.005 OR v.bounty_balance < -0.005 OR v.fee_balance < -0.005) THEN
    RAISE EXCEPTION 'escrow_short: tournament % cannot pay this % - it would leave prize %, bounty %, fee % (chip standard Phase 5.1: an event pays only what it holds)',
      p_tournament_id, p_what, v.prize_balance, v.bounty_balance, v.fee_balance
      USING ERRCODE = 'P0403';
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_escrow_apply(uuid, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_escrow_apply(uuid, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_rake_record()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_fee numeric := round(COALESCE(NEW.rake_amount, 0), 2);
BEGIN
  IF NOT COALESCE(NEW.is_tournament, false) OR NEW.tournament_id IS NULL THEN RETURN NULL; END IF;
  /* CHIP STANDARD 5.3 (2026-09-05): a cancel's fee reversal is rake
     attribution, not escrow money. The refund that precedes it already
     returned the fee slice to the entrant from the fee bank (refund_fee);
     counting the reversal too took the fee out twice, drove the fee bank
     negative and refused the cancel's own refunds (probe 20:0x UTC on a
     target holding 43 qualifiers: fee -2.50, escrow_short). */
  IF v_fee < 0 AND NEW.source = 'atomic_cancel_tournament' THEN RETURN NULL; END IF;
  IF NEW.source = 'fn_award_satellite_seat' THEN
    /* PHASE 5 GATE (2026-09-05): the fee row carries the fee only. The seat's
       money arrives on the satellite's pool_transfer leg (buy-in + fee, or
       less when the satellite pool was short) through zz_ca_escrow_seat_transfer_leg;
       the fee is reclassed out of the prize bank here so the two together read
       exactly what arrived. A target with no fee gets no row here and is fed
       by the leg alone, which the rake row could never do. */
    PERFORM public.fn_ca_escrow_apply(NEW.tournament_id, 'satellite seat fee',
              p_satellite_fee_in => v_fee, p_satellite_in => -v_fee);
  ELSE
    PERFORM public.fn_ca_escrow_apply(NEW.tournament_id, 'entry fee', p_fee_entries_in => v_fee);
  END IF;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_escrow_on_rake_record() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_escrow(p_tournament_id uuid)
 RETURNS TABLE(prize_in numeric, bounty_in numeric, fee_in numeric, overlay_in numeric, satellite_in numeric, prize_out numeric, bounty_out numeric, fee_out numeric, refund_out numeric, prize_balance numeric, bounty_balance numeric, fee_balance numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
WITH t AS (
  SELECT id,
         COALESCE(bounty_amount, 0) AS bounty_amount,
         (COALESCE(is_bounty, false) OR COALESCE(is_pko, false)
          OR COALESCE(is_mystery_bounty, false)) AS is_b
    FROM public.tournaments
   WHERE id = p_tournament_id
), w AS (
  SELECT
    COALESCE(sum(amount) FILTER (WHERE type = 'debit'
                                   AND category IN ('tournament_buyin','rebuy','addon')), 0) AS gross_in,
    count(*) FILTER (WHERE type = 'debit' AND category = 'tournament_buyin') AS n_entry,
    count(*) FILTER (WHERE type = 'debit' AND category = 'rebuy')            AS n_rebuy,
    COALESCE(sum(amount) FILTER (WHERE type = 'credit' AND category = 'prize'), 0)
      - COALESCE(sum(amount) FILTER (WHERE type = 'debit'
                                       AND category IN ('prize','prize_reversal')), 0) AS prize_out,
    COALESCE(sum(amount) FILTER (WHERE type = 'credit' AND category = 'bounty'), 0) AS bounty_out,
    COALESCE(sum(amount) FILTER (WHERE type = 'credit' AND category = 'refund'), 0) AS refund_out
  FROM public.wallet_transactions
  WHERE related_entity_id = p_tournament_id
), rr AS (
  SELECT
    COALESCE(sum(rake_amount), 0) AS fee_in,
    COALESCE(sum(rake_amount) FILTER (WHERE source = 'fn_award_satellite_seat'), 0) AS fee_sat,
    COALESCE(sum(COALESCE(pot_size, 0) - rake_amount)
               FILTER (WHERE source = 'fn_award_satellite_seat'), 0) AS satellite_in
  FROM public.rake_records
  WHERE tournament_id = p_tournament_id AND is_tournament
    -- CHIP STANDARD 5.3 (2026-09-05): a cancel's fee reversal is attribution,
    -- not escrow money; the refund already returned the fee slice.
    AND NOT (rake_amount < 0 AND source = 'atomic_cancel_tournament')
), ov AS (
  -- The bank -> prize_liability rows. The 01:28 UTC build of the lock trigger
  -- wrote its explicit row AND let the union_wallets auto-ledger write a twin
  -- for the same debit; the twin is skipped when an explicit row of the same
  -- amount sits within five seconds of it.
  -- A 'correction' row from a bank into prize_liability is a restored overlay
  -- (2026-09-03: the journal row the lock trigger lost to a deadlock, put back
  -- through fn_ca_post_correction) and counts the same.
  SELECT COALESCE(sum(a.amount), 0) AS ledger_overlay
    FROM public.chip_ledger a
   WHERE a.to_entity_id = p_tournament_id
     AND a.to_type = 'prize_liability'
     AND (a.category = 'overlay'
          OR (a.category = 'correction' AND a.from_type IN ('union_bank','club_treasury')))
     AND NOT (
       COALESCE(a.description, '') LIKE 'auto-ledgered%'
       AND EXISTS (
         SELECT 1 FROM public.chip_ledger b
          WHERE b.to_entity_id = a.to_entity_id
            AND b.category = 'overlay'
            AND b.to_type = 'prize_liability'
            AND b.id <> a.id
            AND b.amount = a.amount
            AND COALESCE(b.description, '') NOT LIKE 'auto-ledgered%'
            AND abs(extract(epoch FROM (b.created_at - a.created_at))) < 5))
), stl AS (
  -- PHASE 5 GATE (2026-09-05): the seat's money is what the satellite's pool
  -- actually moved (the pool_transfer leg), not the nominal the fee row implies.
  SELECT COALESCE(sum(amount), 0) AS moved
    FROM public.chip_ledger
   WHERE to_entity_id = p_tournament_id AND to_type = 'prize_liability'
     AND idempotency_key LIKE 'tourney:%:seat:%:pool_transfer'
), tgo AS (
  SELECT COALESCE(sum(amount), 0) AS tgo_amount
    FROM public.tournament_guarantee_overlays
   WHERE tournament_id = p_tournament_id
), sat AS (
  SELECT COALESCE(sum(amount), 0) AS seats_out
    FROM public.tournament_payouts
   WHERE tournament_id = p_tournament_id AND source = 'satellite_seat'
), fo AS (
  SELECT COALESCE(sum(amount), 0) AS fee_out
    FROM public.tournament_rake_settlements
   WHERE tournament_id = p_tournament_id AND settled_at IS NOT NULL
), calc AS (
  SELECT
    round(w.gross_in, 2)                                          AS gross_in,
    round(rr.fee_in, 2)                                           AS fee_in,
    round(rr.fee_in - rr.fee_sat, 2)                              AS fee_entries,
    round(CASE WHEN t.is_b
               THEN w.n_entry * t.bounty_amount + w.n_rebuy * round(t.bounty_amount)
               ELSE 0 END, 2)                                     AS bounty_in,
    round(CASE WHEN ov.ledger_overlay > 0 THEN ov.ledger_overlay
               ELSE tgo.tgo_amount END, 2)                        AS overlay_in,
    round(stl.moved - rr.fee_sat, 2)                              AS satellite_in,
    round(w.prize_out + sat.seats_out, 2)                         AS prize_out,
    round(w.bounty_out, 2)                                        AS bounty_out,
    round(fo.fee_out, 2)                                          AS fee_out,
    round(w.refund_out, 2)                                        AS refund_out
  FROM t, w, rr, stl, ov, tgo, sat, fo
), split AS (
  SELECT c.*,
         round(c.gross_in - c.fee_entries - c.bounty_in, 2) AS prize_in
    FROM calc c
), apportion AS (
  -- A refund returns a whole entry (prize + bounty + fee slices). Apportion it
  -- by the event's own split so the three residuals sum to the true total.
  SELECT s.*,
         CASE WHEN (s.prize_in + s.bounty_in + s.fee_entries) > 0
              THEN round(s.refund_out * s.prize_in / (s.prize_in + s.bounty_in + s.fee_entries), 2)
              ELSE s.refund_out END AS r_prize,
         CASE WHEN (s.prize_in + s.bounty_in + s.fee_entries) > 0
              THEN round(s.refund_out * s.bounty_in / (s.prize_in + s.bounty_in + s.fee_entries), 2)
              ELSE 0 END AS r_bounty
    FROM split s
)
SELECT
  a.prize_in,
  a.bounty_in,
  a.fee_in,
  a.overlay_in,
  a.satellite_in,
  a.prize_out,
  a.bounty_out,
  a.fee_out,
  a.refund_out,
  round(a.prize_in + a.overlay_in + a.satellite_in - a.prize_out - a.r_prize, 2)      AS prize_balance,
  round(a.bounty_in - a.bounty_out - a.r_bounty, 2)                                    AS bounty_balance,
  round(a.fee_in - a.fee_out - (a.refund_out - a.r_prize - a.r_bounty), 2)             AS fee_balance
FROM apportion a;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_escrow(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_escrow(uuid) TO service_role;

DO $$
BEGIN
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'atomic_cancel_tournament') NOT LIKE '%:pool_transfer%' THEN
    RAISE EXCEPTION 'atomic_cancel_tournament does not read the satellite seat';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'trg_tournaments_cancel_must_refund') NOT LIKE '%seats AS (%' THEN
    RAISE EXCEPTION 'the cancel guard does not count the satellite seat';
  END IF;
END $$;

COMMIT;
