-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260723181924 "ca_sweep3_tier1_2_feature_tables"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 fa1c13652bb588973c884f88aab74ae6 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═════════════════════════════════════════════════════════════════════════════
-- CA sweep #3 Tier 1+2 — real backends for reachable phantom-table features.
-- Only REACHABLE client call-sites get tables (dead-code clusters documented,
-- not built). All schemas match the exact client column usage.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── 1. session_history — written by client SessionStatsService at session end;
--       read by SessionHistoryPage (session_start/session_end aliases),
--       PlayerStyleRadar, PerformanceTrends, StakeLevelComparison.
CREATE TABLE IF NOT EXISTS public.session_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  table_id uuid,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  duration_minutes integer DEFAULT 0,
  initial_stack numeric DEFAULT 0,
  final_stack numeric DEFAULT 0,
  buy_in_total numeric DEFAULT 0,
  profit_loss numeric DEFAULT 0,
  hands_played integer DEFAULT 0,
  hands_won integer DEFAULT 0,
  vpip_percent numeric DEFAULT 0,
  pfr_percent numeric DEFAULT 0,
  big_blind numeric DEFAULT 0,
  bb_won numeric DEFAULT 0,
  trajectory jsonb DEFAULT '[]'::jsonb,
  rebuys integer DEFAULT 0,
  biggest_pot numeric DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- reader-side aliases (SessionHistoryPage selects session_start/session_end)
  session_start timestamptz GENERATED ALWAYS AS (started_at) STORED,
  session_end timestamptz GENERATED ALWAYS AS (ended_at) STORED
);
CREATE INDEX IF NOT EXISTS idx_session_history_user_end ON public.session_history (user_id, ended_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_history_table ON public.session_history (table_id);
ALTER TABLE public.session_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS session_history_insert_own ON public.session_history;
CREATE POLICY session_history_insert_own ON public.session_history
  FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS session_history_select_own ON public.session_history;
CREATE POLICY session_history_select_own ON public.session_history
  FOR SELECT TO authenticated USING (
    user_id = (SELECT auth.uid())
    OR EXISTS (  -- club owners/admins can read sessions played at their club's tables
      SELECT 1 FROM tables t JOIN clubs c ON c.id = t.club_id
       WHERE t.id = session_history.table_id
         AND (c.owner_id = (SELECT auth.uid())
              OR EXISTS (SELECT 1 FROM club_members cm
                          WHERE cm.club_id = c.id AND cm.user_id = (SELECT auth.uid())
                            AND cm.role IN ('owner','co_owner','admin')))
    )
  );

-- ── 2. player_sessions — compatibility VIEW over session_history.
--       Readers: SessionHistory/BankrollTracker/PlayerStatsPage
--       (user_id/date/buy_in/cash_out/profit_loss) and AdminDashboardPage
--       (club_id/created_at/total_hands/net_result).
CREATE OR REPLACE VIEW public.player_sessions
WITH (security_invoker = true) AS
SELECT sh.id,
       sh.user_id,
       t.club_id,
       COALESCE(sh.ended_at, sh.started_at)::date AS date,
       sh.created_at,
       sh.duration_minutes,
       sh.hands_played,
       sh.hands_played AS total_hands,
       sh.buy_in_total AS buy_in,
       sh.final_stack AS cash_out,
       sh.profit_loss,
       sh.profit_loss AS net_result
  FROM public.session_history sh
  LEFT JOIN public.tables t ON t.id = sh.table_id;
GRANT SELECT ON public.player_sessions TO authenticated;

-- ── 3. player_position_stats — read by PlayerStyleRadar, PositionWinRates,
--       PlayerStatsPage pie chart, admin AnalyticsDashboard.
--       Populated server-side by a hand_history trigger (see next migration).
CREATE TABLE IF NOT EXISTS public.player_position_stats (
  user_id uuid NOT NULL,
  position text NOT NULL,
  hands_played integer NOT NULL DEFAULT 0,
  vpip_count integer NOT NULL DEFAULT 0,
  pfr_count integer NOT NULL DEFAULT 0,
  three_bet_count integer NOT NULL DEFAULT 0,
  fold_to_three_bet_count integer NOT NULL DEFAULT 0,
  hands_won integer NOT NULL DEFAULT 0,
  total_profit numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, position)
);
ALTER TABLE public.player_position_stats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pps_select_authenticated ON public.player_position_stats;
CREATE POLICY pps_select_authenticated ON public.player_position_stats
  FOR SELECT TO authenticated USING (true);
