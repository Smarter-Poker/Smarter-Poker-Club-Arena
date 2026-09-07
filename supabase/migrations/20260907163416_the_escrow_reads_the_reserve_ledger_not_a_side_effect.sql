-- ═══════════════════════════════════════════════════════════════════════════
--  A SPIN'S RESERVE LEGS COME FROM THE RESERVE LEDGER, NOT FROM A SIDE EFFECT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A player won a "20 Chip Spin PLO4" on 2026-09-06 and has been 4.80 chips
-- short ever since. `financial_alerts` said so at 13:18 that day, the
-- reconciler tried to pay it at 04:10 the next morning, and
-- `fn_settle_tournament_obligation` refused with `escrow_short`. It refused
-- correctly: the escrow row for that event says its prize bank holds nothing.
--
-- ── WHAT ACTUALLY HAPPENED, READ FROM ROWS ─────────────────────────────────
-- A Spin & Go is not funded by its own buy-ins. `fn_spin_settle_game` pays the
-- buy-ins LESS an 8% house rake INTO the shared spin reserve, then DRAWS the
-- advertised prize (buy_in x multiplier) back out of it. For tournament
-- afa045db-b55c-40d5-acaf-b9df091d3aa0, `spin_reserve_ledger` records exactly
-- that, at 2026-09-06 12:50:38.041273:
--
--     contribution   +55.20   buy-ins less fixed rake
--     jackpot_draw   -60.00   prize pool
--
-- `tournament_escrow` carries both movements as `reserve_out` and
-- `reserve_in`, and they reach it from a trigger on `chip_ledger`
-- (`fn_ca_escrow_on_reserve_leg`, categories `spin_entry` / `spin_prize`).
-- For this event those two chip_ledger rows were never written as themselves.
-- In the same transaction, at the same microsecond, the auto-ledger wrote:
--
--   adjustment  spin_reserve       -> settlement_suspense  60.00  to_entity NULL
--               "auto-ledgered spin_bonus_pools.balance delta -60.00 (category spin_pri..."
--   adjustment  settlement_suspense -> spin_reserve        55.20  to_entity NULL
--               "auto-ledgered spin_bonus_pools.balance delta 55.20 (category spin_entr..."
--
-- The intended category survives only as text inside the description. Healthy
-- neighbours seconds either side carry `spin_entry` / `spin_prize` with real
-- entity ids, so the declaration reached the auto-ledger for them and not for
-- this one. That is the failure mode `fn_spin_settle_game`'s own comment
-- already names: "With only the category set, this leg landed spin_reserve ->
-- settlement_suspense".
--
-- ── HOW OFTEN, MEASURED ────────────────────────────────────────────────────
-- Escrow rows for events the reserve ledger knows about: **18,318**.
-- Rows whose `reserve_in` disagrees with the reserve ledger: **0**.
-- Rows missing their legs entirely: **1** - this one, 60.00.
-- Rows with a negative prize bank: **0**.
--
-- So the mechanism is right 18,317 times out of 18,318. This is not a broken
-- pipe; it is one leg that fell into suspense, and a player who has been short
-- for a day because nothing noticed and nothing could ever notice.
--
-- ── WHAT THIS CHANGES ──────────────────────────────────────────────────────
-- 1. `fn_ca_escrow_apply` opens an escrow row at FIRST SIGHT and reads the
--    spin reserve legs to seed `reserve_out` / `reserve_in`. It read them from
--    `chip_ledger`, which is the derived record and is exactly what went
--    missing here. It now reads `spin_reserve_ledger`, which is the
--    authoritative one - the same rows the pool balance itself was moved by.
--    Same numbers on all 18,317 healthy events (verified: 0 disagreements),
--    correct on the one that was not.
--
-- 2. The single event whose legs never landed is corrected forward from that
--    same authoritative record, and its balances recomputed. No wallet row is
--    hand-written: this only restores what the escrow should have been told,
--    after which the platform's own idempotent path can pay the 4.80 it has
--    been refusing.
--
-- 3. `fn_ca_tournament_escrow` is restored to the definition it had before
--    20260907162426's first form. That earlier form folded the reserve draw
--    into `prize_in`, which reads correctly on its own and is WRONG where it
--    matters: `fn_ca_escrow_apply` derives `gross_in` from `e.prize_in` at
--    first sight, so a spin whose escrow row opened after its draw would have
--    recorded gross_in 64.80 for a 60.00 event and then double counted the
--    draw against the chip_ledger legs. Reverted deliberately, in the same
--    file that introduced it.
--
-- ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────
-- It does not stop a leg landing in suspense. That belongs to whoever owns
-- `fn_ca_declare_ledger` and the auto-ledger, and the honest position (10.11)
-- is to say so rather than to claim it. What changes here is that the escrow -
-- the thing that decides whether a player can be paid - no longer depends on
-- that leg arriving, because it reads the record the money actually moved by.
--
-- ROLLBACK:
--   Restore fn_ca_escrow_apply's first-sight read to chip_ledger, and
--   UPDATE public.tournament_escrow SET reserve_in = 0, reserve_out = 0
--    WHERE tournament_id = 'afa045db-b55c-40d5-acaf-b9df091d3aa0';
--   then recompute prize_balance as the second UPDATE in fn_ca_escrow_apply does.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.spin_reserve_ledger') IS NULL
     OR to_regclass('public.tournament_escrow') IS NULL THEN
    RAISE EXCEPTION 'the spin reserve ledger or the tournament escrow is gone - read before applying.';
  END IF;

  -- The premise of the correction below: the reserve ledger and the escrow
  -- agree everywhere except the rows that never got their legs. If that has
  -- stopped being true, this migration is not the right shape any more.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_escrow e
      JOIN (
        SELECT l.tournament_id AS tid,
               round(COALESCE(-sum(l.amount) FILTER (WHERE l.kind = 'jackpot_draw'), 0), 2) AS drawn
          FROM public.spin_reserve_ledger l GROUP BY 1
      ) s ON s.tid = e.tournament_id
     WHERE e.reserve_in <> 0 AND abs(e.reserve_in - s.drawn) > 0.01
  ) THEN
    RAISE EXCEPTION
      'an escrow row disagrees with the reserve ledger on a leg it already has - that is a different defect from the missing legs this file corrects.';
  END IF;
