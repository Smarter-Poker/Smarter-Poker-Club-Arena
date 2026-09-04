-- ═══════════════════════════════════════════════════════════════════════════════
--  CHIP CONTINUITY - OPERATION TABLE STAKES, SLICE 0 (OPORD 1.3 section 6,
--  OPORD 1.4 sections 2.5 and 18.5). 2026-09-04.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- HOUSE LAW, ALL CASH, NO FLAG:
--   * chips that hit a cash table stay on it until the player leaves (no
--     partial removal - atomic_table_withdraw is DROPPED);
--   * a player ahead of the money they put in stays seated for 10 minutes
--     before they can leave (the stay clock);
--   * a player who leaves a game with chips must return to the same game in
--     the same club within 2 hours with at least the stack they left with
--     (the rejoin floor). Same game = club + variant + sb + bb. Table id and
--     template name are NOT in the key (invariant I8).
--
-- WHY THE CLOCK LIVES HERE AND NOT IN ENGINE MEMORY
--   The engine restarts at :55 of every hour (CLAUDE.md section 13). A clock
--   kept only in process memory resets on every restart - the exact defect
--   that made the five-minute sit-out eviction never fire (see the header of
--   ServerTableEngineBase.restoreSitOutsFromSeats). So the session row holds
--   `stay_remaining_ms` AS OF `stay_last_tick_at` plus `stay_running`; the
--   effective remainder is derived on read and the row is written only on a
--   transition. fn_thaw_platform shifts `stay_last_tick_at` by the frozen
--   minutes so the break never eats a player's clock (section 13 rule 4).
--
-- THE FLOOR IT REPLACES
--   atomic_table_buyin carried a per-table opt-in floor (tables.no_rathole,
--   keyed to the table and the player's last seat there). It fails I8 twice
--   and was on for 15 of 247 live tables. The block is removed; the column is
--   left in place (it is read by lobby code and a nightly manifest) and is
--   dropped by the Slice 6 cutover migration. There is ONE floor now.
--
-- WHO IS ENFORCED AT THE CASH-OUT DOOR
--   atomic_seat_cashout_locked gains p_leave_mode ('voluntary' | 'forced' |
--   NULL). A browser caller (auth.uid() set) is ALWAYS checked - a forged
--   cash-out while the clock runs is refused (A0.16). The engine is checked
--   when it says 'voluntary' (POST /leave, a horse rotator departure,
--   leave_pending at settlement). NULL from the engine is a system exit -
--   eviction, table close, bust, stale-seat sweep - and is not a leave the
--   player chose; it still closes the session and still writes the rejoin
--   floor if chips left with them. Adding the parameter is an overload change
--   (Tier 3): the three-argument signature is dropped so PostgREST sees one
--   candidate.
--
-- HORSES ARE PLAYERS (CLAUDE.md 10.5). Every function here is horse-blind:
--   fn_horse_seat_from_treasury applies the same floor and opens the same
--   session; fn_horse_fund_from_treasury raises the same baseline. Nothing in
--   this file reads the horse flag.
--
-- md5(prosrc) of every live body replaced (read 2026-09-04 from pg_proc):
--   atomic_table_buyin                 0acaea38f7ede1b484cdcd44f7ed1a4f
--   atomic_seat_cashout_locked         3eacd9f31525e623b1e8ff100fc31600
--   atomic_table_addon                 10d867879204f57a1192138d01c783be
--   resolve_pending_addon              08f176c6e4209b36200d1ac2e86c95c8
--   fn_horse_fund_from_treasury        d5b9eeb6be04f9267b9ce40709482372
--   fn_horse_seat_from_treasury        97d639533904d377c3568e99e67fa246
--   fn_cashout_seats_for_closing_table 197c05e8c940c7c7f9d595f72d504d8b
--   player_leave_table                 736a98dd1f5666a88ed42a4ba194a571
--   fn_thaw_platform                   cb0c989146d7280ce9180a365f34f00f
--   atomic_table_withdraw (dropped)    80a75b21109a84413ad6425fe0477e91
--
-- ONE TRANSACTION (production DDL policy, CLAUDE.md section 2).
--
-- ROLLBACK: re-create the ten bodies above from the migrations that last
--   defined them (20260826_buyin_idempotency_*, 20260901002242_*,
--   20260902174500_*, 20260902233000_*), DROP the two tables and the eight
--   fn_cash_* functions. Constraint rows are advisory data and lose nothing.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. TABLES
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.cash_player_session (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id         uuid NOT NULL,
  club_id           uuid,
  -- Slice 0: 'table' with scope_id = table_id. The Slice 6 cutover rewrites
  -- every open row to 'cluster'. A move inside a cluster never touches this row.
  scope_type        text NOT NULL CHECK (scope_type IN ('table', 'cluster')),
  scope_id          uuid NOT NULL,
  table_id          uuid NOT NULL,
  variant           text,
  sb                numeric(14,2),
  bb                numeric(14,2),
  -- I3: money put onto THIS session (buy-in + add-ons applied to the seat).
  -- Never goes down.
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

CREATE UNIQUE INDEX IF NOT EXISTS cash_player_session_one_open
  ON public.cash_player_session (player_id, scope_type, scope_id)
  WHERE closed_at IS NULL;

CREATE INDEX IF NOT EXISTS cash_player_session_open_by_table
  ON public.cash_player_session (table_id)
  WHERE closed_at IS NULL;

CREATE TABLE IF NOT EXISTS public.cash_rejoin_constraints (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id      uuid NOT NULL,
  club_id        uuid NOT NULL,
  variant        text NOT NULL,
  sb             numeric(14,2) NOT NULL,
  bb             numeric(14,2) NOT NULL,
  required_stack numeric(14,2) NOT NULL CHECK (required_stack > 0),
  left_at        timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  source_table_id uuid
);

CREATE INDEX IF NOT EXISTS cash_rejoin_constraints_lookup
  ON public.cash_rejoin_constraints (player_id, club_id, variant, sb, bb, expires_at);

ALTER TABLE public.cash_player_session   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_rejoin_constraints ENABLE ROW LEVEL SECURITY;
-- No browser policies on purpose: the engine (service_role) writes, the
-- SECURITY DEFINER functions below read on the player's behalf. Nothing the
-- client renders comes from a direct table read.
REVOKE ALL ON public.cash_player_session   FROM anon, authenticated;
REVOKE ALL ON public.cash_rejoin_constraints FROM anon, authenticated;
GRANT ALL ON public.cash_player_session   TO service_role;
GRANT ALL ON public.cash_rejoin_constraints TO service_role;

COMMENT ON TABLE public.cash_player_session IS
  'Chip continuity (OPORD 1.3 s6). One open row per player per scope. stay_remaining_ms is as of stay_last_tick_at; derive with fn_cash_stay_remaining_ms.';
COMMENT ON TABLE public.cash_rejoin_constraints IS
  'Chip continuity rejoin floor. Key = player + club + variant + sb + bb. Table id and template name are deliberately absent (invariant I8).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. PURE HELPERS
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_cash_stay_remaining_ms(
  p_remaining integer, p_running boolean, p_last_tick timestamptz
) RETURNS integer
LANGUAGE sql
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT CASE
    WHEN COALESCE(p_running, false)
      THEN GREATEST(0, COALESCE(p_remaining, 0)
             - FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - COALESCE(p_last_tick, clock_timestamp()))) * 1000)::integer)
    ELSE GREATEST(0, COALESCE(p_remaining, 0))
  END;
$$;

