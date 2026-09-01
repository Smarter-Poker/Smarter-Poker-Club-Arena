-- ═══════════════════════════════════════════════════════════════════════════
-- SEAT-FIRST HEALER INSIDE EIGHT SECONDS (2026-09-01, v3 — the version that
-- runs in production; applied as 20260901181911)
-- ───────────────────────────────────────────────────────────────────────────
-- Third apply of the same fix in one hour. The story, so nobody repeats it:
--
-- THE OUTAGE. At ~12:55 UTC the whole platform's seat-first boards opened a
-- fresh set of queues — 96 of them (Deep Stack's 32 spins, Midway's spins and
-- heads-ups) — at a moment when opener seating could not succeed (Deep
-- Stack's 416 horses were still benched behind the green-light latch, and the
-- old engine's fleet-wide picks were being refused by the club-scope entry
-- gate). Every queue got its joinable table and ZERO opening horses. A
-- joinable husk COVERS its price point in ensureBoardOpen, so the board never
-- reopens the config; a seat-first game with no openers never fills, so it
-- never leaves REGISTERING. Result: no spins, no heads-up, anywhere, for
-- five hours — the boards looked open and were all dead.
--
-- v1 (20260901181246) taught fn_repair_seat_first_games the new husk class
--   (joinable table, short of openers) and club-scoped the pick — but timed
--   out: the engine calls it as service_role (statement_timeout pinned 8s)
--   and ~1,000 per-horse fn_ca_entry_scope_ok evaluations per husk blew it.
-- v2 (20260901181626) tried a function-level SET statement_timeout — which
--   cannot work: the timer is checked from the START of the statement.
-- v3 (this file) makes the healer fast: the scope test is the equivalent
--   set-based membership predicate driven off club_members' user_id index,
--   the game's union looked up once per husk, batch clamped to 6 per call.
--   Verified live: 6 games / 12 openers healed per 30-second engine tick.
--
-- The healer now repairs BOTH husk classes:
--   Class A: REGISTERING seat-first game with no table row at all
--     → create the table, seat openers, fresh 60–180s human window.
--   Class B: joinable table short of opening horses (seated < seats-1)
--     → seat the shortfall, fresh window. A human already seated counts
--       toward the field and is never displaced.
-- And its pick honors two laws: the bench latch (horse_status='available'
-- only) and club containment (a horse is only picked for a game its own
-- membership scope admits — the exact test the entry gate enforces, so a
-- pick can never select a horse the gate would refuse).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_repair_seat_first_games(p_limit integer DEFAULT 25)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_t          record;
  v_table_id   uuid;
  v_level      jsonb;
  v_sb         numeric;
  v_bb         numeric;
  v_seats      int;
  v_opening    int;
  v_horse      uuid;
  v_res        jsonb;
  v_seated     int;
  v_repaired   int := 0;
  v_horses_sat int := 0;
  v_window     int;
  v_club_union uuid;
  v_is_union   boolean;
