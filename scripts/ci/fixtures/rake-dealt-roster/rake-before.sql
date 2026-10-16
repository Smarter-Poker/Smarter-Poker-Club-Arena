CREATE OR REPLACE FUNCTION public.fn_rake_law_violations(p_window interval DEFAULT '01:00:00'::interval)
 RETURNS TABLE(kind text, hand_id uuid, table_id uuid, occurred_at timestamp with time zone, small_blind numeric, big_blind numeric, pot numeric, rake numeric, allowed numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH h AS (
    SELECT hh.id, hh.table_id, hh.created_at,
           COALESCE(hh.rake_amount, 0) AS rake,
           COALESCE(rr.bbj_contribution, hh.bbj_amount, 0) AS bbj,
           hh.pot_size AS pot,
           t.small_blind AS sb, t.big_blind AS bb, t.club_id, t.id AS tid,
           t.max_players AS seats,
           lower(COALESCE(hh.game_variant, t.game_variant::text)) AS variant,
           COALESCE(rr.num_players, jsonb_array_length(CASE WHEN jsonb_typeof(hh.players) = 'array' THEN hh.players END)) AS dealt,
           COALESCE(array_length(hh.community_cards, 1), 0)
             + COALESCE(array_length(hh.community_cards2, 1), 0) AS board_n,
           hh.showdown IS NOT NULL AS has_showdown,
           /* The record says which street each action happened on. Read it,
              rather than guessing a flop from how many people put chips in:
              an ordinary multiway preflop pot clears any such count. */
           EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(hh.actions, '[]'::jsonb)) a
                    WHERE lower(COALESCE(a->>'stage', '')) IN ('flop','turn','river')
                       OR lower(COALESCE(a->'publicNode'->>'street', '')) IN ('flop','turn','river'))
             AS played_past_preflop,
           /* "I cannot tell" is its own outcome and must not be filed as
              "ended preflop": a hand with actions, none of which names a
              stage, is an unreadable record and stays a finding. */
           (jsonb_array_length(COALESCE(hh.actions, '[]'::jsonb)) > 0
             AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(hh.actions, '[]'::jsonb)) a
                              WHERE NULLIF(btrim(COALESCE(a->>'stage', '')), '') IS NOT NULL))
             AS streets_unreadable,
           CASE WHEN t.rake_percent >= 0 THEN t.rake_percent
                WHEN c.default_rake_percent >= 0 THEN c.default_rake_percent END AS ov_pct,
           CASE WHEN t.rake_cap_bb >= 0 THEN t.rake_cap_bb
                WHEN c.rake_cap >= 0 THEN c.rake_cap END AS ov_cap_bb,
           c.bbj_rake_enabled,
           hh.hand_number,
           /* A DIAMOND HAND IS NOT PRICED BY THE CHIP SPEC (2026-10-08). A
              Diamond table's rake_percent and rake_cap_bb are explicitly zero
              by rule (DiamondCashBoundary), so the chip spec reads them as a
              0% override; the hand is priced from ca_diamond_economics and
              fn_poker_diamond_settle_cash_hand refuses any other number. */
           COALESCE(c.asset = 'diamonds', false) AS diamond
      FROM public.hand_history hh
      JOIN public.tables t ON t.id = hh.table_id
      LEFT JOIN public.clubs c ON c.id = t.club_id
      LEFT JOIN public.rake_records rr ON rr.hand_id = hh.id
     WHERE hh.created_at > now() - p_window
       AND hh.created_at < now() - interval '5 minutes'
       AND t.tournament_id IS NULL
       AND hh.tournament_id IS NULL
  ), f AS (
    SELECT h.*, e.rake AS exp_rake
      FROM h
      CROSS JOIN LATERAL public.fn_effective_rake(h.bb, h.pot, h.dealt, true, h.sb, h.ov_pct, h.ov_cap_bb, h.seats) e
     WHERE h.board_n >= 3 AND h.dealt IS NOT NULL
       AND NOT h.diamond
  ), fb AS (
    SELECT f.*, public.fn_effective_bbj_drop(f.bb, f.dealt, true, f.club_id, f.tid, f.variant, f.sb, f.pot, f.rake) AS exp_bbj
      FROM f
  ), h0 AS (
    SELECT hh.id, hh.table_id, hh.created_at, hh.pot_size AS pot,
           t.small_blind AS sb, t.big_blind AS bb
      FROM public.hand_history hh
      JOIN public.tables t ON t.id = hh.table_id
     WHERE hh.created_at > now() - p_window
       AND hh.created_at < now() - interval '5 minutes'
       AND t.tournament_id IS NULL
       AND COALESCE(hh.rake_amount, 0) = 0
       AND hh.showdown IS NOT NULL
       AND COALESCE(array_length(hh.community_cards, 1), 0)
             + COALESCE(array_length(hh.community_cards2, 1), 0) < 3
  ), hd AS (
    -- The Diamond rake law is the settler's recompute: the rake this hand
    -- recorded must be the rake its settlement receipt accepted.
    SELECT h.*,
           (SELECT (r.receipt->>'rake')::numeric
              FROM public.poker_diamond_hand_receipts r
             WHERE r.table_id = h.table_id AND r.hand_number = h.hand_number) AS settled_rake
      FROM h
     WHERE h.diamond
  )
  SELECT 'over_spec', id, table_id, created_at, sb, bb, pot, rake, exp_rake
    FROM fb WHERE rake > exp_rake + 0.005
  UNION ALL
  SELECT 'under_spec', id, table_id, created_at, sb, bb, pot, rake, exp_rake
    FROM fb WHERE rake < exp_rake - 0.005
  UNION ALL
  SELECT 'bbj_over_spec', id, table_id, created_at, sb, bb, pot, bbj, exp_bbj
    FROM fb WHERE bbj > exp_bbj + 0.005
  UNION ALL
  SELECT 'bbj_under_spec', id, table_id, created_at, sb, bb, pot, bbj, exp_bbj
    FROM fb WHERE bbj < exp_bbj - 0.005
  UNION ALL
  SELECT 'no_flop_no_drop', id, table_id, created_at, sb, bb, pot, rake, 0::numeric
    FROM h WHERE board_n = 0 AND NOT has_showdown AND rake + bbj > 0.005
     AND NOT diamond
  UNION ALL
  SELECT 'board_not_recorded', id, table_id, created_at, sb, bb, pot, rake, NULL::numeric
    FROM h WHERE board_n = 0 AND (has_showdown OR played_past_preflop OR streets_unreadable)
  UNION ALL
  SELECT 'impossible_showdown', id, table_id, created_at, sb, bb, pot, 0::numeric, NULL::numeric
    FROM h0
  UNION ALL
  SELECT 'players_not_recorded', id, table_id, created_at, sb, bb, pot, rake, NULL::numeric
    FROM h WHERE dealt IS NULL AND board_n >= 3
  UNION ALL
  SELECT 'bbj_club_switch_ignored', id, table_id, created_at, sb, bb, pot, bbj, 0::numeric
    FROM h WHERE bbj_rake_enabled IS FALSE AND bbj > 0.005
  UNION ALL
  SELECT 'diamond_rake_unsettled', id, table_id, created_at, sb, bb, pot, rake, settled_rake
    FROM hd WHERE settled_rake IS DISTINCT FROM rake AND (settled_rake IS NOT NULL OR rake > 0.005);
$function$
