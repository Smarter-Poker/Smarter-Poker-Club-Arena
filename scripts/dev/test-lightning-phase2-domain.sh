#!/usr/bin/env bash
# Lightning Phase 2: the pool, the slot, the instance, the reservation and the ledger.
#
# Applies 20260920235343 to a throwaway PostgreSQL 17 cluster carrying the
# PRE-migration schema -- public.cash_cluster_events without cluster_epoch, and
# three event rows that already exist -- and then exercises every invariant the
# migration encodes as a CONSTRAINT against a real backend rather than against a
# reading of the file.
#
# THE MODEL HAS THREE LEVELS. cash_player_session is the economic identity
# (Phase 1). lightning_pool_session is one player's participation period in one
# Cluster. lightning_pool_slot is ONE OF THAT PLAYER'S SIMULTANEOUS TABLES, and
# it is where everything that is true of a TABLE rather than of a PLAYER lives:
# orbit position, wait percentiles, per-table counters, and when that table
# opened and closed. Most of this file exists to prove that the levels do not
# leak into each other, because every defect found in this migration so far was
# a per-table fact stored in a per-player column.
#
# Phase 2 is a schema phase: nothing writes to these seven relations yet, so
# there is no behaviour to test except the behaviour of the constraints
# themselves. That makes VACUITY the whole risk. Six rules are built into the
# shape of this file, and every one of them was learned from mutation testing
# rather than from review:
#
#   1. Every comparison is IS DISTINCT FROM, never = or <>. A NULL where a value
#      was expected makes `IF NOT (x = y)` evaluate to NULL, which plpgsql takes
#      as false, so an absent column PASSED a check written that way.
#   2. A refusal is only proved when the NAME of the refusing constraint is
#      checked. Asserting only "it was refused" survives the deletion of the
#      constraint actually under test whenever a second one would also fire.
#   3. A guard that is never EXERCISED is not covered. Every partial index here
#      is provoked twice: once for the collision it must raise, and once for the
#      row it must LET THROUGH.
#   4. Every rule that REFUSES something is paired with the thing it must still
#      ACCEPT. lightning_pool_slot_one_open and the two per-instance seat
#      indexes are the sharp cases: keyed too widely they double-assign a
#      player, keyed too narrowly they make multi-table Lightning impossible,
#      and only the two halves together can tell those apart.
#   5. Grants are asserted in BOTH directions. anon, authenticated and PUBLIC
#      must hold nothing, and service_role must hold something: a check of the
#      negative half alone stays green when the whole Lightning family is
#      unreachable by the API role. The fixture is built so neither half can go
#      vacuous, and both of those fixture properties are asserted below.
#   6. A column that MOVED is asserted in both places -- present where it now
#      belongs, and ABSENT where it used to be. p95_wait_ms back on
#      lightning_pool_session, or hands_since_bb back on lightning_blind_ledger,
#      would break no test that only looked for them on lightning_pool_slot, and
#      both are exactly the defect this schema was restructured to remove.
#
# LIGHTNING_PHASE2_MIGRATION overrides the file under test. It exists so that
# mutation testing -- copying the migration to a scratch directory, deleting one
# constraint from the copy and watching this harness go red -- never has to
# touch the migration in the repository.
set -euo pipefail
root=$(git rev-parse --show-toplevel)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
migration=${LIGHTNING_PHASE2_MIGRATION:-$root/supabase/migrations/20260920235343_lightning_phase_2_the_pool_the_instance_the_reservation_and_.sql}
fixture=$(mktemp -d "${TMPDIR:-/tmp}/lightning-phase2-test.XXXXXX")
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
  -o "-k $fixture/socket -p 55542 -h ''" start >/dev/null
started=1

# The two assertion groups live in the throwaway directory with the cluster they
# are written for: ONE psql session, so the pre-re-apply capture can be a TEMP
# table and the migration is applied a second time to the same backend that
# holds it.
cat > "$fixture/assertions.sql" <<'ASSERT'
-- TABLES ---------------------------------------------------------------------
-- The seven relations, the one new column, and the two foreign keys that make
-- the three levels a hierarchy rather than three piles. relkind = 'r' rather
-- than to_regclass, because to_regclass answers yes for an index of the name.
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(x.want, ', ' ORDER BY x.want) INTO v_missing
    FROM unnest(ARRAY['lightning_pool_session','lightning_pool_slot','lightning_instance',
                      'lightning_reservation','lightning_blind_ledger','lightning_hand',
                      'lightning_hand_player']) AS x(want)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = x.want AND c.relkind = 'r');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL tables: the migration did not create %', v_missing;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'cash_cluster_events'
                    AND column_name = 'cluster_epoch') THEN
    RAISE EXCEPTION 'FAIL tables: cash_cluster_events.cluster_epoch does not exist, so no Lightning event can say which seating regime it happened under';
  END IF;

  -- The two links that make the levels a chain: a slot belongs to a session, a
  -- hold and a hand row belong to a SLOT and not to a player. And the slot says
  -- which seating regime it opened under, like every one of its siblings.
  SELECT string_agg(format('%s.%s', x.t, x.c), ', ' ORDER BY x.t, x.c) INTO v_missing
    FROM (VALUES ('lightning_pool_slot','pool_session_id'),
                 ('lightning_pool_slot','cluster_epoch'),
                 ('lightning_reservation','pool_slot_id'),
                 ('lightning_hand_player','pool_slot_id')) AS x(t, c)
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'public' AND table_name = x.t AND column_name = x.c);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL tables: the three-level model is not wired up -- missing %', v_missing;
  END IF;

  -- Every Lightning relation that is scoped to a cluster carries its epoch.
  -- lightning_pool_slot is the per-TABLE record; a slot that spans a
  -- must_move -> lightning conversion with no epoch cannot be segmented by the
  -- seating regime it was played under.
  SELECT string_agg(x.t, ', ' ORDER BY x.t) INTO v_missing
    FROM unnest(ARRAY['lightning_pool_session','lightning_pool_slot','lightning_instance',
                      'lightning_reservation','lightning_hand']) AS x(t)
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'public' AND table_name = x.t AND column_name = 'cluster_epoch');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL tables: cluster-scoped relation(s) % carry no cluster_epoch', v_missing;
  END IF;

  -- The pre-existing index on the altered table is still there: an ADD COLUMN
  -- must not cost the event ledger its by-game read path.
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'cash_cluster_events_by_game') THEN
    RAISE EXCEPTION 'FAIL tables: the pre-existing cash_cluster_events_by_game index is gone';
  END IF;
END $$;
\echo '  ok  TABLES             all seven Lightning relations exist, the slot links session to hold and to hand, cash_cluster_events.cluster_epoch was added'

-- EXISTING ROWS DEFAULTED ----------------------------------------------------
-- The migration's central claim about the altered table: "The default of 0
-- keeps all four existing insert shapes compiling untouched". On an EMPTY table
-- that is unfalsifiable, so the fixture seeded three rows one statement before
-- the migration ran.
DO $$
DECLARE v_seeded bigint; v_bad bigint; v_nullable text; v_default text; v_raised boolean := false; v_constraint text;
BEGIN
  SELECT count(*) INTO v_seeded FROM public.cash_cluster_events
   WHERE kind IN ('fixture_pre_migration_opened','fixture_pre_migration_seated','fixture_pre_migration_closed');
  IF v_seeded IS DISTINCT FROM 3::bigint THEN
    RAISE EXCEPTION 'FAIL defaulted: the fixture must seed 3 pre-migration events for a default to be provable on existing data, found %', v_seeded;
  END IF;

  SELECT count(*) INTO v_bad FROM public.cash_cluster_events WHERE cluster_epoch IS DISTINCT FROM 0;
  IF v_bad IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'FAIL defaulted: % pre-existing event row(s) do not read cluster_epoch = 0, so the column default is not the epoch every existing cluster is at (values: %)',
      v_bad, (SELECT string_agg(DISTINCT cluster_epoch::text, ', ') FROM public.cash_cluster_events);
  END IF;

  SELECT is_nullable, column_default INTO v_nullable, v_default
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'cash_cluster_events' AND column_name = 'cluster_epoch';
  IF v_nullable IS DISTINCT FROM 'NO' THEN
    RAISE EXCEPTION 'FAIL defaulted: cluster_epoch is nullable (is_nullable = %), so an event can decline to say which epoch it happened under', coalesce(v_nullable, '<absent>');
  END IF;
  IF v_default IS DISTINCT FROM '0' THEN
    RAISE EXCEPTION 'FAIL defaulted: the cluster_epoch default is %, not 0', coalesce(v_default, '<none>');
  END IF;

  -- A NEW row written in the oldest insert shape still takes the default.
  INSERT INTO public.cash_cluster_events (game_id, kind)
  VALUES ('c1a50000-0000-0000-0000-000000000001', 'fixture_post_migration');
  IF (SELECT cluster_epoch FROM public.cash_cluster_events WHERE kind = 'fixture_post_migration')
     IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL defaulted: an insert that does not name cluster_epoch did not get 0';
  END IF;

  -- And the epoch cannot go backwards.
  BEGIN
    UPDATE public.cash_cluster_events SET cluster_epoch = -1 WHERE kind = 'fixture_post_migration';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'FAIL defaulted: cash_cluster_events accepted cluster_epoch = -1'; END IF;
  IF v_constraint IS DISTINCT FROM 'cash_cluster_events_epoch_nonneg' THEN
    RAISE EXCEPTION 'FAIL defaulted: refused by %, not the named cash_cluster_events_epoch_nonneg', coalesce(v_constraint, '<unnamed>');
  END IF;
END $$;
\echo '  ok  EXISTING DEFAULTED the three pre-migration events all read epoch 0; the column is NOT NULL DEFAULT 0 and refuses -1'

-- RLS AND GRANTS -------------------------------------------------------------
-- The security posture the whole estate depends on, asserted in BOTH
-- directions. Every Lightning table is created in `public`, where this
-- project's ALTER DEFAULT PRIVILEGES grants ALL on new tables to anon and
-- authenticated BY NAME: RLS plus the REVOKE are the only two things standing
-- between a browser-facing role and the pool. And service_role's access must be
-- STATED, because service_role's BYPASSRLS bypasses ROW security and is not a
-- table privilege -- a Lightning family with no GRANT is one the API cannot
-- read.
DO $$
DECLARE v_tables text[] := ARRAY['lightning_pool_session','lightning_pool_slot','lightning_instance',
                                 'lightning_reservation','lightning_blind_ledger','lightning_hand',
                                 'lightning_hand_player'];
        v_bad text; v_n bigint;
BEGIN
  SELECT count(*) INTO v_n
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = ANY (v_tables) AND c.relkind = 'r';
  IF v_n IS DISTINCT FROM 7::bigint THEN
    RAISE EXCEPTION 'FAIL rls: % of the seven Lightning relations are visible in pg_class, so this check would be vacuous', v_n;
  END IF;

  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO v_bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = ANY (v_tables)
     AND c.relrowsecurity IS DISTINCT FROM true;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL rls: ROW LEVEL SECURITY is OFF on %, so any role that reaches the table reads every row of it', v_bad;
  END IF;

  -- NEGATIVE HALF. information_schema, the view the migration's own @live-proof
  -- reads.
  SELECT string_agg(format('%s/%s/%s', g.table_name, g.grantee, g.privilege_type), ', '
                    ORDER BY g.table_name, g.grantee, g.privilege_type) INTO v_bad
    FROM information_schema.role_table_grants g
   WHERE g.table_schema = 'public' AND g.table_name = ANY (v_tables)
     AND g.grantee IN ('anon', 'authenticated', 'PUBLIC');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL grants: a browser-facing role holds privileges on a Lightning table: %', v_bad;
  END IF;

  -- pg_class.relacl, the raw ACL, which does not depend on which roles the
  -- reading session happens to be a member of. grantee = 0 is PUBLIC.
  SELECT string_agg(format('%s/%s/%s', c.relname,
                           coalesce(pg_get_userbyid(a.grantee), 'PUBLIC'), a.privilege_type), ', '
                    ORDER BY c.relname, coalesce(pg_get_userbyid(a.grantee), 'PUBLIC'), a.privilege_type)
    INTO v_bad
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) a
   WHERE n.nspname = 'public' AND c.relname = ANY (v_tables)
     AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) IN ('anon', 'authenticated'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL grants: pg_class.relacl still carries a browser-facing grant: %', v_bad;
  END IF;

  -- POSITIVE HALF. The negative half alone is satisfied by a Lightning family
  -- that NOBODY can reach; that is not the posture, it is an outage.
  SELECT string_agg(x.want || '/' || x.priv, ', ' ORDER BY x.want, x.priv) INTO v_bad
    FROM (SELECT t AS want, p AS priv
            FROM unnest(v_tables) AS t
            CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS p) x
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.role_table_grants g
      WHERE g.table_schema = 'public' AND g.table_name = x.want
        AND g.grantee = 'service_role' AND g.privilege_type = x.priv);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL grants: service_role does NOT hold privilege(s) the API needs: %. BYPASSRLS bypasses row security and is not a table privilege, so without an explicit GRANT the relation is unreachable', v_bad;
  END IF;

  -- Non-vacuity of the negative half: the fixture's default privileges DID
  -- fire, and a new table in this schema really is born open to anon.
  IF NOT EXISTS (
    SELECT 1 FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
     WHERE n.nspname = 'public' AND d.defaclobjtype = 'r'
       AND array_to_string(d.defaclacl, ',') LIKE '%anon=%') THEN
    RAISE EXCEPTION 'FAIL grants: the fixture did not install ALTER DEFAULT PRIVILEGES granting anon on new tables in public, so every REVOKE in the migration is a no-op and the negative half proves nothing';
  END IF;

  -- Non-vacuity of the POSITIVE half: service_role must NOT be in that default
  -- ACL. An aclitem from ALTER DEFAULT PRIVILEGES is byte-identical to one from
  -- an explicit GRANT, so if the fixture inherited service_role's access the
  -- check above would stay green with every GRANT deleted from the migration.
  IF EXISTS (
    SELECT 1 FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
     WHERE n.nspname = 'public' AND d.defaclobjtype = 'r'
       AND array_to_string(d.defaclacl, ',') LIKE '%service_role=%') THEN
    RAISE EXCEPTION 'FAIL grants: the fixture grants service_role through ALTER DEFAULT PRIVILEGES, so the positive half cannot tell a stated GRANT from an inherited one and would pass with every GRANT deleted';
  END IF;
END $$;
\echo '  ok  RLS AND GRANTS     RLS on all seven; anon/authenticated/PUBLIC hold nothing and service_role holds SELECT/INSERT/UPDATE/DELETE on every one'

