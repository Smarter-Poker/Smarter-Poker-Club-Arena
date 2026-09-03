-- ═══════════════════════════════════════════════════════════════════════════
--  get_club_home(p_club_key text) -> jsonb
--  APPLIED TO PRODUCTION 2026-08-23 via the Supabase MCP before this file was
--  committed; the definition here is the one running live.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY. Painting the club lobby took SIX sequential round trips from the
-- browser: club row, membership+wallet, union row, union club ids, member
-- count, then finally tables+tournaments+BBJ. Measured 2026-08-23, each of
-- those queries executes in ~9ms server-side while a round trip costs
-- 150-250ms wired and 250-400ms on mobile. The lobby was spending 1-1.5s
-- (2-3s on a phone) doing nothing but waiting, which is more than the entire
-- remaining boot payload (262KB brotli). This returns all of it in ONE call,
-- measured at 38ms on the largest club (1,172 members, 42 tables).
--
-- SECURITY INVOKER, deliberately. A SECURITY DEFINER function would have to
-- re-implement every RLS policy these six tables carry, and any mistake there
-- is a data leak. Running as the caller means the existing policies apply
-- unchanged to each statement below - this function returns exactly what the
-- browser could already fetch by issuing the same six queries itself, and
-- nothing more. It is a latency fix, not a permissions change.
--
-- The caller is always auth.uid(); there is no user_id parameter, so it cannot
-- be pointed at somebody else's membership.
--
-- p_club_key accepts either the club UUID or the integer club_id, matching
-- resolveClubIdFilter() on the client. An unknown or malformed key returns
-- {"found": false} rather than raising.
--
-- VERIFIED against the queries it replaces, on both branches:
--   union club   member_count 1172 = 1172, tables 42 = 42, tournaments 0 = 0,
--                bbj 9496.46 = 9496.46, tables ordered created_at DESC
--   standalone   union_id null, tables 42 = 42
--   uuid key and integer key resolve to the same club
--   missing club and junk key both return found=false

