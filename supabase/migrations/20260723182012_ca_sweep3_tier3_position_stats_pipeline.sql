-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260723182012 "ca_sweep3_tier3_position_stats_pipeline"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 daa5fcad613d50b13ab0443cb2e65121 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═════════════════════════════════════════════════════════════════════════════
-- CA sweep #3 Tier 3a — player position stats pipeline.
-- Derives per-position VPIP/PFR/3-bet/win stats from hand_history (the live
-- hand store: players/actions/winners jsonb) via an AFTER INSERT trigger, plus
-- a windowed backfill function. Positions are inferred from preflop action
-- order (last actor = BB, then SB, BTN, CO, MP, earlier = UTG) — documented
-- heuristic, since dealer position is not persisted in hand_history.
-- Profit approximation: winnings minus per-street max to-match amount.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_process_hand_position_stats(p_hand_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_h record;
  v_order uuid[] := '{}';
  v_uid uuid;
  v_n int;
  v_i int;
  v_pos text;
  v_raises int;
  v_player_raised boolean;
  v_vpip int; v_pfr int; v_3bet int; v_fold3 int;
  v_won int; v_profit numeric;
  a jsonb;
  v_raise_count_before int;
BEGIN
  SELECT id, players, actions, winners INTO v_h FROM hand_history WHERE id = p_hand_id;
  IF v_h.id IS NULL OR v_h.players IS NULL OR jsonb_typeof(v_h.players) <> 'array' THEN
    RETURN;
  END IF;

  -- preflop action order (first action per player)
  IF v_h.actions IS NOT NULL AND jsonb_typeof(v_h.actions) = 'array' THEN
    FOR a IN SELECT * FROM jsonb_array_elements(v_h.actions) LOOP
      IF a->>'stage' = 'preflop' AND (a->>'userId') IS NOT NULL THEN
        v_uid := (a->>'userId')::uuid;
        IF NOT v_uid = ANY(v_order) THEN
          v_order := v_order || v_uid;
        END IF;
      END IF;
    END LOOP;
  END IF;

  v_n := array_length(v_order, 1);
  IF v_n IS NULL OR v_n < 2 THEN RETURN; END IF;

  FOR v_i IN 1..v_n LOOP
    v_uid := v_order[v_i];
    -- position by distance from the end of preflop order
    v_pos := CASE v_n - v_i
      WHEN 0 THEN 'BB'
      WHEN 1 THEN 'SB'
      WHEN 2 THEN 'BTN'
      WHEN 3 THEN 'CO'
      WHEN 4 THEN 'MP'
      ELSE 'UTG' END;

    v_vpip := 0; v_pfr := 0; v_3bet := 0; v_fold3 := 0;
    v_raises := 0; v_player_raised := false;

    FOR a IN SELECT * FROM jsonb_array_elements(v_h.actions) LOOP
      CONTINUE WHEN a->>'stage' <> 'preflop' OR (a->>'userId') IS NULL;
      v_raise_count_before := v_raises;
      IF a->>'action' IN ('raise','bet') THEN v_raises := v_raises + 1; END IF;

      IF (a->>'userId')::uuid = v_uid THEN
        IF a->>'action' IN ('call','raise','bet') AND COALESCE((a->>'amount')::numeric, 0) > 0 THEN
          v_vpip := 1;
        END IF;
        IF a->>'action' IN ('raise','bet') THEN
          v_pfr := 1;
          IF v_raise_count_before >= 1 THEN v_3bet := 1; END IF;
          v_player_raised := true;
        END IF;
        IF a->>'action' = 'fold' AND v_player_raised AND v_raise_count_before >= 2 THEN
          v_fold3 := 1;
        END IF;
      END IF;
    END LOOP;

    -- winnings
    SELECT COALESCE(sum((w->>'amount')::numeric), 0) INTO v_profit
      FROM jsonb_array_elements(COALESCE(v_h.winners, '[]'::jsonb)) w
     WHERE (w->>'userId')::uuid = v_uid;
    v_won := CASE WHEN v_profit > 0 THEN 1 ELSE 0 END;

    -- contributed ≈ sum over streets of the max to-match amount the player posted
    v_profit := v_profit - COALESCE((
      SELECT sum(mx) FROM (
        SELECT max(COALESCE((a2->>'amount')::numeric, 0)) AS mx
          FROM jsonb_array_elements(v_h.actions) a2
         WHERE (a2->>'userId')::uuid = v_uid
           AND a2->>'action' IN ('call','raise','bet')
         GROUP BY a2->>'stage'
      ) s), 0);

    INSERT INTO player_position_stats AS pps
      (user_id, position, hands_played, vpip_count, pfr_count, three_bet_count,
       fold_to_three_bet_count, hands_won, total_profit, updated_at)
    VALUES (v_uid, v_pos, 1, v_vpip, v_pfr, v_3bet, v_fold3, v_won, round(v_profit, 2), now())
    ON CONFLICT (user_id, position) DO UPDATE SET
      hands_played = pps.hands_played + 1,
      vpip_count = pps.vpip_count + EXCLUDED.vpip_count,
      pfr_count = pps.pfr_count + EXCLUDED.pfr_count,
      three_bet_count = pps.three_bet_count + EXCLUDED.three_bet_count,
      fold_to_three_bet_count = pps.fold_to_three_bet_count + EXCLUDED.fold_to_three_bet_count,
      hands_won = pps.hands_won + EXCLUDED.hands_won,
      total_profit = pps.total_profit + EXCLUDED.total_profit,
      updated_at = now();
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_hand_history_position_stats()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  BEGIN
    PERFORM fn_process_hand_position_stats(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    -- never block the engine's hand insert on stats bookkeeping
    RAISE WARNING 'position stats failed for hand %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS hand_history_position_stats ON public.hand_history;
CREATE TRIGGER hand_history_position_stats
AFTER INSERT ON public.hand_history
FOR EACH ROW EXECUTE FUNCTION public.trg_hand_history_position_stats();

-- Windowed backfill (call per-window to bound runtime)
CREATE OR REPLACE FUNCTION public.fn_backfill_position_stats(p_from timestamptz, p_to timestamptz)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE v_id uuid; v_count int := 0;
BEGIN
  FOR v_id IN SELECT id FROM hand_history
              WHERE created_at >= p_from AND created_at < p_to
              ORDER BY created_at LOOP
    BEGIN
      PERFORM fn_process_hand_position_stats(v_id);
      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
  RETURN v_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_process_hand_position_stats(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_backfill_position_stats(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
