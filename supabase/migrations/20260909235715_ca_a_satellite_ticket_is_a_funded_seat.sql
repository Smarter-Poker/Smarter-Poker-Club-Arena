-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260909235715; the .sql file was never committed at the
-- time (satellite ticket delivery; see docs/changelog/2026-09-12-a-ticket-is-a-seat-the-delta-can-see.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- ca_a_satellite_ticket_is_a_funded_seat
--
-- fn_satellite_conservation_audit counted a funded seat only as a
-- rake_records row from fn_award_satellite_seat (a seat taken directly in the
-- target event). Since the satellite finish became one atomic authority a
-- full award can also be a target-scoped, entry-only ticket in
-- tournament_tickets (source_satellite_id = the satellite, value = the
-- target's ticket cost). The audit did not read that table, so every
-- satellite that paid its winner a ticket read as "seats_funded 0,
-- unpaid_winners 1, undisbursed <ticket>" and raised a ledger_imbalance
-- incident (ec08f940, 22:52 UTC: Friday Night Feature Satellite Heads-Up
-- 3c98b2f9 and DSS Wednesday $22 Satellite Heads-Up 36a146ee, both fully
-- disbursed: a 30.00 / 20.00 issued ticket plus the 8.00 / 8.50 remainder).
--
-- An issued or redeemed ticket is a funded seat. A cancelled ticket is not:
-- its value comes back as cash, which the cash leg already counts.
BEGIN;

CREATE OR REPLACE FUNCTION public.fn_satellite_conservation_audit(p_hours integer DEFAULT 24)
 RETURNS TABLE(satellite_id uuid, satellite_name text, pool numeric, ticket_cost numeric, awardable integer, seats_funded integer, cash_paid numeric, unpaid_winners integer, excess_disbursed numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH sats AS (
  SELECT s.id, s.name,
         -- The collected pool: what is left in prize_pool plus every seat the
         -- satellite has already paid out of it (Lane G, 2026-09-02).
         round(s.prize_pool::numeric
               + COALESCE((SELECT sum(l.amount) FROM chip_ledger l
                            WHERE l.from_type = 'prize_liability'
                              AND l.from_entity_id = s.id
                              AND l.category = 'tournament_buyin'
                              AND l.idempotency_key LIKE 'tourney:' || s.id::text || ':seat:%:pool_transfer'), 0), 2) pool,
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
  -- a seat taken directly in the target event
  SELECT (r.metadata->>'satellite_id')::uuid sid, (r.metadata->>'user_id')::uuid uid
    FROM rake_records r
   WHERE r.source = 'fn_award_satellite_seat'
     AND (r.metadata->>'satellite_id')::uuid IN (SELECT id FROM sats)
  UNION
  -- 2026-09-09: a target-scoped ticket is the same seat, held rather than
  -- taken. Cancelled tickets come back as cash and are counted there.
  SELECT k.source_satellite_id, k.holder_id
    FROM tournament_tickets k
   WHERE k.source_satellite_id IN (SELECT id FROM sats)
     AND k.status IN ('issued', 'redeemed')
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
$function$;

COMMIT;
