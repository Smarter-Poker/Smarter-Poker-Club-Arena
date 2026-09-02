-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830211704; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- ═══════════════════════════════════════════════════════════════════════════
-- SATELLITE CONSERVATION AUDIT (2026-08-30 audit, phase 3)
--
-- One function the engine polls (FeeReconciler cycle) that answers, for every
-- satellite completed in the window, the two questions this week's incidents
-- proved nobody was asking:
--
--   1. UNPAID WINNERS — a finisher inside the awardable count who received
--      neither a funded seat nor prize cash. Four of these shipped silently.
--   2. DISBURSED BEYOND THE PROMISE — cash + funded seats worth more than
--      max(pool, awardable_seats x ticket). The guarantee overlay is the
--      promise and is allowed; the pre-#1935 face-value cash bug was not.
--      Amounts acknowledged in tournament_conservation_baseline are excluded.
--
-- Read-only. It reports; it never repairs.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_satellite_conservation_audit(p_hours integer DEFAULT 24)
RETURNS TABLE (
  satellite_id uuid, satellite_name text, pool numeric, ticket_cost numeric,
  awardable integer, seats_funded integer, cash_paid numeric,
  unpaid_winners integer, excess_disbursed numeric
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
$$
WITH sats AS (
  SELECT s.id, s.name, s.prize_pool::numeric pool,
         COALESCE(s.satellite_seats, 0) g,
         round(COALESCE(t.buy_in_amount,0) + COALESCE(t.buy_in_fee,0), 2) ticket
    FROM tournaments s
    LEFT JOIN tournaments t ON t.id = s.satellite_target_id
   WHERE s.satellite_target_id IS NOT NULL
     AND s.status = 'COMPLETED'
     AND s.ended_at > now() - make_interval(hours => p_hours)
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
         LEAST(
           GREATEST(s.g, CASE WHEN s.ticket > 0 THEN floor(s.pool / s.ticket)::int ELSE 0 END),
           COALESCE(f.n, 0)
         ) awardable,
         COALESCE((SELECT count(*) FROM seatrows sr WHERE sr.sid = s.id), 0)::int seats_funded,
         COALESCE((SELECT sum(c.amt) FROM cash c WHERE c.sid = s.id), 0) cash_paid,
         COALESCE((SELECT a.amt FROM ack a WHERE a.sid = s.id), 0) acknowledged
    FROM sats s LEFT JOIN fin f ON f.tournament_id = s.id
),
unpaid AS (
  SELECT c.id sid, count(*) n
    FROM calc c
    JOIN tournament_players tp ON tp.tournament_id = c.id
   WHERE tp.position IS NOT NULL AND tp.position <= c.awardable
     AND NOT EXISTS (SELECT 1 FROM seatrows sr WHERE sr.sid = c.id AND sr.uid = tp.user_id)
     AND COALESCE((SELECT ca.amt FROM cash ca WHERE ca.sid = c.id AND ca.uid = tp.user_id), 0) = 0
   GROUP BY 1
)
SELECT c.id, c.name, c.pool, c.ticket, c.awardable, c.seats_funded, c.cash_paid,
       COALESCE(u.n, 0)::int,
       round(GREATEST(
         c.cash_paid + c.seats_funded * c.ticket
           - GREATEST(c.pool, c.awardable * c.ticket) - c.acknowledged, 0), 2)
  FROM calc c LEFT JOIN unpaid u ON u.sid = c.id
 WHERE COALESCE(u.n, 0) > 0
    OR c.cash_paid + c.seats_funded * c.ticket
         - GREATEST(c.pool, c.awardable * c.ticket) - c.acknowledged > 0.005;
$$;

REVOKE ALL ON FUNCTION public.fn_satellite_conservation_audit(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_satellite_conservation_audit(integer) TO service_role;

-- Assertion: over the audited week the acknowledged history must come back
-- clean — the function's job is to catch NEW damage, not to re-report what
-- phase 1 already put on the books.
DO $$
DECLARE v_rows int;
BEGIN
  SELECT count(*) INTO v_rows FROM public.fn_satellite_conservation_audit(24*7);
  IF v_rows > 0 THEN
    RAISE EXCEPTION 'audit function reports % violation(s) on the reconciled week — thresholds wrong, re-derive', v_rows;
  END IF;
END $$;

