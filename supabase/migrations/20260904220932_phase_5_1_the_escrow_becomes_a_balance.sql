-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 5.1 - ESCROW BECOMES A BALANCE (chip standard, 2026-09-04).
-- Read from production 21:50-22:20 UTC.
--
-- What was true. A tournament's money was three COUNTERS on the tournaments
-- row (prize_pool, bounty_pool, total_rake) that no path was obliged to keep
-- true (the shadow finds the prize counter wrong on 1,146 of 1,739 recent
-- events), and one SHADOW (fn_ca_tournament_escrow) that re-derives the
-- truth after the fact from the operational rows every path does write:
-- wallet_transactions (entries, rebuys, add-ons, prizes, bounties, refunds),
-- rake_records (the fee per entry, written with the entry; the satellite
-- seat), the overlay legs in chip_ledger, tournament_payouts (satellite
-- seats), and tournament_rake_settlements (the fee leaving). The shadow
-- balances 100% of asserted events (589 of 589 in the last three hours, 900
-- of 900 today), and the settle function's only cap was the prize counter
-- plus five cents.
--
-- What this does: the shadow's identity becomes a BALANCE, tournament_escrow
-- (prize_balance, bounty_balance, fee_balance, each derived from its own
-- components), maintained in the same transaction as every operational row
-- by triggers on those five tables - the shadow's rules applied as the rows
-- land. A prize, bounty, refund, satellite seat or fee settlement that would
-- take its bank below zero is refused inside the write that would have paid
-- it, so the wallet credit and the escrow debit stand or fall together (R1
-- at the constraint). fn_settle_tournament_obligation reads the balance
-- instead of the counter, so its refusal is the real one and comes with a
-- reason. A tournament the balance has never seen opens itself from the
-- shadow on first sight, so an event that began before this migration is
-- paid against what it really holds; the events open right now are opened
-- here. A tournament reaching COMPLETED with a bank not at zero files a
-- settlement_error incident (R5 reported; holding the event in COMPLETING
-- is engine work, named in the changelog). Spins are tracked but never
-- refused: their prize comes from spin_reserve by multiplier, not from
-- entries; 5.2 gives them their own reserve.
--
-- The counters stay (every page reads them); the hourly shadow keeps running
-- and now compares itself to the balance, so a rule the triggers and the
-- shadow disagree on is an incident, not a silent drift.
--
-- Two migrations: this one builds the balance, its door, the five trigger
-- functions, the close reporter, the settle function's escrow read and the
-- hourly drift check; the second (applied inside the :55 platform freeze,
-- when the money tables are quiet) opens the live events from the shadow and
-- creates the triggers - the two must land together, and creating six
-- triggers on busy tables in one transaction deadlocks against live
-- multi-table writers outside the freeze (measured 22:25 UTC). Until the
-- second lands, the settle function finds no balance and keeps the old
-- counter cap; nothing refuses on a stale figure.
-- Probed rolled-back first. Every number asserted.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.tournament_escrow (
  tournament_id     uuid PRIMARY KEY,
  enforced          boolean NOT NULL DEFAULT true,
  -- components (what came in, what went out), each only ever added to
  gross_in          numeric NOT NULL DEFAULT 0,   -- entries + rebuys + add-ons, gross
  fee_entries_in    numeric NOT NULL DEFAULT 0,   -- rake_records rows, not satellite
  satellite_fee_in  numeric NOT NULL DEFAULT 0,   -- rake_records rows from fn_award_satellite_seat
  bounty_in         numeric NOT NULL DEFAULT 0,
  overlay_in        numeric NOT NULL DEFAULT 0,
  satellite_in      numeric NOT NULL DEFAULT 0,
  prize_out         numeric NOT NULL DEFAULT 0,
  bounty_out        numeric NOT NULL DEFAULT 0,
  fee_out           numeric NOT NULL DEFAULT 0,
  refund_prize      numeric NOT NULL DEFAULT 0,
  refund_bounty     numeric NOT NULL DEFAULT 0,
  refund_fee        numeric NOT NULL DEFAULT 0,
  -- the banks, derived from the components on every write
  prize_balance     numeric NOT NULL DEFAULT 0,
  bounty_balance    numeric NOT NULL DEFAULT 0,
  fee_balance       numeric NOT NULL DEFAULT 0,
  opened_at         timestamptz NOT NULL DEFAULT now(),
  opened_from       text NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  closed_at         timestamptz,
  close_note        text
);
ALTER TABLE public.tournament_escrow ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_escrow FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.tournament_escrow TO service_role;
COMMENT ON TABLE public.tournament_escrow IS
  'The tournament escrow as a BALANCE (chip standard Phase 5.1). prize_balance = (gross_in - fee_entries_in - bounty_in) + overlay_in + satellite_in - prize_out - refund_prize; bounty_balance = bounty_in - bounty_out - refund_bounty; fee_balance = fee_entries_in + satellite_fee_in - fee_out - refund_fee. Maintained by triggers in the same transaction as each operational row; an outflow that would take a bank below zero is refused. enforced=false for spins (5.2).';

