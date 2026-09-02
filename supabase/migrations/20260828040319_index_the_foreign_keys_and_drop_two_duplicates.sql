-- INDEX THE FOREIGN KEYS, DROP TWO PROVEN DUPLICATES.
--
-- From the Supabase performance advisor, 2026-08-28. Only the findings that are
-- safe to act on TODAY are here. The advisor's 1,391 `unused_index` entries are
-- deliberately NOT acted on: Postgres restarted at 02:15:18 UTC, 1h46m before
-- the advisor ran, so every "has not been used" verdict rests on under two
-- hours of traffic. Any index serving a nightly cron, the weekly settlement
-- close, or an admin screen is reported unused and is not. Mass-dropping on
-- that evidence would be the same mistake as reading a failed count as zero.
-- Re-run the advisor after 7+ days of uninterrupted uptime and drop only what
-- is unused in BOTH runs. (The prize is real when it is earned: 1,708 MB, led
-- by idx_hand_history_players_gin at 180 MB, a GIN index maintained on every
-- one of ~220,000 hand inserts a day.)
--
-- ── UNINDEXED FOREIGN KEYS ──────────────────────────────────────────────────
-- An unindexed FK forces a sequential scan of the child table on every UPDATE
-- or DELETE of a parent row. Two of these are on tables this session has been
-- writing to all night and which grow with every tournament:
-- tournament_rake_settlements already holds 31,699 rows, and
-- tournament_guarantee_overlays is written by every funded guarantee.
--
-- Plain CREATE INDEX rather than CONCURRENTLY: apply_migration runs inside a
-- transaction, which CONCURRENTLY cannot do, and every table here is small
-- enough that the brief lock is not worth splitting the change into
-- out-of-band statements.

CREATE INDEX IF NOT EXISTS idx_ad_catalog_created_by
  ON public.ad_catalog (created_by);
CREATE INDEX IF NOT EXISTS idx_commander_print_jobs_reprint_of
  ON public.commander_print_jobs (reprint_of);
CREATE INDEX IF NOT EXISTS idx_commander_tax_events_entry_id
  ON public.commander_tax_events (entry_id);
CREATE INDEX IF NOT EXISTS idx_favorite_tables_table_id
  ON public.favorite_tables (table_id);
CREATE INDEX IF NOT EXISTS idx_flash_pool_players_user_id
  ON public.flash_pool_players (user_id);
CREATE INDEX IF NOT EXISTS idx_promo_vault_inventory_item_key
  ON public.promo_vault_inventory (item_key);
CREATE INDEX IF NOT EXISTS idx_promo_vault_records_item_key
  ON public.promo_vault_records (item_key);
CREATE INDEX IF NOT EXISTS idx_sso_bridge_tokens_user_id
  ON public.sso_bridge_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_tournament_bounty_awards_chest_id
  ON public.tournament_bounty_awards (chest_id);
CREATE INDEX IF NOT EXISTS idx_tournament_guarantee_overlays_club_id
  ON public.tournament_guarantee_overlays (club_id);
CREATE INDEX IF NOT EXISTS idx_tournament_rake_settlements_club_id
  ON public.tournament_rake_settlements (club_id);
CREATE INDEX IF NOT EXISTS idx_vip_reward_claims_reward_id
  ON public.vip_reward_claims (reward_id);

-- ── TWO DUPLICATES, VERIFIED BY SCAN COUNT ──────────────────────────────────
-- idx_bbj_payouts_table is identical in definition to idx_bbj_payouts_table_hand
-- and has 0 scans against the other's 23,907. This one is safe regardless of
-- the stats window: a duplicate index is redundant by DEFINITION, not by usage.
DROP INDEX IF EXISTS public.idx_bbj_payouts_table;

-- daily_trivia_plays_user_date_uidx duplicates the constraint-backed
-- daily_trivia_plays_user_id_played_date_key. Drop the standalone; the
-- constraint keeps enforcing uniqueness.
DROP INDEX IF EXISTS public.daily_trivia_plays_user_date_uidx;

-- ── STALE ALERTS THIS SESSION ALREADY FIXED ─────────────────────────────────
-- fn_backpay_spin_unpaid_winners paid all 41 identified Spin winners (1,437.00
-- chips) and v_spin_unpaid_settlements now returns zero rows in that shape, so
-- these 52 criticals describe a condition that no longer exists. A queue full
-- of resolved problems is how a real one gets missed.
UPDATE public.financial_alerts a
   SET resolved = true, resolved_at = now()
 WHERE a.source = 'fn_spin_unpaid_check'
   AND a.resolved IS NOT TRUE
   AND NOT EXISTS (
     SELECT 1 FROM public.v_spin_unpaid_settlements v
      WHERE v.tournament_id = (a.context->>'tournament_id')::uuid
        AND v.chips_short > 0.01);

DO $post$
DECLARE v_missing int; v_dupe int;
BEGIN
  SELECT count(*) INTO v_missing FROM (VALUES
    ('ad_catalog','idx_ad_catalog_created_by'),
    ('tournament_rake_settlements','idx_tournament_rake_settlements_club_id'),
    ('tournament_guarantee_overlays','idx_tournament_guarantee_overlays_club_id')
  ) AS want(t, i)
   WHERE to_regclass('public.' || want.i) IS NULL;
  IF v_missing > 0 THEN
    RAISE EXCEPTION '% expected index(es) were not created', v_missing;
  END IF;

  -- The kept half of each duplicate pair must survive. Dropping both would
  -- turn a tidy-up into an outage.
  SELECT count(*) INTO v_dupe FROM (VALUES
    ('idx_bbj_payouts_table_hand'),
    ('daily_trivia_plays_user_id_played_date_key')
  ) AS keep(i) WHERE to_regclass('public.' || keep.i) IS NULL;
  IF v_dupe > 0 THEN
    RAISE EXCEPTION 'a duplicate drop removed the index that was meant to be kept';
  END IF;
END
$post$;
