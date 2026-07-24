-- ═══════════════════════════════════════════════════════════════════════════════
--  TOURNEY AUDIT — SWEEP 6 : Satellites + Cash-Game Waitlist
-- ═══════════════════════════════════════════════════════════════════════════════
--  Applied to production (PokerIQ-Production, kuklfnapbkmacvwxktbh) as migration
--  `tourney_audit_sweep6_satellite_and_waitlist`. This file is the repo record of
--  that already-applied change; it is written idempotently so re-applying it in a
--  fresh environment reproduces the live schema exactly.
--
--  WHAT THIS ADDS
--    1. tournaments.satellite_target_id — the tournament a satellite feeds into.
--       The engine (GameServer.processSatelliteAwards) auto-registers top finishers
--       into this target tournament (or pays ticket-value cash when the target is
--       closed/missing), and eliminatePlayer/finishTournament skip per-elimination
--       and winner cash payouts for satellite events (variant='satellite').
--    2. public.table_waitlists — FIFO waitlist for CASH tables ONLY. Tournament /
--       SNG / Spin seating is handled entirely by the engine (late-reg seating +
--       table spawn/redraw), so waitlist rows are never created for tournament
--       tables. On a cash seat opening, the engine
--       (server supabase.ts → notifyWaitlistSeatOpen) claims the oldest 'waiting'
--       row via CAS → 'notified' and inserts a 'waitlist_seat_open' notification.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1. Satellite target link ──────────────────────────────────────────────────
ALTER TABLE public.tournaments
  ADD COLUMN IF NOT EXISTS satellite_target_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tournaments_satellite_target_id_fkey'
  ) THEN
    ALTER TABLE public.tournaments
      ADD CONSTRAINT tournaments_satellite_target_id_fkey
      FOREIGN KEY (satellite_target_id) REFERENCES public.tournaments(id);
  END IF;
END $$;

-- ── 2. Cash-game waitlist table ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.table_waitlists (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id    uuid NOT NULL REFERENCES public.tables(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  status      text NOT NULL DEFAULT 'waiting'
);

-- Status domain.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'table_waitlists_status_check'
  ) THEN
    ALTER TABLE public.table_waitlists
      ADD CONSTRAINT table_waitlists_status_check
      CHECK (status = ANY (ARRAY['waiting','notified','seated','cancelled','expired']));
  END IF;
END $$;

-- One active/any row per (table,user).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'table_waitlists_table_id_user_id_key'
  ) THEN
    ALTER TABLE public.table_waitlists
      ADD CONSTRAINT table_waitlists_table_id_user_id_key UNIQUE (table_id, user_id);
  END IF;
END $$;

-- FIFO lookup by table + partial index for a user's active waitlists.
CREATE INDEX IF NOT EXISTS idx_table_waitlists_table_status
  ON public.table_waitlists USING btree (table_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_table_waitlists_user
  ON public.table_waitlists USING btree (user_id)
  WHERE (status = ANY (ARRAY['waiting','notified']));

-- ── 3. RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE public.table_waitlists ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS table_waitlists_select ON public.table_waitlists;
CREATE POLICY table_waitlists_select ON public.table_waitlists
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS table_waitlists_insert_own ON public.table_waitlists;
CREATE POLICY table_waitlists_insert_own ON public.table_waitlists
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS table_waitlists_update_own ON public.table_waitlists;
CREATE POLICY table_waitlists_update_own ON public.table_waitlists
  FOR UPDATE TO authenticated USING (auth.uid() = user_id);
