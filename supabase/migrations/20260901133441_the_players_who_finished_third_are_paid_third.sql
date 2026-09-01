-- ═══════════════════════════════════════════════════════════════════════════
--  THE PLAYERS WHO FINISHED THIRD ARE PAID THIRD (2026-09-01)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Fifteen MTTs between 2026-05-08 and 2026-07-19 recorded finishing places that
-- run past the size of their own field. Late Night Grind (PLO4) on 2026-06-07
-- seated ten players and stamped places 1, 2, then 6 through 13. Places 3, 4
-- and 5 pay 18, 10 and 7 percent of the pool and had nobody in them, so three
-- players who genuinely finished third, fourth and fifth were labelled sixth,
-- seventh and eighth and paid nothing at all.
--
-- The cause was fixed on 2026-07-19 (distinct finishing places) and there has
-- been no occurrence since. fn_payout_guarantee_check, shipped the same day as
-- this migration, is what would have caught it in an hour rather than ten
-- weeks. This migration is the other half: the players are paid.
--
-- ── WHY COMPACTING THE PLACES IS ARITHMETIC AND NOT A GUESS ───────────────
--
-- In every one of the fifteen events the recorded positions are strictly
-- increasing, distinct, non-null, and number exactly as many as the field. The
-- engine's own ordering is therefore intact; only the labels are inflated.
-- Dense-ranking the recorded positions preserves that order exactly and can
-- only ever move a player UP. Nobody is reordered against anybody, and place 1
-- is already occupied in all fifteen, so no champion changes.
--
-- This migration refuses to touch any event where that is not true, rather than
-- ranking on eliminated_at, which for these events is a mass-sweep timestamp
-- and would reorder 114 of 170 rows on a guess.
--
-- ── THE MONEY, AND WHOSE DECISION IT IS ───────────────────────────────────
--
--   32 players are owed        161.30 chips
--   their pools still hold      76.70
--   the hosting clubs absorb    84.60   across 10 of the 15 events
--   already overpaid            91.10   to players whose corrected place is
--                                       worth less than what they received
--
-- Nothing is clawed back from any player. That is not a new decision: it is
-- Dan's ruling of 2026-08-28 on the duplicate-place overpays, verbatim "no
-- clawback from players, the hosting club absorbs it", and this is the same
-- class of defect - a finishing place recorded wrongly and paid on.
--
-- The 84.60 the clubs absorb is deliberate minting, so it is written to
-- tournament_conservation_baseline, one auditable row per event carrying the
-- exact amount. That is what the table is for, and it stops ten events
-- alerting forever on a difference somebody chose on purpose.
--
-- Every affected player is a horse. Under HORSES ARE PLAYERS that changes
-- nothing about the obligation; it is recorded because it is true.
--
-- ROLLBACK
--   There is none for the credits: fn_credit_and_log moves money and the
--   idempotency keys are consumed. The positions can be restored from
--   tournament_players_position_repair_20260901, which this migration writes
--   BEFORE it changes anything.

-- No explicit BEGIN/COMMIT: the migration runner supplies the single
-- transaction this needs, and the production DDL policy wants exactly one per
-- migration so PostgREST reloads its schema cache once rather than three times.

-- The before picture, kept. Nothing below runs until this exists.
CREATE TABLE IF NOT EXISTS public.tournament_players_position_repair_20260901 (
  tournament_id uuid        NOT NULL,
  user_id       uuid        NOT NULL,
  old_position  integer,
  new_position  integer     NOT NULL,
  place_worth   numeric     NOT NULL,
  already_paid  numeric     NOT NULL,
  top_up        numeric     NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tournament_id, user_id)
);

DO $repair$
DECLARE
  v_ev        record;
  v_row       record;
  v_credited  boolean;
  v_events    integer := 0;
  v_moved     integer := 0;
  v_paid      numeric := 0;
  v_absorbed  numeric := 0;
  v_remaining numeric;
  v_topup     numeric;
