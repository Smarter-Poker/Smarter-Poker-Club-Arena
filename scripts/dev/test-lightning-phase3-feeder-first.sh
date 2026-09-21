#!/usr/bin/env bash
# Lightning Phase 3: a Lightning-capable game opens as a feeder.
#
# Applies 20260921025523 to a throwaway PostgreSQL 17 cluster carrying the
# PRE-migration schema AND the pre-migration FUNCTION BODIES, then exercises
# the rule the specification calls its single most important product rule
# against a real backend rather than against a reading of the file:
#
#   WHILE A LIGHTNING-CAPABLE CLUSTER HAS EXACTLY ONE LIVE TABLE, THAT TABLE
#   IS A FEEDER. FROM THE SECOND TABLE ONWARD, ORDINARY MUST-MOVE ROLES APPLY
#   UNCHANGED - OLDEST IS MAIN 1, NEWEST IS THE FEEDER.
#
# THIS MIGRATION DOES NOT CARRY THE CODE IT CHANGES, and that is what shapes
# both this file and its fixture. Sections 2, 3 and 4 of it read three
# installed bodies out of the catalogue with pg_get_functiondef, assert an
# anchor occurs exactly once in each, replace() it and EXECUTE the result. So
# scripts/dev/fixtures/lightning-phase3-feeder-first-schema.sql installs those
# three functions carrying the anchors byte for byte, and they really run: the
# create path really writes a cash_games row and opens a table, the cluster
# writer really writes a tables row, and the tick really builds a census and
# really runs the two steps Phase 3 edits. A fixture of stubs would have
# proved that the migration's text substitution succeeded and nothing about
# whether a Lightning game opens as a feeder.
#
# Six rules are built into the shape of this file. Every one of them was
# learned from mutation testing - copying the migration to a scratch
# directory, deleting one edit from the copy and watching what this harness
# does - rather than from review:
#
#   1. Every comparison is IS DISTINCT FROM, never = or <>. A NULL where a
#      value was expected makes `IF NOT (x = y)` evaluate to NULL, which
#      plpgsql takes as false, so an absent role PASSED a check written that
#      way. main_index is NULL for every feeder in this file, so this is not
#      a hypothetical.
#   2. Every negative assertion is preceded by its non-vacuity proof. "The
#      tick did not promote the lone feeder" is satisfied by a tick that never
#      promotes anything, so THE TICK STILL PROMOTES below builds the same
#      board without the Lightning flag and watches the same tick promote it.
#      That pair is one test, not two.
#   3. Every refusal pairs with the thing that must still be accepted.
#      LIGHTNING_NEEDS_MUST_MOVE is paired with a manual game that must still
#      be created, and the lightning_enabled type check is paired with an
#      UNKNOWN key that must still be ignored - the estate has no unknown-key
#      rejection and the migration's whole argument for carrying the flag in
#      p_overrides depends on it not gaining one.
#   4. A naming rule is asserted against the other answer, not against itself.
#      "The first feeder is named after its game" is only a statement because
#      the check also asserts that the name the old CASE would have produced
#      is a DIFFERENT string.
#   5. The two readers are asked about BOTH kinds of cluster. A front-table
#      definition that always returned the oldest live table would satisfy
#      every feeder-first assertion here and would silently re-order the lobby
#      for all 166 existing clusters, so every one of them is also asked of an
#      ordinary Main 1 / feeder board.
#   6. The re-apply is compared body by body, not by "it exited 0". The three
#      patched functions are re-entered on a second application and take their
#      early-return NOTICE; the two re-created ones are executed again in
#      full. Both paths must leave pg_get_functiondef byte-identical, and the
#      NOTICES themselves are asserted, because a second application that
#      silently re-patched an already-patched body would produce a different
#      body and exit 0 just the same.
#
# LIGHTNING_PHASE3_MIGRATION overrides the file under test. It exists so that
# mutation testing never has to touch the migration in the repository.
set -euo pipefail
export LC_ALL=C
root=$(git rev-parse --show-toplevel)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
migration=${LIGHTNING_PHASE3_MIGRATION:-$root/supabase/migrations/20260921025523_lightning_phase_3_a_lightning_capable_game_opens_as_a_feeder.sql}
fixture=$(mktemp -d "${TMPDIR:-/tmp}/lightning-phase3-test.XXXXXX")
started=0
cleanup() {
  # || true: the trap runs under set -e, so a non-zero stop would abort the
  # function before rm -rf and leak the fixture directory -- and make a fully
  # passing run exit 1.
  if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null || true; fi
  rm -rf "$fixture"
}
trap cleanup EXIT
mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" \
  -o "-k $fixture/socket -p 55545 -h ''" start >/dev/null
started=1

# The two assertion groups live in the throwaway directory with the cluster
# they are written for: ONE psql session, so the boards built by one section
# are still there for the next, the pre-re-apply capture can be a TEMP table,
# and the migration is applied a second time to the same backend that holds it.
cat > "$fixture/assertions.sql" <<'ASSERT'
-- Every board this file builds, so that a later section can find what an
-- earlier one made without repeating a uuid literal in nine places.
CREATE TEMP TABLE board (k text PRIMARY KEY, game_id uuid, table_id uuid, payload jsonb);

-- NEW LIGHTNING GAME (F01) ---------------------------------------------------
-- The acceptance test the phase is written for: Cluster created, state
-- MUST_MOVE, exactly one initial physical FEEDER, Lightning not active.
DO $$
DECLARE
  v_res jsonb; v_gid uuid; v_tid uuid;
  v_n bigint; v_role text; v_idx integer; v_life text; v_name text; v_game_name text;
  v_mode text; v_flag boolean;
BEGIN
  v_res := public.fn_cash_game_create_impl_20260905(
             'cb000000-0000-0000-0000-000000000001', 'classic', 'nlh', 1.00, 2.00, 9,
             '{"lightning_enabled": true}'::jsonb, 'Lightning F01', true);
  v_gid := (v_res->>'game_id')::uuid;
  v_tid := (v_res->>'table_id')::uuid;
  INSERT INTO board (k, game_id, table_id, payload) VALUES ('lightning', v_gid, v_tid, v_res);

  -- ONE Cluster, ONE table. A second table here would mean the create path
  -- opened a feeder AND kept opening a Main beside it.
  SELECT count(*) INTO v_n FROM public.tables WHERE cluster_id = v_gid;
  IF v_n IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL F01: a Lightning-capable game opened % table(s), not exactly one', v_n;
  END IF;

  SELECT t.role, t.main_index, t.lifecycle, t.name INTO v_role, v_idx, v_life, v_name
    FROM public.tables t WHERE t.cluster_id = v_gid;
  IF v_role IS DISTINCT FROM 'feeder' THEN
    RAISE EXCEPTION 'FAIL F01: the one initial table has role %, not feeder', coalesce(v_role, '<null>');
  END IF;
  IF v_idx IS DISTINCT FROM NULL THEN
    RAISE EXCEPTION 'FAIL F01: the initial feeder carries main_index %, and a feeder has none', v_idx;
  END IF;
  IF v_life IS DISTINCT FROM 'live' THEN
    RAISE EXCEPTION 'FAIL F01: the initial feeder is %, not live', coalesce(v_life, '<null>');
  END IF;
  IF (SELECT t.id FROM public.tables t WHERE t.cluster_id = v_gid) IS DISTINCT FROM v_tid THEN
    RAISE EXCEPTION 'FAIL F01: the returned table_id is not the table that was opened';
  END IF;

  -- The flag is on the row, and the mode is NOT. Phase 3 stores a capability;
  -- the population predicate is Phase 4 and the conversion is Phase 5, so a
  -- cluster_mode of 'lightning' here would be this migration doing Phase 5's
  -- job a fortnight early.
  SELECT g.lightning_enabled, g.cluster_mode, g.name INTO v_flag, v_mode, v_game_name
    FROM public.cash_games g WHERE g.id = v_gid;
  IF v_flag IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL F01: cash_games.lightning_enabled is %, not true', coalesce(v_flag::text, '<null>');
  END IF;
  IF v_mode IS DISTINCT FROM 'must_move' THEN
    RAISE EXCEPTION 'FAIL F01: cluster_mode is %, and Phase 3 converts nothing', coalesce(v_mode, '<null>');
  END IF;
  IF v_res->'lightning_enabled' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'FAIL F01: the returned object carries lightning_enabled = %, so no caller can tell what it got',
      coalesce((v_res->'lightning_enabled')::text, '<absent>');
  END IF;

  -- THE NAMING RULE, asserted against the other answer. fn_cash_cluster_open_table
  -- names every feeder `left(g.name, 50) || ' Feeder'`, which is right for the
  -- second table of a Cluster and wrong for the first, which IS the game on the
  -- board. Checking only `name = g.name` would also pass if the two strings
  -- happened to be equal, so the check asserts they are not.
  IF left(v_game_name, 50) || ' Feeder' IS NOT DISTINCT FROM v_game_name THEN
    RAISE EXCEPTION 'FAIL F01: the fixture game name makes both naming answers identical, so the name check below proves nothing';
  END IF;
  IF v_name IS DISTINCT FROM v_game_name THEN
    RAISE EXCEPTION 'FAIL F01: the initial feeder is called %, not % - the lobby would print the game as a feeder',
      coalesce(v_name, '<null>'), v_game_name;
  END IF;
