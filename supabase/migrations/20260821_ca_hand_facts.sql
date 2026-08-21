-- =====================================================================
-- 20260821_ca_hand_facts.sql
-- Tier 2 migration: new objects only. No DROP, no ALTER COLUMN TYPE.
--
-- WHY THIS EXISTS
-- hand_history is purged after 7 days by sp_prune_hand_history(), holds
-- ~1.5M rows / 10GB, and stores per-player data as JSONB that is 99.97%
-- horse-vs-horse traffic. It also stores hole cards ONLY for players who
-- reached showdown (32.5% of hands), and stores no all-in equity at all.
--
-- Consequently the stats page cannot derive: a player's own hole cards for
-- hands they folded, their exact net (the actions JSON omits blinds and
-- antes), whether they ran above or below all-in EV, or who took chips off
-- whom. None of it is recoverable retroactively.
--
-- ca_hand_facts is the durable, human-only, one-row-per-player-per-hand
-- fact table that fixes all of the above. It is written by the engine at
-- settlement from values it already holds in memory. Horses get no rows,
-- which is what keeps this table roughly four orders of magnitude smaller
-- than hand_history.
--
-- SECURITY: hole_cards on this table includes cards that NEVER went to
-- showdown. RLS scoping this to auth.uid() is the only thing preventing a
-- player from reading an opponent's mucked hand. Any SECURITY DEFINER RPC
-- reading this table MUST assert p_user = auth.uid(); DEFINER bypasses RLS
-- and the policy below will not save a careless function.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Pre-flight assertions: fail loudly rather than half-apply.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'ca_hand_facts'
  ) THEN
    RAISE EXCEPTION 'ca_hand_facts already exists - this migration is not idempotent-safe against an existing table with a different shape. Inspect before re-running.';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 1. ca_hand_facts
-- ---------------------------------------------------------------------
CREATE TABLE public.ca_hand_facts (
  hand_id          uuid        NOT NULL,
  user_id          uuid        NOT NULL,
  club_id          uuid,
  table_id         uuid,
  tournament_id    uuid,
  played_at        timestamptz NOT NULL,
  game_variant     text        NOT NULL,
  big_blind        numeric     NOT NULL,

  -- Seating and position. Position is derived from the authoritative
  -- button_seat and seat order, NOT from preflop action order (the way
  -- fn_process_hand_position_stats does it, which silently drops players
  -- who folded without acting).
  seat             smallint,
  position         text        NOT NULL,
  players_dealt    smallint    NOT NULL,

  -- The hero's own cards, on EVERY hand they were dealt in, not just
  -- showdowns. RLS-protected to auth.uid(). See the security note above.
  hole_cards       jsonb,
  -- 169-grid key for NLH / short-deck: 'AA', 'AKs', '72o'.
  -- NULL for PLO variants - a 13x13 grid cannot represent 4-6 card hands.
  hand_class       text,

  -- Money. Exact. invested INCLUDES blinds, antes, dead blinds and
  -- straddles, and is net of any returned uncalled bet, because it comes
  -- from the engine's currentHandContributions (SeatPlayer.totalInvested)
  -- rather than being reconstructed from the actions JSON.
  invested         numeric     NOT NULL,
  returned         numeric     NOT NULL,
  net              numeric     NOT NULL,
  net_bb           numeric     NOT NULL,
  rake_paid        numeric     NOT NULL DEFAULT 0,

  -- Flow flags, computed in the engine where the truth lives.
  vpip                  boolean  NOT NULL DEFAULT false,
  pfr                   boolean  NOT NULL DEFAULT false,
  three_bet             boolean  NOT NULL DEFAULT false,
  faced_three_bet       boolean  NOT NULL DEFAULT false,
  folded_to_three_bet   boolean  NOT NULL DEFAULT false,
  had_cbet_flop_opp     boolean  NOT NULL DEFAULT false,
  cbet_flop             boolean  NOT NULL DEFAULT false,
  saw_flop              boolean  NOT NULL DEFAULT false,
  went_to_showdown      boolean  NOT NULL DEFAULT false,
  won_at_showdown       boolean  NOT NULL DEFAULT false,
  aggressive_actions    smallint NOT NULL DEFAULT 0,
  passive_actions       smallint NOT NULL DEFAULT 0,

  -- All-in EV. NULL when this player had no all-in in this hand.
  -- all_in_equity is EXACT (every hand is known at an all-in), sourced
  -- from the equity the engine already computes in broadcastAllInEquity
  -- and previously discarded.
  was_all_in       boolean     NOT NULL DEFAULT false,
  all_in_street    text,
  all_in_at_risk   numeric,
  all_in_equity    numeric,
  ev_returned      numeric,

  -- ev_net = (ev_returned - invested) when all-in, else = net.
  -- Outside all-in spots the EV series and the actual series are identical
  -- by construction, which is the correct behaviour for a luck graph.
  ev_net           numeric     NOT NULL,
  ev_net_bb        numeric     NOT NULL,

  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ca_hand_facts_pkey PRIMARY KEY (hand_id, user_id),
  CONSTRAINT ca_hand_facts_equity_range
    CHECK (all_in_equity IS NULL OR (all_in_equity >= 0 AND all_in_equity <= 1))
);

COMMENT ON TABLE public.ca_hand_facts IS
  'Durable per-human-per-hand fact row written by the engine at settlement. Survives the 7-day hand_history purge. hole_cards includes non-showdown cards - RLS to auth.uid() is load-bearing.';
