-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828022019; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ============================================================================
-- spin_unpaid_settlement_detection
--
-- WHAT IS BROKEN
-- --------------
-- A Spin is a 3-handed hyper lottery SNG. When it starts, the server calls
-- public.fn_spin_settle_game(), which does two things to the club's reserve
-- (public.spin_bonus_pools): it books the buy-ins in less rake
-- ('contribution'), then it draws the prize back out ('jackpot_draw'). That
-- draw is the money the winner is supposed to receive. The actual crediting
-- of the winner happens somewhere else entirely -- a wallet_transactions row
-- with type='credit', category='prize', related_entity_id=<tournament id>.
--
-- Nothing in the database has ever checked that those two halves agree.
--
-- We already had public.fn_spin_sweep_unbooked(), but it only looks in ONE
-- direction: "the game ran and nobody drew from the reserve". The opposite
-- and far more expensive direction -- "we drew from the reserve and nobody
-- got paid" -- had no invariant, no view, no alert, nothing.
--
-- MEASURED ON PRODUCTION, 2026-08-28
-- ----------------------------------
-- Across 23,686 settled Spins:
--   * 36 games drew 1,803.00 chips from the reserve and credited ZERO to any
--     player. The reserve is down 1,803.00 and no player is up anything.
--   * 16 more games under-paid: 894.00 drawn vs 620.00 credited.
--   * 11 games over-paid the other way: 546.00 drawn vs 839.00 credited.
--   * Total under-payment exposure: 2,077.00 chips over 52 games.
--   * Every single offender is between 2026-08-22 and 2026-08-24, all in club
--     fade0000-0000-0000-0000-000000000001 ("Midway Union"). Nothing since
--     the 24th, so this reads as a bounded incident rather than a leak that
--     is still running -- but there was no detector to tell us that, which is
--     exactly the problem this migration fixes.
--
-- TWO SHAPES, NOT ONE
-- -------------------
-- The audit described the 36 as "two players eliminated at places 2 and 3,
-- one survivor still status='playing' with a null position". That is true of
-- 26 of them. The other 10 have a perfectly well-formed final table -- a
-- seat at position 1 with status='winner' -- and STILL prize=0.00 and no
-- wallet credit. That matters, because it means ranking the survivors is not
-- sufficient to make the money right. Ranking is not paying. A detector that
-- only looked for null positions would have missed 10 of 36 games and
-- 391.00 chips.
--
-- WHY A VIEW AND NOT A CONSTRAINT
-- -------------------------------
-- The prize credit and the COMPLETED flip are not in one transaction, so we
-- cannot express this as a CHECK. But the ordering is stable and verifiable:
-- across all 14,571 Spins completed in the last three days, the prize credit
-- landed BEFORE the status flip in 14,571 of 14,571 cases, on average 3.2
-- seconds before. So an after-the-fact reconciliation view is sound as long
-- as we give in-flight games a grace period, which the view does below.
--
-- COLUMN NOTES FOR WHOEVER READS THIS NEXT
-- ----------------------------------------
-- Do not identify a Spin by tournaments.spin_multiplier or spin_type. Those
-- columns are populated on EVERY variant (13,357 sng rows, 873 freezeout,
-- 403 bounty ... all carry a non-null spin_multiplier). The only honest
-- identifier is tournaments.variant = 'spin'. Presence of a
-- spin_reserve_ledger row is likewise spin-exclusive in practice (all 23,687
-- belong to variant='spin') but it is a consequence, not the definition.
-- ============================================================================

