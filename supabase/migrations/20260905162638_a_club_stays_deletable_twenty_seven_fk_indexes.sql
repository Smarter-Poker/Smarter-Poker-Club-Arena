-- 20260905162638_a_club_stays_deletable_twenty_seven_fk_indexes.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- `public.clubs` had 27 foreign keys pointing at it whose child column carried
-- no usable index. A DELETE on the parent checks EVERY inbound key, and a check
-- with no index is a sequential scan of the child - so each of these made
-- retiring a club slower, and the retirement RPC runs inside a PostgREST
-- request that is cancelled after a few seconds. When it is cancelled the
-- fixture and its 100,000 chips stay in Club Arena. The CI guard's own words:
-- "That has already happened once."
--
-- Found by `Supabase Invariants - A Club Stays Deletable`, which asks
-- PRODUCTION rather than a manifest - so it goes red the moment a new table
-- lands with a club_id and no index, without any branch having done anything
-- wrong. It was red on this pull request for that reason, and it would have
-- been red on anybody else's. Confirmed independently against the live
-- catalogue before writing this: the same 27, no more and no fewer.
--
-- Two of them are not called club_id: stable_hand_horse_state.active_club_id
-- and .active_host_id both reference clubs, and a "host" is a club here.
--
-- Every one of these tables is small (largest 1,000 rows), so a plain
-- CREATE INDEX inside the transaction takes its ACCESS EXCLUSIVE lock for
-- microseconds. CONCURRENTLY cannot run in a transaction and would trade that
-- for 27 separate schema-cache reloads at ~28 seconds each, which the
-- production DDL policy exists to prevent.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE INDEX IF NOT EXISTS idx_ad_advertiser_club_id_fk
  ON public.ad_advertiser (club_id);

CREATE INDEX IF NOT EXISTS idx_ad_placement_club_id_fk
  ON public.ad_placement (club_id);

CREATE INDEX IF NOT EXISTS idx_bad_beat_jackpots_club_id_fk
  ON public.bad_beat_jackpots (club_id);

CREATE INDEX IF NOT EXISTS idx_blacklists_club_id_fk
  ON public.blacklists (club_id);

CREATE INDEX IF NOT EXISTS idx_ca_supply_snapshot_classifications_club_id_fk
  ON public.ca_supply_snapshot_classifications (club_id);

CREATE INDEX IF NOT EXISTS idx_cashout_requests_club_id_fk
  ON public.cashout_requests (club_id);

CREATE INDEX IF NOT EXISTS idx_chat_moderation_actions_club_id_fk
  ON public.chat_moderation_actions (club_id);

CREATE INDEX IF NOT EXISTS idx_chat_mutes_club_id_fk
  ON public.chat_mutes (club_id);

CREATE INDEX IF NOT EXISTS idx_chip_requests_club_id_fk
  ON public.chip_requests (club_id);

CREATE INDEX IF NOT EXISTS idx_club_arena_messages_club_id_fk
  ON public.club_arena_messages (club_id);

CREATE INDEX IF NOT EXISTS idx_club_chat_club_id_fk
  ON public.club_chat (club_id);

CREATE INDEX IF NOT EXISTS idx_club_opening_setup_funding_club_id_fk
  ON public.club_opening_setup_funding (club_id);

CREATE INDEX IF NOT EXISTS idx_commission_rate_audit_club_id_fk
  ON public.commission_rate_audit (club_id);

CREATE INDEX IF NOT EXISTS idx_conversations_club_id_fk
  ON public.conversations (club_id);

CREATE INDEX IF NOT EXISTS idx_game_ticker_settings_club_id_fk
  ON public.game_ticker_settings (club_id);

CREATE INDEX IF NOT EXISTS idx_player_agent_assignments_club_id_fk
  ON public.player_agent_assignments (club_id);

CREATE INDEX IF NOT EXISTS idx_promotions_club_id_fk
  ON public.promotions (club_id);

CREATE INDEX IF NOT EXISTS idx_rake_rate_audit_club_id_fk
  ON public.rake_rate_audit (club_id);

CREATE INDEX IF NOT EXISTS idx_seed_reveals_club_id_fk
  ON public.seed_reveals (club_id);

CREATE INDEX IF NOT EXISTS idx_stable_hand_horse_state_active_club_id_fk
  ON public.stable_hand_horse_state (active_club_id);

CREATE INDEX IF NOT EXISTS idx_stable_hand_horse_state_active_host_id_fk
  ON public.stable_hand_horse_state (active_host_id);

CREATE INDEX IF NOT EXISTS idx_sub_agents_club_id_fk
  ON public.sub_agents (club_id);

CREATE INDEX IF NOT EXISTS idx_table_templates_club_id_fk
  ON public.table_templates (club_id);

CREATE INDEX IF NOT EXISTS idx_tournament_tickets_club_id_fk
  ON public.tournament_tickets (club_id);

CREATE INDEX IF NOT EXISTS idx_union_announcements_club_id_fk
  ON public.union_announcements (club_id);

CREATE INDEX IF NOT EXISTS idx_union_applications_club_id_fk
  ON public.union_applications (club_id);

CREATE INDEX IF NOT EXISTS idx_union_leave_requests_club_id_fk
  ON public.union_leave_requests (club_id);

-- Nothing inbound to clubs may be left without a usable index. A PARTIAL index
-- does not count: a foreign key check must find the rows a predicate hides.
DO $$
DECLARE v_left text;
BEGIN
  SELECT string_agg(child || '.' || col, ', ') INTO v_left
  FROM (
    SELECT c.relname AS child, a.attname AS col
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class rc ON rc.oid = con.confrelid
    JOIN pg_namespace rn ON rn.oid = rc.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = con.conkey[1]
    WHERE con.contype = 'f'
      AND rn.nspname = 'public' AND rc.relname = 'clubs'
      AND n.nspname = 'public'
      AND array_length(con.conkey, 1) = 1
      AND NOT EXISTS (
        SELECT 1
        FROM pg_index i
        JOIN pg_class t ON t.oid = i.indrelid
        JOIN pg_namespace tn ON tn.oid = t.relnamespace
        JOIN pg_attribute ia ON ia.attrelid = t.oid AND ia.attnum = i.indkey[0]
        WHERE tn.nspname = 'public' AND t.relname = c.relname
          AND ia.attname = a.attname AND i.indpred IS NULL
      )
  ) s;
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'a club still cannot be deleted: unindexed foreign key(s) %', v_left;
  END IF;
END $$;

COMMIT;
