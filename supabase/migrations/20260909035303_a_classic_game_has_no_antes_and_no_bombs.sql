-- 20260909035303_a_classic_game_has_no_antes_and_no_bombs.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  THE TEMPLATE IS A PROMISE TO THE PLAYER, NOT A DEFAULT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The lobby prints the template under every game title - CLASSIC, ACTION or
-- MADNESS - and the picker tells the player exactly what each one means:
--
--   classic  "Standard Ring Game. No Antes, No Bombs, No VPIP Floor."
--   action   "Small Blind Ante, VPIP Floor, Double Board Bomb Every 15 Minutes."
--   madness  "Big Blind Ante, High VPIP Floor, Double Board Bomb Every Orbit."
--
-- `fn_cash_template_defaults` already returns exactly those rules. Nothing
-- enforced them. The creation path let the caller's overrides win:
--
--   v_ante  := coalesce(v_o->>'regular_ante', v_def->>'regular_ante');
--   v_vpip  := fn_cash_override_int(v_o, 'vpip_floor',  ...default...);
--   v_bombs := coalesce(v_def->'bombs','{}') || coalesce(v_o->'bombs','{}');
--
-- - and validated only that the VALUE was legal, never that it matched the
-- template the game is sold as. So a game named and labelled "Classic" could
-- be created with a small-blind ante and a double-board bomb pot.
--
-- IT WAS. Measured on production 2026-09-09 03:50 UTC:
--
--   * 23 of 88 `classic` games carry Action/Madness rules - 11 with bombs
--     enabled, 12 with a small-blind ante.
--   * On the felt right now that is 24 classic TABLES running bomb pots and
--     19 charging an ante, inside 389 seated classic players.
--   * `NLH 0.50/1 Classic` has 10 open tables and 48 seated players taking a
--     double-board bomb every fifteen minutes in a game that says No Bombs.
--     `NLH 0.25/0.50 Classic` has 8 tables and 30 players paying an ante in a
--     game that says No Antes.
--
-- An ante is forced money out of a stack. Taking it in a game advertised as
-- having none is not a cosmetic mismatch.
--
-- Every one of the 23 was created in a single batch at 2026-09-05 03:55:59
-- with no creator; the 46 games seeded on 09-04 and the one on 09-06 are all
-- correct. So the bad batch is what exercised the hole - but the hole is in the
-- live creation path, not in that batch, and it is what this closes.
--
-- THE RULE: the fields NAMED IN THE BLURB come from the template and are not
-- overridable - `regular_ante`, `vpip_floor`, `vpip_window` and the whole
-- `bombs` object. Everything else a host can still edit: the buy-in band, the
-- stay clock, the rejoin window, handedness and the table options. The line is
-- "did we promise this to the player when they picked the game".
--
-- `vpip_window` is included because Dan's rule is a ten-hand window
-- (CLAUDE.md work of 2026-09-04); every template already returns 10, and this
-- keeps it that way.
--
-- HOW THIS EDITS THE FUNCTION. The body is 8KB and owns club-game creation.
-- Retyping it to change four lines risks dropping one of its other guards, so
-- this reads the LIVE definition, does four literal replaces, and refuses to
-- proceed if any anchor is missing or if any sibling guard goes missing from the
-- result. Anchor positions were verified read-only first (2753, 2923, 3104,
-- 3466 - each present exactly once).
--
-- ROLLBACK
--   Reverse the four replaces; each quotes its before and after in full.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

DO $migration$
DECLARE
  v_src text;
  v_new text;
  v_old_ante   CONSTANT text := 'v_ante := coalesce(v_o->>''regular_ante'', v_def->>''regular_ante'');';
  v_new_ante   CONSTANT text := 'v_ante := v_def->>''regular_ante'';';
  v_old_vpip   CONSTANT text := 'v_vpip := public.fn_cash_override_int(v_o, ''vpip_floor'', (v_def->>''vpip_floor'')::integer);';
  v_new_vpip   CONSTANT text := 'v_vpip := (v_def->>''vpip_floor'')::integer;';
  v_old_win    CONSTANT text := 'v_vpip_window := public.fn_cash_override_int(v_o, ''vpip_window'', (v_def->>''vpip_window'')::integer);';
  v_new_win    CONSTANT text := 'v_vpip_window := (v_def->>''vpip_window'')::integer;';
  v_old_bombs  CONSTANT text := 'v_bombs := coalesce(v_def->''bombs'', ''{}''::jsonb) || coalesce(v_o->''bombs'', ''{}''::jsonb);';
  v_new_bombs  CONSTANT text := 'v_bombs := coalesce(v_def->''bombs'', ''{}''::jsonb);';