-- LEVELS ---------------------------------------------------------------------
-- Rule 6. Every column that MOVED is asserted in both places: present on the
-- slot, ABSENT from the level it left. Both of the defects this schema was
-- restructured to remove -- a per-table wait percentile on a per-player row,
-- and a per-table orbit counter on a per-identity ledger -- would be invisible
-- to a test that only checked the new home.
DO $$
DECLARE v_bad text;
BEGIN
  -- Gone from the participation period: one p95 cannot describe three tables,
  -- and a multi-tabler waits at three while playing a fourth, so a summed
  -- wait_total_ms would exceed the elapsed session.
  SELECT string_agg(c, ', ' ORDER BY c) INTO v_bad
    FROM unnest(ARRAY['wait_total_ms','wait_samples','p95_wait_ms','p99_wait_ms',
                      'hands','fast_folds','normal_folds','fold_and_watch','showdowns']) AS c
   WHERE EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'lightning_pool_session'
                    AND column_name = c);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL levels: lightning_pool_session carries per-TABLE column(s) %, which cannot describe a player at three tables -- the session-level total is the sum of the slots and is stored nowhere', v_bad;
  END IF;

  -- Present on the table they describe.
  SELECT string_agg(c, ', ' ORDER BY c) INTO v_bad
    FROM unnest(ARRAY['wait_total_ms','wait_samples','p95_wait_ms','p99_wait_ms',
                      'hands','fast_folds','normal_folds','fold_and_watch','showdowns',
                      'hands_since_bb','hands_since_sb','last_bb_at','last_sb_at','last_button_at',
                      'opened_at','closed_at','close_reason']) AS c
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'public' AND table_name = 'lightning_pool_slot'
                        AND column_name = c);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL levels: lightning_pool_slot is missing %, so there is nowhere per-table truth can live', v_bad;
  END IF;

  -- Gone from the per-identity ledger: a player at three tables has three
  -- independent orbits.
  SELECT string_agg(c, ', ' ORDER BY c) INTO v_bad
    FROM unnest(ARRAY['hands_since_bb','hands_since_sb','last_bb_at','last_sb_at','last_button_at']) AS c
   WHERE EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'lightning_blind_ledger'
                    AND column_name = c);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL levels: lightning_blind_ledger carries per-TABLE orbit column(s) % again -- one integer cannot say 3 hands since BB at one table and 7 at another, and the BB candidate ordering would be answering the wrong question', v_bad;
  END IF;

  -- The money DOES aggregate and stays where the identity is.
  SELECT string_agg(c, ', ' ORDER BY c) INTO v_bad
    FROM unnest(ARRAY['missed_bb_debt','missed_sb_debt','bb_owed','sb_owed',
                      'bb_count','sb_count','btn_count','utg_count','hj_count','co_count']) AS c
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'public' AND table_name = 'lightning_blind_ledger'
                        AND column_name = c);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL levels: lightning_blind_ledger lost %, which is owed by the human to the Cluster and does aggregate', v_bad;
  END IF;
  SELECT string_agg(c, ', ' ORDER BY c) INTO v_bad
    FROM unnest(ARRAY['starting_stack','ending_stack','net_result']) AS c
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'public' AND table_name = 'lightning_pool_session'
                        AND column_name = c);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL levels: lightning_pool_session lost %, but the money is the identity''s and belongs at identity level', v_bad;
  END IF;

  -- And the superseded per-player homes are gone by NAME too.
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'lightning_blind_ledger_oldest_bb') THEN
    RAISE EXCEPTION 'FAIL levels: lightning_blind_ledger_oldest_bb still exists -- the BB candidate ordering is being asked of a PLAYER when the question is asked of a table';
  END IF;
  SELECT string_agg(x.want, ', ' ORDER BY x.want) INTO v_bad
    FROM unnest(ARRAY['lightning_pool_session_counters_nonneg','lightning_reservation_slot_positive',
                      'lightning_hand_player_slot_positive']) AS x(want)
   WHERE EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
                  WHERE n.nspname = 'public' AND c.conname = x.want);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL levels: superseded constraint(s) % still exist, so two levels are both claiming the same fact', v_bad;
  END IF;
END $$;
\echo '  ok  LEVELS             wait, counters and orbit live on the SLOT and are gone from the session and the ledger; the money stayed with the identity'

-- ONE OPEN POOL SESSION ------------------------------------------------------
-- P11: "Any player may have at most one active economic identity in the
-- Cluster." Provoked twice: the collision it must raise, and the re-entry it
-- must LET THROUGH once the first period has exited.
DO $$
DECLARE v_raised boolean := false; v_constraint text;
BEGIN
  INSERT INTO public.lightning_pool_session
    (id, cluster_id, cluster_epoch, player_id, cash_player_session_id, state)
  VALUES ('b0010000-0000-0000-0000-000000000001', 'c1a50000-0000-0000-0000-000000000001', 0,
          '70000000-0000-0000-0000-000000000001', '5e550000-0000-0000-0000-000000000001', 'active');

  BEGIN
    INSERT INTO public.lightning_pool_session
      (id, cluster_id, cluster_epoch, player_id, cash_player_session_id, state)
    VALUES ('b0010000-0000-0000-0000-000000000002', 'c1a50000-0000-0000-0000-000000000001', 0,
            '70000000-0000-0000-0000-000000000001', '5e550000-0000-0000-0000-000000000001', 'joining');
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FAIL one open: a player opened a SECOND open pool session in the same cluster, so there are two participation periods spending one economic identity';
  END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_pool_session_one_open' THEN
    RAISE EXCEPTION 'FAIL one open: refused by %, not the named lightning_pool_session_one_open', coalesce(v_constraint, '<unnamed>');
  END IF;

  UPDATE public.lightning_pool_session
     SET exited_at = clock_timestamp(), exit_reason = 'left_pool'
   WHERE id = 'b0010000-0000-0000-0000-000000000001';

  BEGIN
    INSERT INTO public.lightning_pool_session
      (id, cluster_id, cluster_epoch, player_id, cash_player_session_id, state)
    VALUES ('b0010000-0000-0000-0000-000000000002', 'c1a50000-0000-0000-0000-000000000001', 0,
            '70000000-0000-0000-0000-000000000001', '5e550000-0000-0000-0000-000000000001', 'joining');
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    RAISE EXCEPTION 'FAIL one open: % is not partial -- a player who has already EXITED the pool is refused re-entry for the rest of the cluster''s life', coalesce(v_constraint, '<unnamed>');
  END;
  IF NOT EXISTS (SELECT 1 FROM public.lightning_pool_session WHERE id = 'b0010000-0000-0000-0000-000000000002') THEN
    RAISE EXCEPTION 'FAIL one open: the re-entry after an exit did not land';
  END IF;
END $$;
\echo '  ok  ONE OPEN POOL      a second OPEN period collides on lightning_pool_session_one_open; re-entry after an exit is allowed'

-- POOL STATE MACHINE ---------------------------------------------------------
-- SEVEN participation-level states, and the eight per-hand states of the
-- specification's machine are REFUSED here on purpose. That refusal is asserted
-- deliberately rather than left to happen by accident, because it is a design
-- decision and not an omission: idle_pool, matching, reserved, in_instance,
-- in_hand, folded, watching and ghost_bb are per-TABLE answers, and a player at
-- three tables holds three of them at once. They are derived from the live
-- lightning_reservation and the lightning_instance it names.
DO $$
DECLARE s text; n integer := 0; v_raised boolean; v_constraint text;
BEGIN
  INSERT INTO public.lightning_pool_session
    (id, cluster_id, cluster_epoch, player_id, cash_player_session_id)
  VALUES ('b0010000-0000-0000-0000-000000000003', 'c1a50000-0000-0000-0000-000000000001', 0,
          '70000000-0000-0000-0000-000000000002', '5e550000-0000-0000-0000-000000000002');
  IF (SELECT state FROM public.lightning_pool_session WHERE id = 'b0010000-0000-0000-0000-000000000003')
     IS DISTINCT FROM 'joining' THEN
    RAISE EXCEPTION 'FAIL states: a pool session is not born joining';
  END IF;

  FOREACH s IN ARRAY ARRAY['joining','eligibility_check','active','sit_out',
                           'disconnected','leaving','closed'] LOOP
    UPDATE public.lightning_pool_session SET state = s WHERE id = 'b0010000-0000-0000-0000-000000000003';
    IF (SELECT state FROM public.lightning_pool_session WHERE id = 'b0010000-0000-0000-0000-000000000003')
       IS DISTINCT FROM s THEN
      RAISE EXCEPTION 'FAIL states: % did not stick', s;
    END IF;
    n := n + 1;
  END LOOP;
  IF n IS DISTINCT FROM 7 THEN RAISE EXCEPTION 'FAIL states: only % of the seven participation states were accepted', n; END IF;

  n := 0;
  FOREACH s IN ARRAY ARRAY['idle_pool','matching','reserved','in_instance',
                           'in_hand','folded','watching','ghost_bb'] LOOP
    v_raised := false; v_constraint := NULL;
    BEGIN
      UPDATE public.lightning_pool_session SET state = s WHERE id = 'b0010000-0000-0000-0000-000000000003';
    EXCEPTION WHEN check_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
    END;
    IF NOT v_raised THEN
      RAISE EXCEPTION 'FAIL states: the participation state column still accepts the PER-HAND state ''%'', which a multi-tabling player holds several of at once', s;
    END IF;
    IF v_constraint IS DISTINCT FROM 'lightning_pool_session_state_check' THEN
      RAISE EXCEPTION 'FAIL states: ''%'' was refused by %, not the named lightning_pool_session_state_check', s, coalesce(v_constraint, '<unnamed>');
    END IF;
    n := n + 1;
  END LOOP;
  IF n IS DISTINCT FROM 8 THEN RAISE EXCEPTION 'FAIL states: only % of the eight per-hand states were exercised', n; END IF;

  v_raised := false; v_constraint := NULL;
  BEGIN
    UPDATE public.lightning_pool_session SET state = 'seated' WHERE id = 'b0010000-0000-0000-0000-000000000003';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'FAIL states: the pool state machine accepted ''seated'', a state outside its seven'; END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_pool_session_state_check' THEN
    RAISE EXCEPTION 'FAIL states: refused by %, not the named lightning_pool_session_state_check', coalesce(v_constraint, '<unnamed>');
  END IF;

  UPDATE public.lightning_pool_session SET state = 'active' WHERE id = 'b0010000-0000-0000-0000-000000000003';
END $$;
\echo '  ok  POOL STATES        the seven participation states are accepted; all eight PER-HAND states and ''seated'' raise lightning_pool_session_state_check'

-- EXIT IS EXPLAINED ----------------------------------------------------------
DO $$
DECLARE v_raised boolean := false; v_constraint text;
BEGIN
  BEGIN
    INSERT INTO public.lightning_pool_session
      (id, cluster_id, cluster_epoch, player_id, cash_player_session_id, entered_at, exited_at, exit_reason)
    VALUES ('b0010000-0000-0000-0000-000000000004', 'c1a50000-0000-0000-0000-000000000001', 0,
            '70000000-0000-0000-0000-000000000003', '5e550000-0000-0000-0000-000000000003',
            '2026-09-20T11:00:00Z', '2026-09-20T12:00:00Z', NULL);
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'FAIL exit: a period exited with no reason, so nothing records WHY the player left the pool'; END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_pool_session_exit_is_explained' THEN
    RAISE EXCEPTION 'FAIL exit: refused by %, not the named lightning_pool_session_exit_is_explained', coalesce(v_constraint, '<unnamed>');
  END IF;

  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.lightning_pool_session
      (id, cluster_id, cluster_epoch, player_id, cash_player_session_id, entered_at, exited_at, exit_reason)
    VALUES ('b0010000-0000-0000-0000-000000000004', 'c1a50000-0000-0000-0000-000000000001', 0,
            '70000000-0000-0000-0000-000000000003', '5e550000-0000-0000-0000-000000000003',
            '2026-09-20T12:00:00Z', '2026-09-20T11:00:00Z', 'left_pool');
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'FAIL exit: a period exited an hour BEFORE it was entered'; END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_pool_session_exit_is_explained' THEN
    RAISE EXCEPTION 'FAIL exit: the backwards exit was refused by %, not lightning_pool_session_exit_is_explained', coalesce(v_constraint, '<unnamed>');
  END IF;

  INSERT INTO public.lightning_pool_session
    (id, cluster_id, cluster_epoch, player_id, cash_player_session_id, entered_at, exited_at, exit_reason)
  VALUES ('b0010000-0000-0000-0000-000000000004', 'c1a50000-0000-0000-0000-000000000001', 0,
          '70000000-0000-0000-0000-000000000003', '5e550000-0000-0000-0000-000000000003',
          '2026-09-20T11:00:00Z', NULL, NULL);
  IF NOT EXISTS (SELECT 1 FROM public.lightning_pool_session WHERE id = 'b0010000-0000-0000-0000-000000000004') THEN
    RAISE EXCEPTION 'FAIL exit: an OPEN period with no exit and no reason was refused';
  END IF;
END $$;
\echo '  ok  EXIT EXPLAINED     an unexplained exit and a backwards exit both raise lightning_pool_session_exit_is_explained; an open period is fine'

