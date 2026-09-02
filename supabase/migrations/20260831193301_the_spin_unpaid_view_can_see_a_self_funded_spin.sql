-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831193301; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

/* 2026-08-31 - MTT Phase 5: the spin unpaid detector could only see spins that
 * drew from the reserve.
 *
 * v_spin_unpaid_settlements began `FROM draw d JOIN tournaments t`, where
 * `draw` is spins with a `jackpot_draw` row in spin_reserve_ledger. An INNER
 * join on that CTE means the view - and therefore fn_spin_unpaid_check, which
 * alerts hourly, and fn_backpay_spin_unpaid_winners, which pays - could only
 * ever see a spin whose multiplier was large enough to need the reserve.
 *
 * A 2x or 3x spin is funded entirely by its own three buy-ins. It never draws.
 * 29,977 of 34,567 completed spins are reserve-funded and visible; the other
 * 4,590 were invisible to all three by construction.
 *
 * WHAT THAT BLIND SPOT ACTUALLY COST: NOTHING, MEASURED.
 *
 * Every one of the 4,590 invisible events is CANCELLED with no finisher in
 * first place - there is nobody to pay. Zero chips are genuinely owed. The
 * inline reconciler that runs at the end of every tournament already covers
 * the self-funded case, which is why no unpaid winner accumulated here.
 *
 * So this is defence in depth, not a repair.
 *
 * AND WIDENING IT NAIVELY WOULD HAVE DONE REAL DAMAGE.
 *
 * The obvious fix - LEFT JOIN the draw and fall back to prize_pool - makes all
 * 4,590 cancelled events read as 21,329 chips short, because a cancelled spin
 * holds a nominal prize_pool from collected buy-ins and never pays a prize.
 * fn_spin_unpaid_check raises one critical financial alert per offending
 * event. That is 4,590 criticals for a debt that does not exist, which is how
 * an alert channel gets muted.
 *
 * So the widened arm is scoped to what can actually be owed: a COMPLETED spin
 * with exactly one recorded first place. `expected` falls back to prize_pool
 * only for the self-funded case; reserve-funded events keep measuring against
 * the amount actually drawn, which is the stronger signal and must not be
 * weakened.
 *
 * TIER: 3 (feeds a function that pays). ROLLBACK at the bottom.
 */

CREATE OR REPLACE VIEW public.v_spin_unpaid_settlements AS
 WITH draw AS (
         SELECT l.tournament_id,
            sum(- l.amount) AS prize_drawn,
            max(l.created_at) AS drawn_at
           FROM spin_reserve_ledger l
          WHERE l.kind = 'jackpot_draw'::text AND l.tournament_id IS NOT NULL
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
   FROM tournaments t
     LEFT JOIN draw d ON d.tournament_id = t.id
     LEFT JOIN paid p ON p.tournament_id = t.id
     LEFT JOIN seats s ON s.tournament_id = t.id
  WHERE t.variant = 'spin'::text
    AND round(COALESCE(d.prize_drawn, t.prize_pool) - COALESCE(p.prize_credited, 0::numeric), 2) <> 0::numeric
    AND (
      /* Reserve-funded: unchanged, including the CANCELLED arm it always had. */
      (d.tournament_id IS NOT NULL
       AND ((t.status = ANY (ARRAY['COMPLETED'::text, 'CANCELLED'::text, 'CANCELED'::text]))
            AND COALESCE(t.ended_at, d.drawn_at) < (now() - '00:10:00'::interval)
            OR d.drawn_at < (now() - '02:00:00'::interval)
               AND (t.status <> ALL (ARRAY['RUNNING'::text, 'REGISTERING'::text]))))
      OR
      /* Self-funded: only what can actually be owed. COMPLETED, settled for ten
         minutes, and exactly one recorded first place. A CANCELLED spin holds a
         nominal pool and has no winner; listing it would raise a critical alert
         per event for a debt that does not exist. */
      (d.tournament_id IS NULL
       AND t.status = 'COMPLETED'::text
       AND t.ended_at < (now() - '00:10:00'::interval)
       AND COALESCE(s.seats_at_first, 0::bigint) = 1)
    )
    AND NOT (COALESCE(p.prize_credited, 0::numeric) > COALESCE(d.prize_drawn, t.prize_pool)
             AND t.spin_multiplier IS NOT NULL
             AND COALESCE(p.prize_credited, 0::numeric) = round(t.buy_in_amount * t.spin_multiplier, 2));
