-- SUPERSEDED BY 20261015124934: never installed; refused whole (P0404) because the settler lag incident it resolved carried no root cause. The replacement leaves that incident open.
-- @live-proof: (SELECT count(*) FROM public.financial_alerts WHERE resolved IS NOT TRUE AND (source IN ('Tournament.table_admission_failing','GameServer.tournament_dark_after_rebuild','postHandTasks.leave_pending_failed','fn_money_check_health','drift_incident:financial_alerts:fn_money_check_health','TournamentRecurring.freeBuyAudit','drift_incident:fn_ca_settlement_correctness_check:settler_lag')) AND created_at < timestamptz '2026-10-15 10:15:00+00')=0
-- 20261015101531_the_open_alerts_close_on_their_verified_causes.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- Every financial_alerts row and drift incident this file closes was read
-- against production on 2026-10-15, and each group re-asserts the reading it
-- is closed on before it is closed, so the file rolls back whole if the board
-- has moved. Nothing here moves money, rewrites a ledger row or deletes
-- anything (CLAUDE.md 10.9, 10.12). Where a cause needed a fix, the fix is
-- named; where a detector misread a state the platform produces on purpose,
-- the detector is corrected in its own migration.
--
-- LEFT OPEN ON PURPOSE (each is true today):
--   union_accounting_scheduler x3, fn_union_treasury_selftest x2 and their
--     drift incidents: the original week (2026-10-05 -> 10-12) has not closed.
--     They close with the week.
--   fn_union_age_invoices x2, fn_union_enforce_stop_loss x2 and their drift
--     incidents: Club JAQK (126,153.66) and SHARK CLUB (124,015.29) have not
--     paid their 2026-09-28 -> 10-05 square-up statements (ECO win tax), now
--     7 days past due. A debt between a club and its union, not a defect.
--   fn_tournament_money_conservation x56: closed by the scan itself on its
--     next hourly pass once 20261015100003 is installed.
--   drift_incident:ledger_invariant.refused (09:31 today): the refused
--     transaction of another change, rolled back whole; that change owns it.
--   fn_spin_fairness_check (critical 04:44, warning 22:44) and incident
--     ba5d559f: the 7-day window reads chi-square about 26.9 on 7 df. Every
--     receipt drew from the published ladder with no locked tier, and over
--     42 days (267,415 draws) the same test reads 13.27 (p about 0.07), so
--     the reading looks like chance; it stays open for its owner to judge
--     and closes on the check's own reading.
--
-- THE GROUPS
--
--  A. Freeroll a38b88a9 (100 Chip Guarantee Freeroll, 6:00 AM, 2026-10-13):
--     Tournament.table_admission_failing x8 (04:10 today) and
--     GameServer.tournament_dark_after_rebuild (2026-10-13). The event was
--     unfrozen and finished: COMPLETED at 05:22:52, all 27 places paid to the
--     100.00 pool, its Diamond book conserved (delta 0.00). The refusal
--     (successor_financial_claim_spent) was fixed at the root by
--     20261015011723 (a code defect never spends a hand's one settlement
--     claim).
--
--  B. postHandTasks.leave_pending_failed x85, moves_chips false on every one.
--     83 are 'record "new" has no field "metadata"' between 13:15 and 13:52
--     on 2026-10-13 on two tables: a trigger read a column the table does not
--     have, and it was replaced inside that window; none since, and no
--     trigger on any table today reads NEW.metadata where the table has no
--     metadata column (asserted). 2 are Cloudflare 502 pages (2026-10-14
--     14:27, 2026-10-15 05:48): the departures read now asks again inside the
--     boundary on a gateway failure (server/src/services/supabase/seats.ts,
--     "A GATEWAY BLIP IS NOT THE DATABASE ANSWERING"). Every pending
--     departure stayed leave_pending with its stack and was re-read at the
--     next hand boundary.
--
--  C. fn_money_check_health x7 (10:07 today) and their seven drift
--     incidents. Raised by one diagnostic call made while building the launch
--     health reading: that board is scheduled by no job, and its heartbeat
--     writer (fn_record_money_check_run) is no longer called by the checks it
--     lists. Each check is asserted running on its own cron job;
--     fn_backpay_unfinalised_bounty_pools had its schedule retired on
--     2026-09-22 (docs/BAND-AIDS-REGISTER.md item 3). fn_ca_launch_health
--     (20261015101222) does not call the board.
--
--  D. Settler lag drift incident c748f59f (2026-10-13 16:15): the rakeback
--     settler reads healthy (fn_settler_lag_check: 0.2 h behind, not
--     stalled).
--
--  E. TournamentRecurring.freeBuyAudit (2026-10-13 18:01): Midway published
--     no Free Buy from the Midday slot of 2026-10-13 to the Afternoon slot of
--     2026-10-14 (eight slots). The board resumed with the Prime Time slot of
--     2026-10-15 01:00 UTC once the floor lease was fixed, and every slot
--     due since then is published (asserted). The missed free events are not
--     re-run: nothing was bought into them.
--
-- Wrap ALL DDL for one change in ONE transaction (club-arena CLAUDE.md,
-- production DDL policy). This file carries no DDL.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL search_path = public;

