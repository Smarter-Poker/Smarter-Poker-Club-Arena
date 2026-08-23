-- ═══════════════════════════════════════════════════════════════════════════
--  EVERY HAND ON THE PLATFORM WAS QUEUEING BEHIND ONE ROW
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Measured 2026-08-23 21:50 UTC, live: hands dealt per minute had fallen from
-- ~250 to 29, with 103 "hand_history insert failed: canceling statement due to
-- statement timeout" in 25 minutes. pg_blocking_pids showed the shape exactly:
--
--     pid 25667  active 9.3s   INSERT INTO hand_history ...
--     pid 25660  blocked_by [25667]
--     pid 25654  blocked_by [25667]        eight hand inserts,
--     pid 25661  blocked_by [25667]        all waiting on one
--     ...
--
-- WHY. trg_hand_history_club_member_stats runs inside every hand insert and its
-- FIRST statement upserted club_hand_daily, keyed (club_id, stat_date). A row
-- lock taken by an UPDATE is held until the TRANSACTION commits, not until the
-- statement ends -- so that one row stayed locked for the whole remaining
-- trigger: a jsonb expansion per seated player, a correlated NOT EXISTS over
-- hand_history, and two more upserts.
--
-- AND EVERY TABLE ON THE PLATFORM SHARES THAT ROW. Checked at the same moment:
--
--     distinct clubs dealing:       1
--     live tables:                178
--     busiest club_hand_daily row:  97,772 hands today
--
-- Every table belongs to the union club, so what the design imagined as
-- per-club contention is one row for the entire estate. ~99 ms of hold caps
-- that row at ~10 writes/second however much hardware is behind it; at 250
-- hands a minute the queue never drains, waiters hold their own locks longer,
-- and the pipeline collapses to the 29 hands a minute that was measured.
--
-- THE FIX. The club_hand_daily upsert reads nothing the other statements write,
-- and nothing else reads it. Moved to the END, the hot row is locked for the
-- last statement plus the commit instead of for the entire body.
--
-- MEASURED, same probe before and after, EXPLAIN ANALYZE on a real row:
--
--                                   before      after
--     whole INSERT (incl. waiting)  993.7 ms    87.7 ms
--     the insert node itself        858 ms       7.6 ms
--     this trigger                   98.8 ms    29.7 ms
--     queries blocked on the row      8           0
--
-- NOTHING ELSE CHANGED. Same statements, same values, same conflict targets,
-- same exception handling -- only the order, which the assertions below pin.
--
-- The other two triggers were measured and are not part of this:
-- fn_fold_hand_winnings (18.8 ms) upserts player_stats keyed (user_id,
-- club_id), which is per player and never converges on one row, and
-- trg_hand_history_position_stats (17.7 ms) is already wrapped so it cannot
-- block the engine's insert.
--
-- APPLIED TO PRODUCTION 2026-08-23 via the Supabase MCP.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.trg_hand_history_club_member_stats()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_club uuid;
  v_date date;
