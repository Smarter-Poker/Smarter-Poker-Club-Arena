-- ═══════════════════════════════════════════════════════════════════════════
--  THE FLOOR REMEMBERS THE WEEK
--
--  Dan 2026-09-10, on what to build next: "DO ALL OF THIS", including "a
--  'biggest wins this week' section on the floor."
--
--  The floor (20260909230222) prints the host's most recent wins. A recent
--  win is small more often than not; the biggest of the week is what a
--  player remembers and what a floor shouts about. fn_diamond_game_floor
--  now also returns top_week: the same rounds, over the last seven days, the
--  five that paid the most, named the same way (fn_arena_name and the arena
--  avatar, never a user id, never a horse flag, certification rounds out).
--  Nothing else in the body changes; it stays STABLE and reads only the
--  three round tables and profiles.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_diamond_game_floor(p_club_id uuid, p_limit integer DEFAULT 20)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_host uuid;
  v_lim integer;
  v_wins jsonb;
  v_points jsonb;
  v_top jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To See The Floor');
  END IF;
  SELECT h.host_id INTO v_host FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  v_lim := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50);

  WITH rounds AS (
    SELECT 'wheel'::text AS game, s.created_at AS at, s.user_id,
           s.outcome_kind::text AS kind, s.outcome_amount::numeric AS amount,
           s.prize_value_chips::numeric AS value_chips, NULL::integer AS multiplier_cents
      FROM public.wheel_spins s
     WHERE s.host_id = v_host AND s.outcome_kind <> 'nothing' AND NOT COALESCE(s.is_fixture, false)
    UNION ALL
    SELECT 'plinko', d.created_at, d.user_id, 'chips', d.payout_chips, d.payout_chips, d.multiplier_cents
      FROM public.plinko_drops d
     WHERE d.host_id = v_host AND d.payout_chips > 0 AND NOT COALESCE(d.is_fixture, false)
    UNION ALL
    SELECT 'crash', c.settled_at, c.user_id, 'chips', c.payout_chips, c.payout_chips, c.cashout_cents
      FROM public.crash_rounds c
     WHERE c.host_id = v_host AND c.status = 'cashed' AND c.payout_chips > 0 AND NOT COALESCE(c.is_fixture, false)
  ), recent AS (
    SELECT * FROM rounds ORDER BY at DESC LIMIT v_lim
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'game', r.game,
           'at', r.at,
           'kind', r.kind,
           'amount', r.amount,
           'value_chips', r.value_chips,
           'multiplier_cents', r.multiplier_cents,
           'name', COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name), 'Player'),
           'avatar', NULLIF(pr.arena_avatar_url, ''),
           'mine', r.user_id = auth.uid()
         ) ORDER BY r.at DESC), '[]'::jsonb)
    INTO v_wins
    FROM recent r
    LEFT JOIN public.profiles pr ON pr.id = r.user_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'crash_cents', x.crash_cents,
           'cashed', x.status = 'cashed',
           'at', x.settled_at
         ) ORDER BY x.settled_at DESC), '[]'::jsonb)
    INTO v_points
    FROM (SELECT c.crash_cents, c.status, c.settled_at
            FROM public.crash_rounds c
           WHERE c.host_id = v_host AND c.status <> 'open' AND NOT COALESCE(c.is_fixture, false)
           ORDER BY c.settled_at DESC
           LIMIT 20) x;

  -- the week's biggest: the same rounds, the last seven days, by what they paid
  WITH rounds AS (
    SELECT 'wheel'::text AS game, s.created_at AS at, s.user_id,
           s.outcome_kind::text AS kind, s.outcome_amount::numeric AS amount,
           s.prize_value_chips::numeric AS value_chips, NULL::integer AS multiplier_cents
      FROM public.wheel_spins s
     WHERE s.host_id = v_host AND s.outcome_kind <> 'nothing' AND NOT COALESCE(s.is_fixture, false)
       AND s.created_at >= now() - interval '7 days'
    UNION ALL
    SELECT 'plinko', d.created_at, d.user_id, 'chips', d.payout_chips, d.payout_chips, d.multiplier_cents
      FROM public.plinko_drops d
     WHERE d.host_id = v_host AND d.payout_chips > 0 AND NOT COALESCE(d.is_fixture, false)
       AND d.created_at >= now() - interval '7 days'
    UNION ALL
    SELECT 'crash', c.settled_at, c.user_id, 'chips', c.payout_chips, c.payout_chips, c.cashout_cents
      FROM public.crash_rounds c
     WHERE c.host_id = v_host AND c.status = 'cashed' AND c.payout_chips > 0 AND NOT COALESCE(c.is_fixture, false)
       AND c.settled_at >= now() - interval '7 days'
  ), biggest AS (
    SELECT * FROM rounds ORDER BY value_chips DESC, at DESC LIMIT 5
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'game', b.game,
           'at', b.at,
           'kind', b.kind,
           'amount', b.amount,
           'value_chips', b.value_chips,
           'multiplier_cents', b.multiplier_cents,
           'name', COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name), 'Player'),
           'avatar', NULLIF(pr.arena_avatar_url, ''),
           'mine', b.user_id = auth.uid()
         ) ORDER BY b.value_chips DESC, b.at DESC), '[]'::jsonb)
    INTO v_top
    FROM biggest b
    LEFT JOIN public.profiles pr ON pr.id = b.user_id;

  RETURN jsonb_build_object('ok', true, 'host_id', v_host, 'wins', v_wins, 'crash_points', v_points,
                            'top_week', v_top);
END $function$;


REVOKE ALL ON FUNCTION public.fn_diamond_game_floor(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_floor(uuid, integer) TO authenticated, service_role;

-- The floor still refuses a caller with no account.
DO $$
DECLARE v_res jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  v_res := public.fn_diamond_game_floor('00000000-0000-0000-0000-000000000000'::uuid, 5);
  IF (v_res->>'ok')::boolean THEN
    RAISE EXCEPTION 'the_floor_remembers_the_week: the floor answered a caller with no account: %', v_res;
  END IF;
END $$;

COMMIT;
