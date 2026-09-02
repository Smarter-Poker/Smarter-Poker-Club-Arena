-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826040347; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.trg_hand_history_club_member_stats()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_club uuid;
  v_date date;
  v_tourney boolean;
BEGIN
  SELECT t.club_id, (t.tournament_id IS NOT NULL)
    INTO v_club, v_tourney
    FROM tables t WHERE t.id = NEW.table_id;
  IF v_club IS NULL THEN RETURN NEW; END IF;

  v_tourney := COALESCE(v_tourney, false) OR (NEW.tournament_id IS NOT NULL);

  v_date := (NEW.created_at AT TIME ZONE 'UTC')::date;

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
         CASE WHEN v_tourney THEN 0 WHEN calc.attributable THEN 1 ELSE 0 END,
         CASE WHEN calc.won > 0 THEN 1 ELSE 0 END,
         CASE WHEN v_tourney THEN 0 ELSE calc.won END,
         CASE WHEN v_tourney THEN 0 WHEN calc.attributable THEN calc.delta ELSE 0 END,
         CASE WHEN v_tourney THEN 0 ELSE calc.won END,
         CASE WHEN v_tourney THEN 0 ELSE coalesce(NEW.pot_size, 0) END,
         CASE WHEN v_tourney THEN 0
              WHEN NOT calc.attributable AND calc.delta > calc.won THEN calc.delta - calc.won
              ELSE 0 END
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