-- writes: server-side only (trigger runs as table owner)

-- ── 4. user_feedback — FeedbackForm currently shows success while dropping
--       feedback on the floor.
CREATE TABLE IF NOT EXISTS public.user_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  category text NOT NULL DEFAULT 'general',
  description text NOT NULL,
  screenshot_url text,
  status text NOT NULL DEFAULT 'new',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.user_feedback ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_feedback_insert ON public.user_feedback;
CREATE POLICY user_feedback_insert ON public.user_feedback
  FOR INSERT TO authenticated WITH CHECK (user_id IS NULL OR user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS user_feedback_select_own ON public.user_feedback;
CREATE POLICY user_feedback_select_own ON public.user_feedback
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

-- ── 5. club_invites — agent invite-code generation currently always fails.
CREATE TABLE IF NOT EXISTS public.club_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL,
  agent_id uuid,
  code text NOT NULL UNIQUE,
  email text,
  expires_at timestamptz,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_club_invites_club ON public.club_invites (club_id);
ALTER TABLE public.club_invites ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS club_invites_insert ON public.club_invites;
CREATE POLICY club_invites_insert ON public.club_invites
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM agents a WHERE a.id = club_invites.agent_id AND a.user_id = (SELECT auth.uid()))
    OR EXISTS (SELECT 1 FROM clubs c WHERE c.id = club_invites.club_id AND c.owner_id = (SELECT auth.uid()))
    OR EXISTS (SELECT 1 FROM club_members cm WHERE cm.club_id = club_invites.club_id
                 AND cm.user_id = (SELECT auth.uid()) AND cm.role IN ('owner','co_owner','admin'))
  );
DROP POLICY IF EXISTS club_invites_select ON public.club_invites;
CREATE POLICY club_invites_select ON public.club_invites
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM agents a WHERE a.id = club_invites.agent_id AND a.user_id = (SELECT auth.uid()))
    OR EXISTS (SELECT 1 FROM clubs c WHERE c.id = club_invites.club_id AND c.owner_id = (SELECT auth.uid()))
    OR EXISTS (SELECT 1 FROM club_members cm WHERE cm.club_id = club_invites.club_id
                 AND cm.user_id = (SELECT auth.uid()) AND cm.role IN ('owner','co_owner','admin'))
  );

-- ── 6. club_daily_stats — compatibility VIEW (ClubStatsCards reads
--       hands_played/rake_collected by club_id + stat_date). Live source is
--       rake_records; legacy pre-rake_records era comes from rake_history.
CREATE OR REPLACE VIEW public.club_daily_stats
WITH (security_invoker = true) AS
WITH rr_start AS (SELECT COALESCE(min(created_at), 'infinity'::timestamptz) AS ts FROM public.rake_records)
SELECT club_id, stat_date, sum(hands_played)::integer AS hands_played, sum(rake_collected) AS rake_collected
FROM (
  SELECT club_id, created_at::date AS stat_date, count(*) AS hands_played, sum(rake_amount) AS rake_collected
    FROM public.rake_records GROUP BY 1, 2
  UNION ALL
  SELECT club_id, COALESCE(collected_at, created_at)::date, count(*), sum(rake_amount)
    FROM public.rake_history, rr_start
   WHERE COALESCE(collected_at, created_at) < rr_start.ts
   GROUP BY 1, 2
) u
GROUP BY club_id, stat_date;
GRANT SELECT ON public.club_daily_stats TO authenticated;

-- ── 7. friend_challenges — FriendChallengeModal send currently raw-errors.
CREATE TABLE IF NOT EXISTS public.friend_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenger_id uuid NOT NULL,
  challengee_id uuid NOT NULL,
  challenge_type text NOT NULL,
  target_value numeric DEFAULT 0,
  challenger_progress numeric NOT NULL DEFAULT 0,
  challengee_progress numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_friend_challenges_parties ON public.friend_challenges (challenger_id, challengee_id);
