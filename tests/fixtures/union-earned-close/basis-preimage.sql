CREATE OR REPLACE FUNCTION public.fn_union_club_rake_basis(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_live boolean DEFAULT false)
 RETURNS TABLE(club_id uuid, game_type text, rake_in numeric, rate numeric, payout numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sref text;
BEGIN
  IF p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR p_end <= p_start THEN
    RETURN;
  END IF;

  /* THE WITNESS FIRST. A period that has been closed stored the rows it was
     paid from; a statement for that period describes THAT, never a
     recomputation over attribution tables that may since have moved. */
  v_sref := p_union_id::text || ':'
    || to_char(p_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '..'
    || to_char(p_end   at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

  IF EXISTS (SELECT 1 FROM public.ca_settlements s
              WHERE s.settlement_type = 'union_rakeback_close' AND s.union_id = p_union_id
                AND s.state = 'final' AND s.external_ref = v_sref
                AND s.totals ? 'basis_detail') THEN
    RETURN QUERY
      SELECT (d->>'club_id')::uuid, d->>'game_type',
             (d->>'rake_in')::numeric, (d->>'rate')::numeric, (d->>'payout')::numeric
        FROM public.ca_settlements s
        CROSS JOIN LATERAL jsonb_array_elements(s.totals->'basis_detail') d
       WHERE s.settlement_type = 'union_rakeback_close' AND s.union_id = p_union_id
         AND s.state = 'final' AND s.external_ref = v_sref;
    RETURN;
  END IF;

  /* THE SNAPSHOT SECOND (Phase 6 verification, 20260908). An OPEN window is
     served from the hourly snapshot when its start matches and its end is at
     or after the snapshot's 'through' - a reader with an eight-second budget
     gets the same rows the sweep computed within the hour. Round 1 passes
     p_live and never reads this: it computes at close time and stores the
     witness above. */
  IF NOT p_live THEN
    IF EXISTS (SELECT 1 FROM public.union_rake_basis_snapshot s
                WHERE s.union_id = p_union_id AND s.period_start = p_start
                  AND p_end >= s.through AND p_end <= s.period_end
                  AND s.computed_at > now() - interval '3 hours') THEN
      RETURN QUERY
        SELECT (d->>'club_id')::uuid, d->>'game_type',
               (d->>'rake_in')::numeric, (d->>'rate')::numeric, (d->>'payout')::numeric
          FROM public.union_rake_basis_snapshot s
          CROSS JOIN LATERAL jsonb_array_elements(s.detail) d
         WHERE s.union_id = p_union_id AND s.period_start = p_start
           AND p_end >= s.through AND p_end <= s.period_end
           AND s.computed_at > now() - interval '3 hours';
      RETURN;
    END IF;
  END IF;

  /* THE BASIS (Dan, 2026-09-03): each member club's share is the rake ITS
     PLAYERS generated at the union's tables - cash from
     ca_union_rake_attribution (the seat the player sat through, captured
     hourly), tournaments / SNGs / spins from tournament_players (each
     treasury credit that names a tournament, split by entries: 1 + rebuys +
     add-on). The union's own house club and anything unattributed stay
     with the union.

     THE RATE (Dan, 2026-09-03): resolved per game type per club, falling back
     to club_commission_rate and then to 0.90. Truncated to the cent per
     (club, game type) so a remainder stays with the union.

     Same arithmetic as the block round 1 paid from between 20260903 and
     20260907 (proven row-identical below); the tournament split now groups
     the credits per tournament BEFORE joining tournaments and
     tournament_players, which is the same sum in far fewer rows. */
  RETURN QUERY
  WITH raw AS (
    SELECT t.amount,
           substring(t.notes from '\[tournament ([0-9a-f-]+)\]')::uuid AS tournament_id
      FROM public.union_wallet_transactions t
     WHERE t.union_id = p_union_id
       AND t.wallet = 'rake_wallet' AND t.direction = 'credit' AND t.tx_type = 'rake'
       AND t.created_at >= p_start AND t.created_at < p_end
  ), tsum AS (
    SELECT r.tournament_id, sum(r.amount) AS amt
      FROM raw r WHERE r.tournament_id IS NOT NULL GROUP BY r.tournament_id
  ), tgame AS (
    SELECT s.tournament_id, s.amt, COALESCE(lower(tr.tournament_type), 'other') AS game_type
      FROM tsum s LEFT JOIN public.tournaments tr ON tr.id = s.tournament_id
  ), cash AS (
    SELECT a.club_id, 'cash'::text AS game_type, sum(a.rake_share) AS rake
      FROM public.ca_union_rake_attribution a
     WHERE a.union_id = p_union_id
       AND a.played_at >= p_start AND a.played_at < p_end
       AND a.club_id IS NOT NULL
     GROUP BY a.club_id
  ), tw AS (
    SELECT tp.tournament_id, tp.club_id,
           sum(1 + COALESCE(tp.rebuys, 0) + CASE WHEN tp.add_on THEN 1 ELSE 0 END)::numeric AS w
      FROM public.tournament_players tp
      JOIN tsum s ON s.tournament_id = tp.tournament_id
     GROUP BY tp.tournament_id, tp.club_id
  ), tt AS (
    SELECT tw.tournament_id, sum(tw.w) AS total FROM tw GROUP BY tw.tournament_id
  ), tourney AS (
    SELECT tw.club_id, g.game_type, sum(g.amt * tw.w / NULLIF(tt.total, 0)) AS rake
      FROM tgame g
      JOIN tw ON tw.tournament_id = g.tournament_id
      JOIN tt ON tt.tournament_id = g.tournament_id
     WHERE tw.club_id IS NOT NULL
     GROUP BY tw.club_id, g.game_type
  ), basis AS (
    SELECT x.club_id, x.game_type, sum(x.rake) AS rake_in FROM (
      SELECT cash.club_id, cash.game_type, cash.rake FROM cash
      UNION ALL
      SELECT tourney.club_id, tourney.game_type, tourney.rake FROM tourney) x
     GROUP BY x.club_id, x.game_type
  )
  SELECT b.club_id,
         b.game_type,
         round(b.rake_in, 2) AS rake_in,
         COALESCE(
           CASE b.game_type
             WHEN 'cash'      THEN uc.rate_cash
             WHEN 'mtt'       THEN uc.rate_mtt
             WHEN 'sng'       THEN uc.rate_sng
             WHEN 'spin'      THEN uc.rate_spin
             WHEN 'satellite' THEN uc.rate_satellite
             ELSE NULL
           END,
           uc.club_commission_rate,
           0.90) AS rate,
         trunc(round(b.rake_in, 2)
               * COALESCE(
                   CASE b.game_type
                     WHEN 'cash'      THEN uc.rate_cash
                     WHEN 'mtt'       THEN uc.rate_mtt
                     WHEN 'sng'       THEN uc.rate_sng
                     WHEN 'spin'      THEN uc.rate_spin
                     WHEN 'satellite' THEN uc.rate_satellite
                     ELSE NULL
                   END,
                   uc.club_commission_rate,
                   0.90)
               * 100) / 100 AS payout
    FROM basis b
    JOIN public.union_clubs uc ON uc.union_id = p_union_id AND uc.club_id = b.club_id
   WHERE b.club_id <> p_union_id;
END;
$function$

