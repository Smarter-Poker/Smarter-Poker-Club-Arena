-- 20260905074227_phase_5_2_the_spin_escrow_reads_the_reserve.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (chip standard Phase 5.2, 2026-09-05 07:5x UTC):
--
-- Four hourly supply snapshots under the Phase 5.1 meter read -614.93, -75.45,
-- -85.37 and -156.92 unexplained. Decomposed against the journal for the
-- 06:05-07:05 hour, every account class matched its legs to the cent except
-- tournament_liability (-153.80) and the felt (-3.19). Read per event over a
-- five minute window, every mismatch was a SPIN: the meter read spins from the
-- counters (prize_pool + total_rake), and a spin's counter is its multiplier
-- prize from creation to completion, while the journal moves its money in
-- five steps (entries into prize_liability; prize_liability -> spin_reserve
-- when the pool fills; spin_reserve -> prize_liability at the draw; the prize
-- out; the fee out). The two agree at no instant, so every hour's boundary
-- lands somewhere on that curve and the difference shows as drift. It is an
-- oscillation, not a leak, and it is exactly what part four traded for
-- (reading spins from an escrow that did not know the reserve double-counted
-- their entries).
--
-- The escrow now knows the reserve: two components, reserve_out and
-- reserve_in, fed by the legs the engine already writes (spin_entry,
-- spin_prize) through one trigger on chip_ledger, and the prize bank is
--   (gross_in - fee_entries_in - bounty_in) + overlay_in + satellite_in
--   - reserve_out + reserve_in - prize_out - refund_prize.
-- Backfilled from the legs for every spin row: all 1,699 completed spins read
-- 0.00 to the cent (measured 07:40 UTC; a COMPLETING spin still holds its
-- drawn prize until the payout lands and its fee until settlement), so the
-- meter reads the escrow for every event with a row and the counters only for
-- an event with no row yet. The step the meter takes when it stops believing
-- the spin counters (counters exceeded the exact banks by 237.92 over 117 live
-- spins at 07:41) is recorded on the Mint register as a labelled baseline
-- correction, asserted in band; the shadow comparison learns the reserve
-- terms. Spins stay tracked, not refused (enforced = false): the banks are
-- now exact, and a soak of measured non-negative live banks precedes the flip.
--
-- The trigger on chip_ledger is created LAST and this migration is applied
-- inside the :55 platform freeze (trigger DDL on a hot table deadlocks against
-- live multi-table writers outside it; measured twice on 09-04).
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

ALTER TABLE public.tournament_escrow
  ADD COLUMN IF NOT EXISTS reserve_out numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reserve_in  numeric NOT NULL DEFAULT 0;
COMMENT ON COLUMN public.tournament_escrow.reserve_out IS 'Phase 5.2: what left the prize bank for spin_reserve when the spin pool filled (spin_entry legs)';
COMMENT ON COLUMN public.tournament_escrow.reserve_in  IS 'Phase 5.2: what the draw brought back from spin_reserve as this spin''s prize (spin_prize legs)';
COMMENT ON TABLE public.tournament_escrow IS 'The tournament escrow as a BALANCE (chip standard Phase 5.1, reserve-aware since 5.2). prize_balance = (gross_in - fee_entries_in - bounty_in) + overlay_in + satellite_in - reserve_out + reserve_in - prize_out - refund_prize; bounty_balance = bounty_in - bounty_out - refund_bounty; fee_balance = fee_entries_in + satellite_fee_in - fee_out - refund_fee. Maintained by triggers in the same transaction as each operational row; an outflow that would take a bank below zero is refused where enforced. enforced=false for spins: tracked exactly, not yet refused.';