CREATE OR REPLACE VIEW public.v_spin_unpaid_settlements AS
WITH draw AS (
  SELECT l.tournament_id,
         SUM(-l.amount)::numeric AS prize_drawn,
         MAX(l.created_at)       AS drawn_at
    FROM public.spin_reserve_ledger l
   WHERE l.kind = 'jackpot_draw'
     AND l.tournament_id IS NOT NULL
   GROUP BY l.tournament_id
),
paid AS (
  SELECT w.related_entity_id AS tournament_id,
         SUM(w.amount)::numeric AS prize_credited,
         COUNT(*)               AS credit_rows
    FROM public.wallet_transactions w
   WHERE w.type = 'credit'
     AND w.category = 'prize'
     AND w.related_entity_id IS NOT NULL
   GROUP BY w.related_entity_id
),
seats AS (
  SELECT tp.tournament_id,
         COUNT(*)                                          AS seat_count,
         COUNT(*) FILTER (WHERE tp.position IS NULL)       AS unranked_seats,
         COUNT(*) FILTER (WHERE tp.status = 'playing')     AS still_playing_seats,
         COUNT(*) FILTER (WHERE tp.position = 1)           AS seats_at_first,
         COALESCE(SUM(tp.prize), 0)::numeric               AS sum_seat_prize
    FROM public.tournament_players tp
   GROUP BY tp.tournament_id
)
SELECT t.id                                   AS tournament_id,
       t.club_id,
       t.name,
       t.status                               AS tournament_status,
       t.buy_in_amount,
       t.spin_multiplier,
       t.started_at,
       t.ended_at,
       d.drawn_at,
       d.prize_drawn,
       COALESCE(p.prize_credited, 0)          AS prize_credited,
       COALESCE(p.credit_rows, 0)             AS credit_rows,
       round(d.prize_drawn - COALESCE(p.prize_credited, 0), 2) AS chips_short,
       COALESCE(s.seat_count, 0)              AS seat_count,
       COALESCE(s.unranked_seats, 0)          AS unranked_seats,
       COALESCE(s.still_playing_seats, 0)     AS still_playing_seats,
       COALESCE(s.seats_at_first, 0)          AS seats_at_first,
       COALESCE(s.sum_seat_prize, 0)          AS sum_seat_prize,
       CASE
         WHEN COALESCE(p.prize_credited, 0) = 0            THEN 'nobody_paid'
         WHEN COALESCE(p.prize_credited, 0) < d.prize_drawn THEN 'under_paid'
         ELSE                                                   'over_paid'
       END                                    AS verdict,
       -- The seat story, for triage. 'ranked_but_unpaid' is the shape the
       -- original audit missed: the table finished cleanly and the money
       -- still never moved.
       CASE
         WHEN COALESCE(s.unranked_seats, 0) > 0 THEN 'unranked_survivor'
         WHEN COALESCE(s.seats_at_first, 0) = 1 THEN 'ranked_but_unpaid'
         ELSE 'other'
       END                                    AS seat_shape
  FROM draw d
  JOIN public.tournaments t ON t.id = d.tournament_id AND t.variant = 'spin'
  LEFT JOIN paid  p ON p.tournament_id = d.tournament_id
  LEFT JOIN seats s ON s.tournament_id = d.tournament_id
 WHERE round(d.prize_drawn - COALESCE(p.prize_credited, 0), 2) <> 0
   -- Grace period: a Spin that is still RUNNING has legitimately drawn its
   -- prize and legitimately not paid it yet. Only complain once it is
   -- terminal, or once it has been sitting on a drawn prize for 30 minutes
   -- (a 3-handed hyper that has not finished in 30 minutes is itself a bug).
   AND ( t.status IN ('COMPLETED', 'CANCELLED', 'CANCELED')
         OR d.drawn_at < now() - interval '30 minutes' );

COMMENT ON VIEW public.v_spin_unpaid_settlements IS
  'Reverse conservation check for Spins: every game where the reserve was '
  'debited via fn_spin_settle_game but the sum credited to players '
  '(wallet_transactions type=credit category=prize) does not match. '
  'fn_spin_sweep_unbooked only covers the opposite direction. '
  'chips_short > 0 means players are owed; < 0 means we over-paid.';

REVOKE ALL ON public.v_spin_unpaid_settlements FROM PUBLIC;
GRANT SELECT ON public.v_spin_unpaid_settlements TO service_role;