END $$;
\echo '  ok  F01 LIGHTNING     one cluster, one live table, role feeder with no main_index, lightning_enabled on the row and in the answer, cluster_mode still must_move, and the table carries the game name rather than the game name plus Feeder'

-- THE ORDINARY GAME IS UNCHANGED ---------------------------------------------
-- The half that matters most in production: 166 existing Clusters and every
-- new non-Lightning one must be created exactly as they were. Both spellings
-- of "not Lightning" are asked - the flag absent, and the flag present and
-- false - because the create path reads `v_o ? 'lightning_enabled'` first and
-- an edit that got that test backwards would pass one of them.
DO $$
DECLARE
  r record; v_res jsonb; v_gid uuid; v_n bigint; v_role text; v_idx integer;
  v_name text; v_game_name text; v_flag boolean;
BEGIN
  FOR r IN SELECT * FROM (VALUES
             ('ordinary',       '{}'::jsonb,                          'Ordinary NLH Classic'),
             ('ordinary_false', '{"lightning_enabled": false}'::jsonb, 'Ordinary Flag False')
           ) AS v(k, overrides, nm)
  LOOP
    v_res := public.fn_cash_game_create_impl_20260905(
               'cb000000-0000-0000-0000-000000000001', 'classic', 'nlh', 1.00, 2.00, 9,
               r.overrides, r.nm, true);
    v_gid := (v_res->>'game_id')::uuid;
    INSERT INTO board (k, game_id, table_id, payload)
    VALUES (r.k, v_gid, (v_res->>'table_id')::uuid, v_res);

    SELECT count(*) INTO v_n FROM public.tables WHERE cluster_id = v_gid;
    IF v_n IS DISTINCT FROM 1::bigint THEN
      RAISE EXCEPTION 'FAIL ordinary(%): opened % table(s), not exactly one', r.k, v_n;
    END IF;
    SELECT t.role, t.main_index, t.name INTO v_role, v_idx, v_name
      FROM public.tables t WHERE t.cluster_id = v_gid;
    IF v_role IS DISTINCT FROM 'main' THEN
      RAISE EXCEPTION 'FAIL ordinary(%): the initial table has role %, not main', r.k, coalesce(v_role, '<null>');
    END IF;
    IF v_idx IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'FAIL ordinary(%): the initial main is index %, not 1', r.k, coalesce(v_idx::text, '<null>');
    END IF;
    SELECT g.name, g.lightning_enabled INTO v_game_name, v_flag FROM public.cash_games g WHERE g.id = v_gid;
    IF v_flag IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'FAIL ordinary(%): lightning_enabled is %, not false', r.k, coalesce(v_flag::text, '<null>');
    END IF;
    IF v_name IS DISTINCT FROM v_game_name THEN
      RAISE EXCEPTION 'FAIL ordinary(%): Main 1 is called %, not %', r.k, coalesce(v_name, '<null>'), v_game_name;
    END IF;
    -- The answer still tells the caller, and it tells it the truth.
    IF v_res->'lightning_enabled' IS DISTINCT FROM 'false'::jsonb THEN
      RAISE EXCEPTION 'FAIL ordinary(%): the returned object carries lightning_enabled = %', r.k,
        coalesce((v_res->'lightning_enabled')::text, '<absent>');
    END IF;
  END LOOP;
END $$;
\echo '  ok  ORDINARY UNCHANGED a game created with no flag and a game created with the flag false both open exactly one table, role main index 1, named after the game, with lightning_enabled false on the row and in the answer'

-- THE TWO REFUSALS, AND WHAT MUST STILL BE ACCEPTED ---------------------------
-- Each refusal is asserted on the NAME in SQLERRM, not merely on "it raised":
-- this create path has eighteen other RAISE EXCEPTIONs and any of them would
-- satisfy a check that only asked whether something went wrong.
DO $$
DECLARE
  v_msg text; v_raised boolean; v_res jsonb; v_n bigint; v_role text; v_idx integer;
