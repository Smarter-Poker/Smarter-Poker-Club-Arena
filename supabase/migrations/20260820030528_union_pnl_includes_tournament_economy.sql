-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820030528 "union_pnl_includes_tournament_economy"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 7718da381640ad3374cb5da23552fe9f of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- TOURNAMENTS ARE THE SAME ECONOMY AS CASH (2026-08-19)
--
-- Dan: "tournaments, sit n go's and spins are the same thing, players buy in,
-- rake is taken, and users get paid out if they finish in the money... the same
-- cash game chips are used to buy into MTT, sit n go and spins."
--
-- That is the missing piece behind the residual I could not explain. The P&L
-- counted ONLY cash flows: category 'buyin' / 'cashout', scoped by table_id.
-- Tournament money moves through the SAME wallet but different categories and
-- a different key:
--
--     cash buy-in        debit  'buyin'             -> table_id
--     tournament buy-in  debit  'tournament_buyin'  -> related_entity_id (tournament)
--     prize / bounty     credit 'prize' | 'bounty'  -> related_entity_id (tournament)
--     cash-out           credit 'cashout'           -> table_id
--
-- (Verified on live rows: 63/63 tournament buy-ins and 9/9 prizes carry
-- related_entity_id and no table_id; 68/68 cash buy-ins carry table_id.)
--
-- So every entry fee a player paid was invisible, while nothing offset it —
-- which is exactly the shape of the leak: players appeared to WIN chips that
-- were really just their unreturned tournament stakes.
--
-- Both halves now cover both economies:
--   * P&L counts cash AND tournament flows.
--   * The rake basis counts cash rake AND tournament fees. Tournament rake is
--     the per-entry fee, so it is taken exactly from tournament_players x
--     buy_in_fee rather than inferred — cheaper and more accurate than trying
--     to read it out of pot contributions.
--
-- Seated stacks remain CASH ONLY. A live tournament stack is scrip; the
-- player's entry fee is already booked as a loss and their prize will be
-- booked as a gain when it pays, so counting the scrip too would double-count.
-- A tournament still running at the period boundary therefore reads as a loss
-- until it pays out — a timing effect that self-corrects next period, not an
-- error.
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_wallet_tx_entity_cat_created
  ON wallet_transactions (related_entity_id, category, created_at)
  WHERE related_entity_id IS NOT NULL;