DO $operator$
BEGIN
  IF current_user <> 'postgres' OR session_user <> 'postgres'
     OR NULLIF(current_setting('request.jwt.claims', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'alert_triage_operator_refused' USING ERRCODE = '42501';
  END IF;
END
$operator$;

-- A. THE FREEROLL ------------------------------------------------------------
DO $a$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tournaments t
                  WHERE t.id = 'a38b88a9-5480-4e34-b04f-d669ff8fc8a8'
                    AND t.status = 'COMPLETED' AND t.prize_pool = 100.00
                    AND public.fn_tournament_conservation_delta(t.id) = 0
                    AND (SELECT sum(p.amount) FROM public.tournament_payouts p
                          WHERE p.tournament_id = t.id) = 100.00
                    AND NOT EXISTS (SELECT 1 FROM public.tournament_players p
                                     WHERE p.tournament_id = t.id
                                       AND p.status IN ('registered', 'playing'))) THEN
    RAISE EXCEPTION 'A: the freeroll is not completed, paid and conserved';
  END IF;
END
$a$;
UPDATE public.financial_alerts SET resolved = true, resolved_at = now(),
  resolution = 'verified 2026-10-15: tournament a38b88a9 was unfrozen and finished, COMPLETED at 05:22:52 UTC, all 27 places paid to its 100.00 pool and its Diamond book conserved (delta 0.00). The refusal successor_financial_claim_spent was fixed at the root by 20261015011723 (a code defect never spends a hand''s one settlement claim). migration 20261015101531'
 WHERE resolved IS NOT TRUE
   AND ((source = 'Tournament.table_admission_failing'
         AND context->>'tournament_id' = 'a38b88a9-5480-4e34-b04f-d669ff8fc8a8')
        OR id = '383be67c-cdb3-4098-8aa1-877fbfd8a532');

-- B. LEAVE_PENDING -----------------------------------------------------------
DO $b$
BEGIN
  IF EXISTS (SELECT 1 FROM public.financial_alerts f
              WHERE f.source = 'postHandTasks.leave_pending_failed'
                AND f.context->>'error' LIKE '%has no field "metadata"%'
                AND f.created_at > timestamptz '2026-10-13 13:53:00+00') THEN
    RAISE EXCEPTION 'B: the metadata trigger defect has recurred';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger tg JOIN pg_proc p ON p.oid = tg.tgfoid
              JOIN pg_class c ON c.oid = tg.tgrelid
             WHERE NOT tg.tgisinternal AND c.relnamespace = 'public'::regnamespace
               AND p.prosrc ~* 'new\.metadata'
               AND NOT EXISTS (SELECT 1 FROM pg_attribute a
                                WHERE a.attrelid = c.oid AND a.attname = 'metadata'
                                  AND NOT a.attisdropped)) THEN
    RAISE EXCEPTION 'B: a trigger reads NEW.metadata on a table without it';
  END IF;
  IF EXISTS (SELECT 1 FROM public.financial_alerts f
              WHERE f.source = 'postHandTasks.leave_pending_failed'
                AND f.resolved IS NOT TRUE
                AND f.created_at <= timestamptz '2026-10-15 05:49:00+00'
                AND (f.context->>'moves_chips') IS DISTINCT FROM 'false') THEN
    RAISE EXCEPTION 'B: an open leave_pending alert moved chips';
  END IF;