-- SLOT LIFECYCLE -------------------------------------------------------------
-- Everything the third level exists for. Both halves throughout: two open slots
-- for one player in one cluster are MULTI-TABLING and must be accepted; the
-- same slot number twice while open is a double-open and must not be; and
-- closing one table must free its number WITHOUT touching its siblings, which
-- is the "leave one table, keep playing the others" that a single pool session
-- could not express.
DO $$
DECLARE v_raised boolean; v_constraint text; sib public.lightning_pool_slot%ROWTYPE; sib2 public.lightning_pool_slot%ROWTYPE;
BEGIN
  INSERT INTO public.lightning_pool_session
    (id, cluster_id, cluster_epoch, player_id, cash_player_session_id, state)
  VALUES ('b0010000-0000-0000-0000-000000000006', 'c1a50000-0000-0000-0000-000000000001', 0,
          '70000000-0000-0000-0000-000000000005', '5e550000-0000-0000-0000-000000000005', 'active');

  -- Two tables at once. opened_at is given explicitly throughout this block:
  -- the column defaults to clock_timestamp(), and a fixed close time in the
  -- past would then be BEFORE the open and trip close_is_explained for a
  -- reason that has nothing to do with what is under test.
  INSERT INTO public.lightning_pool_slot (id, pool_session_id, cluster_id, cluster_epoch, player_id, slot, opened_at)
  VALUES ('51070000-0000-0000-0000-000000000002', 'b0010000-0000-0000-0000-000000000006',
          'c1a50000-0000-0000-0000-000000000001', 0, '70000000-0000-0000-0000-000000000005', 1,
          '2026-09-20T12:00:00Z');
  BEGIN
    INSERT INTO public.lightning_pool_slot (id, pool_session_id, cluster_id, cluster_epoch, player_id, slot, opened_at)
    VALUES ('51070000-0000-0000-0000-000000000003', 'b0010000-0000-0000-0000-000000000006',
            'c1a50000-0000-0000-0000-000000000001', 0, '70000000-0000-0000-0000-000000000005', 2,
            '2026-09-20T12:00:00Z');
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    RAISE EXCEPTION 'FAIL slot lifecycle: % refused a SECOND open table for one player, so multi-table Lightning is structurally impossible', coalesce(v_constraint, '<unnamed>');
  END;
  IF (SELECT count(*) FROM public.lightning_pool_slot
       WHERE player_id = '70000000-0000-0000-0000-000000000005' AND closed_at IS NULL)
     IS DISTINCT FROM 2::bigint THEN
    RAISE EXCEPTION 'FAIL slot lifecycle: the player does not hold two simultaneous open tables';
  END IF;

  -- The same slot NUMBER twice while open is a double-open.
  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.lightning_pool_slot (id, pool_session_id, cluster_id, cluster_epoch, player_id, slot)
    VALUES ('51070000-0000-0000-0000-0000000000f1', 'b0010000-0000-0000-0000-000000000006',
            'c1a50000-0000-0000-0000-000000000001', 0, '70000000-0000-0000-0000-000000000005', 1);
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FAIL slot lifecycle: slot 1 was opened TWICE for one player in one cluster, so two tables answer to the same slot number and every per-table read is ambiguous';
  END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_pool_slot_one_open' THEN
    RAISE EXCEPTION 'FAIL slot lifecycle: refused by %, not the named lightning_pool_slot_one_open', coalesce(v_constraint, '<unnamed>');
  END IF;

  -- LEAVE ONE TABLE, KEEP PLAYING THE OTHERS. Capture the sibling first.
  SELECT * INTO sib FROM public.lightning_pool_slot WHERE id = '51070000-0000-0000-0000-000000000003';
  IF sib.id IS NULL THEN RAISE EXCEPTION 'FAIL slot lifecycle: the sibling slot capture is empty'; END IF;
  UPDATE public.lightning_pool_slot
     SET closed_at = '2026-09-20T12:30:00Z', close_reason = 'left_table'
   WHERE id = '51070000-0000-0000-0000-000000000002';

  SELECT * INTO sib2 FROM public.lightning_pool_slot WHERE id = '51070000-0000-0000-0000-000000000003';
  IF sib2.id IS NULL THEN RAISE EXCEPTION 'FAIL slot lifecycle: closing slot 1 destroyed slot 2'; END IF;
  IF sib2.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL slot lifecycle: closing slot 1 also closed slot 2 (closed_at %)', sib2.closed_at;
  END IF;
  IF ROW(sib2.pool_session_id, sib2.cluster_id, sib2.player_id, sib2.slot, sib2.opened_at,
         sib2.closed_at, sib2.close_reason, sib2.hands, sib2.hands_since_bb, sib2.last_bb_at)
     IS DISTINCT FROM
     ROW(sib.pool_session_id, sib.cluster_id, sib.player_id, sib.slot, sib.opened_at,
         sib.closed_at, sib.close_reason, sib.hands, sib.hands_since_bb, sib.last_bb_at) THEN
    RAISE EXCEPTION 'FAIL slot lifecycle: closing one table changed a sibling table''s row';
  END IF;

  -- ...and the closed number is free again, which is what re-seating is.
  BEGIN
    INSERT INTO public.lightning_pool_slot (id, pool_session_id, cluster_id, cluster_epoch, player_id, slot, opened_at)
    VALUES ('51070000-0000-0000-0000-000000000004', 'b0010000-0000-0000-0000-000000000006',
            'c1a50000-0000-0000-0000-000000000001', 0, '70000000-0000-0000-0000-000000000005', 1,
            '2026-09-20T12:31:00Z');
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    RAISE EXCEPTION 'FAIL slot lifecycle: % is not partial on closed_at -- a slot number that has been left can never be used again', coalesce(v_constraint, '<unnamed>');
  END;

  -- A closed table says WHY, and cannot close before it opened.
  v_raised := false; v_constraint := NULL;
  BEGIN
    UPDATE public.lightning_pool_slot SET closed_at = '2026-09-20T12:30:00Z', close_reason = NULL
     WHERE id = '51070000-0000-0000-0000-000000000003';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'FAIL slot lifecycle: a table closed with no reason'; END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_pool_slot_close_is_explained' THEN
    RAISE EXCEPTION 'FAIL slot lifecycle: refused by %, not the named lightning_pool_slot_close_is_explained', coalesce(v_constraint, '<unnamed>');
  END IF;

  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.lightning_pool_slot (id, pool_session_id, cluster_id, cluster_epoch, player_id, slot, opened_at, closed_at, close_reason)
    VALUES ('51070000-0000-0000-0000-0000000000f2', 'b0010000-0000-0000-0000-000000000006',
            'c1a50000-0000-0000-0000-000000000001', 0, '70000000-0000-0000-0000-000000000005', 5,
            '2026-09-20T12:00:00Z', '2026-09-20T11:00:00Z', 'left_table');
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'FAIL slot lifecycle: a table closed an hour BEFORE it opened'; END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_pool_slot_close_is_explained' THEN
    RAISE EXCEPTION 'FAIL slot lifecycle: the backwards close was refused by %, not lightning_pool_slot_close_is_explained', coalesce(v_constraint, '<unnamed>');
  END IF;

  -- The sanity range, both ends and both sides of both ends.
  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.lightning_pool_slot (id, pool_session_id, cluster_id, cluster_epoch, player_id, slot)
    VALUES ('51070000-0000-0000-0000-0000000000f3', 'b0010000-0000-0000-0000-000000000006',
            'c1a50000-0000-0000-0000-000000000001', 0, '70000000-0000-0000-0000-000000000005', 0);
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'FAIL slot lifecycle: slot 0 was accepted, so one table can be addressed as both slot 0 and slot 1'; END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_pool_slot_range' THEN
    RAISE EXCEPTION 'FAIL slot lifecycle: slot 0 was refused by %, not the named lightning_pool_slot_range', coalesce(v_constraint, '<unnamed>');
  END IF;

  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.lightning_pool_slot (id, pool_session_id, cluster_id, cluster_epoch, player_id, slot)
    VALUES ('51070000-0000-0000-0000-0000000000f4', 'b0010000-0000-0000-0000-000000000006',
            'c1a50000-0000-0000-0000-000000000001', 0, '70000000-0000-0000-0000-000000000005', 25);
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'FAIL slot lifecycle: slot 25 was accepted, so a misconfigured simultaneous-table limit has no floor to fall through'; END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_pool_slot_range' THEN
    RAISE EXCEPTION 'FAIL slot lifecycle: slot 25 was refused by %, not lightning_pool_slot_range', coalesce(v_constraint, '<unnamed>');
  END IF;

  -- Both legal extremes ARE accepted, or the range is simply "no". Slot 1 is
  -- already open above; slot 24 is the ceiling itself.
  INSERT INTO public.lightning_pool_slot (id, pool_session_id, cluster_id, cluster_epoch, player_id, slot, opened_at)
  VALUES ('51070000-0000-0000-0000-000000000005', 'b0010000-0000-0000-0000-000000000006',
          'c1a50000-0000-0000-0000-000000000001', 0, '70000000-0000-0000-0000-000000000005', 24,
          '2026-09-20T12:31:00Z');
  IF NOT EXISTS (SELECT 1 FROM public.lightning_pool_slot
                  WHERE id = '51070000-0000-0000-0000-000000000005' AND slot = 24) THEN
    RAISE EXCEPTION 'FAIL slot lifecycle: slot 24, the ceiling itself, was refused';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.lightning_pool_slot
                  WHERE id = '51070000-0000-0000-0000-000000000004' AND slot = 1 AND closed_at IS NULL) THEN
    RAISE EXCEPTION 'FAIL slot lifecycle: slot 1, the floor itself, is not open';
  END IF;
END $$;
\echo '  ok  SLOT LIFECYCLE     two open tables ACCEPTED, a repeated open slot collides on lightning_pool_slot_one_open, closing one frees its number and leaves its sibling untouched, slot 0 and 25 raise lightning_pool_slot_range while 1 and 24 are accepted'

-- ORBIT IS PER TABLE ---------------------------------------------------------
-- The defect this restructuring removed, proved as behaviour and not only as a
-- column list: two of one player's tables must be able to hold DIFFERENT orbit
-- positions at the same instant.
DO $$
DECLARE v_a integer; v_b integer; v_ta timestamptz; v_tb timestamptz; v_def text;
BEGIN
  UPDATE public.lightning_pool_slot
     SET hands_since_bb = 7, hands_since_sb = 3, last_bb_at = '2026-09-20T12:10:00Z'
   WHERE id = '51070000-0000-0000-0000-000000000004';
  UPDATE public.lightning_pool_slot
     SET hands_since_bb = 0, hands_since_sb = 0, last_bb_at = NULL
   WHERE id = '51070000-0000-0000-0000-000000000005';

  SELECT hands_since_bb, last_bb_at INTO v_a, v_ta FROM public.lightning_pool_slot WHERE id = '51070000-0000-0000-0000-000000000004';
  SELECT hands_since_bb, last_bb_at INTO v_b, v_tb FROM public.lightning_pool_slot WHERE id = '51070000-0000-0000-0000-000000000005';
  IF v_a IS DISTINCT FROM 7 OR v_b IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL orbit: one player''s two tables do not carry independent orbit counters (% and %)', v_a, v_b;
  END IF;
  IF v_ta IS DISTINCT FROM '2026-09-20T12:10:00Z'::timestamptz OR v_tb IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL orbit: one player''s two tables do not carry independent last_bb_at (% and %)', v_ta, v_tb;
  END IF;
  -- Both belong to the same human and the same participation period.
  IF (SELECT count(DISTINCT pool_session_id) FROM public.lightning_pool_slot
       WHERE id IN ('51070000-0000-0000-0000-000000000004','51070000-0000-0000-0000-000000000005'))
     IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL orbit: the two tables are not under one participation period, so this proves nothing about a multi-tabler';
  END IF;

  -- The BB candidate ordering is asked of a TABLE and reads only live ones.
  SELECT indexdef INTO v_def FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'lightning_pool_slot_oldest_bb';
  IF v_def IS NULL
     OR position('(cluster_id, last_bb_at NULLS FIRST, player_id)' in v_def) = 0
     OR position('closed_at IS NULL' in v_def) = 0 THEN
    RAISE EXCEPTION 'FAIL orbit: lightning_pool_slot_oldest_bb is not the declared partial index on (cluster_id, last_bb_at NULLS FIRST, player_id) WHERE closed_at IS NULL (%)', coalesce(v_def, '<no definition>');
  END IF;
  -- Non-vacuity: the table that has never posted a BB really does sort first
  -- under that ordering. Restricted to the two slots under test, because the
  -- player holds other open tables whose last_bb_at is also NULL and ties
  -- among NULLs would make the answer arbitrary.
  IF (SELECT id FROM public.lightning_pool_slot
       WHERE cluster_id = 'c1a50000-0000-0000-0000-000000000001' AND closed_at IS NULL
         AND id IN ('51070000-0000-0000-0000-000000000004','51070000-0000-0000-0000-000000000005')
       ORDER BY last_bb_at NULLS FIRST, player_id LIMIT 1)
     IS DISTINCT FROM '51070000-0000-0000-0000-000000000005'::uuid THEN
    RAISE EXCEPTION 'FAIL orbit: the table that has never posted a big blind is not the oldest BB candidate';
  END IF;
END $$;
\echo '  ok  ORBIT PER TABLE    two tables of one player hold independent hands_since_bb and last_bb_at; lightning_pool_slot_oldest_bb orders live slots, NULLS FIRST'

-- SLOT COUNTERS --------------------------------------------------------------
DO $$
DECLARE v_raised boolean; v_constraint text; c text;
BEGIN
  INSERT INTO public.lightning_pool_session
    (id, cluster_id, cluster_epoch, player_id, cash_player_session_id, state)
  VALUES ('b0010000-0000-0000-0000-000000000005', 'c1a50000-0000-0000-0000-000000000001', 0,
          '70000000-0000-0000-0000-000000000004', '5e550000-0000-0000-0000-000000000004', 'active');
  INSERT INTO public.lightning_pool_slot (id, pool_session_id, cluster_id, cluster_epoch, player_id, slot)
  VALUES ('51070000-0000-0000-0000-000000000001', 'b0010000-0000-0000-0000-000000000005',
          'c1a50000-0000-0000-0000-000000000001', 0, '70000000-0000-0000-0000-000000000004', 1);

  -- hands, the wait accumulator the derived mean is computed from, and the
  -- orbit counter, all under one named CHECK.
  FOREACH c IN ARRAY ARRAY['hands','wait_total_ms','hands_since_bb'] LOOP
    v_raised := false; v_constraint := NULL;
    BEGIN
      EXECUTE format('UPDATE public.lightning_pool_slot SET %I = -1 WHERE id = %L',
                     c, '51070000-0000-0000-0000-000000000001');
    EXCEPTION WHEN check_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
    END;
    IF NOT v_raised THEN RAISE EXCEPTION 'FAIL slot counters: lightning_pool_slot.% accepted -1', c; END IF;
    IF v_constraint IS DISTINCT FROM 'lightning_pool_slot_counters_nonneg' THEN
      RAISE EXCEPTION 'FAIL slot counters: % = -1 was refused by %, not the named lightning_pool_slot_counters_nonneg', c, coalesce(v_constraint, '<unnamed>');
    END IF;
  END LOOP;
END $$;
\echo '  ok  SLOT COUNTERS      hands, wait_total_ms and hands_since_bb all raise lightning_pool_slot_counters_nonneg at -1'

