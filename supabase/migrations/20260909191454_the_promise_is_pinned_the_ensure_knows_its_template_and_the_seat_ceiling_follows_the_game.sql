-- 20260909191454_the_promise_is_pinned_the_ensure_knows_its_template_and_the_seat_ceiling_follows_the_game
--
-- Version reserved by scripts/reserve-migration-version.sh (CLAUDE.md 4.5).
-- Lane C of the 2026-09-09 must-move / Classic-Action-Madness audit
-- (docs/audits/2026-09-09-must-move-audit/lane-C.md). NOT applied by the lane;
-- probed ROLLED BACK against production and handed to the integrator.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  FOUR THINGS THE TEMPLATE DID NOT ACTUALLY DECIDE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Every function here was read LIVE (pg_get_functiondef) between 17:30 and
-- 18:15 UTC on 2026-09-09 and every number was measured on production. Lane C
-- found seven things; three of them are fixed better elsewhere in this same
-- audit and are DELETED from this file rather than duplicated, because two
-- migrations rewriting one function body is a coin flip decided by apply order:
--
--   * a locked override being ignored rather than refused -> lane I,
--     20260909181309_a_locked_rule_is_refused_not_ignored_and_a_band_refusal_names_the_holder
--   * run-it-N-times / seven-deuce / bomb_pot_min_players drift in
--     fn_cash_apply_ruleset -> lane E, 20260909181230_..._projects_every_promise
--   * the two ghost tables the tick worklist could not see -> lane A,
--     20260909181653_the_worklist_admits_a_game_with_a_half_closed_table
--
-- THIS VERSION SORTS AFTER ALL THREE ON PURPOSE. Lane E replaces the whole body
-- of fn_cash_apply_ruleset; the remaining columns below are therefore added by
-- ANCHORED LITERAL REPLACEMENT on whatever body is live at apply time, so this
-- composes with lane E's instead of overwriting it. The anchors chosen exist in
-- BOTH the body live today and the body lane E installs, and the migration
-- refuses if an anchor is missing or not unique.
--
-- ── 1. THE PROMISE WAS ENFORCED AT THE FRONT DOOR ONLY ─────────────────────
--
-- 20260909035303 made regular_ante, vpip_floor, vpip_window and bombs come from
-- fn_cash_template_defaults inside fn_cash_game_create_impl. But the BEFORE
-- trigger on cash_games (zz_cash_game_floor_from_template, 20260907190515)
-- pins ONLY vpip_floor and vpip_window. Read at 17:36 UTC:
--
--     NEW.ruleset_snapshot := jsonb_set(
--       jsonb_set(NEW.ruleset_snapshot, '{vpip_floor}',  v_def->'vpip_floor'),
--       '{vpip_window}', v_def->'vpip_window');
--
-- So a direct UPDATE of ruleset_snapshot - an operator console, a backfill, the
-- next creation path somebody writes - can still put a small-blind ante or a
-- double-board bomb back onto a game the lobby sells as "No Antes, No Bombs".
-- That is not hypothetical: the 23 games corrected on 09-09 were created by
-- exactly such a batch write, at 2026-09-05 03:55:59, with no creator.
--
-- The trigger now pins the WHOLE promise - ante, floor, window and the bombs
-- object - on every insert and every update, from the one function that states
-- the rule. `||` rather than jsonb_set, so the bombs OBJECT is replaced whole
-- and a stale member inside it cannot survive.
--
-- ── 2. fn_cash_game_ensure DID NOT KNOW WHICH TEMPLATE IT WAS ENSURING ─────
--
-- It matched on (club_id, variant, sb, bb) alone and took ORDER BY enabled
-- DESC, created_at LIMIT 1. The template was consulted only when CREATING.
-- Measured 18:02 UTC on the platform club fade0000-0000-0000-0000-000000000001,
-- where 29 stake keys carry more than one template because Action and Madness
-- were created BEFORE Classic at the same stakes:
--
--     ensure(nlh, 1.00/2.00, 'classic')  -> "NLH 1/2 Action"
--     ensure(plo6, 2.00/5.00, 'classic') -> "PLO6 2/5 Madness"
--
-- HorseFleetManager.openPlannedTables calls this with p_template => 'classic'
-- for every Stable Hand open order, so an order for a Classic game was answered
-- with a game that charges an ante and runs a bomb pot every orbit. No chip
-- moves wrongly - the seats are bought for whatever game they land on - but the
-- floor is not the floor the planner planned, and the horse count for a Classic
-- key was being spent on a Madness table.
--
-- Two smaller things in the same body: it accepted ANY p_handedness without
-- checking the template's seat_choices (the fleet passes
-- clampSeatsForVariant(variant, 9), so a 9 would land on a 6-locked PLO game if
-- that clamp ever regressed), and it wrote a snapshot with no `table_mode` key.
-- 42 of 69 enabled Classic games carry no table_mode today - 41 from the Gate 7
-- adoption and 1 from ensure - while must_move is true on every one of them.
--
-- ── 3. THE SEAT CEILING AND THE STAKES LABEL WERE NEVER RECONCILED ─────────
--
-- fn_cash_apply_ruleset is the Gate 5 promise that "the snapshot is the rule".
-- Neither it nor its drift predicate ever named max_players, stakes,
-- small_blind, big_blind, game_variant or career_percent_min. Measured 17:50
-- UTC over the 137 open cluster tables:
--
--   * 2 PLO5 Classic tables carry max_players 7 on a game whose handedness is 6
--     (the PLO family is LOCKED at six by fn_cash_template_defaults). One of
--     them has a player sitting in seat 7 right now.
--   * 42 tables carry a legacy label - "$0.10/$0.25" where fn_cash_stakes_label
--     says "0.10/0.25", and one says "0.05/0.1" - so the lobby prints one
--     stakes string and the game card another for the same game.
--
-- THE CEILING NEVER DROPS BELOW AN OCCUPIED CHAIR. It is written as
-- GREATEST(g.handedness, highest occupied seat_number), so the 7-seat table
-- comes down to 6 at the first tick AFTER seat 7 empties. A player is never
-- closed out of a chair they are sitting in, and the seat-number guard on
-- table_seats can never be tripped by this write.
--
-- ── 4. fn_project_stake_band COULD HAND A HORSE A BAND WITH NO GAME ────────
--
-- 20260906093032_a_band_with_no_game_gets_no_horses bounds the horse ladder by
-- the bands that actually have an enabled game, folding a missing rung into the
-- one BELOW it. When nothing at or below the wanted rung exists, the COALESCE
-- falls through to p_band - the band it was asked to project away. Today micro
-- always has a game so the branch has never fired; it fires the first time an
-- operator closes the micro games while a horse holds `low`. It now falls to
-- the LOWEST band that has a game, and "no game anywhere" still returns p_band
-- so fn_assign_horse_stake_bands keeps its fail-open.
--
-- (A fifth, cosmetic: fn_cash_apply_ruleset and fn_cash_cluster_open_table both
-- default vpip_window to 40 when a snapshot lacks the key. Dan's window is ten
-- since 20260904231353 and the trigger above now guarantees the key exists, so
-- the branch is unreachable - but a reader who greps for the window finds three
-- answers. Both say 10 now.)
--
-- WHAT WAS CHECKED AND IS CORRECT, so nobody re-opens it: every enabled
-- cash_games row already agrees with its template on all four promised fields
-- (0 of 109); every open cluster table already agrees with its game on the ante
-- trio, the VPIP trio, every bomb_pot_* column, the buy-in band and the three
-- straddle spellings (0 of 137); no Classic table carries an ante, a bomb or a
-- floor and all 40 Action/Madness tables carry all three; the one-per-band law
-- holds counting variant (0 duplicate groups, no INVALID index); Classic keeps
-- all 10 of its stake levels; and fn_assign_horse_stake_bands is already bounded
-- by fn_available_stake_bands and re-clamps after hysteresis, so handoff item
-- 5.1 is closed - it cannot mint 'high' with no high game.
--
-- ROLLBACK
--   fn_cash_game_floor_from_template  -> the body in 20260907190515.
--   fn_cash_game_ensure               -> the body in 20260905034937.
--   fn_project_stake_band             -> the body in 20260906093032.
--   The two anchored edits            -> re-run the same replace in reverse;
--                                        each quotes its before and after here.
--   The row changes are idempotent projections of the snapshot and of
--   cash_games.must_move; nothing is destroyed and nothing needs reversing.
--
-- One transaction: one PostgREST schema reload (CLAUDE.md section 2, DDL policy).