-- The effective floor for THIS player at THIS table, or NULL when none applies.
-- Different club, variant or blinds -> NULL (A0.8, A0.9, A0.10).
CREATE OR REPLACE FUNCTION public.fn_cash_rejoin_floor(p_user_id uuid, p_table_id uuid)
RETURNS numeric
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT MAX(c.required_stack)
    FROM public.tables t
    JOIN public.cash_rejoin_constraints c
      ON c.player_id = p_user_id
     AND c.club_id  = t.club_id
     AND c.variant  = t.game_variant
     AND c.sb       = t.small_blind
     AND c.bb       = t.big_blind
     AND c.expires_at > now()
   WHERE t.id = p_table_id
     AND t.tournament_id IS NULL;
$$;

-- What the buy-in modal renders. min already includes the floor and the
-- table max cap (I7). floor_applied tells the client the number moved; it
-- says nothing about why (section 6.1: no paragraph about why).
CREATE OR REPLACE FUNCTION public.fn_cash_effective_buyin(p_table_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_min numeric; v_max numeric; v_bb numeric; v_floor numeric; v_eff numeric;
BEGIN
  SELECT t.min_buy_in, t.max_buy_in, t.big_blind INTO v_min, v_max, v_bb
    FROM public.tables t WHERE t.id = p_table_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');
  END IF;
  IF COALESCE(v_min, 0) <= 0 THEN v_min := COALESCE(v_bb, 0) * 40; END IF;
  IF COALESCE(v_max, 0) <= 0 THEN v_max := COALESCE(v_bb, 0) * 200; END IF;
  v_eff := v_min;
  IF v_uid IS NOT NULL THEN
    v_floor := public.fn_cash_rejoin_floor(v_uid, p_table_id);
    IF v_floor IS NOT NULL THEN
      v_eff := GREATEST(v_min, v_floor);
      IF v_max > 0 THEN v_eff := LEAST(v_eff, v_max); END IF;
    END IF;
  END IF;
  RETURN jsonb_build_object('ok', true, 'min', v_eff, 'max', v_max,
                            'table_min', v_min, 'floor_applied', v_floor IS NOT NULL AND v_eff > v_min);
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_cash_effective_buyin(uuid) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. SESSION LIFECYCLE (engine and definer-internal only)
-- ─────────────────────────────────────────────────────────────────────────────

-- Called by every seat creator once the seat row exists. Cash only.
CREATE OR REPLACE FUNCTION public.fn_cash_session_open(p_user_id uuid, p_table_id uuid, p_buy_in numeric)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_t record; v_id uuid;
BEGIN
  SELECT t.id, t.club_id, t.game_variant, t.small_blind, t.big_blind, t.tournament_id
    INTO v_t FROM public.tables t WHERE t.id = p_table_id;
  IF NOT FOUND OR v_t.tournament_id IS NOT NULL THEN RETURN NULL; END IF;

  -- A row still open here means the seat left without closing (a crash, a
  -- direct seat delete). It carries nothing a fresh buy-in should inherit.
  UPDATE public.cash_player_session
     SET closed_at = now(), closed_reason = 'stale_on_reopen'
   WHERE player_id = p_user_id AND scope_type = 'table' AND scope_id = p_table_id
     AND closed_at IS NULL;

  INSERT INTO public.cash_player_session
    (player_id, club_id, scope_type, scope_id, table_id, variant, sb, bb, baseline,
     stay_remaining_ms, stay_running, stay_last_tick_at)
  VALUES
    (p_user_id, v_t.club_id, 'table', p_table_id, p_table_id, v_t.game_variant,
     v_t.small_blind, v_t.big_blind, GREATEST(COALESCE(p_buy_in, 0), 0),
     600000, false, now())
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Money APPLIED to the seat (never a pending add-on: baseline moves when the
-- chips land, or a debited-but-undelivered add-on could unlock a leave).
CREATE OR REPLACE FUNCTION public.fn_cash_session_add_baseline(p_user_id uuid, p_table_id uuid, p_amount numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_s record; v_stack numeric; v_rem integer;
BEGIN
  IF COALESCE(p_amount, 0) <= 0 THEN RETURN; END IF;
  SELECT * INTO v_s FROM public.cash_player_session
   WHERE player_id = p_user_id AND scope_type = 'table' AND scope_id = p_table_id
     AND closed_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT ts.stack INTO v_stack FROM public.table_seats ts
   WHERE ts.table_id = p_table_id AND ts.user_id = p_user_id AND ts.left_at IS NULL
   LIMIT 1;

  -- Settle the clock to now, raise the baseline, and pause if no longer ahead.
  -- The remainder is kept (dip-and-recover never resets to 10:00).
  v_rem := public.fn_cash_stay_remaining_ms(v_s.stay_remaining_ms, v_s.stay_running, v_s.stay_last_tick_at);
  UPDATE public.cash_player_session
     SET baseline          = baseline + p_amount,
         stay_remaining_ms = v_rem,
         stay_last_tick_at = now(),
         stay_running      = (v_s.stay_running AND COALESCE(v_stack, 0) > (v_s.baseline + p_amount) AND v_rem > 0)
   WHERE id = v_s.id;
END;
$$;

-- The engine's transition hook. p_entries: [{user_id, stack?, active}].
--   active = seated AND not sitting out AND connected AND not pending a move.
-- Settles elapsed time, then: running := active AND stack > baseline AND
-- remaining > 0. A player with no session (seated before this migration, or
-- seated through a path that predates it) gets one with baseline = stack now,
-- so nobody can be locked for chips they did not win from here on.
CREATE OR REPLACE FUNCTION public.fn_cash_session_evaluate(p_table_id uuid, p_entries jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_t record; v_e jsonb; v_uid uuid; v_active boolean; v_stack numeric;
  v_s record; v_rem integer; v_running boolean; v_out jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'fn_cash_session_evaluate is engine-only';
  END IF;
  SELECT t.id, t.tournament_id INTO v_t FROM public.tables t WHERE t.id = p_table_id;
  IF NOT FOUND OR v_t.tournament_id IS NOT NULL THEN RETURN v_out; END IF;

  FOR v_e IN SELECT * FROM jsonb_array_elements(COALESCE(p_entries, '[]'::jsonb)) LOOP
    BEGIN
      v_uid := (v_e->>'user_id')::uuid;
    EXCEPTION WHEN others THEN CONTINUE;
    END;
    v_active := COALESCE((v_e->>'active')::boolean, false);
    v_stack := NULLIF(v_e->>'stack', '')::numeric;

    IF v_stack IS NULL THEN
      SELECT ts.stack INTO v_stack FROM public.table_seats ts
       WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL LIMIT 1;
      IF v_stack IS NULL THEN CONTINUE; END IF;   -- not seated: nothing to evaluate
    ELSIF NOT EXISTS (SELECT 1 FROM public.table_seats ts
                       WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL) THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_s FROM public.cash_player_session
     WHERE player_id = v_uid AND scope_type = 'table' AND scope_id = p_table_id AND closed_at IS NULL
     FOR UPDATE;
    IF NOT FOUND THEN
      PERFORM public.fn_cash_session_open(v_uid, p_table_id, v_stack);
      SELECT * INTO v_s FROM public.cash_player_session
       WHERE player_id = v_uid AND scope_type = 'table' AND scope_id = p_table_id AND closed_at IS NULL;
      IF NOT FOUND THEN CONTINUE; END IF;
    END IF;

    v_rem := public.fn_cash_stay_remaining_ms(v_s.stay_remaining_ms, v_s.stay_running, v_s.stay_last_tick_at);
    v_running := v_active AND v_stack > v_s.baseline AND v_rem > 0;

    UPDATE public.cash_player_session
       SET stay_remaining_ms = v_rem,
           stay_last_tick_at = now(),
           stay_running      = v_running
     WHERE id = v_s.id;

    v_out := v_out || jsonb_build_object(
      'user_id', v_uid, 'baseline', v_s.baseline, 'stack', v_stack,
      'stay_remaining_ms', v_rem, 'stay_running', v_running,
      'stay_last_tick_at', now(), 'stay_clock_ms', v_s.stay_clock_ms,
      'leave_locked', (v_stack > v_s.baseline AND v_rem > 0));
  END LOOP;
  RETURN v_out;
END;
$$;

-- I5. Read-only. locked = in_profit AND remaining > 0, whether or not the
-- clock is currently running (a sat-out player who is up is still locked).
CREATE OR REPLACE FUNCTION public.fn_cash_leave_check(p_user_id uuid, p_table_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_s record; v_stack numeric; v_rem integer; v_locked boolean;
BEGIN
  SELECT * INTO v_s FROM public.cash_player_session
   WHERE player_id = p_user_id AND scope_type = 'table' AND scope_id = p_table_id AND closed_at IS NULL;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('allowed', true, 'stay_remaining_ms', 0);
  END IF;
  SELECT ts.stack INTO v_stack FROM public.table_seats ts
   WHERE ts.table_id = p_table_id AND ts.user_id = p_user_id AND ts.left_at IS NULL LIMIT 1;
  v_rem := public.fn_cash_stay_remaining_ms(v_s.stay_remaining_ms, v_s.stay_running, v_s.stay_last_tick_at);
  v_locked := COALESCE(v_stack, 0) > v_s.baseline AND v_rem > 0;
  RETURN jsonb_build_object(
    'allowed', NOT v_locked,
    'code', CASE WHEN v_locked THEN 'LEAVE_LOCKED' ELSE NULL END,
    'stay_remaining_ms', CASE WHEN v_locked THEN v_rem ELSE 0 END,
    'baseline', v_s.baseline, 'stack', COALESCE(v_stack, 0));
END;
$$;

-- Close on a REAL leave. Writes the rejoin floor iff chips left with the
-- player (I6). Existing unexpired row on the same key: max of both stacks,
-- max of both expiries.
CREATE OR REPLACE FUNCTION public.fn_cash_session_close(p_user_id uuid, p_table_id uuid, p_stack numeric, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_t record; v_s record; v_window integer := 7200000; v_exp timestamptz; v_c record;
BEGIN
  SELECT t.club_id, t.game_variant, t.small_blind, t.big_blind, t.tournament_id
    INTO v_t FROM public.tables t WHERE t.id = p_table_id;
  IF NOT FOUND OR v_t.tournament_id IS NOT NULL THEN RETURN; END IF;

  UPDATE public.cash_player_session
     SET closed_at = now(), closed_reason = COALESCE(p_reason, 'leave')
   WHERE player_id = p_user_id AND scope_type = 'table' AND scope_id = p_table_id AND closed_at IS NULL
   RETURNING * INTO v_s;
  IF FOUND THEN v_window := COALESCE(v_s.rejoin_window_ms, 7200000); END IF;

  IF COALESCE(p_stack, 0) <= 0 THEN RETURN; END IF;             -- bust-to-zero: no floor (A0.11)
  IF v_t.club_id IS NULL OR v_t.game_variant IS NULL
     OR v_t.small_blind IS NULL OR v_t.big_blind IS NULL THEN RETURN; END IF;

  v_exp := now() + make_interval(secs => v_window / 1000.0);

  SELECT * INTO v_c FROM public.cash_rejoin_constraints c
   WHERE c.player_id = p_user_id AND c.club_id = v_t.club_id AND c.variant = v_t.game_variant
     AND c.sb = v_t.small_blind AND c.bb = v_t.big_blind AND c.expires_at > now()
   ORDER BY c.expires_at DESC LIMIT 1
   FOR UPDATE;
  IF FOUND THEN
    UPDATE public.cash_rejoin_constraints
       SET required_stack = GREATEST(required_stack, p_stack),
           expires_at     = GREATEST(expires_at, v_exp),
           left_at        = now(),
           source_table_id = p_table_id
     WHERE id = v_c.id;
  ELSE
    INSERT INTO public.cash_rejoin_constraints
      (player_id, club_id, variant, sb, bb, required_stack, left_at, expires_at, source_table_id)
    VALUES (p_user_id, v_t.club_id, v_t.game_variant, v_t.small_blind, v_t.big_blind,
            p_stack, now(), v_exp, p_table_id);
  END IF;
END;
$$;

-- Functions are EXECUTE-to-PUBLIC by default; these are engine / definer-internal.
REVOKE ALL ON FUNCTION public.fn_cash_session_open(uuid, uuid, numeric)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_cash_session_add_baseline(uuid, uuid, numeric)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_cash_session_evaluate(uuid, jsonb)              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_cash_leave_check(uuid, uuid)                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_cash_session_close(uuid, uuid, numeric, text)   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_cash_rejoin_floor(uuid, uuid)                   FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_cash_rejoin_floor(uuid, uuid)               TO service_role;
GRANT  EXECUTE ON FUNCTION public.fn_cash_session_evaluate(uuid, jsonb)              TO service_role;
GRANT  EXECUTE ON FUNCTION public.fn_cash_leave_check(uuid, uuid)                    TO service_role;
GRANT  EXECUTE ON FUNCTION public.fn_cash_session_open(uuid, uuid, numeric)          TO service_role;
GRANT  EXECUTE ON FUNCTION public.fn_cash_session_add_baseline(uuid, uuid, numeric)  TO service_role;
GRANT  EXECUTE ON FUNCTION public.fn_cash_session_close(uuid, uuid, numeric, text)   TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. THE CASH-OUT DOOR: atomic_seat_cashout_locked gains p_leave_mode
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.atomic_seat_cashout_locked(uuid, uuid, integer);

CREATE OR REPLACE FUNCTION public.atomic_seat_cashout_locked(
  p_user_id uuid, p_table_id uuid, p_seat_number integer DEFAULT NULL::integer,
  p_leave_mode text DEFAULT NULL::text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_seat      record;
  v_stack     numeric;
  v_key       text;
  v_legacy    text;
  v_credited  boolean := false;
  v_seat_rows integer;
  v_tournament uuid;
  v_enforce   boolean;
  v_chk       jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( auth.uid() <> p_user_id)) THEN
    RAISE EXCEPTION 'Cannot cash out for another user';
  END IF;

  IF p_seat_number IS NOT NULL THEN
    SELECT id, stack, joined_at, seat_number INTO v_seat
      FROM table_seats
     WHERE table_id = p_table_id AND user_id = p_user_id
       AND seat_number = p_seat_number AND left_at IS NULL
     FOR UPDATE;
  ELSE
    SELECT id, stack, joined_at, seat_number INTO v_seat
      FROM table_seats
     WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
     ORDER BY joined_at DESC
     LIMIT 1
     FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'stack', 0, 'reason', 'no_active_seat');
  END IF;

  v_stack := COALESCE(v_seat.stack, 0);

  SELECT t.tournament_id INTO v_tournament FROM tables t WHERE t.id = p_table_id;

  /* CHIP CONTINUITY (2026-09-04, OPORD 1.3 s6.4 / I5). A browser caller is
     always checked; the engine is checked when it declares the exit voluntary.
     NULL from the engine is a system exit (eviction, table close, bust,
     sweep) and is never the player's choice. Raised BEFORE any credit, so the
     seat, the stack and the session are untouched by a refusal. */
  v_enforce := v_tournament IS NULL
               AND (NOT public.fn_caller_is_engine() OR p_leave_mode = 'voluntary');
  IF v_enforce THEN
    v_chk := public.fn_cash_leave_check(p_user_id, p_table_id);
    IF NOT COALESCE((v_chk->>'allowed')::boolean, true) THEN
      RAISE EXCEPTION 'LEAVE_LOCKED:%', COALESCE(v_chk->>'stay_remaining_ms', '0')
        USING HINT = 'Leave available when the stay clock reaches zero';
    END IF;
  END IF;

  -- to_json, NOT to_char. See the header: to_char pads microseconds and breaks
  -- dedupe against every key the TypeScript already wrote.
  v_key := CASE
             WHEN v_seat.joined_at IS NOT NULL
               THEN 'cashout:' || v_seat.id || ':' || btrim(to_json(v_seat.joined_at)::text, '"')
             ELSE 'cashout:' || v_seat.id
           END;
  v_legacy := 'cashout:' || v_seat.id;

  /* ZERO-DRIFT (2026-09-01): a tournament-table stack is play chips. The seat
     closes, nothing is credited, and no incident is counted - the mint guard
     downstream stays as defence in depth for any OTHER path. */
  IF v_tournament IS NOT NULL THEN
    v_stack := 0;
    v_credited := false;
  ELSIF v_stack > 0 THEN
    IF EXISTS (SELECT 1 FROM wallet_credit_idempotency WHERE key = v_legacy) THEN
      v_credited := false;
    ELSE
      PERFORM public.atomic_credit_wallet_and_log(
        p_user_id, v_stack, 'cashout', 'Cash-out from table',
        p_table_id, NULL, NULL, v_key
      );
      v_credited := true;
    END IF;
  END IF;

  UPDATE table_seats
     SET left_at = NOW(), leave_pending = false
   WHERE table_id = p_table_id AND user_id = p_user_id
     AND seat_number = v_seat.seat_number AND left_at IS NULL;
  GET DIAGNOSTICS v_seat_rows = ROW_COUNT;

  IF v_seat_rows = 0 THEN
    RAISE EXCEPTION
      'Cash-out could not vacate the locked seat (table %, player %, seat %)',
      p_table_id, p_user_id, v_seat.seat_number;
  END IF;

  /* CHIP CONTINUITY: the session closes with the seat, and the rejoin floor
     is written iff chips left with the player. The stack passed is the one
     this transaction credited, read under the same lock. */
  IF v_tournament IS NULL THEN
    PERFORM public.fn_cash_session_close(p_user_id, p_table_id, v_stack, COALESCE(p_leave_mode, 'system'));
  END IF;

  UPDATE tables
     SET current_players = (
       SELECT count(*) FROM table_seats
        WHERE table_id = p_table_id AND left_at IS NULL)
   WHERE id = p_table_id;

  RETURN jsonb_build_object(
    'ok', true, 'stack', v_stack, 'credited', v_credited,
    'seat_number', v_seat.seat_number, 'idempotency_key', v_key,
    'tournament_table', v_tournament IS NOT NULL);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.atomic_seat_cashout_locked(uuid, uuid, integer, text) TO authenticated, service_role;

-- Two system callers name their mode so an ADMIN closing a table from the
-- browser (auth.uid() set) is not refused by a player's stay clock.
CREATE OR REPLACE FUNCTION public.fn_cashout_seats_for_closing_table(p_table_id uuid, p_reason text DEFAULT 'table closed'::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_is_tournament boolean;
  v_seat          record;
  v_club          uuid;
  v_res           jsonb;
  v_count         int := 0;
  v_total         numeric := 0;
BEGIN
  IF p_table_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'p_table_id required');
  END IF;

  SELECT (t.tournament_id IS NOT NULL) INTO v_is_tournament
    FROM public.tables t WHERE t.id = p_table_id;

  IF v_is_tournament IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');
  END IF;

  IF v_is_tournament THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'tournament_table');
  END IF;

  FOR v_seat IN
    SELECT id, user_id, seat_number, stack, club_id
      FROM public.table_seats
     WHERE table_id = p_table_id
       AND left_at IS NULL
       AND user_id IS NOT NULL
       AND COALESCE(stack, 0) > 0
     FOR UPDATE
  LOOP
    v_club := v_seat.club_id;
    IF v_club IS NULL THEN
      v_club := public.fn_player_home_club(v_seat.user_id, NULL);
    END IF;

    IF v_club IS NULL THEN
      CONTINUE;
    END IF;

    PERFORM public.fn_ensure_club_wallet(v_seat.user_id, v_club);

    PERFORM public.fn_ca_declare_ledger('table_cashout', 'table_stack', p_table_id);

    -- CHIP CONTINUITY: a table close is a system exit, never the player's choice.
    v_res := public.atomic_seat_cashout_locked(v_seat.user_id, p_table_id, v_seat.seat_number, 'forced');

    IF COALESCE((v_res->>'credited')::boolean, false) THEN
      v_count := v_count + 1;
      v_total := v_total + COALESCE((v_res->>'stack')::numeric, 0);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'players_paid', v_count, 'chips_returned', v_total,
                            'reason_text', COALESCE(p_reason, 'table closed'));
END;
$function$;

CREATE OR REPLACE FUNCTION public.player_leave_table(p_table_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_seat_number   integer;
  v_tournament_id uuid;
BEGIN
  SELECT seat_number
    INTO v_seat_number
    FROM table_seats
   WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT tournament_id INTO v_tournament_id FROM tables WHERE id = p_table_id;

  IF v_tournament_id IS NULL THEN
    PERFORM public.fn_ca_declare_ledger('table_cashout', 'table_stack', p_table_id);
  END IF;

  -- CHIP CONTINUITY: this is the cron eviction / seat-expiry path (EXECUTE is
  -- service_role only). A system exit, never the player's choice.
  PERFORM public.atomic_seat_cashout_locked(p_user_id, p_table_id, v_seat_number, 'forced');
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. GOING SOUTH IS GONE
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.atomic_table_withdraw(uuid, uuid, numeric, boolean, text);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. BUY-IN: the one floor, and the session opens with the seat
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.atomic_table_buyin(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_amount numeric, p_auto_rebuy boolean DEFAULT false, p_club_id uuid DEFAULT NULL::uuid, p_idempotency_key uuid DEFAULT NULL::uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_is_template boolean;
  v_vip_only boolean;
  v_is_vip boolean;
  v_staff boolean;
  v_floor numeric;
  v_effective_min numeric;
  v_max_players integer;
  v_seats_taken integer;
  v_holds integer := 0;
  v_new_balance NUMERIC;
  v_club_id UUID;
  v_union_id UUID;
  v_ban_id UUID;
  v_min_buy_in NUMERIC;
  v_max_buy_in NUMERIC;
  v_tournament_id UUID;
  v_active_tables INT;
  v_seat_club UUID;
  v_max_tables CONSTANT INT := 4;
BEGIN
  PERFORM set_config('app.money_path', 'atomic_table_buyin', true); -- CHIP STANDARD C2: sanctioned seat creator (trg_ca_guard_seat_creation)
    -- THE ONLY IDEMPOTENCY GUARD IN THIS FUNCTION. Do not add a second one.
    IF p_idempotency_key IS NOT NULL THEN
        INSERT INTO public.transaction_idempotency_keys (key, user_id, action, amount)
        VALUES (p_idempotency_key, p_user_id, 'atomic_table_buyin', p_amount) ON CONFLICT (key) DO NOTHING;
        IF NOT FOUND THEN
            RETURN;
        END IF;
    END IF;
  -- ── A DEAD SESSION MOVES NO MONEY (Dan 2026-09-03) ────────────────────
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'SESSION_REVOKED: this session is signed out - sign in again'
      USING ERRCODE = '28000';
  END IF;
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( auth.uid() <> p_user_id)) THEN
    RAISE EXCEPTION 'Cannot buy in for another user';
  END IF;

  /* ZERO-DRIFT (2026-08-31): declare the ledger context so the wallet debit
     journals as a buy-in against the table, not an anonymous adjustment. */
  PERFORM set_config('app.ledger_category', 'buyin', true);
  PERFORM set_config('app.ledger_counterparty', 'table_stack', true);
  PERFORM set_config('app.ledger_counterparty_entity', COALESCE(p_table_id::text, ''), true);

  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || p_user_id::text, 0));

  SELECT t.club_id, c.union_id, t.min_buy_in, t.max_buy_in, COALESCE(t.max_players, 0),
         COALESCE(t.is_vip_only, false), COALESCE(t.is_template, false), t.tournament_id
    INTO v_club_id, v_union_id, v_min_buy_in, v_max_buy_in, v_max_players,
         v_vip_only, v_is_template, v_tournament_id
    FROM tables t LEFT JOIN clubs c ON c.id = t.club_id
   WHERE t.id = p_table_id LIMIT 1;

  IF v_is_template THEN
    RAISE EXCEPTION 'IS_TEMPLATE: this is a saved table template, not a live game';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Invalid buy-in amount';
  END IF;
  IF v_min_buy_in IS NOT NULL AND v_min_buy_in > 0 AND p_amount < v_min_buy_in THEN
    RAISE EXCEPTION 'Buy-in below table minimum (min %)', v_min_buy_in;
  END IF;
  IF v_max_buy_in IS NOT NULL AND v_max_buy_in > 0 AND p_amount > v_max_buy_in THEN
    RAISE EXCEPTION 'Buy-in above table maximum (max %)', v_max_buy_in;
  END IF;

  /* CHIP CONTINUITY (2026-09-04, I7): the rejoin floor. Keyed on club +
     variant + sb + bb, never on this table, so it follows the player to any
     table of the same game in this club and to no other game (A0.7-A0.10).
     effective_min = min(table.max, max(table.min, required)). This replaces
     the per-table opt-in column block that stood here. */
  IF v_tournament_id IS NULL THEN
    v_floor := public.fn_cash_rejoin_floor(p_user_id, p_table_id);
    IF v_floor IS NOT NULL THEN
      v_effective_min := GREATEST(COALESCE(v_min_buy_in, 0), v_floor);
      IF v_max_buy_in IS NOT NULL AND v_max_buy_in > 0 THEN
        v_effective_min := LEAST(v_effective_min, v_max_buy_in);
      END IF;
      IF p_amount < v_effective_min THEN
        RAISE EXCEPTION 'BUYIN_BELOW_FLOOR: minimum buy-in for this game right now is %', v_effective_min
          USING HINT = 'The minimum for this game is higher for you at the moment.';
      END IF;
    END IF;
  END IF;

  IF v_club_id IS NOT NULL THEN
    SELECT id INTO v_ban_id FROM blacklists
     WHERE user_id = p_user_id
       AND (expires_at IS NULL OR expires_at > now())
       AND (club_id = v_club_id OR (v_union_id IS NOT NULL AND union_id = v_union_id))
     LIMIT 1;
    IF v_ban_id IS NOT NULL THEN
      RAISE EXCEPTION 'Banned from this club';
    END IF;
  END IF;

  IF v_vip_only THEN
    SELECT COALESCE(p.is_vip, false)
           AND (p.vip_expires_at IS NULL OR p.vip_expires_at > now())
      INTO v_is_vip
      FROM profiles p WHERE p.id = p_user_id LIMIT 1;

    IF NOT COALESCE(v_is_vip, false) AND v_club_id IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1 FROM club_members cm
         WHERE cm.club_id = v_club_id AND cm.user_id = p_user_id
           AND cm.role IN ('owner', 'co_owner', 'admin', 'manager', 'agent')
      ) OR EXISTS (
        SELECT 1 FROM clubs c WHERE c.id = v_club_id AND c.owner_id = p_user_id
      ) INTO v_staff;
    END IF;

    IF NOT COALESCE(v_is_vip, false) AND NOT COALESCE(v_staff, false) THEN
      RAISE EXCEPTION 'VIP_ONLY: this table is open to VIP members only'
        USING HINT = 'VIP membership is required to take a seat at this table.';
    END IF;
  END IF;

  DECLARE v_nit jsonb;
  BEGIN
    v_nit := public.fn_nit_check(p_table_id, p_user_id, NULL);
    IF (v_nit->>'ok')::boolean = false AND v_nit->>'reason' = 'career_vpip' THEN
      RAISE EXCEPTION 'NIT_GAME: this table needs a career VPIP of at least %, and yours is % over % hands',
        v_nit->>'required', v_nit->>'vpip', v_nit->>'hands'
        USING HINT = 'The host has set a minimum voluntarily-put-in-pot rate for this game.';
    END IF;
  END;

  IF EXISTS (SELECT 1 FROM table_seats
              WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL) THEN
    RAISE EXCEPTION 'Player already seated at this table';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('table_seat:' || p_table_id::text, 0));

  IF v_max_players > 0 AND p_seat_number > v_max_players THEN
    RAISE EXCEPTION 'TABLE_SIZE: seat % does not exist at this table (% max)',
      p_seat_number, v_max_players;
  END IF;

  IF v_max_players > 0 THEN
    SELECT COUNT(*) INTO v_seats_taken
      FROM table_seats
     WHERE table_id = p_table_id AND left_at IS NULL;
    IF v_seats_taken >= v_max_players THEN
      RAISE EXCEPTION 'TABLE_SIZE: table is full (% of % seats taken)',
        v_seats_taken, v_max_players;
    END IF;

    SELECT COUNT(*) INTO v_holds
      FROM public.table_waitlist w
     WHERE w.table_id = p_table_id
       AND w.status = 'notified'
       AND w.user_id <> p_user_id
       AND COALESCE(w.hold_expires_at, w.notified_at + interval '60 seconds') > now();
    IF v_seats_taken + v_holds >= v_max_players THEN
      RAISE EXCEPTION 'SEAT_RESERVED: the open seat is held for the next player on the waiting list'
        USING HINT = 'Join the waitlist to get the next seat in order.';
    END IF;
  END IF;

  SELECT COUNT(*) INTO v_active_tables
    FROM table_seats ts JOIN tables t ON t.id = ts.table_id
   WHERE ts.user_id = p_user_id AND ts.left_at IS NULL
     AND t.tournament_id IS NULL AND t.status NOT IN ('closed','deleted');
  IF v_active_tables >= v_max_tables THEN
    RAISE EXCEPTION 'TABLE_CAP_REACHED: already seated at % cash tables (max %)', v_active_tables, v_max_tables;
  END IF;

  v_seat_club := public.fn_seat_club_for_user(p_user_id, p_table_id, p_club_id);
  IF v_seat_club IS NULL THEN
    RAISE EXCEPTION 'No club wallet resolves for this player at this table'
      USING HINT = 'The player must hold a membership in a club that belongs to this game''s union.';
  END IF;

  PERFORM public.fn_ensure_club_wallet(p_user_id, v_seat_club);

  UPDATE club_members
     SET chip_balance = chip_balance - p_amount, updated_at = NOW()
   WHERE user_id = p_user_id AND club_id = v_seat_club AND chip_balance >= p_amount
   RETURNING chip_balance INTO v_new_balance;

  IF v_new_balance IS NULL THEN
    RAISE EXCEPTION 'Insufficient club chips for buy-in (club %)', v_seat_club;
  END IF;

  DELETE FROM table_seats
   WHERE table_id = p_table_id AND seat_number = p_seat_number AND left_at IS NOT NULL;

  INSERT INTO table_seats (table_id, seat_number, user_id, stack, status, auto_rebuy, club_id)
       VALUES (p_table_id, p_seat_number, p_user_id, p_amount, 'active', p_auto_rebuy, v_seat_club);

  -- CHIP CONTINUITY: the session opens with the seat. baseline = this buy-in.
  PERFORM public.fn_cash_session_open(p_user_id, p_table_id, p_amount);

  UPDATE public.table_waitlist
     SET status = 'seated'
   WHERE table_id = p_table_id
     AND user_id = p_user_id
     AND status IN ('waiting', 'notified');

  INSERT INTO wallet_transactions
    (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
    VALUES (p_user_id, 'PLAYER', 'debit', p_amount, 'buyin',
            'Cash game buy-in (club wallet)', p_table_id, v_new_balance);

  UPDATE tables
     SET current_players = (SELECT COUNT(*) FROM table_seats
                             WHERE table_id = p_table_id AND left_at IS NULL)
   WHERE id = p_table_id;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. ADD-ONS RAISE THE BASELINE WHEN THE CHIPS LAND (I3, I10, A0.13, A0.17)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.atomic_table_addon(p_user_id uuid, p_table_id uuid, p_amount numeric, p_apply_to_seat boolean DEFAULT true, p_idempotency_key text DEFAULT NULL::text)
RETURNS numeric
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE v_new_balance numeric; v_claimed integer; v_seat_club uuid; v_seat_rows integer;
        v_stack numeric; v_max numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Add-on amount must be positive';
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Cannot add on for another user';
  END IF;

  PERFORM set_config('app.ledger_category', 'addon', true);
  PERFORM set_config('app.ledger_counterparty', 'table_stack', true);
  PERFORM set_config('app.ledger_counterparty_entity', COALESCE(p_table_id::text, ''), true);

  SELECT ts.club_id, ts.stack INTO v_seat_club, v_stack
    FROM table_seats ts
   WHERE ts.table_id = p_table_id AND ts.user_id = p_user_id AND ts.left_at IS NULL
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Player not seated at this table'; END IF;

  /* CHIP CONTINUITY (A0.17, I2): the table maximum is a hard ceiling in the
     database as well as in the engine. Between hands the chips land on the
     seat here; mid-hand resolve_pending_addon already caps at delivery. */
  IF p_apply_to_seat THEN
    SELECT t.max_buy_in INTO v_max FROM tables t WHERE t.id = p_table_id;
    IF v_max IS NOT NULL AND v_max > 0 AND COALESCE(v_stack, 0) + p_amount > v_max THEN
      RAISE EXCEPTION 'BUYIN_ABOVE_MAX: add-on of % would take the stack above the table maximum (%)', p_amount, v_max;
    END IF;
  END IF;

  IF v_seat_club IS NULL THEN
    v_seat_club := public.fn_seat_club_for_user(p_user_id, p_table_id, NULL);
  END IF;
  IF v_seat_club IS NULL THEN
    RAISE EXCEPTION 'No club wallet resolves for this add-on';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO table_addon_idempotency (key, user_id, table_id, amount, applied_to_seat)
    VALUES (p_idempotency_key, p_user_id, p_table_id, p_amount, p_apply_to_seat)
    ON CONFLICT (key) DO NOTHING;
    GET DIAGNOSTICS v_claimed = ROW_COUNT;
    IF v_claimed = 0 THEN
      SELECT chip_balance INTO v_new_balance FROM club_members
       WHERE user_id = p_user_id AND club_id = v_seat_club;
      RETURN v_new_balance;
    END IF;
  END IF;

  PERFORM public.fn_ensure_club_wallet(p_user_id, v_seat_club);

  UPDATE club_members
     SET chip_balance = chip_balance - p_amount, updated_at = NOW()
   WHERE user_id = p_user_id AND club_id = v_seat_club AND chip_balance >= p_amount
   RETURNING chip_balance INTO v_new_balance;
  IF v_new_balance IS NULL THEN
    RAISE EXCEPTION 'Insufficient club chips for add-on (club %)', v_seat_club;
  END IF;

  IF p_apply_to_seat THEN
    UPDATE table_seats SET stack = stack + p_amount
     WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL;
    GET DIAGNOSTICS v_seat_rows = ROW_COUNT;
    IF v_seat_rows = 0 THEN
      RAISE EXCEPTION
        'Add-on of % could not be applied: seat vacated mid-add-on (table %, player %)',
        p_amount, p_table_id, p_user_id;
    END IF;
    -- CHIP CONTINUITY: chips landed on the seat -> baseline rises with them.
    PERFORM public.fn_cash_session_add_baseline(p_user_id, p_table_id, p_amount);
  ELSE
    INSERT INTO table_pending_addons (table_id, user_id, amount)
    VALUES (p_table_id, p_user_id, p_amount);
  END IF;

  INSERT INTO wallet_transactions
    (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
    VALUES (p_user_id, 'PLAYER', 'debit', p_amount, 'addon',
            'Table add-on (club wallet)', p_table_id, v_new_balance);

  RETURN v_new_balance;
END;
$function$;

CREATE OR REPLACE FUNCTION public.resolve_pending_addon(p_pending_id uuid, p_max_buy_in numeric DEFAULT NULL::numeric)
RETURNS TABLE(applied numeric, refunded numeric, was_resolved boolean)
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_row        table_pending_addons%ROWTYPE;
  v_stack      numeric;
  v_headroom   numeric;
  v_applied    numeric := 0;
  v_refunded   numeric := 0;
BEGIN
  SELECT * INTO v_row
    FROM table_pending_addons
   WHERE id = p_pending_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pending add-on % not found', p_pending_id;
  END IF;

  IF v_row.resolved_at IS NOT NULL THEN
    applied      := COALESCE(v_row.applied_to_stack, 0);
    refunded     := COALESCE(v_row.refunded, 0);
    was_resolved := false;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT stack INTO v_stack
    FROM table_seats
   WHERE table_id = v_row.table_id
     AND user_id  = v_row.user_id
     AND left_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    v_applied  := 0;
    v_refunded := v_row.amount;
  ELSE
    IF p_max_buy_in IS NULL THEN
      v_applied := v_row.amount;
    ELSE
      v_headroom := GREATEST(p_max_buy_in - COALESCE(v_stack, 0), 0);
      v_applied  := LEAST(v_row.amount, v_headroom);
    END IF;
    v_refunded := ROUND(v_row.amount - v_applied, 2);
    v_applied  := ROUND(v_applied, 2);

    IF v_applied > 0 THEN
      UPDATE table_seats
         SET stack = COALESCE(stack, 0) + v_applied
       WHERE table_id = v_row.table_id
         AND user_id  = v_row.user_id
         AND left_at IS NULL;
      -- CHIP CONTINUITY (I10): a reload in place is not a leave; the baseline
      -- rises by what was delivered, never by what was refunded.
      PERFORM public.fn_cash_session_add_baseline(v_row.user_id, v_row.table_id, v_applied);
    END IF;
  END IF;

  IF v_refunded > 0 THEN
    PERFORM atomic_credit_wallet_and_log(
      v_row.user_id,
      v_refunded,
      'addon_refund',
      'Add-on refund (exceeds max buy-in or seat vacated)',
      v_row.table_id,
      NULL::uuid,
      NULL::uuid,
      'addon_refund:' || v_row.id::text
    );
  END IF;

  UPDATE table_pending_addons
     SET resolved_at      = now(),
         applied_to_stack = v_applied,
         refunded         = v_refunded
   WHERE id = v_row.id;

  applied      := v_applied;
  refunded     := v_refunded;
  was_resolved := true;
  RETURN NEXT;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. HORSES ARE PLAYERS: same floor, same session, same baseline
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_horse_fund_from_treasury(p_table_id uuid, p_user_id uuid, p_amount numeric)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_club_id uuid;
  v_treasury numeric;
  v_new_stack numeric;
  v_st text;
  v_msg text;
BEGIN
  IF p_table_id IS NULL OR p_user_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'table, user and positive amount required');
  END IF;

  SELECT club_id INTO v_club_id FROM tables WHERE id = p_table_id;
  IF v_club_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'table has no club');
  END IF;

  IF NOT public.fn_actor_can_manage_club_treasury(v_club_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized to fund from club treasury');
  END IF;

  SELECT COALESCE(chip_treasury, 0) INTO v_treasury FROM clubs WHERE id = v_club_id FOR UPDATE;
  IF v_treasury IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'club not found');
  END IF;
  IF v_treasury < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient club treasury',
                              'treasury', v_treasury, 'needed', p_amount);
  END IF;

  UPDATE table_seats
  SET stack = COALESCE(stack, 0) + p_amount
  WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
  RETURNING stack INTO v_new_stack;

  IF v_new_stack IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no active seat for user at table');
  END IF;

  -- CHIP CONTINUITY: a horse's reload raises its baseline exactly as a human's.
  PERFORM public.fn_cash_session_add_baseline(p_user_id, p_table_id, p_amount);

  PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
  UPDATE clubs SET chip_treasury = COALESCE(chip_treasury, 0) - p_amount, updated_at = NOW()
  WHERE id = v_club_id;
  PERFORM set_config('app.ledger_autoskip_clubs', '0', true);

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), v_club_id, NULL, p_user_id, p_amount,
    'horse_treasury_funding', 'Horse buy-in/rebuy funded from club treasury',
    v_treasury - p_amount, NOW()
  );

  BEGIN
    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, table_id, description)
    VALUES (
      COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
      'club_treasury', v_club_id,
      'table_stack',   p_table_id,
      p_amount, 'horse_funding', v_club_id, p_table_id,
      'Buy-in/rebuy funded from club treasury (fn_horse_fund_from_treasury)');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_st = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    BEGIN
      INSERT INTO public.ca_ledger_write_failures (club_id, user_id, delta, sqlstate, message)
      VALUES (v_club_id, p_user_id, -p_amount, v_st,
              'fn_horse_fund_from_treasury: ' || v_msg);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END;

  RETURN jsonb_build_object('success', true, 'new_stack', v_new_stack,
                            'treasury_after', v_treasury - p_amount);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_horse_seat_from_treasury(p_table_id uuid, p_user_id uuid, p_seat_number integer, p_amount numeric)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_club_id uuid;
  v_treasury numeric;
  v_st text;
  v_msg text;
  v_floor numeric;
  v_min numeric;
  v_max numeric;
  v_eff numeric;
