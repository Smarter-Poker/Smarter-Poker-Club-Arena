-- ===========================================================================
-- THE ESCROW SHADOW: WHAT EVERY TOURNAMENT HELD VERSUS WHAT IT PAID, HOURLY
-- Chip Accounting Standard, Lane B, shadow version (2026-09-02)
-- ===========================================================================
--
-- docs/CHIP-ACCOUNTING-STANDARD.md section 0 names the architectural cause of
-- chip drift: a buy-in is destroyed at the wallet and re-minted at payout, and
-- `tournaments.prize_pool`, `bounty_pool` and `total_rake` are COUNTERS, not
-- balances. Nothing between registration and payout can refuse anything.
--
-- The full Lane B (a `tournament_escrow` account with CHECK >= 0, prize_pool
-- as a derived column, payouts refused at a constraint) is HIGH RISK for live
-- play: a constraint that refuses a legitimate payout strands a player mid
-- tournament. Dan's rule (SWARM-BRIEF-R2 rule 13) is that such a thing does
-- not get built. This migration builds the SHADOW instead:
--
--   fn_ca_tournament_escrow(t)      the twelve escrow numbers for one event,
--                                   computed ONLY from evidence rows (wallet
--                                   debits and credits, rake records, overlay
--                                   ledger rows, rake settlements, satellite
--                                   seat receipts). Never reads a counter.
--   tournament_escrow_shadow        the same, as a view, next to the counters.
--   fn_ca_escrow_vs_counter_check   hourly. Compares shadow to counters for
--                                   every event that changed in the window,
--                                   asserts R5 (all three balances are 0) for
--                                   COMPLETED and CANCELLED events, files ONE
--                                   info incident per event (`escrow:<id>`),
--                                   a WARNING only when an event paid more
--                                   than it held by over 1.00, capped per run
--                                   so it can never storm. It NEVER refuses,
--                                   NEVER raises, NEVER writes a counter.
--
-- EVIDENCE MAP (read from the live function bodies on 2026-09-02):
--   entry     fn_register_for_tournament   wallet_transactions debit 'tournament_buyin'
--                                          (charge = buy_in + fee), rake_records row
--                                          (source fn_register_for_tournament) for the
--                                          fee, bounty head = bounty_amount on bounty
--                                          formats (fn_tournament_entry_split).
--   rebuy     process_tournament_rebuy     wallet_transactions debit 'rebuy' (rebuy and
--             _before_one_minute_addon     re-entry) or 'addon'; rake_records row for
--                                          the fee; bounty head = round(bounty_amount)
--                                          on bounty formats for rebuy/re-entry.
--   overlay   fn_ca_fund_overlay_on_lock   chip_ledger 'overlay' union_bank|club_treasury
--                                          -> prize_liability, to_entity_id = tournament.
--             fn_apply_prize_guarantee     tournament_guarantee_overlays row (older path,
--                                          last fired 2026-09-01 19:50 UTC).
--   satellite fn_award_satellite_seat      satellite: tournament_payouts source
--                                          'satellite_seat' (seat value out of its pool);
--                                          target: rake_records source
--                                          fn_award_satellite_seat (pot_size = buy_in +
--                                          fee, rake_amount = fee).
--   payout    every payer                  wallet_transactions credit 'prize' (minus
--                                          debit 'prize' / 'prize_reversal' corrections),
--                                          credit 'bounty', credit 'refund'.
--   rake      fn_settle_tournament_rake    tournament_rake_settlements.amount, settled_at.
--
-- KNOWN LIMITS, stated so nobody mistakes them for findings:
--   * The six guarantees back-funded by `back_fund_the_six_unfunded_guarantees`
--     (2026-09-02 01:19 UTC) were funded with ONE aggregate chip_ledger row whose
--     to_entity_id is the union, not the tournament. The shadow cannot attribute
--     it per event and reports those six as underfunded. That is the truth of
--     the evidence, not a payout defect.
--   * The first version of the lock trigger (01:14 to 01:15 UTC) auto-ledgered
--     its bank debit as 'adjustment' into settlement_suspense. One freeroll
--     ($100 Freeroll, 6:00 PM, started 01:15:00) was funded that way and shows
--     as unfunded here; the suspense watch already carries that row.
--   * Spins are reserve-funded (prize_liability -> spin_reserve at the last
--     seat, prize paid from the reserve). They are computed but NOT asserted;
--     the spin lane owns that conservation.
--   * A refund row does not say which slice (prize, bounty, fee) it returns.
--     It is apportioned by the event's own split so the three residuals still
--     sum to the true total; the total is what the warning reads.
--
-- One transaction. Report-only. No RAISE EXCEPTION anywhere in the check.
-- ===========================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The shadow ledger: one row per tournament, latest computation.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ca_escrow_shadow_results (
  tournament_id        uuid PRIMARY KEY,
  club_id              uuid,
  union_id             uuid,
  name                 text,
  variant              text,
  status               text,
  ended_at             timestamptz,
  checked_at           timestamptz NOT NULL DEFAULT now(),
  prize_in             numeric(15,2) NOT NULL DEFAULT 0,
  bounty_in            numeric(15,2) NOT NULL DEFAULT 0,
  fee_in               numeric(15,2) NOT NULL DEFAULT 0,
  overlay_in           numeric(15,2) NOT NULL DEFAULT 0,
  satellite_in         numeric(15,2) NOT NULL DEFAULT 0,
  prize_out            numeric(15,2) NOT NULL DEFAULT 0,
  bounty_out           numeric(15,2) NOT NULL DEFAULT 0,
  fee_out              numeric(15,2) NOT NULL DEFAULT 0,
  refund_out           numeric(15,2) NOT NULL DEFAULT 0,
  prize_balance        numeric(15,2) NOT NULL DEFAULT 0,
  bounty_balance       numeric(15,2) NOT NULL DEFAULT 0,
  fee_balance          numeric(15,2) NOT NULL DEFAULT 0,
  counter_prize_pool   numeric(15,2),
  counter_bounty_open  numeric(15,2),
  counter_total_rake   numeric(15,2),
  counter_prize_gap    numeric(15,2),
  counter_bounty_gap   numeric(15,2),
  counter_fee_gap      numeric(15,2),
  asserted             boolean NOT NULL DEFAULT false,
  verdict              text NOT NULL DEFAULT 'not_asserted',
  incident_id          uuid,
  CONSTRAINT ca_escrow_shadow_results_verdict_chk
    CHECK (verdict IN ('balanced','overpaid','underpaid','not_asserted'))
);
COMMENT ON TABLE public.ca_escrow_shadow_results IS
  'Chip Accounting Standard Lane B, shadow escrow. One row per tournament: what it held (in) versus what it paid (out), from evidence rows only, and the gap to the prize_pool / bounty_pool / total_rake counters. Report-only; nothing reads this to refuse a payout.';

