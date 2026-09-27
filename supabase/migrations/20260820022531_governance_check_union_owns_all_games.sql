-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820022531 "governance_check_union_owns_all_games"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b123622a23eb41e2384b1d7cefe6cf5b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Extend the weekly governance check with Dan's rule: every live union game,
-- of every type, is owned BY the union — not by whichever member club created
-- it. Covers cash, MTT, SNG and Spin in one predicate, since all four live in
-- the same two tables.
CREATE OR REPLACE FUNCTION fn_union_governance_check()
RETURNS TABLE (invariant text, severity text, offenders bigint, detail text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT 'club_owned_cash_table_in_union', 'critical', count(*),
         'Open cash tables under a union club with no union_id and not private'
    FROM tables t JOIN union_clubs uc ON uc.club_id = t.club_id
   WHERE t.union_id IS NULL AND COALESCE(t.is_private,false) = false
     AND t.tournament_id IS NULL AND COALESCE(t.is_deleted,false) = false
     AND t.status NOT IN ('closed','deleted')
  HAVING count(*) > 0

  UNION ALL
  SELECT 'club_owned_tournament_in_union', 'critical', count(*),
         'Live non-private tournaments under a union club with no union_id'
    FROM tournaments t JOIN union_clubs uc ON uc.club_id = t.club_id
   WHERE t.union_id IS NULL AND COALESCE(t.is_private,false) = false
     AND t.status IN ('ANNOUNCED','SCHEDULED','REGISTERING','LATE_REG','RUNNING')
  HAVING count(*) > 0

  UNION ALL
  -- Dan 2026-08-19: all game types must be created BY the union.
  SELECT 'union_game_not_owned_by_union', 'critical', count(*),
         'Live union games whose club_id names a member club instead of the union '
         || '(cash/MTT/SNG/Spin)'
    FROM (
      SELECT id FROM tables
       WHERE union_id IS NOT NULL AND COALESCE(is_private,false) = false
         AND club_id IS DISTINCT FROM union_id
         AND COALESCE(is_deleted,false) = false AND status NOT IN ('closed','deleted')
      UNION ALL
      SELECT id FROM tournaments
       WHERE union_id IS NOT NULL AND COALESCE(is_private,false) = false
         AND club_id IS DISTINCT FROM union_id
         AND status IN ('ANNOUNCED','SCHEDULED','REGISTERING','LATE_REG','RUNNING')
    ) x
  HAVING count(*) > 0

  UNION ALL
  -- Dan 2026-08-19: both clubs must remain in the union.
  SELECT 'union_lost_a_member_club', 'critical', count(*),
         'Clubs expected in Midway Union that are no longer members'
    FROM (
      SELECT c.id FROM clubs c
       WHERE c.id IN ('a0000000-0000-0000-0000-000000000001',
                      'a41434bb-8d0c-400a-8f0d-e8b3d65afed4')
         AND NOT EXISTS (SELECT 1 FROM union_clubs uc
                          WHERE uc.club_id = c.id
                            AND uc.union_id = 'fade0000-0000-0000-0000-000000000001')
    ) m
  HAVING count(*) > 0

  UNION ALL
  SELECT 'clubs_union_id_mirror_drift', 'critical', count(*),
         'clubs.union_id disagrees with union_clubs'
    FROM union_clubs uc JOIN clubs c ON c.id = uc.club_id
   WHERE c.union_id IS DISTINCT FROM uc.union_id
  HAVING count(*) > 0

  UNION ALL
  SELECT 'private_game_union_visible', 'critical', count(*),
         'Rows flagged private that still carry a union_id'
    FROM (
      SELECT id FROM tables WHERE COALESCE(is_private,false) AND union_id IS NOT NULL
      UNION ALL
      SELECT id FROM tournaments WHERE COALESCE(is_private,false) AND union_id IS NOT NULL
    ) x
  HAVING count(*) > 0

  UNION ALL
  SELECT 'ownership_triggers_missing', 'critical', 5 - count(*),
         'Expected 5 union ownership/mirror triggers'
    FROM pg_trigger
   WHERE tgname IN ('trg_tables_union_ownership','trg_tournaments_union_ownership',
                    'trg_union_clubs_sync_mirror','trg_tables_union_ownership_upd',
                    'trg_tournaments_union_ownership_upd')
  HAVING count(*) < 5

  UNION ALL
  SELECT 'tables_rls_not_private_aware', 'critical', 1,
         'tables SELECT policy no longer considers is_private'
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_policy
      WHERE polrelid = 'public.tables'::regclass AND polcmd = 'r'
        AND pg_get_expr(polqual, polrelid) LIKE '%is_private%')

  UNION ALL
  SELECT 'union_clubs_unreadable_by_members', 'critical', 1,
         'A club member can no longer discover their own union (union_clubs RLS)'
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_policy
      WHERE polrelid = 'public.union_clubs'::regclass AND polcmd = 'r'
        AND pg_get_expr(polqual, polrelid) LIKE '%club_members%')

  UNION ALL
  SELECT 'union_rake_wallet_stale', 'warning', count(*),
         'Union rake wallets holding a balance with no rakeback in 14 days'
    FROM union_wallets uw
   WHERE uw.rake_wallet > 0
     AND NOT EXISTS (
       SELECT 1 FROM union_wallet_transactions t
        WHERE t.union_id = uw.union_id AND t.wallet = 'rake_wallet'
          AND t.direction = 'debit' AND t.created_at > now() - interval '14 days')
  HAVING count(*) > 0

  UNION ALL
  SELECT 'settlement_needs_review', 'warning', count(*),
         'Player P&L periods parked for review and never re-settled'
    FROM union_pnl_settlements WHERE status = 'needs_review'
  HAVING count(*) > 0;
$$;

REVOKE ALL ON FUNCTION fn_union_governance_check() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_union_governance_check() TO service_role;

DO $$
DECLARE v_crit int;
BEGIN
  SELECT count(*) INTO v_crit FROM fn_union_governance_check() WHERE severity = 'critical';
  IF v_crit > 0 THEN
    RAISE EXCEPTION 'ASSERTION FAILED: % critical union invariant(s) broken', v_crit;
  END IF;
END $$;