-- ---------------------------------------------------------------------------
-- fn_spin_unpaid_check: the thing a cron can call. Counts, totals, ids, and
-- raises one deduped financial_alert per offending tournament so the leak
-- announces itself instead of waiting for the next audit.
--
-- Read-only with respect to money. It writes financial_alerts and nothing
-- else. It deliberately does NOT pay anybody: deciding who gets 1,803.00
-- chips is a human decision, and inventing a winner for a table whose
-- survivor was never ranked would be inventing a result.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_spin_unpaid_check(p_since_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_since       timestamptz := now() - make_interval(days => GREATEST(COALESCE(p_since_days, 30), 1));
  v_unpaid      integer := 0;
  v_short       numeric := 0;
  v_over        integer := 0;
  v_over_amt    numeric := 0;
  v_nobody      integer := 0;
  v_ids         uuid[];
  v_alerts      integer := 0;
  v_row         record;
BEGIN
  SELECT COUNT(*) FILTER (WHERE v.chips_short > 0),
         COALESCE(SUM(v.chips_short) FILTER (WHERE v.chips_short > 0), 0),
         COUNT(*) FILTER (WHERE v.chips_short < 0),
         COALESCE(SUM(-v.chips_short) FILTER (WHERE v.chips_short < 0), 0),
         COUNT(*) FILTER (WHERE v.verdict = 'nobody_paid'),
         COALESCE(array_agg(v.tournament_id ORDER BY v.chips_short DESC)
                  FILTER (WHERE v.chips_short > 0), ARRAY[]::uuid[])
    INTO v_unpaid, v_short, v_over, v_over_amt, v_nobody, v_ids
    FROM public.v_spin_unpaid_settlements v
   WHERE COALESCE(v.drawn_at, v.started_at) >= v_since;

  -- One alert per offending tournament, never a duplicate while unresolved.
  FOR v_row IN
    SELECT v.* FROM public.v_spin_unpaid_settlements v
     WHERE COALESCE(v.drawn_at, v.started_at) >= v_since
       AND v.chips_short > 0
  LOOP
    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT 'critical', 'fn_spin_unpaid_check',
           format('Spin drew %s from the reserve and credited %s to players: %s',
                  v_row.prize_drawn, v_row.prize_credited,
                  COALESCE(v_row.name, v_row.tournament_id::text)),
           jsonb_build_object('tournament_id', v_row.tournament_id,
                              'club_id',       v_row.club_id,
                              'prize_drawn',   v_row.prize_drawn,
                              'prize_credited',v_row.prize_credited,
                              'chips_short',   v_row.chips_short,
                              'verdict',       v_row.verdict,
                              'seat_shape',    v_row.seat_shape,
                              'unranked_seats',v_row.unranked_seats,
                              'buy_in',        v_row.buy_in_amount,
                              'multiplier',    v_row.spin_multiplier,
                              'drawn_at',      v_row.drawn_at,
                              'detail',        'no money was moved by this check; a human decides the payout')
     WHERE NOT EXISTS (
       SELECT 1 FROM public.financial_alerts fa
        WHERE fa.source = 'fn_spin_unpaid_check'
          AND fa.resolved IS NOT TRUE
          AND fa.context->>'tournament_id' = v_row.tournament_id::text);
    IF FOUND THEN v_alerts := v_alerts + 1; END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok',                    true,
    'since_days',            GREATEST(COALESCE(p_since_days, 30), 1),
    'unpaid_count',          v_unpaid,
    'nobody_paid_count',     v_nobody,
    'chips_at_risk',         round(v_short, 2),
    'over_paid_count',       v_over,
    'chips_over_paid',       round(v_over_amt, 2),
    'alerts_raised',         v_alerts,
    'tournament_ids',        to_jsonb(v_ids));
END;
$fn$;

COMMENT ON FUNCTION public.fn_spin_unpaid_check(integer) IS
  'Reverse conservation check for Spins. Returns a count, the total chips at '
  'risk and the offending tournament ids, and raises one deduped critical '
  'financial_alert per offender. Moves no money by design.';

REVOKE ALL ON FUNCTION public.fn_spin_unpaid_check(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_spin_unpaid_check(integer) TO service_role;