CREATE INDEX IF NOT EXISTS idx_ca_escrow_shadow_results_verdict_checked
  ON public.ca_escrow_shadow_results (verdict, checked_at DESC);

ALTER TABLE public.ca_escrow_shadow_results ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_escrow_shadow_results FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ca_escrow_shadow_results TO service_role;

CREATE TABLE IF NOT EXISTS public.ca_escrow_shadow_runs (
  id          bigserial PRIMARY KEY,
  run_at      timestamptz NOT NULL DEFAULT now(),
  hours       integer NOT NULL,
  elapsed_ms  integer,
  summary     jsonb NOT NULL
);
COMMENT ON TABLE public.ca_escrow_shadow_runs IS
  'One row per fn_ca_escrow_vs_counter_check run: the distribution of shadow residuals (balanced / overpaid / underpaid, totals) over the window. This number IS the drift the standard is chasing.';

ALTER TABLE public.ca_escrow_shadow_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_escrow_shadow_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ca_escrow_shadow_runs TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.ca_escrow_shadow_runs_id_seq TO service_role;

-- ---------------------------------------------------------------------------
-- 2. The shadow escrow for one tournament, from evidence rows only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_escrow(p_tournament_id uuid)
RETURNS TABLE (
  prize_in       numeric,
  bounty_in      numeric,
  fee_in         numeric,
  overlay_in     numeric,
  satellite_in   numeric,
  prize_out      numeric,
  bounty_out     numeric,
  fee_out        numeric,
  refund_out     numeric,
  prize_balance  numeric,
  bounty_balance numeric,
  fee_balance    numeric
)
LANGUAGE sql
STABLE
SET search_path = public
AS $fn$
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
  SELECT COALESCE(sum(a.amount), 0) AS ledger_overlay
    FROM public.chip_ledger a
   WHERE a.to_entity_id = p_tournament_id
     AND a.category = 'overlay'
     AND a.to_type = 'prize_liability'
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
$fn$;

