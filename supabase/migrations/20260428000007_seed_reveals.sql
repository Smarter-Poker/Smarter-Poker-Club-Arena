-- ═══════════════════════════════════════════════════════════════════════════════
-- Tier E PB-BETTER-1 (Provably-fair RNG)
-- Phase X2 — closes P0-E3 / addresses Tier E E2 (Spec Authority Hierarchy)
-- Migration: 20260428000007_seed_reveals.sql
--
-- Purpose:
--   PokerBros doesn't expose RNG verification. We do. Per-hand seed commit
--   (hash) is published before the deal; seed reveal is published after the
--   hand ends. Players can verify the shuffle reproduces by re-running
--   Fisher-Yates with the revealed seed.
--
--   Why a separate table (vs columns on hand_history):
--     - hand_history is a hot insert path; we don't want to widen its row size
--     - seed reveals are read frequently for verification long after the hand,
--       and live in a different access pattern (public read by hand_id)
--     - public-facing verification UI can SELECT from a narrow table
--
--   Engine workflow (added in Phase X5):
--     1. Before deal:  generate seed → compute SHA256(seed) → INSERT row with seed_commit, seed=NULL
--     2. After hand:   UPDATE row WHERE hand_id=… SET seed = <plaintext>, revealed_at = NOW()
--     3. UI:           any user can SELECT seed_commit + seed and verify
-- ═══════════════════════════════════════════════════════════════════════════════

-- pgcrypto must exist BEFORE the CHECK constraint references digest().
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.seed_reveals (
  hand_id UUID PRIMARY KEY,              -- one row per hand; hard 1:1
  table_id UUID NOT NULL,
  club_id  UUID REFERENCES public.clubs(id) ON DELETE SET NULL,

  -- Commit phase (before deal)
  seed_commit_sha256 TEXT NOT NULL,      -- 64-hex-char SHA256 of plaintext seed
  committed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Reveal phase (after hand resolution)
  seed_plaintext TEXT,                   -- the plaintext seed; NULL until revealed
  revealed_at TIMESTAMPTZ,

  -- Algorithm metadata (so we can rotate algos later without breaking old verify)
  shuffle_algo TEXT NOT NULL DEFAULT 'fisher_yates_v1',
  rng_algo     TEXT NOT NULL DEFAULT 'crypto_getRandomValues',

  -- Sanity: revealed seed must hash to commit
  CONSTRAINT seed_reveal_consistent CHECK (
    seed_plaintext IS NULL OR encode(digest(seed_plaintext, 'sha256'), 'hex') = seed_commit_sha256
  )
);

CREATE INDEX IF NOT EXISTS idx_seed_reveals_table ON public.seed_reveals (table_id, committed_at DESC);
CREATE INDEX IF NOT EXISTS idx_seed_reveals_club  ON public.seed_reveals (club_id, committed_at DESC);

-- RLS: anyone authenticated can read (verification is the entire point);
-- only service role writes.
ALTER TABLE public.seed_reveals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role full access" ON public.seed_reveals;
CREATE POLICY "service_role full access"
  ON public.seed_reveals FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anyone authenticated reads seed reveals" ON public.seed_reveals;
CREATE POLICY "anyone authenticated reads seed reveals"
  ON public.seed_reveals FOR SELECT TO authenticated
  USING (true);

COMMENT ON TABLE public.seed_reveals IS
  'Provably-fair RNG seed commit/reveal ledger. PokerBros does not expose this; '
  'we do (Tier E PB-BETTER-1). Engine writes seed_commit_sha256 before deal, '
  'updates seed_plaintext after hand resolution. Players verify shuffle '
  'reproducibility by re-running Fisher-Yates with the revealed seed.';
