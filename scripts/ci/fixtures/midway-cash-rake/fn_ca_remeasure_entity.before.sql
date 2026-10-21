CREATE OR REPLACE FUNCTION public.fn_ca_remeasure_entity(p_entity_type text, p_entity_id uuid)
 RETURNS TABLE(measurable boolean, ledger_balance numeric, stored_balance numeric, severity text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  /* THREE OUTCOMES, NEVER TWO (CLAUDE.md 10.86 rule 1). "I cannot measure
     this entity type" is its own answer and must never be dressed up as
     'ok' - that would silence a real critical - nor as 'critical', which
     is the bug this function exists to stop. */
  IF p_entity_type = 'club_treasury' AND p_entity_id IS NOT NULL THEN
    RETURN QUERY
      SELECT true, p.ledger_balance, p.stored_balance, p.severity
        FROM public.fn_ca_treasury_positions() p
       WHERE p.club_id = p_entity_id;

    IF FOUND THEN
      RETURN;
    END IF;

    -- Absent from the merged set means no stored treasury AND no flow since
    -- the cutover. That is a measurement of zero, not a failure to measure.
    RETURN QUERY SELECT true, 0::numeric, 0::numeric, 'ok'::text;
    RETURN;
  END IF;

  /* A DIAMOND RAKE FINDING IS MEASURED AGAIN (2026-10-09): on a Diamond cash
     table the rake law is the settler's recompute, so measure every hand of
     the last 48 hours the way fn_rake_law_violations does (recorded rake
     against the rake its receipt accepted). ledger_balance is the accepted
     rake, stored_balance the recorded rake. */
  IF p_entity_type = 'rake_law' AND p_entity_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id = t.club_id
                  WHERE t.id = p_entity_id AND t.tournament_id IS NULL AND c.asset = 'diamonds') THEN
    RETURN QUERY
      WITH hd AS (
        SELECT COALESCE(hh.rake_amount, 0) AS rake,
               (SELECT (r.receipt->>'rake')::numeric
                  FROM public.poker_diamond_hand_receipts r
                 WHERE r.table_id = hh.table_id AND r.hand_number = hh.hand_number) AS settled_rake
          FROM public.hand_history hh
         WHERE hh.table_id = p_entity_id
           AND hh.tournament_id IS NULL
           AND hh.created_at > now() - interval '48 hours'
           AND hh.created_at < now() - interval '5 minutes'
      )
      SELECT true,
             COALESCE(sum(hd.settled_rake), 0),
             COALESCE(sum(hd.rake), 0),
             CASE WHEN bool_or(hd.settled_rake IS DISTINCT FROM hd.rake
                               AND (hd.settled_rake IS NOT NULL OR hd.rake > 0.005))
                  THEN 'critical' ELSE 'ok' END
        FROM hd;
    RETURN;
  END IF;

  /* A CHIP RAKE FINDING IS MEASURED AGAIN (2026-10-16). On a chip cash table
     the rake law is fn_effective_rake and fn_effective_bbj_drop, priced with
     the number of players dealt in, so measure every flopped hand of the last
     36 hours (the escalator's lookback) exactly the way fn_rake_law_violations
     does. Without this branch every chip rake_law finding was "could not
     tell" and the hourly escalator re-filed it for 36 hours after the cause
     was fixed: the Lightning pilot's 2026-10-15 storm recurred every hour.
     ledger_balance is the rake and drop the law allows, stored_balance the
     rake and drop the hands recorded. A flopped hand with no dealt count is
     unreadable, and unreadable is a finding, never ok. */
  IF p_entity_type = 'rake_law' AND p_entity_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.tables t LEFT JOIN public.clubs c ON c.id = t.club_id
                  WHERE t.id = p_entity_id AND t.tournament_id IS NULL
                    AND COALESCE(c.asset = 'diamonds', false) = false) THEN
    RETURN QUERY
      WITH h AS (
        SELECT hh.pot_size AS pot,
               COALESCE(hh.rake_amount, 0) AS rake,
               COALESCE(rr.bbj_contribution, hh.bbj_amount, 0) AS bbj,
               t.small_blind AS sb, t.big_blind AS bb, t.club_id, t.id AS tid,
               t.max_players AS seats,
               lower(COALESCE(hh.game_variant, t.game_variant::text)) AS variant,
               GREATEST(rr.num_players, jsonb_array_length(CASE WHEN jsonb_typeof(hh.players) = 'array' THEN hh.players END)) AS dealt,
               CASE WHEN t.rake_percent >= 0 THEN t.rake_percent
                    WHEN c.default_rake_percent >= 0 THEN c.default_rake_percent END AS ov_pct,
               CASE WHEN t.rake_cap_bb >= 0 THEN t.rake_cap_bb
                    WHEN c.rake_cap >= 0 THEN c.rake_cap END AS ov_cap_bb
          FROM public.hand_history hh
          JOIN public.tables t ON t.id = hh.table_id
          LEFT JOIN public.clubs c ON c.id = t.club_id
          LEFT JOIN public.rake_records rr ON rr.hand_id = hh.id
         WHERE hh.table_id = p_entity_id
           AND hh.tournament_id IS NULL
           AND hh.created_at > now() - interval '36 hours'
           AND hh.created_at < now() - interval '5 minutes'
           AND COALESCE(array_length(hh.community_cards, 1), 0)
                 + COALESCE(array_length(hh.community_cards2, 1), 0) >= 3
      ), f AS (
        SELECT h.*, e.rake AS exp_rake
          FROM h
          LEFT JOIN LATERAL public.fn_effective_rake(h.bb, h.pot, h.dealt, true, h.sb, h.ov_pct, h.ov_cap_bb, h.seats) e
            ON h.dealt IS NOT NULL
      ), fb AS (
        SELECT f.*,
               CASE WHEN f.dealt IS NOT NULL
                    THEN public.fn_effective_bbj_drop(f.bb, f.dealt, true, f.club_id, f.tid, f.variant, f.sb, f.pot, f.rake)
               END AS exp_bbj
          FROM f
      )
      SELECT true,
             COALESCE(sum(fb.exp_rake + fb.exp_bbj), 0),
             COALESCE(sum(fb.rake + fb.bbj), 0),
             CASE WHEN bool_or(fb.dealt IS NULL
                               OR abs(fb.rake - fb.exp_rake) > 0.005
                               OR abs(fb.bbj - fb.exp_bbj) > 0.005)
                  THEN 'critical' ELSE 'ok' END
        FROM fb;
    RETURN;
  END IF;

  RETURN QUERY SELECT false, NULL::numeric, NULL::numeric, NULL::text;
END;
$function$