END $$;

-- ── 1. THE SHADOW, RESTORED ────────────────────────────────────────────────
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
  -- NOT the spin draw. A Spin's prize really does come from the reserve, and
  -- an earlier build of this file folded that draw in here - which reads
  -- correctly on its own and breaks fn_ca_escrow_apply, whose first-sight path
  -- derives gross_in from this number and then adds the reserve legs itself.
  -- The reserve movement belongs to tournament_escrow.reserve_in /
  -- reserve_out, and that is where it stays.
  SELECT c.*, round(c.gross_in - c.fee_entries - c.bounty_in, 2) AS prize_in
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

COMMENT ON FUNCTION public.fn_ca_tournament_escrow(uuid) IS
  'Shadow of one tournament''s prize / bounty / fee banks, derived from wallet '
  'rows, rake records and ledger legs. A Spin''s reserve movement is NOT here: '
  'it lives in tournament_escrow.reserve_out / reserve_in, because '
  'fn_ca_escrow_apply derives gross_in from prize_in at first sight and would '
  'double count a draw folded into it.';

-- ── 2. FIRST SIGHT READS THE AUTHORITATIVE RESERVE RECORD ──────────────────
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
    /* PHASE 5.2: a spin's prize bank also moves through the reserve.
       2026-09-07: read from `spin_reserve_ledger`, not from the chip_ledger
       `spin_entry` / `spin_prize` legs it used to read. Those legs are the
       DERIVED record and one pair of them went missing: on 2026-09-06 at
       12:50:38 both legs of tournament afa045db landed as `adjustment` rows
       into settlement_suspense with a NULL entity, their intended category
       surviving only inside the description text. The escrow therefore never
       learned that 60.00 had been drawn for a 60.00 prize, and
       fn_settle_tournament_obligation refused the winner's last 4.80 as
       `escrow_short` - for a day, with an open critical alert nobody could act
       on. spin_reserve_ledger is the record the pool balance itself moved by;
       it cannot be missing while the money has moved. Verified across 18,318
       escrow rows: 0 disagree with it, 1 was missing the legs entirely. */
    SELECT COALESCE(sum(l.amount) FILTER (WHERE l.kind = 'contribution'), 0),
           COALESCE(-sum(l.amount) FILTER (WHERE l.kind = 'jackpot_draw'), 0)
      INTO r_out, r_in
      FROM public.spin_reserve_ledger l
     WHERE l.tournament_id = p_tournament_id
       AND l.kind IN ('contribution', 'jackpot_draw');
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

