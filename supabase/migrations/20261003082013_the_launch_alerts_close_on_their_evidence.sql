-- 20261003082013_the_launch_alerts_close_on_their_evidence
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-03 08:20:13 UTC.
--
-- THE LAUNCH ALERTS CLOSE ON THEIR EVIDENCE (2026-10-03)
--
-- Twenty open critical financial_alerts, each closed here on rows read from
-- production 2026-10-03 08:00-08:30 UTC. No money row is written and no
-- function changes; resolving an alert closes its drift-incident mirror
-- through zz_ca_alert_resolution_reaches_the_incident.
--
--   S   1  79cdb720 Tournament.satellite_qualifiers_outcome_unknown, satellite
--          00efaa48 "Sunday Funday Main Event Satellite". The engine's call
--          timed out AFTER fn_ca_settle_satellite_cohort committed: the
--          tournament_satellite_settlements row exists (receipt_version 3,
--          settled 21:30:44, pool 810.00, 8 awards = 3 seats + 1 cash + 4
--          entry tickets, remainder 10.00) for exactly the eight qualifier_ids
--          the alert names, and the satellite is COMPLETED. The tickets that
--          could not be spent are fixed by 20261003051648 (see
--          docs/changelog/2026-10-03-a-cohort-satellite-ticket-is-redeemable.md).
--
--   R  19  11 ServerTableEngine.authoritative_hand_semantic_refusal + 8
--          postHandTasks.hand_history_failed, 2026-10-02 22:27:32-22:27:42,
--          all "atomic hand commit refused (lease_proof_expired)": one
--          lease-loss burst over 13 hands on 12 tables. Per alert: no
--          hand_atomic_commits row for the hand id or its table/number, no
--          rake_records row, no chip_ledger leg; every table committed later
--          hands (the successor generation, 22:28-22:29). The hand was rolled
--          back whole and no chip moved. 309 siblings of the same burst were
--          closed by fn_resolve_settled_financial_alerts class 4, whose retry
--          DID commit the exact original hand. These 19 were never committed,
--          and class 4 deliberately does not certify a rollback (stage 1 of
--          20260917044635), so it cannot close them; this is the same proof
--          20261002171245 class A used for 249 rows of the same kind.
--
-- GUARDS: refuses in the break window; each class must match its count
-- exactly or nothing is resolved.
--
-- @live-proof: (SELECT count(*) FROM public.financial_alerts WHERE resolved AND resolution LIKE '%migration 20261003082013_the_launch_alerts_close_on_their_evidence%') = 20

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $pre$
DECLARE v_reason text;
BEGIN
  v_reason := public.fn_ca_break_window_refuses_migrations(now());
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'LAUNCH_ALERTS_REFUSED: %', v_reason USING ERRCODE = '55000';
  END IF;
END
$pre$;

DO $s$
DECLARE v_n int;
BEGIN
  UPDATE public.financial_alerts a
     SET resolved = true, resolved_at = now(),
         resolution = 'verified: satellite 00efaa48 settled whole before the engine call timed out - tournament_satellite_settlements receipt v3 at '
           || s.settled_at::text || ', pool ' || s.pool::text || ', ' || s.ticket_award_count::text || ' awards ('
           || s.seat_count::text || ' seats, ' || s.cash_ticket_count::text || ' cash, ' || s.entry_ticket_count::text
           || ' entry tickets), remainder ' || s.remainder::text || ', for exactly the eight qualifiers named here; satellite COMPLETED. '
           || 'Unspendable v3 tickets fixed by 20261003051648. migration 20261003082013_the_launch_alerts_close_on_their_evidence'
    FROM public.tournament_satellite_settlements s
    JOIN public.tournaments t ON t.id = s.tournament_id
   WHERE a.id = '79cdb720-ab76-41da-9212-76b67e39174e'
     AND a.resolved IS NOT TRUE
     AND a.source = 'Tournament.satellite_qualifiers_outcome_unknown'
     AND s.tournament_id = (a.context->>'tournament_id')::uuid
     AND s.receipt_version = 3
     AND s.settled_at IS NOT NULL
     AND t.status = 'COMPLETED'
     AND s.ticket_award_count = 8
     AND s.seat_count + s.cash_ticket_count + s.entry_ticket_count = s.ticket_award_count
     AND (SELECT array_agg(x ORDER BY x) FROM unnest(s.qualifier_ids) x)
         = (SELECT array_agg(x::uuid ORDER BY x::uuid) FROM jsonb_array_elements_text(a.context->'qualifier_ids') x);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'class S: expected 1 alert, matched %', v_n;
  END IF;
END
$s$;

DO $r$
DECLARE v_n int;
BEGIN
  UPDATE public.financial_alerts a
     SET resolved = true, resolved_at = now(),
         resolution = 'verified: atomic hand commit refused (lease_proof_expired) rolled hand ' || (a.context->'hand_request_identity_v1'->>'hand_id')
           || ' (table ' || (a.context->>'table_id') || ' #' || (a.context->>'hand_number')
           || ') back whole - no hand_atomic_commits row for the hand or its number, no rake_records row and no chip_ledger leg, so no chip moved '
           || 'and no history is owed; the table committed later hands, so its stacks were carried by the database. '
           || 'migration 20261003082013_the_launch_alerts_close_on_their_evidence'
   WHERE a.resolved IS NOT TRUE
     AND a.created_at >= '2026-10-02 22:27:00+00' AND a.created_at < '2026-10-02 22:28:00+00'
     AND a.source IN ('postHandTasks.hand_history_failed', 'ServerTableEngine.authoritative_hand_semantic_refusal')
     AND a.context->>'error' = 'atomic hand commit refused (lease_proof_expired)'
     AND (a.context->'hand_request_identity_v1'->>'hand_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND (a.context->>'table_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND (a.context->>'hand_number') ~ '^[0-9]{1,15}$'
     AND NOT EXISTS (SELECT 1 FROM public.hand_atomic_commits c
                      WHERE c.hand_id = (a.context->'hand_request_identity_v1'->>'hand_id')::uuid)
     AND NOT EXISTS (SELECT 1 FROM public.hand_atomic_commits c
                      WHERE c.table_id = (a.context->>'table_id')::uuid
                        AND c.hand_number = (a.context->>'hand_number')::bigint)
     AND NOT EXISTS (SELECT 1 FROM public.rake_records r
                      WHERE r.hand_id = (a.context->'hand_request_identity_v1'->>'hand_id')::uuid)
     AND NOT EXISTS (SELECT 1 FROM public.chip_ledger l
                      WHERE l.created_at BETWEEN a.created_at - interval '1 hour' AND a.created_at + interval '1 hour'
                        AND l.hand_id = (a.context->'hand_request_identity_v1'->>'hand_id')::uuid)
     AND EXISTS (SELECT 1 FROM public.hand_atomic_commits c
                  WHERE c.table_id = (a.context->>'table_id')::uuid
                    AND c.hand_number > (a.context->>'hand_number')::bigint);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 19 THEN
    RAISE EXCEPTION 'class R: expected 19 alerts, matched %', v_n;
  END IF;
END
$r$;

COMMIT;