COMMENT ON FUNCTION public.fn_ca_tournament_escrow(uuid) IS
  'Shadow tournament escrow from evidence rows only (wallet_transactions, rake_records, chip_ledger overlay rows, tournament_guarantee_overlays, tournament_payouts satellite seats, tournament_rake_settlements). Never reads prize_pool / bounty_pool / total_rake. Returns no row for an unknown tournament. Report-only.';

REVOKE ALL ON FUNCTION public.fn_ca_tournament_escrow(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_escrow(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. The shadow next to the counters, for reading. Always filter by
--    tournament_id or a short window; it is a LATERAL over tournaments.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.tournament_escrow_shadow
WITH (security_invoker = true) AS
SELECT t.id            AS tournament_id,
       t.name,
       t.variant,
       t.tournament_type,
       t.status,
       t.club_id,
       t.union_id,
       t.ended_at,
       round(COALESCE(t.prize_pool, 0), 2)                                    AS counter_prize_pool,
       round(COALESCE(t.bounty_pool, 0) - COALESCE(t.bounty_pool_paid, 0), 2) AS counter_bounty_open,
       round(COALESCE(t.total_rake, 0), 2)                                    AS counter_total_rake,
       e.prize_in, e.bounty_in, e.fee_in, e.overlay_in, e.satellite_in,
       e.prize_out, e.bounty_out, e.fee_out, e.refund_out,
       e.prize_balance, e.bounty_balance, e.fee_balance,
       round(COALESCE(t.prize_pool, 0) - (e.prize_in + e.overlay_in + e.satellite_in), 2) AS counter_prize_gap,
       round((COALESCE(t.bounty_pool, 0) - COALESCE(t.bounty_pool_paid, 0)) - e.bounty_balance, 2) AS counter_bounty_gap,
       round(COALESCE(t.total_rake, 0) - e.fee_in, 2)                          AS counter_fee_gap
  FROM public.tournaments t
  CROSS JOIN LATERAL public.fn_ca_tournament_escrow(t.id) e
 WHERE COALESCE(t.ended_at, t.updated_at, t.created_at) > now() - interval '7 days';

COMMENT ON VIEW public.tournament_escrow_shadow IS
  'Shadow escrow (evidence rows) beside the three counters, last 7 days. Report-only.';

REVOKE ALL ON public.tournament_escrow_shadow FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.tournament_escrow_shadow TO service_role;

-- ---------------------------------------------------------------------------
-- 4. The hourly check. Report-only. Never refuses, never raises, never
--    writes a counter.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_vs_counter_check(
  p_hours       integer DEFAULT 3,
  p_warning_cap integer DEFAULT 5
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_started      timestamptz := clock_timestamp();
  v_cutoff       timestamptz := now() - make_interval(hours => GREATEST(COALESCE(p_hours, 3), 1));
  r              record;
  e              record;
  v_terminal     boolean;
  v_asserted     boolean;
  v_verdict      text;
  v_sev          text;
  v_inc          uuid;
  v_total        numeric;
  v_candidates   integer := 0;
  v_asserted_n   integer := 0;
  v_balanced     integer := 0;
  v_overpaid     integer := 0;
  v_underpaid    integer := 0;
  v_over_total   numeric := 0;
  v_under_total  numeric := 0;
  v_spins        integer := 0;
  v_open         integer := 0;
  v_gap_events   integer := 0;
  v_info         integer := 0;
  v_warn         integer := 0;
  v_warn_capped  integer := 0;
  v_by_variant   jsonb;
  v_summary      jsonb;
  v_state        text;
  v_msg          text;
BEGIN
  FOR r IN
    SELECT t.id, t.name, t.variant, t.status, t.club_id, t.union_id, t.ended_at,
           round(COALESCE(t.prize_pool, 0), 2)                                    AS counter_prize_pool,
           round(COALESCE(t.bounty_pool, 0) - COALESCE(t.bounty_pool_paid, 0), 2) AS counter_bounty_open,
           round(COALESCE(t.total_rake, 0), 2)                                    AS counter_total_rake
      FROM public.tournaments t
     WHERE (t.status = 'COMPLETED' AND t.ended_at > v_cutoff)
        OR (t.status IN ('RUNNING','COMPLETING','CANCELLED','CANCELED')
            AND t.start_time > v_cutoff - interval '3 days'
            AND COALESCE(t.updated_at, t.ended_at, t.started_at, t.created_at) > v_cutoff)
     ORDER BY t.ended_at DESC NULLS LAST
     LIMIT 20000
  LOOP
    v_candidates := v_candidates + 1;

    SELECT * INTO e FROM public.fn_ca_tournament_escrow(r.id);
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    v_terminal := r.status IN ('COMPLETED','CANCELLED','CANCELED');
    v_asserted := v_terminal AND COALESCE(r.variant, '') <> 'spin';
    v_total    := round(e.prize_balance + e.bounty_balance + e.fee_balance, 2);

    IF NOT v_terminal THEN
      v_open := v_open + 1;
    ELSIF NOT v_asserted THEN
      v_spins := v_spins + 1;
    END IF;

    IF abs(r.counter_prize_pool - (e.prize_in + e.overlay_in + e.satellite_in)) > 0.005 THEN
      v_gap_events := v_gap_events + 1;
    END IF;

    v_verdict := 'not_asserted';
    v_inc := NULL;

    IF v_asserted THEN
      v_asserted_n := v_asserted_n + 1;
      IF abs(e.prize_balance) <= 0.005 AND abs(e.bounty_balance) <= 0.005
         AND abs(e.fee_balance) <= 0.005 THEN
        v_verdict := 'balanced';
        v_balanced := v_balanced + 1;
      ELSE
        IF v_total < 0 THEN
          v_verdict := 'overpaid';
          v_overpaid := v_overpaid + 1;
          v_over_total := v_over_total + v_total;
        ELSE
          v_verdict := 'underpaid';
          v_underpaid := v_underpaid + 1;
          v_under_total := v_under_total + v_total;
        END IF;

        -- ONE incident per tournament. Info by default (dashboard only, never
        -- paged). Warning only when the event paid more than it held by over
        -- one chip, and at most p_warning_cap warnings per run so a backlog
        -- can never become a push storm; the rest are filed as info with the
        -- cap noted.
        v_sev := 'info';
        IF e.prize_balance < -1.00 THEN
          IF v_warn < GREATEST(COALESCE(p_warning_cap, 5), 0) THEN
            v_sev := 'warning';
          ELSE
            v_warn_capped := v_warn_capped + 1;
          END IF;
        END IF;

        BEGIN
          v_inc := public.fn_ca_raise_drift_incident(
            p_source          => 'fn_ca_escrow_vs_counter_check',
            p_classification  => 'settlement_error',
            p_severity        => v_sev,
            p_dedupe_key      => 'escrow:' || r.id::text,
            p_discrepancy     => abs(v_total),
            p_expected        => round(e.prize_in + e.bounty_in + e.fee_in + e.overlay_in + e.satellite_in, 2),
            p_actual          => round(e.prize_out + e.bounty_out + e.fee_out + e.refund_out, 2),
            p_layer           => 'ledger',
            p_entity_type     => 'tournament',
            p_entity_id       => r.id,
            p_club_id         => r.club_id,
            p_union_id        => r.union_id,
            p_table_id        => NULL,
            p_tournament_id   => r.id,
            p_hand_id         => NULL,
            p_settlement_id   => NULL,
            p_wallet_ids      => NULL,
            p_transaction_ids => NULL,
            p_suspected_cause => left(format(
              'Escrow shadow (R5): %s (%s) closed with prize %s, bounty %s, fee %s left in escrow (negative = paid more than it held). Held %s, paid %s.',
              COALESCE(r.name, r.id::text), COALESCE(r.variant, '?'),
              e.prize_balance, e.bounty_balance, e.fee_balance,
              round(e.prize_in + e.bounty_in + e.fee_in + e.overlay_in + e.satellite_in, 2),
              round(e.prize_out + e.bounty_out + e.fee_out + e.refund_out, 2)), 300),
            p_ledger_balanced => false,
            p_metadata        => jsonb_build_object(
              'shadow', true, 'never_refuses', true,
              'variant', r.variant, 'status', r.status, 'ended_at', r.ended_at,
              'prize_residual', e.prize_balance, 'bounty_residual', e.bounty_balance,
              'fee_residual', e.fee_balance, 'total_residual', v_total,
              'prize_in', e.prize_in, 'bounty_in', e.bounty_in, 'fee_in', e.fee_in,
              'overlay_in', e.overlay_in, 'satellite_in', e.satellite_in,
              'prize_out', e.prize_out, 'bounty_out', e.bounty_out,
              'fee_out', e.fee_out, 'refund_out', e.refund_out,
              'counter_prize_pool', r.counter_prize_pool,
              'counter_bounty_open', r.counter_bounty_open,
              'counter_total_rake', r.counter_total_rake,
              'warning_capped', (v_sev = 'info' AND e.prize_balance < -1.00)));
        EXCEPTION WHEN OTHERS THEN
          -- A reporter must never be the thing that fails. Keep going.
          GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
          RAISE WARNING 'fn_ca_escrow_vs_counter_check: incident for % not filed (%: %)', r.id, v_state, v_msg;
          v_inc := NULL;
        END;

        IF v_sev = 'warning' THEN
          v_warn := v_warn + 1;
        ELSE
          v_info := v_info + 1;
        END IF;
      END IF;
    END IF;

    INSERT INTO public.ca_escrow_shadow_results AS s (
      tournament_id, club_id, union_id, name, variant, status, ended_at, checked_at,
      prize_in, bounty_in, fee_in, overlay_in, satellite_in,
      prize_out, bounty_out, fee_out, refund_out,
      prize_balance, bounty_balance, fee_balance,
      counter_prize_pool, counter_bounty_open, counter_total_rake,
      counter_prize_gap, counter_bounty_gap, counter_fee_gap,
      asserted, verdict, incident_id)
    VALUES (
      r.id, r.club_id, r.union_id, r.name, r.variant, r.status, r.ended_at, now(),
      e.prize_in, e.bounty_in, e.fee_in, e.overlay_in, e.satellite_in,
      e.prize_out, e.bounty_out, e.fee_out, e.refund_out,
      e.prize_balance, e.bounty_balance, e.fee_balance,
      r.counter_prize_pool, r.counter_bounty_open, r.counter_total_rake,
      round(r.counter_prize_pool - (e.prize_in + e.overlay_in + e.satellite_in), 2),
      round(r.counter_bounty_open - e.bounty_balance, 2),
      round(r.counter_total_rake - e.fee_in, 2),
      v_asserted, v_verdict, v_inc)
    ON CONFLICT (tournament_id) DO UPDATE SET
      club_id = EXCLUDED.club_id, union_id = EXCLUDED.union_id, name = EXCLUDED.name,
      variant = EXCLUDED.variant, status = EXCLUDED.status, ended_at = EXCLUDED.ended_at,
      checked_at = EXCLUDED.checked_at,
      prize_in = EXCLUDED.prize_in, bounty_in = EXCLUDED.bounty_in, fee_in = EXCLUDED.fee_in,
      overlay_in = EXCLUDED.overlay_in, satellite_in = EXCLUDED.satellite_in,
      prize_out = EXCLUDED.prize_out, bounty_out = EXCLUDED.bounty_out,
      fee_out = EXCLUDED.fee_out, refund_out = EXCLUDED.refund_out,
      prize_balance = EXCLUDED.prize_balance, bounty_balance = EXCLUDED.bounty_balance,
      fee_balance = EXCLUDED.fee_balance,
      counter_prize_pool = EXCLUDED.counter_prize_pool,
      counter_bounty_open = EXCLUDED.counter_bounty_open,
      counter_total_rake = EXCLUDED.counter_total_rake,
      counter_prize_gap = EXCLUDED.counter_prize_gap,
      counter_bounty_gap = EXCLUDED.counter_bounty_gap,
      counter_fee_gap = EXCLUDED.counter_fee_gap,
      asserted = EXCLUDED.asserted, verdict = EXCLUDED.verdict,
      incident_id = COALESCE(EXCLUDED.incident_id, s.incident_id);
  END LOOP;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'variant', v.variant, 'events', v.events, 'balanced', v.balanced,
           'overpaid', v.overpaid, 'underpaid', v.underpaid,
           'overpaid_total', v.overpaid_total, 'underpaid_total', v.underpaid_total)
           ORDER BY v.events DESC), '[]'::jsonb)
    INTO v_by_variant
    FROM (
      SELECT COALESCE(variant, '?') AS variant,
             count(*) AS events,
             count(*) FILTER (WHERE verdict = 'balanced')  AS balanced,
             count(*) FILTER (WHERE verdict = 'overpaid')  AS overpaid,
             count(*) FILTER (WHERE verdict = 'underpaid') AS underpaid,
             round(COALESCE(sum(prize_balance + bounty_balance + fee_balance)
                     FILTER (WHERE verdict = 'overpaid'), 0), 2)  AS overpaid_total,
             round(COALESCE(sum(prize_balance + bounty_balance + fee_balance)
                     FILTER (WHERE verdict = 'underpaid'), 0), 2) AS underpaid_total
        FROM public.ca_escrow_shadow_results
       WHERE asserted AND checked_at >= v_started
       GROUP BY 1) v;

  v_summary := jsonb_build_object(
    'hours', p_hours,
    'candidates', v_candidates,
    'asserted', v_asserted_n,
    'balanced', v_balanced,
    'overpaid', v_overpaid,
    'overpaid_total', round(v_over_total, 2),
    'underpaid', v_underpaid,
    'underpaid_total', round(v_under_total, 2),
    'net_residual', round(v_over_total + v_under_total, 2),
    'spins_not_asserted', v_spins,
    'open_not_asserted', v_open,
    'counter_prize_gap_events', v_gap_events,
    'incidents_info', v_info,
    'incidents_warning', v_warn,
    'warnings_capped_to_info', v_warn_capped,
    'by_variant', v_by_variant,
    'elapsed_ms', (extract(epoch FROM (clock_timestamp() - v_started)) * 1000)::integer);

  INSERT INTO public.ca_escrow_shadow_runs (hours, elapsed_ms, summary)
  VALUES (p_hours, (v_summary->>'elapsed_ms')::integer, v_summary);

  RETURN v_summary;