BEGIN
  -- (1) The flag is a boolean or it is nothing. jsonb_typeof rather than a
  --     cast, so the caller sees a named refusal instead of a 22P02.
  v_raised := false;
  BEGIN
    PERFORM public.fn_cash_game_create_impl_20260905(
              'cb000000-0000-0000-0000-000000000001', 'classic', 'nlh', 1.00, 2.00, 9,
              '{"lightning_enabled": "yes"}'::jsonb, 'Refused Flag Text', true);
  EXCEPTION WHEN others THEN v_msg := SQLERRM; v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FAIL refusals: lightning_enabled = "yes" was ACCEPTED, and a string is not true or false';
  END IF;
  IF position('OVERRIDE_INVALID: lightning_enabled must be true or false' in coalesce(v_msg, '')) = 0 THEN
    RAISE EXCEPTION 'FAIL refusals: refused with "%", not the named OVERRIDE_INVALID', coalesce(v_msg, '<none>');
  END IF;

  -- (2) A Lightning game IS a Cluster; a manual (R9) table has no controller
  --     and can never grow a second table, so it can never reach Lightning.
  v_raised := false;
  BEGIN
    PERFORM public.fn_cash_game_create_impl_20260905(
              'cb000000-0000-0000-0000-000000000001', 'classic', 'nlh', 1.00, 2.00, 9,
              '{"lightning_enabled": true}'::jsonb, 'Refused Manual Lightning', false);
  EXCEPTION WHEN others THEN v_msg := SQLERRM; v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FAIL refusals: a manual table was created Lightning-capable, and a manual table is not a Cluster';
  END IF;
  IF position('LIGHTNING_NEEDS_MUST_MOVE' in coalesce(v_msg, '')) = 0 THEN
    RAISE EXCEPTION 'FAIL refusals: refused with "%", not the named LIGHTNING_NEEDS_MUST_MOVE', coalesce(v_msg, '<none>');
  END IF;

  -- THE ACCEPT HALF OF (2). Same call, flag absent: a manual game is still a
  -- game. Without this, the refusal above is satisfied by a create path that
  -- refuses every manual table.
  v_res := public.fn_cash_game_create_impl_20260905(
             'cb000000-0000-0000-0000-000000000001', 'classic', 'nlh', 1.00, 2.00, 9,
             '{}'::jsonb, 'Manual Table Still Fine', false);
  INSERT INTO board (k, game_id, table_id, payload)
  VALUES ('manual', (v_res->>'game_id')::uuid, (v_res->>'table_id')::uuid, v_res);
  IF (v_res->>'must_move')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL refusals: the manual game came back must_move = %', coalesce(v_res->>'must_move', '<absent>');
  END IF;
  SELECT count(*) INTO v_n FROM public.tables WHERE cluster_id = (v_res->>'game_id')::uuid;
  IF v_n IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL refusals: the accepted manual game opened % table(s)', v_n;
  END IF;

  -- THE ACCEPT HALF OF (1), and the migration's own premise. p_overrides has
  -- no key whitelist, no jsonb_object_keys scan and no set difference: an
  -- unrecognised key is silently dropped, which is the only reason the flag
  -- can travel in p_overrides at all. A create path that GAINED an unknown-key
  -- rejection would break every caller that sends an extra key and would make
  -- the migration's central argument false.
  v_res := public.fn_cash_game_create_impl_20260905(
             'cb000000-0000-0000-0000-000000000001', 'classic', 'nlh', 1.00, 2.00, 9,
             '{"lightning_enabled": false, "some_unknown_key": 1}'::jsonb, 'Unknown Key Accepted', true);
  INSERT INTO board (k, game_id, table_id, payload)
  VALUES ('unknown_key', (v_res->>'game_id')::uuid, (v_res->>'table_id')::uuid, v_res);
  SELECT t.role, t.main_index INTO v_role, v_idx
    FROM public.tables t WHERE t.cluster_id = (v_res->>'game_id')::uuid;
  IF v_role IS DISTINCT FROM 'main' OR v_idx IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL refusals: the unknown-key game opened % / %, not main / 1',
      coalesce(v_role, '<null>'), coalesce(v_idx::text, '<null>');
  END IF;

  -- AND A SIBLING GUARD STILL FIRES. Section 2 of the migration asserts that
  -- OVERRIDE_LOCKED survived its replace(); this asserts that what survived
  -- still refuses, which a text search cannot.
  v_raised := false;
  BEGIN
    PERFORM public.fn_cash_game_create_impl_20260905(
              'cb000000-0000-0000-0000-000000000001', 'classic', 'nlh', 1.00, 2.00, 9,
              '{"locked_field": 1}'::jsonb, 'Refused Locked Field', true);
  EXCEPTION WHEN others THEN v_msg := SQLERRM; v_raised := true;
  END;
  IF NOT v_raised OR position('OVERRIDE_LOCKED' in coalesce(v_msg, '')) = 0 THEN
    RAISE EXCEPTION 'FAIL refusals: the OVERRIDE_LOCKED sibling guard no longer refuses (raised %, message %)',
      v_raised, coalesce(v_msg, '<none>');
  END IF;
END $$;
\echo '  ok  REFUSALS           a non-boolean flag is refused by name and a Lightning manual table is refused by name, while a manual game with no flag, a game carrying an unknown override key and the surviving OVERRIDE_LOCKED guard all still behave as they did'

-- THE TICK LEAVES THE LONE FEEDER ALONE --------------------------------------
-- Without this the migration would be correct for under five seconds: the
-- ROLES step's no_live_main arm promotes a lone live feeder to Main 1 on the
-- next tick, so a creation-path-only change would be undone automatically.
DO $$
DECLARE
  v_gid uuid; v_tid uuid; v_res jsonb; v_role text; v_idx integer; v_n bigint; v_events bigint;
