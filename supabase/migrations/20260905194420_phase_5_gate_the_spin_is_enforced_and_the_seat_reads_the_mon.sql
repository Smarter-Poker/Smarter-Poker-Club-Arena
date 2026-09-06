-- 20260905194420_phase_5_gate_the_spin_is_enforced_and_the_seat_reads_the_mon.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (chip standard Phase 5 gate, 2026-09-05 10:5x UTC):
--
-- Two findings of the gate before Phase 6, both read from production.
--
-- 1. THE SPIN IS ENFORCED. Phase 5.2 made a spin's banks exact; the flip to
--    enforced waited on a soak. Measured over 13,346 spins since 09-04: none
--    was paid before its draw, none was paid beyond what its bank held, 0
--    negative live banks in the three hours since the reserve terms landed.
--    Spins now open enforced and every existing spin row is enforced, so a
--    spin pays only what it holds and a close with prize left is judged like
--    any other event. One outflow is exempt from refusal by design: the
--    reserve_out that moves the filled pool into spin_reserve inside the
--    registration that filled it (its fee row can land a moment after the
--    leg within that transaction); it is the pool's own money on its way to
--    the draw, not a payment.
--
-- 2. THE SEAT READS THE MONEY THAT ARRIVED. A satellite seat credited the
--    target's escrow from the seat's rake_records row (pot minus fee, plus
--    the fee), the nominal value, while the money itself moves on the
--    satellite's pool_transfer leg, which is the nominal only when the
--    satellite pool covers it. Today the two agree on all 12 targets (0.00
--    apart), but a target with no fee writes no rake row and would have been
--    fed nothing, and a short satellite pool would have fed the nominal. The
--    target is now fed by the leg (what moved) through one more trigger on
--    chip_ledger, the fee row carries the fee only, and the shadow reads the
--    same. Every existing row is unchanged and asserted so.
--
-- The trigger on chip_ledger is created LAST and this migration is applied
-- inside the :55 platform freeze.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

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

CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_seat_transfer_leg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.fn_ca_escrow_apply(NEW.to_entity_id, 'satellite seat in', p_satellite_in => round(NEW.amount, 2));
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_escrow_on_seat_transfer_leg() FROM PUBLIC, anon, authenticated;

-- Every existing row: the nominal equalled what moved (measured 10:35 UTC over
-- all 12 targets), so no component changes hand; asserted.
DO $$
DECLARE v_off int; v_n int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE abs(e.satellite_in + e.satellite_fee_in - COALESCE(l.moved, 0)) > 0.005)
    INTO v_n, v_off
    FROM public.tournament_escrow e
    LEFT JOIN (SELECT to_entity_id tid, round(sum(amount), 2) moved FROM public.chip_ledger
                WHERE idempotency_key LIKE 'tourney:%:seat:%:pool_transfer' GROUP BY 1) l ON l.tid = e.tournament_id
   WHERE e.satellite_in > 0;
  IF v_off <> 0 THEN RAISE EXCEPTION '% of % satellite targets hold a nominal that differs from what moved', v_off, v_n; END IF;
END $$;

-- The spins: enforced, and proven safe to enforce.
DO $$
DECLARE v_neg int; v_early int;
BEGIN
  SELECT count(*) INTO v_neg FROM public.tournament_escrow e JOIN public.tournaments t ON t.id = e.tournament_id
   WHERE NOT e.enforced AND t.status NOT IN ('COMPLETED','CANCELLED') AND (e.prize_balance < -0.005 OR e.fee_balance < -0.005);
  IF v_neg <> 0 THEN RAISE EXCEPTION '% live spins read a negative bank; not enforcing', v_neg; END IF;
  WITH d AS (SELECT to_entity_id tid, min(created_at) draw_at FROM public.chip_ledger WHERE category = 'spin_prize' AND created_at > now() - interval '24 hours' GROUP BY 1),
       p AS (SELECT from_entity_id tid, min(created_at) pay_at FROM public.chip_ledger WHERE category = 'tournament_prize' AND from_type = 'prize_liability' AND created_at > now() - interval '24 hours' GROUP BY 1)
  SELECT count(*) INTO v_early FROM d JOIN p ON p.tid = d.tid WHERE p.pay_at < d.draw_at;
  IF v_early <> 0 THEN RAISE EXCEPTION '% spins were paid before their draw in 24h; not enforcing', v_early; END IF;
  UPDATE public.tournament_escrow SET enforced = true WHERE NOT enforced;
  RAISE NOTICE 'spins enforced';
END $$;

COMMENT ON TABLE public.tournament_escrow IS 'The tournament escrow as a BALANCE (chip standard Phase 5.1, reserve-aware since 5.2, enforced for every event since the Phase 5 gate). prize_balance = (gross_in - fee_entries_in - bounty_in) + overlay_in + satellite_in - reserve_out + reserve_in - prize_out - refund_prize; bounty_balance = bounty_in - bounty_out - refund_bounty; fee_balance = fee_entries_in + satellite_fee_in - fee_out - refund_fee. Maintained by triggers in the same transaction as each operational row; a payment or refund that would take a bank below zero is refused; a spin''s reserve_out is never refused.';

INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  ('fn_ca_escrow_on_seat_transfer_leg', 'approved', 'chip standard Phase 5 gate (2026-09-05): trigger function on the satellite pool_transfer leg feeding the target escrow satellite_in with what moved; moves no wallet')
ON CONFLICT (proname) DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes;

-- LAST: the trigger on the hot table (applied inside the freeze).
DROP TRIGGER IF EXISTS zz_ca_escrow_seat_transfer_leg ON public.chip_ledger;
CREATE TRIGGER zz_ca_escrow_seat_transfer_leg AFTER INSERT ON public.chip_ledger
  FOR EACH ROW WHEN (NEW.to_type = 'prize_liability' AND NEW.idempotency_key LIKE 'tourney:%:seat:%:pool_transfer')
  EXECUTE FUNCTION public.fn_ca_escrow_on_seat_transfer_leg();
INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note)
VALUES ('chip_ledger', 'zz_ca_escrow_seat_transfer_leg', 'chip standard Phase 5 gate: feeds the target escrow satellite_in from the satellite pool_transfer leg (what moved)')
ON CONFLICT (table_name, trigger_name) DO NOTHING;

COMMIT;