END;
$fn$;

COMMENT ON FUNCTION public.fn_ca_escrow_vs_counter_check(integer, integer) IS
  'Hourly shadow escrow check (Chip Accounting Standard R5, shadow). For every tournament that changed in the window: computes fn_ca_tournament_escrow, records it beside the counters in ca_escrow_shadow_results, and for COMPLETED / CANCELLED non-spin events files ONE info incident per event (dedupe escrow:<id>) when any residual is non-zero, warning only when prize residual < -1.00 and only up to p_warning_cap per run. Report-only: never refuses, never raises, never writes tournaments.';

REVOKE ALL ON FUNCTION public.fn_ca_escrow_vs_counter_check(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_escrow_vs_counter_check(integer, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. Schedule: hourly at :35, three-hour window so a late rake settlement or
--    a reconciler top-up is seen by the next pass, without re-touching every
--    event of the day every hour.
-- ---------------------------------------------------------------------------
DO $sched$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-escrow-shadow-hourly') THEN
    PERFORM cron.unschedule('ca-escrow-shadow-hourly');
  END IF;
  PERFORM cron.schedule(
    'ca-escrow-shadow-hourly',
    '35 * * * *',
    $job$ SET statement_timeout = '300s';
          SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-escrow-shadow'))
                      THEN (public.fn_ca_escrow_vs_counter_check(3, 5))::text
                      ELSE 'locked' END; $job$);
END
$sched$;

-- ---------------------------------------------------------------------------
-- 6. Post-apply assertions (green or the transaction rolls back).
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_rows integer;
  v_body text;
  v_sample uuid;
BEGIN
  SELECT count(*) INTO v_rows FROM public.fn_ca_tournament_escrow(gen_random_uuid());
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'fn_ca_tournament_escrow returned % row(s) for an unknown tournament', v_rows;
  END IF;

  SELECT id INTO v_sample FROM public.tournaments
   WHERE status = 'COMPLETED' ORDER BY ended_at DESC NULLS LAST LIMIT 1;
  IF v_sample IS NOT NULL THEN
    SELECT count(*) INTO v_rows FROM public.fn_ca_tournament_escrow(v_sample);
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'fn_ca_tournament_escrow returned % row(s) for tournament %', v_rows, v_sample;
    END IF;
  END IF;

  SELECT prosrc INTO v_body FROM pg_proc WHERE proname = 'fn_ca_escrow_vs_counter_check';
  IF v_body ~* 'RAISE\s+EXCEPTION' THEN
    RAISE EXCEPTION 'the shadow check must never raise';
  END IF;
  IF v_body ~* 'UPDATE\s+public\.tournaments' OR v_body ~* 'UPDATE\s+tournaments' THEN
    RAISE EXCEPTION 'the shadow check must never write a counter';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-escrow-shadow-hourly') THEN
    RAISE EXCEPTION 'ca-escrow-shadow-hourly is not scheduled';
  END IF;
END
$verify$;

COMMIT;
