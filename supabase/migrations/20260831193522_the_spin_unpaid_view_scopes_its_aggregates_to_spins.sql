-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831193522; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

/* The widened view measured at 21.75s: dropping the INNER JOIN on the draw CTE
 * removed the filter that used to cut the tournament set before the seat and
 * ledger aggregates ran, so it aggregated all 197,524 tournament_players rows
 * and the whole prize side of wallet_transactions.
 *
 * fn_spin_unpaid_check runs hourly and fn_backpay_spin_unpaid_winners reads it
 * on demand - the latter had already started timing out at 60s. A detector
 * that cannot finish is worse than the blind spot it was widened to close.
 *
 * Both aggregates are now scoped to spin tournaments through a `spins` CTE, so
 * they compute over the set the view can actually return instead of the whole
 * estate.
 */
CREATE OR REPLACE VIEW public.v_spin_unpaid_settlements AS
 WITH spins AS (
         SELECT t.id, t.club_id, t.name, t.status, t.buy_in_amount, t.spin_multiplier,
                t.started_at, t.ended_at, t.prize_pool
           FROM tournaments t
          WHERE t.variant = 'spin'::text
            AND t.status <> ALL (ARRAY['RUNNING'::text, 'REGISTERING'::text, 'ANNOUNCED'::text])
        ), draw AS (
         SELECT l.tournament_id,
            sum(- l.amount) AS prize_drawn,
            max(l.created_at) AS drawn_at
           FROM spin_reserve_ledger l
           JOIN spins sp ON sp.id = l.tournament_id
          WHERE l.kind = 'jackpot_draw'::text
          GROUP BY l.tournament_id
        ), paid AS (
         SELECT w.related_entity_id AS tournament_id,
            sum(w.amount) AS prize_credited,
            count(*) AS credit_rows
           FROM wallet_transactions w
           JOIN spins sp ON sp.id = w.related_entity_id
          WHERE w.type = 'credit'::text AND w.category = 'prize'::text
          GROUP BY w.related_entity_id
        ), seats AS (
         SELECT tp.tournament_id,
            count(*) AS seat_count,
            count(*) FILTER (WHERE tp."position" IS NULL) AS unranked_seats,
            count(*) FILTER (WHERE tp.status = 'playing'::text) AS still_playing_seats,
            count(*) FILTER (WHERE tp."position" = 1) AS seats_at_first,
            COALESCE(sum(tp.prize), 0::numeric) AS sum_seat_prize
           FROM tournament_players tp
           JOIN spins sp ON sp.id = tp.tournament_id
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
    COALESCE(d.prize_drawn, t.prize_pool) AS prize_drawn,
    COALESCE(p.prize_credited, 0::numeric) AS prize_credited,
    COALESCE(p.credit_rows, 0::bigint) AS credit_rows,
    round(COALESCE(d.prize_drawn, t.prize_pool) - COALESCE(p.prize_credited, 0::numeric), 2) AS chips_short,
    COALESCE(s.seat_count, 0::bigint) AS seat_count,
    COALESCE(s.unranked_seats, 0::bigint) AS unranked_seats,
    COALESCE(s.still_playing_seats, 0::bigint) AS still_playing_seats,
    COALESCE(s.seats_at_first, 0::bigint) AS seats_at_first,
    COALESCE(s.sum_seat_prize, 0::numeric) AS sum_seat_prize,
        CASE
            WHEN COALESCE(p.prize_credited, 0::numeric) = 0::numeric THEN 'nobody_paid'::text
            WHEN COALESCE(p.prize_credited, 0::numeric) < COALESCE(d.prize_drawn, t.prize_pool) THEN 'under_paid'::text
            ELSE 'over_paid'::text
        END AS verdict,
        CASE
            WHEN COALESCE(s.unranked_seats, 0::bigint) > 0 THEN 'unranked_survivor'::text
            WHEN COALESCE(s.seats_at_first, 0::bigint) = 1 THEN 'ranked_but_unpaid'::text
            ELSE 'other'::text
        END AS seat_shape
   FROM spins t
     LEFT JOIN draw d ON d.tournament_id = t.id
     LEFT JOIN paid p ON p.tournament_id = t.id
     LEFT JOIN seats s ON s.tournament_id = t.id
  WHERE round(COALESCE(d.prize_drawn, t.prize_pool) - COALESCE(p.prize_credited, 0::numeric), 2) <> 0::numeric
    AND (
      (d.tournament_id IS NOT NULL
       AND ((t.status = ANY (ARRAY['COMPLETED'::text, 'CANCELLED'::text, 'CANCELED'::text]))
            AND COALESCE(t.ended_at, d.drawn_at) < (now() - '00:10:00'::interval)
            OR d.drawn_at < (now() - '02:00:00'::interval)))
      OR
      (d.tournament_id IS NULL
       AND t.status = 'COMPLETED'::text
       AND t.ended_at < (now() - '00:10:00'::interval)
       AND COALESCE(s.seats_at_first, 0::bigint) = 1)
    )
    AND NOT (COALESCE(p.prize_credited, 0::numeric) > COALESCE(d.prize_drawn, t.prize_pool)
             AND t.spin_multiplier IS NOT NULL
             AND COALESCE(p.prize_credited, 0::numeric) = round(t.buy_in_amount * t.spin_multiplier, 2));