CREATE OR REPLACE FUNCTION fn_union_pnl_all_clubs(
  p_union_id uuid, p_start timestamptz, p_end timestamptz,
  p_include_horses boolean DEFAULT true
) RETURNS TABLE (
  club_id uuid, buyins numeric, cashouts numeric, realized_net numeric,
  winnings numeric, losses numeric, players int, seated_stack numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH attributed AS (
    SELECT DISTINCT ON (cm.user_id) cm.user_id, cm.club_id
      FROM club_members cm
      JOIN union_clubs uc ON uc.club_id = cm.club_id AND uc.union_id = p_union_id
      JOIN profiles p ON p.id = cm.user_id
     WHERE p_include_horses OR COALESCE(p.is_horse, false) = false
     ORDER BY cm.user_id, cm.joined_at ASC NULLS LAST, cm.club_id
  ),
  union_tables AS (
    SELECT id FROM tables WHERE union_id = p_union_id AND tournament_id IS NULL
  ),
  union_tourneys AS (
    SELECT id FROM tournaments WHERE union_id = p_union_id
  ),
  -- Cash: keyed by table. Tournament: keyed by the tournament entity.
  wallet_flows AS (
    SELECT a.club_id, wt.user_id,
           SUM(CASE WHEN wt.type = 'debit'  THEN wt.amount ELSE 0 END) AS buyins,
           SUM(CASE WHEN wt.type = 'credit' THEN wt.amount ELSE 0 END) AS cashouts
      FROM wallet_transactions wt
      JOIN attributed a ON a.user_id = wt.user_id
     WHERE wt.created_at >= p_start AND wt.created_at < p_end
       AND (
         (wt.category IN ('buyin','cashout')
            AND wt.table_id IN (SELECT id FROM union_tables))
         OR
         (wt.category IN ('tournament_buyin','prize','bounty')
            AND wt.related_entity_id IN (SELECT id FROM union_tourneys))
       )
     GROUP BY a.club_id, wt.user_id
  ),
  chip_flows AS (
    SELECT a.club_id, ct.to_user_id AS user_id, SUM(ct.amount) AS cashouts
      FROM chip_transactions ct
      JOIN union_tables ut ON ut.id = ct.table_id
      JOIN attributed a ON a.user_id = ct.to_user_id
     WHERE ct.transaction_type = 'cashout'
       AND ct.created_at >= p_start AND ct.created_at < p_end
     GROUP BY a.club_id, ct.to_user_id
  ),
  flows AS (
    SELECT COALESCE(w.club_id, c.club_id) AS club_id,
           COALESCE(w.user_id, c.user_id) AS user_id,
           COALESCE(w.buyins, 0) AS buyins,
           COALESCE(w.cashouts, 0) + COALESCE(c.cashouts, 0) AS cashouts
      FROM wallet_flows w
      FULL OUTER JOIN chip_flows c ON c.user_id = w.user_id AND c.club_id = w.club_id
  ),
  per_club AS (
    SELECT f.club_id, SUM(f.buyins) AS buyins, SUM(f.cashouts) AS cashouts,
           SUM(GREATEST(f.cashouts - f.buyins, 0)) AS winnings,
           SUM(GREATEST(f.buyins - f.cashouts, 0)) AS losses,
           COUNT(*)::int AS players
      FROM flows f GROUP BY f.club_id
  ),
  seated AS (
    SELECT a.club_id, SUM(ts.stack) AS seated_stack
      FROM table_seats ts
      JOIN union_tables ut ON ut.id = ts.table_id
      JOIN attributed a ON a.user_id = ts.user_id
     WHERE ts.left_at IS NULL
     GROUP BY a.club_id
  )
  SELECT uc.club_id,
         COALESCE(pc.buyins, 0), COALESCE(pc.cashouts, 0),
         COALESCE(pc.cashouts, 0) - COALESCE(pc.buyins, 0),
         COALESCE(pc.winnings, 0), COALESCE(pc.losses, 0),
         COALESCE(pc.players, 0), COALESCE(s.seated_stack, 0)
    FROM union_clubs uc
    LEFT JOIN per_club pc ON pc.club_id = uc.club_id
    LEFT JOIN seated s ON s.club_id = uc.club_id
   WHERE uc.union_id = p_union_id;
$$;

REVOKE ALL ON FUNCTION fn_union_pnl_all_clubs(uuid, timestamptz, timestamptz, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_union_pnl_all_clubs(uuid, timestamptz, timestamptz, boolean) TO service_role;

-- ── Rake basis: cash rake + tournament entry fees ───────────────────────────
CREATE OR REPLACE FUNCTION fn_union_rake_basis_by_club(
  p_union_id uuid, p_start timestamptz, p_end timestamptz
) RETURNS TABLE (club_id uuid, rake_share numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH attributed AS (
    SELECT DISTINCT ON (cm.user_id) cm.user_id, cm.club_id
      FROM club_members cm
      JOIN union_clubs uc ON uc.club_id = cm.club_id AND uc.union_id = p_union_id
     ORDER BY cm.user_id, cm.joined_at ASC NULLS LAST, cm.club_id
  ),
  ut AS (SELECT id FROM tables WHERE union_id = p_union_id AND tournament_id IS NULL),
  -- Cash rake, weighted by each player's contribution to the pot.
  cash AS (
    SELECT a.club_id, SUM(r.rake_amount * (e.value::numeric) / c.total) AS rake
      FROM rake_records r
      JOIN ut ON ut.id = r.table_id
      CROSS JOIN LATERAL (
        SELECT SUM(t.value::numeric) AS total
          FROM jsonb_each_text(r.player_contributions) AS t(key, value)
      ) c
      CROSS JOIN LATERAL jsonb_each_text(r.player_contributions) AS e(key, value)
      JOIN attributed a ON a.user_id = (e.key)::uuid
     WHERE r.created_at >= p_start AND r.created_at < p_end
       AND r.player_contributions IS NOT NULL AND r.rake_amount > 0
       AND c.total > 0
     GROUP BY a.club_id
  ),
  -- Tournament rake is the entry fee, charged once per registration. Exact,
  -- and far cheaper than trying to infer it from pot contributions.
  tourney AS (
    SELECT a.club_id, SUM(COALESCE(t.buy_in_fee, 0)) AS rake
      FROM tournament_players tp
      JOIN tournaments t ON t.id = tp.tournament_id AND t.union_id = p_union_id
      JOIN attributed a ON a.user_id = tp.user_id
     WHERE tp.registered_at >= p_start AND tp.registered_at < p_end
     GROUP BY a.club_id
  )
  SELECT club_id, round(SUM(rake), 2) AS rake_share
    FROM (SELECT club_id, rake FROM cash
          UNION ALL
          SELECT club_id, rake FROM tourney) x
   GROUP BY club_id;
$$;

REVOKE ALL ON FUNCTION fn_union_rake_basis_by_club(uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_union_rake_basis_by_club(uuid, timestamptz, timestamptz) TO service_role;

-- Re-baseline on the corrected definition.
DO $$
DECLARE u record;
BEGIN
  FOR u IN SELECT id FROM unions LOOP
    PERFORM fn_union_pnl_bootstrap(u.id);
  END LOOP;
END $$;