-- NO ONE-PLAYER INSTANCE -----------------------------------------------------
DO $$
DECLARE v_raised boolean; v_constraint text;
BEGIN
  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.lightning_instance (id, cluster_id, cluster_epoch, target_size, max_size)
    VALUES ('1a570000-0000-0000-0000-0000000000f1', 'c1a50000-0000-0000-0000-000000000001', 0, 1, 9);
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'FAIL sizes: a ONE-PLAYER Lightning instance was created'; END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_instance_sizes' THEN
    RAISE EXCEPTION 'FAIL sizes: target_size = 1 was refused by %, not the named lightning_instance_sizes', coalesce(v_constraint, '<unnamed>');
  END IF;

  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.lightning_instance (id, cluster_id, cluster_epoch, target_size, max_size)
    VALUES ('1a570000-0000-0000-0000-0000000000f2', 'c1a50000-0000-0000-0000-000000000001', 0, 6, 5);
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'FAIL sizes: an instance was formed for 6 players in a container that holds 5'; END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_instance_sizes' THEN
    RAISE EXCEPTION 'FAIL sizes: max_size < target_size was refused by %, not lightning_instance_sizes', coalesce(v_constraint, '<unnamed>');
  END IF;

  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.lightning_instance (id, cluster_id, cluster_epoch, target_size, max_size)
    VALUES ('1a570000-0000-0000-0000-0000000000f3', 'c1a50000-0000-0000-0000-000000000001', 0, 2, 10);
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'FAIL sizes: a ten-handed instance was created, above the estate''s nine-seat ceiling'; END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_instance_sizes' THEN
    RAISE EXCEPTION 'FAIL sizes: max_size = 10 was refused by %, not lightning_instance_sizes', coalesce(v_constraint, '<unnamed>');
  END IF;

  INSERT INTO public.lightning_instance (id, cluster_id, cluster_epoch, target_size, max_size)
  VALUES ('1a570000-0000-0000-0000-000000000001', 'c1a50000-0000-0000-0000-000000000001', 0, 2, 9);
  IF NOT EXISTS (SELECT 1 FROM public.lightning_instance WHERE id = '1a570000-0000-0000-0000-000000000001') THEN
    RAISE EXCEPTION 'FAIL sizes: a legal heads-up-to-nine instance (target 2 / max 9) was refused';
  END IF;
  IF (SELECT state FROM public.lightning_instance WHERE id = '1a570000-0000-0000-0000-000000000001')
     IS DISTINCT FROM 'forming' THEN
    RAISE EXCEPTION 'FAIL sizes: an instance is not born forming';
  END IF;
END $$;
\echo '  ok  INSTANCE SIZES     target 1, max < target and max 10 all raise lightning_instance_sizes; target 2 / max 9 is accepted'

-- ONE INSTANCE PER HAND ------------------------------------------------------
DO $$
DECLARE v_raised boolean := false; v_constraint text;
BEGIN
  INSERT INTO public.lightning_instance (id, cluster_id, cluster_epoch, state, hand_id, target_size, max_size)
  VALUES ('1a570000-0000-0000-0000-000000000002', 'c1a50000-0000-0000-0000-000000000001', 0, 'dealing',
          'fa4d0000-0000-0000-0000-00000000000a', 6, 9);

  BEGIN
    INSERT INTO public.lightning_instance (id, cluster_id, cluster_epoch, state, hand_id, target_size, max_size)
    VALUES ('1a570000-0000-0000-0000-000000000003', 'c1a50000-0000-0000-0000-000000000001', 0, 'dealing',
            'fa4d0000-0000-0000-0000-00000000000a', 6, 9);
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'FAIL one per hand: one hand is running inside TWO containers at once'; END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_instance_one_per_hand' THEN
    RAISE EXCEPTION 'FAIL one per hand: refused by %, not the named lightning_instance_one_per_hand', coalesce(v_constraint, '<unnamed>');
  END IF;

  -- PARTIAL: an instance that is not yet dealing has no hand. NOTE: a plain
  -- unique btree also admits many NULLs, so this pair does NOT by itself prove
  -- partiality -- the indexdef assertion in CATALOG is what does.
  BEGIN
    INSERT INTO public.lightning_instance (id, cluster_id, cluster_epoch, hand_id, target_size, max_size)
    VALUES ('1a570000-0000-0000-0000-000000000004', 'c1a50000-0000-0000-0000-000000000001', 0, NULL, 4, 6);
    INSERT INTO public.lightning_instance (id, cluster_id, cluster_epoch, hand_id, target_size, max_size)
    VALUES ('1a570000-0000-0000-0000-000000000005', 'c1a50000-0000-0000-0000-000000000001', 0, NULL, 4, 6);
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    RAISE EXCEPTION 'FAIL one per hand: % is not partial -- only ONE instance in the whole estate may be forming at a time', coalesce(v_constraint, '<unnamed>');
  END;
  IF (SELECT count(*) FROM public.lightning_instance WHERE hand_id IS NULL) < 3::bigint THEN
    RAISE EXCEPTION 'FAIL one per hand: the two hand-less instances did not both land';
  END IF;
END $$;
\echo '  ok  ONE PER HAND       two instances on one hand_id collide on lightning_instance_one_per_hand; hand_id NULL is unconstrained'

-- ONE PENDING RESERVATION PER SLOT -------------------------------------------
-- The hold belongs to a TABLE, not to a player, and the key is the slot row and
-- nothing else. Both halves: one pending hold per slot, and a player holding
-- several slots at once is multi-tabling and must be accepted.
DO $$
DECLARE v_raised boolean := false; v_constraint text; v_pending bigint;
BEGIN
  INSERT INTO public.lightning_pool_session
    (id, cluster_id, cluster_epoch, player_id, cash_player_session_id, state)
  VALUES ('b0010000-0000-0000-0000-000000000007', 'c1a50000-0000-0000-0000-000000000001', 0,
          '70000000-0000-0000-0000-000000000006', '5e550000-0000-0000-0000-000000000006', 'active');
  INSERT INTO public.lightning_pool_slot (id, pool_session_id, cluster_id, cluster_epoch, player_id, slot) VALUES
    ('51070000-0000-0000-0000-000000000006', 'b0010000-0000-0000-0000-000000000007',
     'c1a50000-0000-0000-0000-000000000001', 0, '70000000-0000-0000-0000-000000000006', 1),
    ('51070000-0000-0000-0000-000000000007', 'b0010000-0000-0000-0000-000000000007',
     'c1a50000-0000-0000-0000-000000000001', 0, '70000000-0000-0000-0000-000000000006', 2);

  INSERT INTO public.lightning_reservation
    (id, cluster_id, cluster_epoch, player_id, pool_slot_id, created_at, expires_at)
  VALUES ('4e550000-0000-0000-0000-000000000001', 'c1a50000-0000-0000-0000-000000000001', 0,
          '70000000-0000-0000-0000-000000000006', '51070000-0000-0000-0000-000000000006',
          '2026-09-20T12:00:00Z', '2026-09-20T12:00:10Z');

  BEGIN
    INSERT INTO public.lightning_reservation
      (id, cluster_id, cluster_epoch, player_id, pool_slot_id, created_at, expires_at)
    VALUES ('4e550000-0000-0000-0000-000000000002', 'c1a50000-0000-0000-0000-000000000001', 0,
            '70000000-0000-0000-0000-000000000006', '51070000-0000-0000-0000-000000000006',
            '2026-09-20T12:00:01Z', '2026-09-20T12:00:11Z');
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FAIL one pending: one table holds TWO pending reservations, so the matcher can seat one slot into two instances for the same hand';
  END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_reservation_one_pending_per_slot' THEN
    RAISE EXCEPTION 'FAIL one pending: refused by %, not the named lightning_reservation_one_pending_per_slot', coalesce(v_constraint, '<unnamed>');
  END IF;

  -- ACCEPTED: the player's OTHER table may hold at the same time.
  BEGIN
    INSERT INTO public.lightning_reservation
      (id, cluster_id, cluster_epoch, player_id, pool_slot_id, created_at, expires_at)
    VALUES ('4e550000-0000-0000-0000-000000000003', 'c1a50000-0000-0000-0000-000000000001', 0,
            '70000000-0000-0000-0000-000000000006', '51070000-0000-0000-0000-000000000007',
            '2026-09-20T12:00:02Z', '2026-09-20T12:00:12Z');
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    RAISE EXCEPTION 'FAIL one pending: % refused a hold on a SECOND table of the same player, so multi-table Lightning is structurally impossible', coalesce(v_constraint, '<unnamed>');
  END;
  SELECT count(*) INTO v_pending FROM public.lightning_reservation r
    JOIN public.lightning_pool_slot s ON s.id = r.pool_slot_id
   WHERE s.player_id = '70000000-0000-0000-0000-000000000006' AND r.state = 'pending';
  IF v_pending IS DISTINCT FROM 2::bigint THEN
    RAISE EXCEPTION 'FAIL one pending: the player holds % simultaneous pending holds, expected 2', v_pending;
  END IF;

  -- PARTIAL on state: a released hold frees its table for the next offer.
  UPDATE public.lightning_reservation
     SET state = 'released', resolved_at = '2026-09-20T12:00:05Z', reason = 'declined'
   WHERE id = '4e550000-0000-0000-0000-000000000001';
  BEGIN
    INSERT INTO public.lightning_reservation
      (id, cluster_id, cluster_epoch, player_id, pool_slot_id, created_at, expires_at)
    VALUES ('4e550000-0000-0000-0000-000000000002', 'c1a50000-0000-0000-0000-000000000001', 0,
            '70000000-0000-0000-0000-000000000006', '51070000-0000-0000-0000-000000000006',
            '2026-09-20T12:00:06Z', '2026-09-20T12:00:16Z');
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    RAISE EXCEPTION 'FAIL one pending: % is not partial on state -- a table whose hold was RELEASED can never be offered a seat again', coalesce(v_constraint, '<unnamed>');
  END;
  IF NOT EXISTS (SELECT 1 FROM public.lightning_reservation WHERE id = '4e550000-0000-0000-0000-000000000002') THEN
    RAISE EXCEPTION 'FAIL one pending: the replacement hold did not land';
  END IF;
END $$;
\echo '  ok  ONE PENDING SLOT   a second hold on one table collides on lightning_reservation_one_pending_per_slot; a hold on the player''s OTHER table is ACCEPTED; a released table re-holds'

-- RESERVATION RESOLUTION -----------------------------------------------------
-- Each failing row is constructed so that exactly ONE of the four constraints
-- can fire.
DO $$
DECLARE v_raised boolean; v_constraint text;
BEGIN
  INSERT INTO public.lightning_pool_session
    (id, cluster_id, cluster_epoch, player_id, cash_player_session_id, state)
  VALUES ('b0010000-0000-0000-0000-000000000008', 'c1a50000-0000-0000-0000-000000000001', 0,
          '70000000-0000-0000-0000-000000000007', '5e550000-0000-0000-0000-000000000007', 'active');
  INSERT INTO public.lightning_pool_slot (id, pool_session_id, cluster_id, cluster_epoch, player_id, slot)
  VALUES ('51070000-0000-0000-0000-000000000008', 'b0010000-0000-0000-0000-000000000008',
          'c1a50000-0000-0000-0000-000000000001', 0, '70000000-0000-0000-0000-000000000007', 1);

  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.lightning_reservation
      (id, cluster_id, cluster_epoch, player_id, pool_slot_id, state, created_at, expires_at, resolved_at)
    VALUES ('4e550000-0000-0000-0000-0000000000f1', 'c1a50000-0000-0000-0000-000000000001', 0,
            '70000000-0000-0000-0000-000000000007', '51070000-0000-0000-0000-000000000008', 'pending',
            '2026-09-20T12:00:00Z', '2026-09-20T12:00:10Z', '2026-09-20T12:00:05Z');
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'FAIL resolution: a PENDING hold carries a resolution time'; END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_reservation_resolution' THEN
    RAISE EXCEPTION 'FAIL resolution: pending-with-resolved_at was refused by %, not the named lightning_reservation_resolution', coalesce(v_constraint, '<unnamed>');
  END IF;

  -- committed, never resolved. lightning_instance_id is deliberately SET, so
  -- lightning_reservation_committed_names_its_instance cannot be what fires.
  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.lightning_reservation
      (id, cluster_id, cluster_epoch, player_id, pool_slot_id, lightning_instance_id, seat_number,
       state, created_at, expires_at, resolved_at)
    VALUES ('4e550000-0000-0000-0000-0000000000f2', 'c1a50000-0000-0000-0000-000000000001', 0,
            '70000000-0000-0000-0000-000000000007', '51070000-0000-0000-0000-000000000008',
            '1a570000-0000-0000-0000-000000000001', 1, 'committed',
            '2026-09-20T12:00:00Z', '2026-09-20T12:00:10Z', NULL);
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'FAIL resolution: a COMMITTED hold never recorded when it resolved'; END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_reservation_resolution' THEN
    RAISE EXCEPTION 'FAIL resolution: committed-with-NULL-resolved_at was refused by %, not lightning_reservation_resolution', coalesce(v_constraint, '<unnamed>');
  END IF;

  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.lightning_reservation
      (id, cluster_id, cluster_epoch, player_id, pool_slot_id, lightning_instance_id,
       state, created_at, expires_at, resolved_at)
    VALUES ('4e550000-0000-0000-0000-0000000000f3', 'c1a50000-0000-0000-0000-000000000001', 0,
            '70000000-0000-0000-0000-000000000007', '51070000-0000-0000-0000-000000000008', NULL, 'committed',
            '2026-09-20T12:00:00Z', '2026-09-20T12:00:10Z', '2026-09-20T12:00:05Z');
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'FAIL resolution: a COMMITTED hold does not name the instance it committed to'; END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_reservation_committed_names_its_instance' THEN
    RAISE EXCEPTION 'FAIL resolution: committed-with-no-instance was refused by %, not the named lightning_reservation_committed_names_its_instance', coalesce(v_constraint, '<unnamed>');
  END IF;

  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.lightning_reservation
      (id, cluster_id, cluster_epoch, player_id, pool_slot_id, created_at, expires_at)
    VALUES ('4e550000-0000-0000-0000-0000000000f4', 'c1a50000-0000-0000-0000-000000000001', 0,
            '70000000-0000-0000-0000-000000000007', '51070000-0000-0000-0000-000000000008',
            '2026-09-20T12:00:00Z', '2026-09-20T12:00:00Z');
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'FAIL resolution: a hold that expires at the instant it is created was accepted, so the expiry sweep has a zero-length window to act in'; END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_reservation_expires_after_creation' THEN
    RAISE EXCEPTION 'FAIL resolution: expires_at = created_at was refused by %, not the named lightning_reservation_expires_after_creation', coalesce(v_constraint, '<unnamed>');
  END IF;

  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.lightning_reservation
      (id, cluster_id, cluster_epoch, player_id, pool_slot_id, created_at, expires_at)
    VALUES ('4e550000-0000-0000-0000-0000000000f5', 'c1a50000-0000-0000-0000-000000000001', 0,
            '70000000-0000-0000-0000-000000000007', '51070000-0000-0000-0000-000000000008',
            '2026-09-20T12:00:00Z', '2026-09-20T11:59:50Z');
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'FAIL resolution: a hold was born already expired'; END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_reservation_expires_after_creation' THEN
    RAISE EXCEPTION 'FAIL resolution: expires_at < created_at was refused by %, not lightning_reservation_expires_after_creation', coalesce(v_constraint, '<unnamed>');
  END IF;

  IF EXISTS (SELECT 1 FROM public.lightning_reservation WHERE pool_slot_id = '51070000-0000-0000-0000-000000000008') THEN
    RAISE EXCEPTION 'FAIL resolution: one of the malformed reservations was stored';
  END IF;
END $$;
\echo '  ok  RESOLUTION         pending+resolved, committed+unresolved, committed+nameless and expires<=created each raise their named CHECK'

