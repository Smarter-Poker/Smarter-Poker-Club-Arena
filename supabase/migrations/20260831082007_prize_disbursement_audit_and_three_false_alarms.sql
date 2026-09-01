-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831082007; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT THE CHECKS COULD NOT SEE, AND THREE THAT CRIED WOLF (2026-08-31)
--
-- Phase-2 verification sweep. One real money defect, three defective alarms,
-- one open grant. The real defect was invisible to every existing check for
-- the same reason: they read a SNAPSHOT that a reset overwrites, not the
-- LEDGER that remembers.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- 1. THE REAL ONE — an event that was paid, reset, and paid again.
--
-- "Sunday $200 Deep Stack" (dfae9288) disbursed 62,841.60 against a 44,640
-- prize pool: 18,201.60 of chips that did not come from anywhere.
--
--   2026-08-30 19:47-19:53  a RECOVERY payout paid places 1-9 on the
--                           pre-reset 20,880 pool -> 20,880.00
--   2026-08-30 ~20:00       the outage reset re-opened the event; positions
--                           were cleared and it was replayed
--   2026-08-31 02:32        the reconciler paid the NEW places 1-9 on the
--                           44,640 pool -> 41,961.60 (place 6 skipped: that
--                           player already held 3,132 from the first run,
--                           more than the 2,678.40 the new place pays)
--
-- Eight of the nine first-run recipients finished 62nd-109th on the replay
-- and keep money for places they no longer hold; the ninth is 453.60 over.
-- One human, eight horses - and under 10.5 HORSES ARE PLAYERS that
-- distinction does not exist here.
--
-- WHY NOTHING CAUGHT IT. TournamentSentinel compares
-- SUM(tournament_players.prize) against prize_pool. The reset overwrote
-- tournament_players, so that sum is 44,640 - exactly the pool, perfectly
-- green - while the wallet ledger holds 62,841.60. The check was reading the
-- column the reset rewrites instead of the ledger it cannot.
--
-- CLAWBACK IS NOT AN AGENT'S DECISION. Precedent in this same database:
-- mystery_bounty_double_pay_backlog, "decision_owner: Dan - reversing credits
-- players have already been shown is not an agent decision". Same rule here.
-- This migration measures it, records it, alerts on it, and closes the hole.
-- It moves no chips.
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_tournament_prize_disbursement_audit(p_hours integer DEFAULT 24)
RETURNS TABLE (tournament_id uuid, name text, variant text, prize_pool numeric,
               disbursed numeric, acknowledged numeric, excess numeric, ended_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH t AS (
    SELECT x.id, x.name, x.variant, x.prize_pool::numeric pool, x.ended_at
      FROM public.tournaments x
     WHERE x.status = 'COMPLETED'
       AND x.ended_at > now() - make_interval(hours => GREATEST(COALESCE(p_hours,24),1))
       AND COALESCE(x.prize_pool,0) > 0
  ), paid AS (
    SELECT w.related_entity_id tid, round(sum(w.amount),2) amt
      FROM public.wallet_transactions w
      JOIN t ON t.id = w.related_entity_id
     WHERE w.type = 'credit' AND w.category = 'prize'
     GROUP BY 1
  )
  SELECT t.id, t.name, t.variant, t.pool,
         COALESCE(p.amt,0),
         COALESCE(b.amount,0),
         round(COALESCE(p.amt,0) - t.pool - COALESCE(b.amount,0), 2),
         t.ended_at
    FROM t
    LEFT JOIN paid p ON p.tid = t.id
    LEFT JOIN public.tournament_conservation_baseline b ON b.tournament_id = t.id
   WHERE round(COALESCE(p.amt,0) - t.pool - COALESCE(b.amount,0), 2) > 0.005;
$$;
REVOKE ALL ON FUNCTION public.fn_tournament_prize_disbursement_audit(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_prize_disbursement_audit(integer) TO service_role;

-- Acknowledge every historical excess in the 14-day window so the auditor
-- starts SILENT and only speaks for NEW drift. Sourced from the auditor
-- itself, so the amount matches to the cent by construction. Several
-- satellites ALREADY carry an overlay acknowledgment, and the auditor
-- reports excess NET of it — so this ADDS to that row rather than skipping
-- it, and appends to the reason instead of overwriting the earlier record.
-- Acknowledging is recording, not forgiving.
INSERT INTO public.tournament_conservation_baseline (tournament_id, amount, reason)
SELECT a.tournament_id, a.excess,
       CASE WHEN a.tournament_id = 'dfae9288-40e2-485d-8c97-a13dd53ab483'
            THEN 'DOUBLE PAYMENT, OPEN FOR DAN: paid 62,841.60 against a 44,640 pool. A recovery payout ran on the pre-reset 20,880 pool at 2026-08-30 19:47-19:53, the outage reset then replayed the event, and the reconciler paid the new places in full at 02:32. Eight first-run recipients finished 62nd-109th on the replay; a ninth is 453.60 over. Clawback is Dan''s decision, not an agent''s (precedent: mystery_bounty_double_pay_backlog). Acknowledged 2026-08-31 so the new auditor reports only NEW drift.'
            ELSE 'prize disbursement exceeded pool; measured and acknowledged 2026-08-31 during the phase-2 sweep (mostly satellites paying overlay-funded seats). Recorded so fn_tournament_prize_disbursement_audit reports only new drift.'
       END
  FROM public.fn_tournament_prize_disbursement_audit(336) a
ON CONFLICT (tournament_id) DO UPDATE
  SET amount = public.tournament_conservation_baseline.amount + EXCLUDED.amount,
      reason = public.tournament_conservation_baseline.reason || ' | ' || EXCLUDED.reason;

INSERT INTO public.financial_alerts (severity, source, message, context)
SELECT 'critical', 'tournament_double_payment_backlog',
       'Sunday $200 Deep Stack paid 62,841.60 against a 44,640 pool after an outage reset replayed an already-paid event - NOT clawed back',
       jsonb_build_object(
         'tournament_id','dfae9288-40e2-485d-8c97-a13dd53ab483',
         'prize_pool',44640,'disbursed',62841.60,'excess',18201.60,
         'cause','a recovery payout paid places 1-9 on the pre-reset 20,880 pool; the reset then replayed the event and the reconciler paid the new places 1-9 in full. tournament_players.prize was overwritten by the reset, so every existing check read 44,640 and stayed green.',
         'fixed_by','20260831 fn_tournament_prize_disbursement_audit reads the wallet ledger instead of the overwritten snapshot',
         'decision_owner','Dan - reversing credits players have already been shown is not an agent decision')
 WHERE NOT EXISTS (SELECT 1 FROM public.financial_alerts
                    WHERE source='tournament_double_payment_backlog' AND resolved IS NOT TRUE);

-- ───────────────────────────────────────────────────────────────────────────
-- 2. FALSE ALARM — the satellite auditor I wrote flagged a correct payout.
--
-- ccb686f8 "Sunday Deep Stack Satellite $10": pool 216, ticket 200, target
-- already closed, so the whole 216 went out as cash and the money conserved
-- exactly. My auditor called it a violation because it computed
-- awardable = GREATEST(configured 2, floor(216/200)=1) = 2 and then demanded
-- position 2 be paid. A satellite whose pool funds one seat does not owe a
-- second player anything, and how a cash fallback splits is the payout
-- structure's business, not a conservation invariant.
--
-- The honest statement is symmetric and needs no seat count:
--     disbursed = cash_paid + seats_funded * ticket
--     allowance = pool + acknowledged overlay
--     excess      = disbursed - allowance > 0  -> chips minted
--     undisbursed = allowance - disbursed > 0  -> somebody was not paid
-- The old excess allowance, GREATEST(pool, awardable*ticket), was too
-- generous the same way: it would have let this satellite pay 400 against a
-- 216 pool without a word.
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_satellite_conservation_audit(p_hours integer DEFAULT 24)
RETURNS TABLE (satellite_id uuid, satellite_name text, pool numeric, ticket_cost numeric,
               awardable integer, seats_funded integer, cash_paid numeric,
               unpaid_winners integer, excess_disbursed numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
WITH sats AS (
  SELECT s.id, s.name, s.prize_pool::numeric pool,
         COALESCE(s.satellite_seats, 0) g,
         round(COALESCE(t.buy_in_amount,0) + COALESCE(t.buy_in_fee,0), 2) ticket
    FROM tournaments s
    LEFT JOIN tournaments t ON t.id = s.satellite_target_id
   WHERE s.satellite_target_id IS NOT NULL
     AND s.status = 'COMPLETED'
     AND s.ended_at > now() - make_interval(hours => GREATEST(COALESCE(p_hours,24),1))
),
fin AS (
  SELECT tp.tournament_id, count(*) n
    FROM tournament_players tp JOIN sats ON sats.id = tp.tournament_id
   WHERE tp.position IS NOT NULL GROUP BY 1
),
seatrows AS (
  SELECT (r.metadata->>'satellite_id')::uuid sid, (r.metadata->>'user_id')::uuid uid
    FROM rake_records r
   WHERE r.source = 'fn_award_satellite_seat'
     AND (r.metadata->>'satellite_id')::uuid IN (SELECT id FROM sats)
),
cash AS (
  SELECT wt.related_entity_id sid, wt.user_id uid, sum(wt.amount) amt
    FROM wallet_transactions wt
   WHERE wt.related_entity_id IN (SELECT id FROM sats)
     AND wt.category = 'prize' AND wt.type = 'credit'
   GROUP BY 1, 2
),
ack AS (
  SELECT b.tournament_id sid, sum(b.amount) amt
    FROM tournament_conservation_baseline b
   WHERE b.tournament_id IN (SELECT id FROM sats) GROUP BY 1
),
calc AS (
  SELECT s.id, s.name, s.pool, s.ticket,
         LEAST(GREATEST(s.g, CASE WHEN s.ticket > 0 THEN floor(s.pool / s.ticket)::int ELSE 0 END),
               COALESCE(f.n, 0)) awardable,
         COALESCE((SELECT count(*) FROM seatrows sr WHERE sr.sid = s.id), 0)::int seats_funded,
         COALESCE((SELECT sum(c.amt) FROM cash c WHERE c.sid = s.id), 0) cash_paid,
         COALESCE((SELECT a.amt FROM ack a WHERE a.sid = s.id), 0) acknowledged
    FROM sats s LEFT JOIN fin f ON f.tournament_id = s.id
),
bal AS (
  SELECT c.*,
         round(c.cash_paid + c.seats_funded * c.ticket - (c.pool + c.acknowledged), 2) excess,
         round(c.pool + c.acknowledged - (c.cash_paid + c.seats_funded * c.ticket), 2) undisbursed
    FROM calc c
),
unpaid AS (
  SELECT b.id sid, count(*) n
    FROM bal b
    JOIN tournament_players tp ON tp.tournament_id = b.id
   WHERE tp.position IS NOT NULL AND tp.position <= b.awardable
     AND NOT EXISTS (SELECT 1 FROM seatrows sr WHERE sr.sid = b.id AND sr.uid = tp.user_id)
     AND COALESCE((SELECT ca.amt FROM cash ca WHERE ca.sid = b.id AND ca.uid = tp.user_id), 0) = 0
   GROUP BY 1
)
SELECT b.id, b.name, b.pool, b.ticket, b.awardable, b.seats_funded, b.cash_paid,
       COALESCE(u.n, 0)::int, GREATEST(b.excess, 0)
  FROM bal b LEFT JOIN unpaid u ON u.sid = b.id
 WHERE b.excess > 0.005 OR b.undisbursed > 0.005;
$$;
REVOKE ALL ON FUNCTION public.fn_satellite_conservation_audit(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_satellite_conservation_audit(integer) TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. FALSE ALARM — two spin checks that asked before the answer was due.
--
-- MEASURED over 6 hours: 744 completed spins, 744 credited, zero unpaid.
-- Median credit lands 0.85s BEFORE the COMPLETED flip; the slowest lands
-- 86.7s AFTER it.
--
--  (a) trg_spin_completed_guard compared drawn against credited INSIDE the
--      flip transaction, so any spin whose credit lands after the flip trips
--      it, and the trigger cannot wait to find out. The money alert is
--      removed; the periodic check owns that question. The null-position CAS
--      IS a flip-moment invariant and is kept, exception included.
--  (b) v_spin_unpaid_settlements gave COMPLETED spins no grace, and alarmed
--      on RUNNING spins via drawn_at < now() - 30min - but the reserve is
--      drawn at the START (measured: 8b1cd0df drew 06:13, ended 06:51,
--      alerted 06:50 mid-play). Now: finished for 10 minutes (7x the worst
--      measured credit lag), or a draw over 2h old on a non-live event.
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.trg_spin_completed_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_unranked integer;
BEGIN
  IF COALESCE(NEW.variant, '') <> 'spin' THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*) INTO v_unranked
    FROM public.tournament_players tp
   WHERE tp.tournament_id = NEW.id
     AND tp.position IS NULL;

  IF v_unranked > 0 THEN
    RAISE EXCEPTION
      'refusing to complete Spin %: % seat(s) still have a null position after ranking. '
      'public.fn_rank_survivors should have filled these; check whether '
      'tournaments_rank_before_complete is still enabled.',
      NEW.id, v_unranked
      USING ERRCODE = 'check_violation';
  END IF;

  -- The money invariant is NOT knowable here: the prize credit lands up to
  -- ~87s after this flip (measured over 744 spins). Asking now produces a
  -- false critical on every slow credit. fn_spin_unpaid_check owns it.
  RETURN NEW;
END $$;

CREATE OR REPLACE VIEW public.v_spin_unpaid_settlements AS
 WITH draw AS (
         SELECT l.tournament_id, sum(- l.amount) AS prize_drawn, max(l.created_at) AS drawn_at
           FROM spin_reserve_ledger l
          WHERE l.kind = 'jackpot_draw'::text AND l.tournament_id IS NOT NULL
          GROUP BY l.tournament_id
        ), paid AS (
         SELECT w.related_entity_id AS tournament_id, sum(w.amount) AS prize_credited, count(*) AS credit_rows
           FROM wallet_transactions w
          WHERE w.type = 'credit'::text AND w.category = 'prize'::text AND w.related_entity_id IS NOT NULL
          GROUP BY w.related_entity_id
        ), seats AS (
         SELECT tp.tournament_id,
            count(*) AS seat_count,
            count(*) FILTER (WHERE tp."position" IS NULL) AS unranked_seats,
            count(*) FILTER (WHERE tp.status = 'playing'::text) AS still_playing_seats,
            count(*) FILTER (WHERE tp."position" = 1) AS seats_at_first,
            COALESCE(sum(tp.prize), 0::numeric) AS sum_seat_prize
           FROM tournament_players tp
          GROUP BY tp.tournament_id
        )
 SELECT t.id AS tournament_id, t.club_id, t.name, t.status AS tournament_status,
    t.buy_in_amount, t.spin_multiplier, t.started_at, t.ended_at, d.drawn_at, d.prize_drawn,
    COALESCE(p.prize_credited, 0::numeric) AS prize_credited,
    COALESCE(p.credit_rows, 0::bigint) AS credit_rows,
    round(d.prize_drawn - COALESCE(p.prize_credited, 0::numeric), 2) AS chips_short,
    COALESCE(s.seat_count, 0::bigint) AS seat_count,
    COALESCE(s.unranked_seats, 0::bigint) AS unranked_seats,
    COALESCE(s.still_playing_seats, 0::bigint) AS still_playing_seats,
    COALESCE(s.seats_at_first, 0::bigint) AS seats_at_first,
    COALESCE(s.sum_seat_prize, 0::numeric) AS sum_seat_prize,
        CASE
            WHEN COALESCE(p.prize_credited, 0::numeric) = 0::numeric THEN 'nobody_paid'::text
            WHEN COALESCE(p.prize_credited, 0::numeric) < d.prize_drawn THEN 'under_paid'::text
            ELSE 'over_paid'::text
        END AS verdict,
        CASE
            WHEN COALESCE(s.unranked_seats, 0::bigint) > 0 THEN 'unranked_survivor'::text
            WHEN COALESCE(s.seats_at_first, 0::bigint) = 1 THEN 'ranked_but_unpaid'::text
            ELSE 'other'::text
        END AS seat_shape
   FROM draw d
     JOIN tournaments t ON t.id = d.tournament_id AND t.variant = 'spin'::text
     LEFT JOIN paid p ON p.tournament_id = d.tournament_id
     LEFT JOIN seats s ON s.tournament_id = d.tournament_id
  WHERE round(d.prize_drawn - COALESCE(p.prize_credited, 0::numeric), 2) <> 0::numeric
    AND (
          (t.status = ANY (ARRAY['COMPLETED'::text, 'CANCELLED'::text, 'CANCELED'::text])
             AND COALESCE(t.ended_at, d.drawn_at) < now() - interval '10 minutes')
       OR (d.drawn_at < now() - interval '2 hours'
             AND t.status <> ALL (ARRAY['RUNNING'::text, 'REGISTERING'::text]))
        )
    AND NOT (COALESCE(p.prize_credited, 0::numeric) > d.prize_drawn
             AND t.spin_multiplier IS NOT NULL
             AND COALESCE(p.prize_credited, 0::numeric) = round(t.buy_in_amount * t.spin_multiplier, 2));

-- ───────────────────────────────────────────────────────────────────────────
-- 4. OPEN GRANT — fn_cashout_seats_for_closing_table was callable by anyone
--    logged in: SECURITY DEFINER, moves chips off a table's seats, no
--    authorization gate. Nothing in either repo calls it from a browser
--    (grepped: zero hits); the engine holds service_role.
-- ───────────────────────────────────────────────────────────────────────────
DO $$
DECLARE sig text;
BEGIN
  FOR sig IN
    SELECT format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname='fn_cashout_seats_for_closing_table'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', sig);
  END LOOP;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Resolve the alerts these findings explain — each gated on a live
--    re-check, never on my say-so.
-- ───────────────────────────────────────────────────────────────────────────
UPDATE public.financial_alerts SET resolved = true, resolved_at = now()
 WHERE source = 'trg_spin_completed_guard' AND resolved IS NOT TRUE
   AND NOT EXISTS (SELECT 1 FROM public.v_spin_unpaid_settlements v
                    WHERE v.tournament_id::text = context->>'tournament_id' AND v.chips_short > 0);
UPDATE public.financial_alerts SET resolved = true, resolved_at = now()
 WHERE source = 'fn_spin_unpaid_check' AND resolved IS NOT TRUE
   AND NOT EXISTS (SELECT 1 FROM public.v_spin_unpaid_settlements v
                    WHERE v.tournament_id::text = context->>'tournament_id' AND v.chips_short > 0);
UPDATE public.financial_alerts SET resolved = true, resolved_at = now()
 WHERE source = 'FeeReconciler.satellite_conservation' AND resolved IS NOT TRUE
   AND NOT EXISTS (SELECT 1 FROM public.fn_satellite_conservation_audit(48));
UPDATE public.financial_alerts SET resolved = true, resolved_at = now()
 WHERE source = 'fn_check_ungated_money_rpcs' AND resolved IS NOT TRUE
   AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                    WHERE n.nspname='public' AND p.proname='fn_cashout_seats_for_closing_table'
                      AND has_function_privilege('authenticated', p.oid, 'EXECUTE'));
UPDATE public.financial_alerts SET resolved = true, resolved_at = now()
 WHERE source = 'fn_rake_bbj_audit' AND resolved IS NOT TRUE
   AND (SELECT (fn_rake_bbj_audit()->>'violations')::int) = 0;
UPDATE public.financial_alerts SET resolved = true, resolved_at = now()
 WHERE source = 'fn_tournament_payout_reconcile' AND resolved IS NOT TRUE
   AND (EXISTS (SELECT 1 FROM public.tournament_conservation_baseline b
                 WHERE b.tournament_id::text = context->>'tournament_id')
        OR (context->'issues'->0->>'excess')::numeric <= 0.01);

-- ═══════════════════════════════ ASSERTIONS ═══════════════════════════════
DO $$
DECLARE n int;
BEGIN
  IF EXISTS (SELECT 1 FROM public.fn_satellite_conservation_audit(168)) THEN
    RAISE EXCEPTION 'satellite auditor still flags rows over 7 days; expected clean';
  END IF;
  IF EXISTS (SELECT 1 FROM public.fn_tournament_prize_disbursement_audit(336)) THEN
    RAISE EXCEPTION 'prize disbursement auditor should be silent after acknowledgment';
  END IF;
  IF EXISTS (SELECT 1 FROM public.v_spin_unpaid_settlements WHERE chips_short > 0) THEN
    RAISE EXCEPTION 'spin view still reports unpaid spins after the grace';
  END IF;
  IF has_function_privilege('authenticated',
       (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public' AND p.proname='fn_cashout_seats_for_closing_table' LIMIT 1),
       'EXECUTE') THEN
    RAISE EXCEPTION 'cashout function is still callable by authenticated';
  END IF;
  SELECT count(*) INTO n FROM public.tournament_conservation_baseline
   WHERE tournament_id = 'dfae9288-40e2-485d-8c97-a13dd53ab483';
  IF n <> 1 THEN RAISE EXCEPTION 'the double-payment acknowledgment was not recorded'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.financial_alerts
                  WHERE source='tournament_double_payment_backlog' AND resolved IS NOT TRUE) THEN
    RAISE EXCEPTION 'the double-payment alert for Dan is missing';
  END IF;
END $$;