COMMENT ON COLUMN public.ca_hand_facts.invested IS
  'Exact chips committed, INCLUDING blinds/antes/straddles, net of returned uncalled bet. From engine currentHandContributions, not reconstructed from actions JSON.';
COMMENT ON COLUMN public.ca_hand_facts.ev_net IS
  'All-in-adjusted net. Equals net on hands with no all-in. Basis of the EV vs actual luck graph.';

CREATE INDEX idx_ca_hand_facts_user_time
  ON public.ca_hand_facts (user_id, played_at DESC);
CREATE INDEX idx_ca_hand_facts_user_class
  ON public.ca_hand_facts (user_id, hand_class)
  WHERE hand_class IS NOT NULL;
CREATE INDEX idx_ca_hand_facts_user_pos
  ON public.ca_hand_facts (user_id, position);
CREATE INDEX idx_ca_hand_facts_allin
  ON public.ca_hand_facts (user_id, played_at DESC)
  WHERE was_all_in = true;

ALTER TABLE public.ca_hand_facts ENABLE ROW LEVEL SECURITY;

-- Read your own rows. Nothing else. Writes are service_role only (the
-- engine holds SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS entirely).
CREATE POLICY ca_hand_facts_own_read ON public.ca_hand_facts
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- 2. ca_hand_transfers  (head-to-head chip flow, for Nemesis / Target)
--
-- ATTRIBUTION RULE (decided 2026-08-21, documented so it is not
-- re-litigated): chip flow is attributed at HAND level, proportionally.
-- For each hand, every winner receives from every loser in proportion to
-- that loser's share of total losses in the hand.
--
--   transfer(w, l) = net_w * (loss_l / total_losses)
--
-- This conserves chips exactly, is exactly right for the overwhelming
-- majority of hands (single pot, or a single winner), and approximates
-- only in multi-way side-pot situations. It deliberately does NOT
-- attribute rake to any opponent: total wins are less than total losses
-- by exactly the rake, so each loser's attributed outflow is their loss
-- minus their share of the rake. That is correct - the house took it,
-- not the villain.
--
-- The alternative (exact per-pot attribution) requires capturing pot
-- eligibility from HandController before it is nulled at settlement.
-- Rejected: it needs an edit to an oversized engine file for an accuracy
-- gain that is invisible in the aggregate a nemesis stat displays.
-- ---------------------------------------------------------------------
CREATE TABLE public.ca_hand_transfers (
  hand_id    uuid        NOT NULL,
  winner_id  uuid        NOT NULL,
  loser_id   uuid        NOT NULL,
  amount     numeric     NOT NULL CHECK (amount > 0),
  played_at  timestamptz NOT NULL,
  club_id    uuid,
  table_id   uuid,
  CONSTRAINT ca_hand_transfers_pkey PRIMARY KEY (hand_id, winner_id, loser_id),
  CONSTRAINT ca_hand_transfers_distinct CHECK (winner_id <> loser_id)
);

COMMENT ON TABLE public.ca_hand_transfers IS
  'Head-to-head chip flow per hand. Hand-level proportional attribution (see migration comment). Written only when at least one side is human.';

CREATE INDEX idx_ca_hand_transfers_loser
  ON public.ca_hand_transfers (loser_id, played_at DESC);
CREATE INDEX idx_ca_hand_transfers_winner
  ON public.ca_hand_transfers (winner_id, played_at DESC);

ALTER TABLE public.ca_hand_transfers ENABLE ROW LEVEL SECURITY;

CREATE POLICY ca_hand_transfers_involved_read ON public.ca_hand_transfers
  FOR SELECT TO authenticated
  USING (winner_id = auth.uid() OR loser_id = auth.uid());

-- ---------------------------------------------------------------------
-- 3. Post-apply assertions
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_facts_rls   boolean;
  v_xfer_rls    boolean;
  v_facts_cols  int;
  v_policies    int;
BEGIN
  SELECT relrowsecurity INTO v_facts_rls
    FROM pg_class WHERE oid = 'public.ca_hand_facts'::regclass;
  SELECT relrowsecurity INTO v_xfer_rls
    FROM pg_class WHERE oid = 'public.ca_hand_transfers'::regclass;

  IF NOT v_facts_rls THEN
    RAISE EXCEPTION 'ASSERT FAILED: RLS not enabled on ca_hand_facts. This table holds non-showdown hole cards.';
  END IF;
  IF NOT v_xfer_rls THEN
    RAISE EXCEPTION 'ASSERT FAILED: RLS not enabled on ca_hand_transfers.';
  END IF;

  SELECT count(*) INTO v_facts_cols
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ca_hand_facts';
  IF v_facts_cols < 35 THEN
    RAISE EXCEPTION 'ASSERT FAILED: ca_hand_facts has only % columns, expected >= 35.', v_facts_cols;
  END IF;

  SELECT count(*) INTO v_policies
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('ca_hand_facts', 'ca_hand_transfers');
  IF v_policies <> 2 THEN
    RAISE EXCEPTION 'ASSERT FAILED: expected exactly 2 RLS policies, found %.', v_policies;
  END IF;

  RAISE NOTICE 'ca_hand_facts + ca_hand_transfers created, RLS verified, % columns.', v_facts_cols;
END $$;
