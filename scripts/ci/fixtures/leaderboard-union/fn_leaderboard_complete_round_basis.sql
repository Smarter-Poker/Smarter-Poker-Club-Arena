CREATE OR REPLACE FUNCTION public.fn_leaderboard_complete_round_basis(p_club_id uuid, p_period text, p_start date, p_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cutoff date;
  v_open public.leaderboard_complete_captures%ROWTYPE;
  v_close public.leaderboard_complete_captures%ROWTYPE;
  v_count bigint;
  v_hash text;
  v_rows jsonb;
  v_capture public.leaderboard_complete_captures%ROWTYPE;
BEGIN
  IF p_club_id IS NULL OR p_start IS NULL OR p_end IS NULL
     OR p_period NOT IN ('weekly', 'monthly') OR p_period IS NULL
     OR p_end > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date
     OR (p_period = 'weekly' AND
         (extract(dow FROM p_start) <> 0 OR p_end <> p_start + 7))
     OR (p_period = 'monthly' AND
         (extract(day FROM p_start) <> 1 OR p_end <> (p_start + interval '1 month')::date)) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'LEADERBOARD_BASIS_WINDOW_INVALID';
  END IF;
  SELECT CASE p_period WHEN 'weekly' THEN weekly_v2_from ELSE monthly_v2_from END
    INTO v_cutoff FROM public.leaderboard_basis_rollout WHERE singleton;
  IF v_cutoff IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'LEADERBOARD_BASIS_ROLLOUT_MISSING';
  END IF;
  IF p_start < v_cutoff AND EXISTS (
    SELECT 1 FROM public.leaderboard_basis_existing_clubs WHERE club_id = p_club_id
  ) THEN
    -- Caller must run/freeze legacy semantics, not claim these inputs complete.
    RETURN jsonb_build_object('basis_version', 'legacy_v1', 'complete', false);
  END IF;

  SELECT * INTO v_open FROM public.leaderboard_complete_captures WHERE capture_date = p_start;
  SELECT * INTO v_close FROM public.leaderboard_complete_captures WHERE capture_date = p_end;
  IF v_open.capture_date IS NULL OR v_close.capture_date IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'LEADERBOARD_CAPTURE_UNAVAILABLE';
  END IF;
  -- Exact dates, never max(date)<=boundary. Validate the complete global domain:
  -- any club with zero rows is genuinely empty within the applied-stats capture.
  FOR v_capture IN SELECT * FROM public.leaderboard_complete_captures
    WHERE capture_date IN (p_start, p_end)
  LOOP
    SELECT count(*), md5(COALESCE(string_agg(
      (to_jsonb(c) - 'snapshot_date')::text, E'\n' ORDER BY c.club_id, c.user_id), ''))
    INTO v_count, v_hash FROM public.leaderboard_capture_counters c
    WHERE c.snapshot_date = v_capture.capture_date;
    IF NOT v_capture.complete OR v_count <> v_capture.row_count
       OR v_hash <> v_capture.counter_hash
       OR (v_capture.captured_at AT TIME ZONE 'UTC')::date <> v_capture.capture_date THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'LEADERBOARD_CAPTURE_INVALID';
    END IF;
  END LOOP;

  -- Same closing roster and delta arithmetic as authoritative ranking. Individual
  -- absence in a proven complete opening capture is legitimate zero, not failure.
  -- Return raw deltas; no invented score/tie/qualification or previous-rank rule.
  SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.user_id), '[]'::jsonb) INTO v_rows
  FROM (
    SELECT closing.user_id,
      GREATEST(closing.hands_dealt - COALESCE(opening.hands_dealt, 0), 0)::numeric AS hands_played,
      closing.total_winnings - COALESCE(opening.total_winnings, 0) AS total_winnings,
      closing.total_losses - COALESCE(opening.total_losses, 0) AS total_losses,
      GREATEST(closing.tournaments_won - COALESCE(opening.tournaments_won, 0), 0)::numeric AS tournaments_won,
      GREATEST(closing.total_rake - COALESCE(opening.total_rake, 0), 0) AS total_rake,
      GREATEST(closing.sum_big_blind - COALESCE(opening.sum_big_blind, 0), 0) AS sum_big_blind
    FROM public.leaderboard_capture_counters closing
    LEFT JOIN public.leaderboard_capture_counters opening
      ON opening.snapshot_date = p_start AND opening.club_id = closing.club_id
      AND opening.user_id = closing.user_id
    WHERE closing.snapshot_date = p_end AND closing.club_id = p_club_id
  ) d;
  RETURN jsonb_build_object('basis_version', 'complete_capture_v2', 'complete', true,
    'source_contract', 'applied_player_stats_v1', 'club_id', p_club_id,
    'opening_date', p_start, 'closing_date', p_end,
    'opening_captured_at', v_open.captured_at, 'closing_captured_at', v_close.captured_at,
    'opening_hash', v_open.counter_hash, 'closing_hash', v_close.counter_hash,
    'rows', v_rows);
END;
$function$