BEGIN
  v_src := pg_get_functiondef(
    'public.fn_cash_game_create_impl_20260905(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean)'::regprocedure);

  IF position(v_old_ante in v_src) = 0
     OR position(v_old_vpip in v_src) = 0
     OR position(v_old_win in v_src) = 0
     OR position(v_old_bombs in v_src) = 0 THEN
    RAISE EXCEPTION
      'the live definition is not the shape this migration expects; read it before re-running';
  END IF;

  v_new := replace(v_src, v_old_ante,  v_new_ante);
  v_new := replace(v_new, v_old_vpip,  v_new_vpip);
  v_new := replace(v_new, v_old_win,   v_new_win);
  v_new := replace(v_new, v_old_bombs, v_new_bombs);

  IF position(v_old_ante in v_new) <> 0
     OR position(v_old_vpip in v_new) <> 0
     OR position(v_old_win in v_new) <> 0
     OR position(v_old_bombs in v_new) <> 0 THEN
    RAISE EXCEPTION 'a replacement did not take';
  END IF;

  -- Every other guard this function performs must survive the edit. These are
  -- the ones a careless rewrite would silently drop.
  IF position('VARIANT_UNAVAILABLE' in v_new) = 0
     OR position('STAKES_INVALID' in v_new) = 0
     OR position('HANDEDNESS_INVALID' in v_new) = 0
     OR position('BUYIN_BAND_INVALID' in v_new) = 0
     OR position('ANTE_INVALID' in v_new) = 0
     OR position('VPIP_INVALID' in v_new) = 0
     OR position('BOMB_TRIGGER_INVALID' in v_new) = 0
     OR position('STAY_CLOCK_BELOW_FLOOR' in v_new) = 0
     OR position('REJOIN_WINDOW_BELOW_FLOOR' in v_new) = 0 THEN
    RAISE EXCEPTION 'a guard went missing in the edit';
  END IF;

  EXECUTE v_new;
END;
$migration$;

-- ── AND CORRECT THE GAMES THAT WERE ALREADY CREATED WRONG ──────────────────
-- Only the four contract fields are rewritten, and only where they disagree
-- with the template. Nothing else in the snapshot is touched, so a host's
-- buy-in band, clocks and options survive untouched.
--
-- This takes nothing from a player: it REMOVES a forced ante and a bomb-pot
-- ante from games that were never supposed to charge either, and it cannot
-- move a chip that is already in a pot.
DO $backfill$
DECLARE
  v_fixed integer;
  v_left  integer;
BEGIN
  UPDATE public.cash_games g
     SET ruleset_snapshot = g.ruleset_snapshot
           || jsonb_build_object(
                'regular_ante', d.def->>'regular_ante',
                'vpip_floor',   (d.def->>'vpip_floor')::integer,
                'vpip_window',  (d.def->>'vpip_window')::integer,
                'bombs',        d.def->'bombs'),
         updated_at = now()
    FROM (SELECT id, public.fn_cash_template_defaults(template_name, variant) AS def
            FROM public.cash_games) d
   WHERE d.id = g.id
     AND (g.ruleset_snapshot->>'regular_ante'     IS DISTINCT FROM d.def->>'regular_ante'
       OR g.ruleset_snapshot->>'vpip_floor'       IS DISTINCT FROM d.def->>'vpip_floor'
       OR g.ruleset_snapshot->>'vpip_window'      IS DISTINCT FROM d.def->>'vpip_window'
       OR g.ruleset_snapshot->'bombs'->>'enabled' IS DISTINCT FROM d.def->'bombs'->>'enabled'
       OR g.ruleset_snapshot->'bombs'->>'trigger' IS DISTINCT FROM d.def->'bombs'->>'trigger');
  GET DIAGNOSTICS v_fixed = ROW_COUNT;

  SELECT count(*) INTO v_left
    FROM public.cash_games g
    JOIN LATERAL public.fn_cash_template_defaults(g.template_name, g.variant) AS def ON true
   WHERE g.ruleset_snapshot->>'regular_ante'     IS DISTINCT FROM def->>'regular_ante'
      OR g.ruleset_snapshot->'bombs'->>'enabled' IS DISTINCT FROM def->'bombs'->>'enabled';

  IF v_left <> 0 THEN
    RAISE EXCEPTION 'refusing to commit: % game(s) still disagree with their template', v_left;
  END IF;

  RAISE NOTICE 'realigned % cash game(s) to their template contract', v_fixed;
END;
$backfill$;

COMMIT;
