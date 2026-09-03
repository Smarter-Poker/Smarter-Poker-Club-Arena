-- ═══════════════════════════════════════════════════════════════════════════
-- A SAVED TEMPLATE IS NOT A LIVE TABLE
-- ───────────────────────────────────────────────────────────────────────────
-- APPLIED TO PRODUCTION 2026-08-25 as migration
--   a_saved_template_is_not_a_live_table
--
-- TableConfigPage's Save button inserts with `is_template: true` and NO
-- status. `tables.status` defaults to 'waiting'. get_club_home filters on
-- is_deleted, status and tournament_id and NOTHING ELSE. So the moment a host
-- pressed Save, their template appeared on the board as an empty joinable
-- game -- and a player who sat down would have started a table the host never
-- started, at a row nobody was watching.
--
-- There are zero templates in production today, which is the only reason this
-- had not already happened. It is closed in BOTH places, because they fail
-- differently: the RPC filter keeps a template off the board, and the buy-in
-- guard makes it unsittable even if some other surface links straight to it.
--
-- Both halves PATCH the deployed body rather than restating it, so this
-- migration cannot silently revert anything applied to those two functions
-- earlier the same day (get_club_home gained the lobby flags and club names;
-- atomic_table_buyin gained the table-size, no-rathole and VIP guards). Each
-- half is a no-op when already present, and the assertion at the foot
-- re-checks every one of those guards.
--
-- VERIFIED against production inside a rolled-back transaction (CLAUDE.md 11.5):
--   a template inserted into a real club appeared on get_club_home 0 times
--   buying a seat at it -> IS_TEMPLATE: this is a saved table template, not a
--                          live game
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. OFF THE BOARD ───────────────────────────────────────────────────────
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_club_home';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'get_club_home does not exist - refusing to guess';
  END IF;

  IF position('COALESCE(is_template, false) = false' in v_def) > 0 THEN
    RAISE NOTICE 'get_club_home already excludes templates; nothing to do';
    RETURN;
  END IF;

  IF position('      AND tournament_id IS NULL' in v_def) = 0 THEN
    RAISE EXCEPTION 'the tables WHERE clause is not the shape this patch expects';
  END IF;

  EXECUTE replace(
    v_def,
    '      AND tournament_id IS NULL',
    E'      AND tournament_id IS NULL\n'
    || E'      -- A template is a saved SHAPE, not a game. Without this the\n'
    || E'      -- Save button put an empty joinable table on the board.\n'
    || E'      AND COALESCE(is_template, false) = false'
  );
END $$;

-- ── 2. UNSITTABLE ──────────────────────────────────────────────────────────
DO $$
DECLARE
  v_def text;
  v_new text;
  v_anchor CONSTANT text := '  IF p_amount IS NULL OR p_amount <= 0 THEN';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'atomic_table_buyin';

  IF position('IS_TEMPLATE:' in v_def) > 0 THEN
    RAISE NOTICE 'atomic_table_buyin already refuses templates; nothing to do';
    RETURN;
  END IF;

  IF position(v_anchor in v_def) = 0 THEN
    RAISE EXCEPTION 'atomic_table_buyin is not the shape this patch expects';
  END IF;

  IF position('COALESCE(t.no_rathole, false), COALESCE(t.is_vip_only, false)' in v_def) = 0 THEN
    RAISE EXCEPTION 'expected the VIP-era select list; apply the VIP migration first';
  END IF;

  -- The flag has to be READ before it can be refused: declare, fetch, refuse.
  v_new := replace(v_def,
    '  v_no_rathole boolean;',
    E'  v_no_rathole boolean;\n  v_is_template boolean;');

  v_new := replace(v_new,
    'COALESCE(t.no_rathole, false), COALESCE(t.is_vip_only, false)',
    'COALESCE(t.no_rathole, false), COALESCE(t.is_vip_only, false), COALESCE(t.is_template, false)');

  v_new := replace(v_new,
    E'         v_no_rathole, v_vip_only\n',
    E'         v_no_rathole, v_vip_only, v_is_template\n');

  v_new := replace(v_new, v_anchor,
    E'  -- A template is a saved SHAPE, not a game. Nothing buys a seat at one,\n'
    || E'  -- whatever happens to link to it (2026-08-25).\n'
    || E'  IF v_is_template THEN\n'
    || E'    RAISE EXCEPTION ''IS_TEMPLATE: this is a saved table template, not a live game'';\n'
    || E'  END IF;\n\n'
    || v_anchor);

  EXECUTE v_new;
END $$;

DO $$
DECLARE v_home text; v_buyin text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_home FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='get_club_home';
  SELECT pg_get_functiondef(p.oid) INTO v_buyin FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='atomic_table_buyin';

  IF position('COALESCE(is_template, false) = false' in v_home) = 0 THEN
    RAISE EXCEPTION 'the lobby still returns templates';
  END IF;
  IF position('IS_TEMPLATE:' in v_buyin) = 0 THEN
    RAISE EXCEPTION 'a template can still be sat at';
  END IF;
  -- Everything applied earlier the same day must have survived both patches.
  IF position('club_names' in v_home) = 0
     OR position('is_vip_only' in v_home) = 0
     OR position('VIP_ONLY:' in v_buyin) = 0
     OR position('NO_RATHOLE:' in v_buyin) = 0
     OR position('TABLE_SIZE:' in v_buyin) = 0
     OR position('TABLE_CAP_REACHED:' in v_buyin) = 0 THEN
    RAISE EXCEPTION 'a guard applied earlier today was lost';
  END IF;
END $$;