-- ONE SEAT PER INSTANCE ------------------------------------------------------
-- Two DIFFERENT players, so that lightning_reservation_one_pending_per_slot
-- cannot be what refuses the second row.
DO $$
DECLARE v_raised boolean := false; v_constraint text;
BEGIN
  INSERT INTO public.lightning_instance (id, cluster_id, cluster_epoch, state, target_size, max_size)
  VALUES ('1a570000-0000-0000-0000-000000000006', 'c1a50000-0000-0000-0000-000000000001', 0, 'reserved', 6, 9);
  INSERT INTO public.lightning_pool_session
    (id, cluster_id, cluster_epoch, player_id, cash_player_session_id, state)
  VALUES ('b0010000-0000-0000-0000-000000000009', 'c1a50000-0000-0000-0000-000000000001', 0,
          '70000000-0000-0000-0000-000000000008', '5e550000-0000-0000-0000-000000000008', 'active'),
         ('b0010000-0000-0000-0000-00000000000a', 'c1a50000-0000-0000-0000-000000000001', 0,
          '70000000-0000-0000-0000-000000000009', '5e550000-0000-0000-0000-000000000009', 'active');
  INSERT INTO public.lightning_pool_slot (id, pool_session_id, cluster_id, cluster_epoch, player_id, slot) VALUES
    ('51070000-0000-0000-0000-000000000009', 'b0010000-0000-0000-0000-000000000009',
     'c1a50000-0000-0000-0000-000000000001', 0, '70000000-0000-0000-0000-000000000008', 1),
    ('51070000-0000-0000-0000-00000000000a', 'b0010000-0000-0000-0000-00000000000a',
     'c1a50000-0000-0000-0000-000000000001', 0, '70000000-0000-0000-0000-000000000009', 1);

  INSERT INTO public.lightning_reservation
    (id, cluster_id, cluster_epoch, player_id, pool_slot_id, lightning_instance_id, seat_number, created_at, expires_at)
  VALUES ('4e550000-0000-0000-0000-000000000004', 'c1a50000-0000-0000-0000-000000000001', 0,
          '70000000-0000-0000-0000-000000000008', '51070000-0000-0000-0000-000000000009',
          '1a570000-0000-0000-0000-000000000006', 4, '2026-09-20T12:00:00Z', '2026-09-20T12:00:10Z');

  BEGIN
    INSERT INTO public.lightning_reservation
      (id, cluster_id, cluster_epoch, player_id, pool_slot_id, lightning_instance_id, seat_number, created_at, expires_at)
    VALUES ('4e550000-0000-0000-0000-000000000005', 'c1a50000-0000-0000-0000-000000000001', 0,
            '70000000-0000-0000-0000-000000000009', '51070000-0000-0000-0000-00000000000a',
            '1a570000-0000-0000-0000-000000000006', 4, '2026-09-20T12:00:01Z', '2026-09-20T12:00:11Z');
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FAIL one seat: two players hold seat 4 of the same instance, so the hand forms with two people in one chair';
  END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_reservation_one_seat_per_instance' THEN
    RAISE EXCEPTION 'FAIL one seat: refused by %, not the named lightning_reservation_one_seat_per_instance', coalesce(v_constraint, '<unnamed>');
  END IF;

  UPDATE public.lightning_reservation
     SET state = 'released', resolved_at = '2026-09-20T12:00:05Z', reason = 'expired_hold'
   WHERE id = '4e550000-0000-0000-0000-000000000004';
  BEGIN
    INSERT INTO public.lightning_reservation
      (id, cluster_id, cluster_epoch, player_id, pool_slot_id, lightning_instance_id, seat_number, created_at, expires_at)
    VALUES ('4e550000-0000-0000-0000-000000000005', 'c1a50000-0000-0000-0000-000000000001', 0,
            '70000000-0000-0000-0000-000000000009', '51070000-0000-0000-0000-00000000000a',
            '1a570000-0000-0000-0000-000000000006', 4, '2026-09-20T12:00:06Z', '2026-09-20T12:00:16Z');
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    RAISE EXCEPTION 'FAIL one seat: % is not partial on state -- a seat whose hold was RELEASED can never be filled again', coalesce(v_constraint, '<unnamed>');
  END;
  IF NOT EXISTS (SELECT 1 FROM public.lightning_reservation WHERE id = '4e550000-0000-0000-0000-000000000005') THEN
    RAISE EXCEPTION 'FAIL one seat: the replacement seat hold did not land';
  END IF;
END $$;
\echo '  ok  ONE SEAT           two holds on one (instance, seat) collide on lightning_reservation_one_seat_per_instance; a released seat reopens'

-- ONE SEAT PER PLAYER PER INSTANCE -------------------------------------------
-- The sibling rule the slot dimension made necessary. one_seat_per_instance
-- stops two PLAYERS sharing a chair; this stops one player holding two chairs
-- at the same instance through two of their tables -- a pair of reservations
-- that is committable here and IMPOSSIBLE at lightning_hand_player, which is
-- keyed (hand_id, player_id).
DO $$
DECLARE v_raised boolean := false; v_constraint text; v_live bigint;
BEGIN
  INSERT INTO public.lightning_instance (id, cluster_id, cluster_epoch, state, target_size, max_size)
  VALUES ('1a570000-0000-0000-0000-000000000007', 'c1a50000-0000-0000-0000-000000000001', 0, 'forming', 6, 9),
         ('1a570000-0000-0000-0000-000000000008', 'c1a50000-0000-0000-0000-000000000001', 0, 'forming', 6, 9);
  INSERT INTO public.lightning_pool_session
    (id, cluster_id, cluster_epoch, player_id, cash_player_session_id, state)
  VALUES ('b0010000-0000-0000-0000-00000000000b', 'c1a50000-0000-0000-0000-000000000001', 0,
          '70000000-0000-0000-0000-00000000000a', '5e550000-0000-0000-0000-00000000000a', 'active');
  INSERT INTO public.lightning_pool_slot (id, pool_session_id, cluster_id, cluster_epoch, player_id, slot) VALUES
    ('51070000-0000-0000-0000-00000000000b', 'b0010000-0000-0000-0000-00000000000b',
     'c1a50000-0000-0000-0000-000000000001', 0, '70000000-0000-0000-0000-00000000000a', 1),
    ('51070000-0000-0000-0000-00000000000c', 'b0010000-0000-0000-0000-00000000000b',
     'c1a50000-0000-0000-0000-000000000001', 0, '70000000-0000-0000-0000-00000000000a', 2);

  INSERT INTO public.lightning_reservation
    (id, cluster_id, cluster_epoch, player_id, pool_slot_id, lightning_instance_id, seat_number, created_at, expires_at)
  VALUES ('4e550000-0000-0000-0000-000000000006', 'c1a50000-0000-0000-0000-000000000001', 0,
          '70000000-0000-0000-0000-00000000000a', '51070000-0000-0000-0000-00000000000b',
          '1a570000-0000-0000-0000-000000000007', 3, '2026-09-20T12:00:00Z', '2026-09-20T12:00:10Z');

  -- REFUSED: the player's OTHER table takes a DIFFERENT seat at the SAME
  -- instance. The seat differs and the slot differs, so neither
  -- one_seat_per_instance nor one_pending_per_slot can be what refuses it.
  BEGIN
    INSERT INTO public.lightning_reservation
      (id, cluster_id, cluster_epoch, player_id, pool_slot_id, lightning_instance_id, seat_number, created_at, expires_at)
    VALUES ('4e550000-0000-0000-0000-000000000007', 'c1a50000-0000-0000-0000-000000000001', 0,
            '70000000-0000-0000-0000-00000000000a', '51070000-0000-0000-0000-00000000000c',
            '1a570000-0000-0000-0000-000000000007', 5, '2026-09-20T12:00:01Z', '2026-09-20T12:00:11Z');
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FAIL one seat per player: one player holds seats 3 AND 5 of the same instance through two of their tables -- a pair of reservations the hand layer can never commit, because lightning_hand_player is keyed (hand_id, player_id)';
  END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_reservation_one_seat_per_player_instance' THEN
    RAISE EXCEPTION 'FAIL one seat per player: refused by %, not the named lightning_reservation_one_seat_per_player_instance', coalesce(v_constraint, '<unnamed>');
  END IF;

  -- ACCEPTED: the same second table at a DIFFERENT instance. This is the whole
  -- point of multi-tabling; an index keyed on (player_id) alone would refuse it
  -- and look correct from the refuse-half alone.
  BEGIN
    INSERT INTO public.lightning_reservation
      (id, cluster_id, cluster_epoch, player_id, pool_slot_id, lightning_instance_id, seat_number, created_at, expires_at)
    VALUES ('4e550000-0000-0000-0000-000000000008', 'c1a50000-0000-0000-0000-000000000001', 0,
            '70000000-0000-0000-0000-00000000000a', '51070000-0000-0000-0000-00000000000c',
            '1a570000-0000-0000-0000-000000000008', 5, '2026-09-20T12:00:02Z', '2026-09-20T12:00:12Z');
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    RAISE EXCEPTION 'FAIL one seat per player: % refused a seat at a SECOND instance, so one player can never be at two Lightning tables at once and multi-tabling is dead', coalesce(v_constraint, '<unnamed>');
  END;
  SELECT count(DISTINCT lightning_instance_id) INTO v_live FROM public.lightning_reservation
   WHERE player_id = '70000000-0000-0000-0000-00000000000a'
     AND state IN ('pending', 'committed') AND lightning_instance_id IS NOT NULL;
  IF v_live IS DISTINCT FROM 2::bigint THEN
    RAISE EXCEPTION 'FAIL one seat per player: the player holds live seats at % distinct instances, expected 2, so the accept-half proves nothing', v_live;
  END IF;
END $$;
\echo '  ok  SEAT PER PLAYER    two seats at ONE instance collide on lightning_reservation_one_seat_per_player_instance; seats at two DIFFERENT instances are ACCEPTED'

-- DELETE RULES, TWO LEVELS ---------------------------------------------------
-- The two foreign keys are deliberately NOT the same rule, and the difference
-- is the whole argument:
--
--   * a hold is a transient claim, and a table that closes must never keep one,
--     so reservation -> slot is ON DELETE CASCADE;
--   * a participation period is a RECORD. lightning_hand_player.pool_slot_id
--     deliberately carries no foreign key so hand history outlives the pool, so
--     a slot that could vanish with its session would leave every historical
--     hand pointing at a table that no longer exists and per-table statistics
--     unreconstructable. That is the same rule as "instance destruction must
--     never destroy hand history", one level down. So slot -> session is
--     ON DELETE RESTRICT: a period is closed, not deleted.
--
-- Both halves of the RESTRICT are proved: the delete is REFUSED while a slot
-- exists, and SUCCEEDS once the slots are gone, so "restrict" is not "never".
DO $$
DECLARE v_n bigint; v_raised boolean := false; v_constraint text;
BEGIN
  INSERT INTO public.lightning_pool_session
    (id, cluster_id, cluster_epoch, player_id, cash_player_session_id, state)
  VALUES ('b0010000-0000-0000-0000-00000000000d', 'c1a50000-0000-0000-0000-000000000001', 0,
          '70000000-0000-0000-0000-00000000000c', '5e550000-0000-0000-0000-00000000000c', 'active');
  INSERT INTO public.lightning_pool_slot (id, pool_session_id, cluster_id, cluster_epoch, player_id, slot) VALUES
    ('51070000-0000-0000-0000-00000000000f', 'b0010000-0000-0000-0000-00000000000d',
     'c1a50000-0000-0000-0000-000000000001', 0, '70000000-0000-0000-0000-00000000000c', 1),
    ('51070000-0000-0000-0000-000000000010', 'b0010000-0000-0000-0000-00000000000d',
     'c1a50000-0000-0000-0000-000000000001', 0, '70000000-0000-0000-0000-00000000000c', 2);
  INSERT INTO public.lightning_reservation
    (id, cluster_id, cluster_epoch, player_id, pool_slot_id, created_at, expires_at)
  VALUES ('4e550000-0000-0000-0000-00000000000b', 'c1a50000-0000-0000-0000-000000000001', 0,
          '70000000-0000-0000-0000-00000000000c', '51070000-0000-0000-0000-00000000000f',
          '2026-09-20T12:00:00Z', '2026-09-20T12:00:10Z');

  -- HOP 1, RESTRICT: a participation period that still has a table cannot be
  -- deleted at all. This is the check that protects hand history.
  BEGIN
    DELETE FROM public.lightning_pool_session WHERE id = 'b0010000-0000-0000-0000-00000000000d';
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FAIL delete rules: a pool session was DELETED while it still owned tables, so every historical hand written against those tables now points at a lightning_pool_slot that does not exist and per-table statistics are unreconstructable';
  END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_pool_slot_belongs_to_its_session' THEN
    RAISE EXCEPTION 'FAIL delete rules: the session delete was refused by %, not the named lightning_pool_slot_belongs_to_its_session', coalesce(v_constraint, '<unnamed>');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.lightning_pool_session WHERE id = 'b0010000-0000-0000-0000-00000000000d')
     OR (SELECT count(*) FROM public.lightning_pool_slot WHERE pool_session_id = 'b0010000-0000-0000-0000-00000000000d')
        IS DISTINCT FROM 2::bigint THEN
    RAISE EXCEPTION 'FAIL delete rules: the refused delete still removed something';
  END IF;

  -- HOP 2, CASCADE: a table that goes away takes its transient holds with it.
  IF (SELECT count(*) FROM public.lightning_reservation WHERE pool_slot_id = '51070000-0000-0000-0000-00000000000f')
     IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL delete rules: the hold to be cascaded does not exist, so the delete below would prove nothing';
  END IF;
  BEGIN
    DELETE FROM public.lightning_pool_slot WHERE id = '51070000-0000-0000-0000-00000000000f';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE EXCEPTION 'FAIL delete rules: deleting a table was REFUSED by its own hold, so lightning_reservation_belongs_to_its_slot is not ON DELETE CASCADE (%)', SQLERRM;
  END;
  IF EXISTS (SELECT 1 FROM public.lightning_reservation WHERE id = '4e550000-0000-0000-0000-00000000000b') THEN
    RAISE EXCEPTION 'FAIL delete rules: a hold outlived the table it was holding a seat for';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.lightning_pool_slot WHERE id = '51070000-0000-0000-0000-000000000010') THEN
    RAISE EXCEPTION 'FAIL delete rules: deleting one table removed its sibling too';
  END IF;

  -- THE ACCEPT-HALF OF RESTRICT: once the tables are gone the period can be
  -- deleted. RESTRICT must mean "not while children exist", not "never".
  DELETE FROM public.lightning_pool_slot WHERE id = '51070000-0000-0000-0000-000000000010';
  BEGIN
    DELETE FROM public.lightning_pool_session WHERE id = 'b0010000-0000-0000-0000-00000000000d';
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    RAISE EXCEPTION 'FAIL delete rules: % refused a session delete with no slots left, so a participation period can never be removed at all', coalesce(v_constraint, '<unnamed>');
  END;
  IF EXISTS (SELECT 1 FROM public.lightning_pool_session WHERE id = 'b0010000-0000-0000-0000-00000000000d') THEN
    RAISE EXCEPTION 'FAIL delete rules: the childless session survived its own DELETE';
  END IF;