BEGIN
  PERFORM set_config('app.money_path', 'fn_horse_seat_from_treasury', true); -- CHIP STANDARD C2: sanctioned seat creator (trg_ca_guard_seat_creation)
  IF p_table_id IS NULL OR p_user_id IS NULL OR p_seat_number IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'table, user, seat and positive amount required');
  END IF;

  SELECT club_id, min_buy_in, max_buy_in INTO v_club_id, v_min, v_max FROM tables WHERE id = p_table_id;
  IF v_club_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'table has no club');
  END IF;

  IF NOT public.fn_actor_can_manage_club_treasury(v_club_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized to seat from club treasury');
  END IF;

  -- CHIP CONTINUITY (I7): the same floor a human meets at atomic_table_buyin.
  v_floor := public.fn_cash_rejoin_floor(p_user_id, p_table_id);
  IF v_floor IS NOT NULL THEN
    v_eff := GREATEST(COALESCE(v_min, 0), v_floor);
    IF v_max IS NOT NULL AND v_max > 0 THEN v_eff := LEAST(v_eff, v_max); END IF;
    IF p_amount < v_eff THEN
      RETURN jsonb_build_object('success', false, 'error', 'BUYIN_BELOW_FLOOR', 'required', v_eff);
    END IF;
  END IF;

  SELECT COALESCE(chip_treasury, 0) INTO v_treasury FROM clubs WHERE id = v_club_id FOR UPDATE;
  IF v_treasury IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'club not found');
  END IF;
  IF v_treasury < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient club treasury',
                              'treasury', v_treasury, 'needed', p_amount);
  END IF;

  BEGIN
    INSERT INTO table_seats (table_id, user_id, seat_number, stack, is_sitting_out)
    VALUES (p_table_id, p_user_id, p_seat_number, p_amount, false);
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', 'seat already taken');
  END;

  -- CHIP CONTINUITY: the session opens with the seat, baseline = this buy-in.
  PERFORM public.fn_cash_session_open(p_user_id, p_table_id, p_amount);

  PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
  UPDATE clubs SET chip_treasury = COALESCE(chip_treasury, 0) - p_amount, updated_at = NOW()
  WHERE id = v_club_id;
  PERFORM set_config('app.ledger_autoskip_clubs', '0', true);

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), v_club_id, NULL, p_user_id, p_amount,
    'horse_treasury_funding', 'Horse seated + funded from club treasury',
    v_treasury - p_amount, NOW()
  );

  BEGIN
    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, table_id, description)
    VALUES (
      COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
      'club_treasury', v_club_id,
      'table_stack',   p_table_id,
      p_amount, 'horse_funding', v_club_id, p_table_id,
      'Seated + funded from club treasury (fn_horse_seat_from_treasury)');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_st = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    BEGIN
      INSERT INTO public.ca_ledger_write_failures (club_id, user_id, delta, sqlstate, message)
      VALUES (v_club_id, p_user_id, -p_amount, v_st,
              'fn_horse_seat_from_treasury: ' || v_msg);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END;

  RETURN jsonb_build_object('success', true, 'treasury_after', v_treasury - p_amount);
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. THE THAW GIVES THE STAY CLOCK AND THE FLOOR THEIR FROZEN MINUTES BACK
--    (CLAUDE.md section 13 rule 4). Body is the live one plus two steps.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_thaw_platform(p_freeze_started timestamp with time zone, p_frozen_seconds numeric, p_thawed_by text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_budget      CONSTANT INTERVAL := interval '4 seconds';
  c_level_batch CONSTANT INTEGER  := 40;

  v_started  TIMESTAMPTZ := clock_timestamp();
  v_row      public.engine_maintenance_thaws%ROWTYPE;
  v_shift    INTERVAL;
  v_counts   JSONB;
  v_n        INTEGER;
  v_done     TEXT[] := '{}';
  v_cursor   UUID;
  v_last     UUID;
  v_batch_n  INTEGER;
  v_total    INTEGER;
BEGIN
  IF p_frozen_seconds IS NULL OR p_frozen_seconds <= 0 OR p_frozen_seconds > 900 THEN
    RETURN jsonb_build_object('ok', false, 'complete', false, 'reason', 'implausible_frozen_seconds');
  END IF;

  INSERT INTO public.engine_maintenance_thaws (freeze_started_at, frozen_seconds, shifted, thawed_by)
  VALUES (p_freeze_started, p_frozen_seconds, '{}'::jsonb, p_thawed_by)
  ON CONFLICT (freeze_started_at) DO NOTHING;

  SELECT * INTO v_row
    FROM public.engine_maintenance_thaws
   WHERE freeze_started_at = p_freeze_started
     FOR UPDATE;

  v_counts := COALESCE(v_row.shifted, '{}'::jsonb);
  IF COALESCE((v_counts->>'complete')::boolean, false) THEN
    RETURN jsonb_build_object('ok', true, 'complete', true, 'reason', 'already_thawed', 'shifted', v_counts);
  END IF;

  v_shift := make_interval(secs => v_row.frozen_seconds);

  PERFORM set_config('app.freeze_bypass', 'on', TRUE);

  -- ── Step: sit-out clocks on live seats ─────────────────────────────────
  IF NOT (v_counts ? 'sit_out_at') THEN
    UPDATE public.table_seats
       SET sit_out_at = sit_out_at + v_shift
     WHERE left_at IS NULL AND sit_out_at IS NOT NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('sit_out_at', v_n);
    v_done := array_append(v_done, 'sit_out_at');
  END IF;

  -- ── Step: waitlist seat holds ──────────────────────────────────────────
  IF NOT (v_counts ? 'hold_expires_at') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.table_waitlist
       SET hold_expires_at = hold_expires_at + v_shift
     WHERE hold_expires_at > p_freeze_started;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('hold_expires_at', v_n);
    v_done := array_append(v_done, 'hold_expires_at');
  END IF;

  -- ── Step: tournament add-on windows ────────────────────────────────────
  IF NOT (v_counts ? 'addon_period_ends_at') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.tournaments
       SET addon_period_ends_at = addon_period_ends_at + v_shift
     WHERE addon_period_ends_at > p_freeze_started;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('addon_period_ends_at', v_n);
    v_done := array_append(v_done, 'addon_period_ends_at');
  END IF;

  -- ── Step: the cashier claim-back window ────────────────────────────────
  IF NOT (v_counts ? 'reversible_until') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.chip_transactions
       SET reversible_until = reversible_until + v_shift
     WHERE reversible_until > p_freeze_started;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('reversible_until', v_n);
    v_done := array_append(v_done, 'reversible_until');
  END IF;

  -- ── Step: mystery bounty reveal windows ────────────────────────────────
  IF NOT (v_counts ? 'reveal_deadline_at') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.tournament_bounty_awards
       SET reveal_deadline_at = reveal_deadline_at + v_shift
     WHERE reveal_deadline_at > p_freeze_started;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('reveal_deadline_at', v_n);
    v_done := array_append(v_done, 'reveal_deadline_at');
  END IF;

  -- ── Step: bust-rebuy prompts ───────────────────────────────────────────
  IF NOT (v_counts ? 'rebuy_prompt_until') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.tournament_players
       SET rebuy_prompt_until = rebuy_prompt_until + v_shift
     WHERE rebuy_prompt_until > p_freeze_started;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('rebuy_prompt_until', v_n);
    v_done := array_append(v_done, 'rebuy_prompt_until');
  END IF;

  -- ── Step: timed bomb pots ──────────────────────────────────────────────
  IF NOT (v_counts ? 'bomb_pot_next_due_at') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.tables
       SET bomb_pot_next_due_at = bomb_pot_next_due_at + v_shift
     WHERE bomb_pot_next_due_at IS NOT NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('bomb_pot_next_due_at', v_n);
    v_done := array_append(v_done, 'bomb_pot_next_due_at');
  END IF;

  -- ── Step: CHIP CONTINUITY stay clocks (2026-09-04) ─────────────────────
  -- A running stay clock is `remaining as of last_tick`; shifting last_tick
  -- forward by the frozen minutes is exactly "the freeze did not count".
  IF NOT (v_counts ? 'cash_stay_last_tick_at') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.cash_player_session
       SET stay_last_tick_at = stay_last_tick_at + v_shift
     WHERE closed_at IS NULL AND stay_running AND stay_last_tick_at <= p_freeze_started + v_shift;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('cash_stay_last_tick_at', v_n);
    v_done := array_append(v_done, 'cash_stay_last_tick_at');
  END IF;

  -- ── Step: CHIP CONTINUITY rejoin floors (2026-09-04) ───────────────────
  IF NOT (v_counts ? 'cash_rejoin_expires_at') AND clock_timestamp() - v_started <= c_budget THEN
    UPDATE public.cash_rejoin_constraints
       SET expires_at = expires_at + v_shift
     WHERE expires_at > p_freeze_started;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('cash_rejoin_expires_at', v_n);
    v_done := array_append(v_done, 'cash_rejoin_expires_at');
  END IF;

  -- ── Step (chunked): blind level clocks ─────────────────────────────────
  WHILE NOT (v_counts ? 'level_started_at') AND clock_timestamp() - v_started <= c_budget LOOP
    v_cursor := NULLIF(v_counts->>'level_started_at_cursor', '')::uuid;
    v_total  := COALESCE((v_counts->>'level_started_at_so_far')::integer, 0);

    WITH batch AS (
      SELECT id
        FROM public.tournaments
       WHERE status = 'RUNNING'
         AND COALESCE(on_break, FALSE) = FALSE
         AND level_started_at IS NOT NULL
         AND (v_cursor IS NULL OR id > v_cursor)
       ORDER BY id
       LIMIT c_level_batch
    ),
    shifted AS (
      UPDATE public.tournaments t
         SET level_started_at = t.level_started_at + v_shift
        FROM batch b
       WHERE t.id = b.id
      RETURNING t.id
    )
    SELECT count(*), max(id::text)::uuid INTO v_batch_n, v_last FROM shifted;

    v_total := v_total + COALESCE(v_batch_n, 0);

    IF COALESCE(v_batch_n, 0) < c_level_batch THEN
      v_counts := (v_counts - 'level_started_at_cursor' - 'level_started_at_so_far')
                  || jsonb_build_object('level_started_at', v_total);
      v_done := array_append(v_done, 'level_started_at');
    ELSE
      v_counts := v_counts || jsonb_build_object(
        'level_started_at_cursor', v_last::text,
        'level_started_at_so_far', v_total
      );
    END IF;
  END LOOP;

  -- NOT shifted, deliberately: tournaments.break_ends_at (the synchronized
  -- break owns it), late_reg (registration is frozen during the break),
  -- ban/mute/promotion expiries (time genuinely passing).

  IF v_counts ?& ARRAY['sit_out_at','hold_expires_at','addon_period_ends_at','reversible_until',
                       'reveal_deadline_at','rebuy_prompt_until','bomb_pot_next_due_at',
                       'cash_stay_last_tick_at','cash_rejoin_expires_at','level_started_at'] THEN
    v_counts := v_counts || jsonb_build_object('complete', true);
  END IF;

  UPDATE public.engine_maintenance_thaws
     SET shifted   = v_counts,
         thawed_at = now()
   WHERE freeze_started_at = p_freeze_started;

  RETURN jsonb_build_object(
    'ok', true,
    'complete', COALESCE((v_counts->>'complete')::boolean, false),
    'steps_this_call', to_jsonb(v_done),
    'elapsed_ms', round(extract(epoch from clock_timestamp() - v_started) * 1000),
    'shifted', v_counts
  );
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. POST-APPLY ASSERTIONS. Abort if the shape is not what this file says.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_src text;
  v_n int;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'atomic_table_buyin';
  IF v_src IS NULL THEN RAISE EXCEPTION 'ASSERT FAILED: atomic_table_buyin missing'; END IF;
  IF position('fn_cash_rejoin_floor' in v_src) = 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: buy-in does not apply the rejoin floor';
  END IF;
  IF position('fn_cash_session_open' in v_src) = 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: buy-in does not open a session';
  END IF;
  IF position('no_rathole' in v_src) > 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: the per-table floor is still in atomic_table_buyin';
  END IF;
  v_n := (length(v_src) - length(replace(v_src, 'INTO public.transaction_idempotency_keys', '')))
         / length('INTO public.transaction_idempotency_keys');
  IF v_n <> 1 THEN RAISE EXCEPTION 'ASSERT FAILED: expected exactly 1 idempotency guard, found %', v_n; END IF;

  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'atomic_seat_cashout_locked';
  IF v_n <> 1 THEN RAISE EXCEPTION 'ASSERT FAILED: expected ONE atomic_seat_cashout_locked, found %', v_n; END IF;
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'atomic_seat_cashout_locked';
  IF position('fn_cash_leave_check' in v_src) = 0 OR position('fn_cash_session_close' in v_src) = 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: cash-out door does not enforce or close the session';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'atomic_table_withdraw') THEN
    RAISE EXCEPTION 'ASSERT FAILED: atomic_table_withdraw still exists';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_thaw_platform';
  IF position('cash_stay_last_tick_at' in v_src) = 0 OR position('cash_rejoin_expires_at' in v_src) = 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: thaw does not shift chip-continuity deadlines';
  END IF;

  FOR v_src IN SELECT unnest(ARRAY['fn_cashout_seats_for_closing_table','player_leave_table']) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = v_src
                      AND position('''forced''' in p.prosrc) > 0) THEN
      RAISE EXCEPTION 'ASSERT FAILED: % does not declare a forced exit', v_src;
    END IF;
  END LOOP;

  RAISE NOTICE 'chip continuity slice 0: sessions, floor, leave lock, thaw, withdraw dropped.';
END $$;

COMMIT;