CREATE OR REPLACE FUNCTION public.get_club_home(p_club_key text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_club            public.clubs%ROWTYPE;
  v_uid             uuid := auth.uid();
  v_union_id        uuid;
  v_union_club_ids  uuid[];
  v_scope_ids       uuid[];
  v_member_count    integer;
  v_membership      jsonb;
  v_tables          jsonb;
  v_tournaments     jsonb;
  v_bbj             jsonb;
BEGIN
  -- ── the club, by uuid or by integer club_id ────────────────────────────
  IF p_club_key ~ '^[0-9a-fA-F]{8}-' THEN
    SELECT * INTO v_club FROM public.clubs WHERE id = p_club_key::uuid;
  ELSIF p_club_key ~ '^[0-9]+$' THEN
    SELECT * INTO v_club FROM public.clubs WHERE club_id = p_club_key::bigint;
  END IF;

  IF v_club.id IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  -- ── union membership of the CLUB ───────────────────────────────────────
  SELECT uc.union_id INTO v_union_id
  FROM public.union_clubs uc
  WHERE uc.club_id = v_club.id
  LIMIT 1;

  IF v_union_id IS NOT NULL THEN
    SELECT array_agg(uc.club_id) INTO v_union_club_ids
    FROM public.union_clubs uc
    WHERE uc.union_id = v_union_id;
  END IF;

  v_union_club_ids := COALESCE(v_union_club_ids, ARRAY[v_club.id]);
  -- member_count is counted over the union when there is one, matching the
  -- client's "re-query with all club IDs" branch.
  v_scope_ids := CASE WHEN v_union_id IS NOT NULL AND array_length(v_union_club_ids, 1) > 1
                      THEN v_union_club_ids ELSE ARRAY[v_club.id] END;

  SELECT count(*)::int INTO v_member_count
  FROM public.club_members cm
  WHERE cm.club_id = ANY (v_scope_ids)
    AND cm.status IN ('active', 'approved');

  -- ── the CALLER's own membership row only ───────────────────────────────
  IF v_uid IS NOT NULL THEN
    SELECT jsonb_build_object('chip_balance', cm.chip_balance, 'role', cm.role)
      INTO v_membership
    FROM public.club_members cm
    WHERE cm.club_id = v_club.id AND cm.user_id = v_uid
    LIMIT 1;
  END IF;

  -- ── cash tables (mirrors the lobby filters exactly) ────────────────────
  SELECT COALESCE(jsonb_agg(t ORDER BY t.created_at DESC), '[]'::jsonb) INTO v_tables
  FROM (
    SELECT id, name, game_variant, stakes, current_players, max_players, status,
           small_blind, big_blind, min_buy_in, max_buy_in, settings, created_at
    FROM public.tables
    WHERE is_deleted = false
      AND (status IS NULL OR status NOT IN ('closed', 'deleted'))
      AND tournament_id IS NULL
      AND (
        CASE WHEN v_union_id IS NOT NULL
             THEN (union_id = v_union_id OR (club_id = v_club.id AND is_private = true))
             ELSE club_id = ANY (v_union_club_ids)
        END
      )
    ORDER BY created_at DESC
    LIMIT 100
  ) t;

  -- ── joinable tournaments ───────────────────────────────────────────────
  SELECT COALESCE(jsonb_agg(x ORDER BY x.start_time ASC), '[]'::jsonb) INTO v_tournaments
  FROM (
    SELECT id, name, game_type, buy_in_amount, buy_in_fee, guaranteed_prize,
           start_time, status, current_players, max_players, starting_chips,
           club_id, late_reg_mins, late_reg_levels, started_at, current_level
    FROM public.tournaments
    WHERE status IN ('REGISTERING', 'RUNNING')
      AND (
        CASE WHEN v_union_id IS NOT NULL
             THEN (club_id = v_club.id AND is_private = true)
             ELSE club_id = ANY (v_union_club_ids)
        END
      )
    ORDER BY start_time ASC
    LIMIT 100
  ) x;

  -- ── bad beat jackpot pool (union pool wins when in a union) ────────────
  SELECT jsonb_build_object('id', bp.id, 'main_balance', bp.main_balance)
    INTO v_bbj
  FROM public.bbj_pools bp
  WHERE CASE WHEN v_union_id IS NOT NULL
             THEN (bp.union_id = v_union_id OR bp.club_id = ANY (v_union_club_ids))
             ELSE bp.club_id = v_club.id
        END
  ORDER BY (bp.union_id IS NOT NULL) DESC
  LIMIT 1;

  RETURN jsonb_build_object(
    'found', true,
    'club', to_jsonb(v_club),
    'membership', v_membership,
    'union_id', v_union_id,
    'union_club_ids', to_jsonb(v_union_club_ids),
    'member_count', v_member_count,
    'tables', v_tables,
    'tournaments', v_tournaments,
    'bbj', v_bbj
  );
END;
$$;

COMMENT ON FUNCTION public.get_club_home(text) IS
  'Club lobby payload in one round trip (was six). SECURITY INVOKER: RLS applies to every read, so it returns exactly what the caller could fetch itself.';

REVOKE ALL ON FUNCTION public.get_club_home(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_club_home(text) TO authenticated;

-- ── Post-apply assertions ─────────────────────────────────────────────────
DO $$
DECLARE
  v_kind char;
  v_anon boolean;
BEGIN
  SELECT p.prosecdef::int::char INTO v_kind
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_club_home';

  IF v_kind IS NULL THEN
    RAISE EXCEPTION 'get_club_home was not created';
  END IF;
  IF v_kind <> '0' THEN
    RAISE EXCEPTION 'get_club_home must be SECURITY INVOKER so RLS still applies';
  END IF;

  SELECT has_function_privilege('anon', p.oid, 'EXECUTE') INTO v_anon
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_club_home';

  IF v_anon THEN
    RAISE EXCEPTION 'get_club_home must not be executable by anon';
  END IF;
END $$;