BEGIN
  SELECT b.game_id, b.table_id INTO v_gid, v_tid FROM board b WHERE b.k = 'lightning';
  v_res := public.fn_cash_cluster_tick(v_gid, 0);

  -- NON-VACUITY: the tick actually ran, and it actually saw the feeder. A tick
  -- that returned early (not_found, manual_game, a frozen platform) would
  -- leave the table alone for reasons that have nothing to do with Phase 3.
  IF (v_res->>'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL lone feeder: the tick did not run (%)', v_res::text;
  END IF;
  IF (v_res->>'tables')::integer IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL lone feeder: the tick counted % live table(s), so its census never saw the feeder it was supposed to leave alone',
      coalesce(v_res->>'tables', '<absent>');
  END IF;

  SELECT count(*) INTO v_n FROM public.tables WHERE cluster_id = v_gid;
  IF v_n IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL lone feeder: the tick left % table(s) on a cluster that had one', v_n;
  END IF;
  SELECT t.role, t.main_index INTO v_role, v_idx FROM public.tables t WHERE t.id = v_tid;
  IF v_role IS DISTINCT FROM 'feeder' THEN
    RAISE EXCEPTION 'FAIL lone feeder: one tick turned the Lightning cluster''s only table into a %', coalesce(v_role, '<null>');
  END IF;
  IF v_idx IS DISTINCT FROM NULL THEN
    RAISE EXCEPTION 'FAIL lone feeder: the lone feeder was given main_index %', v_idx;
  END IF;

  SELECT count(*) INTO v_events FROM public.cash_cluster_events e
   WHERE e.game_id = v_gid AND e.kind = 'feeder_promoted_to_main';
  IF v_events IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'FAIL lone feeder: % feeder_promoted_to_main event(s) were written for a cluster whose feeder was not promoted', v_events;
  END IF;
  -- The ledger is not simply empty for this game: the create path wrote the
  -- feeder_opened row, so "no promotion row" is a statement about which rows
  -- are there rather than about a table nobody writes to.
  SELECT count(*) INTO v_events FROM public.cash_cluster_events e WHERE e.game_id = v_gid;
  IF v_events < 1::bigint THEN
    RAISE EXCEPTION 'FAIL lone feeder: the event ledger holds nothing at all for this cluster, so the absence above proves nothing';
  END IF;
END $$;
\echo '  ok  LONE FEEDER        a tick of the Lightning cluster leaves its one table a feeder with no main_index and writes no feeder_promoted_to_main, against a ledger that already holds the feeder_opened row'

-- THE TICK STILL PROMOTES A NON-LIGHTNING LONE FEEDER ------------------------
-- The accept half of the check above, and the reason it is a test at all. The
-- board is identical - one live feeder, no main - and the only difference is
-- the flag. A tick that had simply lost its promotion arm would pass LONE
-- FEEDER and fail here.
DO $$
DECLARE
  v_gid uuid := 'ca000000-0000-0000-0000-0000000000c5';
  v_tid uuid := 'ab000000-0000-0000-0000-0000000000c5';
  v_res jsonb; v_role text; v_idx integer; v_name text; v_game_name text; v_events bigint;
BEGIN
  INSERT INTO public.cash_games
    (id, club_id, union_id, name, template_name, variant, sb, bb, handedness,
     ruleset_snapshot, created_by, must_move, lightning_enabled, created_at)
  VALUES
    (v_gid, 'cb000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-0000000000f1',
     'Ordinary Lone Feeder', 'classic', 'nlh', 1.00, 2.00, 9, '{"seats": 9}'::jsonb,
     '00000000-0000-0000-0000-0000000000aa', true, false, clock_timestamp());
  INSERT INTO public.tables
    (id, club_id, name, game_variant, small_blind, big_blind, max_players, status,
     cluster_id, role, main_index, lifecycle, opened_at, live_at, created_at)
  VALUES
    (v_tid, 'cb000000-0000-0000-0000-000000000001', 'Ordinary Lone Feeder Feeder', 'nlh',
     1.00, 2.00, 9, 'waiting', v_gid, 'feeder', NULL, 'live',
     clock_timestamp(), clock_timestamp(), clock_timestamp());
  INSERT INTO board (k, game_id, table_id) VALUES ('ordinary_lone_feeder', v_gid, v_tid);

  -- NON-VACUITY: the board really is a lone live feeder before the tick.
  SELECT t.role INTO v_role FROM public.tables t WHERE t.id = v_tid;
  IF v_role IS DISTINCT FROM 'feeder' THEN
    RAISE EXCEPTION 'FAIL promotes: the fixture board is not a feeder before the tick (%)', coalesce(v_role, '<null>');
  END IF;

  v_res := public.fn_cash_cluster_tick(v_gid, 0);
  IF (v_res->>'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL promotes: the tick did not run (%)', v_res::text;
  END IF;

  SELECT t.role, t.main_index, t.name INTO v_role, v_idx, v_name FROM public.tables t WHERE t.id = v_tid;
  SELECT g.name INTO v_game_name FROM public.cash_games g WHERE g.id = v_gid;
  IF v_role IS DISTINCT FROM 'main' THEN
    RAISE EXCEPTION 'FAIL promotes: a NON-Lightning lone feeder was left a %, so the suppression above is not about Lightning at all',
      coalesce(v_role, '<null>');
  END IF;
  IF v_idx IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL promotes: the promoted table is main_index %, not 1', coalesce(v_idx::text, '<null>');
  END IF;
  IF v_name IS DISTINCT FROM v_game_name THEN
    RAISE EXCEPTION 'FAIL promotes: the promoted table is called %, not % - the name must not change under the players',
      coalesce(v_name, '<null>'), v_game_name;
  END IF;
  SELECT count(*) INTO v_events FROM public.cash_cluster_events e
   WHERE e.game_id = v_gid AND e.kind = 'feeder_promoted_to_main';
  IF v_events IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL promotes: % feeder_promoted_to_main event(s) written, not 1 - so the absence asserted for the Lightning cluster was an absence of a row nobody writes',
      v_events;
  END IF;
END $$;
\echo '  ok  STILL PROMOTES     the same tick on the same board without the flag promotes the lone feeder to main index 1, renames it after the game and writes the feeder_promoted_to_main row whose absence the previous check asserted'

-- THE SECOND TABLE RESTORES ORDINARY MUST-MOVE -------------------------------
-- The promotion is DEFERRED, not disabled. The moment there is a second table
-- for a Main to be the Main OF, the ordinary ROLES step fires and the Cluster
-- is an ordinary must-move game: oldest is Main 1, newest is the feeder.
DO $$
DECLARE
  v_gid uuid; v_old uuid; v_new uuid; v_res jsonb;
  v_role text; v_idx integer; v_name text; v_game_name text; v_n bigint;
BEGIN
  SELECT b.game_id, b.table_id INTO v_gid, v_old FROM board b WHERE b.k = 'lightning';
  v_new := public.fn_cash_cluster_open_table(v_gid, 'feeder', NULL, 'live', NULL);
  INSERT INTO board (k, game_id, table_id) VALUES ('lightning_second', v_gid, v_new);

  -- NON-VACUITY: two live tables, and the older one is still a feeder, so the
  -- promotion below is something the tick did and not something it inherited.
  SELECT count(*) INTO v_n FROM public.tables t
   WHERE t.cluster_id = v_gid AND t.lifecycle = 'live' AND coalesce(t.is_deleted, false) = false;
  IF v_n IS DISTINCT FROM 2::bigint THEN
    RAISE EXCEPTION 'FAIL second table: the cluster has % live table(s), not 2', v_n;
  END IF;
  SELECT t.role INTO v_role FROM public.tables t WHERE t.id = v_old;
  IF v_role IS DISTINCT FROM 'feeder' THEN
    RAISE EXCEPTION 'FAIL second table: the older table is already a % before the tick', coalesce(v_role, '<null>');
  END IF;
  IF (SELECT t.created_at FROM public.tables t WHERE t.id = v_old)
     >= (SELECT t.created_at FROM public.tables t WHERE t.id = v_new) THEN
    RAISE EXCEPTION 'FAIL second table: the two tables are not ordered in time, so "oldest becomes Main 1" cannot be tested';
  END IF;

  v_res := public.fn_cash_cluster_tick(v_gid, 0);
  IF (v_res->>'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL second table: the tick did not run (%)', v_res::text;
  END IF;

  SELECT g.name INTO v_game_name FROM public.cash_games g WHERE g.id = v_gid;
  SELECT t.role, t.main_index, t.name INTO v_role, v_idx, v_name FROM public.tables t WHERE t.id = v_old;
  IF v_role IS DISTINCT FROM 'main' OR v_idx IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL second table: the OLDER table is % / %, not main / 1 - must-move has nothing to move players onto',
      coalesce(v_role, '<null>'), coalesce(v_idx::text, '<null>');
  END IF;
  IF v_name IS DISTINCT FROM v_game_name THEN
    RAISE EXCEPTION 'FAIL second table: the promoted table is called %, not %', coalesce(v_name, '<null>'), v_game_name;
  END IF;
  SELECT t.role, t.main_index INTO v_role, v_idx FROM public.tables t WHERE t.id = v_new;
  IF v_role IS DISTINCT FROM 'feeder' THEN
    RAISE EXCEPTION 'FAIL second table: the NEWER table is a %, and the newest physical table is the feeder', coalesce(v_role, '<null>');
  END IF;
  IF v_idx IS DISTINCT FROM NULL THEN
    RAISE EXCEPTION 'FAIL second table: the newer feeder carries main_index %', v_idx;
  END IF;
END $$;
\echo '  ok  SECOND TABLE       opening a second table on the Lightning cluster and ticking makes the OLDER table main index 1 under the game name and leaves the newer one a feeder: ordinary must-move, deferred rather than disabled'

-- R3 REOPENS THE RIGHT KIND OF TABLE -----------------------------------------
-- An enabled game always has a live table; anything that closed the last one
-- is undone by R3 on the next tick. For a Lightning-capable Cluster the table
-- R3 reopens is a feeder, for exactly the reason the created one is - and for
-- an ordinary Cluster it is still Main 1, which is the half that protects the
-- 166 Clusters live today.
DO $$
DECLARE
  r record; v_res jsonb; v_live bigint; v_role text; v_idx integer; v_want_key text;
BEGIN
  FOR r IN SELECT b.k, b.game_id FROM board b WHERE b.k IN ('lightning', 'ordinary') ORDER BY b.k LOOP
    -- Close every table this cluster has, by both liveness fields.
    UPDATE public.tables SET lifecycle = 'closed', status = 'closed', updated_at = now()
     WHERE cluster_id = r.game_id;

    -- NON-VACUITY: nothing is live, so what comes back was opened by R3.
    SELECT count(*) INTO v_live FROM public.tables t
     WHERE t.cluster_id = r.game_id AND t.lifecycle <> 'closed' AND coalesce(t.is_deleted, false) = false;
    IF v_live IS DISTINCT FROM 0::bigint THEN
      RAISE EXCEPTION 'FAIL R3(%): % table(s) are still live before the tick', r.k, v_live;
    END IF;

    v_res := public.fn_cash_cluster_tick(r.game_id, 0);
    IF (v_res->>'ok')::boolean IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'FAIL R3(%): the tick did not run (%)', r.k, v_res::text;
    END IF;

    SELECT count(*) INTO v_live FROM public.tables t
     WHERE t.cluster_id = r.game_id AND t.lifecycle <> 'closed' AND coalesce(t.is_deleted, false) = false;
    IF v_live IS DISTINCT FROM 1::bigint THEN
      RAISE EXCEPTION 'FAIL R3(%): R3 left % live table(s), not exactly one', r.k, v_live;
    END IF;
    SELECT t.role, t.main_index INTO v_role, v_idx FROM public.tables t
     WHERE t.cluster_id = r.game_id AND t.lifecycle <> 'closed' AND coalesce(t.is_deleted, false) = false;

    IF r.k = 'lightning' THEN
      v_want_key := 'feeder1';
      IF v_role IS DISTINCT FROM 'feeder' THEN
        RAISE EXCEPTION 'FAIL R3(lightning): R3 reopened a %, and a Lightning-capable cluster''s one table is a feeder', coalesce(v_role, '<null>');
      END IF;
      IF v_idx IS DISTINCT FROM NULL THEN
        RAISE EXCEPTION 'FAIL R3(lightning): the reopened feeder carries main_index %', v_idx;
      END IF;
      IF (v_res->'actions' @> '[{"feeder1": "opened"}]'::jsonb) IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'FAIL R3(lightning): the tick reported actions %, which do not say a feeder was opened', coalesce((v_res->'actions')::text, '<absent>');
      END IF;
    ELSE
      v_want_key := 'main1';
      IF v_role IS DISTINCT FROM 'main' THEN
        RAISE EXCEPTION 'FAIL R3(ordinary): R3 reopened a %, and an ordinary cluster always has Main 1', coalesce(v_role, '<null>');
      END IF;
      IF v_idx IS DISTINCT FROM 1 THEN
        RAISE EXCEPTION 'FAIL R3(ordinary): the reopened main is index %, not 1', coalesce(v_idx::text, '<null>');
      END IF;
      IF (v_res->'actions' @> '[{"main1": "opened"}]'::jsonb) IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'FAIL R3(ordinary): the tick reported actions %, which do not say a Main 1 was opened', coalesce((v_res->'actions')::text, '<absent>');
      END IF;
    END IF;

    -- And it did not ALSO report the other one: R3 opens one table, not two.
    IF r.k = 'lightning' AND (v_res->'actions' @> '[{"main1": "opened"}]'::jsonb) IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'FAIL R3(lightning): the tick reported a Main 1 open as well as a feeder open (%)', (v_res->'actions')::text;
    END IF;
    IF r.k = 'ordinary' AND (v_res->'actions' @> '[{"feeder1": "opened"}]'::jsonb) IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'FAIL R3(ordinary): the tick reported a feeder open on an ordinary cluster (%)', (v_res->'actions')::text;
    END IF;
  END LOOP;
END $$;
\echo '  ok  R3 REOPEN          a Lightning cluster with no live table gets a feeder back and reports feeder1, an ordinary one gets main index 1 back and reports main1, and neither reports the other'

-- THE FRONT TABLE ------------------------------------------------------------
-- One definition for the three readers that ask "which table stands for this
-- game": Main 1 when the Cluster has a live one, otherwise the oldest live
-- table. The ORDER BY is the whole function, so all four of its terms are
-- asked separately.
DO $$
DECLARE
  v_g_main  uuid := 'ca000000-0000-0000-0000-0000000000f2';
  v_g_old   uuid := 'ca000000-0000-0000-0000-0000000000f3';
  v_g_skip  uuid := 'ca000000-0000-0000-0000-0000000000f4';
  v_feeder1 uuid; v_main1 uuid; v_feeder_a uuid; v_feeder_b uuid;
  v_closed uuid; v_deleted uuid; v_live uuid;
  v_front uuid;
BEGIN
  -- (a) A CLUSTER WHOSE OLDEST TABLE IS A FEEDER AND WHICH ALSO HAS A LIVE
  --     MAIN 1. This is the shape that tells the two candidate definitions
  --     apart: "oldest live table" answers the feeder and "Main 1 when there
  --     is one" answers the Main, and only the second is right.
  INSERT INTO public.cash_games
    (id, club_id, union_id, name, template_name, variant, sb, bb, handedness,
     ruleset_snapshot, created_by, must_move, created_at)
  VALUES (v_g_main, 'cb000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-0000000000f1',
          'Front Main Wins', 'classic', 'nlh', 1.00, 2.00, 9, '{"seats": 9}'::jsonb,
          '00000000-0000-0000-0000-0000000000aa', true, clock_timestamp());
  INSERT INTO public.tables (club_id, name, game_variant, small_blind, big_blind, max_players,
                             status, cluster_id, role, main_index, lifecycle, created_at)
  VALUES ('cb000000-0000-0000-0000-000000000001', 'Front Main Wins Feeder', 'nlh', 1.00, 2.00, 9,
          'waiting', v_g_main, 'feeder', NULL, 'live', clock_timestamp())
  RETURNING id INTO v_feeder1;
  INSERT INTO public.tables (club_id, name, game_variant, small_blind, big_blind, max_players,
                             status, cluster_id, role, main_index, lifecycle, created_at)
  VALUES ('cb000000-0000-0000-0000-000000000001', 'Front Main Wins', 'nlh', 1.00, 2.00, 9,
          'waiting', v_g_main, 'main', 1, 'live', clock_timestamp())
  RETURNING id INTO v_main1;
  INSERT INTO board (k, game_id, table_id) VALUES ('front_main', v_g_main, v_main1);

  -- NON-VACUITY: the feeder really is older, so "not the oldest" is a real
  -- statement about this board rather than an accident of insertion order.
  IF (SELECT t.created_at FROM public.tables t WHERE t.id = v_feeder1)
     >= (SELECT t.created_at FROM public.tables t WHERE t.id = v_main1) THEN
    RAISE EXCEPTION 'FAIL front table: the feeder is not older than the Main 1, so this board cannot tell the two definitions apart';
  END IF;
  v_front := public.fn_cash_cluster_front_table(v_g_main);
  IF v_front IS DISTINCT FROM v_main1 THEN
    RAISE EXCEPTION 'FAIL front table: a cluster with a live Main 1 answered %, and the Main 1 is %',
      coalesce(v_front::text, '<null>'), v_main1::text;
  END IF;

  -- (b) NO LIVE MAIN 1: the oldest live table is the game.
  INSERT INTO public.cash_games
    (id, club_id, union_id, name, template_name, variant, sb, bb, handedness,
     ruleset_snapshot, created_by, must_move, lightning_enabled, created_at)
  VALUES (v_g_old, 'cb000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-0000000000f1',
          'Front Oldest Wins', 'classic', 'nlh', 1.00, 2.00, 9, '{"seats": 9}'::jsonb,
          '00000000-0000-0000-0000-0000000000aa', true, true, clock_timestamp());
  INSERT INTO public.tables (club_id, name, game_variant, small_blind, big_blind, max_players,
                             status, cluster_id, role, main_index, lifecycle, created_at)
  VALUES ('cb000000-0000-0000-0000-000000000001', 'Front Oldest Wins', 'nlh', 1.00, 2.00, 9,
          'waiting', v_g_old, 'feeder', NULL, 'live', clock_timestamp())
  RETURNING id INTO v_feeder_a;
  INSERT INTO public.tables (club_id, name, game_variant, small_blind, big_blind, max_players,
                             status, cluster_id, role, main_index, lifecycle, created_at)
  VALUES ('cb000000-0000-0000-0000-000000000001', 'Front Oldest Wins Feeder', 'nlh', 1.00, 2.00, 9,
          'waiting', v_g_old, 'feeder', NULL, 'live', clock_timestamp())
  RETURNING id INTO v_feeder_b;
  INSERT INTO board (k, game_id, table_id) VALUES ('front_oldest', v_g_old, v_feeder_a);
  IF v_feeder_a IS NOT DISTINCT FROM v_feeder_b THEN
    RAISE EXCEPTION 'FAIL front table: the two feeders are the same row';
  END IF;
  v_front := public.fn_cash_cluster_front_table(v_g_old);
  IF v_front IS DISTINCT FROM v_feeder_a THEN
    RAISE EXCEPTION 'FAIL front table: a cluster with no live Main 1 answered %, and its oldest live table is %',
      coalesce(v_front::text, '<null>'), v_feeder_a::text;
  END IF;

  -- (c) A CLUSTER THAT DOES NOT EXIST answers NULL rather than raising: the
  --     two readers call this inside a query and a raise there would take the
  --     tick worklist down with it.
  v_front := public.fn_cash_cluster_front_table('00000000-0000-0000-0000-000000000000'::uuid);
  IF v_front IS DISTINCT FROM NULL THEN
    RAISE EXCEPTION 'FAIL front table: a cluster that does not exist answered %', v_front::text;
  END IF;

  -- (d) CLOSED AND DELETED ARE SKIPPED, and both are the tables that would
  --     otherwise WIN: the closed one is the oldest row and the deleted one is
  --     a Main 1, so either filter going missing changes this answer.
  INSERT INTO public.cash_games
    (id, club_id, union_id, name, template_name, variant, sb, bb, handedness,
     ruleset_snapshot, created_by, must_move, lightning_enabled, created_at)
  VALUES (v_g_skip, 'cb000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-0000000000f1',
          'Front Skips Dead', 'classic', 'nlh', 1.00, 2.00, 9, '{"seats": 9}'::jsonb,
          '00000000-0000-0000-0000-0000000000aa', true, true, clock_timestamp());
  INSERT INTO public.tables (club_id, name, game_variant, small_blind, big_blind, max_players,
                             status, cluster_id, role, main_index, lifecycle, created_at)
  VALUES ('cb000000-0000-0000-0000-000000000001', 'Front Skips Dead', 'nlh', 1.00, 2.00, 9,
          'closed', v_g_skip, 'main', 1, 'closed', clock_timestamp())
  RETURNING id INTO v_closed;
  INSERT INTO public.tables (club_id, name, game_variant, small_blind, big_blind, max_players,
                             status, cluster_id, role, main_index, lifecycle, is_deleted, created_at)
  VALUES ('cb000000-0000-0000-0000-000000000001', 'Front Skips Dead Ghost', 'nlh', 1.00, 2.00, 9,
          'waiting', v_g_skip, 'main', 1, 'live', true, clock_timestamp())
  RETURNING id INTO v_deleted;
  INSERT INTO public.tables (club_id, name, game_variant, small_blind, big_blind, max_players,
                             status, cluster_id, role, main_index, lifecycle, created_at)
  VALUES ('cb000000-0000-0000-0000-000000000001', 'Front Skips Dead Feeder', 'nlh', 1.00, 2.00, 9,
          'waiting', v_g_skip, 'feeder', NULL, 'live', clock_timestamp())
  RETURNING id INTO v_live;
  INSERT INTO board (k, game_id, table_id) VALUES ('front_skip', v_g_skip, v_live);

  IF (SELECT count(*) FROM public.tables t WHERE t.cluster_id = v_g_skip) IS DISTINCT FROM 3::bigint THEN
    RAISE EXCEPTION 'FAIL front table: the skip board does not hold three rows, so the two filters have nothing to filter';
  END IF;
  v_front := public.fn_cash_cluster_front_table(v_g_skip);
  IF v_front IS DISTINCT FROM v_live THEN
    RAISE EXCEPTION 'FAIL front table: the skip board answered % - closed is % and is_deleted is % - and the one live table is %',
      coalesce(v_front::text, '<null>'), v_closed::text, v_deleted::text, v_live::text;
  END IF;

  -- AND THE ANSWER DID NOT MOVE for the cluster that was already in the
  -- database before the migration ran.
  IF public.fn_cash_cluster_front_table('ca000000-0000-0000-0000-0000000000e1'::uuid)
     IS DISTINCT FROM 'ab000000-0000-0000-0000-0000000000e1'::uuid THEN
    RAISE EXCEPTION 'FAIL front table: the pre-existing cluster''s front table moved';
  END IF;
END $$;
\echo '  ok  FRONT TABLE        Main 1 wins over an older live feeder, the oldest live table wins when there is no Main 1, a cluster that does not exist answers NULL, a closed oldest row and a deleted Main 1 are both skipped, and the pre-existing cluster answers what it always did'

-- THE WORKLIST ---------------------------------------------------------------
-- fn_cash_clusters_to_tick.main1_table_id is what the ClusterController reads
-- to count eligible horses and to decide whether an engine must exist. A NULL
-- there means the Cluster is created and then never ticks, never opens a
-- second table, and never reaches a Lightning threshold at all - so for a
-- feeder-first Cluster this column is the difference between a product and a
-- dead row.
DO $$
DECLARE
  v_res jsonb; v_gid uuid; v_tid uuid; v_rows bigint; v_answer uuid; v_old_answer uuid;
BEGIN
  v_res := public.fn_cash_game_create_impl_20260905(
             'cb000000-0000-0000-0000-000000000001', 'classic', 'nlh', 1.00, 2.00, 9,
             '{"lightning_enabled": true}'::jsonb, 'Worklist Lightning', true);
  v_gid := (v_res->>'game_id')::uuid;
  v_tid := (v_res->>'table_id')::uuid;
  INSERT INTO board (k, game_id, table_id, payload) VALUES ('worklist_lightning', v_gid, v_tid, v_res);

  -- NON-VACUITY: the question the worklist USED to ask answers NULL for this
  -- board, so "it is not NULL any more" is a change and not a coincidence.
  SELECT t.id INTO v_old_answer FROM public.tables t
   WHERE t.cluster_id = v_gid AND t.role = 'main' AND t.main_index = 1
     AND t.lifecycle <> 'closed' AND coalesce(t.is_deleted, false) = false
   ORDER BY t.created_at LIMIT 1;
  IF v_old_answer IS DISTINCT FROM NULL THEN
    RAISE EXCEPTION 'FAIL worklist: this board has a live Main 1 (%), so it is not a feeder-first cluster at all', v_old_answer::text;
  END IF;

  SELECT count(*) INTO v_rows FROM public.fn_cash_clusters_to_tick();
  IF v_rows < 2::bigint THEN
    RAISE EXCEPTION 'FAIL worklist: the worklist returned % row(s); with fewer than two clusters on it the checks below compare one answer to itself', v_rows;
  END IF;

  SELECT w.main1_table_id INTO v_answer FROM public.fn_cash_clusters_to_tick() w WHERE w.game_id = v_gid;
  IF v_answer IS DISTINCT FROM v_tid THEN
    RAISE EXCEPTION 'FAIL worklist: the feeder-first cluster reports main1_table_id %, and its one feeder is % - a NULL here is a cluster that never ticks',
      coalesce(v_answer::text, '<null>'), v_tid::text;
  END IF;

  -- THE UNCHANGED HALF: an ordinary cluster still reports its Main 1, and it
  -- is the cluster that was in the database before the migration ran.
  SELECT w.main1_table_id INTO v_answer FROM public.fn_cash_clusters_to_tick() w
   WHERE w.game_id = 'ca000000-0000-0000-0000-0000000000e1'::uuid;
  IF v_answer IS DISTINCT FROM 'ab000000-0000-0000-0000-0000000000e1'::uuid THEN
    RAISE EXCEPTION 'FAIL worklist: the pre-existing ordinary cluster reports main1_table_id %, not its Main 1',
      coalesce(v_answer::text, '<null>');
  END IF;

  -- A manual (R9) game is still not a Cluster and is still not on the list.
  IF EXISTS (SELECT 1 FROM public.fn_cash_clusters_to_tick() w
              JOIN board b ON b.k = 'manual' AND b.game_id = w.game_id) THEN
    RAISE EXCEPTION 'FAIL worklist: a manual table appeared on the cluster worklist';
  END IF;
END $$;
\echo '  ok  WORKLIST           a feeder-first cluster reports its feeder as main1_table_id where the old question answered NULL, an ordinary cluster still reports its Main 1, a manual game is still absent, and the list carries at least two clusters'

-- THE MUST-MOVE LIST ---------------------------------------------------------
-- Its whole job is to list everyone who is NOT in the main game. Spelled as
-- "not on Main 1" it listed every seated player of a feeder-first Cluster,
-- including the ones sitting in the only game there is.
DO $$
DECLARE
  v_res jsonb; v_gid uuid; v_feeder uuid; v_second uuid;
  v_p1 uuid := 'aa000000-0000-0000-0000-000000000001';
  v_p2 uuid := 'aa000000-0000-0000-0000-000000000002';
  v_p3 uuid := 'aa000000-0000-0000-0000-000000000003';
  v_rows bigint; v_user uuid; v_table uuid; v_old_rows bigint;
BEGIN
  v_res := public.fn_cash_game_create_impl_20260905(
             'cb000000-0000-0000-0000-000000000001', 'classic', 'nlh', 1.00, 2.00, 9,
             '{"lightning_enabled": true}'::jsonb, 'Lobby Lightning', true);
  v_gid := (v_res->>'game_id')::uuid;
  v_feeder := (v_res->>'table_id')::uuid;
  INSERT INTO board (k, game_id, table_id, payload) VALUES ('lobby_lightning', v_gid, v_feeder, v_res);

  INSERT INTO public.cash_game_roster (game_id, user_id) VALUES (v_gid, v_p1), (v_gid, v_p2);
  INSERT INTO public.table_seats (table_id, user_id, seat_number, stack)
  VALUES (v_feeder, v_p1, 1, 200), (v_feeder, v_p2, 2, 200);

  -- NON-VACUITY: the old question would have listed both of them. Without
  -- this the zero below is satisfied by an empty roster or an empty seat map.
  SELECT count(*) INTO v_old_rows
    FROM public.cash_game_roster r
    JOIN public.table_seats ts ON ts.user_id = r.user_id AND ts.left_at IS NULL
    JOIN public.tables t ON t.id = ts.table_id AND t.cluster_id = r.game_id AND t.lifecycle <> 'closed'
   WHERE r.game_id = v_gid AND r.left_at IS NULL
     AND NOT (t.role = 'main' AND t.main_index = 1);
  IF v_old_rows IS DISTINCT FROM 2::bigint THEN
    RAISE EXCEPTION 'FAIL lobby: the old "not on Main 1" question answers % here, not 2, so the zero below proves nothing', v_old_rows;
  END IF;

  SELECT count(*) INTO v_rows FROM public.fn_cash_game_must_move_list(v_gid);
  IF v_rows IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'FAIL lobby: % player(s) on a feeder-first cluster''s only table are listed as waiting to move; they are IN the main game', v_rows;
  END IF;

  -- A SECOND TABLE, AND THE THIRD PLAYER IS A MOVER. The front table is still
  -- the older feeder, so exactly the player who is not on it is listed.
  v_second := public.fn_cash_cluster_open_table(v_gid, 'feeder', NULL, 'live', NULL);
  INSERT INTO public.cash_game_roster (game_id, user_id) VALUES (v_gid, v_p3);
  INSERT INTO public.table_seats (table_id, user_id, seat_number, stack) VALUES (v_second, v_p3, 1, 200);

  SELECT count(*) INTO v_rows FROM public.fn_cash_game_must_move_list(v_gid);
  IF v_rows IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL lobby: the two-table feeder-first cluster lists % player(s), not the one on the second table', v_rows;
  END IF;
  SELECT m.user_id, m.table_id INTO v_user, v_table FROM public.fn_cash_game_must_move_list(v_gid) m;
  IF v_user IS DISTINCT FROM v_p3 THEN
    RAISE EXCEPTION 'FAIL lobby: the listed player is %, not the one seated on the second table', coalesce(v_user::text, '<null>');
  END IF;
  IF v_table IS DISTINCT FROM v_second THEN
    RAISE EXCEPTION 'FAIL lobby: the listed player is shown on %, not on the second table %', coalesce(v_table::text, '<null>'), v_second::text;
  END IF;
END $$;

DO $$
DECLARE
  v_res jsonb; v_gid uuid; v_main uuid; v_feeder uuid;
  v_pm uuid := 'aa000000-0000-0000-0000-000000000011';
  v_pf uuid := 'aa000000-0000-0000-0000-000000000012';
  v_rows bigint; v_user uuid; v_role text; v_idx integer;
BEGIN
  -- THE UNCHANGED HALF. An ordinary Cluster with a Main 1 and a feeder must
  -- answer exactly what it always answered: the feeder's players, and not the
  -- Main 1's. A front-table definition that always returned the oldest live
  -- table would pass every feeder-first check above and fail here.
  v_res := public.fn_cash_game_create_impl_20260905(
             'cb000000-0000-0000-0000-000000000001', 'classic', 'nlh', 1.00, 2.00, 9,
             '{}'::jsonb, 'Lobby Ordinary', true);
  v_gid := (v_res->>'game_id')::uuid;
  v_main := (v_res->>'table_id')::uuid;
  v_feeder := public.fn_cash_cluster_open_table(v_gid, 'feeder', NULL, 'live', NULL);
  INSERT INTO board (k, game_id, table_id, payload) VALUES ('lobby_ordinary', v_gid, v_main, v_res);

  SELECT t.role, t.main_index INTO v_role, v_idx FROM public.tables t WHERE t.id = v_main;
  IF v_role IS DISTINCT FROM 'main' OR v_idx IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL lobby ordinary: the board is % / %, not the Main 1 plus feeder shape this check needs',
      coalesce(v_role, '<null>'), coalesce(v_idx::text, '<null>');
  END IF;

  INSERT INTO public.cash_game_roster (game_id, user_id) VALUES (v_gid, v_pm), (v_gid, v_pf);
  INSERT INTO public.table_seats (table_id, user_id, seat_number, stack)
  VALUES (v_main, v_pm, 1, 200), (v_feeder, v_pf, 1, 200);

  SELECT count(*) INTO v_rows FROM public.fn_cash_game_must_move_list(v_gid);
  IF v_rows IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL lobby ordinary: the lobby lists % player(s) on a Main 1 plus feeder board, not the one on the feeder', v_rows;
  END IF;
  SELECT m.user_id INTO v_user FROM public.fn_cash_game_must_move_list(v_gid) m;
  IF v_user IS DISTINCT FROM v_pf THEN
    RAISE EXCEPTION 'FAIL lobby ordinary: the listed player is %, and the feeder''s player is %', coalesce(v_user::text, '<null>'), v_pf::text;
  END IF;
  IF EXISTS (SELECT 1 FROM public.fn_cash_game_must_move_list(v_gid) m WHERE m.user_id = v_pm) THEN
    RAISE EXCEPTION 'FAIL lobby ordinary: the Main 1 player is listed as waiting to move out of the game he is already in';
  END IF;
END $$;
\echo '  ok  MUST-MOVE LIST     two players on a feeder-first cluster''s only table are listed as movers by the old question and by the new one are not, a third player on its second table is the only mover, and an ordinary Main 1 plus feeder board still lists the feeder and not the Main'

-- The preimage of the re-apply: the exact text of every function the migration
-- creates or patches, plus the shape of the board it must not touch.
CREATE TEMP TABLE pre_reapply_fn AS
  SELECT x.fn,
         pg_get_functiondef(x.fn::regprocedure) AS def
    FROM unnest(ARRAY[
      'public.fn_cash_game_create_impl_20260905(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean)',
      'public.fn_cash_cluster_open_table(uuid,text,integer,text,uuid)',
      'public.fn_cash_cluster_tick(uuid,integer)',
      'public.fn_cash_clusters_to_tick()',
      'public.fn_cash_game_must_move_list(uuid)',
      'public.fn_cash_cluster_front_table(uuid)']) AS x(fn);

CREATE TEMP TABLE pre_reapply_tables AS SELECT * FROM public.tables;
CREATE TEMP TABLE pre_reapply_games  AS SELECT * FROM public.cash_games;
CREATE TEMP TABLE pre_reapply_events AS SELECT * FROM public.cash_cluster_events;
CREATE TEMP TABLE pre_reapply_counts AS
  SELECT (SELECT count(*) FROM public.cash_games)          AS games,
         (SELECT count(*) FROM public.tables)              AS tables_,
         (SELECT count(*) FROM public.cash_cluster_events) AS events,
         (SELECT count(*) FROM public.table_seats)         AS seats,
         (SELECT count(*) FROM pre_reapply_fn)             AS fns;
ASSERT

cat > "$fixture/reapply-assertions.sql" <<'REAPPLY'
-- IDEMPOTENT RE-APPLY --------------------------------------------------------
-- Reaching this file at all means the second psql -f of the migration exited 0
-- under ON_ERROR_STOP; what is left is that it changed nothing. That is a
-- sharper question here than in a schema migration: three of these five
-- functions are patched by SUBSTITUTION against whatever is installed, so a
-- second application that did not take its early-return NOTICE would patch an
-- already-patched body - doubling a branch, or failing an anchor count - and a
-- harness that only asked "did it exit 0" would not see the difference.
DO $$
DECLARE c pre_reapply_counts%ROWTYPE; v_bad text;
BEGIN
  SELECT * INTO c FROM pre_reapply_counts;
  IF c.games IS NULL THEN RAISE EXCEPTION 'FAIL re-apply: the pre-re-apply capture is empty'; END IF;
  -- Non-vacuity: there is a board to leave alone, and six bodies to compare.
  IF LEAST(c.games, c.tables_, c.events, c.seats) < 1 THEN
    RAISE EXCEPTION 'FAIL re-apply: a relation is empty before the re-apply (games % / tables % / events % / seats %), so "nothing moved" compares nothing to nothing',
      c.games, c.tables_, c.events, c.seats;
  END IF;
  IF c.fns IS DISTINCT FROM 6::bigint THEN
    RAISE EXCEPTION 'FAIL re-apply: % function bodies were captured, not 6', c.fns;
  END IF;

  -- THE FIVE PATCHED OR RE-CREATED BODIES, PLUS THE NEW ONE, BYTE FOR BYTE.
  SELECT string_agg(p.fn, ', ' ORDER BY p.fn) INTO v_bad
    FROM pre_reapply_fn p
   WHERE pg_get_functiondef(p.fn::regprocedure) IS DISTINCT FROM p.def;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL re-apply: the second application changed the body of %', v_bad;
  END IF;

  IF (SELECT count(*) FROM public.cash_games) IS DISTINCT FROM c.games THEN
    RAISE EXCEPTION 'FAIL re-apply: cash_games went from % rows to %', c.games, (SELECT count(*) FROM public.cash_games); END IF;
  IF (SELECT count(*) FROM public.tables) IS DISTINCT FROM c.tables_ THEN
    RAISE EXCEPTION 'FAIL re-apply: tables went from % rows to %', c.tables_, (SELECT count(*) FROM public.tables); END IF;
  IF (SELECT count(*) FROM public.cash_cluster_events) IS DISTINCT FROM c.events THEN
    RAISE EXCEPTION 'FAIL re-apply: cash_cluster_events went from % rows to %', c.events, (SELECT count(*) FROM public.cash_cluster_events); END IF;

  -- Stronger than counts: not one column of one row moved.
  IF EXISTS (SELECT * FROM pre_reapply_tables EXCEPT SELECT * FROM public.tables)
     OR EXISTS (SELECT * FROM public.tables EXCEPT SELECT * FROM pre_reapply_tables) THEN
    RAISE EXCEPTION 'FAIL re-apply: a table row changed on the second application'; END IF;
  IF EXISTS (SELECT * FROM pre_reapply_games EXCEPT SELECT * FROM public.cash_games)
     OR EXISTS (SELECT * FROM public.cash_games EXCEPT SELECT * FROM pre_reapply_games) THEN
    RAISE EXCEPTION 'FAIL re-apply: a cash_games row changed on the second application'; END IF;
  IF EXISTS (SELECT * FROM pre_reapply_events EXCEPT SELECT * FROM public.cash_cluster_events)
     OR EXISTS (SELECT * FROM public.cash_cluster_events EXCEPT SELECT * FROM pre_reapply_events) THEN
    RAISE EXCEPTION 'FAIL re-apply: a cash_cluster_events row changed on the second application'; END IF;

  -- And the behaviour is still there after the second pass, asked of the one
  -- board that only the new definition can answer.
  IF (SELECT public.fn_cash_cluster_front_table(b.game_id) FROM board b WHERE b.k = 'worklist_lightning')
     IS DISTINCT FROM (SELECT b.table_id FROM board b WHERE b.k = 'worklist_lightning') THEN
    RAISE EXCEPTION 'FAIL re-apply: the feeder-first cluster lost its front table on the second application';
  END IF;
END $$;
\echo '  ok  RE-APPLY           the migration applied a second time left all six function bodies byte-identical and moved no cash_games, tables or cash_cluster_events row'
REAPPLY

# ONE psql session, five files: the pre-migration schema and bodies, the
# migration, the assertions, the migration AGAIN, and the re-apply assertions.
# Output is teed rather than left on the terminal because the last assertion is
# about three NOTICES, and a NOTICE is the only evidence that the three
# substituting DO blocks took their early return instead of patching an
# already-patched body.
set +e
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55545 -d postgres \
  -f "$root/scripts/dev/fixtures/lightning-phase3-feeder-first-schema.sql" \
  -f "$migration" \
  -f "$fixture/assertions.sql" \
  -f "$migration" \
  -f "$fixture/reapply-assertions.sql" 2>&1 | tee "$fixture/psql.out"
psql_status=${PIPESTATUS[0]}
set -e
if [ "$psql_status" != 0 ]; then
  echo "FAIL: psql exited $psql_status"
  exit 1
fi

# THE THREE NOTICES. Each of the three substituting DO blocks opens with a
# sentinel - a string the patched body carries and the unpatched one does not -
# and returns early when it finds it. Exactly ONE occurrence of each proves
# both halves: the FIRST application did the work (or the notice would appear
# twice) and the SECOND application did not (or it would not appear at all).
notice_once() {
  local want="$1" label="$2" n
  n=$(grep -c -F -- "$want" "$fixture/psql.out" || true)
  if [ "$n" != 1 ]; then
    echo "FAIL re-apply notice: '$label' was announced $n time(s), not once; a first pass that skipped or a second pass that re-patched both land here"
    exit 1
  fi
}
notice_once 'already opens a feeder for a Lightning-capable game' 'create path'
notice_once 'already names a first-table feeder after the game'   'cluster writer'
notice_once "already leaves a Lightning cluster's lone feeder alone" 'tick'
echo '  ok  RE-APPLY NOTICES  each of the three substituting blocks announced its early return exactly once, so the first pass patched and the second pass did not'

echo 'PASS: Lightning Phase 3 feeder-first must-move, 11 checks: a Lightning-capable game opens exactly one live table with role feeder and no main_index under the game name with lightning_enabled on the row and in the answer and cluster_mode still must_move, a game with no flag and a game with the flag false both still open Main 1 named after the game, a non-boolean flag and a Lightning manual table are both refused by name while a manual game an unknown override key and the OVERRIDE_LOCKED sibling guard all still behave as before, the tick leaves a Lightning lone feeder alone and writes no feeder_promoted_to_main while the same tick on the same board without the flag promotes it and writes that row, a second table restores ordinary must-move with the older table as Main 1 under the game name and the newer as feeder, R3 reopens a feeder reporting feeder1 for a Lightning cluster and Main 1 reporting main1 for an ordinary one, the front table is Main 1 over an older live feeder and the oldest live table without one and NULL for a cluster that does not exist and skips closed and deleted rows, the tick worklist reports a feeder-first cluster feeder where the old question answered NULL and still reports an ordinary Main 1, the must-move lobby lists nobody on a feeder-first cluster single table and exactly the second table player once there is one and still lists the feeder and not the Main on an ordinary board, and the migration is idempotent on re-apply with all six bodies byte-identical and each of its three substituting blocks announcing its early return exactly once'
