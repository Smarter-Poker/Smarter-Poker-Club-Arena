-- THE OVERLAY ROW RETRIES A DEADLOCK, AND NAMES ITS BANK
-- Chip Accounting Standard S12 / R7 (2026-09-03, found by the pre-Phase-2
-- verification sweep, 15:40 UTC).
--
-- WHAT HAPPENED. At 00:31:49 UTC the lock trigger funded Late Night PKO
-- (PLO4) (1068cd04): it debited the Midway union bank 18.00 and raised the
-- pool from 432.00 to its 450.00 guarantee. Then its chip_ledger INSERT lost a
-- deadlock (40P01). The insert sits in its own BEGIN/EXCEPTION block, so the
-- subtransaction rolled back, the outer transaction committed, and the money
-- moved with no journal row. ca_ledger_write_failures 704 recorded it, the
-- trial balance carried union_banks -18.00 for sixteen hours, and the escrow
-- shadow reported the event as "held 1080, paid 1098". The row was restored
-- by hand at 15:5x UTC (chip_ledger correction:lwf:704). No player was short:
-- balances were right all along; the journal was one row short.
--
-- TWO THINGS WERE WRONG WITH THE FAILURE PATH, and this migration fixes both:
--
-- 1. A deadlock is transient. The other transaction wins, finishes, and the
--    same INSERT succeeds a moment later. The trigger now retries the journal
--    row up to three times on 40P01 (and only on 40P01: any other SQLSTATE is
--    a real refusal and is recorded at once, exactly as before). Nothing else
--    in the trigger changes: the bank debit and the pool top-up are the same
--    statements in the same order.
--
-- 2. The failure message did not name the bank it debited. The estate's
--    repair primitive, fn_ca_repair_write_failure, reads the store from the
--    message ('union_wallets.chip_balance' -> union_bank,
--    'clubs.chip_treasury' -> club_treasury); with neither string present it
--    fell through to club_treasury, so an operator repairing 704 the standard
--    way would have posted the row from the wrong account. The message now
--    carries the store name, so the existing repair maps it correctly.
--
-- AND THE SHADOW LEARNS TO SEE A RESTORED ROW. fn_ca_tournament_escrow counts
-- overlay only from category 'overlay'. A row restored through
-- fn_ca_post_correction is category 'correction' (the primitive fixes the
-- category, on purpose - a correction must read as a correction). A
-- correction from a bank INTO prize_liability is, by definition, a restored
-- overlay, so the shadow now counts those too. The shadow is read-only; this
-- changes what it reports, never what anything pays.
--
-- Two CREATE OR REPLACE statements, one transaction. The trigger
-- zz_ca_fund_overlay_on_lock is untouched.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_ca_fund_overlay_on_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_short numeric; v_union uuid; v_bank numeric; v_from text; v_store text;
  v_st text; v_msg text; v_pool_before numeric;
  v_entrants int; v_places int; v_existing jsonb;
  v_guarantee numeric; v_seat_guarantee numeric; v_target uuid;
  v_attempt int; v_written boolean := false;
