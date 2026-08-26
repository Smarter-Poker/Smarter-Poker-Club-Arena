-- ═══════════════════════════════════════════════════════════════════════════
--  get_club_home(): return only the columns the lobby actually uses
--  APPLIED TO PRODUCTION 2026-08-23 before this file was committed.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The first version returned to_jsonb(v_club) — all 76 columns of
-- public.clubs. The six queries it replaced asked for SIXTEEN named columns,
-- so as written the lobby also shipped, on every load, to every member:
--
--   chip_treasury, chip_pool, promo_balance, insurance_balance, total_rake
--   club_commission_rate, default_rake_percent, rake_percent, rake_cap*
--   auto_settlement_*, settlement_locked*
--   code   <- the club join code
--
-- Not a privilege escalation: the function is SECURITY INVOKER, RLS already
-- allowed the caller to read that row, and a determined client could always
-- have selected those columns itself. But "could have asked for it" is not
-- "was sent it on every visit", and a lobby paint has no business carrying a
-- club's treasury, rake configuration and join code. Found while auditing my
-- own change from earlier the same night.
--
-- 16 keys instead of 76, verified against production. The DO block at the end
-- fails the migration if any internal column reappears — a schema addition
-- must never widen this payload by accident.

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
  IF p_club_key ~ '^[0-9a-fA-F]{8}-' THEN
    SELECT * INTO v_club FROM public.clubs WHERE id = p_club_key::uuid;
  ELSIF p_club_key ~ '^[0-9]+$' THEN
    SELECT * INTO v_club FROM public.clubs WHERE club_id = p_club_key::bigint;
  END IF;

  IF v_club.id IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT uc.union_id INTO v_union_id
  FROM public.union_clubs uc WHERE uc.club_id = v_club.id LIMIT 1;

  IF v_union_id IS NOT NULL THEN
    SELECT array_agg(uc.club_id) INTO v_union_club_ids
    FROM public.union_clubs uc WHERE uc.union_id = v_union_id;
  END IF;

  v_union_club_ids := COALESCE(v_union_club_ids, ARRAY[v_club.id]);
  v_scope_ids := CASE WHEN v_union_id IS NOT NULL AND array_length(v_union_club_ids, 1) > 1
                      THEN v_union_club_ids ELSE ARRAY[v_club.id] END;

  SELECT count(*)::int INTO v_member_count
  FROM public.club_members cm
  WHERE cm.club_id = ANY (v_scope_ids) AND cm.status IN ('active', 'approved');

  IF v_uid IS NOT NULL THEN
    SELECT jsonb_build_object('chip_balance', cm.chip_balance, 'role', cm.role)
      INTO v_membership
    FROM public.club_members cm
    WHERE cm.club_id = v_club.id AND cm.user_id = v_uid LIMIT 1;
  END IF;

  SELECT COALESCE(jsonb_agg(t ORDER BY t.created_at DESC), '[]'::jsonb) INTO v_tables
  FROM (
    SELECT id, name, game_variant, stakes, current_players, max_players, status,
           small_blind, big_blind, min_buy_in, max_buy_in, settings, created_at
    FROM public.tables
    WHERE is_deleted = false
      AND (status IS NULL OR status NOT IN ('closed', 'deleted'))
      AND tournament_id IS NULL
      AND (CASE WHEN v_union_id IS NOT NULL
                THEN (union_id = v_union_id OR (club_id = v_club.id AND is_private = true))
                ELSE club_id = ANY (v_union_club_ids) END)
    ORDER BY created_at DESC LIMIT 100
  ) t;

  SELECT COALESCE(jsonb_agg(x ORDER BY x.start_time ASC), '[]'::jsonb) INTO v_tournaments
  FROM (
    SELECT id, name, game_type, buy_in_amount, buy_in_fee, guaranteed_prize,
           start_time, status, current_players, max_players, starting_chips,
           club_id, late_reg_mins, late_reg_levels, started_at, current_level
    FROM public.tournaments
    WHERE status IN ('REGISTERING', 'RUNNING')
      AND (CASE WHEN v_union_id IS NOT NULL
                THEN (club_id = v_club.id AND is_private = true)
                ELSE club_id = ANY (v_union_club_ids) END)
    ORDER BY start_time ASC LIMIT 100
  ) x;

  SELECT jsonb_build_object('id', bp.id, 'main_balance', bp.main_balance) INTO v_bbj
  FROM public.bbj_pools bp
  WHERE CASE WHEN v_union_id IS NOT NULL
             THEN (bp.union_id = v_union_id OR bp.club_id = ANY (v_union_club_ids))
             ELSE bp.club_id = v_club.id END
  ORDER BY (bp.union_id IS NOT NULL) DESC LIMIT 1;

  RETURN jsonb_build_object(
    'found', true,
    -- EXACTLY the columns the replaced client query named. Adding to this list
    -- must be a deliberate act, never a side effect of a schema change.
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

-- ── Post-apply assertions ─────────────────────────────────────────────────
DO $$
DECLARE v_keys text[]; v_leaked text[];
BEGIN
  SELECT array_agg(k) INTO v_keys FROM jsonb_object_keys(
    (public.get_club_home((SELECT id::text FROM public.clubs ORDER BY member_count DESC NULLS LAST LIMIT 1))->'club')
  ) AS k;

  v_leaked := ARRAY(SELECT unnest(v_keys) INTERSECT SELECT unnest(ARRAY[
    'chip_treasury','chip_pool','promo_balance','insurance_balance','total_rake',
    'club_commission_rate','default_rake_percent','rake_percent','rake_cap','code',
    'settlement_locked','settlement_locked_until','auto_settlement_enabled']));

  IF array_length(v_leaked, 1) > 0 THEN
    RAISE EXCEPTION 'get_club_home still returns internal club columns: %', v_leaked;
  END IF;
  IF NOT ('name' = ANY (v_keys)) OR NOT ('logo_url' = ANY (v_keys)) THEN
    RAISE EXCEPTION 'get_club_home lost a column the lobby needs';
  END IF;
  IF has_function_privilege('anon', 'public.get_club_home(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon regained EXECUTE';
  END IF;
END $$;
