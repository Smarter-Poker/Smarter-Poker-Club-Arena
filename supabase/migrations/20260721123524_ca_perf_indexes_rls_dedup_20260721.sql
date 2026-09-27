-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260721123524 "ca_perf_indexes_rls_dedup_20260721"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 19c7ffc35bcb143e550749d5796b7426 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE INDEX IF NOT EXISTS idx_agent_commissions_club_id ON public.agent_commissions (club_id);
CREATE INDEX IF NOT EXISTS idx_club_members_agent_id ON public.club_members (agent_id);
CREATE INDEX IF NOT EXISTS idx_club_wallet_transactions_club_id ON public.club_wallet_transactions (club_id);
CREATE INDEX IF NOT EXISTS idx_hand_players_hand_id ON public.hand_players (hand_id);
CREATE INDEX IF NOT EXISTS idx_hand_players_user_id ON public.hand_players (user_id);
CREATE INDEX IF NOT EXISTS idx_rake_records_club_id ON public.rake_records (club_id);
CREATE INDEX IF NOT EXISTS idx_rake_records_table_id ON public.rake_records (table_id);
CREATE INDEX IF NOT EXISTS idx_tables_club_id ON public.tables (club_id);
CREATE INDEX IF NOT EXISTS idx_tables_union_id ON public.tables (union_id);
CREATE INDEX IF NOT EXISTS idx_union_wallet_transactions_club_id ON public.union_wallet_transactions (club_id);

DROP POLICY IF EXISTS seven_deuce_bounties_select ON public.seven_deuce_bounties;
CREATE POLICY seven_deuce_bounties_select ON public.seven_deuce_bounties
  FOR SELECT TO public
  USING (
    EXISTS (
      SELECT 1 FROM club_members cm
      WHERE cm.club_id = seven_deuce_bounties.club_id
        AND cm.user_id = (SELECT auth.uid())
    )
  );

DROP INDEX IF EXISTS public.idx_single_pending_cashout;

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_indexes WHERE schemaname='public'
      AND indexname='idx_single_pending_cashout') <> 0 THEN
    RAISE EXCEPTION 'duplicate cashout index still present';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public'
      AND tablename='seven_deuce_bounties' AND qual LIKE '%( SELECT auth.uid()%') <> 1 THEN
    RAISE EXCEPTION 'seven_deuce_bounties policy not rewritten';
  END IF;
  IF (SELECT count(*) FROM pg_indexes WHERE schemaname='public'
      AND indexname IN (
        'idx_agent_commissions_club_id','idx_club_members_agent_id',
        'idx_club_wallet_transactions_club_id','idx_hand_players_hand_id',
        'idx_hand_players_user_id','idx_rake_records_club_id',
        'idx_rake_records_table_id','idx_tables_club_id',
        'idx_tables_union_id','idx_union_wallet_transactions_club_id')) <> 10 THEN
    RAISE EXCEPTION 'not all 10 FK covering indexes present';
  END IF;
END $$;