BEGIN
  IF NOT (COALESCE(OLD.status,'') IN ('ANNOUNCED','REGISTERING')
          AND NEW.status IN ('RUNNING','COMPLETING','COMPLETED')) THEN
    RETURN NEW;
  END IF;

  /* ── 1. payout table, from the field that actually entered ─────────────
     Only when nobody has registered yet. With registrations present,
     fn_guard_managed_game_lifecycle protects payout_structure and this
     trigger currently runs BEFORE it, so writing here refuses the whole
     start. Re-enabled once the trigger is renamed to sort after the guard.

     NOT FOR A SPIN (2026-09-02). A Spin's ladder comes from the tier the
     wheel drew - 10x is 80/20 - and this rule is "pay the top N% of the
     field", which on three seats rounds to one place and silently replaced
     every high multiplier with winner-take-all. 32 games, 1,592 chips. */
  SELECT count(*) INTO v_entrants
    FROM public.tournament_players tp WHERE tp.tournament_id = NEW.id;

  IF NEW.variant IS DISTINCT FROM 'spin' THEN
    IF v_entrants > 0 AND NOT EXISTS (
         SELECT 1 FROM pg_trigger tg
          WHERE tg.tgrelid = 'public.tournaments'::regclass
            AND tg.tgname = 'zz_ca_fund_overlay_on_lock')
    THEN
      NULL;  -- stand down: the guard would refuse the start
    ELSIF v_entrants > 0 THEN
      v_places := GREATEST(1, LEAST(v_entrants,
                    ceil(v_entrants * COALESCE(NEW.payout_percent,10) / 100.0)::int));
      BEGIN
        v_existing := NULLIF(btrim(COALESCE(NEW.payout_structure,'')), '')::jsonb;
      EXCEPTION WHEN OTHERS THEN v_existing := NULL; END;

      IF v_existing IS NULL
         OR jsonb_typeof(v_existing) <> 'array'
         OR jsonb_array_length(v_existing) = 0
         OR v_existing = '[{"place":1,"percentage":100}]'::jsonb
         OR jsonb_array_length(v_existing) <> v_places
      THEN
        NEW.payout_structure := public.fn_ca_payout_structure(
                                  v_entrants, COALESCE(NEW.payout_percent,10))::text;
      END IF;
    END IF;
  END IF;

  /* ── 2. the guarantee overlay, from the main bank ─────────────────────── */
  v_pool_before := round(COALESCE(NEW.prize_pool,0),2);
  v_guarantee   := round(COALESCE(NEW.guaranteed_prize,0),2);

  /* A GUARANTEED SEAT IS A GUARANTEE (2026-09-02). A satellite's advertised
     seats are worth target buy-in + fee each; the engine awards every one of
     them, so the bank funds the shortfall here, like any other guarantee. */
  IF NEW.variant = 'satellite' AND COALESCE(NEW.satellite_seats, 0) > 0 THEN
    v_target := COALESCE(NEW.satellite_target_id, NEW.satellite_target);
    IF v_target IS NOT NULL THEN
      SELECT round((COALESCE(t2.buy_in_amount,0) + COALESCE(t2.buy_in_fee,0)) * NEW.satellite_seats, 2)
        INTO v_seat_guarantee
        FROM public.tournaments t2 WHERE t2.id = v_target;
      v_guarantee := GREATEST(v_guarantee, COALESCE(v_seat_guarantee, 0));
    END IF;
  END IF;

  v_short := GREATEST(0, v_guarantee - v_pool_before);
  IF v_short <= 0 THEN RETURN NEW; END IF;

  PERFORM set_config('app.ledger_category', 'overlay', true);
  PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
  PERFORM set_config('app.ledger_counterparty_entity', NEW.id::text, true);

  v_union := CASE WHEN COALESCE(NEW.is_private,false) THEN NULL ELSE NEW.union_id END;

  IF v_union IS NOT NULL THEN
    SELECT chip_balance INTO v_bank FROM public.union_wallets
     WHERE union_id = v_union FOR UPDATE;
    v_from := 'union_bank';
    v_store := 'union_wallets.chip_balance';
    IF COALESCE(v_bank,0) < v_short THEN
      PERFORM public.fn_raise_server_financial_alert(
        'critical', 'fn_ca_fund_overlay_on_lock',
        format('%s needs %s chips of overlay to meet its %s guarantee and the union bank holds %s. The pool was NOT topped up.',
               COALESCE(NEW.name, NEW.id::text), v_short,
               v_guarantee, COALESCE(v_bank,0)),
        jsonb_build_object('kind','overlay_unfunded','tournament_id',NEW.id,
          'shortfall',v_short,'bank',COALESCE(v_bank,0)), NEW.id::text);
      RETURN NEW;
    END IF;
    PERFORM set_config('app.ledger_autoskip_union_wallets', '1', true);
    UPDATE public.union_wallets
       SET chip_balance = chip_balance - v_short, updated_at = now()
     WHERE union_id = v_union;
    PERFORM set_config('app.ledger_autoskip_union_wallets', '0', true);
  ELSE
    SELECT chip_treasury INTO v_bank FROM public.clubs
     WHERE id = NEW.club_id FOR UPDATE;
    v_from := 'club_treasury';
    v_store := 'clubs.chip_treasury';
    IF COALESCE(v_bank,0) < v_short THEN
      PERFORM public.fn_raise_server_financial_alert(
        'critical', 'fn_ca_fund_overlay_on_lock',
        format('%s needs %s chips of overlay to meet its %s guarantee and the club treasury holds %s. The pool was NOT topped up.',
               COALESCE(NEW.name, NEW.id::text), v_short,
               v_guarantee, COALESCE(v_bank,0)),
        jsonb_build_object('kind','overlay_unfunded','tournament_id',NEW.id,
          'shortfall',v_short,'bank',COALESCE(v_bank,0)), NEW.id::text);
      RETURN NEW;
    END IF;
    PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
    UPDATE public.clubs
       SET chip_treasury = COALESCE(chip_treasury,0) - v_short, updated_at = now()
     WHERE id = NEW.club_id;
    PERFORM set_config('app.ledger_autoskip_clubs', '0', true);
  END IF;

  NEW.prize_pool := round(v_pool_before + v_short, 2);

  /* THE JOURNAL ROW RETRIES A DEADLOCK (2026-09-03). 40P01 is transient: the
     other transaction finishes and the same INSERT succeeds. Three attempts;
     any other SQLSTATE is a real refusal and is recorded on the first try. */
  FOR v_attempt IN 1..3 LOOP
    BEGIN
      INSERT INTO public.chip_ledger (
        performed_by, from_type, from_entity_id, to_type, to_entity_id,
        amount, category, club_id, tournament_id, description)
      VALUES (
        COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
        v_from, COALESCE(v_union, NEW.club_id), 'prize_liability', NEW.id,
        v_short, 'overlay', NEW.club_id, NEW.id,
        format('Guarantee overlay from the main bank: %s (%s) was %s short of its %s guarantee - field made %s, bank paid %s',
               COALESCE(NEW.name, 'tournament'), NEW.id::text,
               v_short, v_guarantee,
               v_pool_before, v_short));
      v_written := true;
      EXIT;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_st = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      IF v_st = '40P01' AND v_attempt < 3 THEN
        CONTINUE;  -- deadlock: try the same row again
      END IF;
      /* The message names the store that moved, so fn_ca_repair_write_failure
         maps it to the right ledger account (union_bank / club_treasury). */
      BEGIN
        INSERT INTO public.ca_ledger_write_failures (club_id, user_id, delta, sqlstate, message)
        VALUES (NEW.club_id, NULL, v_short, v_st,
                'fn_ca_fund_overlay_on_lock ' || v_store
                || ' -> prize_liability (tournament ' || NEW.id::text || ', attempt '
                || v_attempt::text || '): ' || v_msg);
      EXCEPTION WHEN OTHERS THEN NULL; END;
      EXIT;
    END;
  END LOOP;

  RETURN NEW;
