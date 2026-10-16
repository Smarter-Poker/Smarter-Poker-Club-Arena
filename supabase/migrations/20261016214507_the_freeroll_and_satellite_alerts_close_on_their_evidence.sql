-- 20261016214507_the_freeroll_and_satellite_alerts_close_on_their_evidence
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-16 21:45:07 UTC.
--
-- THE FREEROLL AND SATELLITE ALERTS CLOSE ON THEIR EVIDENCE (2026-10-16)
--
-- Twelve open critical financial_alerts, each closed here on rows read from
-- production 2026-10-16 21:40-21:50 UTC. No money row is written and no
-- function changes; resolving an alert closes its drift-incident mirror
-- through zz_ca_alert_resolution_reaches_the_incident.
--
--   F  11  85313174 "Coffee Break Freeroll (PLO4)": 10
--          Tournament.table_admission_failing (tables 00986dca, 0aba0649,
--          0c6edb9d, 1738d53b, 30c09ebd, 40dc74c3, 7e04fa02, 7eb131f4,
--          973938f6, cdc8cdcf, 17:22-17:25) and 1
--          GameServer.tournament_dark_after_rebuild (18:49). The cause was
--          f06_movement_prior refusing a mid-hand add-on rebase and a rebought
--          chair, fixed by 20261016183932 (#7137, installed 21:36:05). Within
--          90 s every park took its admission, the event played out and
--          COMPLETED at 21:38:22, every named table is closed, and
--          tournament_payouts carries exactly the 390.40 prize pool.
--
--   S   1  206bee20 Tournament.satellite_qualifiers_refused_repeatedly,
--          9dc3fae9 "Sunday Deep Stack Satellite 25" ("winner at the table
--          cap" for 1179f15e). The satellite settled whole at 18:29:39:
--          tournament_satellite_settlements receipt v3, pool 600.00, three
--          awards for exactly the three qualifiers (two seats in 62dafa63 for
--          1179f15e and 15de44a8, and a 200.00 cash award paid through
--          credit_and_log to 06eb013d, who already held a seat), remainder
--          0, satellite COMPLETED.
--
-- GUARDS: refuses in the break window; each class must match its count
-- exactly or nothing is resolved.
--
-- The two drift-incident mirrors carry this resolution text too (the trigger
-- copies it), so the proof counts the originals only.
-- @live-proof: (SELECT count(*) FROM public.financial_alerts WHERE resolved AND source NOT LIKE 'drift_incident:%' AND resolution LIKE '%migration 20261016214507_the_freeroll_and_satellite_alerts_close_on_their_evidence%') = 12

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $pre$
DECLARE v_reason text;
BEGIN
  v_reason := public.fn_ca_break_window_refuses_migrations(now());
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'FREEROLL_SATELLITE_ALERTS_REFUSED: %', v_reason USING ERRCODE = '55000';
  END IF;
END
$pre$;

DO $f$
DECLARE v_n int;
BEGIN
  UPDATE public.financial_alerts a
     SET resolved = true, resolved_at = now(),
         resolution = 'verified: cause fixed by 20261016183932 (f06_movement_prior admits a receipted mid-hand add-on rebase and a rebought chair); '
           || 'tournament ' || t.id::text || ' COMPLETED at ' || t.ended_at::text
           || CASE WHEN a.source = 'Tournament.table_admission_failing'
                   THEN ', table ' || (a.context->>'table_id') || ' closed' ELSE '' END
           || ', tournament_payouts ' || t.prize_pool::text || ' = prize pool. '
           || 'migration 20261016214507_the_freeroll_and_satellite_alerts_close_on_their_evidence'
    FROM public.tournaments t
   WHERE a.resolved IS NOT TRUE
     AND a.source IN ('Tournament.table_admission_failing', 'GameServer.tournament_dark_after_rebuild')
     AND a.created_at >= '2026-10-16 17:00+00' AND a.created_at < '2026-10-16 19:00+00'
     AND t.id = '85313174-6aea-4c81-b68b-9b3d09a2078e'
     AND (a.context->>'tournament_id') = t.id::text
     AND t.status = 'COMPLETED' AND t.ended_at IS NOT NULL AND t.prize_pool_finalized
     AND NOT EXISTS (SELECT 1 FROM public.tournament_players p
                      WHERE p.tournament_id = t.id AND p.status IN ('playing', 'registered'))
     AND (SELECT sum(p.amount) FROM public.tournament_payouts p WHERE p.tournament_id = t.id) = t.prize_pool
     AND (a.source <> 'Tournament.table_admission_failing'
          OR EXISTS (SELECT 1 FROM public.tables tb
                      WHERE tb.id = (a.context->>'table_id')::uuid
                        AND tb.tournament_id = t.id AND lower(tb.status) = 'closed'));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 11 THEN
    RAISE EXCEPTION 'class F: expected 11 alerts, matched %', v_n;
  END IF;
END
$f$;

DO $s$
DECLARE v_n int;
BEGIN
  UPDATE public.financial_alerts a
     SET resolved = true, resolved_at = now(),
         resolution = 'verified: satellite 9dc3fae9 settled whole at ' || s.settled_at::text
           || ' - tournament_satellite_settlements receipt v3, pool ' || s.pool::text || ', '
           || s.ticket_award_count::text || ' awards (' || s.seat_count::text || ' seats, '
           || s.cash_ticket_count::text || ' cash, ' || s.entry_ticket_count::text
           || ' entry tickets), remainder ' || s.remainder::text
           || ', for exactly the three qualifiers; satellite COMPLETED. '
           || 'migration 20261016214507_the_freeroll_and_satellite_alerts_close_on_their_evidence'
    FROM public.tournament_satellite_settlements s
    JOIN public.tournaments t ON t.id = s.tournament_id
   WHERE a.id = '206bee20-ceb6-4772-b730-7253025197a5'
     AND a.resolved IS NOT TRUE
     AND a.source = 'Tournament.satellite_qualifiers_refused_repeatedly'
     AND s.tournament_id = (a.context->>'tournament_id')::uuid
     AND s.receipt_version = 3
     AND s.settled_at IS NOT NULL
     AND t.status = 'COMPLETED'
     AND s.ticket_award_count = 3
     AND s.seat_count + s.cash_ticket_count + s.entry_ticket_count = s.ticket_award_count
     AND s.remainder = 0
     AND (SELECT count(*) FROM public.tournament_satellite_awards w
           WHERE w.tournament_id = s.tournament_id AND w.user_id = ANY (s.qualifier_ids)) = 3
     AND (SELECT sum(w.amount) FROM public.tournament_satellite_awards w
           WHERE w.tournament_id = s.tournament_id) = s.pool;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'class S: expected 1 alert, matched %', v_n;
  END IF;
END
$s$;

COMMIT;
