-- ═══════════════════════════════════════════════════════════════════════════
--  CLUSTER RUNTIME, PART 1 OF 2: COLUMNS AND TABLES (Slice 2, 2026-09-05)
-- ═══════════════════════════════════════════════════════════════════════════
-- Split from the functions on purpose: an ALTER TABLE on public.tables takes
-- an ACCESS EXCLUSIVE lock, and a transaction that holds it while a probe
-- runs its scenarios parks every reader of tables (the engine, PostgREST)
-- behind it. Part 2 is functions only and can be probed inside a
-- rolled-back transaction without touching that lock.
--
-- THREE transactions, not one (measured 2026-09-05, twice): public.tables is
-- in the realtime publication, so an ALTER on it asks for an exclusive lock
-- on realtime's `subscription` relation while a live realtime worker holds
-- `subscription` and is waiting to read `tables` - a deadlock that Postgres
-- resolves by killing the migration. Holding the tables lock across a second
-- ALTER (cash_games) or the FK-creating CREATE TABLEs widens that window, so
-- each lock is taken, used and released on its own, with a lock_timeout so
-- the migration never queues behind readers. The apply script retries a
-- transaction that loses the race; every statement is IF NOT EXISTS.
BEGIN;
SET LOCAL lock_timeout = '3s';

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Columns and tables
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.tables
  ADD COLUMN IF NOT EXISTS opened_at            timestamptz,
  ADD COLUMN IF NOT EXISTS live_at              timestamptz,
  ADD COLUMN IF NOT EXISTS break_started_at     timestamptz,
  ADD COLUMN IF NOT EXISTS break_eligible_since timestamptz,
  ADD COLUMN IF NOT EXISTS promote_pending      boolean NOT NULL DEFAULT false;

COMMIT;

BEGIN;
SET LOCAL lock_timeout = '3s';
ALTER TABLE public.cash_games
  ADD COLUMN IF NOT EXISTS opening_hold_since timestamptz,
  ADD COLUMN IF NOT EXISTS last_tick_at       timestamptz,
  ADD COLUMN IF NOT EXISTS last_tick_actions  jsonb;

COMMIT;

BEGIN;
SET LOCAL lock_timeout = '3s';
-- A planned seat move. The controller plans; the engine executes at the
-- player's next hand boundary; expiry is thawed with the platform (18.5).
CREATE TABLE IF NOT EXISTS public.cash_seat_moves (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id        uuid NOT NULL REFERENCES public.cash_games(id) ON DELETE CASCADE,
  player_id      uuid NOT NULL,
  from_table_id  uuid NOT NULL REFERENCES public.tables(id) ON DELETE CASCADE,
  to_table_id    uuid NOT NULL REFERENCES public.tables(id) ON DELETE CASCADE,
  reason         text NOT NULL CHECK (reason IN ('must_move', 'break')),
  state          text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'cancelled', 'expired')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL DEFAULT now() + interval '60 seconds',
  executed_at    timestamptz,
  to_seat_number integer,
  note           text
);
CREATE UNIQUE INDEX IF NOT EXISTS cash_seat_moves_one_pending_per_player
  ON public.cash_seat_moves (player_id) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS cash_seat_moves_pending_by_from
  ON public.cash_seat_moves (from_table_id) WHERE state = 'pending';
ALTER TABLE public.cash_seat_moves ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cash_seat_moves_read_own ON public.cash_seat_moves;
CREATE POLICY cash_seat_moves_read_own ON public.cash_seat_moves FOR SELECT TO authenticated
  USING (player_id = auth.uid());
REVOKE ALL ON public.cash_seat_moves FROM anon;
GRANT SELECT ON public.cash_seat_moves TO authenticated;
GRANT ALL ON public.cash_seat_moves TO service_role;

-- The cluster waitlist: a buyer for the GAME, not a table (18.3). Gate 4
-- gives it a client; today only its count matters to the open rule.
CREATE TABLE IF NOT EXISTS public.cash_game_waitlist (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id     uuid NOT NULL REFERENCES public.cash_games(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,
  status      text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'notified', 'seated', 'cancelled', 'expired')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS cash_game_waitlist_one_open
  ON public.cash_game_waitlist (game_id, user_id) WHERE status IN ('waiting', 'notified');
ALTER TABLE public.cash_game_waitlist ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cash_game_waitlist_read_own ON public.cash_game_waitlist;
CREATE POLICY cash_game_waitlist_read_own ON public.cash_game_waitlist FOR SELECT TO authenticated
  USING (user_id = auth.uid());
REVOKE ALL ON public.cash_game_waitlist FROM anon;
GRANT SELECT ON public.cash_game_waitlist TO authenticated;
GRANT ALL ON public.cash_game_waitlist TO service_role;

-- Every transition the controller makes, as it made it. Read by the lobby
-- and by the acceptance probe; never by the controller itself (no memory).
CREATE TABLE IF NOT EXISTS public.cash_cluster_events (
  id        bigserial PRIMARY KEY,
  game_id   uuid NOT NULL,
  table_id  uuid,
  kind      text NOT NULL,
  payload   jsonb NOT NULL DEFAULT '{}'::jsonb,
  at        timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS cash_cluster_events_by_game ON public.cash_cluster_events (game_id, at DESC);
ALTER TABLE public.cash_cluster_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cash_cluster_events FROM anon, authenticated;
GRANT ALL ON public.cash_cluster_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.cash_cluster_events_id_seq TO service_role;

COMMIT;
