-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819233814 "union_governance_invariant_check"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 a0756c41ee03297d30030ab06f75eed4 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- UNION GOVERNANCE INVARIANT CHECK (2026-08-19)
--
-- Everything this project enforces has been verified BY HAND, repeatedly, with
-- ad-hoc SQL. That does not survive contact with a busy repo: the failure mode
-- for all of it is silent data drift, not a build error, so a code-level CI
-- gate cannot see it either.
--
-- These are the invariants, expressed once, runnable anywhere, cheap enough to
-- run weekly. The settlement job calls it and alerts on any violation.
--
-- Each row returned is a BROKEN invariant. An empty result is a healthy system.
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_union_governance_check()
RETURNS TABLE (invariant text, severity text, offenders bigint, detail text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  -- 1. THE HARD RULE: a club inside a union must not own union-visible cash
  --    games. Anything non-private under a union club must carry union_id.
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
  -- 2. The denormalized mirror must never drift from union_clubs. This is the
  --    exact bug that sent one club's rake to its own treasury for months.
  SELECT 'clubs_union_id_mirror_drift', 'critical', count(*),
         'clubs.union_id disagrees with union_clubs'
    FROM union_clubs uc JOIN clubs c ON c.id = uc.club_id
   WHERE c.union_id IS DISTINCT FROM uc.union_id
  HAVING count(*) > 0

  UNION ALL
  -- 3. Private games are club-only by definition; a union_id on one makes it
  --    union-visible, which is the thing private is supposed to prevent.
  SELECT 'private_game_union_visible', 'critical', count(*),
         'Rows flagged private that still carry a union_id'
    FROM (
      SELECT id FROM tables WHERE COALESCE(is_private,false) AND union_id IS NOT NULL
      UNION ALL
      SELECT id FROM tournaments WHERE COALESCE(is_private,false) AND union_id IS NOT NULL
    ) x
  HAVING count(*) > 0

  UNION ALL
  -- 4. Enforcement must actually be installed. Triggers get dropped by
  --    well-meaning migrations; this notices.
  SELECT 'ownership_triggers_missing', 'critical',
         5 - count(*), 'Expected 5 union ownership/mirror triggers'
    FROM pg_trigger
   WHERE tgname IN ('trg_tables_union_ownership','trg_tournaments_union_ownership',
                    'trg_union_clubs_sync_mirror','trg_tables_union_ownership_upd',
                    'trg_tournaments_union_ownership_upd')
  HAVING count(*) < 5

  UNION ALL
  -- 5. RLS must still hide private games. It was USING(true) once.
  SELECT 'tables_rls_not_private_aware', 'critical', 1,
         'tables SELECT policy no longer considers is_private'
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_policy
      WHERE polrelid = 'public.tables'::regclass AND polcmd = 'r'
        AND pg_get_expr(polqual, polrelid) LIKE '%is_private%')

  UNION ALL
  -- 6. Rake must not silently pile up unpaid. The weekly rakeback read a dead
  --    column for months and never paid a club while this number grew.
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
  -- 7. A settlement parked for review is not self-healing; someone must look.
  SELECT 'settlement_needs_review', 'warning', count(*),
         'Player P&L periods parked for review and never re-settled'
    FROM union_pnl_settlements
   WHERE status = 'needs_review'
  HAVING count(*) > 0;
$$;

REVOKE ALL ON FUNCTION fn_union_governance_check() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_union_governance_check() TO service_role;

-- The system must be healthy right now, or this whole project is not done.
DO $$
DECLARE v_crit int;
BEGIN
  SELECT count(*) INTO v_crit FROM fn_union_governance_check() WHERE severity = 'critical';
  IF v_crit > 0 THEN
    RAISE EXCEPTION 'ASSERTION FAILED: % critical union governance invariant(s) broken', v_crit;
  END IF;
END $$;
