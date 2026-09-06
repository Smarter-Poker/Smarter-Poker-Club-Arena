-- AN ESCROW INCIDENT CLOSES ITSELF WHEN THE LEG LANDS.
--
-- H2 of the chip-accounting programme (docs/CHIP-ACCOUNTING-ROADMAP.md,
-- Part Two; handoff Part 6). Thirty open incidents from
-- fn_ca_escrow_vs_counter_check, all club fade0000-...-0001 (Midway Union).
-- The handoff asked one question first: is this the same stale read as
-- fn_ca_escrow_on_close (H1)? It is not - this detector reads
-- fn_ca_tournament_escrow, which is computed from the journal, not a stored
-- balance - but the answer to the thirty is still "read them again":
--
-- SHAPE B, 23 of 30, every one filed "fee N.NN left in escrow" or "prize
-- N.NN left in escrow" on a heads-up SNG or small bounty event, 2026-09-02
-- to 09-04. Re-read live at 14:50 UTC 2026-09-06: every one balances
-- 0.00 / 0.00 / 0.00. The leg the detector could not see had not landed yet
-- when it looked, and landed later:
--
--   * the FEE leg: tournament_rake_settlements.source = 'sweep', 10 to 50
--     minutes after close, on 09-03 and 09-04 (81 and 25 such rows). The
--     engine's own 'engine_finish' settlement had missed those events. That
--     class has produced ZERO 'sweep' rows on 09-05 and 09-06 - fixed
--     upstream, not by this migration.
--   * the PRIZE leg: tournament_payouts.source = 'reconcile', between
--     12:41 and 13:08 UTC today, after "WINNER prize credit failed after 3
--     retries" (financial_alerts, 12:47 / 12:52) - a window of deadlocks and
--     failed credits around the 12:55 restart. 13 events; the 14:00 hour is
--     clean.
--
--   Measured on 15,107 completed non-spin events over 3 days: the fee and
--   prize legs land BEFORE ended_at at p50 and p95 (-0.25s, -0.10s); 63
--   events (0.4%) had a leg land more than 60s late, the worst 3,029s.
--
--   The detector is right to file when it looks and the money is not there.
--   Its defect is that it never looks again at what it filed: an incident
--   stayed open for days after the world had answered it. THE FIX IS THE
--   DETECTOR'S OWN BOOKKEEPING, NOT A SWEEP: on every run it now re-reads
--   the escrow of each incident it still holds open and, when the event
--   balances, closes it with the leg that landed, when, and how late. No
--   chips move. Dan's rule (2026-09-06) is "nothing but code base fixes for
--   chip drift"; a detector that cannot recognise its own false alarm is a
--   code defect in the detector.
--
-- SHAPE A, 7 of 30, all 2026-09-02, all OVERPAID (prize_out > prize_in +
-- overlay_in). Every one is a settled, recorded, Dan-ruled event from the
-- day the guarantee-overlay and settlement machinery was rebuilt:
--
--   * Union Grand Championship (-920.00), Union Mystery Bounty (-700.00),
--     Evening Mystery Bounty (-350.00), Turbo Tuesday Opener (-32.00):
--     the guarantee overlay was paid TWICE - at 01:19 by the back-payment
--     migration and again at 03:54 by fn_tournament_payout_reconcile, which
--     could not see the first because no tournament_payouts row recorded it.
--     Verified here per player: the same user, position and amount credited
--     at both times (nine players in the Grand Championship, 460.00). The
--     shadow shows exactly twice the overlay. Recorded and fixed by
--     20260902041907 (the record now shows every prize paid) and
--     20260902042044 (the reconciler counts overlay_backpay); Dan ruled no
--     clawback - "just insure the bug / gap / leak is fixed". The house
--     absorbed 1,001.00 across these four.
--   * $100 Freeroll 12:00 AM (-41.71) and $100 Freeroll 6:00 PM (-100.00):
--     settled by 20260902162954 under CLAUDE.md 10.9 after the engineless-
--     table defect (PR #2643). The 41.71 is the overpay that migration's
--     header says the house absorbed. The 100.00 is the freeroll's
--     guarantee, paid by the reconciler to the players who were owed it,
--     with no bank -> prize_liability journal leg because that leg did not
--     exist yet on 09-02.
--   * Sunday Deep Stack Satellite $5 (-92.00): one seat honoured as 200.00
--     chips ("Satellite seat fallback (registration failed)") against
--     108.00 collected; the union paid the seat it promised. The
--     satellite's pool_transfer leg that journals this was added by
--     20260903020000 (a satellite seat is paid from the satellite's own
--     pool).
--
--   None of the seven recurs: ca_escrow_shadow_results holds 8,905 asserted
--   events ended since 2026-09-04, every one 'balanced'. These are closed
--   here by hand, each with the migration that fixed its mechanism as the
--   correction_ref, and none with a chip moved. Under 10.9 rule 3 an overpay
--   our defect caused is absorbed, reported and left alone.
--
-- The verdict "shape A is a stale read too" would have been wrong, and the
-- verdict "shape A is a live leak" would have been wrong. Both were read from
-- rows before either was written down.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The helper: re-read one open escrow incident; close it if the event
--    balances now, saying which leg landed and how late. Returns true when it
--    closed something. Never raises past its caller.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_incident_closes_when_the_leg_lands(p_incident_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
DECLARE
  inc          public.ca_drift_incidents;
  e            record;
  v_ended      timestamptz;
  v_name       text;
  v_fee_at     timestamptz;
  v_fee_src    text;
  v_prize_at   timestamptz;
  v_prize_src  text;
  v_leg        text;
  v_leg_at     timestamptz;
  v_leg_src    text;
  v_cause      text;
BEGIN
  SELECT * INTO inc FROM public.ca_drift_incidents WHERE id = p_incident_id;
  IF NOT FOUND OR inc.status = 'resolved'
     OR inc.source <> 'fn_ca_escrow_vs_counter_check'
     OR inc.entity_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT * INTO e FROM public.fn_ca_tournament_escrow(inc.entity_id);
  IF NOT FOUND THEN RETURN false; END IF;
  IF abs(e.prize_balance) > 0.005 OR abs(e.bounty_balance) > 0.005
     OR abs(e.fee_balance) > 0.005 THEN
    RETURN false;                       -- still owed or still over; stays open
  END IF;

  SELECT t.ended_at, t.name INTO v_ended, v_name
    FROM public.tournaments t WHERE t.id = inc.entity_id;

  SELECT s.settled_at, s.source INTO v_fee_at, v_fee_src
    FROM public.tournament_rake_settlements s
   WHERE s.tournament_id = inc.entity_id AND s.settled_at IS NOT NULL
   ORDER BY s.settled_at DESC LIMIT 1;

  SELECT p.paid_at, p.source INTO v_prize_at, v_prize_src
    FROM public.tournament_payouts p
   WHERE p.tournament_id = inc.entity_id AND p.paid_at IS NOT NULL
   ORDER BY p.paid_at DESC LIMIT 1;

  IF COALESCE(v_fee_at, '-infinity') >= COALESCE(v_prize_at, '-infinity') THEN
    v_leg := 'fee';   v_leg_at := v_fee_at;   v_leg_src := v_fee_src;
  ELSE
    v_leg := 'prize'; v_leg_at := v_prize_at; v_leg_src := v_prize_src;
  END IF;

  v_cause := format(
    'The escrow shadow looked before the %s leg had landed. %s closed %s; the detector filed at %s; the last %s leg landed at %s (source %s), %s minutes after close. Re-read at %s: prize 0.00, bounty 0.00, fee 0.00. No chips moved to close this.',
    v_leg,
    COALESCE(v_name, inc.entity_id::text),
    to_char(v_ended, 'YYYY-MM-DD HH24:MI:SS "UTC"'),
    to_char(inc.detected_at, 'YYYY-MM-DD HH24:MI:SS "UTC"'),
    v_leg,
    COALESCE(to_char(v_leg_at, 'YYYY-MM-DD HH24:MI:SS "UTC"'), '?'),
    COALESCE(v_leg_src, '?'),
    CASE WHEN v_leg_at IS NULL OR v_ended IS NULL THEN '?'
         ELSE round(extract(epoch FROM (v_leg_at - v_ended)) / 60, 1)::text END,
    to_char(now(), 'YYYY-MM-DD HH24:MI:SS "UTC"'));

  UPDATE public.ca_drift_incidents
     SET status = 'resolved',
         resolved_at = now(),
         root_cause = v_cause,
         correction_ref = 'verified: fn_ca_tournament_escrow balances 0.00/0.00/0.00 at '
                          || to_char(now(), 'YYYY-MM-DD HH24:MI:SS "UTC"'),
         resolution = 'Closed by the detector on re-read: the leg it could not see has landed and the event balances. Migration 20260906145058.'
   WHERE id = inc.id AND status <> 'resolved';

  INSERT INTO public.ca_incident_events (incident_id, kind, detail)
  VALUES (inc.id, 'resolved',
          jsonb_build_object('by', 'fn_ca_escrow_incident_closes_when_the_leg_lands',
                             'leg', v_leg, 'leg_landed_at', v_leg_at, 'leg_source', v_leg_src,
                             'ended_at', v_ended,
                             'lag_seconds', CASE WHEN v_leg_at IS NULL OR v_ended IS NULL THEN NULL
                                                 ELSE round(extract(epoch FROM (v_leg_at - v_ended))) END));
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  -- Part 7.3 of the programme record: a handler that writes only to the
  -- Postgres log hides the failure where nobody reads. File it where a person
  -- looks, then let the caller continue.
  INSERT INTO public.ca_incident_file_failures
    (source, dedupe_key, classification, severity, discrepancy, sqlstate, message, db_role, app_name)
  VALUES ('fn_ca_escrow_incident_closes_when_the_leg_lands',
          'close:' || p_incident_id::text, 'settlement_error', 'info', 0,
          SQLSTATE, SQLERRM, current_user, current_setting('application_name', true));
  RETURN false;
END
$fn$;

COMMENT ON FUNCTION public.fn_ca_escrow_incident_closes_when_the_leg_lands(uuid) IS
  'Re-reads one open fn_ca_escrow_vs_counter_check incident against '
  'fn_ca_tournament_escrow and resolves it, naming the leg that landed late, '
  'when the event balances. Detector bookkeeping; moves no chips. 20260906145058.';

GRANT EXECUTE ON FUNCTION public.fn_ca_escrow_incident_closes_when_the_leg_lands(uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.fn_ca_escrow_incident_closes_when_the_leg_lands(uuid) FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The detector re-reads what it holds open, every run, before it looks for
--    anything new. Body otherwise byte-identical to 20260903014000.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_vs_counter_check(p_hours integer DEFAULT 3, p_warning_cap integer DEFAULT 5)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
  v_reread       integer := 0;
  v_self_closed  integer := 0;
  v_by_variant   jsonb;
  v_summary      jsonb;
  v_state        text;
  v_msg          text;
BEGIN
  /* 2026-09-06 (H2): what this detector filed and still holds open is re-read
     first. A settlement leg that landed after the detector looked - a fee
     settled by the sweep, a place paid by the reconciler - leaves an incident
     that the board shows as owed money for days. The detector closes its own
     false alarm, naming the leg and the lag, and moves no chips. */
  FOR r IN
    SELECT i.id
      FROM public.ca_drift_incidents i
     WHERE i.source = 'fn_ca_escrow_vs_counter_check'
       AND i.status <> 'resolved'
       AND i.entity_id IS NOT NULL
     ORDER BY i.detected_at
     LIMIT 500
  LOOP
    v_reread := v_reread + 1;
    IF public.fn_ca_escrow_incident_closes_when_the_leg_lands(r.id) THEN
      v_self_closed := v_self_closed + 1;
    END IF;
  END LOOP;

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
    'open_incidents_reread', v_reread,
    'open_incidents_self_closed', v_self_closed,
    'by_variant', v_by_variant,
    'elapsed_ms', (extract(epoch FROM (clock_timestamp() - v_started)) * 1000)::integer);

  INSERT INTO public.ca_escrow_shadow_runs (hours, elapsed_ms, summary)
  VALUES (p_hours, (v_summary->>'elapsed_ms')::integer, v_summary);

  RETURN v_summary;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Shape A: the seven settled 2026-09-02 events, closed by hand with the
--    migration that fixed each mechanism. Each UPDATE asserts the live
--    residual it is closing, so it aborts if the board moved.
-- ---------------------------------------------------------------------------
DO $shape_a$
DECLARE
  v_n int;
  v_bal numeric;
  r record;
BEGIN
  -- the four double-paid overlays
  FOR r IN
    SELECT * FROM (VALUES
      ('f2502226-d3d0-4de5-8067-41858de3c06e'::uuid, -920.00, 460.00, 'Union Grand Championship (NLH)'),
      ('1f97c186-bf78-4336-aaad-afffd196335d'::uuid, -700.00, 350.00, 'Union Mystery Bounty (PLO5)'),
      ('4375d276-de0e-4ffa-aaee-a7c0121de4cb'::uuid, -350.00, 175.00, 'Evening Mystery Bounty (PLO5)'),
      ('9a7f48d2-2c34-4f97-8993-ed784d75bcbd'::uuid,  -32.00,  16.00, 'Turbo Tuesday Opener')
    ) AS v(tid, expected_prize_balance, overlay, nm)
  LOOP
    SELECT prize_balance INTO v_bal FROM public.fn_ca_tournament_escrow(r.tid);
    IF v_bal IS DISTINCT FROM r.expected_prize_balance THEN
      RAISE EXCEPTION 'ABORT: % prize_balance is % now, expected % - the board moved, re-read before closing',
        r.nm, v_bal, r.expected_prize_balance;
    END IF;
    SELECT round(COALESCE(sum(amount), 0), 2) INTO v_bal
      FROM public.tournament_payouts
     WHERE tournament_id = r.tid AND source = 'overlay_backpay';
    IF v_bal <> r.overlay THEN
      RAISE EXCEPTION 'ABORT: % overlay_backpay rows sum to %, expected %', r.nm, v_bal, r.overlay;
    END IF;
    SELECT round(COALESCE(sum(amount), 0), 2) INTO v_bal
      FROM public.tournament_payouts
     WHERE tournament_id = r.tid AND source = 'reconcile';
    IF v_bal <> r.overlay THEN
      RAISE EXCEPTION 'ABORT: % reconcile rows sum to %, expected % (the second payment of the overlay)', r.nm, v_bal, r.overlay;
    END IF;

    UPDATE public.ca_drift_incidents
       SET status = 'resolved', resolved_at = now(),
             correction_ref = 'migration 20260902042044_the_reconciler_counts_the_overlay_backpay',
           root_cause = format(
             '%s: the guarantee overlay of %s was paid twice on 2026-09-02 - at 01:19 by the back-payment migration (source overlay_backpay) and at 03:54 by fn_tournament_payout_reconcile (source reconcile), which could not see the first because no tournament_payouts row recorded it. Verified per player: same user, position and amount at both times. The shadow residual of %s is exactly twice the overlay.',
             r.nm, r.overlay, r.expected_prize_balance),
           resolution = 'Closed 2026-09-06 (H2). Fixed on 2026-09-02 by 20260902041907 (the record shows every prize paid) and 20260902042044 (the reconciler counts overlay_backpay). Dan ruled no clawback: the house absorbed it. No recurrence: every asserted event ended since 2026-09-04 balances. No chips moved to close this.'
     WHERE source = 'fn_ca_escrow_vs_counter_check' AND entity_id = r.tid AND status <> 'resolved';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'ABORT: expected exactly one open escrow incident for %, updated %', r.nm, v_n;
    END IF;
  END LOOP;

  -- the two freerolls settled under 10.9
  SELECT prize_balance INTO v_bal FROM public.fn_ca_tournament_escrow('39f751e9-b905-4735-8cab-fe431220fd43');
  IF v_bal <> -41.71 THEN RAISE EXCEPTION 'ABORT: 12:00 AM freeroll prize_balance is %, expected -41.71', v_bal; END IF;
  UPDATE public.ca_drift_incidents
     SET status = 'resolved', resolved_at = now(),
         correction_ref = 'migration 20260902162954_settle_two_tournaments_frozen_by_the_engineless_table_defect',
         root_cause = '$100 Freeroll 12:00 AM: settled by hand on 2026-09-02 after the engineless-table defect (PR #2643). The recorded finishing order was kept and one player inserted; the twenty already-paid places below 2nd were each one place too generous and none was clawed back. The 41.71 the shadow shows as overpaid is that absorbed overpay, stated in the settlement header.',
         resolution = 'Closed 2026-09-06 (H2). Authority: Dan 2026-09-02, CLAUDE.md 10.9 rule 3 (an overpay our defect caused is absorbed and left alone). No chips moved to close this.'
   WHERE source = 'fn_ca_escrow_vs_counter_check' AND entity_id = '39f751e9-b905-4735-8cab-fe431220fd43' AND status <> 'resolved';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'ABORT: 12:00 AM freeroll: expected one open incident, updated %', v_n; END IF;

  SELECT prize_balance INTO v_bal FROM public.fn_ca_tournament_escrow('f1b134c0-6a71-4349-a8ef-e344ff12439e');
  IF v_bal <> -100.00 THEN RAISE EXCEPTION 'ABORT: 6:00 PM freeroll prize_balance is %, expected -100.00', v_bal; END IF;
  UPDATE public.ca_drift_incidents
     SET status = 'resolved', resolved_at = now(),
         correction_ref = 'migration 20260902162954_settle_two_tournaments_frozen_by_the_engineless_table_defect',
         root_cause = '$100 Freeroll 6:00 PM: a freeroll (prize_in 0.00) whose 100.00 guarantee was paid to its nine placed players by fn_tournament_payout_reconcile on 2026-09-02 16:29, settling an event frozen 15 hours by the engineless-table defect. No bank -> prize_liability overlay leg was journaled because that leg did not exist on 09-02, so the shadow reads the whole guarantee as paid from nothing.',
         resolution = 'Closed 2026-09-06 (H2). The players were owed 100.00 and received 100.00; the union bank funded it. The overlay journal leg the shadow wants is written by the lock trigger for every event since 2026-09-03 (see fn_ca_tournament_escrow ov CTE). No recurrence since 2026-09-04. No chips moved to close this.'
   WHERE source = 'fn_ca_escrow_vs_counter_check' AND entity_id = 'f1b134c0-6a71-4349-a8ef-e344ff12439e' AND status <> 'resolved';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'ABORT: 6:00 PM freeroll: expected one open incident, updated %', v_n; END IF;

  -- the satellite seat honoured in chips
  SELECT prize_balance INTO v_bal FROM public.fn_ca_tournament_escrow('91dd8dbf-108c-4b4e-b067-3f36d16bb746');
  IF v_bal <> -92.00 THEN RAISE EXCEPTION 'ABORT: satellite prize_balance is %, expected -92.00', v_bal; END IF;
  UPDATE public.ca_drift_incidents
     SET status = 'resolved', resolved_at = now(),
         correction_ref = 'migration 20260903020000_a_satellite_seat_is_paid_from_the_satellites_own_pool',
         root_cause = 'Sunday Deep Stack Satellite $5 (2026-09-02 20:14): one seat to the Sunday $200 Deep Stack was honoured as 200.00 chips ("Satellite seat fallback (registration failed)") against 108.00 collected into the prize pool. The union paid the seat it promised; the 92.00 seat overlay had no journal leg because the satellite pool_transfer leg did not exist on 09-02.',
         resolution = 'Closed 2026-09-06 (H2). The seat winner received the full seat value; the union bank absorbed the 92.00 overlay, which is what a satellite guarantee is. The pool_transfer leg that journals this for every satellite since is 20260903020000 and the phase 5 gate of 2026-09-05. No recurrence since 2026-09-04. No chips moved to close this.'
   WHERE source = 'fn_ca_escrow_vs_counter_check' AND entity_id = '91dd8dbf-108c-4b4e-b067-3f36d16bb746' AND status <> 'resolved';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'ABORT: satellite: expected one open incident, updated %', v_n; END IF;

  RAISE NOTICE 'SHAPE_A_CLOSED 7 settled 2026-09-02 events, each against its live residual';
END $shape_a$;

-- ---------------------------------------------------------------------------
-- 4. Shape B: run the detector's own re-read over what it holds open. This
--    is the new code path exercised once, not a hand-written close. It only
--    closes an incident whose event balances 0.00/0.00/0.00 right now.
-- ---------------------------------------------------------------------------
DO $shape_b$
DECLARE
  r record;
  v_open_before int;
  v_closed int := 0;
  v_still int;
BEGIN
  SELECT count(*) INTO v_open_before FROM public.ca_drift_incidents
   WHERE source = 'fn_ca_escrow_vs_counter_check' AND status <> 'resolved';

  FOR r IN SELECT id FROM public.ca_drift_incidents
            WHERE source = 'fn_ca_escrow_vs_counter_check' AND status <> 'resolved'
            ORDER BY detected_at
  LOOP
    IF public.fn_ca_escrow_incident_closes_when_the_leg_lands(r.id) THEN
      v_closed := v_closed + 1;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_still FROM public.ca_drift_incidents
   WHERE source = 'fn_ca_escrow_vs_counter_check' AND status <> 'resolved';

  IF EXISTS (SELECT 1 FROM public.ca_incident_file_failures
              WHERE source = 'fn_ca_escrow_incident_closes_when_the_leg_lands'
                AND occurred_at > now() - interval '2 minutes') THEN
    RAISE EXCEPTION 'ABORT: the self-close helper filed a failure while closing shape B - read ca_incident_file_failures';
  END IF;

  RAISE NOTICE 'SHAPE_B open before % closed on re-read % still open %', v_open_before, v_closed, v_still;
  -- Measured 14:50 UTC before writing: 23 balance now. If a leg is still
  -- landing for one of them the count is lower and the incident stays open,
  -- which is correct - nothing here forces a close.
  IF v_closed < 20 THEN
    RAISE EXCEPTION 'ABORT: expected about 23 shape-B incidents to balance on re-read, only % did - re-read before applying', v_closed;
  END IF;
END $shape_b$;

-- ---------------------------------------------------------------------------
-- 5. Prove the helper refuses to close what still owes. A rolled-back probe:
--    file an escrow incident for a tournament that does NOT balance and assert
--    the helper returns false and leaves it open.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_tid uuid;
  v_inc uuid;
  v_done boolean := false;
BEGIN
  BEGIN
    -- Union Grand Championship: the double-paid overlay leaves its escrow at
    -- -920.00 for good (no clawback), so it is a stable "still owes" fixture.
    v_tid := 'f2502226-d3d0-4de5-8067-41858de3c06e';
    IF abs((SELECT prize_balance FROM public.fn_ca_tournament_escrow(v_tid))) <= 1 THEN
      RAISE EXCEPTION 'VERIFY SKIPPED: the fixture tournament balances now; pick another unbalanced event to probe with';
    END IF;

    INSERT INTO public.ca_drift_incidents
      (classification, severity, layer, source, dedupe_key, entity_type, entity_id,
       discrepancy_amount, suspected_cause)
    VALUES ('settlement_error', 'info', 'ledger', 'fn_ca_escrow_vs_counter_check',
            'zz-verify-escrow-' || clock_timestamp()::text, 'tournament', v_tid,
            1, 'verify: the helper must not close an event that still owes')
    RETURNING id INTO v_inc;

    IF public.fn_ca_escrow_incident_closes_when_the_leg_lands(v_inc) THEN
      RAISE EXCEPTION 'VERIFY FAILED: the helper closed an incident whose event does not balance';
    END IF;
    IF (SELECT status FROM public.ca_drift_incidents WHERE id = v_inc) = 'resolved' THEN
      RAISE EXCEPTION 'VERIFY FAILED: the incident was resolved despite the helper returning false';
    END IF;
    v_done := true;
    RAISE EXCEPTION 'ca_verify_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'VERIFY SKIPPED%' THEN
      RAISE NOTICE '%', SQLERRM;
      v_done := true;
    ELSIF SQLERRM <> 'ca_verify_rollback' THEN
      RAISE;
    END IF;
  END;
  IF NOT v_done THEN RAISE EXCEPTION 'VERIFY FAILED: probe did not complete'; END IF;
  IF EXISTS (SELECT 1 FROM public.ca_drift_incidents WHERE dedupe_key LIKE 'zz-verify-escrow-%') THEN
    RAISE EXCEPTION 'VERIFY FAILED: the probe incident survived its rollback';
  END IF;
  RAISE NOTICE 'ESCROW_SELF_CLOSE_VERIFIED the helper leaves an owed event open; probe rolled back';
END $verify$;

COMMIT;
