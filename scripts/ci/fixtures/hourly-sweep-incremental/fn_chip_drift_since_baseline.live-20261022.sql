CREATE OR REPLACE FUNCTION public.fn_chip_drift_since_baseline()
 RETURNS TABLE(club_id uuid, user_id uuid, opening_balance numeric, movements_since numeric, expected numeric, actual numeric, drift numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH span AS (SELECT MIN(taken_at) AS t0 FROM public.ca_chip_baseline),
  /* EVERY SIDE OF A LEG IS ITS OWN MOVEMENT (2026-10-03). A leg moves chips
     out of its from side and into its to side, and each side is counted for
     the member it names. The reading this replaces grouped a leg under ONE
     player - the to side when it was a player_wallet - and summed both sides
     there, so a leg between two player wallets (rakeback and commission paid
     wallet to wallet since 2026-09-29: 1,905 legs, 1,022,959.37 chips) netted
     to zero for the receiver and never reached the payer. 670 members read
     as drifting by 645,215.28 in all and exactly 0.00 net, worst -103,747.97,
     every chip of it accounted for in the journal. */
  sides AS (
    SELECT cl.club_id AS c_id, cl.to_entity_id AS u_id, cl.amount AS amt
      FROM public.chip_ledger cl, span
     WHERE cl.club_id IS NOT NULL
       AND cl.created_at >= span.t0
       AND cl.to_type = 'player_wallet'
    UNION ALL
    SELECT cl.club_id, cl.from_entity_id, -cl.amount
      FROM public.chip_ledger cl, span
     WHERE cl.club_id IS NOT NULL
       AND cl.created_at >= span.t0
       AND cl.from_type = 'player_wallet'
  ),
  moves AS (
    SELECT s.c_id, s.u_id, sum(s.amt) AS net
      FROM sides s
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
$function$;