-- ── The one door every trigger uses ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_apply(
  p_tournament_id uuid, p_what text,
  p_gross_in numeric DEFAULT 0, p_fee_entries_in numeric DEFAULT 0, p_satellite_fee_in numeric DEFAULT 0,
  p_bounty_in numeric DEFAULT 0, p_overlay_in numeric DEFAULT 0, p_satellite_in numeric DEFAULT 0,
  p_prize_out numeric DEFAULT 0, p_bounty_out numeric DEFAULT 0, p_fee_out numeric DEFAULT 0,
  p_refund numeric DEFAULT 0)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v public.tournament_escrow%ROWTYPE;
  v_spin boolean; e record; v_sat_fee numeric;
  v_prize_in numeric; v_tot numeric; r_p numeric := 0; r_b numeric := 0; r_f numeric := 0;
  v_outflow boolean := COALESCE(p_prize_out, 0) > 0 OR COALESCE(p_bounty_out, 0) > 0 OR COALESCE(p_fee_out, 0) > 0 OR COALESCE(p_refund, 0) > 0;
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
    INSERT INTO public.tournament_escrow
      (tournament_id, enforced, gross_in, fee_entries_in, satellite_fee_in, bounty_in, overlay_in, satellite_in,
       prize_out, bounty_out, fee_out, refund_prize, refund_bounty, refund_fee,
       prize_balance, bounty_balance, fee_balance, opened_from)
    VALUES
      (p_tournament_id, NOT v_spin,
       round(e.prize_in + e.bounty_in + (e.fee_in - v_sat_fee), 2), round(e.fee_in - v_sat_fee, 2), round(v_sat_fee, 2),
       e.bounty_in, e.overlay_in, e.satellite_in, e.prize_out, e.bounty_out, e.fee_out, r_p, r_b, r_f,
       e.prize_balance, e.bounty_balance, e.fee_balance,
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
      r_p := p_refund;
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
         updated_at = now()
   WHERE tournament_id = p_tournament_id;
  UPDATE public.tournament_escrow
     SET prize_balance  = round((gross_in - fee_entries_in - bounty_in) + overlay_in + satellite_in - prize_out - refund_prize, 2),
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
REVOKE ALL ON FUNCTION public.fn_ca_escrow_apply(uuid, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_escrow_apply(uuid, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric) TO service_role;

-- ── wallet_transactions: entries, rebuys, add-ons, prizes, bounties, refunds ─
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_wallet_tx()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cat text := lower(COALESCE(NEW.category, ''));
  v_amt numeric := round(COALESCE(NEW.amount, 0), 2);
  t record; v_bounty numeric;
BEGIN
  IF NEW.related_entity_id IS NULL OR v_amt = 0 THEN RETURN NULL; END IF;
  IF NEW.type = 'debit' AND v_cat IN ('tournament_buyin', 'rebuy', 'addon') THEN
    SELECT COALESCE(bounty_amount, 0) AS bounty_amount,
           (COALESCE(is_bounty, false) OR COALESCE(is_pko, false) OR COALESCE(is_mystery_bounty, false)) AS is_b
      INTO t FROM public.tournaments WHERE id = NEW.related_entity_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    -- The shadow's rule: an entry carries the bounty, a rebuy carries it rounded, an add-on none.
    v_bounty := CASE WHEN t.is_b AND v_cat = 'tournament_buyin' THEN round(t.bounty_amount, 2)
                     WHEN t.is_b AND v_cat = 'rebuy' THEN round(t.bounty_amount)
                     ELSE 0 END;
    PERFORM public.fn_ca_escrow_apply(NEW.related_entity_id, v_cat, p_gross_in => v_amt, p_bounty_in => v_bounty);
  ELSIF NEW.type = 'credit' AND v_cat = 'prize' THEN
    PERFORM public.fn_ca_escrow_apply(NEW.related_entity_id, 'prize', p_prize_out => v_amt);
  ELSIF NEW.type = 'debit' AND v_cat IN ('prize', 'prize_reversal') THEN
    PERFORM public.fn_ca_escrow_apply(NEW.related_entity_id, 'prize reversal', p_prize_out => -v_amt);
  ELSIF NEW.type = 'credit' AND v_cat = 'bounty' THEN
    PERFORM public.fn_ca_escrow_apply(NEW.related_entity_id, 'bounty', p_bounty_out => v_amt);
  ELSIF NEW.type = 'credit' AND v_cat = 'refund' THEN
    PERFORM public.fn_ca_escrow_apply(NEW.related_entity_id, 'refund', p_refund => v_amt);
  END IF;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_escrow_on_wallet_tx() FROM PUBLIC, anon, authenticated;

-- ── rake_records: the fee per entry, and the satellite seat's pot ──────────
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_rake_record()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_fee numeric := round(COALESCE(NEW.rake_amount, 0), 2);
BEGIN
  IF NOT COALESCE(NEW.is_tournament, false) OR NEW.tournament_id IS NULL THEN RETURN NULL; END IF;
  IF NEW.source = 'fn_award_satellite_seat' THEN
    PERFORM public.fn_ca_escrow_apply(NEW.tournament_id, 'satellite seat in',
              p_satellite_fee_in => v_fee, p_satellite_in => round(COALESCE(NEW.pot_size, 0) - v_fee, 2));
  ELSE
    PERFORM public.fn_ca_escrow_apply(NEW.tournament_id, 'entry fee', p_fee_entries_in => v_fee);
  END IF;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_escrow_on_rake_record() FROM PUBLIC, anon, authenticated;

-- ── chip_ledger: an overlay from a bank into the event's prize_liability ───
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_overlay_leg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Explicit rows only: the autoledger twin (description 'auto-ledgered ...')
  -- of the same debit is not a second overlay. None has been written since
  -- the lock trigger was fixed on 09-03; the shadow still skips them.
  IF COALESCE(NEW.description, '') LIKE 'auto-ledgered%' THEN RETURN NULL; END IF;
  PERFORM public.fn_ca_escrow_apply(NEW.to_entity_id, 'overlay', p_overlay_in => round(NEW.amount, 2));
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_escrow_on_overlay_leg() FROM PUBLIC, anon, authenticated;

-- ── tournament_payouts: a satellite seat is a prize paid in kind ──────────
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_seat_payout()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.fn_ca_escrow_apply(NEW.tournament_id, 'satellite seat out', p_prize_out => round(COALESCE(NEW.amount, 0), 2));
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_escrow_on_seat_payout() FROM PUBLIC, anon, authenticated;

-- ── tournament_rake_settlements: the fee leaves when it settles ───────────
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_rake_settlement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.settled_at IS NULL THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND OLD.settled_at IS NOT NULL THEN RETURN NULL; END IF;
  PERFORM public.fn_ca_escrow_apply(NEW.tournament_id, 'fee settlement', p_fee_out => round(COALESCE(NEW.amount, 0), 2));
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_escrow_on_rake_settlement() FROM PUBLIC, anon, authenticated;

-- ── The close (R5): a bank not at zero at COMPLETED is an incident ─────────
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_close()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v public.tournament_escrow%ROWTYPE; v_tot numeric;
BEGIN
  IF NEW.status <> 'COMPLETED' OR OLD.status = 'COMPLETED' THEN RETURN NULL; END IF;
  SELECT * INTO v FROM public.tournament_escrow WHERE tournament_id = NEW.id;
  IF NOT FOUND OR NOT v.enforced THEN RETURN NULL; END IF;
  v_tot := round(v.prize_balance + v.bounty_balance + v.fee_balance, 2);
  UPDATE public.tournament_escrow SET closed_at = now(),
         close_note = CASE WHEN abs(v.prize_balance) <= 0.05 AND abs(v.bounty_balance) <= 0.05 THEN 'closed at zero'
                           ELSE format('closed with prize %s, bounty %s, fee %s left', v.prize_balance, v.bounty_balance, v.fee_balance) END
   WHERE tournament_id = NEW.id;
  -- The fee bank settles after COMPLETED (fn_settle_tournament_rake runs on
  -- the completed event), so only prize and bounty are judged here.
  IF abs(v.prize_balance) > 0.05 OR abs(v.bounty_balance) > 0.05 THEN
    BEGIN
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_escrow_on_close', 'settlement_error', CASE WHEN v.prize_balance < -1 THEN 'warning' ELSE 'info' END,
        'escrow-close:' || NEW.id::text,
        v_tot, 0, v_tot, 'ledger', 'tournament', NEW.id, NEW.club_id, NEW.union_id, NULL, NEW.id, NULL, NULL, NULL, NULL,
        format('R5: %s reached COMPLETED with prize %s and bounty %s still in escrow (fee %s settles after close); the reconciler settles what is owed, and what is left after that is the epoch reset gate''s',
               COALESCE(NEW.name, NEW.id::text), v.prize_balance, v.bounty_balance, v.fee_balance),
        false, jsonb_build_object('prize_balance', v.prize_balance, 'bounty_balance', v.bounty_balance, 'fee_balance', v.fee_balance));
    EXCEPTION WHEN OTHERS THEN NULL;  -- a reporter never blocks a close
    END;
  END IF;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_escrow_on_close() FROM PUBLIC, anon, authenticated;

-- ── The settle function reads the balance, not the counter ────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_can_pay(p_tournament_id uuid, p_kind text, p_amount numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v public.tournament_escrow%ROWTYPE; v_have numeric;
BEGIN
  SELECT * INTO v FROM public.tournament_escrow WHERE tournament_id = p_tournament_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('known', false);
  END IF;
  v_have := CASE WHEN p_kind IN ('bounty', 'mystery_bounty', 'bounty_residual') THEN v.bounty_balance
                 WHEN p_kind = 'refund' THEN v.prize_balance + v.bounty_balance + v.fee_balance
                 ELSE v.prize_balance END;
  RETURN jsonb_build_object('known', true, 'enforced', v.enforced, 'available', v_have,
                            'ok', (NOT v.enforced) OR p_amount <= v_have + 0.005,
                            'prize_balance', v.prize_balance, 'bounty_balance', v.bounty_balance, 'fee_balance', v.fee_balance);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_escrow_can_pay(uuid, text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_escrow_can_pay(uuid, text, numeric) TO service_role;

-- ── fn_settle_tournament_obligation: the balance decides, the counter is the fallback ─
CREATE OR REPLACE FUNCTION public.fn_settle_tournament_obligation(p_tournament_id uuid, p_kind text, p_place integer, p_user_id uuid, p_amount numeric, p_source text, p_description text DEFAULT NULL::text, p_adjustment_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_kind        text := lower(btrim(COALESCE(p_kind, '')));
  v_row_kind    text;
  v_place       integer;
  v_amount      numeric := round(COALESCE(p_amount, 0), 2);
  v_t           record;
  v_ob          public.tournament_obligations%ROWTYPE;
  v_seeded_paid numeric := 0;
  v_owed        numeric;
  v_pay         numeric;
  v_key         text;
  v_category    text;
  v_desc        text;
  v_pool_kinds  text[] := ARRAY['place','late_reg_adjustment','bubble_protection','final_table_deal','satellite_remainder','seat'];
  -- Rows paid from the BOUNTY pool (or recorded on the target by a satellite),
  -- never from the prize pool. Everything else counts against the pool.
  v_not_pool    text[] := ARRAY['satellite_seat','bounty','mystery_bounty','bounty_residual','own_bounty','mystery_bounty_residual'];
  v_paid_pool   numeric := 0;
  v_credited    boolean;
  v_alert_ctx   jsonb;
  v_payout_source text;
  v_can         jsonb;
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
      'refused_reason', 'missing_ids', 'obligation_id', NULL, 'idempotency_key', NULL);
  END IF;
  IF v_kind NOT IN ('place','bounty','bounty_residual','mystery_bounty','refund','seat',
                    'satellite_remainder','bubble_protection','final_table_deal','late_reg_adjustment') THEN
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
      'refused_reason', 'unknown_kind', 'obligation_id', NULL, 'idempotency_key', NULL);
  END IF;
  IF v_amount < 0 THEN
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
      'refused_reason', 'negative_amount', 'obligation_id', NULL, 'idempotency_key', NULL);
  END IF;

  -- A late-registration top-up is the SAME obligation as the place it corrects:
  -- it carries the new total and the difference is what moves.
  v_row_kind := CASE WHEN v_kind = 'late_reg_adjustment' THEN 'place' ELSE v_kind END;
  v_place    := CASE WHEN v_row_kind IN ('place') THEN p_place ELSE NULL END;
  IF v_row_kind = 'place' AND v_place IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
      'refused_reason', 'place_required', 'obligation_id', NULL, 'idempotency_key', NULL);
  END IF;

  -- Kill switch (Lane E): an open freeze on tournament payouts refuses everything.
  IF to_regclass('public.ca_payout_freeze') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.ca_payout_freeze f
                WHERE f.scope = 'tournament_payouts' AND f.cleared_at IS NULL) THEN
      RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
        'refused_reason', 'payout_frozen', 'obligation_id', NULL, 'idempotency_key', NULL);
    END IF;
  END IF;

  SELECT t.id, t.name, t.club_id, t.prize_pool, t.bounty_pool, t.bounty_pool_paid, t.status
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
      'refused_reason', 'tournament_not_found', 'obligation_id', NULL, 'idempotency_key', NULL);
  END IF;

  -- Upsert the obligation. amount_owed only ever rises.
  IF v_place IS NOT NULL THEN
    SELECT * INTO v_ob FROM public.tournament_obligations
     WHERE tournament_id = p_tournament_id AND kind = v_row_kind AND place = v_place
     FOR UPDATE;
  ELSE
    SELECT * INTO v_ob FROM public.tournament_obligations
     WHERE tournament_id = p_tournament_id AND kind = v_row_kind AND place IS NULL AND user_id = p_user_id
     FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    -- Legacy seeding: what did the old key shapes already pay for this obligation?
    IF v_place IS NOT NULL THEN
      SELECT COALESCE(sum(tp.amount), 0) INTO v_seeded_paid
        FROM public.tournament_payouts tp
       WHERE tp.tournament_id = p_tournament_id AND tp."position" = v_place
         AND COALESCE(tp.source, '') NOT IN ('satellite_seat');
    ELSIF v_row_kind = 'refund' THEN
      SELECT COALESCE(sum(w.amount), 0) INTO v_seeded_paid
        FROM public.wallet_transactions w
       WHERE w.related_entity_id = p_tournament_id AND w.user_id = p_user_id
         AND w.type = 'credit' AND lower(w.category) IN ('refund','tournament_refund');
    END IF;
    v_seeded_paid := round(v_seeded_paid, 2);
    v_owed := GREATEST(v_amount, v_seeded_paid);

    INSERT INTO public.tournament_obligations
      (tournament_id, kind, place, user_id, amount_owed, amount_paid, source)
    VALUES (p_tournament_id, v_row_kind, v_place, p_user_id, v_owed, v_seeded_paid, p_source)
    RETURNING * INTO v_ob;
  ELSE
    IF v_amount > v_ob.amount_owed THEN
      UPDATE public.tournament_obligations
         SET amount_owed = v_amount, updated_at = now(), user_id = COALESCE(user_id, p_user_id)
       WHERE id = v_ob.id
       RETURNING * INTO v_ob;
    END IF;
  END IF;

  -- The player on record for a place is whoever was first paid for it; a
  -- different user asking for an already-paid place gets a refusal, not chips.
  IF v_place IS NOT NULL AND v_ob.user_id IS NOT NULL AND v_ob.user_id <> p_user_id AND v_ob.amount_paid > 0 THEN
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', v_ob.amount_paid,
      'refused_reason', 'place_paid_to_another_user', 'obligation_id', v_ob.id, 'idempotency_key', NULL);
  END IF;

  v_pay := round(LEAST(v_amount, v_ob.amount_owed) - v_ob.amount_paid, 2);
  IF v_pay <= 0 THEN
    RETURN jsonb_build_object('ok', true, 'paid', 0, 'already_paid', v_ob.amount_paid,
      'refused_reason', NULL, 'obligation_id', v_ob.id, 'idempotency_key', NULL);
  END IF;

  -- R2b: one finisher, one place.
  IF v_row_kind = 'place' THEN
    IF EXISTS (SELECT 1 FROM public.tournament_obligations o
                WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
                  AND o.user_id = p_user_id AND o.place <> v_place AND o.amount_paid > 0) THEN
      v_alert_ctx := jsonb_build_object('kind','second_place_prize_refused','tournament_id',p_tournament_id,
        'user_id',p_user_id,'place',v_place,'amount',v_pay,'source',p_source);
      PERFORM public.fn_raise_server_financial_alert('critical','fn_settle_tournament_obligation',
        format('Refused a second structure place: this player already holds a paid place in tournament %s', p_tournament_id),
        v_alert_ctx, 'obl:second_place:' || p_tournament_id::text || ':' || p_user_id::text);
      RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', v_ob.amount_paid,
        'refused_reason', 'player_already_holds_a_place', 'obligation_id', v_ob.id, 'idempotency_key', NULL);
    END IF;
  END IF;

  /* R1 (chip standard Phase 5.1, 2026-09-04): the ESCROW BALANCE decides.
     tournament_escrow holds what the event holds, per bank; a place is paid
     from the prize bank, a bounty from the bounty bank, a refund from all
     three. When the balance knows the event, the counter cap below is not
     consulted; the escrow trigger refuses again inside the credit if a race
     gets past this read. An event the balance has never seen (opened on its
     first row) keeps the old counter cap for this call. */
  v_can := public.fn_ca_escrow_can_pay(p_tournament_id, v_row_kind, v_pay);
  IF (v_can->>'known')::boolean AND NOT (v_can->>'ok')::boolean THEN
    v_alert_ctx := jsonb_build_object('kind','escrow_short','tournament_id',p_tournament_id,'tournament',v_t.name,
      'user_id',p_user_id,'obligation_kind',v_kind,'place',v_place,'requested',v_pay,
      'escrow_available',(v_can->>'available')::numeric,'prize_balance',(v_can->>'prize_balance')::numeric,
      'bounty_balance',(v_can->>'bounty_balance')::numeric,'fee_balance',(v_can->>'fee_balance')::numeric,'source',p_source);
    PERFORM public.fn_raise_server_financial_alert('critical','fn_settle_tournament_obligation',
      format('Refused %s to %s for %s: the escrow holds %s for that bank (%s)',
             v_pay, p_user_id, v_kind, (v_can->>'available')::numeric, v_t.name),
      v_alert_ctx, 'obl:escrow_short:' || v_ob.id::text);
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', v_ob.amount_paid,
      'refused_reason', 'escrow_short', 'obligation_id', v_ob.id, 'idempotency_key', NULL);
  END IF;

  -- R1-lite (counter cap), only for an event the balance has never seen.
  IF v_row_kind = ANY (v_pool_kinds) AND NOT (v_can->>'known')::boolean THEN
    SELECT COALESCE(sum(tp.amount), 0) INTO v_paid_pool
      FROM public.tournament_payouts tp
     WHERE tp.tournament_id = p_tournament_id
       AND NOT (COALESCE(tp.source, '') = ANY (v_not_pool));
    IF v_paid_pool + v_pay > COALESCE(v_t.prize_pool, 0) + 0.05 THEN
      v_alert_ctx := jsonb_build_object('kind','escrow_short','tournament_id',p_tournament_id,'tournament',v_t.name,
        'user_id',p_user_id,'obligation_kind',v_kind,'place',v_place,'requested',v_pay,
        'paid_from_pool_so_far',v_paid_pool,'prize_pool',v_t.prize_pool,'source',p_source);
      PERFORM public.fn_raise_server_financial_alert('critical','fn_settle_tournament_obligation',
        format('Refused %s to %s for %s: the prize pool of %s has already paid %s (%s)',
               v_pay, p_user_id, v_kind, round(COALESCE(v_t.prize_pool,0),2), v_paid_pool, v_t.name),
        v_alert_ctx, 'obl:escrow_short:' || v_ob.id::text);
      RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', v_ob.amount_paid,
        'refused_reason', 'escrow_short', 'obligation_id', v_ob.id, 'idempotency_key', NULL);
    END IF;
  END IF;

  /* THE KEY NAMES THE TOURNAMENT (Lane A3, 2026-09-02). fn_credit_player_wallet_once
     resolves WHICH club wallet to credit from a 'tourney:<id>:...' key
     (tournament_players.club_id for that entry); any other shape falls back to
     fn_player_home_club, which is the club the player joined FIRST, not the
     club they bought in from. Measured in the rolled-back probe: 3 of 4 places
     landed in the wrong club under the old 'obl:<id>:<n>' shape. No 'obl:' key
     was ever spent in production, so the rename costs nothing. */
  v_key := 'tourney:' || p_tournament_id::text || ':obl:' || v_ob.id::text || ':' || (round(v_ob.amount_paid * 100))::bigint::text;
  v_category := CASE
                  WHEN v_row_kind IN ('bounty','bounty_residual','mystery_bounty') THEN 'bounty'
                  WHEN v_row_kind = 'refund' THEN 'refund'
                  ELSE 'prize'
                END;
  /* THE PAYOUT RECORD KEEPS ITS CLASS (2026-09-02). tournament_payouts.source is
     the CLASS of a payment ('structure', 'reconcile', 'late_reg_adjustment',
     'final_table_deal', ...) and every detector downstream filters on it:
     fn_tournament_guarantee_check and fn_tournament_double_paid_obligations
     whitelist it, fn_payout_guarantee_check blacklists the bounty classes. The
     engine calls this function with its own provenance ('engine.finishTournament'
     and friends), which the first build wrote straight into that column - so
     the moment the engine cut over, the guarantee check would have counted
     every engine-paid place as unpaid. Provenance stays on
     tournament_obligations.source; the payout row gets the class. */
  v_payout_source := CASE
    WHEN lower(COALESCE(p_source, '')) IN ('structure','reconcile','hu_shortfall','spin_backpay',
         'overlay_backpay','late_reg_adjustment','final_table_deal','bubble_protection',
         'satellite_remainder','clawback') THEN lower(p_source)
    WHEN v_kind = 'late_reg_adjustment' THEN 'late_reg_adjustment'
    WHEN v_row_kind IN ('final_table_deal','bubble_protection','satellite_remainder') THEN v_row_kind
    ELSE 'structure'
  END;
  v_desc := COALESCE(NULLIF(btrim(p_description), ''),
              CASE
                WHEN v_row_kind = 'place' THEN format('Tournament prize: position %s', v_place)
                WHEN v_row_kind = 'refund' THEN 'Tournament refund'
                ELSE format('Tournament %s', replace(v_row_kind, '_', ' '))
              END);

  PERFORM set_config('app.money_path', 'fn_settle_tournament_obligation', true);

  -- Guard against a key that was already spent while the obligation says otherwise:
  -- that means the obligation row was rebuilt without its payments, and paying
  -- again would be exactly the bug this function exists to end.
  IF EXISTS (SELECT 1 FROM public.wallet_credit_idempotency k WHERE k.key = v_key) THEN
    RAISE EXCEPTION 'fn_settle_tournament_obligation: key % already spent while obligation % shows paid %; refusing',
      v_key, v_ob.id, v_ob.amount_paid;
  END IF;

  v_credited := public.fn_credit_and_log(
    p_user_id, v_pay, v_key, v_category, v_desc, p_tournament_id,
    'PLAYER', NULL, NULL,
    CASE WHEN v_category = 'prize' THEN v_place ELSE NULL END,
    CASE WHEN v_category = 'prize' THEN v_payout_source ELSE NULL END);

  PERFORM set_config('app.money_path', '', true);

  IF NOT v_credited THEN
    -- fn_credit_and_log returns false only when the key was already spent or a
    -- guard inside it refused; either way no chips moved for THIS call.
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', v_ob.amount_paid,
      'refused_reason', 'credit_refused', 'obligation_id', v_ob.id, 'idempotency_key', v_key);
  END IF;

  UPDATE public.tournament_obligations
     SET amount_paid = amount_paid + v_pay,
         user_id     = COALESCE(user_id, p_user_id),
         source      = COALESCE(p_source, source),
         updated_at  = now(),
         settled_at  = CASE WHEN amount_paid + v_pay >= amount_owed THEN now() ELSE settled_at END
   WHERE id = v_ob.id;

  RETURN jsonb_build_object('ok', true, 'paid', v_pay, 'already_paid', v_ob.amount_paid,
    'refused_reason', NULL, 'obligation_id', v_ob.id, 'idempotency_key', v_key);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_settle_tournament_obligation(uuid, text, integer, uuid, numeric, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_obligation(uuid, text, integer, uuid, numeric, text, text, uuid) TO service_role;

-- ── The balance against the shadow, hourly, from the shadow's own cron ────
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_balance_drift(p_hours integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r record; e record; v_n int := 0; v_bad int := 0; v_list jsonb := '[]'::jsonb;
BEGIN
  FOR r IN SELECT x.* FROM public.tournament_escrow x
            WHERE x.updated_at > now() - make_interval(hours => GREATEST(COALESCE(p_hours, 3), 1))
              AND x.updated_at < now() - interval '2 minutes'   -- a row mid-flight is not a finding
            ORDER BY x.updated_at DESC LIMIT 5000
  LOOP
    v_n := v_n + 1;
    SELECT * INTO e FROM public.fn_ca_tournament_escrow(r.tournament_id);
    IF abs(r.prize_balance - e.prize_balance) > 0.01 OR abs(r.bounty_balance - e.bounty_balance) > 0.01 OR abs(r.fee_balance - e.fee_balance) > 0.01 THEN
      v_bad := v_bad + 1;
      IF v_bad <= 20 THEN
        v_list := v_list || jsonb_build_object('tournament_id', r.tournament_id,
                    'balance', jsonb_build_object('prize', r.prize_balance, 'bounty', r.bounty_balance, 'fee', r.fee_balance),
                    'shadow', jsonb_build_object('prize', e.prize_balance, 'bounty', e.bounty_balance, 'fee', e.fee_balance));
      END IF;
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_escrow_balance_drift', 'settlement_error', 'warning',
        'escrow-balance-drift:' || r.tournament_id::text,
        round((r.prize_balance + r.bounty_balance + r.fee_balance) - (e.prize_balance + e.bounty_balance + e.fee_balance), 2),
        round(e.prize_balance + e.bounty_balance + e.fee_balance, 2), round(r.prize_balance + r.bounty_balance + r.fee_balance, 2),
        'ledger', 'tournament', r.tournament_id, NULL, NULL, NULL, r.tournament_id, NULL, NULL, NULL, NULL,
        format('the maintained escrow balance (prize %s, bounty %s, fee %s) disagrees with the shadow (prize %s, bounty %s, fee %s): a path wrote an operational row the escrow triggers do not read, or the other way round',
               r.prize_balance, r.bounty_balance, r.fee_balance, e.prize_balance, e.bounty_balance, e.fee_balance),
        false, jsonb_build_object('tournament_id', r.tournament_id));
    END IF;
  END LOOP;
  RETURN jsonb_build_object('checked', v_n, 'disagree', v_bad, 'sample', v_list);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_escrow_balance_drift(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_escrow_balance_drift(integer) TO service_role;

DO $$
DECLARE v_cmd text; v_id bigint;
BEGIN
  SELECT jobid, command INTO v_id, v_cmd FROM cron.job WHERE jobname = 'ca-escrow-shadow-hourly';
  IF v_id IS NULL THEN RAISE EXCEPTION 'ca-escrow-shadow-hourly is not scheduled'; END IF;
  IF v_cmd NOT LIKE '%fn_ca_escrow_balance_drift%' THEN
    -- The existing command is kept verbatim; one statement is appended.
    PERFORM cron.alter_job(v_id, command => rtrim(v_cmd, E' \n;') || E';\n          SELECT (public.fn_ca_escrow_balance_drift(3))::text;');
  END IF;
END $$;

INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  ('fn_ca_escrow_apply', 'approved', 'chip standard Phase 5.1 (2026-09-04): the one door that moves tournament_escrow, called by the five escrow triggers; refuses an outflow that would take a bank below zero; moves no wallet'),
  ('fn_ca_escrow_can_pay', 'approved', 'chip standard Phase 5.1 (2026-09-04): reads the escrow for fn_settle_tournament_obligation; moves nothing'),
  ('fn_ca_escrow_balance_drift', 'approved', 'chip standard Phase 5.1 (2026-09-04): hourly balance-vs-shadow comparison; moves nothing')
ON CONFLICT (proname) DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes;

