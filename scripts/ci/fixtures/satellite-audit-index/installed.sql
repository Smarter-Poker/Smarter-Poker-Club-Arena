CREATE OR REPLACE FUNCTION public.fn_satellite_conservation_audit(p_hours integer DEFAULT 24)
 RETURNS TABLE(satellite_id uuid, satellite_name text, pool numeric, ticket_cost numeric, awardable integer, seats_funded integer, cash_paid numeric, unpaid_winners integer, excess_disbursed numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH sats AS (
  SELECT s.id, s.name,
         -- The collected pool. With an escrow row that is exact: what left it
         -- as prize plus what is still in it. Before escrow (Lane G,
         -- 2026-09-02): what is left in prize_pool plus every seat already
         -- paid out of it.
         COALESCE(
           (SELECT round(COALESCE(e.prize_out, 0) + COALESCE(e.prize_balance, 0), 2)
              FROM tournament_escrow e WHERE e.tournament_id = s.id),
           round(s.prize_pool::numeric
               + COALESCE((SELECT sum(l.amount) FROM chip_ledger l
                            WHERE l.from_type = 'prize_liability'
                              AND l.from_entity_id = s.id
                              AND l.category = 'tournament_buyin'
                              AND l.idempotency_key LIKE 'tourney:' || s.id::text || ':seat:%:pool_transfer'), 0), 2)
         ) pool,
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
  -- a target-scoped ticket is the same seat, held rather than taken;
  -- a cancelled ticket comes back as cash and is counted there
  SELECT k.source_satellite_id, k.holder_id
    FROM tournament_tickets k
   WHERE k.source_satellite_id IN (SELECT id FROM sats)
     AND k.status IN ('issued', 'redeemed')
  UNION
  -- the payout journal names its source: this is the seat as the authority
  -- that paid it recorded it
  -- A CASH DELIVERY IS NOT A SEAT (2026-09-10): a capped winner paid in
  -- cash writes the same satellite_ticket payout row as a held ticket; the
  -- award row says which it was, and only seat/ticket is a funded seat.
  SELECT p.tournament_id, p.user_id
    FROM tournament_payouts p
    JOIN tournament_satellite_awards a
      ON a.tournament_id = p.tournament_id AND a.place = p.position
     AND a.delivery_kind IN ('seat', 'ticket')
   WHERE p.tournament_id IN (SELECT id FROM sats)
     AND p.source IN ('satellite_seat', 'satellite_ticket')
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
$function$