END $$;
\echo '  ok  DELETE RULES       a session with tables is REFUSED by lightning_pool_slot_belongs_to_its_session (RESTRICT, so hand history keeps its slot); a table takes its holds (CASCADE); a childless session deletes fine'

-- IDENTITY AGREES ------------------------------------------------------------
-- player_id and cluster_id are denormalised onto the slot and onto the hold so
-- the indexes can key on them without a join, and denormalised copies that
-- nothing checks are copies that drift. The one that matters most is
-- lightning_reservation_one_seat_per_player_instance: it keys on the HOLD's own
-- player_id, so a hold whose player_id disagreed with its slot's would silently
-- reopen exactly the hole that index exists to close. The composite foreign
-- keys are what make the copies provably agree.
--
-- Both halves: mismatched values are REFUSED at each level, and matching values
-- insert, so the refusal is not simply "nothing can be written".
DO $$
DECLARE v_raised boolean; v_constraint text;
BEGIN
  INSERT INTO public.lightning_pool_session
    (id, cluster_id, cluster_epoch, player_id, cash_player_session_id, state)
  VALUES ('b0010000-0000-0000-0000-00000000000c', 'c1a50000-0000-0000-0000-000000000001', 0,
          '70000000-0000-0000-0000-00000000000b', '5e550000-0000-0000-0000-00000000000b', 'active');

  -- A slot that claims a DIFFERENT human than its own session.
  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.lightning_pool_slot (id, pool_session_id, cluster_id, cluster_epoch, player_id, slot)
    VALUES ('51070000-0000-0000-0000-0000000000e1', 'b0010000-0000-0000-0000-00000000000c',
            'c1a50000-0000-0000-0000-000000000001', 0, '70000000-0000-0000-0000-0000000000ff', 1);
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FAIL identity: a table claims a different human than the participation period that owns it, so lightning_pool_slot_one_open enforces one-open-table for the WRONG player and lightning_pool_slot_oldest_bb selects blinds for them too';
  END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_pool_slot_belongs_to_its_session' THEN
    RAISE EXCEPTION 'FAIL identity: the mismatched player was refused by %, not the named lightning_pool_slot_belongs_to_its_session', coalesce(v_constraint, '<unnamed>');
  END IF;

  -- A slot that claims a DIFFERENT cluster than its own session.
  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.lightning_pool_slot (id, pool_session_id, cluster_id, cluster_epoch, player_id, slot)
    VALUES ('51070000-0000-0000-0000-0000000000e2', 'b0010000-0000-0000-0000-00000000000c',
            'c1a50000-0000-0000-0000-000000000099', 0, '70000000-0000-0000-0000-00000000000b', 1);
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FAIL identity: a table claims a different Cluster than the participation period that owns it';
  END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_pool_slot_belongs_to_its_session' THEN
    RAISE EXCEPTION 'FAIL identity: the mismatched cluster was refused by %, not lightning_pool_slot_belongs_to_its_session', coalesce(v_constraint, '<unnamed>');
  END IF;

  -- ACCEPT-HALF, level one: matching values land.
  INSERT INTO public.lightning_pool_slot (id, pool_session_id, cluster_id, cluster_epoch, player_id, slot) VALUES
    ('51070000-0000-0000-0000-00000000000d', 'b0010000-0000-0000-0000-00000000000c',
     'c1a50000-0000-0000-0000-000000000001', 0, '70000000-0000-0000-0000-00000000000b', 1),
    ('51070000-0000-0000-0000-00000000000e', 'b0010000-0000-0000-0000-00000000000c',
     'c1a50000-0000-0000-0000-000000000001', 0, '70000000-0000-0000-0000-00000000000b', 2);
  IF (SELECT count(*) FROM public.lightning_pool_slot WHERE pool_session_id = 'b0010000-0000-0000-0000-00000000000c')
     IS DISTINCT FROM 2::bigint THEN
    RAISE EXCEPTION 'FAIL identity: two tables whose human and cluster MATCH their session were refused, so the composite key refuses everything and proves nothing';
  END IF;

  -- A hold that claims a DIFFERENT human than the table it is held against.
  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.lightning_reservation
      (id, cluster_id, cluster_epoch, player_id, pool_slot_id, created_at, expires_at)
    VALUES ('4e550000-0000-0000-0000-0000000000e1', 'c1a50000-0000-0000-0000-000000000001', 0,
            '70000000-0000-0000-0000-0000000000ff', '51070000-0000-0000-0000-00000000000d',
            '2026-09-20T12:00:00Z', '2026-09-20T12:00:10Z');
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FAIL identity: a hold names a different human than the table it is held against, so lightning_reservation_one_seat_per_player_instance keys on a player who is not the one being seated and the one-seat-per-player rule protects the wrong human';
  END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_reservation_belongs_to_its_slot' THEN
    RAISE EXCEPTION 'FAIL identity: the mismatched hold player was refused by %, not the named lightning_reservation_belongs_to_its_slot', coalesce(v_constraint, '<unnamed>');
  END IF;

  -- A hold that claims a DIFFERENT cluster than its table.
  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.lightning_reservation
      (id, cluster_id, cluster_epoch, player_id, pool_slot_id, created_at, expires_at)
    VALUES ('4e550000-0000-0000-0000-0000000000e2', 'c1a50000-0000-0000-0000-000000000099', 0,
            '70000000-0000-0000-0000-00000000000b', '51070000-0000-0000-0000-00000000000d',
            '2026-09-20T12:00:00Z', '2026-09-20T12:00:10Z');
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FAIL identity: a hold names a different Cluster than the table it is held against';
  END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_reservation_belongs_to_its_slot' THEN
    RAISE EXCEPTION 'FAIL identity: the mismatched hold cluster was refused by %, not lightning_reservation_belongs_to_its_slot', coalesce(v_constraint, '<unnamed>');
  END IF;

  -- ACCEPT-HALF, level two: a hold whose human and cluster match its table lands.
  INSERT INTO public.lightning_reservation
    (id, cluster_id, cluster_epoch, player_id, pool_slot_id, created_at, expires_at)
  VALUES ('4e550000-0000-0000-0000-000000000009', 'c1a50000-0000-0000-0000-000000000001', 0,
          '70000000-0000-0000-0000-00000000000b', '51070000-0000-0000-0000-00000000000d',
          '2026-09-20T12:00:00Z', '2026-09-20T12:00:10Z');
  IF NOT EXISTS (SELECT 1 FROM public.lightning_reservation WHERE id = '4e550000-0000-0000-0000-000000000009') THEN
    RAISE EXCEPTION 'FAIL identity: a hold whose human and cluster MATCH its table was refused, so the composite key refuses everything and proves nothing';
  END IF;
END $$;
\echo '  ok  IDENTITY AGREES    a slot or a hold whose player or cluster differs from its parent is refused by the named composite FK; matching values insert'

-- BLIND LEDGER ---------------------------------------------------------------
-- What is left here after the orbit moved: the frequency totals and the debt,
-- both of which are owed by the HUMAN to the Cluster and do aggregate across
-- that human's tables.
DO $$
DECLARE v_raised boolean; v_constraint text;
BEGIN
  INSERT INTO public.lightning_blind_ledger (cluster_id, player_id, bb_count, sb_count, bb_owed)
  VALUES ('c1a50000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-00000000000d', 3, 4, 2.00);
  INSERT INTO public.lightning_blind_ledger (cluster_id, player_id)
  VALUES ('c1a50000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-00000000000d');

  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.lightning_blind_ledger (cluster_id, player_id)
    VALUES ('c1a50000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-00000000000d');
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FAIL ledger: one player carries TWO blind ledgers in one cluster, so blind fairness has two disagreeing answers';
  END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_blind_ledger_pkey' THEN
    RAISE EXCEPTION 'FAIL ledger: refused by %, not the named lightning_blind_ledger_pkey', coalesce(v_constraint, '<unnamed>');
  END IF;

  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.lightning_blind_ledger (cluster_id, player_id, bb_count)
    VALUES ('c1a50000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-00000000000e', -1);
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'FAIL ledger: a player has posted -1 big blinds'; END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_blind_ledger_counts_nonneg' THEN
    RAISE EXCEPTION 'FAIL ledger: bb_count = -1 was refused by %, not the named lightning_blind_ledger_counts_nonneg', coalesce(v_constraint, '<unnamed>');
  END IF;

  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.lightning_blind_ledger (cluster_id, player_id, bb_owed)
    VALUES ('c1a50000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-00000000000e', -1);
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'FAIL ledger: the house owes a player -1 in blinds, which is money flowing the wrong way'; END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_blind_ledger_debt_nonneg' THEN
    RAISE EXCEPTION 'FAIL ledger: bb_owed = -1 was refused by %, not the named lightning_blind_ledger_debt_nonneg', coalesce(v_constraint, '<unnamed>');
  END IF;
END $$;
\echo '  ok  BLIND LEDGER       (cluster, player) is the key; bb_count = -1 and bb_owed = -1 raise their named CHECKs'

-- HAND LINKAGE ---------------------------------------------------------------
DO $$
DECLARE v_raised boolean := false; v_constraint text;
BEGIN
  INSERT INTO public.lightning_hand
    (hand_id, cluster_id, cluster_epoch, lightning_instance_id, formed_at, settled_at)
  VALUES ('fa4d0000-0000-0000-0000-00000000000a', 'c1a50000-0000-0000-0000-000000000001', 0,
          '1a570000-0000-0000-0000-000000000002', '2026-09-20T12:00:00Z', '2026-09-20T12:01:30Z'),
         ('fa4d0000-0000-0000-0000-00000000000b', 'c1a50000-0000-0000-0000-000000000001', 0,
          '1a570000-0000-0000-0000-000000000006', '2026-09-20T12:02:00Z', NULL);

  BEGIN
    UPDATE public.lightning_hand SET settled_at = '2026-09-20T11:59:00Z'
     WHERE hand_id = 'fa4d0000-0000-0000-0000-00000000000a';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'FAIL hand: a hand settled a minute BEFORE it formed'; END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_hand_settles_after_formation' THEN
    RAISE EXCEPTION 'FAIL hand: refused by %, not the named lightning_hand_settles_after_formation', coalesce(v_constraint, '<unnamed>');
  END IF;
END $$;
\echo '  ok  HAND LINKAGE       a Lightning hand records its cluster, epoch and instance and cannot settle before it formed'

-- FOLD TAXONOMY --------------------------------------------------------------
DO $$
DECLARE f text; n integer := 0; v_raised boolean; v_constraint text; v_seat smallint := 1; v_pos text;
BEGIN
  FOREACH f IN ARRAY ARRAY['none','normal','fast','fold_watch'] LOOP
    INSERT INTO public.lightning_hand_player
      (hand_id, player_id, pool_slot_id, seat, position, blind_role, fold_type)
    VALUES ('fa4d0000-0000-0000-0000-00000000000a',
            ('70000000-0000-0000-0000-0000000000' || lpad(to_hex(16 + n), 2, '0'))::uuid,
            '51070000-0000-0000-0000-000000000001', v_seat, 'btn', 'none', f);
    IF (SELECT fold_type FROM public.lightning_hand_player
         WHERE hand_id = 'fa4d0000-0000-0000-0000-00000000000a' AND seat = v_seat)
       IS DISTINCT FROM f THEN
      RAISE EXCEPTION 'FAIL fold: % did not stick', f;
    END IF;
    n := n + 1; v_seat := v_seat + 1;
  END LOOP;
  IF n IS DISTINCT FROM 4 THEN RAISE EXCEPTION 'FAIL fold: only % of the four fold types were accepted', n; END IF;

  INSERT INTO public.lightning_hand_player (hand_id, player_id, pool_slot_id, seat)
  VALUES ('fa4d0000-0000-0000-0000-00000000000a', '70000000-0000-0000-0000-0000000000ff',
          '51070000-0000-0000-0000-000000000001', 5);
  IF (SELECT fold_type FROM public.lightning_hand_player
       WHERE hand_id = 'fa4d0000-0000-0000-0000-00000000000a' AND seat = 5) IS DISTINCT FROM 'none' THEN
    RAISE EXCEPTION 'FAIL fold: fold_type does not default to none';
  END IF;
  -- position and blind_role are NULLABLE, and a bare read of `position` -- a
  -- reserved word in the SQL grammar -- must still parse.
  SELECT position INTO v_pos FROM public.lightning_hand_player
   WHERE hand_id = 'fa4d0000-0000-0000-0000-00000000000a' AND seat = 5;
  IF v_pos IS NOT NULL THEN RAISE EXCEPTION 'FAIL fold: position is not nullable (%)', v_pos; END IF;
  IF (SELECT blind_role FROM public.lightning_hand_player
       WHERE hand_id = 'fa4d0000-0000-0000-0000-00000000000a' AND seat = 5) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL fold: blind_role is not nullable';
  END IF;

  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.lightning_hand_player (hand_id, player_id, pool_slot_id, seat, fold_type)
    VALUES ('fa4d0000-0000-0000-0000-00000000000a', '70000000-0000-0000-0000-0000000000fe',
            '51070000-0000-0000-0000-000000000001', 6, 'slow');
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FAIL fold: fold_type accepted ''slow'', a value outside the four-way taxonomy, so the fast-fold counters can never be trusted';
  END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_hand_player_fold_type_check' THEN
    RAISE EXCEPTION 'FAIL fold: refused by %, not the named lightning_hand_player_fold_type_check', coalesce(v_constraint, '<unnamed>');
  END IF;

  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.lightning_hand_player (hand_id, player_id, pool_slot_id, seat, position)
    VALUES ('fa4d0000-0000-0000-0000-00000000000a', '70000000-0000-0000-0000-0000000000fd',
            '51070000-0000-0000-0000-000000000001', 6, 'straddle');
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'FAIL fold: position accepted ''straddle'', which is a blind role and not a seat position'; END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_hand_player_position_check' THEN
    RAISE EXCEPTION 'FAIL fold: an invalid position was refused by %, not the named lightning_hand_player_position_check', coalesce(v_constraint, '<unnamed>');
  END IF;

  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.lightning_hand_player (hand_id, player_id, pool_slot_id, seat, blind_role)
    VALUES ('fa4d0000-0000-0000-0000-00000000000a', '70000000-0000-0000-0000-0000000000fc',
            '51070000-0000-0000-0000-000000000001', 6, 'utg');
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'FAIL fold: blind_role accepted ''utg'', which is a position and not a blind role'; END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_hand_player_blind_role_check' THEN
    RAISE EXCEPTION 'FAIL fold: an invalid blind_role was refused by %, not the named lightning_hand_player_blind_role_check', coalesce(v_constraint, '<unnamed>');
  END IF;
