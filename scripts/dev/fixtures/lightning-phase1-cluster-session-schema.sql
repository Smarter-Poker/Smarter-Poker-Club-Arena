-- Isolated PostgreSQL contract fixture, never a production migration.
--
-- The PRE-migration shape of everything 20260920172736 touches, so that the
-- Lightning Phase 1 migration genuinely ALTERS something when it is applied on
-- top of this file: cash_games WITHOUT cluster_mode / lightning_enabled /
-- cluster_epoch, cash_player_session WITHOUT cluster_id, and the installed
-- three-argument fn_cash_session_open whose INSERT does not carry the cluster.
--
-- Columns no reader under test touches are omitted. CONSTRAINTS ARE NOT: the
-- session row carries the real scope_type CHECK, the real table_id NOT NULL,
-- the three floor CHECKs and the real cash_player_session_one_open partial
-- unique index (20260904120000 chip continuity slice 0), because those are
-- exactly the things a column addition and a backfill could break.

-- Supabase's grant targets. The migration REVOKEs from anon/authenticated and
-- GRANTs to service_role, so all three must exist. Guarded, so re-running the
-- fixture against a cluster that already has them is not an error.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. THE CLUSTER (20260904160500 slice 1, + must_move from 20260904230000)
-- ─────────────────────────────────────────────────────────────────────────────
-- ruleset_snapshot is read by fn_cash_session_open to RAISE the two clocks;
-- must_move, enabled and handedness are read by the new lightning-state reader.
-- cluster_mode, lightning_enabled and cluster_epoch are deliberately ABSENT.