-- The one door grows two components; the 12-argument shape is dropped so a
-- named-argument call cannot be ambiguous between the two.
DROP FUNCTION public.fn_ca_escrow_apply(uuid, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric);
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
  v_outflow boolean := COALESCE(p_prize_out, 0) > 0 OR COALESCE(p_bounty_out, 0) > 0 OR COALESCE(p_fee_out, 0) > 0 OR COALESCE(p_refund, 0) > 0 OR COALESCE(p_reserve_out, 0) > 0;
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
      (p_tournament_id, NOT v_spin,
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
$function$
;
REVOKE ALL ON FUNCTION public.fn_ca_escrow_apply(uuid, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_escrow_apply(uuid, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric) TO service_role;

-- chip_ledger: the reserve legs the engine writes for a spin
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_reserve_leg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.category = 'spin_entry' THEN
    PERFORM public.fn_ca_escrow_apply(NEW.from_entity_id, 'spin pool to reserve', p_reserve_out => round(NEW.amount, 2));
  ELSIF NEW.category = 'spin_prize' THEN
    PERFORM public.fn_ca_escrow_apply(NEW.to_entity_id, 'spin prize from reserve', p_reserve_in => round(NEW.amount, 2));
  END IF;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_escrow_on_reserve_leg() FROM PUBLIC, anon, authenticated;

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
    IF abs(r.prize_balance - (e.prize_balance - r.reserve_out + r.reserve_in)) > 0.01 OR abs(r.bounty_balance - e.bounty_balance) > 0.01 OR abs(r.fee_balance - e.fee_balance) > 0.01 THEN
      v_bad := v_bad + 1;
      IF v_bad <= 20 THEN
        v_list := v_list || jsonb_build_object('tournament_id', r.tournament_id,
                    'balance', jsonb_build_object('prize', r.prize_balance, 'bounty', r.bounty_balance, 'fee', r.fee_balance),
                    'shadow', jsonb_build_object('prize', e.prize_balance - r.reserve_out + r.reserve_in, 'bounty', e.bounty_balance, 'fee', e.fee_balance));
      END IF;
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_escrow_balance_drift', 'settlement_error', 'warning',
        'escrow-balance-drift:' || r.tournament_id::text,
        round((r.prize_balance + r.bounty_balance + r.fee_balance) - (e.prize_balance - r.reserve_out + r.reserve_in + e.bounty_balance + e.fee_balance), 2),
        round(e.prize_balance - r.reserve_out + r.reserve_in + e.bounty_balance + e.fee_balance, 2), round(r.prize_balance + r.bounty_balance + r.fee_balance, 2),
        'ledger', 'tournament', r.tournament_id, NULL, NULL, NULL, r.tournament_id, NULL, NULL, NULL, NULL,
        format('the maintained escrow balance (prize %s, bounty %s, fee %s) disagrees with the shadow (prize %s, bounty %s, fee %s): a path wrote an operational row the escrow triggers do not read, or the other way round',
               r.prize_balance, r.bounty_balance, r.fee_balance, e.prize_balance, e.bounty_balance, e.fee_balance),
        false, jsonb_build_object('tournament_id', r.tournament_id));
    END IF;
  END LOOP;
  RETURN jsonb_build_object('checked', v_n, 'disagree', v_bad, 'sample', v_list);
END;
$function$
;
REVOKE ALL ON FUNCTION public.fn_ca_escrow_balance_drift(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_escrow_balance_drift(integer) TO service_role;

-- Backfill every spin row from its legs, then recompute its banks.
WITH legs AS (
  SELECT COALESCE(CASE WHEN l.category = 'spin_entry' THEN l.from_entity_id END, l.to_entity_id) AS tid,
         sum(l.amount) FILTER (WHERE l.category = 'spin_entry') AS r_out,
         sum(l.amount) FILTER (WHERE l.category = 'spin_prize') AS r_in
    FROM public.chip_ledger l
   WHERE l.category IN ('spin_entry', 'spin_prize')
   GROUP BY 1
)
UPDATE public.tournament_escrow e
   SET reserve_out = round(COALESCE(legs.r_out, 0), 2),
       reserve_in  = round(COALESCE(legs.r_in, 0), 2)
  FROM legs
 WHERE legs.tid = e.tournament_id AND NOT e.enforced;
UPDATE public.tournament_escrow
   SET prize_balance = round((gross_in - fee_entries_in - bounty_in) + overlay_in + satellite_in - reserve_out + reserve_in - prize_out - refund_prize, 2)
 WHERE NOT enforced;

DO $$
DECLARE v_closed_nonzero int; v_spins int; v_neg int;
BEGIN
  -- COMPLETING is not judged: a spin there still holds its drawn prize until the payout lands, and its fee until settlement.
  SELECT count(*) FILTER (WHERE t.status IN ('COMPLETED','CANCELLED') AND (abs(e.prize_balance) > 0.005 OR abs(e.fee_balance) > 0.005)),
         count(*),
         count(*) FILTER (WHERE e.prize_balance < -0.005)
    INTO v_closed_nonzero, v_spins, v_neg
    FROM public.tournament_escrow e JOIN public.tournaments t ON t.id = e.tournament_id WHERE NOT e.enforced;
  IF v_spins < 1500 THEN RAISE EXCEPTION 'expected the spin escrow rows, found %', v_spins; END IF;
  IF v_closed_nonzero <> 0 THEN RAISE EXCEPTION '% closed spins do not read zero with the reserve terms', v_closed_nonzero; END IF;
  IF v_neg <> 0 THEN RAISE EXCEPTION '% spin prize banks read negative with the reserve terms', v_neg; END IF;
  RAISE NOTICE 'spin escrow backfilled: % rows, every closed one at zero, none negative', v_spins;
END $$;

-- The definitional step, recorded before the meter changes: counters vs exact
-- banks over the live spins, this instant.
DO $$
DECLARE v_delta numeric; v_n int; v_supply numeric;
BEGIN
  SELECT round(sum(COALESCE(t.prize_pool,0) + COALESCE(t.bounty_pool,0) - COALESCE(t.bounty_pool_paid,0) + COALESCE(t.total_rake,0)
                   - (e.prize_balance + e.bounty_balance + e.fee_balance)), 2), count(*)
    INTO v_delta, v_n
    FROM public.tournaments t JOIN public.tournament_escrow e ON e.tournament_id = t.id
   WHERE t.status NOT IN ('COMPLETED','CANCELLED') AND NOT e.enforced;
  IF v_n < 30 THEN RAISE EXCEPTION 'expected the live spins, found %', v_n; END IF;
  -- The offset swings both ways (a spin's counter is its multiplier prize
  -- from creation; the exact bank is below it while the pool fills and above
  -- it after a large draw): +237.92 at 07:41, +421.64 at 07:45, -22.56 at
  -- 07:55. The sign decides mint or burn; the size is bounded.
  IF abs(v_delta) > 1500 THEN
    RAISE EXCEPTION 'the spin step reads % over % spins, further from zero than the spins could carry', v_delta, v_n;
  END IF;
  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) - v_delta INTO v_supply
    FROM public.ca_mint_ledger WHERE asset = 'chips';
  INSERT INTO public.ca_mint_ledger
    (op_id, action, asset, holder_type, holder_id, holder_label, amount, balance_before, balance_after, supply_after, reason, performed_by_label)
  VALUES
    ('register-opening-baseline-correction:supply-meter-redefinition:2026-09-05-spins', CASE WHEN v_delta >= 0 THEN 'burn' ELSE 'mint' END, 'chips', 'circulation',
     '00000000-0000-0000-0000-00000000c1c0', 'circulation', abs(v_delta), abs(v_delta), 0, v_supply,
     format('OPENING BASELINE CORRECTION, not a retirement: since part four the meter read a spin''s liability from its counters (the multiplier prize from creation to completion), which the journal never holds at any single instant; since Phase 5.2 it reads the spin escrow, which carries the reserve legs and is exact. The counters differed from the exact banks by %s (counters minus exact) over %s live spins at %s UTC. No chip moved.', v_delta, v_n, to_char(clock_timestamp(), 'YYYY-MM-DD HH24:MI')),
     'chip standard Phase 5.2');
  UPDATE public.ca_drift_incidents
     SET status = 'resolved', resolved_at = now(),
         correction_ref = 'migration 20260905074227_phase_5_2_the_spin_escrow_reads_the_reserve',
         root_cause = 'the supply meter read spin liability from counters that agree with the journal at no instant (multiplier prize from creation to completion, while the money moves through spin_reserve in five legs); each hourly boundary landed elsewhere on that curve, so the hour read as drift; 3 BBJ legs were also refused by the platform freeze while their bank writes stood (separate migration)',
         resolution = format('the spin escrow carries reserve_out/reserve_in and reads exact (every closed spin at 0.00); the meter reads the escrow for every event with a row; the step (%s over %s live spins) is a labelled register correction', v_delta, v_n)
   WHERE dedupe_key = 'supply-unexplained:2026-09-05-07' AND status = 'open';
  RAISE NOTICE 'spin step % over % live spins recorded as a baseline correction', v_delta, v_n;
END $$;

CREATE OR REPLACE FUNCTION public.fn_ca_supply_snapshot()
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  s RECORD; prev RECORD; v_mint numeric; v_burn numeric; v_unexplained numeric;
  v_total numeric; v_trailing numeric; v_prev_unexplained numeric; v_critical boolean;
  v_outside text[] := public.fn_ca_noncirculating_chip_stores();
BEGIN
  SELECT
    (SELECT COALESCE(sum(chip_balance),0) FROM club_members)            AS member_wallets,
    (SELECT COALESCE(sum(promo_balance),0) FROM club_members)           AS member_promo,
    (SELECT COALESCE(sum(stack),0) FROM table_seats
      WHERE left_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM tables t
                         WHERE t.id = table_seats.table_id
                           AND t.tournament_id IS NOT NULL))            AS felt,
    (SELECT COALESCE(sum(chip_treasury),0) FROM clubs)                  AS treasuries,
    (SELECT COALESCE(sum(chip_pool),0) FROM clubs)                      AS chip_pools,
    /* CHIP STANDARD (2026-09-03): the club-held promo and insurance floats are
       chips like any other. They were outside the total, so every BBJ promo
       sweep into a standalone club read as chips leaving the world. */
    (SELECT COALESCE(sum(promo_balance),0) FROM clubs)                  AS club_promo,
    (SELECT COALESCE(sum(insurance_balance),0) FROM clubs)              AS club_insurance,
    (SELECT COALESCE(sum(chip_balance),0) FROM club_wallets)            AS club_wallets,
    (SELECT COALESCE(sum(chip_balance+rake_wallet+bbj_wallet+promo_wallet
             +insurance_wallet+COALESCE(spin_reserve_wallet,0)),0)
       FROM union_wallets)                                              AS union_wallets,
    (SELECT COALESCE(sum(COALESCE(agent_wallet_balance,0)
             +COALESCE(promo_wallet_balance,0)),0) FROM agents)         AS agent_wallets,
    (SELECT COALESCE(sum(COALESCE(promo_wallet_balance,0)),0) FROM agents) AS agent_promo,
    (SELECT COALESCE(sum(main_balance+backup_balance+promo_balance),0)
       FROM bbj_pools)                                                  AS bbj,
    (SELECT COALESCE(sum(balance),0) FROM spin_bonus_pools)             AS spin,
    /* CHIP STANDARD PHASE 5.1 (2026-09-05): a tournament's liability is its
       ESCROW BALANCE where the balance enforces the event (every non-spin
       event with a row since part two), and the old counters where it does
       not: an event with no row yet, and every SPIN, whose money sits in
       spin_reserve until the draw funds its prize and whose escrow row is
       tracked, not enforced (part four: reading spins from the escrow
       double-counted their entries against the reserve). */
    /* PHASE 5.2 (2026-09-05): the spin escrow now carries the reserve legs
       (reserve_out at pool completion, reserve_in at the draw), so its banks
       are exact and journal-consistent; the meter reads the escrow for EVERY
       event with a row, and the counters only for an event with no row yet. */
    (SELECT COALESCE(sum(COALESCE(e.prize_balance + e.bounty_balance + e.fee_balance,
                                  COALESCE(t.prize_pool,0) + COALESCE(t.bounty_pool,0)
                                  - COALESCE(t.bounty_pool_paid,0) + COALESCE(t.total_rake,0))),0)
       FROM tournaments t
       LEFT JOIN public.tournament_escrow e ON e.tournament_id = t.id
      WHERE t.status NOT IN ('COMPLETED','CANCELLED'))                  AS tourn_liab,
    (SELECT COALESCE(sum(leaderboard_seed_remaining),0)
       FROM club_opening_setups)                                        AS lb_liab,
    /* phase 4: cert-held chips, reported not excluded */
    (SELECT COALESCE(sum(cm.chip_balance),0)
       FROM club_members cm
      WHERE public.fn_ca_is_cert_account(cm.user_id))                   AS cert_w
  INTO s;

  v_total := s.member_wallets + s.member_promo + s.felt + s.treasuries + s.chip_pools
           + s.club_promo + s.club_insurance
           + s.club_wallets + s.union_wallets + s.agent_wallets + s.bbj + s.spin + s.tourn_liab + s.lb_liab;

  SELECT * INTO prev FROM public.ca_supply_snapshots ORDER BY taken_at DESC LIMIT 1;
  v_prev_unexplained := CASE WHEN prev.id IS NULL THEN NULL ELSE prev.unexplained END;

  IF prev.id IS NOT NULL THEN
    -- Symmetric: out of a non-circulating store is issuance, into one is
    -- retirement. A store-to-store row appears in each sum once and nets to
    -- zero, which is correct -- it never touched circulation.
    SELECT COALESCE(sum(amount) FILTER (WHERE from_type = ANY(v_outside)),0),
           COALESCE(sum(amount) FILTER (WHERE to_type   = ANY(v_outside)),0)
      INTO v_mint, v_burn
      FROM public.chip_ledger
     WHERE created_at > prev.taken_at
       /* A correction moves no balance (see a_correction_is_not_a_mint):
          counting it as issuance invents drift equal to itself. */
       AND NOT (category = 'correction'
                AND metadata->>'posted_via' = 'fn_ca_post_correction');
  END IF;

  INSERT INTO public.ca_supply_snapshots
    (member_wallets, member_promo, felt, treasuries, chip_pools, club_wallets,
     union_wallets, agent_wallets, bbj_pools, spin_pools, tournament_liability,
     leaderboard_liability, cert_wallets, club_promo, club_insurance, agent_promo, total,
     mint_since_prev, burn_since_prev, delta_vs_prev, unexplained)
  VALUES
    (s.member_wallets, s.member_promo, s.felt, s.treasuries, s.chip_pools,
     s.club_wallets, s.union_wallets, s.agent_wallets, s.bbj, s.spin, s.tourn_liab,
     s.lb_liab, s.cert_w, s.club_promo, s.club_insurance, s.agent_promo, v_total,
     v_mint, v_burn,
     CASE WHEN prev.id IS NULL THEN NULL ELSE v_total - prev.total END,
     CASE WHEN prev.id IS NULL OR prev.tournament_liability IS NULL
            OR prev.leaderboard_liability IS NULL THEN NULL
          ELSE v_total - prev.total - COALESCE(v_mint,0) + COALESCE(v_burn,0) END)
  RETURNING unexplained INTO v_unexplained;

  SELECT COALESCE(sum(unexplained), 0) INTO v_trailing
    FROM public.ca_supply_snapshots
   WHERE taken_at > now() - interval '4 hours' AND unexplained IS NOT NULL;

  IF v_unexplained IS NOT NULL AND abs(v_unexplained) > 100 AND abs(v_trailing) > 300 THEN
    v_critical := abs(v_unexplained) > 25000
               OR (abs(v_trailing) > 2000
                   AND v_prev_unexplained IS NOT NULL
                   AND abs(v_prev_unexplained) > 100
                   AND sign(v_prev_unexplained) = sign(v_unexplained));
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_supply_snapshot', 'ledger_imbalance',
      CASE WHEN v_critical THEN 'critical' ELSE 'warning' END,
      'supply-unexplained:' || to_char(now(), 'YYYY-MM-DD-HH24'),
      v_unexplained, prev.total + COALESCE(v_mint,0) - COALESCE(v_burn,0), v_total,
      'ledger', 'ca_supply_snapshots', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'total chip supply changed by ' || round(v_unexplained,2)
        || ' beyond ledgered issuance/retirement this interval; trailing 4h net '
        || round(v_trailing,2)
        || CASE WHEN v_critical THEN ' - SAME-SIGN across consecutive intervals (a leak persists, oscillation flips)'
                ELSE ' (single-interval swing; previous interval did not agree in sign)' END,
      false, jsonb_build_object('trailing_4h', round(v_trailing,2),
                                 'prev_unexplained', round(COALESCE(v_prev_unexplained,0),2)));
  END IF;

  RETURN v_unexplained;
END
$function$
;
REVOKE ALL ON FUNCTION public.fn_ca_supply_snapshot() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_supply_snapshot() TO service_role;

INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  ('fn_ca_escrow_on_reserve_leg', 'approved', 'chip standard Phase 5.2 (2026-09-05): trigger function on chip_ledger reserve legs (spin_entry, spin_prize) feeding the spin escrow through fn_ca_escrow_apply; moves no wallet')
ON CONFLICT (proname) DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes;

-- LAST: the trigger on the hot table (applied inside the freeze).
DROP TRIGGER IF EXISTS zz_ca_escrow_reserve_leg ON public.chip_ledger;
CREATE TRIGGER zz_ca_escrow_reserve_leg AFTER INSERT ON public.chip_ledger
  FOR EACH ROW WHEN (NEW.category IN ('spin_entry', 'spin_prize'))
  EXECUTE FUNCTION public.fn_ca_escrow_on_reserve_leg();
INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note)
VALUES ('chip_ledger', 'zz_ca_escrow_reserve_leg', 'chip standard Phase 5.2: maintains the spin escrow reserve_out/reserve_in from the spin_entry and spin_prize legs')
ON CONFLICT DO NOTHING;

COMMIT;