ALTER TABLE public.friend_challenges ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS friend_challenges_insert ON public.friend_challenges;
CREATE POLICY friend_challenges_insert ON public.friend_challenges
  FOR INSERT TO authenticated WITH CHECK (challenger_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS friend_challenges_select ON public.friend_challenges;
CREATE POLICY friend_challenges_select ON public.friend_challenges
  FOR SELECT TO authenticated USING (challenger_id = (SELECT auth.uid()) OR challengee_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS friend_challenges_update ON public.friend_challenges;
CREATE POLICY friend_challenges_update ON public.friend_challenges
  FOR UPDATE TO authenticated USING (challenger_id = (SELECT auth.uid()) OR challengee_id = (SELECT auth.uid()));

-- ── 8. throw_usage — VIP free-throw ledger; every VIP throw currently fails.
CREATE TABLE IF NOT EXISTS public.throw_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  throwable_id text NOT NULL,
  paid_diamonds boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_throw_usage_user_month ON public.throw_usage (user_id, created_at DESC);
ALTER TABLE public.throw_usage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS throw_usage_insert_own ON public.throw_usage;
CREATE POLICY throw_usage_insert_own ON public.throw_usage
  FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS throw_usage_select_own ON public.throw_usage;
CREATE POLICY throw_usage_select_own ON public.throw_usage
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

-- ── 9. Bonus-surface read tables (reachable readers on ProfilePage/BonusPage;
--       the wheel/bonus WRITE flows are dead code — no claim RPCs built).
CREATE TABLE IF NOT EXISTS public.special_bonuses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text,
  title text,
  description text,
  reward numeric NOT NULL DEFAULT 0,
  reward_type text NOT NULL DEFAULT 'chips',
  condition text,
  progress numeric NOT NULL DEFAULT 0,
  target numeric NOT NULL DEFAULT 0,
  claimed boolean NOT NULL DEFAULT false,
  claimed_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_special_bonuses_user ON public.special_bonuses (user_id, claimed, expires_at);
ALTER TABLE public.special_bonuses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS special_bonuses_select_own ON public.special_bonuses;
CREATE POLICY special_bonuses_select_own ON public.special_bonuses
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
-- NOTE: no client UPDATE policy on purpose — BonusPage's local "claim" flips
-- claimed without crediting; claiming must go through a server RPC when the
-- bonus feature is actually built. Server (service_role) seeds/updates rows.

CREATE TABLE IF NOT EXISTS public.user_lucky_wheel_spins (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  total_spins integer NOT NULL DEFAULT 0,
  last_spin_date timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.user_lucky_wheel_spins ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ulws_select_all ON public.user_lucky_wheel_spins;
CREATE POLICY ulws_select_all ON public.user_lucky_wheel_spins
  FOR SELECT TO authenticated USING (true);  -- leaderboard is public within app

CREATE TABLE IF NOT EXISTS public.user_daily_rewards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  last_claim_date timestamptz,
  current_streak integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.user_daily_rewards ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS udr_select_own ON public.user_daily_rewards;
CREATE POLICY udr_select_own ON public.user_daily_rewards
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

CREATE TABLE IF NOT EXISTS public.user_bonuses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  daily_streak integer NOT NULL DEFAULT 0,
  last_daily_claim timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.user_bonuses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_bonuses_select_own ON public.user_bonuses;
CREATE POLICY user_bonuses_select_own ON public.user_bonuses
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

-- ── 10. Promotions claims + leaderboards (PromotionDetail claim currently
--        raw-errors; leaderboard promos always empty).
CREATE TABLE IF NOT EXISTS public.promotion_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id uuid NOT NULL,
  user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active',
  bonus_amount numeric NOT NULL DEFAULT 0,
  wager_progress numeric NOT NULL DEFAULT 0,
  wager_required numeric NOT NULL DEFAULT 0,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (promotion_id, user_id)
);
ALTER TABLE public.promotion_claims ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS promotion_claims_insert_own ON public.promotion_claims;
CREATE POLICY promotion_claims_insert_own ON public.promotion_claims
  FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS promotion_claims_select_own ON public.promotion_claims;
CREATE POLICY promotion_claims_select_own ON public.promotion_claims
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

CREATE TABLE IF NOT EXISTS public.promotion_leaderboards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  rank integer,
  score numeric NOT NULL DEFAULT 0,
  prize numeric,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (promotion_id, user_id)
);
ALTER TABLE public.promotion_leaderboards ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS promo_lb_select_all ON public.promotion_leaderboards;
CREATE POLICY promo_lb_select_all ON public.promotion_leaderboards
  FOR SELECT TO authenticated USING (true);
-- writes: server-side only

-- ── 11. flash_pools — page currently error-toasts on every load. Table only;
--        join_flash_pool RPC is deliberately NOT created (it must seat the
--        player via the game engine before any buy-in debit — engine work).
CREATE TABLE IF NOT EXISTS public.flash_pools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  small_blind numeric NOT NULL,
  big_blind numeric NOT NULL,
  active_players integer NOT NULL DEFAULT 0,
  tables_running integer NOT NULL DEFAULT 0,
  buy_in_min numeric,
  buy_in_max numeric,
  status text NOT NULL DEFAULT 'waiting',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.flash_pools ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS flash_pools_select_all ON public.flash_pools;
CREATE POLICY flash_pools_select_all ON public.flash_pools
  FOR SELECT TO authenticated USING (true);

-- ── 12. Referrals (server-authoritative crediting comes in the RPC migration).
CREATE TABLE IF NOT EXISTS public.referral_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  code text NOT NULL UNIQUE,
  uses integer NOT NULL DEFAULT 0,
  max_uses integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.referral_codes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS referral_codes_select_own ON public.referral_codes;
CREATE POLICY referral_codes_select_own ON public.referral_codes
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS referral_codes_insert_own ON public.referral_codes;
CREATE POLICY referral_codes_insert_own ON public.referral_codes
  FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));