END $$;
\echo '  ok  FOLD TAXONOMY      none/normal/fast/fold_watch accepted; a fifth fold type, a bad position and a bad blind role each raise their named CHECK'

-- ONE PLAYER PER SEAT PER HAND -----------------------------------------------
-- The other half of the formation barrier. The second case matters more with
-- three levels: a multi-tabler legitimately holds several slots, and
-- lightning_hand_player_pkey is what stops two of them landing in ONE hand.
DO $$
DECLARE v_raised boolean; v_constraint text;
BEGIN
  INSERT INTO public.lightning_hand_player (hand_id, player_id, pool_slot_id, seat, position, blind_role)
  VALUES ('fa4d0000-0000-0000-0000-00000000000b', '70000000-0000-0000-0000-000000000021',
          '51070000-0000-0000-0000-00000000000b', 2, 'sb', 'sb');

  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.lightning_hand_player (hand_id, player_id, pool_slot_id, seat)
    VALUES ('fa4d0000-0000-0000-0000-00000000000b', '70000000-0000-0000-0000-000000000022',
            '51070000-0000-0000-0000-00000000000b', 2);
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FAIL one seat per hand: two players occupy seat 2 of the same hand, so the committed participant set is not a set';
  END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_hand_player_one_per_seat' THEN
    RAISE EXCEPTION 'FAIL one seat per hand: refused by %, not the named lightning_hand_player_one_per_seat', coalesce(v_constraint, '<unnamed>');
  END IF;

  -- TWO OF THE PLAYER'S TABLES CANNOT LAND IN ONE HAND. Different pool_slot_id
  -- and a different seat, so only the primary key can be what refuses it.
  v_raised := false; v_constraint := NULL;
  BEGIN
    INSERT INTO public.lightning_hand_player (hand_id, player_id, pool_slot_id, seat)
    VALUES ('fa4d0000-0000-0000-0000-00000000000b', '70000000-0000-0000-0000-000000000021',
            '51070000-0000-0000-0000-00000000000c', 3);
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME; v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FAIL one player per hand: one player sits in two chairs of one hand through two of their tables, so the formation barrier no longer locks a participant SET';
  END IF;
  IF v_constraint IS DISTINCT FROM 'lightning_hand_player_pkey' THEN
    RAISE EXCEPTION 'FAIL one player per hand: refused by %, not the named lightning_hand_player_pkey', coalesce(v_constraint, '<unnamed>');
  END IF;
END $$;
\echo '  ok  SEAT PER HAND      a shared seat raises lightning_hand_player_one_per_seat; the same player through a SECOND table raises lightning_hand_player_pkey'

