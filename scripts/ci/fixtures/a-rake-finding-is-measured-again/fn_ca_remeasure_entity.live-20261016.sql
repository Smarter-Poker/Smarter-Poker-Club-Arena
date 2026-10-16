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

  RETURN QUERY SELECT false, NULL::numeric, NULL::numeric, NULL::text;
END;
$function$