END;
$function$;

-- Trigger function: not callable by anyone directly. Restated for the repo's definer gate.
REVOKE ALL ON FUNCTION public.fn_ca_fund_overlay_on_lock() FROM PUBLIC, anon, authenticated;

-- ── The escrow shadow counts a restored overlay row ─────────────────────────
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
    round(rr.satellite_in, 2)                                     AS satellite_in,
    round(w.prize_out + sat.seats_out, 2)                         AS prize_out,
    round(w.bounty_out, 2)                                        AS bounty_out,
    round(fo.fee_out, 2)                                          AS fee_out,
    round(w.refund_out, 2)                                        AS refund_out
  FROM t, w, rr, ov, tgo, sat, fo
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

-- Self-check: the live definitions carry the retry, the store name, and the
-- restored-overlay clause; the trigger is still attached.
DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'fn_ca_fund_overlay_on_lock' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%FOR v_attempt IN 1..3 LOOP%' OR v_src NOT LIKE '%40P01%' THEN
    RAISE EXCEPTION 'the overlay journal row does not retry a deadlock';
  END IF;
  IF v_src NOT LIKE '%union_wallets.chip_balance%' OR v_src NOT LIKE '%clubs.chip_treasury%' THEN
    RAISE EXCEPTION 'the failure message does not name its bank';
  END IF;
  IF v_src NOT LIKE '%v_guarantee := GREATEST(v_guarantee, COALESCE(v_seat_guarantee, 0))%' THEN
    RAISE EXCEPTION 'the satellite seat guarantee did not survive the rewrite';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.tournaments'::regclass
                    AND tgname = 'zz_ca_fund_overlay_on_lock' AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'zz_ca_fund_overlay_on_lock is not attached and enabled';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'fn_ca_tournament_escrow' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%a.category = ''correction'' AND a.from_type IN (''union_bank'',''club_treasury'')%' THEN
    RAISE EXCEPTION 'the escrow shadow does not count a restored overlay';
  END IF;
END $$;

COMMIT;