BEGIN
  FOR v_t IN
    SELECT t.id, t.name, t.club_id, t.game_type, t.max_players, t.blind_structure,
           jt.table_id AS joinable_table_id,
           COALESCE(jt.seated, 0) AS seated_now
      FROM public.tournaments t
      LEFT JOIN LATERAL (
        SELECT tb.id AS table_id,
               (SELECT count(*) FROM public.table_seats ts
                 WHERE ts.table_id = tb.id AND ts.left_at IS NULL) AS seated
          FROM public.tables tb
         WHERE tb.tournament_id = t.id
           AND COALESCE(tb.is_deleted, false) = false
           AND tb.status IN ('waiting', 'running', 'active')
         ORDER BY tb.created_at
         LIMIT 1
      ) jt ON true
     WHERE t.status = 'REGISTERING'
       AND (COALESCE(t.variant, '') = 'spin' OR COALESCE(t.max_players, 0) <= 2)
       AND (
         NOT EXISTS (SELECT 1 FROM public.tables tb2 WHERE tb2.tournament_id = t.id)
         OR (jt.table_id IS NOT NULL
             AND COALESCE(jt.seated, 0)
                 < GREATEST(COALESCE(NULLIF(t.max_players, 0), 3) - 1, 0))
       )
     ORDER BY t.created_at
     -- Clamped batch: small enough that a call always finishes inside the
     -- 8-second service_role ceiling; the 30-second tick supplies throughput.
     LIMIT LEAST(GREATEST(p_limit, 0), 6)
  LOOP
    v_seats := COALESCE(NULLIF(v_t.max_players, 0), 3);

    IF v_t.joinable_table_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.tables tb3 WHERE tb3.tournament_id = v_t.id) THEN
      -- Class A: no table at all. Mirrors createOpenSeatTable exactly:
      -- status 'waiting' so the engine has nothing to deal yet, and
      -- tournament_id set so cash discovery (tournament_id IS NULL) can
      -- never pick it up.
      v_level := COALESCE((v_t.blind_structure::jsonb)->0, '{}'::jsonb);
      v_sb := COALESCE((v_level->>'smallBlind')::numeric, 10);
      v_bb := COALESCE((v_level->>'bigBlind')::numeric, 20);

      INSERT INTO public.tables (
        club_id, tournament_id, name, game_type, game_variant, stakes,
        small_blind, big_blind, min_buy_in, max_buy_in,
        max_players, current_players, status
      ) VALUES (
        v_t.club_id, v_t.id, v_t.name, 'tournament', lower(COALESCE(v_t.game_type, 'nlh')),
        v_sb::text || '/' || v_bb::text, v_sb, v_bb, 0, 0,
        v_seats, 0, 'waiting'
      )
      RETURNING id INTO v_table_id;

      v_opening := GREATEST(v_seats - 1, 0);
    ELSE
      -- Class B: joinable table short of openers. Seat the SHORTFALL only.
      v_opening := GREATEST(GREATEST(v_seats - 1, 0) - v_t.seated_now, 0);
      IF v_opening = 0 THEN
        CONTINUE;
      END IF;
    END IF;

    -- The game's scope, looked up ONCE per husk. Same membership rule the
    -- entry gate enforces: a union-owned board admits members of the union's
    -- clubs; a club board admits members of the club or of any sibling in
    -- its union; a standalone club admits its own members.
    v_is_union := false;
    v_club_union := NULL;
    IF v_t.club_id IS NOT NULL THEN
      SELECT EXISTS (SELECT 1 FROM public.unions u WHERE u.id = v_t.club_id) INTO v_is_union;
      IF NOT v_is_union THEN
        SELECT c.union_id INTO v_club_union FROM public.clubs c WHERE c.id = v_t.club_id;
      END IF;
    END IF;

    v_seated := 0;

    -- Every seat but one: two horses on a Spin, one on a heads-up. The last
    -- seat belongs to a human.
    FOR v_horse IN
      SELECT p.id
        FROM public.profiles p
       WHERE p.is_horse = true
         -- The bench latch is honored: a benched horse is never repaired
         -- into a seat.
         AND p.horse_status = 'available'
         AND (v_t.club_id IS NULL OR EXISTS (
           SELECT 1
             FROM public.club_members cm
             JOIN public.clubs c2 ON c2.id = cm.club_id
            WHERE cm.user_id = p.id
              AND (
                cm.club_id = v_t.club_id
                OR (v_is_union AND (
                     c2.union_id = v_t.club_id
                     OR EXISTS (SELECT 1 FROM public.union_clubs uc
                                 WHERE uc.club_id = c2.id AND uc.union_id = v_t.club_id)))
                OR (v_club_union IS NOT NULL AND (
                     c2.union_id = v_club_union
                     OR EXISTS (SELECT 1 FROM public.union_clubs uc2
                                 WHERE uc2.club_id = c2.id AND uc2.union_id = v_club_union)))
              )))
         AND NOT EXISTS (
           SELECT 1 FROM public.table_seats ts
             JOIN public.tables tb4 ON tb4.id = ts.table_id
            WHERE ts.user_id = p.id AND ts.left_at IS NULL
              AND tb4.status IN ('waiting', 'running'))
         AND NOT EXISTS (
           SELECT 1 FROM public.tournament_players tp
             JOIN public.tournaments t2 ON t2.id = tp.tournament_id
            WHERE tp.user_id = p.id
              AND tp.status IN ('registered', 'playing')
              AND t2.status IN ('ANNOUNCED', 'REGISTERING', 'RUNNING'))
       ORDER BY random()
       LIMIT v_opening
    LOOP
      v_res := public.fn_seat_horse_in_seat_first_game(v_t.id, v_horse);
      IF COALESCE((v_res->>'ok')::boolean, false) THEN
        v_seated := v_seated + 1;
        v_horses_sat := v_horses_sat + 1;
      END IF;
    END LOOP;

    -- A FRESH HUMAN WINDOW, not the one that expired hours ago. Only when
    -- the repair actually changed something: rewinding the clock on a game
    -- this pass did not touch would keep a full table from ever starting.
    IF v_seated > 0 OR v_t.joinable_table_id IS NULL THEN
      v_window := 60 + floor(random() * 121)::int;
      UPDATE public.tournaments
         SET start_time = now() + make_interval(secs => v_window)
       WHERE id = v_t.id;
      v_repaired := v_repaired + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'repaired', v_repaired,
    'horses_seated', v_horses_sat
  );
END;
$fn$;

-- The engine's service role is the only caller.
REVOKE ALL ON FUNCTION public.fn_repair_seat_first_games(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_repair_seat_first_games(integer) FROM anon;
REVOKE ALL ON FUNCTION public.fn_repair_seat_first_games(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_repair_seat_first_games(integer) TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- ASSERTIONS (abort the transaction if the fix is not what it claims)
-- ───────────────────────────────────────────────────────────────────────────
DO $$
DECLARE v_def text;
BEGIN
  v_def := pg_get_functiondef('public.fn_repair_seat_first_games(integer)'::regprocedure);
  IF v_def LIKE '%fn_ca_entry_scope_ok(%' THEN
    RAISE EXCEPTION 'per-horse scope fn call still present - the timeout will recur';
  END IF;
  IF v_def NOT LIKE '%LEAST(GREATEST(p_limit, 0), 6)%' THEN
    RAISE EXCEPTION 'healer batch is not clamped';
  END IF;
  IF v_def NOT LIKE '%union_clubs%' THEN
    RAISE EXCEPTION 'set-based scope predicate missing';
  END IF;
END $$;

COMMIT;
