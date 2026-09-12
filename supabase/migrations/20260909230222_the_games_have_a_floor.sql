-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260909230222; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260909230222   (the stamp IS the apply time, UTC: 2026-09-09 23:02:22)
--   name        the_games_have_a_floor
--   created_by  (not recorded)
--   statements  1 statement(s), 5123 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260909230222 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_diamond_game_floor
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- ═══════════════════════════════════════════════════════════════════════════
--  THE GAMES HAVE A FLOOR
--
--  Dan 2026-09-09, on the three games: "move onto the next phase of this
--  complex build and upgrade phase for the 3 diamonds to chips games."
--
--  A casino floor is loud with other people winning. These three games were
--  not: a player arriving at the wheel saw their own history (empty, the
--  first time) and nothing else, so an open game with a full pool looked
--  like an empty room. This is the floor: one read that returns the host's
--  recent wins across all three games, named the way the club already names
--  a winner (fn_arena_name and the club's own arena avatar, exactly as
--  fn_bbj_recent_hits does it), plus the last twenty crash points, which is
--  the first thing anyone who has played Aviator looks for.
--
--  WHAT IT NEVER RETURNS. No user id (a bare id can be joined to things a
--  player must not see), no horse flag, nothing derived from one (10.5 and
--  the horse-identity laws: a horse is a player, and it wins like one).
--  Certification rounds (is_fixture) are kept out, as they are kept out of
--  the fairness statistics. Nothing here moves money; it is STABLE and reads
--  only the three round tables and profiles.
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

  RETURN jsonb_build_object('ok', true, 'host_id', v_host, 'wins', v_wins, 'crash_points', v_points);
END $function$;

REVOKE ALL ON FUNCTION public.fn_diamond_game_floor(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_floor(uuid, integer) TO authenticated, service_role;

-- The floor exists, and it refuses a caller with no account.
DO $$
DECLARE v_res jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'fn_diamond_game_floor') THEN
    RAISE EXCEPTION 'the_games_have_a_floor: fn_diamond_game_floor was not created';
  END IF;
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  v_res := public.fn_diamond_game_floor('00000000-0000-0000-0000-000000000000'::uuid, 5);
  IF (v_res->>'ok')::boolean THEN
    RAISE EXCEPTION 'the_games_have_a_floor: the floor answered a caller with no account: %', v_res;
  END IF;
END $$;

COMMIT;
