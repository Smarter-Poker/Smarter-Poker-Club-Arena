/* A SPIN THAT GAVE ITS DRAW BACK IS NOT SHORT (2026-09-08)

   v_spin_unpaid_settlements computed chips_short as prize_drawn minus
   prize_credited and never subtracted surplus_return, so a spin that was
   CANCELLED and returned its ENTIRE draw to the reserve still read as short by
   the whole prize. Measured today: of 16 open incidents, 14 were cancelled
   spins that had returned every chip (514.00 of surplus_return across them),
   and exactly one spin was genuinely unpaid - pokerdale, 3.00, since settled.

   The class was re-raised 11 times at 14:50 within minutes of those incidents
   being resolved, which is the point: resolving an incident without fixing the
   detector that files it is a band-aid, and the board fills straight back up.

   chips_short and the WHERE now net surplus_return off; prize_returned is
   appended LAST because CREATE OR REPLACE VIEW cannot reorder columns. */
CREATE OR REPLACE VIEW public.v_spin_unpaid_settlements AS
 WITH draw AS (
         SELECT l.tournament_id,
            sum(- l.amount) AS prize_drawn,
            max(l.created_at) AS drawn_at
           FROM spin_reserve_ledger l
          WHERE l.kind = 'jackpot_draw'::text AND l.tournament_id IS NOT NULL
          GROUP BY l.tournament_id
        ), returned AS (
         SELECT l.tournament_id, sum(l.amount) AS prize_returned
           FROM spin_reserve_ledger l
          WHERE l.kind = 'surplus_return'::text AND l.tournament_id IS NOT NULL
          GROUP BY l.tournament_id
        ), paid AS (
         SELECT w.related_entity_id AS tournament_id,
            sum(w.amount) AS prize_credited,
            count(*) AS credit_rows
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
 SELECT t.id AS tournament_id,
    t.club_id,
    t.name,
    t.status AS tournament_status,
    t.buy_in_amount,
    t.spin_multiplier,
    t.started_at,
    t.ended_at,
    d.drawn_at,
    d.prize_drawn,
    COALESCE(p.prize_credited, 0::numeric) AS prize_credited,
    COALESCE(p.credit_rows, 0::bigint) AS credit_rows,
    round(d.prize_drawn - COALESCE(r.prize_returned, 0::numeric) - COALESCE(p.prize_credited, 0::numeric), 2) AS chips_short,
    COALESCE(s.seat_count, 0::bigint) AS seat_count,
    COALESCE(s.unranked_seats, 0::bigint) AS unranked_seats,
    COALESCE(s.still_playing_seats, 0::bigint) AS still_playing_seats,
    COALESCE(s.seats_at_first, 0::bigint) AS seats_at_first,
    COALESCE(s.sum_seat_prize, 0::numeric) AS sum_seat_prize,
        CASE
            WHEN COALESCE(r.prize_returned, 0::numeric) > 0::numeric THEN 'draw_returned'::text
            WHEN COALESCE(p.prize_credited, 0::numeric) = 0::numeric THEN 'nobody_paid'::text
            WHEN COALESCE(p.prize_credited, 0::numeric) < d.prize_drawn THEN 'under_paid'::text
            ELSE 'over_paid'::text
        END AS verdict,
        CASE
            WHEN COALESCE(s.unranked_seats, 0::bigint) > 0 THEN 'unranked_survivor'::text
            WHEN COALESCE(s.seats_at_first, 0::bigint) = 1 THEN 'ranked_but_unpaid'::text
            ELSE 'other'::text
        END AS seat_shape,
    COALESCE(r.prize_returned, 0::numeric) AS prize_returned
   FROM draw d
     JOIN tournaments t ON t.id = d.tournament_id AND t.variant = 'spin'::text
     LEFT JOIN returned r ON r.tournament_id = d.tournament_id
     LEFT JOIN paid p ON p.tournament_id = d.tournament_id
     LEFT JOIN seats s ON s.tournament_id = d.tournament_id
  WHERE round(d.prize_drawn - COALESCE(r.prize_returned, 0::numeric) - COALESCE(p.prize_credited, 0::numeric), 2) <> 0::numeric
    AND ((t.status = ANY (ARRAY['COMPLETED'::text, 'CANCELLED'::text, 'CANCELED'::text])) AND COALESCE(t.ended_at, d.drawn_at) < (now() - '00:10:00'::interval) OR d.drawn_at < (now() - '02:00:00'::interval) AND (t.status <> ALL (ARRAY['RUNNING'::text, 'REGISTERING'::text])))
    AND NOT (COALESCE(p.prize_credited, 0::numeric) > d.prize_drawn AND t.spin_multiplier IS NOT NULL AND COALESCE(p.prize_credited, 0::numeric) = round(t.buy_in_amount * t.spin_multiplier, 2));