-- ============================================================================
-- 20260830113000_spin_unpaid_view_flags_harm_not_booking.sql
-- TIER: 2 | AFFECTS: v_spin_unpaid_settlements (+ new v_spin_draw_booking_gaps)
-- Applied to production via the Supabase MCP on 2026-08-30.
--
-- v_spin_unpaid_settlements carried 11 permanent 'over_paid' rows from the
-- 2026-08-22..24 settle-convention transition: in every one the winner was
-- credited EXACTLY buy_in x multiplier (the spec prize - no player harmed,
-- no player overpaid) while the era's jackpot_draw row booked less than the
-- gross prize. That is a booking-convention delta, not an incident, and 11
-- rows of it forever is alarm fatigue on the one view that must stay red
-- only when a player or the pool is actually harmed.
--
-- The alarm view now flags: nobody_paid, under_paid, and over_paid where the
-- credit does NOT equal the spec prize (a real overpayment). The convention
-- deltas move - fully visible, nothing deleted - to v_spin_draw_booking_gaps.
-- ============================================================================

CREATE OR REPLACE VIEW public.v_spin_unpaid_settlements AS
 WITH draw AS (
         SELECT l.tournament_id,
            sum(- l.amount) AS prize_drawn,
            max(l.created_at) AS drawn_at
           FROM spin_reserve_ledger l
          WHERE l.kind = 'jackpot_draw' AND l.tournament_id IS NOT NULL
          GROUP BY l.tournament_id
        ), paid AS (
         SELECT w.related_entity_id AS tournament_id,
            sum(w.amount) AS prize_credited,
            count(*) AS credit_rows
           FROM wallet_transactions w
          WHERE w.type = 'credit' AND w.category = 'prize' AND w.related_entity_id IS NOT NULL
          GROUP BY w.related_entity_id
        ), seats AS (
         SELECT tp.tournament_id,
            count(*) AS seat_count,
            count(*) FILTER (WHERE tp."position" IS NULL) AS unranked_seats,
            count(*) FILTER (WHERE tp.status = 'playing') AS still_playing_seats,
            count(*) FILTER (WHERE tp."position" = 1) AS seats_at_first,
            COALESCE(sum(tp.prize), 0::numeric) AS sum_seat_prize
           FROM tournament_players tp
          GROUP BY tp.tournament_id
        )
 SELECT t.id AS tournament_id, t.club_id, t.name, t.status AS tournament_status,
    t.buy_in_amount, t.spin_multiplier, t.started_at, t.ended_at,
    d.drawn_at, d.prize_drawn,
    COALESCE(p.prize_credited, 0::numeric) AS prize_credited,
    COALESCE(p.credit_rows, 0::bigint) AS credit_rows,
    round(d.prize_drawn - COALESCE(p.prize_credited, 0::numeric), 2) AS chips_short,
    COALESCE(s.seat_count, 0::bigint) AS seat_count,
    COALESCE(s.unranked_seats, 0::bigint) AS unranked_seats,
    COALESCE(s.still_playing_seats, 0::bigint) AS still_playing_seats,
    COALESCE(s.seats_at_first, 0::bigint) AS seats_at_first,
    COALESCE(s.sum_seat_prize, 0::numeric) AS sum_seat_prize,
        CASE
            WHEN COALESCE(p.prize_credited, 0::numeric) = 0::numeric THEN 'nobody_paid'
            WHEN COALESCE(p.prize_credited, 0::numeric) < d.prize_drawn THEN 'under_paid'
            ELSE 'over_paid'
        END AS verdict,
        CASE
            WHEN COALESCE(s.unranked_seats, 0::bigint) > 0 THEN 'unranked_survivor'
            WHEN COALESCE(s.seats_at_first, 0::bigint) = 1 THEN 'ranked_but_unpaid'
            ELSE 'other'
        END AS seat_shape
   FROM draw d
     JOIN tournaments t ON t.id = d.tournament_id AND t.variant = 'spin'
     LEFT JOIN paid p ON p.tournament_id = d.tournament_id
     LEFT JOIN seats s ON s.tournament_id = d.tournament_id
  WHERE round(d.prize_drawn - COALESCE(p.prize_credited, 0::numeric), 2) <> 0::numeric
    AND ((t.status = ANY (ARRAY['COMPLETED','CANCELLED','CANCELED'])) OR d.drawn_at < (now() - interval '30 minutes'))
    -- Booking-convention delta, not harm: the winner holds exactly the spec
    -- prize (buy_in x multiplier); only the era's draw row booked less.
    -- Those rows live in v_spin_draw_booking_gaps instead.
    AND NOT (
      COALESCE(p.prize_credited, 0::numeric) > d.prize_drawn
      AND t.spin_multiplier IS NOT NULL
      AND COALESCE(p.prize_credited, 0::numeric) = round(t.buy_in_amount * t.spin_multiplier, 2)
    );

CREATE OR REPLACE VIEW public.v_spin_draw_booking_gaps AS
 WITH draw AS (
         SELECT l.tournament_id, sum(- l.amount) AS prize_drawn, max(l.created_at) AS drawn_at
           FROM spin_reserve_ledger l
          WHERE l.kind = 'jackpot_draw' AND l.tournament_id IS NOT NULL
          GROUP BY l.tournament_id
        ), paid AS (
         SELECT w.related_entity_id AS tournament_id, sum(w.amount) AS prize_credited
           FROM wallet_transactions w
          WHERE w.type = 'credit' AND w.category = 'prize' AND w.related_entity_id IS NOT NULL
          GROUP BY w.related_entity_id
        )
 SELECT t.id AS tournament_id, t.club_id, t.name, t.buy_in_amount, t.spin_multiplier,
        t.started_at, t.ended_at, d.drawn_at, d.prize_drawn,
        p.prize_credited,
        round(p.prize_credited - d.prize_drawn, 2) AS draw_under_booked_by
   FROM draw d
   JOIN tournaments t ON t.id = d.tournament_id AND t.variant = 'spin'
   JOIN paid p ON p.tournament_id = d.tournament_id
  WHERE t.spin_multiplier IS NOT NULL
    AND p.prize_credited > d.prize_drawn
    AND p.prize_credited = round(t.buy_in_amount * t.spin_multiplier, 2);