CREATE TABLE public.cash_games (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id          uuid NOT NULL,
  name             text NOT NULL,
  variant          text NOT NULL,
  sb               numeric(14,2) NOT NULL CHECK (sb > 0),
  bb               numeric(14,2) NOT NULL CHECK (bb > sb),
  handedness       integer NOT NULL CHECK (handedness BETWEEN 2 AND 9),
  ruleset_snapshot jsonb NOT NULL,
  enabled          boolean NOT NULL DEFAULT true,
  state            text NOT NULL DEFAULT 'live' CHECK (state IN ('live', 'dormant')),
  must_move        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. THE TABLE (tables.cluster_id, 20260904160500 slice 1 line 85)
-- ─────────────────────────────────────────────────────────────────────────────
-- cluster_id is the backfill's only source of truth, and it is NULLABLE in
-- production: a cash table outside a cluster has none. Both cases are seeded.

CREATE TABLE public.tables (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id       uuid,
  game_variant  text,
  small_blind   numeric(14,2),
  big_blind     numeric(14,2),
  tournament_id uuid,
  cluster_id    uuid REFERENCES public.cash_games(id),
  role          text CHECK (role IN ('main', 'feeder')),
  main_index    integer CHECK (main_index >= 1),
  lifecycle     text CHECK (lifecycle IN ('opening', 'live', 'breaking', 'closed'))
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. THE PHYSICAL CHAIR
-- ─────────────────────────────────────────────────────────────────────────────
-- Nothing under test reads table_seats. It is here because Phase 1's whole
-- argument is that the chair still holds the chips and still closes the
-- session (cash_player_session.table_id stays NOT NULL), so a fixture that
-- omitted the chair would be asserting continuity for a session with nowhere
-- to sit. The two production keys are carried for the same reason.

CREATE TABLE public.table_seats (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id    uuid NOT NULL REFERENCES public.tables(id) ON DELETE CASCADE,
  user_id     uuid,
  seat_number integer,
  stack       numeric(14,2),
  joined_at   timestamptz NOT NULL DEFAULT now(),
  left_at     timestamptz,
  CONSTRAINT table_seats_table_id_seat_number_key UNIQUE (table_id, seat_number)
);

CREATE UNIQUE INDEX idx_unique_active_user_per_table
  ON public.table_seats (table_id, user_id)
  WHERE left_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. THE CONTINUOUS CASH SESSION (20260904120000 chip continuity slice 0)
-- ─────────────────────────────────────────────────────────────────────────────
-- Verbatim pre-migration shape. cluster_id is ABSENT: the migration adds it.

CREATE TABLE public.cash_player_session (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id         uuid NOT NULL,
  club_id           uuid,
  scope_type        text NOT NULL CHECK (scope_type IN ('table', 'cluster')),
  scope_id          uuid NOT NULL,
  table_id          uuid NOT NULL,
  variant           text,
  sb                numeric(14,2),
  bb                numeric(14,2),
  baseline          numeric(14,2) NOT NULL DEFAULT 0,
  stay_clock_ms     integer NOT NULL DEFAULT 600000,
  rejoin_window_ms  integer NOT NULL DEFAULT 7200000,
  stay_remaining_ms integer NOT NULL DEFAULT 600000,
  stay_running      boolean NOT NULL DEFAULT false,
  stay_last_tick_at timestamptz NOT NULL DEFAULT now(),
  opened_at         timestamptz NOT NULL DEFAULT now(),
  closed_at         timestamptz,
  closed_reason     text,
  CONSTRAINT cash_player_session_clock_floor CHECK (stay_clock_ms >= 600000),
  CONSTRAINT cash_player_session_window_floor CHECK (rejoin_window_ms >= 7200000),
  CONSTRAINT cash_player_session_remaining_nonneg CHECK (stay_remaining_ms >= 0)
);

-- The ON CONFLICT inference target of fn_cash_session_open. One open row per
-- player per scope: the reason a Phase 1 that opened a SECOND economic
-- identity would be caught here rather than in production.
CREATE UNIQUE INDEX cash_player_session_one_open
  ON public.cash_player_session (player_id, scope_type, scope_id)
  WHERE closed_at IS NULL;

CREATE INDEX cash_player_session_open_by_table
  ON public.cash_player_session (table_id)
  WHERE closed_at IS NULL;

REVOKE ALL ON public.cash_player_session FROM anon, authenticated;
GRANT ALL ON public.cash_player_session TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. THE INSTALLED OPEN PATH (20260904160500), WITHOUT THE CLUSTER
-- ─────────────────────────────────────────────────────────────────────────────
-- Byte-identical to the body quoted in section 4 of the migration under test,
-- minus the two cluster_id additions to the INSERT. It already SELECTs
-- t.cluster_id, because it has always needed the game's snapshot to raise the
-- two clocks; it simply never stored it. That is the whole delta being proved.

CREATE OR REPLACE FUNCTION public.fn_cash_session_open(p_user_id uuid, p_table_id uuid, p_buy_in numeric)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_t record; v_id uuid; v_stay integer := 600000; v_rejoin integer := 7200000; v_snap jsonb;
BEGIN
  SELECT t.id, t.club_id, t.game_variant, t.small_blind, t.big_blind, t.tournament_id, t.cluster_id
    INTO v_t FROM public.tables t WHERE t.id = p_table_id;
  IF NOT FOUND OR v_t.tournament_id IS NOT NULL THEN RETURN NULL; END IF;

  -- A game's snapshot may RAISE the two clocks (never lower: CHECK floors on
  -- the session row and the create function both refuse it).
  IF v_t.cluster_id IS NOT NULL THEN
    SELECT g.ruleset_snapshot INTO v_snap FROM public.cash_games g WHERE g.id = v_t.cluster_id;
    IF v_snap IS NOT NULL THEN
      v_stay   := GREATEST(600000,  coalesce((v_snap->>'stay_clock_min')::integer, 10) * 60000);
      v_rejoin := GREATEST(7200000, coalesce((v_snap->>'rejoin_window_min')::integer, 120) * 60000);
    END IF;
  END IF;

  IF p_buy_in IS NOT NULL THEN
    UPDATE public.cash_player_session
       SET closed_at = clock_timestamp(), closed_reason = 'stale_on_reopen'
     WHERE player_id = p_user_id AND scope_type = 'table' AND scope_id = p_table_id
       AND closed_at IS NULL;
  END IF;

  INSERT INTO public.cash_player_session
    (player_id, club_id, scope_type, scope_id, table_id, variant, sb, bb, baseline,
     stay_clock_ms, rejoin_window_ms, stay_remaining_ms, stay_running, stay_last_tick_at, opened_at)
  VALUES
    (p_user_id, v_t.club_id, 'table', p_table_id, p_table_id, v_t.game_variant,
     v_t.small_blind, v_t.big_blind, GREATEST(COALESCE(p_buy_in, 0), 0),
     v_stay, v_rejoin, v_stay, false, clock_timestamp(), clock_timestamp())
  ON CONFLICT (player_id, scope_type, scope_id) WHERE closed_at IS NULL DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.cash_player_session
     WHERE player_id = p_user_id AND scope_type = 'table' AND scope_id = p_table_id
       AND closed_at IS NULL;
  END IF;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_cash_session_open(uuid, uuid, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_session_open(uuid, uuid, numeric) TO service_role;