BEGIN;

-- ── 1. The trigger pins the whole promise ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_cash_game_floor_from_template()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_def jsonb;
BEGIN
  IF NEW.ruleset_snapshot IS NULL THEN
    RETURN NEW;
  END IF;

  -- THE TEMPLATE IS A PROMISE TO THE PLAYER (2026-09-09). The four fields the
  -- lobby blurb names come from fn_cash_template_defaults on EVERY write, not
  -- only at creation. "No Antes, No Bombs, No VPIP Floor" cannot be true of a
  -- game whose snapshot says otherwise, whoever wrote that snapshot.
  --
  -- `||` and not jsonb_set for `bombs`: the object is replaced WHOLE, so a
  -- stale member inside it (a trigger left over from a template change) cannot
  -- survive underneath a corrected `enabled`.
  v_def := public.fn_cash_template_defaults(NEW.template_name, NEW.variant);

  NEW.ruleset_snapshot := NEW.ruleset_snapshot
    || jsonb_build_object(
         'vpip_floor',   v_def->'vpip_floor',
         'vpip_window',  v_def->'vpip_window',
         'regular_ante', v_def->'regular_ante',
         'bombs',        v_def->'bombs');

  RETURN NEW;
END;
$function$;

-- ── 2. fn_cash_game_ensure ensures the game it was asked for ───────────────
CREATE OR REPLACE FUNCTION public.fn_cash_game_ensure(p_club_id uuid, p_variant text, p_sb numeric, p_bb numeric, p_template text DEFAULT 'classic'::text, p_handedness integer DEFAULT NULL::integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  g record; v_def jsonb; v_snap jsonb; v_id uuid; v_union uuid;
  v_t text := lower(coalesce(p_template, 'classic'));
  v_v text := lower(p_variant);
  v_label text; v_variant_label text; v_name text; v_seats integer; v_choices integer[];
BEGIN
  IF v_t NOT IN ('classic', 'action', 'madness') THEN v_t := 'classic'; END IF;

  -- THE TEMPLATE IS PART OF THE KEY (2026-09-09). Classic keeps every stake and
  -- Action and Madness run one game per blind band, so the same club can - and
  -- the platform club does, on 29 keys - hold all three at the same stakes. A
  -- key matched on (club, variant, sb, bb) alone returned whichever was oldest,
  -- and on that club the oldest was Action for NLH 1/2 and Madness for PLO6
  -- 2/5: an order for a Classic game was answered with a game that charges an
  -- ante. A game ensured under one template is never another.
  SELECT * INTO g FROM public.cash_games
   WHERE club_id = p_club_id AND variant = v_v AND sb = p_sb AND bb = p_bb
     AND template_name = v_t
   ORDER BY enabled DESC, created_at LIMIT 1;
  IF FOUND THEN
    IF NOT g.enabled THEN
      UPDATE public.cash_games SET enabled = true, closed_at = NULL, closed_by = NULL, updated_at = now()
       WHERE id = g.id;
      INSERT INTO public.cash_cluster_events (game_id, kind, payload)
      VALUES (g.id, 'game_woken', jsonb_build_object('by', 'fn_cash_game_ensure'));
    END IF;
    -- A game with no open table at all: Main 1 is opened, as at creation.
    IF NOT EXISTS (SELECT 1 FROM public.tables t WHERE t.cluster_id = g.id AND t.lifecycle <> 'closed'
                    AND coalesce(t.is_deleted, false) = false) THEN
      PERFORM public.fn_cash_cluster_open_table(g.id, 'main', 1, 'live', NULL);
    END IF;
    RETURN g.id;
  END IF;

  v_def := public.fn_cash_template_defaults(v_t, v_v);
  -- HANDEDNESS IS ONE OF THE TEMPLATE'S CHOICES, as fn_cash_game_create already
  -- requires of a host (HANDEDNESS_INVALID). A machine caller that asks for a
  -- size the template does not offer gets the template's default rather than a
  -- refusal that would strand the open order, and the event records both
  -- numbers so the difference is readable rather than silent.
  SELECT array_agg(x::integer) INTO v_choices FROM jsonb_array_elements_text(v_def->'seat_choices') x;
  IF (v_def->>'seats_locked')::boolean THEN
    v_seats := (v_def->>'seats')::integer;
  ELSIF p_handedness IS NOT NULL AND p_handedness = ANY (v_choices) THEN
    v_seats := p_handedness;
  ELSE
    v_seats := (v_def->>'seats')::integer;
  END IF;

  -- table_mode was missing from every snapshot this function wrote. must_move
  -- is the column of record and this function always creates a must-move game.
  v_snap := v_def || jsonb_build_object('seats', v_seats, 'sb', p_sb, 'bb', p_bb,
                                        'table_mode', 'must_move',
                                        'resolved_at', to_jsonb(clock_timestamp()),
                                        'created_by', 'fn_cash_game_ensure');
  v_variant_label := CASE v_v
    WHEN 'nlh' THEN 'NLH' WHEN 'plo4' THEN 'PLO4' WHEN 'plo5' THEN 'PLO5' WHEN 'plo6' THEN 'PLO6'
    WHEN 'plo8' THEN 'PLO8' WHEN 'flo8' THEN 'FLO8' WHEN 'flh' THEN 'FLH'
    WHEN 'short_deck' THEN 'Short Deck' WHEN 'pineapple' THEN 'Pineapple' ELSE upper(v_v) END;
  v_label := public.fn_cash_stakes_label(p_sb, p_bb, v_v);
  v_name := left(v_variant_label || ' ' || v_label || ' ' || initcap(v_t), 60);
  SELECT u.id INTO v_union
    FROM public.fn_club_union_context(p_club_id) ctx
    JOIN public.unions u ON u.id = COALESCE(ctx.own_union_id, ctx.member_union_id);

  INSERT INTO public.cash_games
    (club_id, union_id, name, template_name, variant, sb, bb, handedness, ruleset_snapshot, created_by, must_move)
  VALUES
    (p_club_id, v_union, v_name, v_t, v_v, p_sb, p_bb, v_seats, v_snap, NULL, true)
  RETURNING id INTO v_id;
  PERFORM public.fn_cash_cluster_open_table(v_id, 'main', 1, 'live', NULL);
  INSERT INTO public.cash_cluster_events (game_id, kind, payload)
  VALUES (v_id, 'game_created', jsonb_build_object('name', v_name, 'must_move', true,
                                                   'by', 'fn_cash_game_ensure',
                                                   'template', v_t,
                                                   'seats', v_seats, 'seats_asked', p_handedness));
  RETURN v_id;
END;
$function$;

-- ── 3. A band with no game at or below folds to the lowest band that has one ─
CREATE OR REPLACE FUNCTION public.fn_project_stake_band(p_band text, p_available text[])
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH ladder(band, ord) AS (
    VALUES ('micro', 1), ('low', 2), ('mid', 3), ('high', 4)
  ),
  want AS (SELECT l.ord FROM ladder l WHERE l.band = p_band),
  avail AS (SELECT l.band, l.ord FROM ladder l WHERE l.band = ANY(COALESCE(p_available, '{}'::text[])))
  SELECT COALESCE(
           -- the wanted rung, or the nearest rung BELOW it that has a game
           (SELECT a.band FROM avail a, want w WHERE a.ord <= w.ord ORDER BY a.ord DESC LIMIT 1),
           -- nothing at or below: the LOWEST rung that has a game. This used to
           -- return p_band itself - the band with no game that the whole
           -- function exists to project away (2026-09-09).
           (SELECT a.band FROM avail a ORDER BY a.ord ASC LIMIT 1),
           -- no game anywhere: the caller (fn_assign_horse_stake_bands) has
           -- already returned without writing, and this keeps that fail-open.
           p_band
         );
$function$;

-- ── 4. The seat ceiling, the stakes label and the blinds join the projection ─
--
-- ANCHORED, NOT REWRITTEN. Lane E (20260909181230) replaces the whole body of
-- fn_cash_apply_ruleset in this same audit. Re-typing the body here would
-- silently drop its run-it-N-times work if this applied second, or lose this if
-- it applied second. So the four columns are inserted after anchors that exist
-- in BOTH bodies, and the migration refuses unless each anchor is present
-- exactly once.
DO $reconciler$
DECLARE
  v_src text; v_new text;
  -- SET-list anchor: the buy-in pair, unchanged in every version of this body.
  v_set_anchor CONSTANT text :=
    '         min_buy_in = round(g.bb * v_min_bb, 2),' || E'\n' ||
    '         max_buy_in = round(g.bb * v_max_bb, 2),';
  v_set_add CONSTANT text :=
    '         min_buy_in = round(g.bb * v_min_bb, 2),' || E'\n' ||
    '         max_buy_in = round(g.bb * v_max_bb, 2),' || E'\n' ||
    '         -- THE CEILING IS THE GAME''S HANDEDNESS, BUT NEVER BELOW AN' || E'\n' ||
    '         -- OCCUPIED CHAIR (2026-09-09). Two PLO5 Classic tables carried' || E'\n' ||
    '         -- max_players 7 on a 6-handed game and one had a player in seat' || E'\n' ||
    '         -- 7; the ceiling follows the seats down at the first tick AFTER' || E'\n' ||
    '         -- that chair empties, so nobody is closed out of a seat.' || E'\n' ||
    '         max_players = GREATEST(g.handedness,' || E'\n' ||
    '                                coalesce((SELECT max(ts.seat_number) FROM public.table_seats ts' || E'\n' ||
    '                                           WHERE ts.table_id = t.id AND ts.left_at IS NULL), 0)),' || E'\n' ||
    '         stakes = public.fn_cash_stakes_label(g.sb, g.bb, g.variant),' || E'\n' ||
    '         small_blind = g.sb, big_blind = g.bb, game_variant = g.variant,';
  -- Predicate anchor: the last of the buy-in tests, likewise unchanged.
  v_pred_anchor CONSTANT text :=
    '       OR t.max_buy_in IS DISTINCT FROM round(g.bb * v_max_bb, 2)';
  v_pred_add CONSTANT text :=
    '       OR t.max_buy_in IS DISTINCT FROM round(g.bb * v_max_bb, 2)' || E'\n' ||
    '       OR t.max_players IS DISTINCT FROM GREATEST(g.handedness,' || E'\n' ||
    '                                coalesce((SELECT max(ts.seat_number) FROM public.table_seats ts' || E'\n' ||
    '                                           WHERE ts.table_id = t.id AND ts.left_at IS NULL), 0))' || E'\n' ||
    '       OR t.stakes IS DISTINCT FROM public.fn_cash_stakes_label(g.sb, g.bb, g.variant)' || E'\n' ||
    '       OR t.small_blind IS DISTINCT FROM g.sb' || E'\n' ||
    '       OR t.big_blind IS DISTINCT FROM g.bb' || E'\n' ||
    '       OR t.game_variant IS DISTINCT FROM g.variant' || E'\n' ||
    '       OR t.career_percent_min IS DISTINCT FROM 0';
  v_win_old CONSTANT text := 'v_vpip_window := coalesce((s->>''vpip_window'')::integer, 40);';
  v_win_new CONSTANT text := 'v_vpip_window := coalesce((s->>''vpip_window'')::integer, 10);';
  v_hits integer;
BEGIN
  v_src := pg_get_functiondef('public.fn_cash_apply_ruleset(uuid)'::regprocedure);

  IF position('max_players = GREATEST(g.handedness' in v_src) > 0 THEN
    RAISE NOTICE 'fn_cash_apply_ruleset already projects the seat ceiling; nothing to do';
    RETURN;
  END IF;

  v_hits := (length(v_src) - length(replace(v_src, v_set_anchor, ''))) / length(v_set_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'the buy-in SET anchor appears % time(s) in fn_cash_apply_ruleset; read the live body before re-running', v_hits;
  END IF;
  v_hits := (length(v_src) - length(replace(v_src, v_pred_anchor, ''))) / length(v_pred_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'the buy-in predicate anchor appears % time(s) in fn_cash_apply_ruleset; read the live body before re-running', v_hits;
  END IF;

  v_new := replace(v_src, v_set_anchor, v_set_add);
  v_new := replace(v_new, v_pred_anchor, v_pred_add);
  -- The dead 40-hand default, if this body still carries it.
  IF position(v_win_old in v_new) > 0 THEN
    v_new := replace(v_new, v_win_old, v_win_new);
  END IF;

  -- Nothing this body already did may go missing in the edit.
  IF position('bomb_pot_double_board' in v_new) = 0
     OR position('maintain_percent_min = v_vpip' in v_new) = 0
     OR position('straddle_enabled = false' in v_new) = 0
     OR position('ruleset_applied' in v_new) = 0
     OR position('t.lifecycle <> ''closed''' in v_new) = 0 THEN
    RAISE EXCEPTION 'fn_cash_apply_ruleset lost a limb in the edit';
  END IF;

  EXECUTE v_new;
END;
$reconciler$;

-- ── 5. The opener's dead 40-hand default agrees with the template ──────────
DO $opener$
DECLARE
  v_src text; v_new text;
  v_old CONSTANT text := 'v_vpip_window := coalesce((s->>''vpip_window'')::integer, 40);';
  v_rep CONSTANT text := 'v_vpip_window := coalesce((s->>''vpip_window'')::integer, 10);';
  v_hits integer;
BEGIN
  v_src := pg_get_functiondef('public.fn_cash_cluster_open_table(uuid,text,integer,text,uuid)'::regprocedure);
  IF position(v_old in v_src) = 0 THEN
    IF position(v_rep in v_src) > 0 THEN
      RETURN;  -- already says ten
    END IF;
    RAISE EXCEPTION 'fn_cash_cluster_open_table is not the shape this migration expects; read the live body before re-running';
  END IF;
  v_hits := (length(v_src) - length(replace(v_src, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'the vpip_window anchor appears % time(s) in fn_cash_cluster_open_table', v_hits;
  END IF;
  v_new := replace(v_src, v_old, v_rep);
  IF position('fn_cash_stakes_label' in v_new) = 0 OR position('cash_cluster_events' in v_new) = 0 THEN
    RAISE EXCEPTION 'fn_cash_cluster_open_table lost a limb in the edit';
  END IF;
  EXECUTE v_new;
END;
$opener$;

-- ── 6. Realign the rows through the platform's own path, and prove it ──────
DO $realign$
DECLARE
  v_modes integer; v_games integer; v_tables integer; v_left integer; v_probe text;
BEGIN
  -- 6a. table_mode: 42 enabled Classic games carry no such key. must_move is
  --     the column of record; nothing about the game changes.
  UPDATE public.cash_games
     SET ruleset_snapshot = ruleset_snapshot
           || jsonb_build_object('table_mode', CASE WHEN must_move THEN 'must_move' ELSE 'manual' END),
         updated_at = now()
   WHERE ruleset_snapshot IS NOT NULL AND NOT (ruleset_snapshot ? 'table_mode');
  GET DIAGNOSTICS v_modes = ROW_COUNT;

  -- 6b. Every snapshot passes through the widened trigger once, so a game whose
  --     ante or bombs disagree with its template is corrected by the very code
  --     that will refuse the next one. Measured 0 disagreements before this
  --     runs; the pass is what PROVES that rather than assuming it.
  UPDATE public.cash_games SET ruleset_snapshot = ruleset_snapshot WHERE ruleset_snapshot IS NOT NULL;

  SELECT count(*) INTO v_games
    FROM public.cash_games g
    JOIN LATERAL public.fn_cash_template_defaults(g.template_name, g.variant) AS def ON true
   WHERE g.ruleset_snapshot->>'regular_ante' IS DISTINCT FROM def->>'regular_ante'
      OR (g.ruleset_snapshot->>'vpip_floor')::integer IS DISTINCT FROM (def->>'vpip_floor')::integer
      OR (g.ruleset_snapshot->>'vpip_window')::integer IS DISTINCT FROM (def->>'vpip_window')::integer
      OR g.ruleset_snapshot->'bombs' IS DISTINCT FROM def->'bombs'
      OR NOT (g.ruleset_snapshot ? 'table_mode');
  IF v_games <> 0 THEN
    RAISE EXCEPTION 'ABORT: % game(s) still disagree with their template promise', v_games;
  END IF;

  -- 6c. Every open cluster table takes its game's projection, through the one
  --     function allowed to write it (never a hand-written UPDATE on tables).
  SELECT coalesce(sum(public.fn_cash_apply_ruleset(id)), 0) INTO v_tables FROM public.cash_games;

  -- 6d. The assertions name only what THIS migration guarantees. Run-it, the
  --     seven-deuce bounty and bomb_pot_min_players belong to lane E and are
  --     deliberately not asserted here: this file must not fail because a
  --     sibling migration has not been applied yet.
  SELECT count(*) INTO v_left
    FROM public.tables t
    JOIN public.cash_games g ON g.id = t.cluster_id
   WHERE t.lifecycle <> 'closed' AND coalesce(t.is_deleted, false) = false
     AND (
          t.stakes IS DISTINCT FROM public.fn_cash_stakes_label(g.sb, g.bb, g.variant)
       OR t.small_blind IS DISTINCT FROM g.sb
       OR t.big_blind IS DISTINCT FROM g.bb
       OR t.game_variant IS DISTINCT FROM g.variant
       OR t.career_percent_min IS DISTINCT FROM 0
       OR t.max_players < g.handedness
       OR (t.max_players > g.handedness
           AND t.max_players > coalesce((SELECT max(ts.seat_number) FROM public.table_seats ts
                                          WHERE ts.table_id = t.id AND ts.left_at IS NULL), 0))
       -- The template contract on the felt, restated as an assertion.
       OR (g.template_name = 'classic' AND (t.ante_enabled OR t.bomb_pot_enabled OR t.nit_game))
       OR (g.template_name <> 'classic' AND NOT (t.ante_enabled AND t.bomb_pot_enabled AND t.nit_game))
       OR t.maintain_percent_min IS DISTINCT FROM (g.ruleset_snapshot->>'vpip_floor')::integer
       OR t.maintain_hands IS DISTINCT FROM (g.ruleset_snapshot->>'vpip_window')::integer
     );
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'ABORT: % live table(s) still disagree with their game', v_left;
  END IF;

  -- 6e. No seat is left outside its own table's ceiling by the write above.
  IF EXISTS (SELECT 1 FROM public.table_seats ts
               JOIN public.tables t ON t.id = ts.table_id
              WHERE ts.left_at IS NULL AND t.cluster_id IS NOT NULL
                AND t.lifecycle <> 'closed' AND ts.seat_number > t.max_players) THEN
    RAISE EXCEPTION 'ABORT: the seat ceiling was written below an occupied chair';
  END IF;

  -- 6f. The band projection can no longer name a band with no game.
  --
  -- THE CASES BELOW ARE THE ONES THAT ACTUALLY DISCRIMINATE. A first draft of
  -- this block asserted project('high', {micro}) = 'micro', which the OLD body
  -- already answered correctly (micro is below high, so the fold-down arm
  -- catches it) - a check that cannot fail, which is CLAUDE.md 10.86's trap
  -- written into an assertion. The broken arm is the one where nothing is at
  -- or BELOW the wanted rung; measured against the live unfixed function at
  -- 19:20 UTC, project('micro', {low,mid}) answered 'micro' and
  -- project('low', {mid,high}) answered 'low' - both bands with no game.
  v_probe := public.fn_project_stake_band('micro', ARRAY['low', 'mid']);
  IF v_probe <> 'low' THEN
    RAISE EXCEPTION 'ABORT: fn_project_stake_band(micro, {low,mid}) answered %', v_probe;
  END IF;
  v_probe := public.fn_project_stake_band('low', ARRAY['mid', 'high']);
  IF v_probe <> 'mid' THEN
    RAISE EXCEPTION 'ABORT: fn_project_stake_band(low, {mid,high}) answered %', v_probe;
  END IF;
  -- ...and the arms that were already right must not have moved.
  IF public.fn_project_stake_band('high', ARRAY['micro']) <> 'micro'
     OR public.fn_project_stake_band('mid', ARRAY['micro','low','mid','high']) <> 'mid'
     OR public.fn_project_stake_band('high', '{}'::text[]) <> 'high' THEN
    RAISE EXCEPTION 'ABORT: fn_project_stake_band changed an answer it should not have';
  END IF;

  RAISE NOTICE 'table_mode backfilled on % game(s); % table(s) reprojected', v_modes, v_tables;
END;
$realign$;

COMMIT;