-- EVERY NAMED CONSTRAINT AND INDEX -------------------------------------------
-- Several of the objects above have a behavioural signature; several do not.
-- Deleting lightning_reservation_pending_by_expiry, lightning_blind_ledger_owing
-- or lightning_pool_slot_by_session changes no answer this harness can observe,
-- only how expensive the answer is. They are asserted by NAME so a later edit
-- cannot quietly drop one and have it found months later by a nightly audit.
DO $$
DECLARE v_missing text; v_def text; v_bad text;
BEGIN
  SELECT string_agg(x.want, ', ' ORDER BY x.want) INTO v_missing
    FROM unnest(ARRAY[
      'lightning_pool_session_pkey',
      'lightning_pool_session_identity',
      'lightning_pool_session_state_check',
      'lightning_pool_session_epoch_nonneg',
      'lightning_pool_session_exit_is_explained',
      'lightning_pool_slot_pkey',
      'lightning_pool_slot_identity',
      'lightning_pool_slot_belongs_to_its_session',
      'lightning_pool_slot_range',
      'lightning_pool_slot_epoch_nonneg',
      'lightning_pool_slot_counters_nonneg',
      'lightning_pool_slot_close_is_explained',
      'lightning_instance_pkey',
      'lightning_instance_state_check',
      'lightning_instance_epoch_nonneg',
      'lightning_instance_sizes',
      'lightning_instance_lifecycle_order',
      'lightning_reservation_pkey',
      'lightning_reservation_belongs_to_its_slot',
      'lightning_reservation_state_check',
      'lightning_reservation_epoch_nonneg',
      'lightning_reservation_expires_after_creation',
      'lightning_reservation_seat_range',
      'lightning_reservation_resolution',
      'lightning_reservation_committed_names_its_instance',
      'lightning_blind_ledger_pkey',
      'lightning_blind_ledger_counts_nonneg',
      'lightning_blind_ledger_debt_nonneg',
      'lightning_hand_pkey',
      'lightning_hand_epoch_nonneg',
      'lightning_hand_settles_after_formation',
      'lightning_hand_player_pkey',
      'lightning_hand_player_fold_type_check',
      'lightning_hand_player_position_check',
      'lightning_hand_player_blind_role_check',
      'lightning_hand_player_seat_range',
      'cash_cluster_events_epoch_nonneg']) AS x(want)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public' AND c.conname = x.want);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL catalog: the migration declares constraint(s) that do not exist: %', v_missing;
  END IF;

  SELECT string_agg(x.want, ', ' ORDER BY x.want) INTO v_missing
    FROM unnest(ARRAY[
      'lightning_pool_session_pkey',
      'lightning_pool_session_identity',
      'lightning_pool_session_one_open',
      'lightning_pool_session_open_by_cluster',
      'lightning_pool_session_by_cash_session',
      'lightning_pool_slot_pkey',
      'lightning_pool_slot_identity',
      'lightning_pool_slot_one_open',
      'lightning_pool_slot_oldest_bb',
      'lightning_pool_slot_by_session',
      'lightning_instance_pkey',
      'lightning_instance_one_per_hand',
      'lightning_instance_live_by_cluster',
      'lightning_reservation_pkey',
      'lightning_reservation_one_pending_per_slot',
      'lightning_reservation_one_seat_per_instance',
      'lightning_reservation_one_seat_per_player_instance',
      'lightning_reservation_pending_by_expiry',
      'lightning_reservation_by_pool_slot',
      'lightning_blind_ledger_pkey',
      'lightning_blind_ledger_owing',
      'lightning_hand_pkey',
      'lightning_hand_by_cluster_epoch',
      'lightning_hand_by_instance',
      'lightning_hand_player_pkey',
      'lightning_hand_player_one_per_seat',
      'lightning_hand_player_by_pool_slot']) AS x(want)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = x.want);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL catalog: the migration declares index(es) that do not exist: %', v_missing;
  END IF;

  -- Superseded names must be GONE, or a later reader finds two indexes claiming
  -- the same rule with different keys.
  SELECT string_agg(x.want, ', ' ORDER BY x.want) INTO v_bad
    FROM unnest(ARRAY['lightning_reservation_one_pending_per_player',
                      'lightning_blind_ledger_oldest_bb',
                      'lightning_hand_player_by_pool_session']) AS x(want)
   WHERE EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = x.want);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL catalog: superseded index(es) % still exist alongside their replacements', v_bad;
  END IF;

  -- The indexes that are load-bearing rather than merely fast, checked for the
  -- SHAPE the migration declares and not only for their name.
  SELECT indexdef INTO v_def FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'lightning_pool_session_one_open';
  IF v_def IS NULL OR position('UNIQUE' in v_def) = 0 OR position('exited_at IS NULL' in v_def) = 0 THEN
    RAISE EXCEPTION 'FAIL catalog: lightning_pool_session_one_open is not the UNIQUE partial index the migration declares (%)', coalesce(v_def, '<no definition>');
  END IF;
  SELECT indexdef INTO v_def FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'lightning_pool_slot_one_open';
  IF v_def IS NULL OR position('UNIQUE' in v_def) = 0
     OR position('(player_id, cluster_id, slot)' in v_def) = 0
     OR position('closed_at IS NULL' in v_def) = 0 THEN
    RAISE EXCEPTION 'FAIL catalog: lightning_pool_slot_one_open is not UNIQUE on (player_id, cluster_id, slot) WHERE closed_at IS NULL (%)', coalesce(v_def, '<no definition>');
  END IF;
  SELECT indexdef INTO v_def FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'lightning_instance_one_per_hand';
  IF v_def IS NULL OR position('UNIQUE' in v_def) = 0 OR position('hand_id IS NOT NULL' in v_def) = 0 THEN
    RAISE EXCEPTION 'FAIL catalog: lightning_instance_one_per_hand is not the UNIQUE partial index the migration declares (%)', coalesce(v_def, '<no definition>');
  END IF;
  SELECT indexdef INTO v_def FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'lightning_reservation_one_pending_per_slot';
  IF v_def IS NULL OR position('UNIQUE' in v_def) = 0 OR position('(pool_slot_id)' in v_def) = 0
     OR position('''pending''' in v_def) = 0 THEN
    RAISE EXCEPTION 'FAIL catalog: lightning_reservation_one_pending_per_slot is not UNIQUE on (pool_slot_id) WHERE state = ''pending'' (%)', coalesce(v_def, '<no definition>');
  END IF;
  SELECT indexdef INTO v_def FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'lightning_reservation_one_seat_per_instance';
  IF v_def IS NULL OR position('UNIQUE' in v_def) = 0 THEN
    RAISE EXCEPTION 'FAIL catalog: lightning_reservation_one_seat_per_instance is not UNIQUE (%)', coalesce(v_def, '<no definition>');
  END IF;
  -- Key AND predicate verbatim. Dropping `lightning_instance_id IS NOT NULL`
  -- from this predicate has NO behavioural signature at all -- a multi-column
  -- unique btree already admits any number of NULLs -- so the catalog is the
  -- only place that mutation can ever be caught.
  SELECT indexdef INTO v_def FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'lightning_reservation_one_seat_per_player_instance';
  IF v_def IS NULL OR position('UNIQUE' in v_def) = 0
     OR position('(player_id, lightning_instance_id)' in v_def) = 0
     OR position('lightning_instance_id IS NOT NULL' in v_def) = 0
     OR position('''pending''' in v_def) = 0 OR position('''committed''' in v_def) = 0 THEN
    RAISE EXCEPTION 'FAIL catalog: lightning_reservation_one_seat_per_player_instance is not UNIQUE on (player_id, lightning_instance_id) WHERE state IN (''pending'',''committed'') AND lightning_instance_id IS NOT NULL (%)', coalesce(v_def, '<no definition>');
  END IF;
  SELECT indexdef INTO v_def FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'lightning_hand_player_one_per_seat';
  IF v_def IS NULL OR position('UNIQUE' in v_def) = 0 THEN
    RAISE EXCEPTION 'FAIL catalog: lightning_hand_player_one_per_seat is not UNIQUE (%)', coalesce(v_def, '<no definition>');
  END IF;

  -- The two composite identity targets, verbatim. A two-column key would let
  -- the child name only (id, player_id) or (id, cluster_id) and the other copy
  -- would be free to drift again.
  SELECT indexdef INTO v_def FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'lightning_pool_session_identity';
  IF v_def IS NULL OR position('UNIQUE' in v_def) = 0 OR position('(id, player_id, cluster_id)' in v_def) = 0 THEN
    RAISE EXCEPTION 'FAIL catalog: lightning_pool_session_identity is not UNIQUE on (id, player_id, cluster_id) (%)', coalesce(v_def, '<no definition>');
  END IF;
  SELECT indexdef INTO v_def FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'lightning_pool_slot_identity';
  IF v_def IS NULL OR position('UNIQUE' in v_def) = 0 OR position('(id, player_id, cluster_id)' in v_def) = 0 THEN
    RAISE EXCEPTION 'FAIL catalog: lightning_pool_slot_identity is not UNIQUE on (id, player_id, cluster_id) (%)', coalesce(v_def, '<no definition>');
  END IF;

  -- ...and they are real UNIQUE CONSTRAINTS, not merely unique indexes.
  -- PostgreSQL accepts a foreign key that references a bare CREATE UNIQUE
  -- INDEX, so the two assertions above would pass either way. The difference is
  -- invisible in pg_indexes and decisive everywhere else: information_schema
  -- models SQL-standard CONSTRAINTS, so with a bare index
  -- referential_constraints.unique_constraint_name comes back NULL and anything
  -- that introspects through information_schema rather than pg_catalog -- schema
  -- diff tools, ORM reflection, Supabase's own introspection -- can see that
  -- the foreign key exists but cannot resolve what it points at.
  SELECT string_agg(format('%s=%s', x.want, coalesce(c.contype::text, '<absent>')), ', ' ORDER BY x.want) INTO v_bad
    FROM unnest(ARRAY['lightning_pool_session_identity','lightning_pool_slot_identity']) AS x(want)
    LEFT JOIN pg_constraint c ON c.conname = x.want AND c.contype = 'u'
   WHERE c.oid IS NULL;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL catalog: identity target(s) % are not UNIQUE CONSTRAINTS (contype u) but bare indexes, so information_schema cannot resolve the foreign keys that reference them', v_bad;
  END IF;

  -- The consequence, asserted where it is actually observed.
  SELECT string_agg(format('%s -> %s', r.constraint_name, coalesce(r.unique_constraint_name, '<NULL>')), ', '
                    ORDER BY r.constraint_name) INTO v_bad
    FROM information_schema.referential_constraints r
   WHERE r.constraint_schema = 'public'
     AND r.constraint_name IN ('lightning_pool_slot_belongs_to_its_session','lightning_reservation_belongs_to_its_slot')
     AND r.unique_constraint_name IS NULL;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL catalog: foreign key(s) % do not resolve through information_schema.referential_constraints, so every consumer that introspects that way sees a key pointing at nothing', v_bad;
  END IF;
  IF (SELECT count(*) FROM information_schema.referential_constraints r
       WHERE r.constraint_schema = 'public'
         AND r.constraint_name IN ('lightning_pool_slot_belongs_to_its_session','lightning_reservation_belongs_to_its_slot'))
     IS DISTINCT FROM 2::bigint THEN
    RAISE EXCEPTION 'FAIL catalog: information_schema.referential_constraints does not report both Lightning foreign keys, so the check above would be vacuous';
  END IF;
  IF (SELECT r.unique_constraint_name FROM information_schema.referential_constraints r
       WHERE r.constraint_schema = 'public' AND r.constraint_name = 'lightning_pool_slot_belongs_to_its_session')
     IS DISTINCT FROM 'lightning_pool_session_identity'
     OR (SELECT r.unique_constraint_name FROM information_schema.referential_constraints r
          WHERE r.constraint_schema = 'public' AND r.constraint_name = 'lightning_reservation_belongs_to_its_slot')
        IS DISTINCT FROM 'lightning_pool_slot_identity' THEN
    RAISE EXCEPTION 'FAIL catalog: a Lightning foreign key resolves to the wrong identity constraint';
  END IF;

  -- The referencing side of the CASCADE needs an index that covers EVERY row.
  -- lightning_reservation_one_pending_per_slot is partial on state = pending,
  -- so it cannot serve the referential check, and without this index deleting
  -- one slot sequentially scans the whole reservation table -- measured at
  -- 19,990 rows scanned to find 10, under the lock the delete holds, getting
  -- worse as Lightning gets busier.
  SELECT indexdef INTO v_def FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'lightning_reservation_by_pool_slot';
  IF v_def IS NULL OR position('(pool_slot_id)' in v_def) = 0 THEN
    RAISE EXCEPTION 'FAIL catalog: lightning_reservation_by_pool_slot is not an index on (pool_slot_id) (%)', coalesce(v_def, '<no definition>');
  END IF;
  IF position(' WHERE ' in v_def) > 0 THEN
    RAISE EXCEPTION 'FAIL catalog: lightning_reservation_by_pool_slot is PARTIAL (%), so it cannot serve the ON DELETE CASCADE referential check for holds that are not pending, which is nearly all of them', v_def;
  END IF;

  -- EXACTLY TWO foreign keys, each named, each COMPOSITE over all three
  -- columns, and each with its own delete rule: RESTRICT upward so hand history
  -- keeps its table, CASCADE downward so a closed table keeps no claim.
  -- "NO FOREIGN KEYS TO ANY EXISTING TABLE" still holds: both stay inside the
  -- Lightning family, because this estate has already lost minutes of Postgres
  -- to an FK on a hot relation.
  SELECT string_agg(format('%s on %s: %s (delete %s)', c.conname, c.conrelid::regclass::text,
                           pg_get_constraintdef(c.oid), c.confdeltype), ', ' ORDER BY c.conname)
    INTO v_bad
    FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid JOIN pg_namespace n ON n.oid = r.relnamespace
   WHERE c.contype = 'f' AND n.nspname = 'public' AND r.relname LIKE 'lightning\_%'
     AND NOT (c.conname = 'lightning_pool_slot_belongs_to_its_session'
              AND c.confrelid = 'public.lightning_pool_session'::regclass
              AND c.confdeltype = 'r' AND array_length(c.conkey, 1) = 3
              AND pg_get_constraintdef(c.oid) = 'FOREIGN KEY (pool_session_id, player_id, cluster_id) REFERENCES lightning_pool_session(id, player_id, cluster_id) ON DELETE RESTRICT')
     AND NOT (c.conname = 'lightning_reservation_belongs_to_its_slot'
              AND c.confrelid = 'public.lightning_pool_slot'::regclass
              AND c.confdeltype = 'c' AND array_length(c.conkey, 1) = 3
              AND pg_get_constraintdef(c.oid) = 'FOREIGN KEY (pool_slot_id, player_id, cluster_id) REFERENCES lightning_pool_slot(id, player_id, cluster_id) ON DELETE CASCADE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL catalog: a Lightning foreign key is not the named three-column key with the delete rule the migration declares: %', v_bad;
  END IF;
  IF (SELECT count(*) FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = r.relnamespace
      WHERE c.contype = 'f' AND n.nspname = 'public' AND r.relname LIKE 'lightning\_%')
     IS DISTINCT FROM 2::bigint THEN
    RAISE EXCEPTION 'FAIL catalog: the Lightning family does not carry exactly the two hierarchy foreign keys';
  END IF;

  -- Each composite FK is backed by the identity index, and PostgreSQL records
  -- that dependency, which is what stops a later edit dropping the index out
  -- from under the key.
  IF (SELECT i.relname FROM pg_constraint c JOIN pg_class i ON i.oid = c.conindid
       WHERE c.conname = 'lightning_pool_slot_belongs_to_its_session')
     IS DISTINCT FROM 'lightning_pool_session_identity' THEN
    RAISE EXCEPTION 'FAIL catalog: lightning_pool_slot_belongs_to_its_session is not backed by lightning_pool_session_identity';
  END IF;
  IF (SELECT i.relname FROM pg_constraint c JOIN pg_class i ON i.oid = c.conindid
       WHERE c.conname = 'lightning_reservation_belongs_to_its_slot')
     IS DISTINCT FROM 'lightning_pool_slot_identity' THEN
    RAISE EXCEPTION 'FAIL catalog: lightning_reservation_belongs_to_its_slot is not backed by lightning_pool_slot_identity';
  END IF;
END $$;
\echo '  ok  CATALOG            every constraint and index the migration names exists with its declared key and predicate; both identity targets are real UNIQUE CONSTRAINTS so both composite foreign keys resolve through information_schema; RESTRICT up, CASCADE down, and the cascade has an unpartial covering index'

-- The preimage of the re-apply: every row of everything the migration creates
-- or touches.
CREATE TEMP TABLE pre_reapply_pool_session AS SELECT * FROM public.lightning_pool_session;
CREATE TEMP TABLE pre_reapply_pool_slot    AS SELECT * FROM public.lightning_pool_slot;
CREATE TEMP TABLE pre_reapply_instance     AS SELECT * FROM public.lightning_instance;
CREATE TEMP TABLE pre_reapply_reservation  AS SELECT * FROM public.lightning_reservation;
CREATE TEMP TABLE pre_reapply_ledger       AS SELECT * FROM public.lightning_blind_ledger;
CREATE TEMP TABLE pre_reapply_hand         AS SELECT * FROM public.lightning_hand;
CREATE TEMP TABLE pre_reapply_hand_player  AS SELECT * FROM public.lightning_hand_player;
CREATE TEMP TABLE pre_reapply_events       AS SELECT * FROM public.cash_cluster_events;
CREATE TEMP TABLE pre_reapply_counts AS
  SELECT (SELECT count(*) FROM public.lightning_pool_session) AS pool_sessions,
         (SELECT count(*) FROM public.lightning_pool_slot)    AS pool_slots,
         (SELECT count(*) FROM public.lightning_instance)     AS instances,
         (SELECT count(*) FROM public.lightning_reservation)  AS reservations,
         (SELECT count(*) FROM public.lightning_blind_ledger) AS ledger_rows,
         (SELECT count(*) FROM public.lightning_hand)         AS hands,
         (SELECT count(*) FROM public.lightning_hand_player)  AS hand_players,
         (SELECT count(*) FROM public.cash_cluster_events)    AS events;
ASSERT

cat > "$fixture/reapply-assertions.sql" <<'REAPPLY'
-- IDEMPOTENT RE-APPLY --------------------------------------------------------
-- Reaching this file at all means the second psql -f of the migration exited 0
-- under ON_ERROR_STOP; what is left is that it moved nothing.
DO $$
DECLARE c pre_reapply_counts%ROWTYPE;
BEGIN
  SELECT * INTO c FROM pre_reapply_counts;
  IF c.pool_sessions IS NULL THEN RAISE EXCEPTION 'FAIL re-apply: the pre-re-apply count capture is empty'; END IF;
  -- Non-vacuity: every relation must hold rows, or "the counts did not change"
  -- is the statement 0 = 0 repeated eight times.
  IF LEAST(c.pool_sessions, c.pool_slots, c.instances, c.reservations, c.ledger_rows,
           c.hands, c.hand_players, c.events) < 1 THEN
    RAISE EXCEPTION 'FAIL re-apply: a relation is empty before the re-apply (session % / slot % / inst % / res % / ledger % / hand % / hp % / events %), so this check would compare nothing to nothing',
      c.pool_sessions, c.pool_slots, c.instances, c.reservations, c.ledger_rows, c.hands, c.hand_players, c.events;
  END IF;

  IF (SELECT count(*) FROM public.lightning_pool_session) IS DISTINCT FROM c.pool_sessions THEN
    RAISE EXCEPTION 'FAIL re-apply: lightning_pool_session went from % rows to %', c.pool_sessions, (SELECT count(*) FROM public.lightning_pool_session); END IF;
  IF (SELECT count(*) FROM public.lightning_pool_slot) IS DISTINCT FROM c.pool_slots THEN
    RAISE EXCEPTION 'FAIL re-apply: lightning_pool_slot went from % rows to %', c.pool_slots, (SELECT count(*) FROM public.lightning_pool_slot); END IF;
  IF (SELECT count(*) FROM public.lightning_instance) IS DISTINCT FROM c.instances THEN
    RAISE EXCEPTION 'FAIL re-apply: lightning_instance went from % rows to %', c.instances, (SELECT count(*) FROM public.lightning_instance); END IF;
  IF (SELECT count(*) FROM public.lightning_reservation) IS DISTINCT FROM c.reservations THEN
    RAISE EXCEPTION 'FAIL re-apply: lightning_reservation went from % rows to %', c.reservations, (SELECT count(*) FROM public.lightning_reservation); END IF;
  IF (SELECT count(*) FROM public.lightning_blind_ledger) IS DISTINCT FROM c.ledger_rows THEN
    RAISE EXCEPTION 'FAIL re-apply: lightning_blind_ledger went from % rows to %', c.ledger_rows, (SELECT count(*) FROM public.lightning_blind_ledger); END IF;
  IF (SELECT count(*) FROM public.lightning_hand) IS DISTINCT FROM c.hands THEN
    RAISE EXCEPTION 'FAIL re-apply: lightning_hand went from % rows to %', c.hands, (SELECT count(*) FROM public.lightning_hand); END IF;
  IF (SELECT count(*) FROM public.lightning_hand_player) IS DISTINCT FROM c.hand_players THEN
    RAISE EXCEPTION 'FAIL re-apply: lightning_hand_player went from % rows to %', c.hand_players, (SELECT count(*) FROM public.lightning_hand_player); END IF;
  IF (SELECT count(*) FROM public.cash_cluster_events) IS DISTINCT FROM c.events THEN
    RAISE EXCEPTION 'FAIL re-apply: cash_cluster_events went from % rows to %', c.events, (SELECT count(*) FROM public.cash_cluster_events); END IF;

  -- Stronger than counts: not one column of one row moved.
  IF EXISTS (SELECT * FROM pre_reapply_pool_session EXCEPT SELECT * FROM public.lightning_pool_session)
     OR EXISTS (SELECT * FROM public.lightning_pool_session EXCEPT SELECT * FROM pre_reapply_pool_session) THEN
    RAISE EXCEPTION 'FAIL re-apply: a pool session row changed on the second application'; END IF;
  IF EXISTS (SELECT * FROM pre_reapply_pool_slot EXCEPT SELECT * FROM public.lightning_pool_slot)
     OR EXISTS (SELECT * FROM public.lightning_pool_slot EXCEPT SELECT * FROM pre_reapply_pool_slot) THEN
    RAISE EXCEPTION 'FAIL re-apply: a pool slot row changed on the second application'; END IF;
  IF EXISTS (SELECT * FROM pre_reapply_instance EXCEPT SELECT * FROM public.lightning_instance)
     OR EXISTS (SELECT * FROM public.lightning_instance EXCEPT SELECT * FROM pre_reapply_instance) THEN
    RAISE EXCEPTION 'FAIL re-apply: an instance row changed on the second application'; END IF;
  IF EXISTS (SELECT * FROM pre_reapply_reservation EXCEPT SELECT * FROM public.lightning_reservation)
     OR EXISTS (SELECT * FROM public.lightning_reservation EXCEPT SELECT * FROM pre_reapply_reservation) THEN
    RAISE EXCEPTION 'FAIL re-apply: a reservation row changed on the second application'; END IF;
  IF EXISTS (SELECT * FROM pre_reapply_ledger EXCEPT SELECT * FROM public.lightning_blind_ledger)
     OR EXISTS (SELECT * FROM public.lightning_blind_ledger EXCEPT SELECT * FROM pre_reapply_ledger) THEN
    RAISE EXCEPTION 'FAIL re-apply: a blind ledger row changed on the second application'; END IF;
  IF EXISTS (SELECT * FROM pre_reapply_hand EXCEPT SELECT * FROM public.lightning_hand)
     OR EXISTS (SELECT * FROM public.lightning_hand EXCEPT SELECT * FROM pre_reapply_hand) THEN
    RAISE EXCEPTION 'FAIL re-apply: a lightning_hand row changed on the second application'; END IF;
  IF EXISTS (SELECT * FROM pre_reapply_hand_player EXCEPT SELECT * FROM public.lightning_hand_player)
     OR EXISTS (SELECT * FROM public.lightning_hand_player EXCEPT SELECT * FROM pre_reapply_hand_player) THEN
    RAISE EXCEPTION 'FAIL re-apply: a lightning_hand_player row changed on the second application'; END IF;
  IF EXISTS (SELECT * FROM pre_reapply_events EXCEPT SELECT * FROM public.cash_cluster_events)
     OR EXISTS (SELECT * FROM public.cash_cluster_events EXCEPT SELECT * FROM pre_reapply_events) THEN
    RAISE EXCEPTION 'FAIL re-apply: a cash_cluster_events row changed on the second application'; END IF;
END $$;
\echo '  ok  RE-APPLY           the migration applied a second time and moved no row in any of the eight relations'
REAPPLY

"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55542 -d postgres \
  -f "$root/scripts/dev/fixtures/lightning-phase2-domain-schema.sql" \
  -f "$migration" \
  -f "$fixture/assertions.sql" \
  -f "$migration" \
  -f "$fixture/reapply-assertions.sql"

echo 'PASS: Lightning Phase 2 domain schema, three levels: the migration applies unmodified and creates all seven relations plus cash_cluster_events.cluster_epoch, pre-existing events defaulted to epoch 0 on a NOT NULL column, RLS on every table with nothing held by anon/authenticated/PUBLIC and service_role explicitly granted on all seven, wait and counters and orbit live on the SLOT and are absent from the session and the ledger while the money stayed with the identity, every cluster-scoped relation carries its epoch, one OPEN pool session per player per cluster, the seven participation states accepted and all eight per-hand states refused, exit is explained and never backwards, two open tables ACCEPTED with a repeated slot number refused and a closed slot freeing its number without touching its siblings, slot 0 and 25 refused while 1 and 24 are accepted, two tables of one player holding independent orbit positions with the BB ordering read from live slots, slot counters non-negative, no one-player and no ten-handed instance, one instance per hand, one pending hold per TABLE with the other table ACCEPTED and a released table re-holding, reservation resolution consistency and expiry ordering, one seat per instance, one seat per PLAYER per instance with two different instances still ACCEPTED, a session with tables REFUSED by lightning_pool_slot_belongs_to_its_session while a table still takes its holds and a childless session deletes, a slot or hold whose player or cluster differs from its parent REFUSED by the named composite foreign key while matching values insert, blind ledger keyed by (cluster, player) with non-negative counts and debt, hand linkage settles after formation, the four-way fold taxonomy with position and blind-role checks, one player per seat per hand with a second table of the same player still refused, every named constraint and index present with its declared key and predicate exactly two composite foreign keys RESTRICT up and CASCADE down resolving through information_schema against real UNIQUE constraints, an unpartial lightning_reservation_by_pool_slot covering the cascade, and the migration idempotent on re-apply'