BEGIN
  SELECT t.club_id INTO v_club FROM tables t WHERE t.id = NEW.table_id;
  IF v_club IS NULL THEN RETURN NEW; END IF;
  v_date := (NEW.created_at AT TIME ZONE 'UTC')::date;

  -- Per-player and per-table bookkeeping FIRST. These are keyed
  -- (club_id, table_id, user_id, stat_date) and (table_id, user_id), so two
  -- hands at different tables never contend, and this is where the ~99 ms
  -- goes. Doing it before the club-wide counter is the whole point of this
  -- migration: none of it is done while holding the one row every table shares.
  WITH pl AS (
    SELECT DISTINCT ON (p->>'userId') (p->>'userId')::uuid AS uid, (p->>'stack')::numeric AS stack
    FROM jsonb_array_elements(coalesce(NEW.players, '[]'::jsonb)) p
    WHERE (p->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      AND (p->>'stack') IS NOT NULL
  ), wn AS (
    SELECT (w->>'userId')::uuid AS uid, sum((w->>'amount')::numeric) AS won
    FROM jsonb_array_elements(coalesce(NEW.winners, '[]'::jsonb)) w
    WHERE (w->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    GROUP BY 1
  ), base AS (
    SELECT pl.uid, pl.stack, coalesce(wn.won, 0) AS won, st.last_stack,
           (st.last_stack IS NOT NULL AND st.last_hand_number IS NOT NULL AND NEW.hand_number IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM hand_history h2
               WHERE h2.table_id = NEW.table_id
                 AND h2.hand_number > st.last_hand_number
                 AND h2.hand_number < NEW.hand_number)) AS adjacent
    FROM pl
    LEFT JOIN wn ON wn.uid = pl.uid
    LEFT JOIN club_member_table_state st ON st.table_id = NEW.table_id AND st.user_id = pl.uid
  ), agg AS (
    SELECT count(*) AS seated,
           count(*) FILTER (WHERE last_stack IS NOT NULL) AS with_prior,
           coalesce(sum(stack - last_stack) FILTER (WHERE last_stack IS NOT NULL), 0) AS dsum
    FROM base
  ), calc AS (
    SELECT b.uid, b.won,
           CASE WHEN b.last_stack IS NOT NULL THEN b.stack - b.last_stack ELSE 0 END AS delta,
           CASE WHEN a.seated = a.with_prior
                THEN abs(a.dsum + coalesce(NEW.rake_amount, 0) + coalesce(NEW.bbj_amount, 0)) < 0.005
                ELSE b.adjacent AND (b.stack - b.last_stack) <= b.won + 0.001 END AS attributable
    FROM base b CROSS JOIN agg a
  )
  INSERT INTO club_member_daily_stats AS s
    (club_id, table_id, user_id, stat_date, hands_played, hands_attributed, hands_won,
     total_won, profit, biggest_pot_won, biggest_pot, topup_total)
  SELECT v_club, NEW.table_id, calc.uid, v_date, 1,
         CASE WHEN calc.attributable THEN 1 ELSE 0 END,
         CASE WHEN calc.won > 0 THEN 1 ELSE 0 END,
         calc.won,
         CASE WHEN calc.attributable THEN calc.delta ELSE 0 END,
         calc.won,
         coalesce(NEW.pot_size, 0),
         CASE WHEN NOT calc.attributable AND calc.delta > calc.won THEN calc.delta - calc.won ELSE 0 END
  FROM calc
  ON CONFLICT (club_id, table_id, user_id, stat_date) DO UPDATE SET
    hands_played = s.hands_played + 1,
    hands_attributed = s.hands_attributed + EXCLUDED.hands_attributed,
    hands_won = s.hands_won + EXCLUDED.hands_won,
    total_won = s.total_won + EXCLUDED.total_won,
    profit = s.profit + EXCLUDED.profit,
    biggest_pot_won = greatest(s.biggest_pot_won, EXCLUDED.biggest_pot_won),
    biggest_pot = greatest(s.biggest_pot, EXCLUDED.biggest_pot),
    topup_total = s.topup_total + EXCLUDED.topup_total,
    updated_at = now();

  INSERT INTO club_member_table_state AS st (table_id, user_id, last_stack, last_hand_number)
  SELECT DISTINCT ON (p->>'userId') NEW.table_id, (p->>'userId')::uuid, (p->>'stack')::numeric, NEW.hand_number
  FROM jsonb_array_elements(coalesce(NEW.players, '[]'::jsonb)) p
  WHERE (p->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    AND (p->>'stack') IS NOT NULL
  ON CONFLICT (table_id, user_id) DO UPDATE SET
    last_stack = EXCLUDED.last_stack,
    last_hand_number = EXCLUDED.last_hand_number,
    updated_at = now();

  -- THE ONE ROW EVERY TABLE SHARES, TAKEN LAST AND HELD ONLY UNTIL COMMIT.
  -- Club-level per-day rollup (Hands Today / Rake Today / 14-day series).
  INSERT INTO club_hand_daily AS d (club_id, stat_date, hands, rake, bbj, pot_total)
  VALUES (v_club, v_date, 1, coalesce(NEW.rake_amount, 0), coalesce(NEW.bbj_amount, 0), coalesce(NEW.pot_size, 0))
  ON CONFLICT (club_id, stat_date) DO UPDATE SET
    hands = d.hands + 1,
    rake = d.rake + EXCLUDED.rake,
    bbj = d.bbj + EXCLUDED.bbj,
    pot_total = d.pot_total + EXCLUDED.pot_total,
    updated_at = now();

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'trg_hand_history_club_member_stats failed: %', SQLERRM;
  RETURN NEW;
END;
$function$;

DO $check$
DECLARE src text; i_daily int; i_member int; i_state int;
BEGIN
  SELECT prosrc INTO src FROM pg_proc WHERE proname = 'trg_hand_history_club_member_stats';

  -- Every write the old body performed must still be here, once each.
  IF (SELECT count(*) FROM regexp_matches(src, 'INSERT INTO club_hand_daily', 'g')) <> 1
     OR (SELECT count(*) FROM regexp_matches(src, 'INSERT INTO club_member_daily_stats', 'g')) <> 1
     OR (SELECT count(*) FROM regexp_matches(src, 'INSERT INTO club_member_table_state', 'g')) <> 1 THEN
    RAISE EXCEPTION 'a write was lost or duplicated while reordering the trigger';
  END IF;

  -- And the hot one must be LAST. This is the entire point; if a later edit
  -- moves it back to the front the platform silently reacquires a ten-writes-
  -- per-second ceiling on every hand dealt anywhere.
  i_daily  := position('INSERT INTO club_hand_daily' in src);
  i_member := position('INSERT INTO club_member_daily_stats' in src);
  i_state  := position('INSERT INTO club_member_table_state' in src);
  IF NOT (i_daily > i_member AND i_daily > i_state) THEN
    RAISE EXCEPTION 'club_hand_daily is not the last write - the shared row is locked for the whole trigger again';
  END IF;

  -- The conflict targets and the exception guard must be untouched.
  IF src NOT LIKE '%ON CONFLICT (club_id, stat_date) DO UPDATE%'
     OR src NOT LIKE '%ON CONFLICT (club_id, table_id, user_id, stat_date) DO UPDATE%'
     OR src NOT LIKE '%ON CONFLICT (table_id, user_id) DO UPDATE%'
     OR src NOT LIKE '%EXCEPTION WHEN OTHERS%' THEN
    RAISE EXCEPTION 'a conflict target or the exception guard changed';
  END IF;
END $check$;
