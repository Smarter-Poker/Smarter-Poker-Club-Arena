CREATE OR REPLACE FUNCTION public.fn_chip_drift_since_baseline()
 RETURNS TABLE(club_id uuid, user_id uuid, opening_balance numeric, movements_since numeric, expected numeric, actual numeric, drift numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH span AS (SELECT MIN(taken_at) AS t0 FROM public.ca_chip_baseline),
  moves AS (
    SELECT cl.club_id AS c_id,
           /* The player is whichever side is typed player_wallet. Never a
              coalesce: both sides are populated now. */
           CASE WHEN cl.to_type = 'player_wallet' THEN cl.to_entity_id
                ELSE cl.from_entity_id END AS u_id,
           SUM(CASE WHEN cl.to_type   = 'player_wallet' THEN cl.amount ELSE 0 END)
         - SUM(CASE WHEN cl.from_type = 'player_wallet' THEN cl.amount ELSE 0 END) AS net
    FROM public.chip_ledger cl, span
    WHERE cl.club_id IS NOT NULL
      AND cl.created_at >= span.t0
      AND (cl.to_type = 'player_wallet' OR cl.from_type = 'player_wallet')
    GROUP BY 1, 2
  )
  SELECT b.club_id, b.user_id, b.opening_balance,
         COALESCE(m.net, 0)                              AS movements_since,
         b.opening_balance + COALESCE(m.net, 0)          AS expected,
         COALESCE(cm.chip_balance, 0)                    AS actual,
         COALESCE(cm.chip_balance, 0) - (b.opening_balance + COALESCE(m.net, 0)) AS drift
  FROM public.ca_chip_baseline b
  JOIN public.club_members cm
    ON cm.club_id = b.club_id AND cm.user_id = b.user_id
  LEFT JOIN moves m
    ON m.c_id = b.club_id AND m.u_id = b.user_id;
$function$