BEGIN
  FOR v_ev IN
    WITH ev AS (
      SELECT t.id, t.name, round(COALESCE(t.prize_pool, 0), 2) AS pool,
             t.payout_structure::jsonb AS ps,
             (SELECT count(*) FROM public.tournament_players tp
               WHERE tp.tournament_id = t.id) AS entrants,
             COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
                        WHERE w.related_entity_id = t.id AND w.type = 'credit'
                          AND w.category = 'prize'), 0) AS wallet_prizes
        FROM public.tournaments t
       WHERE t.status = 'COMPLETED'
         AND COALESCE(t.prize_pool, 0) > 0
         AND COALESCE(t.satellite_seats, 0) = 0
         AND COALESCE(t.variant, '') <> 'satellite'
    ), places AS (
      SELECT ev.id, (elem->>'place')::int AS place
        FROM ev CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(ev.ps) = 'array' THEN ev.ps ELSE '[]'::jsonb END) elem
    )
    SELECT ev.*
      FROM ev
     WHERE EXISTS (
             SELECT 1 FROM places p
              WHERE p.id = ev.id AND p.place <= ev.entrants
                AND NOT EXISTS (SELECT 1 FROM public.tournament_players tp
                                 WHERE tp.tournament_id = ev.id AND tp.position = p.place))
       -- THE PRECONDITION. Positions must be a clean total order of the field:
       -- present, distinct, and exactly as many as there are players. Anything
       -- else and the compaction would be a guess, so the event is skipped and
       -- left for a human.
       AND NOT EXISTS (SELECT 1 FROM public.tournament_players tp
                        WHERE tp.tournament_id = ev.id AND tp.position IS NULL)
       AND (SELECT count(DISTINCT tp.position) FROM public.tournament_players tp
             WHERE tp.tournament_id = ev.id) = ev.entrants
       AND EXISTS (SELECT 1 FROM public.tournament_players tp
                    WHERE tp.tournament_id = ev.id AND tp.position = 1)
  LOOP
    v_events := v_events + 1;

    INSERT INTO public.tournament_players_position_repair_20260901
      (tournament_id, user_id, old_position, new_position, place_worth, already_paid, top_up)
    SELECT c.id, c.user_id, c.old_pos, c.new_pos, c.worth, c.paid,
           GREATEST(round(c.worth - c.paid, 2), 0)
      FROM (
        SELECT np.id, np.user_id, np.old_pos, np.new_pos,
               round(v_ev.pool * (elem->>'percentage')::numeric / 100, 2) AS worth,
               COALESCE((SELECT sum(x.amount) FROM public.wallet_transactions x
                          WHERE x.related_entity_id = np.id AND x.user_id = np.user_id
                            AND x.type = 'credit' AND x.category = 'prize'), 0) AS paid
          FROM (
            SELECT tp.tournament_id AS id, tp.user_id, tp.position AS old_pos,
                   dense_rank() OVER (ORDER BY tp.position)::int AS new_pos
              FROM public.tournament_players tp
             WHERE tp.tournament_id = v_ev.id
          ) np
          JOIN LATERAL jsonb_array_elements(v_ev.ps) elem
            ON (elem->>'place')::int = np.new_pos
      ) c
    ON CONFLICT (tournament_id, user_id) DO NOTHING;

    /* Places carrying no prize are still renumbered: a standing of 13th in a
       ten-handed field is wrong whether or not it pays.

       ONE ROW AT A TIME, IN ASCENDING TARGET ORDER. A set-based UPDATE is
       refused by trg_tournament_place_collision, and rightly so - moving the
       player at 11 down to 10 while the player at 10 has not yet moved to 9
       puts two players on place 10, and that trigger exists because a contested
       place is paid twice (the prize idempotency key carries the user id).
       Dense rank never moves anybody up, so walking the targets in ascending
       order means the seat is always empty by the time it is filled. */
    FOR v_row IN
      SELECT tp.user_id, tp.position AS old_pos,
             dense_rank() OVER (ORDER BY tp.position)::int AS new_pos
        FROM public.tournament_players tp
       WHERE tp.tournament_id = v_ev.id
       ORDER BY 3
    LOOP
      IF v_row.old_pos IS DISTINCT FROM v_row.new_pos THEN
        UPDATE public.tournament_players
           SET position = v_row.new_pos
         WHERE tournament_id = v_ev.id AND user_id = v_row.user_id;
        v_moved := v_moved + 1;
      END IF;
    END LOOP;

    v_topup := 0;
    FOR v_row IN
      SELECT rp.user_id, rp.new_position, rp.top_up
        FROM public.tournament_players_position_repair_20260901 rp
       WHERE rp.tournament_id = v_ev.id AND rp.top_up > 0.005
       ORDER BY rp.new_position
    LOOP
      v_credited := public.fn_credit_and_log(
        v_row.user_id,
        v_row.top_up,
        format('tourney:%s:vacantplace:%s:%s', v_ev.id, v_row.user_id, v_row.new_position),
        'prize',
        format('Tournament prize (finishing place corrected to %s)', v_row.new_position),
        v_ev.id);
      IF v_credited THEN
        v_paid := v_paid + v_row.top_up;
        v_topup := v_topup + v_row.top_up;
      END IF;
    END LOOP;

    -- What the pool could not back is minted on purpose, and recorded as such.
    v_remaining := GREATEST(v_ev.pool - v_ev.wallet_prizes, 0);
    IF v_topup > v_remaining THEN
      INSERT INTO public.tournament_conservation_baseline (tournament_id, amount, reason, recorded_at)
      VALUES (v_ev.id, round(v_topup - v_remaining, 2),
              'vacant paid place repair 2026-09-01: the hosting club absorbs what the pool could not back, per Dan 2026-08-28 (no clawback from players)',
              now())
      ON CONFLICT (tournament_id) DO UPDATE
        SET amount = public.tournament_conservation_baseline.amount + EXCLUDED.amount,
            reason = EXCLUDED.reason,
            recorded_at = EXCLUDED.recorded_at;
      v_absorbed := v_absorbed + round(v_topup - v_remaining, 2);
    END IF;
  END LOOP;

  RAISE NOTICE 'vacant-place repair: % event(s), % position(s) corrected, % chips paid, % absorbed by clubs',
    v_events, v_moved, round(v_paid, 2), round(v_absorbed, 2);

  IF v_events = 0 THEN
    RAISE EXCEPTION 'the repair matched no events; refusing to record a no-op as done';
  END IF;
END
$repair$;

-- Nothing may still be sitting in a paid place with no holder.
DO $assert$
DECLARE v_left integer;
BEGIN
  WITH ev AS (
    SELECT t.id, t.payout_structure::jsonb ps,
           (SELECT count(*) FROM public.tournament_players tp WHERE tp.tournament_id=t.id) entrants
      FROM public.tournaments t
     WHERE t.id IN (SELECT DISTINCT tournament_id
                      FROM public.tournament_players_position_repair_20260901)
  )
  SELECT count(*) INTO v_left
    FROM ev CROSS JOIN LATERAL jsonb_array_elements(ev.ps) elem
   WHERE (elem->>'place')::int <= ev.entrants
     AND NOT EXISTS (SELECT 1 FROM public.tournament_players tp
                      WHERE tp.tournament_id = ev.id
                        AND tp.position = (elem->>'place')::int);
  IF v_left > 0 THEN
    RAISE EXCEPTION 'repair left % paid place(s) with nobody in them', v_left;
  END IF;
END
$assert$;
