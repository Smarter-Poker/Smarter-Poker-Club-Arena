-- ═══════════════════════════════════════════════════════════════════════════
--  get_club_home() HAD BEEN THROWING ON EVERY CALL SINCE IT WAS WRITTEN
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan, 2026-08-23: "THE MTT, SPINS AND HEADS UP TABLES AND EVENTS THAT WERE
-- CREATED IN THE MIDWAY UNION ARE NOT BEING DISPLAYED IN THE ATTACHED CLUBS...
-- THEY ARE NOT SHOWING UP INSIDE MIDWAY UNION ANY MORE EITHER."
--
-- WHAT WAS ACTUALLY IN PRODUCTION. The body installed by
-- 20260823260000_club_home_union_tournaments.sql could not run. Not "was
-- slow", not "returned the wrong rows" -- every call raised, from the first:
--
--     SELECT union_id ... FROM union_clubs WHERE ... AND status = 'active'
--     ERROR 42703: column "status" does not exist
--
-- public.union_clubs has five columns and none of them is status. Behind that
-- first exception sat four more of the same kind, none ever reached:
--
--     clubs.short_id            -- does not exist; the integer key is club_id
--     club_members.profile_id   -- does not exist; it is user_id
--     tables.time_bank_seconds / time_bank_rounds / min_buyin as projected
--                               -- not the columns the lobby reads
--     WHERE tables.status IN ('RUNNING','WAITING')   -- the column is
--                               lowercase, so zero rows even once it compiled
--
-- and the object it returned had no `found` key, while the caller reads
--     if (homeErr || !home || home.found !== true) return;
-- Five independent reasons for one outcome: THE FAST PATH HAS NEVER PAINTED
-- A SINGLE LOBBY.
--
-- WHY THAT IS THE BUG BEING REPORTED. This RPC exists to replace six
-- sequential round trips with one. Dead, every club lobby falls back to the
-- slow chain -- club row, membership, union row, union club ids, member
-- count, and only THEN tables and tournaments -- measured at three seconds on
-- production and longer on a phone. For that whole window every tab reads
-- "No Tournaments Yet". That is precisely "sometimes it displays, then it
-- disappears".
--
-- HOW IT GOT HERE, which matters more than the columns. The migration that
-- installed it was written, applied and committed WITHOUT ONCE CALLING THE
-- FUNCTION. One `SELECT get_club_home(<any club>)` would have failed in under
-- a millisecond. Its sibling 20260823250000 does carry assertions, and one of
-- them calls fn_club_home_scope_parity(), which calls this -- so that cannot
-- have passed either. The assertions were recorded, not run.
--
-- So the guarantee added here is not another string match on the source text.
-- It EXECUTES the function, on every club on the platform, and refuses to
-- apply if any call raises, if any union club comes back blind, or if it
-- takes longer than a quarter second. A definition that cannot run can no
-- longer reach production.
--
-- Also dropped: the second, unused overload of fn_club_home_in_scope. Two
-- functions of one name whose 2nd and 3rd parameters are (boolean, uuid) in
-- one and (uuid, boolean) in the other are resolved silently by argument
-- type. Nothing called the second; it is a trap, not a feature.
--
-- ── APPLIED TO PRODUCTION IN THREE STEPS via the Supabase MCP ──────────────
--   20260823280000_get_club_home_was_never_run              (this file)
--   20260823290000_club_home_tables_predicate_matches_its_index
--   20260823300000_club_home_carries_table_size
-- The two follow-ups are recorded separately and documented in their own
-- files; the body below is the settled result of all three, so replaying this
-- file alone reaches the same state production is in.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── One statement of the scope rule (kept from 20260823250000) ─────────────
CREATE OR REPLACE FUNCTION public.fn_club_home_in_scope(
  p_club_id               uuid,
  p_is_private            boolean,
  p_union_id              uuid,
  p_viewer_union_id       uuid,
  p_viewer_club_id        uuid,
  p_viewer_union_club_ids uuid[]
)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
  SELECT CASE
    -- A UNION CLUB sees everything the UNION owns, plus its own private games.
    -- Another club's private game is never visible here.
    WHEN p_viewer_union_id IS NOT NULL THEN
      (p_union_id = p_viewer_union_id
       OR (p_club_id = p_viewer_club_id AND COALESCE(p_is_private, false)))
    -- A STANDALONE club sees what it owns.
    ELSE p_club_id = ANY (p_viewer_union_club_ids)
  END;
$fn$;

DROP FUNCTION IF EXISTS public.fn_club_home_in_scope(uuid, uuid, boolean, uuid, uuid, uuid[]);