END
$b$;
UPDATE public.financial_alerts SET resolved = true, resolved_at = now(),
  resolution = CASE
    WHEN context->>'error' LIKE '%has no field "metadata"%' THEN
      'verified 2026-10-15: one of 83 refusals between 13:15 and 13:52 UTC on 2026-10-13 from a trigger that read NEW.metadata on a table without that column; it was replaced inside that window, none has recurred, and no trigger reads NEW.metadata on a table without it today. moves_chips false: the departure stayed leave_pending with its stack and was re-read at the next hand boundary. migration 20261015101531'
    ELSE
      'verified 2026-10-15: a Cloudflare 502 page on the departures read (moves_chips false); the departure stayed leave_pending with its stack and was re-read at the next hand boundary. Root fix: the departures read asks again inside the boundary on a gateway failure (seats.ts, A GATEWAY BLIP IS NOT THE DATABASE ANSWERING). migration 20261015101531'
  END
 WHERE resolved IS NOT TRUE
   AND source = 'postHandTasks.leave_pending_failed'
   AND created_at <= timestamptz '2026-10-15 05:49:00+00'
   AND (context->>'error' LIKE '%has no field "metadata"%'
        OR context->>'error' ILIKE '%bad gateway%');

-- C. THE UNSCHEDULED MONEY CHECK BOARD ---------------------------------------
DO $c$
DECLARE r record;
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job j WHERE j.command ILIKE '%fn_money_check_health%') THEN
    RAISE EXCEPTION 'C: fn_money_check_health is scheduled after all';
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job j WHERE j.command ILIKE '%fn_backpay_unfinalised_bounty_pools%') THEN
    RAISE EXCEPTION 'C: the retired bounty backpay is scheduled again';
  END IF;
  FOR r IN SELECT * FROM (VALUES
      ('fn_cash_pot_conservation_check', interval '13 hours'),
      ('fn_detect_results_without_a_hand', interval '13 hours'),
      ('fn_pay_backed_payout_shortfalls', interval '3 hours'),
      ('fn_payout_guarantee_check', interval '3 hours'),
      ('fn_tournament_money_conservation', interval '3 hours'),
      ('fn_uncollected_entry_check', interval '3 hours')) v(fn, within) LOOP
    IF NOT EXISTS (SELECT 1 FROM cron.job j JOIN cron.job_run_details d ON d.jobid = j.jobid
                    WHERE j.active AND j.command ILIKE '%' || r.fn || '%'
                      AND d.status = 'succeeded' AND d.end_time > now() - r.within) THEN
      RAISE EXCEPTION 'C: % has not succeeded on its own job within %', r.fn, r.within;
    END IF;
  END LOOP;
END
$c$;
SELECT public.fn_ca_incident_action(
         i.id, 'resolve',
         'Not a silent check. Raised by one diagnostic call to fn_money_check_health, which no job schedules and whose heartbeat writer the listed checks no longer call. Each listed check is running on its own cron job (asserted); fn_backpay_unfinalised_bounty_pools had its schedule retired on 2026-09-22. migration 20261015101531',
         NULL,
         'An unscheduled heartbeat board was read by hand; its heartbeats are no longer written.',
         'migration 20261015101531')
  FROM public.ca_drift_incidents i
  JOIN public.financial_alerts f
    ON f.source = 'drift_incident:financial_alerts:fn_money_check_health'
   AND (f.context->>'incident_id')::uuid = i.id
 WHERE i.resolved_at IS NULL
   AND f.created_at = timestamptz '2026-10-15 10:07:10.721629+00';
UPDATE public.financial_alerts SET resolved = true, resolved_at = now(),
  resolution = 'verified 2026-10-15: raised by one diagnostic call to fn_money_check_health, which no job schedules and whose heartbeat writer the listed checks no longer call. Each listed check is running on its own cron job (asserted); fn_backpay_unfinalised_bounty_pools had its schedule retired on 2026-09-22 (docs/BAND-AIDS-REGISTER.md item 3). migration 20261015101531'
 WHERE resolved IS NOT TRUE
   AND source IN ('fn_money_check_health', 'drift_incident:financial_alerts:fn_money_check_health')
   AND created_at = timestamptz '2026-10-15 10:07:10.721629+00';

