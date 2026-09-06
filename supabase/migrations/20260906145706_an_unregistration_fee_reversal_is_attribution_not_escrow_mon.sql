-- AN UNREGISTRATION FEE REVERSAL IS ATTRIBUTION, NOT ESCROW MONEY.
--
-- The one fn_ca_escrow_vs_counter_check incident that 20260906145058 could
-- not close on re-read: Midweek Bounty (890de5a7), "prize 0.98, bounty 0.00,
-- fee -0.98 left in escrow. Held 600.00, paid 600.00." The money is exactly
-- right; the shadow's split of it is not.
--
-- READ FROM THE ROWS (2026-09-06 14:55 UTC): 60 entries at 10.00 (6 prize,
-- 3 bounty, 1 fee); one player unregistered on 09-01 and
-- fn_unregister_from_tournament refunded the whole 10.00 and wrote a -1.00
-- rake_records row. fn_ca_tournament_escrow counted that reversal, so
-- fee_in read 59 instead of 60 and prize_in 361 instead of 360; the 10.00
-- refund was then apportioned by 361:180:59 (6.02 / 3.00 / 0.98) instead of
-- the entry's own 6 / 3 / 1. Hence +0.98 on prize and -0.98 on fee, summing
-- to zero.
--
-- The 2026-09-05 chip standard already says a CANCEL's fee reversal is
-- attribution rather than escrow money and excludes it. An unregistration's
-- reversal is the identical case and is now excluded the same way. With it
-- excluded: prize 360 - 354 - 6 = 0.00, bounty 180 - 177 - 3 = 0.00,
-- fee 60 - 59 - 1 = 0.00.
--
-- BLAST RADIUS, measured before writing: exactly ONE completed non-spin event
-- in the last 7 days carries an fn_unregister_from_tournament reversal, and it
-- is this one. The migration asserts the event reads balanced after the
-- change, then lets the detector's own re-read (20260906145058) close the
-- incident. No chips move.

BEGIN;

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
    -- 2026-09-06 (20260906145706): an UNREGISTRATION's fee reversal is the
    -- same thing. fn_unregister_from_tournament refunds the whole entry and
    -- writes a negative rake row; counting that row here moved one chip from
    -- fee_in to prize_in and the pro-rata refund apportion then split a 10.00
    -- refund 6.02 / 3.00 / 0.98 against a real 6 / 3 / 1 - a zero-sum
    -- +0.98 / -0.98 residual on an event that held 600.00 and paid 600.00.
    AND NOT (rake_amount < 0
             AND source IN ('atomic_cancel_tournament', 'fn_unregister_from_tournament'))
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

DO $verify$
DECLARE e record; v_closed boolean; v_open int;
BEGIN
  SELECT * INTO e FROM public.fn_ca_tournament_escrow('890de5a7-abf6-40d9-868c-b8b3ecba4282');
  IF NOT (abs(e.prize_balance) <= 0.005 AND abs(e.bounty_balance) <= 0.005 AND abs(e.fee_balance) <= 0.005) THEN
    RAISE EXCEPTION 'VERIFY FAILED: Midweek Bounty still reads prize % bounty % fee % after excluding the unregistration reversal',
      e.prize_balance, e.bounty_balance, e.fee_balance;
  END IF;
  IF e.fee_in <> 60.00 OR e.prize_in <> 360.00 THEN
    RAISE EXCEPTION 'VERIFY FAILED: expected fee_in 60.00 and prize_in 360.00, got % and %', e.fee_in, e.prize_in;
  END IF;

  SELECT public.fn_ca_escrow_incident_closes_when_the_leg_lands(i.id) INTO v_closed
    FROM public.ca_drift_incidents i
   WHERE i.source = 'fn_ca_escrow_vs_counter_check' AND i.status <> 'resolved'
     AND i.entity_id = '890de5a7-abf6-40d9-868c-b8b3ecba4282';
  IF NOT COALESCE(v_closed, false) THEN
    RAISE EXCEPTION 'VERIFY FAILED: the detector re-read did not close the Midweek Bounty incident';
  END IF;

  SELECT count(*) INTO v_open FROM public.ca_drift_incidents
   WHERE source = 'fn_ca_escrow_vs_counter_check' AND status <> 'resolved';
  RAISE NOTICE 'UNREGISTER_REVERSAL_EXCLUDED Midweek Bounty balanced and closed; escrow incidents still open: %', v_open;
END $verify$;

COMMIT;
