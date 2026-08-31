-- 2026-08-31 - MTT Phase 5: the spin unpaid view stays narrow, and here is why.
--
-- This file restores v_spin_unpaid_settlements to its pre-2026-08-31
-- definition. Two migrations that widened it were applied first and are
-- superseded by this one; they are recorded in production as
-- 20260831193301 (the_spin_unpaid_view_can_see_a_self_funded_spin) and
-- 20260831193522 (the_spin_unpaid_view_scopes_its_aggregates_to_spins) and
-- have no separate repo file, because their net effect on the schema is
-- nothing. This file is the whole story.
--
-- THE GAP IS REAL. The view begins `FROM draw d JOIN tournaments t`, where
-- `draw` is spins holding a `jackpot_draw` row in spin_reserve_ledger. An
-- INNER join on that CTE means the view - and fn_spin_unpaid_check, which
-- alerts hourly, and fn_backpay_spin_unpaid_winners, which pays - can only
-- ever see a spin whose multiplier needed the reserve. A 2x or 3x spin is
-- funded entirely by its own three buy-ins and never draws. 4,590 of 34,567
-- completed spins were invisible to all three by construction.
--
-- IT IS ALSO WORTH NOTHING, MEASURED. Every one of those 4,590 is CANCELLED
-- with no finisher in first place. There is nobody to pay. Genuinely owed:
-- 0.00 chips. The inline reconciler that runs at the end of every tournament
-- already covers the self-funded case, which is why nothing accumulated.
--
-- AND CLOSING IT MADE THINGS WORSE, TWICE.
--
-- First attempt (LEFT JOIN the draw, fall back to prize_pool): all 4,590
-- cancelled events read as 21,329 chips short, because a cancelled spin holds
-- a nominal prize_pool from collected buy-ins and never pays a prize.
-- fn_spin_unpaid_check raises one critical financial alert PER offending
-- event. That is 4,590 criticals for money nobody is owed, which is how an
-- alert channel gets muted.
--
-- Second attempt (scope the new arm to COMPLETED events with exactly one
-- recorded first place, and scope the aggregates to spins): correct - it
-- returned 0 rows and 0 payable - but it has to materialise the seat
-- aggregate over 197,524 tournament_players rows to guard the new arm, and
-- fn_backpay_spin_unpaid_winners reads the view three times: backlog before,
-- the loop, backlog after. It stopped completing inside 60 seconds. It
-- completed before, and completes again now.
--
-- A detector that cannot finish is worse than a blind spot over a debt of
-- zero. So the gap is RECORDED, not closed.
--
-- WHAT ACTUALLY COVERS IT MEANWHILE: `poker_tournaments_unpaid_completed`
-- from Phase 2, which is format-agnostic - it asks whether a COMPLETED
-- tournament with a prize pool has any prize payment at all, and does not
-- care whether the reserve was involved. It is already alerting. It is what
-- caught the one genuinely unpaid Spin winner on 2026-08-31, ten minutes
-- before the inline reconciler settled it.
--
-- ANYONE WIDENING THIS LATER: fix the cost first. The seat aggregate is what
-- makes it unaffordable, and fn_backpay reads the view three times per run.
--
-- TIER: 3 (feeds a function that pays). This is itself the rollback of the two
-- superseded migrations; verified afterwards by
--   select public.fn_backpay_spin_unpaid_winners(false, 100)
-- returning {"ok": true, "owed_before": 0, "owed_after": 0, "winners_paid": 0}
-- instead of timing out.

BEGIN;

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
    d.prize_drawn,
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
    AND ((t.status = ANY (ARRAY['COMPLETED'::text, 'CANCELLED'::text, 'CANCELED'::text]))
         AND COALESCE(t.ended_at, d.drawn_at) < (now() - '00:10:00'::interval)
         OR d.drawn_at < (now() - '02:00:00'::interval)
            AND (t.status <> ALL (ARRAY['RUNNING'::text, 'REGISTERING'::text])))
    AND NOT (COALESCE(p.prize_credited, 0::numeric) > d.prize_drawn
             AND t.spin_multiplier IS NOT NULL
             AND COALESCE(p.prize_credited, 0::numeric) = round(t.buy_in_amount * t.spin_multiplier, 2));

COMMIT;