-- ── 3. THE ONE ROW WHOSE LEGS NEVER LANDED, CORRECTED FORWARD ──────────────
-- Every escrow row whose reserve legs are absent while the reserve ledger has
-- them. Measured before writing this: exactly one, 60.00 drawn / 55.20
-- contributed. Written as a set so it is correct whatever the count is at the
-- moment it runs, and asserted afterwards.
WITH srl AS (
  SELECT l.tournament_id AS tid,
         round(COALESCE(sum(l.amount) FILTER (WHERE l.kind = 'contribution'), 0), 2) AS contribution,
         round(COALESCE(-sum(l.amount) FILTER (WHERE l.kind = 'jackpot_draw'), 0), 2) AS drawn
    FROM public.spin_reserve_ledger l
   GROUP BY 1
)
UPDATE public.tournament_escrow e
   SET reserve_out = s.contribution,
       reserve_in  = s.drawn,
       prize_balance = round((e.gross_in - e.fee_entries_in - e.bounty_in)
                             + e.overlay_in + e.satellite_in
                             - s.contribution + s.drawn
                             - e.prize_out - e.refund_prize, 2),
       updated_at = now()
  FROM srl s
 WHERE s.tid = e.tournament_id
   AND e.reserve_in = 0
   AND e.reserve_out = 0
   AND s.drawn > 0;

COMMIT;

-- ── POST-CHECKS ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_missing int;
  v_bal numeric;
  v_neg int;
BEGIN
  SELECT count(*) INTO v_missing
    FROM public.tournament_escrow e
    JOIN (
      SELECT l.tournament_id AS tid,
             round(COALESCE(-sum(l.amount) FILTER (WHERE l.kind = 'jackpot_draw'), 0), 2) AS drawn
        FROM public.spin_reserve_ledger l GROUP BY 1
    ) s ON s.tid = e.tournament_id
   WHERE e.reserve_in = 0 AND s.drawn > 0;

  IF v_missing <> 0 THEN
    RAISE EXCEPTION 'post-check: % escrow row(s) still have no reserve_in while the reserve ledger shows a draw', v_missing;
  END IF;

  SELECT prize_balance INTO v_bal
    FROM public.tournament_escrow
   WHERE tournament_id = 'afa045db-b55c-40d5-acaf-b9df091d3aa0';

  IF v_bal IS NULL OR round(v_bal, 2) <> 4.80 THEN
    RAISE EXCEPTION
      'post-check: the worked example holds % in its prize bank; 4.80 is what the winner is still owed', v_bal;
  END IF;

  -- Correcting one row must not have driven any other bank negative.
  SELECT count(*) INTO v_neg FROM public.tournament_escrow WHERE prize_balance < -0.005;
  IF v_neg > 0 THEN
    RAISE EXCEPTION 'post-check: % escrow row(s) now show a negative prize bank', v_neg;
  END IF;

  RAISE NOTICE 'spin reserve legs: none missing; worked example prize bank = %', v_bal;
END $$;
