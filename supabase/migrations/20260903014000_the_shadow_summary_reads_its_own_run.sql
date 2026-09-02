-- ===========================================================================
-- THE SHADOW SUMMARY READS ITS OWN RUN
-- Chip Accounting Standard, Lane B, escrow shadow, correction (2026-09-02)
-- ===========================================================================
--
-- The first 24-hour run of fn_ca_escrow_vs_counter_check (20:13 UTC, 7,279
-- events, 174 s) returned every top-level number correctly and an EMPTY
-- `by_variant` array. The per-variant rollup selected rows with
-- `checked_at >= v_started`, where v_started is clock_timestamp() (taken when
-- the function began) and checked_at is stamped now() (the transaction start,
-- which is earlier). Inside one transaction now() < clock_timestamp(), so the
-- rollup matched nothing it had just written.
--
-- The rollup now compares against now() captured once into v_run_now, which
-- is the exact value every row of this run carries. Nothing else changes: the
-- function is reproduced whole so the law test can pin the live body.
--
-- One DDL statement, one transaction, one schema reload.
-- ===========================================================================
BEGIN;

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
  v_run_now      timestamptz := now();
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
       WHERE asserted AND checked_at >= v_run_now
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

DO $verify$
DECLARE
  v_body text;
BEGIN
  SELECT prosrc INTO v_body FROM pg_proc WHERE proname = 'fn_ca_escrow_vs_counter_check';
  IF v_body !~ 'checked_at >= v_run_now' THEN
    RAISE EXCEPTION 'the shadow summary must read its own run';
  END IF;
  IF v_body ~* 'RAISE\s+EXCEPTION' THEN
    RAISE EXCEPTION 'the shadow check must never raise';
  END IF;
  IF v_body ~* 'UPDATE\s+public\.tournaments' OR v_body ~* 'UPDATE\s+tournaments' THEN
    RAISE EXCEPTION 'the shadow check must never write a counter';
  END IF;
END
$verify$;

COMMIT;