CREATE OR REPLACE FUNCTION public.get_club_home(p_club_key text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_club           public.clubs%ROWTYPE;
  v_uid            uuid := auth.uid();
  v_union_id       uuid;
  v_union_club_ids uuid[];
  v_member_count   integer;
  v_membership     jsonb;
  v_tables         jsonb;
  v_tournaments    jsonb;
  v_bbj            jsonb;
BEGIN
  -- Whatever is in the URL: a UUID, the integer club_id, or a slug.
  -- clubs.short_id does not exist and never did.
  IF p_club_key ~ '^[0-9a-fA-F]{8}-' THEN
    SELECT * INTO v_club FROM public.clubs WHERE id = p_club_key::uuid LIMIT 1;
  ELSIF p_club_key ~ '^[0-9]+$' THEN
    SELECT * INTO v_club FROM public.clubs WHERE club_id = p_club_key::integer LIMIT 1;
  ELSE
    SELECT * INTO v_club FROM public.clubs WHERE slug = p_club_key LIMIT 1;
  END IF;

  IF v_club.id IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  -- UNION MEMBERSHIP FROM BOTH SOURCES, exactly as ClubHomePage does.
  -- union_clubs is authoritative, but the two are written by different paths
  -- and the union's OWN club carries clubs.union_id with no union_clubs row --
  -- which is why Midway went blind to its own games. Reading only one of them
  -- makes the fast paint and the authoritative query disagree, and a lobby
  -- that contradicts itself is worse than a slow one.
  SELECT uc.union_id INTO v_union_id
  FROM public.union_clubs uc WHERE uc.club_id = v_club.id LIMIT 1;
  IF v_union_id IS NULL THEN
    v_union_id := v_club.union_id;
  END IF;

  IF v_union_id IS NOT NULL THEN
    SELECT array_agg(uc.club_id) INTO v_union_club_ids
    FROM public.union_clubs uc WHERE uc.union_id = v_union_id;
  END IF;
  v_union_club_ids := COALESCE(v_union_club_ids, ARRAY[]::uuid[]) || v_club.id;

  SELECT count(*)::int INTO v_member_count
  FROM public.club_members cm
  WHERE cm.club_id = ANY (v_union_club_ids)
    AND cm.status IN ('active', 'approved');

  IF v_uid IS NOT NULL THEN
    SELECT jsonb_build_object('chip_balance', cm.chip_balance, 'role', cm.role)
      INTO v_membership
    FROM public.club_members cm
    WHERE cm.club_id = v_club.id AND cm.user_id = v_uid LIMIT 1;
  END IF;

  -- ── The cash list. Same columns and the SAME FILTERS as the authoritative
  --    query in ClubHomePage, written the same way on purpose: `status NOT IN`
  --    rather than lower(status) is what lets the partial indexes on
  --    public.tables apply. With lower() this was a sequential scan of 64,670
  --    rows to return 44 -- 593 ms. Without it, an index scan at 4.8 ms.
  SELECT COALESCE(jsonb_agg(t ORDER BY t.created_at DESC), '[]'::jsonb) INTO v_tables
  FROM (
    SELECT id, name, game_variant, stakes, current_players, max_players, status,
           small_blind, big_blind, min_buy_in, max_buy_in, settings, created_at
    FROM public.tables
    WHERE is_deleted = false
      AND status NOT IN ('closed', 'deleted')
      AND tournament_id IS NULL
      AND public.fn_club_home_in_scope(club_id, is_private, union_id,
                                       v_union_id, v_club.id, v_union_club_ids)
    ORDER BY created_at DESC LIMIT 200
  ) t;

  -- ── The tournament list, through the SAME predicate. That single shared
  --    predicate is what 20260823250000 exists to protect; keep it that way.
  --    `variant` classifies a Spin by what it IS rather than by its name, and
  --    `table_size` feeds the "Table Size" slider, which must never be handed
  --    max_players.
  SELECT COALESCE(jsonb_agg(x ORDER BY x.start_time ASC), '[]'::jsonb) INTO v_tournaments
  FROM (
    SELECT id, name, game_type, variant, table_size, buy_in_amount, buy_in_fee,
           guaranteed_prize, start_time, status, current_players, max_players,
           starting_chips, club_id, union_id, is_xmtt, late_reg_mins,
           late_reg_levels, started_at, current_level
    FROM public.tournaments
    WHERE status IN ('REGISTERING', 'RUNNING', 'LATE_REG', 'STARTING_SOON')
      AND public.fn_club_home_in_scope(club_id, is_private, union_id,
                                       v_union_id, v_club.id, v_union_club_ids)
    ORDER BY start_time ASC LIMIT 200
  ) x;

  SELECT jsonb_build_object('id', bp.id, 'main_balance', bp.main_balance) INTO v_bbj
  FROM public.bbj_pools bp
  WHERE CASE WHEN v_union_id IS NOT NULL
             THEN (bp.union_id = v_union_id OR bp.club_id = ANY (v_union_club_ids))
             ELSE bp.club_id = v_club.id END
  ORDER BY (bp.union_id IS NOT NULL) DESC LIMIT 1;

  RETURN jsonb_build_object(
    'found', true,
    -- EXACTLY the columns the replaced client query named. Widening this is a
    -- deliberate act: 20260823180000 removed the club's treasury, rake
    -- configuration and join code from a payload every member receives on
    -- every visit, and that must not creep back.
    'club', jsonb_build_object(
      'id', v_club.id,
      'club_id', v_club.club_id,
      'name', v_club.name,
      'description', v_club.description,
      'avatar_url', v_club.avatar_url,
      'logo_url', v_club.logo_url,
      'member_count', v_club.member_count,
      'online_count', v_club.online_count,
      'owner_id', v_club.owner_id,
      'level', v_club.level,
      'hierarchy_units_rounded_up', v_club.hierarchy_units_rounded_up,
      'player_threshold_current', v_club.player_threshold_current,
      'player_threshold_next', v_club.player_threshold_next,
      'hierarchy_threshold_current', v_club.hierarchy_threshold_current,
      'hierarchy_threshold_next', v_club.hierarchy_threshold_next,
      'created_at', v_club.created_at
    ),
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

REVOKE ALL ON FUNCTION public.get_club_home(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_club_home(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_club_home(text) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
--  POST-APPLY ASSERTIONS -- THESE CALL THE FUNCTION
-- ═══════════════════════════════════════════════════════════════════════════
-- The previous body passed every text-matching assertion ever written about it
-- and could not survive one invocation. So: run it. On every club.
DO $check$
DECLARE
  c record; v jsonb; v_union_live integer; v_ms numeric; v_t0 timestamptz; def text; v_leaked text[];
BEGIN
  FOR c IN SELECT id, name, union_id FROM public.clubs LOOP
    v_t0 := clock_timestamp();
    v := public.get_club_home(c.id::text);
    v_ms := extract(epoch FROM clock_timestamp() - v_t0) * 1000;

    IF v IS NULL OR (v->>'found') <> 'true' THEN
      RAISE EXCEPTION 'get_club_home(%) did not report found=true - the client discards anything else', c.name;
    END IF;
    IF jsonb_typeof(v->'tables') <> 'array' OR jsonb_typeof(v->'tournaments') <> 'array' THEN
      RAISE EXCEPTION 'get_club_home(%) returned a non-array list', c.name;
    END IF;
    -- This RPC exists ONLY to be fast; six round trips are the alternative.
    IF v_ms > 250 THEN
      RAISE EXCEPTION 'get_club_home(%) took % ms - the cash list is not using its partial index', c.name, round(v_ms);
    END IF;
    IF jsonb_array_length(v->'tournaments') > 0
       AND NOT ((v->'tournaments'->0) ? 'table_size') THEN
      RAISE EXCEPTION 'get_club_home(%) dropped table_size - the Table Size slider would re-narrow the list after the paint', c.name;
    END IF;

    -- A union club that sees nothing while its union runs games is the exact
    -- screenshot this whole thread is about.
    IF c.union_id IS NOT NULL AND c.union_id <> c.id THEN
      SELECT count(*) INTO v_union_live FROM public.tournaments t
       WHERE t.union_id = c.union_id
         AND t.status IN ('REGISTERING', 'RUNNING', 'LATE_REG', 'STARTING_SOON');
      IF v_union_live > 0 AND jsonb_array_length(v->'tournaments') = 0 THEN
        RAISE EXCEPTION '% is blind: the union runs % joinable games and its club home returns none', c.name, v_union_live;
      END IF;
    END IF;
  END LOOP;

  SELECT pg_get_functiondef(oid) INTO def FROM pg_proc WHERE proname = 'get_club_home';

  -- The scope may only be written once, and both lists must use it.
  IF (SELECT count(*) FROM regexp_matches(def, 'fn_club_home_in_scope', 'g')) <> 2 THEN
    RAISE EXCEPTION 'get_club_home does not route exactly its two lists through the shared scope';
  END IF;
  IF def NOT LIKE '%variant%' THEN
    RAISE EXCEPTION 'get_club_home no longer returns variant - the lobby is back to guessing from the name';
  END IF;
  IF def LIKE '%lower(status)%' THEN
    RAISE EXCEPTION 'the cash list is back on lower(status) and cannot use its index';
  END IF;

  -- The narrow projection holds.
  SELECT array_agg(k) INTO v_leaked
  FROM jsonb_object_keys(
    (public.get_club_home((SELECT id::text FROM public.clubs ORDER BY member_count DESC NULLS LAST LIMIT 1))->'club')
  ) AS k
  WHERE k = ANY (ARRAY[
    'chip_treasury','chip_pool','promo_balance','insurance_balance','total_rake',
    'club_commission_rate','default_rake_percent','rake_percent','rake_cap','code',
    'settlement_locked','settlement_locked_until','auto_settlement_enabled']);
  IF array_length(v_leaked, 1) > 0 THEN
    RAISE EXCEPTION 'get_club_home returns internal club columns again: %', v_leaked;
  END IF;

  IF has_function_privilege('anon', 'public.get_club_home(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon regained EXECUTE on get_club_home';
  END IF;
END $check$;