-- D. SETTLER LAG -------------------------------------------------------------
DO $d$
BEGIN
  IF (public.fn_settler_lag_check()->>'healthy') IS DISTINCT FROM 'true'
     OR (public.fn_settler_lag_check()->>'stalled') IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'D: the rakeback settler is not healthy';
  END IF;
END
$d$;
SELECT public.fn_ca_incident_action(
         i.id, 'resolve',
         'The rakeback settler reads healthy and not stalled (fn_settler_lag_check). migration 20261015101531',
         NULL, NULL, 'migration 20261015101531')
  FROM public.ca_drift_incidents i
 WHERE i.id = 'c748f59f-30eb-4e05-8652-0eea387abfd8' AND i.resolved_at IS NULL;
UPDATE public.financial_alerts SET resolved = true, resolved_at = now(),
  resolution = 'verified 2026-10-15: the rakeback settler reads healthy and not stalled (fn_settler_lag_check), and incident c748f59f is resolved. migration 20261015101531'
 WHERE resolved IS NOT TRUE
   AND source = 'drift_incident:fn_ca_settlement_correctness_check:settler_lag'
   AND context->>'incident_id' = 'c748f59f-30eb-4e05-8652-0eea387abfd8';

-- E. THE FREE BUY BOARD ------------------------------------------------------
DO $e$
BEGIN
  IF (SELECT count(*) FROM public.tournaments t
       WHERE t.union_id = 'fade0000-0000-0000-0000-000000000001' AND t.free_buy
         AND (t.name, t.start_time) IN (
           ('Prime Time Free Buy (NLH)', timestamptz '2026-10-15 01:00:00+00'),
           ('Midnight Free Buy (NLH)',   timestamptz '2026-10-15 05:00:00+00'),
           ('Morning Free Buy (NLH)',    timestamptz '2026-10-15 13:00:00+00'))) <> 3 THEN
    RAISE EXCEPTION 'E: a Free Buy slot due since the board resumed is missing';
  END IF;
END
$e$;
UPDATE public.financial_alerts SET resolved = true, resolved_at = now(),
  resolution = 'verified 2026-10-15: Midway published no Free Buy from the Midday slot of 2026-10-13 to the Afternoon slot of 2026-10-14 (eight slots). The board resumed with Prime Time at 2026-10-15 01:00 UTC once the floor lease was fixed, and every slot due since is published (asserted). The missed free events are not re-run; nothing was bought into them. migration 20261015101531'
 WHERE resolved IS NOT TRUE
   AND source = 'TournamentRecurring.freeBuyAudit'
   AND id = 'f2c43ab2-fe2d-45d6-a7db-0055a1000ae7';

-- EVERY GROUP CLOSED ---------------------------------------------------------
DO $closed$
BEGIN
  IF (SELECT count(*) FROM public.financial_alerts
       WHERE resolved IS NOT TRUE AND created_at < timestamptz '2026-10-15 10:15:00+00'
         AND (source IN ('Tournament.table_admission_failing', 'GameServer.tournament_dark_after_rebuild',
                         'postHandTasks.leave_pending_failed', 'fn_money_check_health',
                         'drift_incident:financial_alerts:fn_money_check_health',
                         'TournamentRecurring.freeBuyAudit',
                         'drift_incident:fn_ca_settlement_correctness_check:settler_lag'))) <> 0 THEN
    RAISE EXCEPTION 'an alert this file reads as closed is still open';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_drift_incidents i
              WHERE i.resolved_at IS NULL
                AND (i.id = 'c748f59f-30eb-4e05-8652-0eea387abfd8'
                     OR i.id IN (SELECT (f.context->>'incident_id')::uuid FROM public.financial_alerts f
                                  WHERE f.source = 'drift_incident:financial_alerts:fn_money_check_health'
                                    AND f.created_at = timestamptz '2026-10-15 10:07:10.721629+00'))) THEN
    RAISE EXCEPTION 'an incident this file resolves is still open';
  END IF;
END
$closed$;

COMMIT;
