-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260415175516 as "create_missing_tables_bugs_013_014_015_v2"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
-- BUGs 014 + 015 — create 3 missing tables (bbj_payouts, bbj_payout_recipients, tournament_bounties)
-- BUG 013 (union_transactions) fixed at code level separately by redirecting writes to union_wallet_transactions.

CREATE TABLE IF NOT EXISTS public.bbj_payouts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id          uuid NOT NULL REFERENCES public.bbj_pools(id) ON DELETE RESTRICT,
  hand_id          uuid,
  table_id         uuid NOT NULL,
  hand_number      bigint,
  winner_user_id   uuid NOT NULL,
  loser_user_id    uuid NOT NULL,
  total_amount     numeric(20,2) NOT NULL,
  winner_share     numeric(20,2) NOT NULL,
  loser_share      numeric(20,2) NOT NULL,
  table_share      numeric(20,2) NOT NULL,
  table_player_count integer NOT NULL,
  metadata         jsonb,
  created_at       timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bbj_payouts_pool ON public.bbj_payouts(pool_id);
CREATE INDEX IF NOT EXISTS idx_bbj_payouts_winner ON public.bbj_payouts(winner_user_id);
CREATE INDEX IF NOT EXISTS idx_bbj_payouts_loser ON public.bbj_payouts(loser_user_id);
CREATE INDEX IF NOT EXISTS idx_bbj_payouts_table ON public.bbj_payouts(table_id, hand_number);
ALTER TABLE public.bbj_payouts ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.bbj_payouts IS 'BUG 014 FIX 2026-04-15 — master BBJ payout record';

CREATE TABLE IF NOT EXISTS public.bbj_payout_recipients (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id   uuid NOT NULL REFERENCES public.bbj_payouts(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,
  amount      numeric(20,2) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bbj_payout_recipients_payout ON public.bbj_payout_recipients(payout_id);
CREATE INDEX IF NOT EXISTS idx_bbj_payout_recipients_user ON public.bbj_payout_recipients(user_id);
ALTER TABLE public.bbj_payout_recipients ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.bbj_payout_recipients IS 'BUG 014 FIX 2026-04-15 — per-player table-share breakdown';

CREATE TABLE IF NOT EXISTS public.tournament_bounties (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id             uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  eliminated_player_id      uuid NOT NULL,
  collector_player_id       uuid NOT NULL,
  bounty_amount             numeric(20,2) NOT NULL,
  added_to_collector_bounty numeric(20,2) DEFAULT 0,
  is_mystery_revealed       boolean DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tourney_bounties_tournament ON public.tournament_bounties(tournament_id);
CREATE INDEX IF NOT EXISTS idx_tourney_bounties_collector ON public.tournament_bounties(collector_player_id);
CREATE INDEX IF NOT EXISTS idx_tourney_bounties_eliminated ON public.tournament_bounties(eliminated_player_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tourney_bounty_ko
  ON public.tournament_bounties(tournament_id, eliminated_player_id, collector_player_id);
ALTER TABLE public.tournament_bounties ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.tournament_bounties IS 'BUG 015 FIX 2026-04-15 — bounty KO record';

-- RLS policies (manual drop+create since CREATE POLICY IF NOT EXISTS isn't supported in PG 17)
DROP POLICY IF EXISTS bbj_payouts_public_read ON public.bbj_payouts;
CREATE POLICY bbj_payouts_public_read ON public.bbj_payouts FOR SELECT USING (true);

DROP POLICY IF EXISTS bbj_payout_recipients_public_read ON public.bbj_payout_recipients;
CREATE POLICY bbj_payout_recipients_public_read ON public.bbj_payout_recipients FOR SELECT USING (true);

DROP POLICY IF EXISTS tournament_bounties_public_read ON public.tournament_bounties;
CREATE POLICY tournament_bounties_public_read ON public.tournament_bounties FOR SELECT USING (true);