CREATE TABLE IF NOT EXISTS public.referral_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_id uuid REFERENCES public.referral_codes(id),
  referrer_id uuid NOT NULL,
  referee_id uuid NOT NULL UNIQUE,   -- one redemption per referee, ever
  chips_awarded_referrer numeric NOT NULL DEFAULT 0,
  chips_awarded_referee numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_referral_redemptions_referrer ON public.referral_redemptions (referrer_id);
ALTER TABLE public.referral_redemptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS referral_redemptions_select ON public.referral_redemptions;
CREATE POLICY referral_redemptions_select ON public.referral_redemptions
  FOR SELECT TO authenticated USING (referrer_id = (SELECT auth.uid()) OR referee_id = (SELECT auth.uid()));
-- writes: only via redeem_referral_code RPC

CREATE TABLE IF NOT EXISTS public.referral_milestone_claims (
  user_id uuid NOT NULL,
  milestone integer NOT NULL,
  chips_awarded numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, milestone)
);
ALTER TABLE public.referral_milestone_claims ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rmc_select_own ON public.referral_milestone_claims;
CREATE POLICY rmc_select_own ON public.referral_milestone_claims
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

-- ── 13. feature_purchases — read by VIPService.checkExistingPurchase; written
--        by the fn_purchase_feature RPC (next migration).
CREATE TABLE IF NOT EXISTS public.feature_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  feature text NOT NULL,
  cost integer NOT NULL DEFAULT 0,
  usage_type text,
  uses_remaining integer,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_feature_purchases_user_feature ON public.feature_purchases (user_id, feature, created_at DESC);
ALTER TABLE public.feature_purchases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS feature_purchases_select_own ON public.feature_purchases;
CREATE POLICY feature_purchases_select_own ON public.feature_purchases
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
-- writes: only via fn_purchase_feature RPC

-- ── Realtime: client subscribes to these tables; add to the publication.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['session_history','agent_commissions','settlement_invoices','special_bonuses','flash_pools'] LOOP
    BEGIN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
END $$;
